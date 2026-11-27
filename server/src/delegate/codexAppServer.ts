// Codex CLI 的 app-server（codex app-server --listen stdio://）常驻进程池：结构与 acp.ts 的 AcpPool 对应——
// 按「可执行文件 + 账号 + 工作区」分桶，每进程多线程（thread）并发 + 弹性扩容，绝不跨账号或跨 cwd 复用；
// 用「首次输出看门狗 + 空闲看门狗 + 崩溃重试一次」兜底。线路层是 jsonRpc.ts，事件翻译是 codexEvents.ts。
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import type { DelegateModelList, SubagentAvailability } from '@cosyee/shared';
import { codexAccountArgs, codexAccountEnv, ensureCodexHome } from '../accounts/codex-env.js';
import { DEFAULT_ID } from '../accounts/index.js';
import { killTree, killTreeSync, spawnSpec } from '../claude/bin.js';
import type { Json } from '../transcript.js';
import { CRASH_RETRY_PREFIX } from './acp.js';
import { BackendError, type BackendResult, type BackendRunOptions, type DelegateBackend } from './backend.js';
import { CODEX_NOT_LOGGED_IN, type CodexInfo, probeCodexVersion, resolveCodexInfo } from './codex.js';
import { CodexTurnTranslator, ZERO_USAGE, parseCodexModels } from './codexEvents.js';
import {
  type CodexAccountInfo,
  MIN_CODEX_VERSION,
  N,
  type ModelListPage,
  RpcError,
  SR,
  type RateLimitSnapshot,
  type SandboxMode,
  type SandboxPolicy,
  type ThreadOpenResult,
  type TokenUsageBreakdown,
  isProtocolIncompatible,
  parseAccount,
  parseModelPage,
  parseRateLimitsResponse,
  parseThreadOpen,
  parseTokenUsage,
  parseTurnStart,
  threadIdOf,
  versionLess,
} from './codexProtocol.js';
import { JsonRpcConnection } from './jsonRpc.js';
import { CodexUsageAdapter } from './usage/codexUsage.js';

// ───────────── 账号来源 ─────────────

export interface CodexAccountRef {
  id: string;
  /** CODEX_HOME 目录；null = 默认账号（沿用宿主环境 / ~/.codex） */
  dir: string | null;
  label?: string;
}

/** 组件 / 账号模块需要实现的最小接口 */
export interface CodexAccountSource {
  /** 当前活跃账号 */
  active(): CodexAccountRef;
  /** 按 id 取账号（续接会话 / 委派路线用）；账号已移除返回 null */
  accountFor(id: string): CodexAccountRef | null;
  /** 当前活跃账号是否已登录：false = 明确未登录；true = 已登录；'unknown' = 未知 / 探测中 */
  activeLoggedIn(): boolean | 'unknown';
  /** 指定账号是否已登录（不起进程不联网）；账号不存在返回 null */
  loggedIn?(id: string): boolean | 'unknown' | null;
}

const DEFAULT_ACCOUNT: CodexAccountRef = { id: DEFAULT_ID, dir: null };

const DEFAULT_ACCOUNTS: CodexAccountSource = {
  active: () => DEFAULT_ACCOUNT,
  accountFor: (id) => (id === DEFAULT_ID ? DEFAULT_ACCOUNT : null),
  activeLoggedIn: () => 'unknown',
};

/** 账号未登录时的报错文案 */
export function codexNotLoggedInMessage(account: CodexAccountRef): string {
  if (account.id === DEFAULT_ID) return CODEX_NOT_LOGGED_IN;
  return `Codex 账号「${account.label || account.id}」未登录：请在设置里重新登录该账号`;
}

// ───────────── 常量 / 小工具 ─────────────

const isWin = process.platform === 'win32';
/** 算作「有进度」的 update 类型 */
const PROGRESS_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
const CLIENT_INFO = { name: 'cosyee', title: 'Cosyee', version: '1' };
const USER_INPUT_PLACEHOLDER = '这是无人值守的委派任务，无法向用户提问。请按你认为最合理的默认方案继续，并在最终回答里说明所做的假设。';

export interface CodexRunOptions extends BackendRunOptions {
  execPath: string;
  /** 本次调用使用的 Codex 账号；不传 = 默认账号 */
  account?: CodexAccountRef;
}

export interface CodexPoolOptions {
  spawn?: typeof nodeSpawn;
  kill?: (pid: number) => void;
  now?: () => number;
  /** 当前活跃账号 id（hold 语义：切账号后只保活新账号的桶） */
  activeAccountId?: () => string;
  /** 需要保活的 codex 账号 id（委派路线里用到的）；传了就代替 activeAccountId 判断 hold */
  heldAccountIds?: () => readonly string[];
  /** 收到服务端推送 account/rateLimits/updated 时回调（更新账号额度缓存） */
  onRateLimits?: (accountId: string, raw: unknown) => void;
  sessionIdleMs?: number;
  processIdleMs?: number;
  extraProcessIdleMs?: number;
  sweepMs?: number;
  /** 第一条进度前最多等多久，默认 2 分钟（推理模型可能长时间不吐字，比 agy 放宽） */
  firstUpdateMs?: number;
  /** 运行中无工具调用时，多久无任何通知视为卡死，默认 10 分钟 */
  idleUpdateMs?: number;
  cancelGraceMs?: number;
  requestTimeoutMs?: number;
  maxPromptsPerProc?: number;
  maxProcsPerCwd?: number;
  /** 进程环境基底（测试注入）；默认 process.env */
  baseEnv?: NodeJS.ProcessEnv;
}

interface ThreadState {
  busy: boolean;
  lastUsed: number;
  model?: string;
  effort?: string;
  /** 本线程累计用量（含续接回放）；下一个 turn 的用量基线 */
  lastTotal: TokenUsageBreakdown | null;
  /** 只读：审批类服务端请求一律拒绝 */
  readOnly: boolean;
  /** 正在执行的 turn 的通知接收器 */
  sink?: (method: string, params: unknown) => void;
}

interface Lease {
  proc: CodexProc;
  release: () => void;
}

interface Waiter {
  sessionId?: string;
  signal: AbortSignal;
  resolve: (lease: Lease) => void;
  reject: (e: Error) => void;
  onAbort: () => void;
}

interface CwdPool {
  readonly accountId: string;
  readonly cwdKey: string;
  procs: CodexProc[];
  waiters: Waiter[];
}

interface Ctx {
  spawn: typeof nodeSpawn;
  kill: (pid: number) => void;
  killSync: (pid: number) => void;
  now: () => number;
  requestTimeoutMs: number;
  baseEnv: NodeJS.ProcessEnv;
  onGone: (p: CodexProc) => void;
  onRateLimits?: (accountId: string, raw: unknown) => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const cancelled = () => new Error('已取消');

function delay(ms: number): { p: Promise<'timeout'>; cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | undefined;
  const p = new Promise<'timeout'>((r) => {
    t = setTimeout(() => r('timeout'), ms);
  });
  return { p, cancel: () => t && clearTimeout(t) };
}

function abortPromise(signal: AbortSignal): { p: Promise<'abort'>; off: () => void } {
  let off = () => {};
  const p = new Promise<'abort'>((r) => {
    if (signal.aborted) return r('abort');
    const f = () => r('abort');
    signal.addEventListener('abort', f, { once: true });
    off = () => signal.removeEventListener('abort', f);
  });
  return { p, off };
}

/**
 * 每轮 turn/start 的沙箱：只读（内置 Explore / Plan、主会话计划模式）→ readOnly；
 * 否则完全访问（对齐 Antigravity 的 --dangerously-skip-permissions 与原生子代理）：委派是无人值守的，
 * approvalPolicy=never 下 workspace-write 写工作区外（npm 缓存、用户目录、上级 worktree）会直接失败。
 */
export function sandboxFor(readOnly: boolean): SandboxPolicy {
  return readOnly ? { type: 'readOnly', networkAccess: false } : { type: 'dangerFullAccess' };
}

/**
 * thread/start、thread/resume 一律以只读打开，真正的权限由每轮 turn/start 的 sandboxPolicy 决定（每轮都传，覆盖线程设置）。
 * 打开时就给 danger-full-access 的话，Codex 会把 git 仓库目录当成「用户信任的项目」写进 CODEX_HOME/config.toml
 * （默认账号就是用户自己的 ~/.codex），每个委派目录都会留下一条。
 */
const OPEN_SANDBOX: SandboxMode = 'read-only';

// ───────────── 进程 ─────────────

/**
 * 委派进程关掉的 Codex 功能：
 * - computer_use：操作用户桌面；委派是免审批 + 完全访问，不能让它接管键鼠。
 * - 下级代理：委派本身就是子代理，再派下级的话工具步骤全在下级线程里，界面看不到、额度和时长也不可控。
 *   v1（features.multi_agent）关开关即可；v2 由模型目录的 multi_agent_version 强制开启，features.multi_agent_v2=false 关不掉，
 *   只能把每个会话的线程上限压到 1（只剩根线程），spawn_agent 会直接返回 "agent thread limit reached"。
 *   用户配置里 multi_agent_v2 写成布尔或表都能被这条覆盖（离线假模型实测）。
 */
export const DELEGATE_FEATURE_ARGS = [
  '-c',
  'features.computer_use=false',
  '-c',
  'features.multi_agent=false',
  '-c',
  'features.multi_agent_v2.max_concurrent_threads_per_session=1',
] as const;

/**
 * 每个委派线程的开发者指令开头：明确它是执行者。
 * 用户自己的 ~/.codex/AGENTS.md 可能要求「主会话只编排、执行交给 subagent」，不说明的话模型会反复尝试派下级代理。
 * 真正挡住的是 DELEGATE_FEATURE_ARGS 的线程上限；这段只让模型一开始就自己动手，不浪费调用、也不因派发失败而放弃。
 */
export const DELEGATE_ROLE_INSTRUCTIONS =
  [
    '你是被上级会话委派的子代理（subagent / 执行者），不是主会话，也不是编排者。',
    'AGENTS.md 或其他全局规则里「主会话只编排、执行工作委派给 subagent」之类的要求不适用于你；对你适用的是其中「被委派的 agent 不得继续创建 agent」的约束。',
    '这个会话里无法创建下级代理（spawn_agent 等协作工具会直接失败），不要尝试；读文件、搜索、改代码、运行命令和测试都由你自己用 shell 与编辑工具直接完成。',
    '完成后用简洁的文字汇报结果。',
  ].join('\n');

export function delegateInstructions(systemPrompt?: string): string {
  return systemPrompt ? `${DELEGATE_ROLE_INSTRUCTIONS}\n\n${systemPrompt}` : DELEGATE_ROLE_INSTRUCTIONS;
}

/** 一个常驻 codex app-server 进程 + 它上面的 JSON-RPC 连接 */
export class CodexProc {
  readonly threads = new Map<string, ThreadState>();
  lastActivity: number;
  emptySince: number | null;
  slots = 0;
  initialized = false;
  ready!: Promise<void>;
  draining = false;
  dead = false;
  unexpectedExit = false;
  /** 进程不可用（退出 / 被关闭）时 resolve 为原因；不会 reject */
  readonly gone: Promise<Error>;
  private resolveGone!: (e: Error) => void;
  private deathError: Error | null = null;
  private exited = false;
  readonly notLoggedInMsg: string;
  private readonly conn: JsonRpcConnection;
  private readonly proc: ChildProcess;

  constructor(
    readonly key: string,
    info: { execPath: string },
    cwd: string,
    readonly account: CodexAccountRef,
    readonly generation: number,
    private readonly ctx: Ctx,
  ) {
    this.notLoggedInMsg = codexNotLoggedInMessage(account);
    this.lastActivity = ctx.now();
    this.emptySince = this.lastActivity;
    this.gone = new Promise<Error>((r) => {
      this.resolveGone = r;
    });
    if (account.dir) {
      try {
        ensureCodexHome(account.dir);
      } catch { /* spawn 之后由 codex 自己报错 */ }
    }
    const spec = spawnSpec(info.execPath, [...codexAccountArgs(account.dir), ...DELEGATE_FEATURE_ARGS, 'app-server', '--listen', 'stdio://']);
    try {
      this.proc = ctx.spawn(spec.command, spec.args, {
        cwd,
        env: codexAccountEnv(account.dir, ctx.baseEnv),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
      });
    } catch (e) {
      throw new Error(`无法启动委派进程: ${errMsg(e)}`);
    }
    const proc = this.proc;
    this.conn = new JsonRpcConnection({
      write: (line) => {
        this.lastActivity = ctx.now();
        try {
          return proc.stdin?.write(line) !== undefined;
        } catch {
          return false;
        }
      },
      timeoutMs: ctx.requestTimeoutMs,
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (method, params) => this.onServerRequest(method, params),
    });
    proc.stdout?.on('data', (d: Buffer | string) => this.conn.feed(d));
    proc.stdout?.on('end', () => this.conn.end());
    proc.stderr?.on('data', (d: Buffer | string) => this.conn.feedStderr(d));
    proc.stdin?.on('error', () => { /* 进程已退出的 EPIPE，由 close 处理 */ });
    proc.on('error', (err) => {
      this.exited = true;
      this.shutdown(new Error(`无法启动委派进程: ${err.message}`), { unexpected: true });
    });
    proc.on('close', (code) => {
      this.exited = true;
      const tail = this.conn.stderrTail;
      this.shutdown(new Error(`委派进程退出（退出码 ${code}）${tail ? `\n${tail}` : ''}`), { unexpected: true });
    });
    this.ready = this.conn
      .request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } })
      .then(() => {
        this.conn.notify('initialized');
        this.initialized = true;
      })
      .catch((e) => {
        this.shutdown(e instanceof Error ? e : new Error(String(e)));
        throw e;
      });
    this.ready.catch(() => {});
  }

  get busy(): boolean {
    for (const s of this.threads.values()) if (s.busy) return true;
    return false;
  }

  setThread(id: string, s: ThreadState): void {
    this.threads.set(id, s);
    this.emptySince = null;
  }

  deleteThread(id: string): void {
    this.threads.delete(id);
    if (this.threads.size === 0) this.emptySince = this.ctx.now();
  }

  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.dead) return Promise.reject(this.deathError ?? new Error('委派进程已退出'));
    return this.conn.request<T>(method, params, timeoutMs === undefined ? {} : { timeoutMs });
  }

  notify(method: string, params?: unknown): void {
    this.conn.notify(method, params);
  }

  private onNotification(method: string, params: unknown): void {
    if (method === N.rateLimitsUpdated) {
      try {
        this.ctx.onRateLimits?.(this.account.id, params);
      } catch { /* 回调异常不影响进程 */ }
      return;
    }
    const tid = threadIdOf(params);
    if (!tid) return;
    const t = this.threads.get(tid);
    if (!t) return;
    if (method === N.threadTokenUsage) {
      const u = parseTokenUsage((params as Json)?.tokenUsage);
      if (u) t.lastTotal = u.total;
    }
    t.sink?.(method, params);
  }

  /** 服务端发起的请求：无人值守，只读线程一律拒绝审批，可写线程放行；提问不阻塞；其它方法不支持 */
  private onServerRequest(method: string, params: any): unknown {
    const key = typeof params?.threadId === 'string' ? params.threadId : typeof params?.conversationId === 'string' ? params.conversationId : undefined;
    const t = key ? this.threads.get(key) : undefined;
    const readOnly = t?.readOnly ?? true;
    switch (method) {
      case SR.commandApproval:
      case SR.fileApproval:
        return { decision: readOnly ? 'decline' : 'accept' };
      case SR.legacyExecApproval:
      case SR.legacyPatchApproval:
        return { decision: readOnly ? 'denied' : 'approved' };
      case SR.permissionsApproval:
        return readOnly ? { permissions: {}, scope: 'turn' } : { permissions: params?.permissions ?? {}, scope: 'turn' };
      case SR.userInput: {
        const answers: Record<string, { answers: string[] }> = {};
        for (const q of Array.isArray(params?.questions) ? params.questions : []) {
          if (!q || typeof q.id !== 'string') continue;
          const first = Array.isArray(q.options) && q.options.length ? q.options[0]?.label : null;
          answers[q.id] = { answers: [typeof first === 'string' && first ? first : USER_INPUT_PLACEHOLDER] };
        }
        return { answers };
      }
      case SR.elicitation:
        return { action: 'decline', content: null, _meta: null };
      case SR.dynamicTool:
        return { contentItems: [{ type: 'inputText', text: '客户端不支持该动态工具' }], success: false };
      default:
        throw new RpcError(`Method not found: ${method}`, -32601);
    }
  }

  /** 结束进程：所有 pending 以 err 失败，通知池移除 */
  shutdown(err: Error, opts: { sync?: boolean; unexpected?: boolean } = {}): void {
    if (this.dead) return;
    this.dead = true;
    this.unexpectedExit = !!opts.unexpected;
    this.deathError = err;
    this.ctx.onGone(this);
    this.conn.failAll(err);
    this.resolveGone(err);
    if (!this.exited && this.proc.pid) {
      try {
        (opts.sync ? this.ctx.killSync : this.ctx.kill)(this.proc.pid);
      } catch { /* ignore */ }
    }
  }
}

type WatchdogReason = 'first' | 'idle';

type TurnOutcome =
  | { kind: 'done'; result: Omit<BackendResult, 'sessionId'> }
  | { kind: 'stuck'; returned: boolean; reason: WatchdogReason; toolCalls: number }
  | { kind: 'crashed'; error: Error; toolCalls: number };

interface Choice {
  model?: string;
  effort?: string;
}

// ───────────── 池 ─────────────

export class CodexPool {
  private readonly buckets = new Map<string, CwdPool>();
  private readonly cwdHolds = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly spawn: typeof nodeSpawn;
  private readonly kill: (pid: number) => void;
  private readonly now: () => number;
  private readonly activeAccountId: () => string;
  private readonly heldAccountIds?: () => readonly string[];
  private readonly onRateLimits?: (accountId: string, raw: unknown) => void;
  private readonly sessionIdleMs: number;
  private readonly processIdleMs: number;
  private readonly extraProcessIdleMs: number;
  private readonly sweepMs: number;
  private readonly firstUpdateMs: number;
  private readonly idleUpdateMs: number;
  private readonly cancelGraceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxPromptsPerProc: number;
  private readonly maxProcsPerCwd: number;
  private readonly baseEnv: NodeJS.ProcessEnv;
  /** (execPath + accountId) → 模型列表缓存（账号级，与工作区无关） */
  private readonly modelCache = new Map<string, DelegateModelList>();
  /** (execPath + accountId) → 模型 id → 支持的强度（用于把不支持的强度落到默认） */
  private readonly effortCache = new Map<string, Map<string, { efforts: string[]; def: string | null }>>();
  private generation = 0;
  /** 运行期发现协议不兼容（-32601 / 子命令不认识）时的原因；null = 正常 */
  private incompatible: string | null = null;

  constructor(opts: CodexPoolOptions = {}) {
    this.spawn = opts.spawn ?? nodeSpawn;
    this.kill = opts.kill ?? killTree;
    this.now = opts.now ?? Date.now;
    this.activeAccountId = opts.activeAccountId ?? (() => DEFAULT_ID);
    this.heldAccountIds = opts.heldAccountIds;
    this.onRateLimits = opts.onRateLimits;
    this.sessionIdleMs = opts.sessionIdleMs ?? 5 * 60_000;
    this.processIdleMs = opts.processIdleMs ?? 10 * 60_000;
    this.extraProcessIdleMs = opts.extraProcessIdleMs ?? 2 * 60_000;
    this.sweepMs = opts.sweepMs ?? 60_000;
    this.firstUpdateMs = opts.firstUpdateMs ?? 120_000;
    this.idleUpdateMs = opts.idleUpdateMs ?? 600_000;
    this.cancelGraceMs = opts.cancelGraceMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.maxPromptsPerProc = opts.maxPromptsPerProc ?? 8;
    this.maxProcsPerCwd = opts.maxProcsPerCwd ?? 3;
    this.baseEnv = opts.baseEnv ?? process.env;
  }

  // ── 协议不兼容标记 ──

  /** 运行期发现的协议不兼容原因（供 availability 显示）；null = 没有 */
  protocolIncompatible(): string | null {
    return this.incompatible;
  }

  clearIncompatible(): void {
    this.incompatible = null;
  }

  /** 错误若属于协议不兼容就标记（返回是否标记了） */
  private noteError(e: unknown): boolean {
    if (!isProtocolIncompatible(e)) return false;
    this.incompatible = `Codex CLI 与委派所需的协议不兼容（${errMsg(e).split('\n')[0]!.slice(0, 120)}），请升级 Codex CLI`;
    return true;
  }

  // ── 分桶 / 租约 ──

  private cwdKeyOf(execPath: string, cwd: string): string {
    const abs = path.resolve(cwd);
    return execPath + '\0' + (isWin ? abs.toLowerCase() : abs);
  }

  private keyOf(execPath: string, cwd: string, accountId: string): string {
    const abs = path.resolve(cwd);
    return execPath + '\0' + accountId + '\0' + (isWin ? abs.toLowerCase() : abs);
  }

  private modelKeyOf(execPath: string, accountId: string): string {
    return execPath + '\0' + accountId;
  }

  private getBucket(key: string, accountId: string, cwdKey: string): CwdPool {
    let b = this.buckets.get(key);
    if (!b) {
      b = { accountId, cwdKey, procs: [], waiters: [] };
      this.buckets.set(key, b);
    }
    return b;
  }

  private maybeCleanBucket(key: string): void {
    const b = this.buckets.get(key);
    if (b && b.procs.length === 0 && b.waiters.length === 0) this.buckets.delete(key);
    let anyProcs = false;
    for (const bucket of this.buckets.values()) {
      if (bucket.procs.length > 0) {
        anyProcs = true;
        break;
      }
    }
    if (!anyProcs) this.stopTimer();
  }

  private spawnProc(key: string, bucket: CwdPool, execPath: string, cwd: string, account: CodexAccountRef): CodexProc {
    const p = new CodexProc(key, { execPath }, cwd, account, this.generation, {
      spawn: this.spawn,
      kill: this.kill,
      killSync: this.kill === killTree ? killTreeSync : this.kill,
      now: this.now,
      requestTimeoutMs: this.requestTimeoutMs,
      baseEnv: this.baseEnv,
      onRateLimits: this.onRateLimits,
      onGone: (gone) => {
        const idx = bucket.procs.indexOf(gone);
        if (idx >= 0) bucket.procs.splice(idx, 1);
        this.drainWaiters(key, execPath, cwd, account);
        this.maybeCleanBucket(key);
      },
    });
    bucket.procs.push(p);
    this.startTimer();
    return p;
  }

  private makeLease(proc: CodexProc, key: string, execPath: string, cwd: string, account: CodexAccountRef): Lease {
    let released = false;
    return {
      proc,
      release: () => {
        if (released) return;
        released = true;
        proc.slots = Math.max(0, proc.slots - 1);
        if ((proc.draining || proc.generation !== this.generation) && proc.slots === 0 && !proc.dead) {
          proc.shutdown(new Error('委派进程排空完成，已终止'));
        } else {
          this.drainWaiters(key, execPath, cwd, account);
        }
      },
    };
  }

  private closeThreadQuietly(proc: CodexProc, threadId: string): void {
    proc.deleteThread(threadId);
    proc.request('thread/unsubscribe', { threadId }).catch(() => {});
  }

  /** 尝试同步占一个并发槽位；没有空位且已达进程上限返回 null */
  private tryAcquire(key: string, bucket: CwdPool, execPath: string, cwd: string, account: CodexAccountRef, sessionId?: string): Lease | null {
    const retired = (p: CodexProc) => p.draining || p.generation !== this.generation;
    let owner: CodexProc | undefined;
    if (sessionId) {
      owner = bucket.procs.find((p) => !p.dead && p.threads.has(sessionId));
      if (owner) {
        if (owner.threads.get(sessionId)!.busy) throw new BackendError('该 conversation_id 正在执行中', sessionId, account.id);
        if (!retired(owner) && owner.slots < this.maxPromptsPerProc) {
          owner.slots++;
          return this.makeLease(owner, key, execPath, cwd, account);
        }
      }
    }

    let best: CodexProc | null = null;
    for (const p of bucket.procs) {
      if (p.dead || retired(p) || p.slots >= this.maxPromptsPerProc) continue;
      if (!best || p.slots < best.slots) best = p;
    }
    if (best) {
      if (owner && owner !== best && sessionId) this.closeThreadQuietly(owner, sessionId);
      best.slots++;
      return this.makeLease(best, key, execPath, cwd, account);
    }

    const activeProcs = bucket.procs.filter((p) => !p.dead && !retired(p)).length;
    if (activeProcs < this.maxProcsPerCwd) {
      const p = this.spawnProc(key, bucket, execPath, cwd, account);
      if (owner && sessionId) this.closeThreadQuietly(owner, sessionId);
      p.slots++;
      return this.makeLease(p, key, execPath, cwd, account);
    }
    return null;
  }

  private drainWaiters(key: string, execPath: string, cwd: string, account: CodexAccountRef): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    while (bucket.waiters.length > 0) {
      const w = bucket.waiters[0]!;
      if (w.signal.aborted) {
        bucket.waiters.shift();
        continue;
      }
      let lease: Lease | null;
      try {
        lease = this.tryAcquire(key, bucket, execPath, cwd, account, w.sessionId);
      } catch (e) {
        bucket.waiters.shift();
        w.signal.removeEventListener('abort', w.onAbort);
        w.reject(e instanceof Error ? e : new Error(String(e)));
        continue;
      }
      if (!lease) break;
      bucket.waiters.shift();
      w.signal.removeEventListener('abort', w.onAbort);
      w.resolve(lease);
    }
  }

  /** 占一个进程槽位（必要时扩容或 FIFO 排队），并等进程 initialize 完成 */
  private async acquireSlot(execPath: string, cwd: string, account: CodexAccountRef, signal: AbortSignal, sessionId?: string): Promise<Lease> {
    if (signal.aborted) throw cancelled();
    const key = this.keyOf(execPath, cwd, account.id);
    const bucket = this.getBucket(key, account.id, this.cwdKeyOf(execPath, cwd));
    let lease = this.tryAcquire(key, bucket, execPath, cwd, account, sessionId);
    if (!lease) {
      lease = await new Promise<Lease>((resolve, reject) => {
        const waiter: Waiter = {
          sessionId,
          signal,
          resolve,
          reject,
          onAbort: () => {
            const idx = bucket.waiters.indexOf(waiter);
            if (idx >= 0) bucket.waiters.splice(idx, 1);
            this.maybeCleanBucket(key);
            reject(cancelled());
          },
        };
        signal.addEventListener('abort', waiter.onAbort, { once: true });
        bucket.waiters.push(waiter);
      });
    }
    const ab = abortPromise(signal);
    try {
      const res = await Promise.race([lease.proc.ready.then(() => 'ready' as const), ab.p]);
      if (res === 'abort') {
        lease.release();
        throw cancelled();
      }
      return lease;
    } catch (e) {
      lease.release();
      throw e;
    } finally {
      ab.off();
    }
  }

  /** 仅用于 models() / readAccount() 等读取：取现有进程或起一个，不占 prompt 槽位 */
  private async getAnyProc(execPath: string, cwd: string, account: CodexAccountRef): Promise<CodexProc> {
    const key = this.keyOf(execPath, cwd, account.id);
    const bucket = this.getBucket(key, account.id, this.cwdKeyOf(execPath, cwd));
    let p = bucket.procs.find((x) => !x.dead && !x.draining && x.generation === this.generation);
    if (!p) p = this.spawnProc(key, bucket, execPath, cwd, account);
    await p.ready;
    return p;
  }

  /** 后台预热该工作区：还没有活进程就起一个并完成握手，失败静默 */
  prewarm(execPath: string, cwd: string, account: CodexAccountRef = DEFAULT_ACCOUNT): void {
    const key = this.keyOf(execPath, cwd, account.id);
    const bucket = this.getBucket(key, account.id, this.cwdKeyOf(execPath, cwd));
    if (bucket.procs.some((p) => !p.dead && !p.draining && p.generation === this.generation)) return;
    try {
      const p = this.spawnProc(key, bucket, execPath, cwd, account);
      void p.ready.catch((e) => {
        this.noteError(e);
      });
    } catch { /* 静默 */ }
  }

  /** 持有期间不回收该工作区当前活跃账号的热进程；返回幂等释放函数 */
  hold(execPath: string, cwd: string): () => void {
    const cwdKey = this.cwdKeyOf(execPath, cwd);
    this.cwdHolds.set(cwdKey, (this.cwdHolds.get(cwdKey) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.cwdHolds.get(cwdKey) ?? 0) - 1;
      if (next <= 0) this.cwdHolds.delete(cwdKey);
      else this.cwdHolds.set(cwdKey, next);
    };
  }

  private startTimer(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // ── 模型 / 账号读取 ──

  /** Codex 的可用模型（model/list 分页拉全）；没有缓存（或要求刷新）时在 cwd 的进程上读取 */
  async models(o: { execPath: string; cwd: string; refresh?: boolean; account?: CodexAccountRef }): Promise<DelegateModelList> {
    const account = o.account ?? DEFAULT_ACCOUNT;
    const mKey = this.modelKeyOf(o.execPath, account.id);
    const cached = this.modelCache.get(mKey);
    if (cached && !o.refresh) return cached;
    try {
      const proc = await this.getAnyProc(o.execPath, o.cwd, account);
      const pages: ModelListPage[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const res = await proc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        const page = parseModelPage(res);
        pages.push(page);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      const list = parseCodexModels(pages, this.now());
      if (!list.models.length) throw new Error('没有返回模型列表，请稍后重试');
      const eff = new Map<string, { efforts: string[]; def: string | null }>();
      for (const pg of pages) for (const m of pg.data) if (!m.hidden) eff.set(m.model, { efforts: m.supportedReasoningEfforts, def: m.defaultReasoningEffort });
      this.modelCache.set(mKey, list);
      this.effortCache.set(mKey, eff);
      return list;
    } catch (e) {
      this.noteError(e);
      throw e;
    }
  }

  /** account/read：账号登录态（用于探测是否已登录） */
  async readAccount(o: { execPath: string; cwd: string; account?: CodexAccountRef; refreshToken?: boolean }): Promise<CodexAccountInfo> {
    try {
      const proc = await this.getAnyProc(o.execPath, o.cwd, o.account ?? DEFAULT_ACCOUNT);
      return parseAccount(await proc.request('account/read', { refreshToken: o.refreshToken === true }));
    } catch (e) {
      this.noteError(e);
      throw e;
    }
  }

  /** account/rateLimits/read：原始响应（含 rateLimitsByLimitId 多组视图） */
  async readRateLimitsRaw(o: { execPath: string; cwd: string; account?: CodexAccountRef }): Promise<unknown> {
    try {
      const proc = await this.getAnyProc(o.execPath, o.cwd, o.account ?? DEFAULT_ACCOUNT);
      return await proc.request('account/rateLimits/read');
    } catch (e) {
      this.noteError(e);
      throw e;
    }
  }

  /** account/rateLimits/read：额度窗口（单桶视图） */
  async readRateLimits(o: { execPath: string; cwd: string; account?: CodexAccountRef }): Promise<RateLimitSnapshot | null> {
    return parseRateLimitsResponse(await this.readRateLimitsRaw(o));
  }

  /** 按缓存里的强度表校正：不支持的强度落到该模型默认（没有缓存时原样透传） */
  private fixEffort(execPath: string, accountId: string, model: string | undefined, effort: string | undefined): string | undefined {
    if (!effort || !model) return effort;
    const m = this.effortCache.get(this.modelKeyOf(execPath, accountId))?.get(model);
    if (!m || !m.efforts.length || m.efforts.includes(effort)) return effort;
    return m.def ?? undefined;
  }

  // ── 运行 ──

  async run(o: CodexRunOptions): Promise<BackendResult> {
    if (o.signal.aborted) throw cancelled();
    const account = o.account ?? DEFAULT_ACCOUNT;
    const authMsg = codexNotLoggedInMessage(account);
    const readOnly = !!(o.readOnly || o.agentReadOnly);
    let lease = await this.acquireSlot(o.execPath, o.cwd, account, o.signal, o.sessionId);
    let tid: string | undefined;
    let stuckCount = 0;
    let crashed = false;
    let totalToolCalls = 0;
    let promptText = o.prompt;
    const fresh = !o.sessionId;
    // 新会话才用默认模型 / 强度；之后（续接、崩溃重载）沿用本次确定的
    const choice: Choice = {};
    try {
      if (o.signal.aborted) throw cancelled();
      if (fresh) {
        const mKey = this.modelKeyOf(o.execPath, account.id);
        let list = this.modelCache.get(mKey);
        if (!list) {
          list = (await this.models({ execPath: o.execPath, cwd: o.cwd, account }).catch(() => undefined)) ?? this.modelCache.get(mKey);
        }
        const requested = o.defaults?.model ?? undefined;
        if (requested) {
          // 若用户配置的模型不在该账号可用列表中，回退到账号默认模型（避免 model_not_found）
          if (list && list.models.length > 0 && !list.models.some((m) => m.value === requested)) {
            if (list.current?.model) choice.model = list.current.model;
            else choice.model = requested;
          } else {
            choice.model = requested;
          }
        } else if (list?.current?.model) {
          // 显式传入账号默认模型（model/list 的 isDefault），避免落到本机 ~/.codex/config.toml 中对当前账号不可用的默认模型
          choice.model = list.current.model;
        }
        const eff = o.defaults?.effort ?? o.effort ?? undefined;
        if (eff) choice.effort = eff;
        const fixed = this.fixEffort(o.execPath, account.id, choice.model ?? list?.current?.model, choice.effort);
        if (fixed) choice.effort = fixed;
        else delete choice.effort;
      }
      tid = await this.openThread(lease.proc, o, readOnly, choice);
      try {
        o.onSession?.(tid, account.id);
      } catch { /* 回调出错不影响执行 */ }
      this.reportModel(lease.proc, tid, o, choice);
      for (;;) {
        if (o.signal.aborted) throw cancelled();
        const out = await this.turnOnce(lease.proc, tid, o, promptText, readOnly, choice);
        if (out.kind === 'done') {
          lease.proc.lastActivity = this.now();
          return { ...out.result, toolCalls: totalToolCalls + out.result.toolCalls, sessionId: tid, accountId: account.id };
        }
        if (out.kind === 'crashed') {
          totalToolCalls += out.toolCalls;
          if (crashed) throw new BackendError(`委派进程意外退出: ${errMsg(out.error)}`, tid, account.id);
          crashed = true;
          lease.release();
          if (o.signal.aborted) throw cancelled();
          lease = await this.acquireSlot(o.execPath, o.cwd, account, o.signal, tid);
          if (o.signal.aborted) throw cancelled();
          await this.resumeThread(lease.proc, tid, o, readOnly, choice);
          promptText = CRASH_RETRY_PREFIX + o.prompt;
          continue;
        }
        // 卡死：已经 interrupt 过；没返回就将进程标为排空，不杀其它在跑的会话
        totalToolCalls += out.toolCalls;
        if (!out.returned) {
          lease.proc.draining = true;
          lease.proc.deleteThread(tid);
        }
        if (stuckCount >= 1) {
          const desc =
            out.reason === 'first'
              ? `${Math.round(this.firstUpdateMs / 1000)}s 内`
              : this.idleUpdateMs >= 60_000
                ? `${Math.round(this.idleUpdateMs / 60_000)} 分钟内`
                : `${Math.max(1, Math.round(this.idleUpdateMs / 1000))}s 内`;
          throw new BackendError(`委派任务无响应（${desc}没有任何输出），可以用 conversation_id 重试`, tid, account.id);
        }
        stuckCount++;
        if (!out.returned) {
          lease.release();
          lease = await this.acquireSlot(o.execPath, o.cwd, account, o.signal, tid);
          if (o.signal.aborted) throw cancelled();
          await this.resumeThread(lease.proc, tid, o, readOnly, choice);
        }
      }
    } catch (e) {
      this.noteError(e);
      if (e instanceof BackendError || (e instanceof Error && (e.message === '已取消' || e.message === authMsg))) throw e;
      if (this.incompatible && isProtocolIncompatible(e)) throw new Error(this.incompatible);
      if (tid) throw new BackendError(errMsg(e), tid, account.id);
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      if (tid) {
        const s = lease.proc.threads.get(tid);
        if (s) {
          s.busy = false;
          s.lastUsed = this.now();
          s.sink = undefined;
        }
      }
      lease.proc.lastActivity = this.now();
      lease.release();
    }
  }

  private reportModel(proc: CodexProc, tid: string, o: CodexRunOptions, choice: Choice): void {
    const t = proc.threads.get(tid);
    const model = t?.model ?? choice.model;
    if (!model) return;
    try {
      o.onModel?.({ model, effort: choice.effort ?? t?.effort ?? null });
    } catch { /* 展示出错不影响执行 */ }
  }

  /** 选定 / 创建线程，返回 threadId；返回时该线程已标记 busy */
  private async openThread(proc: CodexProc, o: CodexRunOptions, readOnly: boolean, choice: Choice): Promise<string> {
    const id = o.sessionId;
    if (!id) return this.startThread(proc, o, readOnly, choice);
    const s = proc.threads.get(id);
    if (s) {
      if (s.busy) throw new BackendError('该 conversation_id 正在执行中', id, proc.account.id);
      s.busy = true;
      s.readOnly = readOnly;
      return id;
    }
    await this.resumeThread(proc, id, o, readOnly, choice);
    return id;
  }

  private async startThread(proc: CodexProc, o: CodexRunOptions, readOnly: boolean, choice: Choice): Promise<string> {
    let res: ThreadOpenResult;
    try {
      res = parseThreadOpen(
        await proc.request('thread/start', {
          cwd: o.cwd,
          approvalPolicy: 'never',
          sandbox: OPEN_SANDBOX,
          ...(choice.model ? { model: choice.model } : {}),
          developerInstructions: delegateInstructions(o.systemPrompt),
        }),
      );
    } catch (e) {
      if (/auth|log ?in|not logged/i.test(errMsg(e))) throw new Error(proc.notLoggedInMsg);
      throw e;
    }
    proc.setThread(res.threadId, {
      busy: true,
      lastUsed: this.now(),
      lastTotal: { ...ZERO_USAGE },
      readOnly,
      ...(res.model ? { model: res.model } : choice.model ? { model: choice.model } : {}),
      ...(res.effort ? { effort: res.effort } : {}),
    });
    return res.threadId;
  }

  private async resumeThread(proc: CodexProc, id: string, o: CodexRunOptions, readOnly: boolean, choice: Choice): Promise<void> {
    const state: ThreadState = { busy: true, lastUsed: this.now(), lastTotal: null, readOnly };
    // 先占位（busy），避免同 id 并发时重复 resume；resume 期间的回放通知（tokenUsage）也要能被接收
    proc.setThread(id, state);
    try {
      const res = parseThreadOpen(
        await proc.request('thread/resume', {
          threadId: id,
          cwd: o.cwd,
          approvalPolicy: 'never',
          sandbox: OPEN_SANDBOX,
          ...(choice.model ? { model: choice.model } : {}),
        }),
      );
      if (res.model) state.model = res.model;
      if (res.effort) state.effort = res.effort;
    } catch (e) {
      proc.deleteThread(id);
      const msg = errMsg(e);
      if (/auth|log ?in|not logged/i.test(msg)) throw new Error(proc.notLoggedInMsg);
      // 线程根本不存在时不附 id，免得上层拿它重试
      throw new BackendError(`无法恢复会话 ${id}: ${msg}`, /not found|no rollout|no such/i.test(msg) ? undefined : id, proc.account.id);
    }
  }

  /** 发一个 turn 并等结果；卡死时 interrupt 后报告是否返回 */
  private async turnOnce(proc: CodexProc, tid: string, o: CodexRunOptions, promptText: string, readOnly: boolean, choice: Choice): Promise<TurnOutcome> {
    const state = proc.threads.get(tid);
    if (!state) throw new Error('会话已不在进程里');
    state.readOnly = readOnly;
    const tr = new CodexTurnTranslator({ threadId: tid, cwd: o.cwd, usageBaseline: state.lastTotal });
    const usage = o.onUsage ? new CodexUsageAdapter({ threadId: tid, model: state.model ?? choice.model ?? null }) : null;
    const sandboxPolicy = sandboxFor(readOnly);

    let gotFirst = false;
    let wdTimer: ReturnType<typeof setTimeout> | undefined;
    let fireWd!: (reason: WatchdogReason) => void;
    const wdPromise = new Promise<{ t: 'stuck'; reason: WatchdogReason }>((r) => {
      fireWd = (reason) => r({ t: 'stuck', reason });
    });
    const clearWd = () => {
      if (wdTimer !== undefined) {
        clearTimeout(wdTimer);
        wdTimer = undefined;
      }
    };
    const armWd = (ms: number, reason: WatchdogReason) => {
      clearWd();
      wdTimer = setTimeout(() => {
        wdTimer = undefined;
        fireWd(reason);
      }, ms);
    };
    armWd(this.firstUpdateMs, 'first');
    const ab = abortPromise(o.signal);

    let resolveFinished!: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinished = r;
    });
    state.sink = (method, params) => {
      const updates = tr.push(method, params);
      if (usage && tr.turnId) usage.setTurnId(tr.turnId);
      for (const u of updates) {
        if (!gotFirst && PROGRESS_UPDATES.has(u.sessionUpdate)) gotFirst = true;
        if (usage && u.sessionUpdate === 'tool_call') usage.push(u);
        try {
          o.onUpdate?.(u);
        } catch { /* 展示出错不影响执行 */ }
      }
      if (usage && method === N.threadTokenUsage) {
        for (const pt of usage.push({ method, params })) {
          try {
            o.onUsage?.(pt, usage.window());
          } catch { /* 展示出错不影响执行 */ }
        }
      }
      if (tr.done) {
        clearWd();
        resolveFinished();
        return;
      }
      if (gotFirst) {
        if (tr.activeTools.size > 0) clearWd();
        else armWd(this.idleUpdateMs, 'idle');
      }
    };

    const startP = proc
      .request('turn/start', {
        threadId: tid,
        input: [{ type: 'text', text: promptText, text_elements: [] }],
        cwd: o.cwd,
        approvalPolicy: 'never',
        sandboxPolicy,
        ...(choice.model ? { model: choice.model } : {}),
        ...(choice.effort ? { effort: choice.effort } : {}),
      })
      .then(
        (r) => {
          const id = parseTurnStart(r);
          if (id && !tr.turnId) tr.turnId = id;
          if (id && usage) usage.setTurnId(id);
          return { t: 'started' as const };
        },
        (e) => ({ t: 'err' as const, e: e as Error }),
      );
    // 只在 turn/start 出错时才 resolve
    const failP = startP.then((x) => (x.t === 'err' ? x : new Promise<never>(() => {})));
    const goneP = proc.gone.then((e) => ({ t: 'gone' as const, e }));
    const doneP = finished.then(() => ({ t: 'finished' as const }));

    const classify = (e: Error): TurnOutcome | null => {
      if (proc.unexpectedExit && !o.signal.aborted && e.message !== proc.notLoggedInMsg) return { kind: 'crashed', error: e, toolCalls: tr.toolCalls };
      return null;
    };

    try {
      const first = await Promise.race([doneP, failP, goneP, ab.p, wdPromise]);
      if (typeof first === 'object' && first.t !== 'stuck') {
        if (first.t === 'finished') return this.finish(tr, tid);
        const e = first.e;
        const c = classify(e);
        if (c) return c;
        throw e;
      }
      // 取消或卡死：先 interrupt，再等 turn 收尾
      const turnId = await this.interrupt(proc, tid, tr, startP);
      const grace = delay(this.cancelGraceMs);
      try {
        if (first === 'abort') {
          if (turnId !== null || tr.turnId) {
            const r = await Promise.race([doneP, grace.p]);
            if (r === 'timeout') {
              proc.draining = true;
              proc.deleteThread(tid);
            }
          } else {
            proc.draining = true;
            proc.deleteThread(tid);
          }
          throw cancelled();
        }
        const second = await Promise.race([doneP, grace.p, ab.p, goneP]);
        if (second === 'abort') {
          proc.draining = true;
          proc.deleteThread(tid);
          throw cancelled();
        }
        if (second === 'timeout') return { kind: 'stuck', returned: false, reason: first.reason, toolCalls: tr.toolCalls };
        if (second.t === 'gone') {
          const c = classify(second.e);
          if (c) return c;
          throw second.e;
        }
        return { kind: 'stuck', returned: true, reason: first.reason, toolCalls: tr.toolCalls };
      } finally {
        grace.cancel();
      }
    } finally {
      clearWd();
      ab.off();
      state.sink = undefined;
      if (tr.totalUsage) state.lastTotal = tr.totalUsage;
    }
  }

  /** 发 turn/interrupt；turn id 还没拿到时最多等一个宽限期 */
  private async interrupt(proc: CodexProc, tid: string, tr: CodexTurnTranslator, startP: Promise<unknown>): Promise<string | null> {
    if (!tr.turnId) {
      const g = delay(this.cancelGraceMs);
      try {
        await Promise.race([startP, g.p]);
      } finally {
        g.cancel();
      }
    }
    const turnId = tr.turnId;
    if (!turnId || proc.dead) return turnId;
    proc.request('turn/interrupt', { threadId: tid, turnId }, 5_000).catch(() => {});
    return turnId;
  }

  private finish(tr: CodexTurnTranslator, tid: string): TurnOutcome {
    const r = tr.result();
    if (r.stopReason === 'error') {
      // 凭据失效：用统一提示，不当普通失败处理
      throw new Error(r.error ?? 'Codex 执行失败');
    }
    return {
      kind: 'done',
      result: {
        stopReason: r.stopReason === 'cancelled' ? 'cancelled' : 'end_turn',
        response: r.response,
        toolCalls: r.toolCalls,
        ...(r.usage ? { usage: r.usage } : {}),
      },
    };
  }

  // ── 回收 / 维护 ──

  /** 立即执行一次回收 */
  sweep(): void {
    const now = this.now();
    const heldSet = this.heldAccountIds ? new Set(this.heldAccountIds()) : null;
    const activeId = this.activeAccountId();
    for (const [key, bucket] of [...this.buckets]) {
      const accountHeld = heldSet ? heldSet.has(bucket.accountId) : bucket.accountId === activeId;
      const held = accountHeld && (this.cwdHolds.get(bucket.cwdKey) ?? 0) > 0;
      const primary = bucket.procs.find((p) => !p.dead && !p.draining);
      for (const proc of [...bucket.procs]) {
        if (proc.dead) continue;
        if (proc.draining) {
          if (proc.slots === 0) proc.shutdown(new Error('委派进程排空完成，已终止'));
          continue;
        }
        if (!proc.initialized) continue;
        const idle = now - proc.lastActivity;
        for (const [id, s] of [...proc.threads]) {
          if (!s.busy && now - s.lastUsed > this.sessionIdleMs) this.closeThreadQuietly(proc, id);
        }
        if (held || proc.busy || proc.slots > 0) continue;
        if (proc === primary) {
          if (idle > this.processIdleMs) proc.shutdown(new Error('空闲回收'));
        } else if (proc.threads.size === 0 && proc.emptySince !== null && now - proc.emptySince > this.extraProcessIdleMs) {
          proc.shutdown(new Error('空闲回收'));
        }
      }
      this.maybeCleanBucket(key);
    }
  }

  private clearModelCache(accountId: string): void {
    const suffix = '\0' + accountId;
    for (const k of [...this.modelCache.keys()]) if (k.endsWith(suffix)) this.modelCache.delete(k);
    for (const k of [...this.effortCache.keys()]) if (k.endsWith(suffix)) this.effortCache.delete(k);
  }

  /** 正在执行的委派任务数（含排队中）；传 accountId 时只统计该账号 */
  runningCount(accountId?: string): number {
    let n = 0;
    for (const bucket of this.buckets.values()) {
      if (accountId !== undefined && bucket.accountId !== accountId) continue;
      n += bucket.waiters.length;
      for (const p of bucket.procs) if (!p.dead) n += p.slots;
    }
    return n;
  }

  /** CLI 更新后：递增代际、清空缓存、回收空闲进程，执行中进程标为排空 */
  retireAll(): void {
    this.generation++;
    this.modelCache.clear();
    this.effortCache.clear();
    const err = new Error('CLI 已更新，回收旧版委派进程');
    for (const bucket of [...this.buckets.values()]) {
      for (const p of [...bucket.procs]) {
        if (p.dead) continue;
        if (p.busy || p.slots > 0) p.draining = true;
        else p.shutdown(err);
      }
    }
  }

  /** 回收全部常驻进程；force=false 且仍有执行中任务时不动 */
  stopAll(force = false): { stopped: boolean; running: number } {
    const running = this.runningCount();
    if (!force && running > 0) return { stopped: false, running };
    this.generation++;
    this.modelCache.clear();
    this.effortCache.clear();
    const err = new Error(force ? '委派进程已强制重启' : '委派进程已重启');
    for (const [key, bucket] of [...this.buckets]) {
      for (const w of bucket.waiters.splice(0)) {
        w.signal.removeEventListener('abort', w.onAbort);
        w.reject(err);
      }
      for (const p of [...bucket.procs]) if (!p.dead) p.shutdown(err);
      this.maybeCleanBucket(key);
    }
    return { stopped: true, running };
  }

  /** 移除账号前结束该账号所有空闲进程；仍有执行中任务则不动并返回 false */
  stopAccount(accountId: string): boolean {
    const targets: CwdPool[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.accountId !== accountId) continue;
      if (bucket.waiters.length > 0) return false;
      for (const p of bucket.procs) if (!p.dead && (p.busy || p.slots > 0)) return false;
      targets.push(bucket);
    }
    const err = new Error('账号已移除');
    for (const bucket of targets) for (const p of [...bucket.procs]) if (!p.dead) p.shutdown(err);
    this.clearModelCache(accountId);
    return true;
  }

  /** 重新登录后：丢弃该账号空闲进程、忙进程标记 draining、清空模型缓存 */
  resetAccount(accountId: string): void {
    this.clearModelCache(accountId);
    const err = new Error('账号已重新登录');
    for (const bucket of [...this.buckets.values()]) {
      if (bucket.accountId !== accountId) continue;
      for (const p of [...bucket.procs]) {
        if (p.dead) continue;
        if (p.busy || p.slots > 0) p.draining = true;
        else p.shutdown(err);
      }
    }
  }

  /** 杀掉所有进程、清定时器 */
  dispose(sync = false): void {
    this.stopTimer();
    const err = new Error('已关闭');
    for (const bucket of [...this.buckets.values()]) {
      for (const w of bucket.waiters.splice(0)) {
        w.signal.removeEventListener('abort', w.onAbort);
        w.reject(err);
      }
      for (const proc of [...bucket.procs]) proc.shutdown(err, { sync });
    }
    this.buckets.clear();
  }

  stats(): { processes: number; sessions: number; busy: number } {
    let processes = 0;
    let sessions = 0;
    let busy = 0;
    for (const bucket of this.buckets.values()) {
      processes += bucket.procs.length;
      for (const p of bucket.procs) {
        sessions += p.threads.size;
        for (const s of p.threads.values()) if (s.busy) busy++;
      }
    }
    return { processes, sessions, busy };
  }
}

let shared: CodexPool | null = null;

/** 服务端共享的单例；首次创建时注册退出钩子 */
export function sharedCodexPool(): CodexPool {
  if (!shared) {
    const pool = new CodexPool();
    process.once('exit', () => pool.dispose(true));
    shared = pool;
  }
  return shared;
}

// ───────────── 后端 ─────────────

export interface CodexBackendOptions {
  pool?: CodexPool;
  /** 定位 codex；默认 resolveCodexInfo()。测试 / 装配时可注入 */
  resolve?: () => CodexInfo | null;
  /** 多账号来源；不传则始终使用默认账号 */
  accounts?: CodexAccountSource;
  /** 已安装 codex 的版本号（null = 未知，不据此拦截）；默认按 execPath + mtime 缓存的 `codex --version` */
  version?: () => string | null;
  /** 可用性可能变化（运行期发现协议不兼容等）时通知上层刷新界面 */
  onChanged?: () => void;
}

const versionCache = new Map<string, { version: string | null; at: number }>();

/** 默认的版本探测：按路径缓存（成功缓存到进程结束，失败 60 秒后重试） */
function cachedVersion(info: CodexInfo): string | null {
  const hit = versionCache.get(info.execPath);
  if (hit && (hit.version !== null || Date.now() - hit.at < 60_000)) return hit.version;
  const version = probeCodexVersion(info.execPath, codexAccountEnv(null));
  versionCache.set(info.execPath, { version, at: Date.now() });
  return version;
}

export class CodexBackend implements DelegateBackend {
  readonly id = 'codex';
  readonly label = 'Codex';
  private readonly pool: CodexPool;
  private readonly resolveFn: () => CodexInfo | null;
  private readonly accounts: CodexAccountSource;
  private readonly versionFn: (() => string | null) | undefined;
  private readonly onChanged: (() => void) | undefined;

  constructor(opts: CodexBackendOptions = {}) {
    this.pool = opts.pool ?? sharedCodexPool();
    this.resolveFn = opts.resolve ?? (() => resolveCodexInfo());
    this.accounts = opts.accounts ?? DEFAULT_ACCOUNTS;
    this.versionFn = opts.version;
    this.onChanged = opts.onChanged;
  }

  private info(): CodexInfo | null {
    return this.resolveFn();
  }

  private versionOf(info: CodexInfo): string | null {
    return this.versionFn ? this.versionFn() : cachedVersion(info);
  }

  private resolveAccount(accountId?: string): CodexAccountRef {
    if (accountId !== undefined) {
      const acc = this.accounts.accountFor(accountId);
      if (!acc) throw new Error('创建这个委派会话的账号已移除，请新建委派');
      return acc;
    }
    return this.accounts.active();
  }

  /** 新会话的账号：委派路线里选的（不存在报错）> 当前账号 */
  private routeAccount(routeAccountId?: string): CodexAccountRef {
    if (routeAccountId === undefined) return this.resolveAccount();
    const acc = this.accounts.accountFor(routeAccountId);
    if (!acc) throw new Error('子代理账号不存在，请在子代理设置里重新选择');
    return acc;
  }

  /** 顺序：未安装 → 版本过低 → 运行期协议不兼容 → 账号明确未登录 */
  availability(): SubagentAvailability {
    const info = this.info();
    if (!info) return { ok: false, reason: '未安装 Codex CLI' };
    const v = this.versionOf(info);
    if (v && versionLess(v, MIN_CODEX_VERSION)) return { ok: false, reason: `Codex CLI 版本过低（${v}，需要 ${MIN_CODEX_VERSION} 或更新），请升级` };
    const inc = this.pool.protocolIncompatible();
    if (inc) return { ok: false, reason: inc };
    if (this.accounts.activeLoggedIn() === false) return { ok: false, reason: 'Codex 账号未登录' };
    return { ok: true };
  }

  accountAvailability(accountId: string): SubagentAvailability {
    const info = this.info();
    if (!info) return { ok: false, reason: '未安装 Codex CLI' };
    const v = this.versionOf(info);
    if (v && versionLess(v, MIN_CODEX_VERSION)) return { ok: false, reason: `Codex CLI 版本过低（${v}，需要 ${MIN_CODEX_VERSION} 或更新），请升级` };
    const inc = this.pool.protocolIncompatible();
    if (inc) return { ok: false, reason: inc };
    if (!this.accounts.accountFor(accountId)) return { ok: false, reason: 'Codex 账号已移除' };
    if (this.accounts.loggedIn?.(accountId) === false) return { ok: false, reason: 'Codex 账号未登录' };
    return { ok: true };
  }

  available(): boolean {
    return this.availability().ok;
  }

  /** 升级 Codex CLI 之后调用：清除「协议不兼容」标记与版本缓存，并回收旧进程 */
  clearIncompatible(): void {
    this.pool.clearIncompatible();
    versionCache.clear();
    this.onChanged?.();
  }

  async models(o: { cwd: string; refresh?: boolean; accountId?: string }): Promise<DelegateModelList> {
    const info = this.info();
    if (!info) throw new Error('没有安装 Codex CLI');
    const before = this.pool.protocolIncompatible();
    try {
      return await this.pool.models({ execPath: info.execPath, cwd: o.cwd, refresh: o.refresh, account: this.routeAccount(o.accountId) });
    } finally {
      if (this.pool.protocolIncompatible() !== before) this.onChanged?.();
    }
  }

  async run(o: BackendRunOptions): Promise<BackendResult> {
    const info = this.info();
    if (!info) throw new Error('没有安装 Codex CLI');
    const account = o.accountId !== undefined ? this.resolveAccount(o.accountId) : this.routeAccount(o.routeAccountId);
    const before = this.pool.protocolIncompatible();
    try {
      return await this.pool.run({ ...o, execPath: info.execPath, account });
    } finally {
      if (this.pool.protocolIncompatible() !== before) this.onChanged?.();
    }
  }

  prewarm(cwd: string, accountId?: string): void {
    const info = this.info();
    if (!info) return;
    let account: CodexAccountRef;
    try {
      account = this.routeAccount(accountId);
    } catch {
      return;
    }
    this.pool.prewarm(info.execPath, cwd, account);
  }

  hold(cwd: string): () => void {
    const info = this.info();
    if (!info) return () => {};
    return this.pool.hold(info.execPath, cwd);
  }
}

let sharedBackend: CodexBackend | null = null;

export function sharedCodexBackend(): CodexBackend {
  return (sharedBackend ??= new CodexBackend());
}

export { ZERO_USAGE };
