// 会话进程管理 + WebSocket 订阅分发。一个会话一个 Runner；订阅者按会话分组。
import path from 'node:path';
import type { AppliedSettings, ClientMsg, ContextUsage, ServerMsg, SessionConfig, SkillMode } from '@cosyee/shared';
import { toContextUsage } from '../context.js';
import { baseClaudeHome, cosyeeHome, isSafeId, isSessionUuid, normalizeDir } from '../paths.js';
import type { Pins } from '../pins.js';
import type { Sessions } from '../sessions.js';
import { type DiskSkill, listDiskSkills, removeDiskSkill } from '../skillsDisk.js';
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
  /** 已停用的内置工具名单的存取（全局）；不传则不下发 permissions.deny（旧测试） */
  tools?: ToolStore;
  /** 自动压缩窗口的存取（全局，null = 不覆盖）；不传则不下发（旧测试） */
  compactWindow?: CompactWindowStore;
  /** 多账号：会话用哪个账号启动；不传则沿用当前账号（旧测试） */
  accounts?: SessionAccounts;
  /** 每个会话最近一次使用的配置（模型 / 强度）的存取；不传则不记录（旧测试） */
  configs?: SessionConfigStore;
}

export interface SessionConfigStore {
  get(sessionId: string): SessionConfig | null;
  set(sessionId: string, config: SessionConfig): void;
}

export interface SessionAccounts {
  /** 会话应当用哪个账号启动进程（dir 为 null = 默认账号） */
  resolve(sessionId: string): { id: string; dir: string | null };
  /** 该账号还没有 claude 进程、即将启动第一个时调用（补共享链接、同步 MCP 配置） */
  prepare(accountId: string): void;
  /** 会话发出了消息：记下它用的账号 */
  bind(sessionId: string, accountId: string): void;
}

export interface CompactWindowStore {
  get(): number | null;
  set(window: number | null): void;
}

export interface ToolStore {
  /** 当前已停用的工具名 */
  get(): string[];
  /** 整体替换（调用方保证名字已校验、去重） */
  set(names: string[]): void;
  /** 最近一次 init 报告的内置工具名（落盘；探测进程收不到 init 时用它） */
  known?(): string[];
  setKnown?(names: string[]): void;
  /** 已关闭的智能体名（全局）；以 Agent(名字) 并入 permissions.deny */
  agents?(): string[];
  setAgents?(names: string[]): void;
}

/** 内置工具名（与 workspaces.ts 的 TOOL_NAME_RE 一致）；mcp__ 工具另由 MCP 一节管理 */
const BUILTIN_TOOL_RE = /^(?!mcp__)[A-Za-z][A-Za-z0-9_]{0,63}$/;

export interface SkillStore {
  get(): Record<string, SkillMode>;
  set(name: string, mode: SkillMode): void;
  /** 一次设置多个（只落盘一次） */
  setMany(modes: Record<string, SkillMode>): void;
  /** 删掉某个 skill 的已存状态（skill 被移除后不再留条目） */
  remove(name: string): void;
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
  private readonly tools?: ToolStore;
  private readonly compactWindow?: CompactWindowStore;
  private readonly accounts?: SessionAccounts;
  private readonly configs?: SessionConfigStore;
  /** 会话最近一次 system/init 的 skills（带插件前缀），另按 cwd 存一份给探测进程（探测进程不发消息，收不到 init） */
  private initSkills = new Map<string, string[]>();
  private initSkillsByCwd = new Map<string, string[]>();
  /** 会话最近一次 system/init 的内置工具名 */
  private initTools = new Map<string, string[]>();
  /** MCP pending 重采：按会话的计时器与已重试次数 */
  private mcpRetry = new Map<string, { timer: NodeJS.Timeout | null; n: number }>();
  /** 没有标题的会话：首条消息被接收后立即让 CLI 生成一个（每轮结束时再兜底重试） */
  private readonly autoTitle: AutoTitle;

  constructor(opts: ManagerOptions) {
    this.dots = opts.dots;
    this.sessions = opts.sessions;
    this.pins = opts.pins;
    this.timings = opts.timings;
    this.claudePath = opts.claudePath;
    this.skills = opts.skills;
    this.tools = opts.tools;
    this.compactWindow = opts.compactWindow;
    this.accounts = opts.accounts;
    this.configs = opts.configs;
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
          this.configs?.set(msg.sessionId, msg.config); // 没有进程时也要记下：刷新页面后据此还原
          this.runners.get(msg.sessionId)?.setConfig(msg.config);
          break;
        case 'queue.cancel':
          this.requireId(msg.sessionId);
          this.requireMsgId(msg.id);
          void this.queueCancel(client, msg.sessionId, msg.id);
          break;
        case 'queue.sendNow':
          this.requireId(msg.sessionId);
          this.requireMsgId(msg.id);
          void this.queueSendNow(client, msg.sessionId, msg.id);
          break;
        case 'rewind':
          void this.rewind(client, msg);
          break;
        case 'prompt.reply':
          this.promptReply(msg);
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

  /** 消息 id 必须是 UUID（CLI 要求 user 消息的 uuid 为 UUID 格式） */
  private requireMsgId(id: unknown): asserts id is string {
    if (!isSessionUuid(id)) throw new Error('消息 id 不合法');
  }

  /** 回应 AskUserQuestion / ExitPlanMode。请求已不存在（被取消 / 已回应）时静默忽略 */
  private promptReply(msg: Extract<ClientMsg, { t: 'prompt.reply' }>): void {
    this.requireId(msg.sessionId);
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('请求 id 不合法');
    const rp = msg.reply as unknown as Record<string, unknown> | null;
    if (!rp || typeof rp !== 'object') throw new Error('回应不合法');
    switch (rp.kind) {
      case 'answer': {
        const a = rp.answers as Record<string, unknown> | null;
        if (!a || typeof a !== 'object' || Array.isArray(a) || !Object.values(a).every((v) => typeof v === 'string')) {
          throw new Error('answers 不合法');
        }
        break;
      }
      case 'revise':
        if (typeof rp.feedback !== 'string') throw new Error('feedback 不合法');
        break;
      case 'skip':
      case 'approve':
        break;
      default:
        throw new Error('回应类型不合法');
    }
    const ok = this.runners.get(msg.sessionId)?.reply(msg.id, msg.reply);
    if (ok && msg.reply.kind === 'approve') {
      // 批准计划后会话已切到 auto：记下，刷新页面后据此还原
      const cur = this.configs?.get(msg.sessionId);
      if (cur) this.configs?.set(msg.sessionId, { ...cur, permissionMode: 'auto' });
    }
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
    // 排队消息快照（紧跟 replay；没有排队也发空数组，前端据此清掉旧状态）
    this.safeSend(client, { t: 'queue', sessionId: id, items: r ? r.queueItems() : [] });
    // 待回应请求快照（同上，空数组也发）
    this.safeSend(client, { t: 'prompts', sessionId: id, items: r ? r.promptItems() : [] });
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
    if (msg.id !== undefined) this.requireMsgId(msg.id); // 没带 id 的旧客户端：runner 自己生成
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
      r.send(msg.text, msg.config, msg.id, msg.mode);
    } catch (e) {
      if (created && !r.alive) this.runners.delete(id);
      throw e;
    }
    this.configs?.set(id, msg.config);
    this.cwdOf.set(id, r.cwd);
    if (this.accounts && r.accountId) this.accounts.bind(id, r.accountId);
    this.dots.viewed(id);
    this.changed(r.cwd);
  }

  // ───────────── 排队消息 / 回退 ─────────────

  /** 撤回一条排队消息：结果只回给发起的连接（text 是原文，前端填回输入框） */
  private async queueCancel(client: Client, sessionId: string, id: string): Promise<void> {
    const r = this.runners.get(sessionId);
    let res: { ok: boolean; text?: string } = { ok: false };
    if (r?.alive) {
      try {
        res = await r.cancelQueued(id);
      } catch { /* 进程退出 / 超时：按失败回复 */ }
    }
    const m: ServerMsg = { t: 'queue.cancelled', sessionId, id, ok: res.ok };
    if (res.ok && res.text !== undefined) m.text = res.text;
    this.safeSend(client, m);
  }

  /** 立即发送一条排队消息：中断当前轮并马上执行它。失败（已不在排队）时重发一次队列快照让前端对齐 */
  private async queueSendNow(client: Client, sessionId: string, id: string): Promise<void> {
    const r = this.runners.get(sessionId);
    try {
      if (!r?.alive) throw new Error('会话没有在运行');
      const res = await r.sendNow(id);
      if (res.ok) return;
    } catch (e) {
      this.safeSend(client, { t: 'error', message: `立即发送失败：${e instanceof Error ? e.message : String(e)}` });
    }
    this.safeSend(client, { t: 'queue', sessionId, items: r ? r.queueItems() : [] });
  }

  /**
   * 回退到某条用户消息。没有进程时用 --resume 拉起一个不发消息的探测进程（CLI 在收到第一条消息前就能响应
   * control_request，runner 启动时的 get_settings 就是这样发的），回退后它按探测进程的规则空闲回收，
   * 之后发消息时直接复用。结果只回给发起的连接。
   */
  private async rewind(client: Client, msg: Extract<ClientMsg, { t: 'rewind' }>): Promise<void> {
    const reply = (ok: boolean, extra: { prefillText?: string; error?: string } = {}): void => {
      const m: ServerMsg = { t: 'rewind.result', sessionId: String(msg?.sessionId), reqId: String(msg?.reqId), targetId: String(msg?.targetId), ok };
      if (extra.prefillText !== undefined) m.prefillText = extra.prefillText;
      if (extra.error !== undefined) m.error = extra.error;
      this.safeSend(client, m);
    };
    try {
      this.requireId(msg.sessionId);
      this.requireMsgId(msg.targetId);
      if (typeof msg.reqId !== 'string' || !msg.reqId) throw new Error('reqId 不能为空');
      const id = msg.sessionId;
      let r = this.runners.get(id);
      if (r && !r.alive) throw new Error('claude 进程正在关闭，请稍后重试');
      if (!r) {
        if (typeof msg.cwd !== 'string' || !msg.cwd) throw new Error('cwd 不能为空');
        validateConfig(msg.config);
        const cwd = normalizeDir(msg.cwd);
        r = this.createRunner(id, cwd, false, msg.config, true);
        this.runners.set(id, r);
        try {
          r.start();
        } catch (e) {
          if (this.runners.get(id) === r) this.runners.delete(id);
          throw e;
        }
        this.cwdOf.set(id, cwd);
      }
      const res = await r.rewind(msg.targetId);
      if (res.rewound === true) {
        reply(true, { prefillText: typeof res.prefillText === 'string' ? res.prefillText : '' });
        this.changed(r.cwd);
      } else {
        reply(false, { error: String(res.error ?? res.reason ?? '回退失败') });
      }
    } catch (e) {
      reply(false, { error: e instanceof Error ? e.message : String(e) });
    }
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
      flagSettings: () => ({ ...this.skillFlagSettings(), ...this.toolFlagSettings(), ...this.compactFlagSettings() }),
      hooks: {
        onEvent: (e) => {
          this.emit(id, { t: 'event', sessionId: id, e });
          const ev = e as { type?: unknown; subtype?: unknown; skills?: unknown; tools?: unknown } | null;
          if (ev?.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.skills)) {
            const list = ev.skills.filter((x): x is string => typeof x === 'string');
            this.initSkills.set(id, list);
            this.initSkillsByCwd.set(cwd, list);
          }
          if (ev?.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.tools)) {
            const list = ev.tools.filter((x): x is string => typeof x === 'string' && BUILTIN_TOOL_RE.test(x));
            this.initTools.set(id, list);
            if (list.length) this.tools?.setKnown?.(list);
          }
          this.autoTitle.observe(runner, cwd, e);
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
        onQueue: (items) => this.emit(id, { t: 'queue', sessionId: id, items }),
        onPrompts: (items) => this.emit(id, { t: 'prompts', sessionId: id, items }),
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

  /** 启动参数里的 --settings 附加项：已停用的工具与关闭的智能体（permissions.deny）。启动时下发，模型根本看不到它们 */
  private toolFlagSettings(): Record<string, unknown> {
    const list = this.denyList();
    return list.length ? { permissions: { deny: list } } : {};
  }

  /**
   * 启动参数里的 --settings 附加项：自动压缩窗口。走 flag settings 而不是进程环境变量——
   * 用户 ~/.claude/settings.json 的 env 会盖过进程环境变量，flag settings 则盖过用户设置（实测）。
   */
  private compactFlagSettings(): Record<string, unknown> {
    const w = this.compactWindow?.get() ?? null;
    return w ? { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(w) } } : {};
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
    const disk = this.scanDiskSkills(r.sessionId, r.cwd);
    const usage = toContextUsage(raw, Date.now(), {
      initSkills: this.initSkills.get(r.sessionId) ?? this.initSkillsByCwd.get(r.cwd) ?? null,
      overrides: eff && typeof eff === 'object' ? (eff as Record<string, unknown>) : null,
      cosyeeOverrides: this.skills?.get() ?? null,
      diskSkills: disk,
      hidden: this.hiddenSkills(disk),
      mcpStatus: mcp,
      disabledTools: this.tools?.get() ?? null,
      disabledAgents: this.tools?.agents?.() ?? null,
      tools: this.initTools.get(r.sessionId) ?? this.tools?.known?.() ?? null,
      compactWindow: this.compactWindow?.get() ?? null,
    });
    this.contextCache.set(r.sessionId, usage);
    this.emit(r.sessionId, { t: 'context', sessionId: r.sessionId, usage });
    this.scheduleMcpRetry(r, usage);
    return usage;
  }

  private readonly removedSkills = new Set<string>();

  /** 磁盘上的全部 skill（会话所用账号的配置目录 + 项目目录）；扫描失败当作读不到 */
  private scanDiskSkills(sessionId: string, cwd: string | null): DiskSkill[] | null {
    try {
      const dir = this.accounts?.resolve(sessionId)?.dir ?? null;
      return listDiskSkills(dir ?? baseClaudeHome(), cwd);
    } catch {
      return null;
    }
  }

  /** 被移除、且磁盘上确实没有了的 skill 名（磁盘上又出现就不再藏） */
  private hiddenSkills(disk: DiskSkill[] | null): string[] {
    const onDisk = new Set((disk ?? []).map((d) => d.name));
    for (const n of [...this.removedSkills]) if (onDisk.has(n)) this.removedSkills.delete(n);
    return [...this.removedSkills];
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
    const probe = this.createRunner(id, cwd, !loc, this.configs?.get(id) ?? { model: 'sonnet', effort: 'medium' }, true);
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
    return this.setSkillModes({ [name]: mode });
  }

  /** 批量设置（「一键推荐配置」用）：只落盘、下发、采集一次 */
  async setSkillModes(modes: Record<string, SkillMode>): Promise<void> {
    if (!this.skills) throw new HttpError(500, '未启用 skill 设置');
    const entries = Object.entries(modes);
    if (entries.length === 0) return;
    this.skills.setMany(modes);
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
      let skills = usage.skills;
      for (const [name, mode] of entries) {
        skills = skills.some((s) => s.name === name)
          ? skills.map((s) => (s.name === name ? { ...s, mode, tokens: mode === 'on' ? s.tokens : null } : s))
          : [...skills, { name, mode, tokens: null, source: name.includes(':') ? 'plugin' : null }];
      }
      const next = { ...usage, skills };
      this.contextCache.set(id, next);
      this.emit(id, { t: 'context', sessionId: id, usage: next });
    }
  }

  /**
   * 启用 / 停用一个内置工具：先存下来（新启动的会话经 --settings 的 permissions.deny 带上），
   * 再把完整名单下发给所有运行中的进程（apply_flag_settings 对 permissions.deny 是整体替换，实测空数组即清除）。
   * 实测（claude 2.x）：运行中下发立即生效——被停用的工具再被调用会得到 "Permission to use X has been denied."，
   * 但该工具仍留在模型的工具列表里（模型可能还会尝试一次）；重启 / 新会话后才会从列表里消失。
   */
  async setToolEnabled(name: string, enabled: boolean): Promise<string[]> {
    if (!this.tools) throw new HttpError(500, '未启用工具设置');
    const cur = this.tools.get();
    const has = cur.includes(name);
    if (enabled === !has) return [...cur];
    this.tools.set(enabled ? cur.filter((n) => n !== name) : [...cur, name]);
    const list = [...this.tools.get()];
    await this.pushDeny({ disabledTools: list });
    return list;
  }

  /**
   * 开启 / 关闭一个智能体（子代理）：同工具开关，名单全局保存，以 Agent(名字) 规则并入 permissions.deny。
   * 关闭后模型派发该智能体会被拒绝；新启动的会话里它不再出现在 Agent 工具的可选列表中。
   */
  async setAgentEnabled(name: string, enabled: boolean): Promise<string[]> {
    if (!this.tools?.agents || !this.tools.setAgents) throw new HttpError(500, '未启用智能体设置');
    const cur = this.tools.agents();
    const has = cur.includes(name);
    if (enabled === !has) return [...cur];
    this.tools.setAgents(enabled ? cur.filter((n) => n !== name) : [...cur, name]);
    const list = [...this.tools.agents()];
    await this.pushDeny({ disabledAgents: list });
    return list;
  }

  /** 完整的 permissions.deny：停用的工具 + 关闭的智能体（Agent(名字)） */
  private denyList(): string[] {
    return [...(this.tools?.get() ?? []), ...(this.tools?.agents?.() ?? []).map((a) => `Agent(${a})`)];
  }

  /**
   * 把完整的 deny 名单下发给所有运行中的进程，并刷新面板；没有进程、但面板开着的会话直接改缓存里的名单。
   * apply_flag_settings 对 permissions.deny 是整体替换，实测空数组即清除，所以每次都发全量。
   */
  private async pushDeny(patch: Pick<ContextUsage, 'disabledTools' | 'disabledAgents'>): Promise<void> {
    const deny = this.denyList();
    const alive = [...this.runners.values()].filter((r) => r.alive);
    await Promise.all(
      alive.map(async (r) => {
        try {
          await r.request('apply_flag_settings', { settings: { permissions: { deny } } });
        } catch { /* 进程忙 / 已退出：下次启动时经 --settings 生效 */ }
        if (this.hasSubscribers(r.sessionId)) void this.fetchContext(r).catch(() => {});
      }),
    );
    for (const [id, usage] of this.contextCache) {
      if (this.runners.get(id)?.alive || !this.hasSubscribers(id)) continue;
      const next = { ...usage, ...patch };
      this.contextCache.set(id, next);
      this.emit(id, { t: 'context', sessionId: id, usage: next });
    }
  }

  /**
   * 设置自动压缩窗口（null = 不覆盖）：先存下来（新启动的进程经 --settings env 带上），再下发给所有运行中的进程。
   * 实测（claude 2.x）：运行中 apply_flag_settings 的 env 立即生效，get_context_usage 的 autoCompactThreshold 随之变为 窗口 - 33k；
   * 之后再下发 effortLevel / permissions 等其它顶层键不会冲掉它（按顶层键合并）。
   * 恢复默认时下发空 env：进程里已经写入的环境变量未必撤销，重启进程后才确定回到默认。
   */
  async setCompactWindow(window: number | null): Promise<number | null> {
    if (!this.compactWindow) throw new HttpError(500, '未启用压缩窗口设置');
    if (this.compactWindow.get() === window) return window;
    this.compactWindow.set(window);
    const env = window ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) } : {};
    const alive = [...this.runners.values()].filter((r) => r.alive);
    await Promise.all(
      alive.map(async (r) => {
        try {
          await r.request('apply_flag_settings', { settings: { env } });
        } catch { /* 进程忙 / 已退出：下次启动时经 --settings 生效 */ }
        if (this.hasSubscribers(r.sessionId)) void this.fetchContext(r).catch(() => {});
      }),
    );
    // 没有进程、但面板开着的会话：只改设置值，触发点要等进程启动后由 CLI 报告
    for (const [id, usage] of this.contextCache) {
      if (this.runners.get(id)?.alive || !this.hasSubscribers(id)) continue;
      const next = { ...usage, compactWindow: window };
      this.contextCache.set(id, next);
      this.emit(id, { t: 'context', sessionId: id, usage: next });
    }
    return window;
  }

  /**
   * 移除一个用户级 / 项目级 skill：目录移到 ~/.cosyee/removed-skills（可手动放回恢复），清掉它的已存状态，
   * 并让正在运行的进程也把它关掉（进程里已加载的内容要到新会话才会真正消失）。
   */
  async removeSkill(sessionId: string | null, name: string, cwd: string | null): Promise<{ backup: string }> {
    const dir = sessionId ? this.accounts?.resolve(sessionId)?.dir ?? null : null;
    let backup: string;
    try {
      backup = removeDiskSkill(name, dir ?? baseClaudeHome(), cwd, path.join(cosyeeHome(), 'removed-skills'));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    this.removedSkills.add(name);
    this.skills?.remove(name);
    for (const m of [this.initSkills, this.initSkillsByCwd]) {
      for (const [k, list] of m) m.set(k, list.filter((n) => n !== name));
    }
    const map = { ...(this.skills?.get() ?? {}), [name]: 'off' as SkillMode };
    const alive = [...this.runners.values()].filter((r) => r.alive);
    await Promise.all(
      alive.map(async (r) => {
        try {
          await r.request('apply_flag_settings', { settings: { skillOverrides: map } });
        } catch { /* 进程忙 / 已退出 */ }
        if (this.hasSubscribers(r.sessionId)) void this.fetchContext(r).catch(() => {});
      }),
    );
    for (const [id, usage] of this.contextCache) {
      if (this.runners.get(id)?.alive || !this.hasSubscribers(id)) continue;
      const next = { ...usage, skills: usage.skills.filter((s) => s.name !== name) };
      this.contextCache.set(id, next);
      this.emit(id, { t: 'context', sessionId: id, usage: next });
    }
    return { backup };
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
    this.initTools.clear();
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
      this.initTools.delete(id);
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

  /** 会话所在的工作目录：该会话有过进程时的 cwd（文件预览用它划定可读范围）；没有则 undefined，调用方再查会话记录 */
  knownCwd(id: string): string | undefined {
    return this.cwdOf.get(id);
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
