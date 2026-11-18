// 会话进程管理 + WebSocket 订阅分发。一个会话一个 Runner；订阅者按会话分组。
import type { AppliedSettings, ClientMsg, ContextUsage, ServerMsg, SkillMode } from '@cosyee/shared';
import { toContextUsage } from '../context.js';
import { isSafeId, normalizeDir } from '../paths.js';
import type { Pins } from '../pins.js';
import type { Sessions } from '../sessions.js';
import type { DotState } from '../state.js';
import { HttpError } from '../workspaces.js';
import { AutoTitle } from './autotitle.js';
import { Runner, type RunnerTimings, validateConfig } from './runner.js';

/** 一个 WebSocket 连接的抽象，便于测试。 */
export interface Client {
  send(msg: ServerMsg): void;
}

export interface ManagerOptions {
  dots: DotState;
  sessions: Sessions;
  /** 置顶：会话开始 / 停止执行时自动置顶、顺延到期时间；不传则不做自动置顶（旧测试） */
  pins?: Pins;
  timings?: Partial<RunnerTimings>;
  claudePath?: string;
  /** skill 状态的存取（全局，Cosyee 自己保存）；不传则不下发 skillOverrides（旧测试） */
  skills?: SkillStore;
  /** 多账号：会话用哪个账号启动；不传则沿用当前账号（旧测试） */
  accounts?: SessionAccounts;
}

export interface SessionAccounts {
  /** 会话应当用哪个账号启动进程（dir 为 null = 默认账号） */
  resolve(sessionId: string): { id: string; dir: string | null };
  /** 该账号还没有 claude 进程、即将启动第一个时调用（补共享链接、同步 MCP 配置） */
  prepare(accountId: string): void;
  /** 会话发出了消息：记下它用的账号 */
  bind(sessionId: string, accountId: string): void;
}

export interface SkillStore {
  get(): Record<string, SkillMode>;
  set(name: string, mode: SkillMode): void;
}

/** MCP 服务器还在连接（pending）时，隔多久再采一次上下文、最多几次 */
const MCP_PENDING_RETRY_MS = 3000;
const MCP_PENDING_RETRIES = 5;

const TITLE_MAX_INPUT = 500;
/** 回合进行中，上下文用量的最小刷新间隔（毫秒）；节流 + 单飞，避免每条消息都打一次 get_context_usage */
const CONTEXT_LIVE_MS = 3000;

export class Manager {
  private runners = new Map<string, Runner>();
  private clients = new Set<Client>();
  private subs = new Map<string, Set<Client>>();
  private settingsCache = new Map<string, AppliedSettings>();
  private contextCache = new Map<string, ContextUsage>();
  private cwdOf = new Map<string, string>();
  private probing = new Map<string, Promise<ContextUsage | null>>();
  /** 回合进行中的上下文刷新节流状态（按会话） */
  private ctxLive = new Map<string, { timer: NodeJS.Timeout | null; last: number; busy: boolean }>();
  private readonly dots: DotState;
  private readonly sessions: Sessions;
  private readonly pins?: Pins;
  private readonly timings?: Partial<RunnerTimings>;
  private readonly claudePath?: string;
  private readonly skills?: SkillStore;
  private readonly accounts?: SessionAccounts;
  /** 会话最近一次 system/init 的 skills（带插件前缀），另按 cwd 存一份给探测进程（探测进程不发消息，收不到 init） */
  private initSkills = new Map<string, string[]>();
  private initSkillsByCwd = new Map<string, string[]>();
  /** MCP pending 重采：按会话的计时器与已重试次数 */
  private mcpRetry = new Map<string, { timer: NodeJS.Timeout | null; n: number }>();
  /** 每轮结束后仍没有标题的会话，主动让 CLI 生成一个 */
  private readonly autoTitle: AutoTitle;

  constructor(opts: ManagerOptions) {
    this.dots = opts.dots;
    this.sessions = opts.sessions;
    this.pins = opts.pins;
    this.timings = opts.timings;
    this.claudePath = opts.claudePath;
    this.skills = opts.skills;
    this.accounts = opts.accounts;
    this.autoTitle = new AutoTitle({
      hasTitle: async (id, cwd) => {
        const s = await this.sessions.scan(id, cwd);
        return s ? !!(s.userTitle || s.customTitle || s.agentName || s.aiTitle) : null;
      },
      firstPrompt: async (id, cwd) => (await this.sessions.scan(id, cwd))?.firstPrompt,
      onTitled: (_id, cwd) => {
        // CLI 写 ai-title 是异步追加，稍后再通知一次，保证列表读到新标题
        this.changed(cwd);
        setTimeout(() => this.changed(cwd), 800).unref();
      },
    });
  }

  // ───────────── 连接与订阅 ─────────────

  addClient(c: Client): void {
    this.clients.add(c);
  }

  removeClient(c: Client): void {
    this.clients.delete(c);
    for (const [id, set] of this.subs) {
      set.delete(c);
      if (set.size === 0) this.subs.delete(id);
    }
  }

  private broadcast(m: ServerMsg): void {
    for (const c of this.clients) this.safeSend(c, m);
  }

  private emit(sessionId: string, m: ServerMsg): void {
    const set = this.subs.get(sessionId);
    if (set) for (const c of set) this.safeSend(c, m);
  }

  private safeSend(c: Client, m: ServerMsg): void {
    try {
      c.send(m);
    } catch { /* 连接已断，由 removeClient 清理 */ }
  }

  private changed(cwd: string): void {
    this.broadcast({ t: 'sessions.changed', cwd });
  }

  /** 置顶 / 已删除集合变了（手动置顶、删除、恢复、自动置顶到期）：通知所有前端重取侧栏数据 */
  notifySidebar(): void {
    this.broadcast({ t: 'sidebar.changed' });
  }

  hasSubscribers(sessionId: string): boolean {
    return (this.subs.get(sessionId)?.size ?? 0) > 0;
  }

  /** 处理客户端消息；非法消息回 error，不抛出。 */
  handle(client: Client, msg: ClientMsg): void {
    try {
      switch (msg?.t) {
        case 'subscribe':
          this.requireId(msg.sessionId);
          void this.subscribe(client, msg.sessionId);
          break;
        case 'unsubscribe': {
          const set = this.subs.get(msg.sessionId);
          set?.delete(client);
          if (set && set.size === 0) this.subs.delete(msg.sessionId);
          break;
        }
        case 'send':
          this.send(client, msg);
          break;
        case 'interrupt':
          this.requireId(msg.sessionId);
          this.runners.get(msg.sessionId)?.interrupt();
          break;
        case 'config':
          this.requireId(msg.sessionId);
          validateConfig(msg.config);
          this.runners.get(msg.sessionId)?.setConfig(msg.config);
          break;
        default:
          throw new Error('未知消息类型');
      }
    } catch (e) {
      this.safeSend(client, { t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private requireId(id: unknown): asserts id is string {
    if (!isSafeId(id)) throw new Error('sessionId 不合法');
  }

  private async subscribe(client: Client, id: string): Promise<void> {
    let set = this.subs.get(id);
    if (!set) this.subs.set(id, (set = new Set()));
    set.add(client);

    // 已查看：清除蓝点
    if (this.dots.viewed(id)) {
      const cwd = this.cwdOf.get(id) ?? (await this.sessions.findCwd(id));
      if (cwd) this.changed(cwd);
    }

    const r = this.runners.get(id);
    const status = r ? r.status : 'idle';
    this.safeSend(client, { t: 'status', sessionId: id, status });
    if (r) {
      const snap = r.snapshot();
      if (snap.events.length > 0) this.safeSend(client, { t: 'replay', sessionId: id, events: snap.events, status: snap.status });
    }
    const st = this.settingsCache.get(id);
    if (st) this.safeSend(client, { t: 'settings', sessionId: id, applied: st });
    const ctx = this.contextCache.get(id);
    if (ctx) this.safeSend(client, { t: 'context', sessionId: id, usage: ctx });
  }

  // ───────────── 发送 ─────────────

  private send(client: Client, msg: Extract<ClientMsg, { t: 'send' }>): void {
    this.requireId(msg.sessionId);
    if (typeof msg.cwd !== 'string' || !msg.cwd) throw new Error('cwd 不能为空');
    if (typeof msg.text !== 'string' || msg.text.trim() === '') throw new Error('消息不能为空');
    validateConfig(msg.config);
    const id = msg.sessionId;
    const cwd = normalizeDir(msg.cwd);

    // 发送者自动订阅，保证收到本轮事件
    let set = this.subs.get(id);
    if (!set) this.subs.set(id, (set = new Set()));
    set.add(client);

    let r = this.runners.get(id);
    // 并行模式：空闲的进程不是这个会话现在该用的账号（例如新会话草稿的探测进程启动后换了账号）→ 换一个进程
    if (r && this.accounts && r.status === 'idle' && r.accountId !== this.accounts.resolve(id).id) {
      const old = r;
      this.runners.delete(id);
      old.shutdown(2000);
      r = undefined;
    }
    const created = !r;
    if (!r) {
      r = this.createRunner(id, cwd, !!msg.isNew, msg.config, false);
      this.runners.set(id, r);
    }
    try {
      r.send(msg.text, msg.config);
    } catch (e) {
      if (created && !r.alive) this.runners.delete(id);
      throw e;
    }
    this.cwdOf.set(id, r.cwd);
    if (this.accounts && r.accountId) this.accounts.bind(id, r.accountId);
    this.dots.viewed(id);
    this.changed(r.cwd);
  }

  private createRunner(id: string, cwd: string, isNew: boolean, config: ClientMsgConfig, probe: boolean): Runner {
    const account = this.accounts?.resolve(id);
    if (account && this.processCount(account.id) === 0) {
      try {
        this.accounts!.prepare(account.id);
      } catch { /* 不影响启动 */ }
    }
    const runner: Runner = new Runner({
      sessionId: id,
      cwd,
      account,
      isNew,
      config,
      probe,
      timings: this.timings,
      claudePath: this.claudePath,
      flagSettings: () => this.skillFlagSettings(),
      hooks: {
        onEvent: (e) => {
          this.emit(id, { t: 'event', sessionId: id, e });
          const ev = e as { type?: unknown; subtype?: unknown; skills?: unknown } | null;
          if (ev?.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.skills)) {
            const list = ev.skills.filter((x): x is string => typeof x === 'string');
            this.initSkills.set(id, list);
            this.initSkillsByCwd.set(cwd, list);
          }
          this.autoTitle.collect(id, e);
          // 一条完整的 assistant / user(tool_result) 消息落地后，上下文用量就变了：节流刷新，让右侧面板实时更新
          const type = (e as { type?: unknown } | null)?.type;
          if (type === 'assistant' || type === 'user') this.scheduleLiveContext(runner);
        },
        onStatus: (status, error) => {
          const running = status === 'running' || status === 'starting';
          const wasDot = this.dots.setRunning(id, running);
          // 开始执行 → 自动置顶；停止 → 从此刻起计 30 分钟
          const pinChanged = this.pins?.onRunning(id, cwd, running) ?? false;
          this.emit(id, error ? { t: 'status', sessionId: id, status, error } : { t: 'status', sessionId: id, status });
          if (wasDot) this.changed(cwd);
          if (pinChanged) this.notifySidebar();
        },
        onSettings: (applied) => {
          this.settingsCache.set(id, { ...this.settingsCache.get(id), ...applied });
          this.emit(id, { t: 'settings', sessionId: id, applied });
        },
        onTurnEnd: () => {
          this.cancelLiveContext(id);
          this.dots.turnFinished(id, this.hasSubscribers(id));
          this.pins?.touch(id);
          this.changed(cwd);
          if (runner.alive) void this.fetchContext(runner).catch(() => {});
          if (runner.alive) void this.autoTitle.ensure(runner, cwd);
        },
        onExit: () => {
          // 已被同一会话的新进程替换（并行模式换账号）：新进程的状态不能被旧进程退出清掉
          const other = this.runners.get(id);
          if (other && other !== runner) return;
          this.cancelLiveContext(id);
          this.cancelMcpRetry(id);
          if (other === runner) this.runners.delete(id);
          const wasDot = this.dots.setRunning(id, false);
          this.pins?.onRunning(id, cwd, false);
          if (wasDot) this.changed(cwd);
        },
      },
    });
    return runner;
  }

  // ───────────── 上下文 ─────────────

  /** 启动参数里的 --settings 附加项：Cosyee 保存的 skill 状态 */
  private skillFlagSettings(): Record<string, unknown> {
    const map = this.skills?.get() ?? {};
    return Object.keys(map).length ? { skillOverrides: { ...map } } : {};
  }

  /**
   * 采集上下文：get_context_usage 为主，get_settings（只取 effective.skillOverrides）与 mcp_status 失败时忽略。
   * get_settings 的其余内容含个人信息，这里不保留。
   */
  private async fetchContext(r: Runner): Promise<ContextUsage> {
    const [raw, settings, mcp] = await Promise.all([
      r.request('get_context_usage'),
      r.request('get_settings').catch(() => null),
      r.request('mcp_status').catch(() => null),
    ]);
    const eff = (settings as { effective?: { skillOverrides?: unknown } } | null)?.effective?.skillOverrides;
    const usage = toContextUsage(raw, Date.now(), {
      initSkills: this.initSkills.get(r.sessionId) ?? this.initSkillsByCwd.get(r.cwd) ?? null,
      overrides: eff && typeof eff === 'object' ? (eff as Record<string, unknown>) : null,
      cosyeeOverrides: this.skills?.get() ?? null,
      mcpStatus: mcp,
    });
    this.contextCache.set(r.sessionId, usage);
    this.emit(r.sessionId, { t: 'context', sessionId: r.sessionId, usage });
    this.scheduleMcpRetry(r, usage);
    return usage;
  }

  /** 有 MCP 服务器还在连接：过一会儿再采一次，让状态与工具列表跟上 */
  private scheduleMcpRetry(r: Runner, usage: ContextUsage): void {
    const id = r.sessionId;
    const pending = usage.mcpServers.some((s) => s.status === 'pending');
    let st = this.mcpRetry.get(id);
    if (!pending) {
      if (st && !st.timer) this.mcpRetry.delete(id);
      return;
    }
    if (!st) this.mcpRetry.set(id, (st = { timer: null, n: 0 }));
    if (st.timer || st.n >= MCP_PENDING_RETRIES) return;
    const state = st;
    state.n++;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (r.alive && this.runners.get(id) === r) void this.fetchContext(r).catch(() => {});
    }, MCP_PENDING_RETRY_MS);
    state.timer.unref();
  }

  private cancelMcpRetry(id: string): void {
    const st = this.mcpRetry.get(id);
    if (st?.timer) clearTimeout(st.timer);
    this.mcpRetry.delete(id);
  }

  /** 延迟若干毫秒后再采一次（MCP 打开后连接需要时间） */
  private refetchLater(r: Runner, ms: number): void {
    setTimeout(() => {
      if (r.alive && this.runners.get(r.sessionId) === r) void this.fetchContext(r).catch(() => {});
    }, ms).unref();
  }

  /**
   * 回合进行中按事件触发的上下文刷新：没人订阅就不采集；距上次不足 CONTEXT_LIVE_MS 则合并成一次尾部刷新；
   * 同一会话同时只有一个请求在途。回合结束时 onTurnEnd 还会再采一次最终值。
   */
  private scheduleLiveContext(r: Runner): void {
    const id = r.sessionId;
    if (!r.alive || !this.hasSubscribers(id)) return;
    let st = this.ctxLive.get(id);
    if (!st) this.ctxLive.set(id, (st = { timer: null, last: 0, busy: false }));
    if (st.timer || st.busy) return; // 已有待执行的刷新 / 正在采集
    const state = st;
    const run = () => {
      state.timer = null;
      if (!r.alive || !this.hasSubscribers(id)) return;
      state.busy = true;
      state.last = Date.now();
      void this.fetchContext(r)
        .catch(() => { /* 采集失败（进程忙 / 超时）：等下一条消息再试 */ })
        .finally(() => { state.busy = false; });
    };
    const wait = Math.max(0, state.last + CONTEXT_LIVE_MS - Date.now());
    state.timer = setTimeout(run, wait);
    state.timer.unref();
  }

  private cancelLiveContext(id: string): void {
    const st = this.ctxLive.get(id);
    if (st?.timer) clearTimeout(st.timer);
    this.ctxLive.delete(id);
  }

  getContext(id: string): ContextUsage | null {
    return this.contextCache.get(id) ?? null;
  }

  /**
   * 立即重新采集；会话没有进程时拉起一个不发消息的探测进程（已有记录用 --resume）。
   * draft：前端新开、还没发过消息的会话（磁盘上没有记录）——用 --session-id 拉起，之后第一条消息直接复用这个进程。
   */
  async refreshContext(id: string, cwdHint?: string, draft = false): Promise<ContextUsage | null> {
    const r = this.runners.get(id);
    if (r) {
      if (!r.alive) return this.getContext(id);
      try {
        return await this.fetchContext(r);
      } catch {
        return this.getContext(id);
      }
    }
    const running = this.probing.get(id);
    if (running) return running;
    const p = this.probeContext(id, cwdHint, draft).finally(() => this.probing.delete(id));
    this.probing.set(id, p);
    return p;
  }

  private async probeContext(id: string, cwdHint?: string, draft = false): Promise<ContextUsage | null> {
    let probe: Runner;
    try {
      probe = await this.startProbe(id, cwdHint, draft);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return this.getContext(id);
    }
    try {
      return await this.fetchContext(probe);
    } catch {
      if (!probe.alive && this.runners.get(id) === probe) this.runners.delete(id);
      return this.getContext(id);
    }
  }

  /**
   * 会话没有进程时，拉起一个不发消息的探测进程：有记录用 --resume；没有记录且 draft（新会话草稿）用 --session-id。
   * （实测：不发消息的 --session-id 进程不会写会话文件，探测进程空闲退出后再用 --session-id 新建不冲突。）
   * 会话不存在（且不是草稿）抛 404，启动失败抛原错误。
   */
  private async startProbe(id: string, cwdHint?: string, draft = false): Promise<Runner> {
    const cwd = cwdHint ? normalizeDir(cwdHint) : (this.cwdOf.get(id) ?? (await this.sessions.findCwd(id)));
    if (!cwd) throw new HttpError(404, '会话不存在');
    const loc = await this.sessions.locate(id, cwd);
    if (!loc && !draft) throw new HttpError(404, '会话不存在');
    const existing = this.runners.get(id);
    if (existing?.alive) return existing;
    // 配置只用于启动参数；进程随后可复用，真正发消息时 send 会按需 set_model 等
    const probe = this.createRunner(id, cwd, !loc, { model: 'sonnet', effort: 'medium' }, true);
    this.runners.set(id, probe);
    try {
      probe.start();
    } catch (e) {
      if (this.runners.get(id) === probe) this.runners.delete(id);
      throw e;
    }
    this.cwdOf.set(id, cwd);
    return probe;
  }

  // ───────────── Skill / MCP 开关 ─────────────

  /**
   * 设置一个 skill 的状态：先存下来（新启动的会话经 --settings 带上），再把完整映射下发给所有运行中的会话
   * （apply_flag_settings 里 skillOverrides 是整体替换，必须发完整映射），然后为有人看的会话重新采集上下文。
   */
  async setSkillMode(name: string, mode: SkillMode): Promise<void> {
    if (!this.skills) throw new HttpError(500, '未启用 skill 设置');
    this.skills.set(name, mode);
    const map = { ...this.skills.get() };
    const alive = [...this.runners.values()].filter((r) => r.alive);
    await Promise.all(
      alive.map(async (r) => {
        try {
          await r.request('apply_flag_settings', { settings: { skillOverrides: map } });
        } catch { /* 进程忙 / 已退出：下次启动时经 --settings 生效 */ }
        if (this.hasSubscribers(r.sessionId)) void this.fetchContext(r).catch(() => {});
      }),
    );
    // 没有进程、但面板开着的会话：直接改缓存里的状态
    for (const [id, usage] of this.contextCache) {
      if (this.runners.get(id)?.alive || !this.hasSubscribers(id)) continue;
      const has = usage.skills.some((s) => s.name === name);
      const skills = has
        ? usage.skills.map((s) => (s.name === name ? { ...s, mode, tokens: mode === 'on' ? s.tokens : null } : s))
        : [...usage.skills, { name, mode, tokens: null, source: name.includes(':') ? 'plugin' : null }];
      const next = { ...usage, skills };
      this.contextCache.set(id, next);
      this.emit(id, { t: 'context', sessionId: id, usage: next });
    }
  }

  /**
   * 开关 MCP 服务器（CLI 的 mcp_toggle，按项目写进 ~/.claude.json，与终端 /mcp 相同）。
   * 会话没有进程时先拉起探测进程。打开后服务器异步连接，稍后再采两次。
   */
  async toggleMcp(id: string, server: string, enabled: boolean, cwdHint?: string, draft = false): Promise<ContextUsage | null> {
    let r = this.runners.get(id);
    if (!r?.alive) r = await this.startProbe(id, cwdHint, draft);
    try {
      await r.request('mcp_toggle', { serverName: server, enabled });
    } catch (e) {
      throw new HttpError(502, `切换 MCP 失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const usage = await this.fetchContext(r).catch(() => this.getContext(id));
    if (enabled) {
      this.refetchLater(r, 2000);
      this.refetchLater(r, 6000);
    }
    return usage;
  }

  // ───────────── 改名 / 已读 ─────────────

  async rename(id: string, cwd: string, title: string): Promise<void> {
    const t = String(title ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!t) throw new HttpError(400, '标题不能为空');
    if (t.length > TITLE_MAX_INPUT) throw new HttpError(400, '标题过长');
    const r = this.runners.get(id);
    let done = false;
    if (r?.alive) {
      try {
        await r.request('rename_session', { title: t, source: 'host', session_id: id });
        done = true;
      } catch { /* 退回直接写文件 */ }
    }
    if (!done) await this.sessions.appendTitle(id, cwd, t);
    this.changed(normalizeDir(cwd));
  }

  viewed(id: string, cwd: string): void {
    if (this.dots.viewed(id)) this.changed(normalizeDir(cwd));
  }

  // ───────────── 关闭 ─────────────

  /** 优雅关闭：关闭所有进程并等待退出（最多 timeoutMs）。 */
  async shutdown(timeoutMs = 4000): Promise<void> {
    const rs = [...this.runners.values()];
    for (const r of rs) r.shutdown(Math.min(2000, timeoutMs));
    const deadline = Date.now() + timeoutMs;
    while (this.runners.size > 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    for (const r of this.runners.values()) r.killSync();
  }

  /**
   * 切换账号：结束所有进程，清掉与账号有关的缓存（设置、上下文、skill 列表…）。
   * 订阅关系保留（前端随后整页刷新会重新订阅）。
   */
  async resetAll(timeoutMs = 5000): Promise<void> {
    await this.shutdown(timeoutMs);
    for (const id of [...this.ctxLive.keys()]) this.cancelLiveContext(id);
    for (const id of [...this.mcpRetry.keys()]) this.cancelMcpRetry(id);
    this.settingsCache.clear();
    this.contextCache.clear();
    this.probing.clear();
    this.initSkills.clear();
    this.initSkillsByCwd.clear();
  }

  /**
   * 只结束属于某些账号的进程（并行模式切回切换模式、移除账号），清掉这些会话的缓存；其它会话不受影响。
   * match 收到进程的账号 id（没有账号信息的进程为 null）。
   */
  async stopAccounts(match: (accountId: string | null) => boolean, timeoutMs = 5000): Promise<void> {
    const rs = [...this.runners.values()].filter((r) => match(r.accountId));
    if (!rs.length) return;
    for (const r of rs) r.shutdown(Math.min(2000, timeoutMs));
    const deadline = Date.now() + timeoutMs;
    while (rs.some((r) => this.runners.get(r.sessionId) === r) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    for (const r of rs) {
      if (this.runners.get(r.sessionId) === r) {
        r.killSync();
        this.runners.delete(r.sessionId);
      }
      const id = r.sessionId;
      this.cancelLiveContext(id);
      this.cancelMcpRetry(id);
      this.settingsCache.delete(id);
      this.contextCache.delete(id);
      this.probing.delete(id);
      this.initSkills.delete(id);
    }
  }

  /** 通知所有前端：账号变了（reload = 整页刷新） */
  notifyAccount(reload: boolean): void {
    this.broadcast({ t: 'account.changed', reload });
  }

  /** 同步强杀（process 'exit' 事件里使用）。 */
  killAllSync(): void {
    for (const r of this.runners.values()) r.killSync();
  }

  /** 正在执行（starting / running）的会话数；空闲的探测进程不算。传 accountId 只数该账号的。 */
  runningCount(accountId?: string): number {
    let n = 0;
    for (const r of this.runners.values()) {
      if (accountId !== undefined && r.accountId !== accountId) continue;
      if (r.status === 'running' || r.status === 'starting') n++;
    }
    return n;
  }

  /** 某个账号的 claude 进程数（含空闲的） */
  processCount(accountId: string): number {
    let n = 0;
    for (const r of this.runners.values()) if (r.accountId === accountId) n++;
    return n;
  }

  /** 会话当前进程所属的账号；没有进程为 null */
  runnerAccount(sessionId: string): string | null {
    return this.runners.get(sessionId)?.accountId ?? null;
  }

  get runnerCount(): number {
    return this.runners.size;
  }
}

type ClientMsgConfig = Extract<ClientMsg, { t: 'config' }>['config'];
