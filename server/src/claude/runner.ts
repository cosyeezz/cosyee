// 一个会话一个 claude 进程（stream-json 双向）。负责：启动 / 读写 / 回合状态机 / control_request /
// 中断 / 空闲回收。不关心 WebSocket 订阅者，通过 RunnerHooks 把结果交给 manager。
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import type {
  AppliedSettings,
  AskQuestion,
  CosyeeUserEvent,
  PendingPrompt,
  PermissionMode,
  PromptReply,
  QueueItem,
  QueueMode,
  RunStatus,
  SessionConfig,
} from '@cosyee/shared';
import { LineSplitter, parseLine } from '../transcript.js';
import { claudeEnv, resolveClaude, spawnSpec } from './bin.js';
import { ControlTracker } from './control.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface RunnerHooks {
  /** CLI 的一个事件（或合成的 cosyee_user），应广播给订阅者 */
  onEvent(e: unknown): void;
  onStatus(status: RunStatus, error?: string): void;
  onSettings(applied: AppliedSettings): void;
  /** 一轮结束（回到 idle，或进程在回合中意外退出）；进程可能仍在，也可能已不在 */
  onTurnEnd(): void;
  /** 排队消息列表变了（完整快照）：新排入、开始执行、被撤回、进程退出 */
  onQueue?(items: QueueItem[]): void;
  /** 待用户回应的请求（AskUserQuestion / ExitPlanMode）变了（完整快照） */
  onPrompts?(items: PendingPrompt[]): void;
  /** 进程已退出，runner 可丢弃 */
  onExit(): void;
}

export interface RunnerTimings {
  idleMs: number;
  probeIdleMs: number;
  interruptKillMs: number;
  /** result 之后没有后台任务、也没等到续轮时，多久判定本轮真的结束 */
  limboQuietMs: number;
  /** result 之后仍有后台任务时，多久没有任何输出就放弃等待 */
  limboBusyMs: number;
  requestTimeoutMs: number;
}

export const DEFAULT_TIMINGS: RunnerTimings = {
  idleMs: 30 * 60_000,
  probeIdleMs: 60_000,
  interruptKillMs: 5_000,
  limboQuietMs: 20_000,
  limboBusyMs: 15 * 60_000,
  requestTimeoutMs: 30_000,
};

export interface RunnerInit {
  sessionId: string;
  cwd: string;
  /** true：--session-id（新会话）；false：--resume */
  isNew: boolean;
  config: SessionConfig;
  hooks: RunnerHooks;
  /** 仅为读取上下文 / 设置而启动（不发消息），空闲回收更快 */
  probe?: boolean;
  timings?: Partial<RunnerTimings>;
  /** 测试用：覆盖 claude 路径 */
  claudePath?: string;
  /** 每次启动时读取，合并进 --settings（如 skillOverrides） */
  flagSettings?: () => Record<string, unknown>;
  /** 用哪个账号启动（多账号）：dir 为 null = 默认账号；不传 = 当前账号 */
  account?: { id: string; dir: string | null };
}

const EVENT_BUFFER_MAX = 100_000;
const STDERR_TAIL_BYTES = 8 * 1024;
// 第三方兼容服务的模型名可能带 / : @ +（provider/model、model:tag），一并放过；仍然排除空白与引号
const MODEL_RE = /^[A-Za-z0-9._:/@+[\]-]{1,120}$/;
/** 思考显示模式：CLI 可选 summarized / omitted / highlights（highlights 仅 Anthropic 托管会话可用） */
export const THINKING_DISPLAY = 'summarized';

export function validateConfig(c: SessionConfig): void {
  if (!c || typeof c.model !== 'string' || !MODEL_RE.test(c.model)) throw new Error('model 不合法');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(c.effort)) throw new Error('effort 不合法');
  if (c.permissionMode !== undefined && c.permissionMode !== 'auto' && c.permissionMode !== 'plan') throw new Error('permissionMode 不合法');
}

/** 会话权限模式 -> CLI 的 --permission-mode / set_permission_mode 值 */
export function cliPermissionMode(m?: PermissionMode): 'plan' | 'bypassPermissions' {
  return m === 'plan' ? 'plan' : 'bypassPermissions';
}

/** AskUserQuestion 的 questions 输入清洗：只留字符串 / 布尔字段，丢弃畸形项 */
function sanitizeQuestions(raw: unknown[]): AskQuestion[] {
  const out: AskQuestion[] = [];
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const o = q as Json;
    if (typeof o.question !== 'string' || !Array.isArray(o.options)) continue;
    const options: AskQuestion['options'] = [];
    for (const op of o.options) {
      if (!op || typeof op !== 'object' || typeof op.label !== 'string') continue;
      options.push(typeof op.description === 'string' ? { label: op.label, description: op.description } : { label: op.label });
    }
    const item: AskQuestion = { question: o.question, options };
    if (typeof o.header === 'string') item.header = o.header;
    if (typeof o.multiSelect === 'boolean') item.multiSelect = o.multiSelect;
    out.push(item);
  }
  return out;
}

/**
 * 追加到 CLI 系统提示词的路径引用约定（同 axiom2）：模型用 Markdown 链接引用文件，
 * 前端据此把路径渲染成可点击、可预览的文件按钮。正斜杠避免 `\.` 等被 Markdown 当转义吃掉，
 * 含空格的路径用 <> 包住，否则链接目标会在空格处截断。
 */
export const PATH_PROMPT =
  'When referencing files, use Markdown links: [filename](path). Prefer absolute paths with forward slashes ' +
  '(e.g. [runner.ts](F:/repo/src/runner.ts)); append :line for a specific line ([runner.ts](F:/repo/src/runner.ts:42)); ' +
  'wrap the target in <> when the path contains spaces ([a b.md](<F:/repo/a b.md>)). Do not put file links inside backticks.';

/**
 * 分工约定：主会话负责理解、设计与最终判断，把耗 token 的搜索 / 实现交给 Sonnet 子代理。
 * 主会话每轮都要重读整个上下文，大段工具输出留在子代理里能持续省钱。不论主会话用什么模型都追加。
 */
export const DELEGATION_PROMPT =
  'Delegation policy: the main session owns understanding, ' +
  'design and every final judgment; delegate token-heavy legwork to subagents with model "sonnet". ' +
  '(1) Search / diagnosis: when locating something means sweeping many files, directories or naming conventions, use an ' +
  'Explore subagent. It only locates and gathers evidence, never concludes: each finding = file:line + a 5-10 line key ' +
  'snippet + a one-line reason. Judge from the snippets; re-read the source only when unsure. Targeted lookups that one ' +
  'or two Grep/Read calls can settle, do yourself. ' +
  '(2) Implementation: clarify requirements, read the necessary code, split the work into independent tasks, then give each ' +
  'general-purpose subagent a self-contained spec: files/functions to change (with paths) and what not to touch; ' +
  'interface signatures, data structures, naming; existing code to imitate (file:line); acceptance criteria (build, lint, ' +
  'tests pass; expected behavior). Require a report with a change summary plus the verification commands and results. ' +
  'Review the diff yourself; send fixes back to the same subagent via SendMessage rather than spawning a new one. ' +
  '(3) Parallelism: only for independent tasks, split by module; define shared interfaces first; never let two subagents ' +
  'edit the same file. Worktree isolation starts from HEAD and cannot see uncommitted changes, so if the working tree is ' +
  'dirty, split by disjoint files in the main working tree instead. ' +
  '(4) Keep for yourself: small changes (roughly under a few dozen lines), cross-layer changes that need decisions along ' +
  'the way, UI tweaks that need visual iteration, and all final judgments (is it a bug, which design to choose).';

/** 每次启动追加到系统提示词的全部内容 */
// 不能含换行：claude 若解析到 .cmd / .bat，参数要经 cmd.exe 转发，换行会把整条命令行截断
export const APPEND_PROMPT = `${PATH_PROMPT} ${DELEGATION_PROMPT}`;

/** 构造 claude 命令行参数（不含可执行文件）。 */
export function buildArgs(sessionId: string, isNew: boolean, config: SessionConfig, extraSettings: Record<string, unknown> = {}): string[] {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--forward-subagent-text',
    // 让 CLI 在“用户消息真正进入对话”的时刻回显它（isReplay）。运行中写入的消息会先被 CLI 排队，
    // 等当前这批工具跑完才插入；回显就是插入点，runner 据此精确知道“写了几条还没进对话”。
    '--replay-user-messages',
    // 权限：auto = bypassPermissions（等同 --dangerously-skip-permissions），plan = 计划模式。
    // --permission-prompt-tool stdio 必须带：否则 -p 下根本没有 AskUserQuestion / ExitPlanMode 这两个工具；
    // 带了之后它们（以及 plan 模式下的写文件等）以 control_request can_use_tool 交给我们，由 runner 放行或转给前端。
    '--allow-dangerously-skip-permissions',
    '--permission-mode', cliPermissionMode(config.permissionMode),
    '--permission-prompt-tool', 'stdio',
    '--model', config.model,
    '--effort', config.effort,
    // 每次启动都要带：--resume 不会沿用上次进程的追加提示词
    '--append-system-prompt', APPEND_PROMPT,
  ];
  const settings: Record<string, unknown> = { ...extraSettings };
  if (config.ultracode) settings.ultracode = true;
  if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));
  args.push(isNew ? '--session-id' : '--resume', sessionId);
  return args;
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } catch { /* ignore */ }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
}

function killTreeSync(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } catch { /* ignore */ }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
}

export class Runner {
  readonly sessionId: string;
  readonly cwd: string;
  /** 进程所属账号 id；没指定（旧调用方式）为 null */
  readonly accountId: string | null;
  private readonly accountDir: string | null | undefined;
  private readonly hooks: RunnerHooks;
  private readonly timings: RunnerTimings;
  private readonly claudePath: string;

  private proc: ChildProcess | null = null;
  private control: ControlTracker;
  private splitter = new LineSplitter();
  private stderrTail = '';

  private _status: RunStatus = 'idle';
  private buffer: unknown[] = [];
  /** 当前（或最近一次启动时）已生效的配置，用于判断要不要发 set_model / apply_flag_settings */
  private applied: SessionConfig;
  private chain: Promise<void> = Promise.resolve();
  /** 等用户回应的 can_use_tool 请求（AskUserQuestion / ExitPlanMode），及各自的原始工具输入（构造 updatedInput 用） */
  private prompts: PendingPrompt[] = [];
  private promptInputs = new Map<string, Json>();

  // 回合状态
  private turnSeq = 0;
  /**
   * 运行中发给 CLI、还没开始执行的消息（lifecycle 仍处于 queued），按写入顺序。
   * 由 command_lifecycle 驱动：started / completed / cancelled / discarded / refused 都会移出。
   * 空闲时发的开轮消息不在内（cosyee_user 在 send 时就发了）。
   */
  private queue: QueueItem[] = [];
  private interrupting = false;
  /** rewind_conversation 在途：它带来的中断 result 当作本轮结束（不等排队消息续轮） */
  private rewinding = false;
  /** result 已到但本轮还没真正结束（等待续轮 / 后台任务 / 未开始的排队消息） */
  private limbo = false;
  /** result 之后是否还在等排队消息续轮 */
  private expectNext = false;
  private tasks = new Set<string>();

  private idleTimer: NodeJS.Timeout | null = null;
  private limboTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;

  /** 我们主动结束进程（空闲回收、中断后杀、关闭）：退出时不算异常 */
  private intentional = false;
  private closed = false;
  private probeMode: boolean;

  constructor(init: RunnerInit) {
    this.sessionId = init.sessionId;
    this.cwd = init.cwd;
    this.accountId = init.account?.id ?? null;
    this.accountDir = init.account ? init.account.dir : undefined;
    this.hooks = init.hooks;
    this.applied = { ...init.config };
    this.probeMode = !!init.probe;
    this.timings = { ...DEFAULT_TIMINGS, ...init.timings };
    this.claudePath = init.claudePath ?? resolveClaude();
    this.control = new ControlTracker((o) => this.writeLine(o), `cosyee-${this.sessionId.slice(0, 8)}`, this.timings.requestTimeoutMs);
    this.initArgs = { isNew: init.isNew, flagSettings: init.flagSettings };
  }

  private initArgs: { isNew: boolean; flagSettings?: () => Record<string, unknown> };

  get status(): RunStatus {
    return this._status;
  }

  /** 进程是否在（可以收发 control_request） */
  get alive(): boolean {
    return this.proc !== null && !this.closed && !this.intentional;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** 订阅时补发用：当前回合已缓冲的事件 */
  snapshot(): { status: RunStatus; events: unknown[] } {
    return { status: this._status, events: this.buffer.slice() };
  }

  // ───────────── 启动 ─────────────

  /** 启动进程。cwd 不存在 / 启动失败会抛错。 */
  start(): void {
    if (this.proc) return;
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(this.cwd);
    } catch { /* 下面报错 */ }
    if (!st?.isDirectory()) throw new Error(`工作目录不存在: ${this.cwd}`);

    const args = buildArgs(this.sessionId, this.initArgs.isNew, this.applied, this.initArgs.flagSettings?.() ?? {});
    const spec = spawnSpec(this.claudePath, args);
    const proc = spawn(spec.command, spec.args, {
      cwd: this.cwd,
      env: claudeEnv(this.accountDir),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
    });
    this.proc = proc;
    this.closed = false;
    this.intentional = false;
    // 之后重启一律用 --resume
    this.initArgs.isNew = false;

    proc.stdout!.on('data', (d: Buffer) => {
      for (const line of this.splitter.push(d)) this.onLine(line);
    });
    proc.stderr!.on('data', (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-STDERR_TAIL_BYTES);
    });
    proc.stdin!.on('error', () => { /* 进程已退出的 EPIPE，由 close 处理 */ });
    proc.on('error', (err) => this.onClose(null, `无法启动 claude: ${err.message}`));
    proc.on('close', (code, signal) => this.onClose(code, signal ? `被信号 ${signal} 终止` : undefined));

    if (this.probeMode) {
      this._status = 'idle';
      this.armIdle(this.timings.probeIdleMs);
    } else {
      this.setStatus('starting');
    }
    // 先开思考摘要（必须在第一条用户消息之前写入 stdin），再查一次 settings
    // （CLI 在收到第一条消息前就能响应 control_request）
    this.enableThinkingSummaries();
    void this.refreshSettings();
  }

  /**
   * 让模型返回思考摘要文本。CLI 默认 thinking_display 为 "updates"，思考文本恒为空串；
   * 设为 "summarized" 后 thinking_delta / assistant 的 thinking 块带摘要文本（transcript 也会保存）。
   * 只改显示模式，不带 max_thinking_tokens（预算保持不变）。
   * 同步写入 stdin，保证排在随后的用户消息之前；旧版 CLI 不支持时回错误，忽略即可。
   */
  private enableThinkingSummaries(): void {
    this.control.request('set_max_thinking_tokens', { thinking_display: THINKING_DISPLAY }).catch((e) => {
      console.warn(`[runner ${this.sessionId.slice(0, 8)}] 开启思考摘要失败:`, e instanceof Error ? e.message : e);
    });
  }

  // ───────────── 发送 ─────────────

  /**
   * 发一条用户消息。同步完成 spawn 与状态切换；config 的下发与写入在内部串行进行。
   * 空闲时开新一轮（立即发 cosyee_user，mode:'start'）；运行中则排队：立刻写给 CLI（CLI 自己排队），
   * 记入排队列表并通知（hooks.onQueue），不发 cosyee_user；等 CLI 真正开始执行它（lifecycle started / 回显）时再发。
   * id：消息 uuid（写进 stdin 的 uuid，lifecycle / 回显 / transcript 的关联键），没传则生成一个。
   * mode：运行中的排队方式，next=steering（并入当前轮），later=follow-up（本轮结束后另开一轮），缺省 next；空闲时忽略。
   */
  send(text: string, config: SessionConfig, id?: string, mode?: QueueMode): void {
    validateConfig(config);
    this.clearIdle();
    if (this.proc && !this.alive) throw new Error('claude 进程正在关闭，请稍后重试');
    const fresh = !this.proc;
    this.probeMode = false; // 在 start 之前清：发消息启动的进程按正常回合走（starting），开轮事件才会进缓冲
    if (fresh) {
      this.applied = { ...config };
      this.start();
    }
    const uuid = id || randomUUID();

    if (this._status === 'idle' && !fresh) {
      // 新一轮
      this.beginTurn();
      this.setStatus('running');
    } else if (fresh) {
      this.beginTurn();
    } else {
      // 运行中：排队，等 lifecycle started / 回显
      const m: QueueMode = mode === 'later' ? 'later' : 'next';
      this.setQueue([...this.queue, { id: uuid, text, mode: m, at: Date.now() }]);
      this.queueWrite(text, config, uuid, m);
      return;
    }

    const ev: CosyeeUserEvent = { type: 'cosyee_user', text, at: Date.now(), id: uuid, mode: 'start' };
    this.pushEvent(ev);
    this.queueWrite(text, config, uuid);
  }

  /** priority 缺省表示开轮消息（CLI 视同 next）；排队的消息显式带上 */
  private queueWrite(text: string, config: SessionConfig, uuid: string, priority?: QueueMode): void {
    this.chain = this.chain
      .then(async () => {
        if (!this.alive) return;
        await this.applyConfig(config);
        const frame: Json = { type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } };
        if (priority) frame.priority = priority;
        this.writeLine(frame);
      })
      .catch((e) => console.warn(`[runner ${this.sessionId.slice(0, 8)}] 发送失败:`, e instanceof Error ? e.message : e));
  }

  private beginTurn(): void {
    this.turnSeq++;
    this.buffer = [];
    this.interrupting = false;
    this.limbo = false;
    this.tasks.clear();
    this.clearLimbo();
  }

  // ───────────── 排队消息（由 command_lifecycle 驱动） ─────────────

  /** 排队列表（拷贝）：订阅时补发快照用 */
  queueItems(): QueueItem[] {
    return this.queue.map((q) => ({ ...q }));
  }

  private setQueue(items: QueueItem[]): void {
    if (items.length === 0 && this.queue.length === 0) return;
    this.queue = items;
    this.hooks.onQueue?.(this.queueItems());
  }

  /** 把一条消息移出排队列表（已开始 / 已完成 / 被取消 / 被拒绝）；返回被移出的记录 */
  private takeQueued(id: string): QueueItem | undefined {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i < 0) return undefined;
    const item = this.queue[i]!;
    this.setQueue(this.queue.filter((_, j) => j !== i));
    return item;
  }

  /**
   * 排队的消息开始被 CLI 执行：发 cosyee_user（前端据此开始 / 切换到这一条的显示）。
   * 若此刻 runner 已空闲（CLI 另开了一轮）或本轮 result 已到（limbo 等续轮），先开新一轮（清缓冲）；
   * 仍在同一轮里（steering 并入）则不动缓冲。lifecycle started 与回显谁先到谁触发，
   * 另一个到时记录已不在，直接忽略（steering 是回显先于 started，later / send_now 是 started 先于回显）。
   */
  private startQueued(id: string): void {
    const item = this.takeQueued(id);
    if (!item) return;
    if (this._status === 'idle' || this.limbo) {
      this.beginTurn();
      this.clearIdle();
      this.setStatus('running');
    }
    const ev: CosyeeUserEvent = { type: 'cosyee_user', text: item.text, at: Date.now(), id: item.id, mode: item.mode };
    this.pushEvent(ev);
  }

  /** 排队的消息没有开始就结束了（撤回 / 作废 / 拒绝）。若正等它续轮、已无别的可等，收尾本轮 */
  private dropQueued(id: string): void {
    if (!this.takeQueued(id)) return;
    if (this.limbo && this.queue.length === 0 && this.tasks.size === 0) this.finishTurn();
  }

  /** command_lifecycle 帧：按 command_uuid 维护排队列表。帧本身不转发给前端 */
  private onLifecycle(msg: Json): void {
    const id = msg.command_uuid;
    if (typeof id !== 'string') return;
    switch (msg.state) {
      case 'started':
        this.startQueued(id);
        break;
      case 'completed':
      case 'cancelled':
      case 'discarded':
      case 'refused':
        this.dropQueued(id);
        break;
      // queued：send 时已记账
    }
  }

  /** --replay-user-messages 的回显：是排队消息的“开始”信号之一；开轮消息（不在列表里）的回显直接丢弃 */
  private onEcho(msg: Json): void {
    if (typeof msg.uuid === 'string') this.startQueued(msg.uuid);
  }

  /** 修改配置：进程在则立即下发（下一轮生效），否则只记下，启动时用。 */
  setConfig(config: SessionConfig): void {
    validateConfig(config);
    if (!this.alive) {
      this.applied = { ...config };
      return;
    }
    this.chain = this.chain
      .then(() => (this.alive ? this.applyConfig(config) : undefined))
      .catch((e) => console.warn(`[runner ${this.sessionId.slice(0, 8)}] 设置失败:`, e instanceof Error ? e.message : e));
  }

  private async applyConfig(config: SessionConfig): Promise<void> {
    const cur = this.applied;
    let changed = false;
    if (config.model !== cur.model) {
      await this.control.request('set_model', { model: config.model });
      cur.model = config.model;
      changed = true;
    }
    if ((config.permissionMode ?? 'auto') !== (cur.permissionMode ?? 'auto')) {
      await this.control.request('set_permission_mode', { mode: cliPermissionMode(config.permissionMode) });
      cur.permissionMode = config.permissionMode;
    }
    const flags: Json = {};
    if (config.effort !== cur.effort) flags.effortLevel = config.effort;
    if (config.ultracode !== undefined && !!config.ultracode !== !!cur.ultracode) flags.ultracode = !!config.ultracode;
    if (Object.keys(flags).length > 0) {
      await this.control.request('apply_flag_settings', { settings: flags });
      cur.effort = config.effort;
      if (config.ultracode !== undefined) cur.ultracode = !!config.ultracode;
      changed = true;
    }
    if (changed) await this.refreshSettings();
  }

  /** get_settings -> hooks.onSettings（只取四个字段）。失败静默。 */
  async refreshSettings(): Promise<void> {
    try {
      const r = await this.control.request('get_settings');
      const a = (r.applied ?? {}) as Json;
      const out: AppliedSettings = {};
      if (typeof a.model === 'string') out.model = a.model;
      if (typeof a.effort === 'string') out.effort = a.effort as AppliedSettings['effort'];
      if (typeof a.ultracode === 'boolean') out.ultracode = a.ultracode;
      if (typeof a.ultracodeAvailable === 'boolean') out.ultracodeAvailable = a.ultracodeAvailable;
      this.hooks.onSettings(out);
    } catch { /* 进程退出或超时：忽略 */ }
  }

  /** 通用 control_request（context / rename 等由 manager 调用）。 */
  request(subtype: string, extra: Json = {}, timeoutMs?: number): Promise<Json> {
    if (!this.alive) return Promise.reject(new Error('进程不在运行'));
    return this.control.request(subtype, extra, timeoutMs);
  }

  // ───────────── 待回应的请求（AskUserQuestion / ExitPlanMode，经 can_use_tool） ─────────────

  /** 待回应列表（拷贝）：订阅时补发快照用 */
  promptItems(): PendingPrompt[] {
    return this.prompts.map((p) => ({ ...p }));
  }

  private notifyPrompts(): void {
    this.hooks.onPrompts?.(this.promptItems());
  }

  private clearPrompts(): void {
    if (this.prompts.length === 0) return;
    this.prompts = [];
    this.promptInputs.clear();
    this.notifyPrompts();
  }

  private dropPrompt(id: string): void {
    const i = this.prompts.findIndex((p) => p.id === id);
    if (i < 0) return;
    this.prompts = this.prompts.filter((_, j) => j !== i);
    this.promptInputs.delete(id);
    this.notifyPrompts();
  }

  /** 写 can_use_tool 的 control_response（进程已不在则忽略） */
  private respondPrompt(id: string, response: Json): void {
    try {
      this.writeLine({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
    } catch { /* 进程已退出 */ }
  }

  private onCanUseTool(id: string, req: Json): void {
    const input: Json = req.input && typeof req.input === 'object' ? req.input : {};
    const toolUseId = typeof req.tool_use_id === 'string' ? req.tool_use_id : undefined;
    let prompt: PendingPrompt | null = null;
    if (req.tool_name === 'AskUserQuestion' && Array.isArray(input.questions)) {
      const questions = sanitizeQuestions(input.questions);
      if (questions.length > 0) prompt = { kind: 'question', id, toolUseId, questions, at: Date.now() };
    } else if (req.tool_name === 'ExitPlanMode') {
      prompt = {
        kind: 'plan',
        id,
        toolUseId,
        plan: typeof input.plan === 'string' ? input.plan : '',
        planFilePath: typeof input.planFilePath === 'string' ? input.planFilePath : undefined,
        at: Date.now(),
      };
    }
    if (!prompt) {
      // 其余工具（含 plan 模式下写计划文件）自动放行
      this.respondPrompt(id, { behavior: 'allow', updatedInput: input });
      return;
    }
    this.promptInputs.set(id, input);
    this.prompts = [...this.prompts, prompt];
    this.notifyPrompts();
  }

  /**
   * 回应一个待处理的请求。没有这个 id 或回应类型与请求不符返回 false。
   * approve：放行 ExitPlanMode 并把会话切到 auto（bypassPermissions）。
   */
  reply(id: string, reply: PromptReply): boolean {
    const p = this.prompts.find((x) => x.id === id);
    if (!p || !reply || typeof reply !== 'object') return false;
    const orig = this.promptInputs.get(id) ?? {};
    let response: Json;
    let switchToAuto = false;
    if (p.kind === 'question' && reply.kind === 'answer') {
      const a = reply.answers;
      if (!a || typeof a !== 'object' || Array.isArray(a) || !Object.values(a).every((v) => typeof v === 'string')) return false;
      response = { behavior: 'allow', updatedInput: { ...orig, answers: { ...a } } };
    } else if (p.kind === 'question' && reply.kind === 'skip') {
      response = { behavior: 'deny', message: 'The user chose not to answer these questions. Continue with your best judgment.' };
    } else if (p.kind === 'plan' && reply.kind === 'approve') {
      response = { behavior: 'allow', updatedInput: orig };
      switchToAuto = true;
    } else if (p.kind === 'plan' && reply.kind === 'revise') {
      const fb = typeof reply.feedback === 'string' ? reply.feedback.trim() : '';
      response = {
        behavior: 'deny',
        message: fb
          ? `The user did not approve the plan. Their feedback:\n${fb}`
          : 'The user did not approve the plan. Revise the plan, or ask the user what to change.',
      };
    } else {
      return false;
    }
    this.dropPrompt(id);
    this.respondPrompt(id, response);
    if (switchToAuto) {
      // 批准后 CLI 自己落到 default 模式，再切到 bypassPermissions（= auto）
      this.applied.permissionMode = 'auto';
      this.chain = this.chain
        .then(() => (this.alive ? this.control.request('set_permission_mode', { mode: 'bypassPermissions' }).then(() => undefined) : undefined))
        .catch((e) => console.warn(`[runner ${this.sessionId.slice(0, 8)}] 切换权限模式失败:`, e instanceof Error ? e.message : e));
    }
    return true;
  }

  // ───────────── 中断 ─────────────

  interrupt(): void {
    if (!this.alive || (this._status !== 'running' && this._status !== 'starting')) return;
    this.interrupting = true;
    // 卡在等用户回应的工具先拒掉，CLI 才能顺利走中断流程
    for (const p of this.prompts) this.respondPrompt(p.id, { behavior: 'deny', message: 'The user interrupted.' });
    this.clearPrompts();
    const seq = this.turnSeq;
    this.control
      .request('interrupt')
      .then(() => {
        // result 之后的等待期没有"本轮"可结束，直接收尾
        if (this.turnSeq === seq && this.limbo) this.finishTurn();
      })
      .catch(() => {});
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      // 5 秒后本轮仍没结束：杀进程树。会话可用 --resume 继续
      if (this.turnSeq === seq && this.interrupting && this.proc) this.kill();
    }, this.timings.interruptKillMs);
  }

  /**
   * 撤回一条还没开始的排队消息（cancel_async_message）。ok = CLI 回 cancelled===true；
   * 此时 text 为我们记录的原文（前端填回输入框）。重复撤回 / 已开始执行 / 不存在都是 ok:false。
   */
  async cancelQueued(id: string): Promise<{ ok: boolean; text?: string }> {
    const item = this.queue.find((q) => q.id === id);
    await this.chain; // 保证消息已写进 stdin，撤回请求排在它后面
    const r = await this.request('cancel_async_message', { message_uuid: id });
    if (r.cancelled !== true) return { ok: false };
    // CLI 在 control_response 之前已发 cancelled 帧，通常这里已移出；没有 lifecycle 能力的旧 CLI 靠这一步
    this.dropQueued(id);
    return { ok: true, text: item?.text };
  }

  /**
   * 立即发送一条排队消息：中断当前这一轮并马上执行它（interrupt {send_now, message_uuid}）。
   * 被中断那一轮的 result 是 error_during_execution + terminal_reason aborted_tools，属用户主动行为，
   * 照常转发给前端（前端按 terminal_reason 显示“已中断”）。此时目标消息仍在排队列表里，
   * onResult 会据此保持 running（limbo），随后 lifecycle started → init → 回显，下一轮紧接着开始。
   * ok=false（state:'nothing_waiting'）表示它已经不在排队了（已开始或已被撤回）。
   */
  async sendNow(id: string): Promise<{ ok: boolean; state?: string }> {
    await this.chain;
    const r = await this.request('interrupt', { send_now: true, message_uuid: id });
    const state = typeof r.send_now === 'string' ? r.send_now : undefined;
    return { ok: state !== 'nothing_waiting', state };
  }

  /**
   * 回退到某条用户消息（rewind_conversation）：它及之后的对话被移出上下文。返回 CLI 的内层响应
   * （rewound / prefillText / error / reason）。执行中带 interrupt_if_running，CLI 先走一遍中断序列
   * （result aborted_tools 等，约比响应早 30ms），这一轮按正常结束处理，不等排队消息续轮。
   * 成功后清空排队列表（回退后排队的消息不再有意义）。
   */
  async rewind(targetId: string): Promise<Json> {
    await this.chain; // 保证此前发的消息已写进 stdin，回退请求排在它们后面
    const running = this._status === 'running' || this._status === 'starting';
    if (running) this.rewinding = true;
    try {
      const r = await this.request('rewind_conversation', {
        target_message_uuid: targetId,
        ...(running ? { interrupt_if_running: true } : {}),
      });
      if (r.rewound === true) {
        this.setQueue([]);
        // 中断的 result 已经到过、却因为还有排队消息 / 任务在等续轮：回退后不会有续轮了
        if (this.limbo) this.finishTurn();
      }
      return r;
    } finally {
      this.rewinding = false;
    }
  }

  /** 强制结束进程（意图性退出）。 */
  kill(): void {
    this.intentional = true;
    const pid = this.proc?.pid;
    if (pid) killTree(pid);
  }

  /** 同步杀（后端 exit 事件里用）。 */
  killSync(): void {
    this.intentional = true;
    const pid = this.proc?.pid;
    if (pid && !this.closed) killTreeSync(pid);
  }

  /** 优雅关闭：关 stdin，宽限期后强杀。 */
  shutdown(graceMs = 2000): void {
    this.intentional = true;
    this.clearTimers();
    const proc = this.proc;
    if (!proc || this.closed) return;
    try {
      proc.stdin!.end();
    } catch { /* ignore */ }
    const pid = proc.pid;
    const t = setTimeout(() => {
      if (pid && !this.closed) killTree(pid);
    }, graceMs);
    t.unref();
  }

  // ───────────── 读取 ─────────────

  private writeLine(obj: Json): void {
    const stdin = this.proc?.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) throw new Error('claude 进程的 stdin 已关闭');
    stdin.write(JSON.stringify(obj) + '\n');
  }

  private onLine(line: string): void {
    const msg = parseLine(line);
    if (!msg) return;
    this.handleMessage(msg);
  }

  /** 测试用入口：直接喂入一个已解析的 stdout 消息。 */
  handleMessage(msg: Json): void {
    switch (msg.type) {
      case 'control_response':
        this.control.handleResponse(msg);
        return;
      case 'control_cancel_request':
        // CLI 撤销了一个待回应的请求（如中断）：丢掉对应的 prompt
        if (typeof msg.request_id === 'string') this.dropPrompt(msg.request_id);
        return;
      case 'control_request': {
        // CLI 反向请求。can_use_tool：AskUserQuestion / ExitPlanMode 转成待回应 prompt 交给前端，
        // 其余工具（plan 模式下写计划文件等）一律放行；其它 subtype（hook / mcp 等）回错误避免它一直等
        const id = msg.request_id;
        if (typeof id === 'string' && msg.request?.subtype === 'can_use_tool') {
          this.onCanUseTool(id, msg.request);
        } else if (typeof id === 'string') {
          try {
            this.writeLine({ type: 'control_response', response: { subtype: 'error', request_id: id, error: 'not supported by cosyee host' } });
          } catch { /* ignore */ }
        }
        return;
      }
    }

    // 消息生命周期（排队 / 开始 / 完成 / 取消）：只维护排队列表，不转发
    if (msg.type === 'command_lifecycle') {
      this.onLifecycle(msg);
      if (this.limbo) this.armLimbo();
      return;
    }

    if (this._status === 'starting') this.setStatus('running');

    // 用户消息回显（--replay-user-messages）：不转发；排队消息借此（或 lifecycle started）发 cosyee_user
    if (msg.type === 'user' && msg.isReplay === true) {
      this.onEcho(msg);
      if (this.limbo) this.armLimbo();
      return;
    }

    const isTurnStart =
      (msg.type === 'system' && msg.subtype === 'init') || msg.type === 'stream_event' || msg.type === 'assistant';

    // idle 时收到本轮内容：CLI 在后台子代理完成后自动续轮，视作新一轮（没有 cosyee_user）
    if (this._status === 'idle' && isTurnStart && this.alive) {
      this.beginTurn();
      this.clearIdle();
      this.setStatus('running');
    } else if (this.limbo && isTurnStart) {
      this.limbo = false;
      this.expectNext = false;
      this.clearLimbo();
    }

    if (msg.type === 'system') this.trackTasks(msg);

    this.pushEvent(msg);

    if (msg.type === 'result') this.onResult();
    else if (this.limbo) this.armLimbo();
  }

  private trackTasks(msg: Json): void {
    switch (msg.subtype) {
      case 'background_tasks_changed': {
        this.tasks.clear();
        if (Array.isArray(msg.tasks)) for (const t of msg.tasks) if (t && typeof t.task_id === 'string') this.tasks.add(t.task_id);
        break;
      }
      case 'task_started':
        if (typeof msg.task_id === 'string') this.tasks.add(msg.task_id);
        break;
      case 'task_notification':
        if (typeof msg.task_id === 'string') this.tasks.delete(msg.task_id);
        break;
      case 'task_updated': {
        const st = msg.patch?.status;
        if (typeof msg.task_id === 'string' && (st === 'completed' || st === 'failed' || st === 'killed' || st === 'cancelled')) {
          this.tasks.delete(msg.task_id);
        }
        break;
      }
    }
  }

  private pushEvent(e: unknown): void {
    // 只缓冲回合内的事件：空闲时的零散事件（切权限模式的 system/status、探针进程启动时的输出等）
    // 若进了缓冲，订阅时会被当成「当前回合」replay，前端据此丢掉历史最后一轮
    const inTurn = this._status === 'starting' || this._status === 'running';
    if (inTurn && this.buffer.length < EVENT_BUFFER_MAX) this.buffer.push(e);
    this.hooks.onEvent(e);
  }

  private onResult(): void {
    if (this.interrupting || this.rewinding) {
      this.finishTurn();
      return;
    }
    // 排队列表里还有没开始的消息：CLI 会自动为它开下一轮（send_now 中断后、later 都是这样）。
    // steering 并入当前轮的消息在 result 之前就 started 了，不在列表里，不会误判。
    const more = this.queue.length > 0;
    this.expectNext = more;
    // 还有排队的消息 / 后台任务：保持 running，等 CLI 自动续轮
    if (more || this.tasks.size > 0) {
      this.limbo = true;
      this.armLimbo();
      return;
    }
    // 没有任何后台任务：CLI 不会再续轮，本轮结束
    this.finishTurn();
  }

  /** limbo：result 已到，但还在等续轮。没有任务时短等，有任务时长等，期间任何输出都会重新计时。 */
  private armLimbo(): void {
    this.clearLimbo();
    const ms = this.tasks.size > 0 || this.expectNext ? this.timings.limboBusyMs : this.timings.limboQuietMs;
    this.limboTimer = setTimeout(() => {
      this.limboTimer = null;
      if (this.limbo) this.finishTurn();
    }, ms);
  }

  private clearLimbo(): void {
    if (this.limboTimer) clearTimeout(this.limboTimer);
    this.limboTimer = null;
  }

  private finishTurn(): void {
    if (this._status === 'idle') return;
    this.limbo = false;
    this.expectNext = false;
    this.interrupting = false;
    this.tasks.clear();
    this.clearLimbo();
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.buffer = [];
    this.clearPrompts();
    this.setStatus('idle');
    if (this.alive) this.armIdle(this.timings.idleMs);
    this.hooks.onTurnEnd();
  }

  private setStatus(s: RunStatus, error?: string): void {
    if (this._status === s && !error) return;
    this._status = s;
    this.hooks.onStatus(s, error);
  }

  // ───────────── 空闲回收 ─────────────

  private armIdle(ms: number): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this._status !== 'idle' || !this.proc) return;
      this.intentional = true;
      try {
        this.proc.stdin!.end();
      } catch { /* ignore */ }
      const pid = this.proc.pid;
      const t = setTimeout(() => {
        if (pid && !this.closed) killTree(pid);
      }, 5000);
      t.unref();
    }, ms);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private clearTimers(): void {
    this.clearIdle();
    this.clearLimbo();
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
  }

  // ───────────── 退出 ─────────────

  private onClose(code: number | null, why?: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const line of this.splitter.flush()) this.onLine(line);
    this.control.rejectAll('claude 进程已退出');
    this.setQueue([]); // 进程没了，排队的消息也没了
    this.clearPrompts(); // 待回应的请求也随进程失效（没法再写回）
    this.clearTimers();
    this.proc = null;

    const wasTurn = this._status === 'running' || this._status === 'starting';
    const failed = !!why || (code !== null && code !== 0);

    if (this.intentional) {
      // 空闲回收 / 中断超时被杀 / 关闭：对前端表现为"空闲、可用 --resume 续聊"，不报 exited
      this.buffer = [];
      if (wasTurn) {
        this.setStatus('idle');
        this.hooks.onTurnEnd();
      }
    } else {
      const tail = this.stderrTail.trim();
      const error = failed ? `${why ?? `claude 退出码 ${code}`}${tail ? `\n${tail}` : ''}` : undefined;
      this.buffer = [];
      this.setStatus('exited', error);
      if (wasTurn) this.hooks.onTurnEnd();
    }
    this.hooks.onExit();
  }
}
