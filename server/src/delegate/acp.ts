// Antigravity CLI 的 ACP 模式（agy acp）常驻进程池：按账号与工作区分桶，每进程多并发 + 弹性扩容，绝不跨账号或跨 cwd 复用。
// 比起一次调用起一个进程，省掉冷启动，也能用「首次输出看门狗 + 重试一次」绕开冷启动偶发的卡死。
import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import path from 'node:path';
import type { DelegateModelList, SubagentAvailability } from '@cosyee/shared';
import type { AgyAccountRef } from '../accounts/agy.js';
import { agyAccountArgs, agyAccountEnv } from '../accounts/agy-env.js';
import { DEFAULT_ID } from '../accounts/index.js';
import { killTree, killTreeSync, spawnSpec } from '../claude/bin.js';
import { type Json, LineSplitter } from '../transcript.js';
import { AGY_NOT_LOGGED_IN, resolveAgy } from './agy.js';
import { BackendError, type BackendResult, type BackendRunOptions, type DelegateBackend } from './backend.js';
import { type AvailableModel, parseAvailable, resolveModelId, splitModelId, toModelList } from './models.js';
import { AgyUsageAdapter } from './usage/agyUsage.js';

const DEFAULT_ACCOUNT: AgyAccountRef = { id: DEFAULT_ID, dir: null };
/** 接了账号管理、但一个 Antigravity 账号都没有时的提示 */
export const NO_AGY_ACCOUNT = '没有 Antigravity 账号：请在左下角账号菜单「管理账号」里登录';

/** 账号未登录时的报错文案：默认账号沿用原文案，添加的账号提示在左下角账号菜单重新登录 */
export function notLoggedInMessage(account: AgyAccountRef): string {
  if (account.id === DEFAULT_ID) return AGY_NOT_LOGGED_IN;
  return `Antigravity 账号「${account.label || account.id}」未登录：请在左下角账号菜单重新登录`;
}

const isWin = process.platform === 'win32';
const STDERR_TAIL_BYTES = 4 * 1024;
/** 算作「有进度」的 update 类型，其它（usage_update 等）不算 */
const PROGRESS_UPDATES = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan']);
/** agy 冷启动竞态：会话建立时模型配置为空，prompt 立即以文字报这个错 */
const NO_MODEL_RE = /plan model not specified/i;
/** 进程意外退出后自动重试一次时，加在原 prompt 前的提示 */
export const CRASH_RETRY_PREFIX =
  '(Your previous run of this task was interrupted because your process exited unexpectedly. Before continuing, check what has already been done, such as files changed and commands run, and do not repeat completed steps.)\n\n';

export interface AcpRunOptions extends BackendRunOptions {
  agyPath: string;
  /** 本次调用使用的 agy 账号；不传 = 默认账号 */
  account?: AgyAccountRef;
}

export interface AcpPoolOptions {
  spawn?: typeof nodeSpawn;
  kill?: (pid: number) => void;
  now?: () => number;
  /** 当前活跃的 agy 账号 id（用于 hold 语义：切账号后只保活新账号的桶，旧账号的桶按空闲时间正常回收） */
  activeAccountId?: () => string;
  /** 需要保活的 agy 账号 id（委派路线里用到的）；传了就代替 activeAccountId 判断 hold */
  heldAccountIds?: () => readonly string[];
  sessionIdleMs?: number;
  processIdleMs?: number;
  extraProcessIdleMs?: number;
  sweepMs?: number;
  firstUpdateMs?: number;
  /** 运行中无工具调用时，多久无任何 session update 视为卡死，默认 10 分钟 */
  idleUpdateMs?: number;
  cancelGraceMs?: number;
  requestTimeoutMs?: number;
  /** 模型列表为空（冷启动竞态）时的重试间隔 */
  modelsRetryMs?: number;
  /** 单个进程最多同时跑几个 prompt，默认 8 */
  maxPromptsPerProc?: number;
  /** 单个工作区最多起几个进程，默认 3 */
  maxProcsPerCwd?: number;
  /** 委派进程完成 initialize 就绪时回调（用于从内置 language server 刷新额度） */
  onProcReady?: (accountId: string, pid: number) => void;
  /** 一轮委派执行结束时回调（用于及时刷新额度） */
  onRunFinished?: (accountId: string) => void;
}

interface Session {
  busy: boolean;
  lastUsed: number;
  model?: string;
}

interface Pending {
  resolve: (v: Json) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Lease {
  proc: AcpProc;
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
  procs: AcpProc[];
  waiters: Waiter[];
}

interface Ctx {
  spawn: typeof nodeSpawn;
  kill: (pid: number) => void;
  killSync: (pid: number) => void;
  now: () => number;
  requestTimeoutMs: number;
  /** 进程不再可用时通知池移除 */
  onGone: (p: AcpProc) => void;
  /** 进程 initialize 完成时回调 */
  onReady?: (p: AcpProc) => void;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const cancelled = () => new Error('已取消');

/** 可取消的延时：cancel 后 promise 永不 resolve */
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

/** 一个常驻 agy acp 进程 + 它上面的 JSON-RPC 连接 */
class AcpProc {
  readonly sessions = new Map<string, Session>();
  /** 正在 prompt 的会话 -> update 回调；没有监听者的 update（比如 load 回放）直接丢弃 */
  readonly listeners = new Map<string, (u: Json) => void>();
  lastActivity: number;
  /** 没有打开会话的起始时间（用于额外进程的 2 分钟空闲回收） */
  emptySince: number | null;
  /** 已预留的并发槽位数（含正在等 initialize 的调用） */
  slots = 0;
  initialized = false;
  ready!: Promise<void>;
  draining = false;
  dead = false;
  unexpectedExit = false;
  private deathError: Error | null = null;
  private exited = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly splitter = new LineSplitter();
  readonly notLoggedInMsg: string;
  private stderrTail = '';
  private readonly proc: ChildProcess;

  constructor(
    readonly key: string,
    agyPath: string,
    cwd: string,
    readonly account: AgyAccountRef,
    readonly generation: number,
    private readonly ctx: Ctx,
  ) {
    this.notLoggedInMsg = notLoggedInMessage(account);
    this.lastActivity = ctx.now();
    this.emptySince = this.lastActivity;
    const spec = spawnSpec(agyPath, ['acp', '--dangerously-skip-permissions', ...agyAccountArgs(account.dir)]);
    try {
      this.proc = ctx.spawn(spec.command, spec.args, {
        cwd,
        env: agyAccountEnv(account.dir),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
      });
    } catch (e) {
      throw new Error(`无法启动委派进程: ${errMsg(e)}`);
    }
    const proc = this.proc;
    proc.stdout?.on('data', (d: Buffer | string) => {
      for (const l of this.splitter.push(d)) this.onLine(l);
    });
    proc.stderr?.on('data', (d: Buffer | string) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-STDERR_TAIL_BYTES);
      if (!this.dead && /Authentication required/i.test(this.stderrTail)) this.shutdown(new Error(this.notLoggedInMsg));
    });
    proc.stdin?.on('error', () => { /* 进程已退出的 EPIPE，由 close 处理 */ });
    proc.on('error', (err) => {
      this.exited = true;
      this.shutdown(new Error(`无法启动委派进程: ${err.message}`), { unexpected: true });
    });
    proc.on('close', (code) => {
      this.exited = true;
      const tail = this.stderrTail.trim();
      this.shutdown(new Error(`委派进程退出（退出码 ${code}）${tail ? `\n${tail}` : ''}`), { unexpected: true });
    });
    this.ready = this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'cosyee', version: '1' },
    }).then(
      () => {
        this.initialized = true;
        if (!this.dead) {
          try {
            this.ctx.onReady?.(this);
          } catch { /* 回调出错不影响进程就绪 */ }
        }
      },
      (e) => {
        this.shutdown(e instanceof Error ? e : new Error(String(e)));
        throw e;
      },
    );
    this.ready.catch(() => {});
  }

  get pid(): number | undefined {
    return this.proc.pid;
  }

  get busy(): boolean {
    for (const s of this.sessions.values()) if (s.busy) return true;
    return false;
  }

  setSession(id: string, s: Session): void {
    this.sessions.set(id, s);
    this.emptySince = null;
  }

  deleteSession(id: string): void {
    this.sessions.delete(id);
    if (this.sessions.size === 0) this.emptySince = this.ctx.now();
  }

  /** 发请求；timeoutMs 缺省用全局，0 表示不设超时（prompt） */
  request(method: string, params: Json, timeoutMs = this.ctx.requestTimeoutMs): Promise<Json> {
    if (this.dead) return Promise.reject(this.deathError ?? new Error('委派进程已退出'));
    const id = this.nextId++;
    return new Promise<Json>((resolve, reject) => {
      const entry: Pending = { resolve, reject };
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private write(msg: Json): void {
    this.lastActivity = this.ctx.now();
    try {
      this.proc.stdin?.write(JSON.stringify(msg) + '\n');
    } catch { /* 由 close 处理 */ }
  }

  private onLine(line: string): void {
    let m: Json;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!m || typeof m !== 'object') return;
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method === 'string') {
      if (hasId) this.onAgentRequest(m);
      else if (m.method === 'session/update') this.onUpdate(m.params);
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (p.timer) clearTimeout(p.timer);
    if (m.error) {
      const e = m.error;
      p.reject(new Error(typeof e === 'object' && e ? String(e.message ?? JSON.stringify(e)) : String(e)));
    } else {
      p.resolve(m.result ?? {});
    }
  }

  private onUpdate(params: Json | undefined): void {
    const sid = params?.sessionId;
    const update = params?.update;
    if (typeof sid !== 'string' || !update || typeof update !== 'object') return;
    this.listeners.get(sid)?.(update);
  }

  /** agent -> client 的请求：权限自动放行，其它方法不支持 */
  private onAgentRequest(m: Json): void {
    if (m.method === 'session/request_permission') {
      const opts: Json[] = Array.isArray(m.params?.options) ? m.params.options : [];
      const pick = opts.find((o) => o.kind === 'allow_once') ?? opts.find((o) => o.kind === 'allow_always') ?? opts[0];
      const outcome = pick ? { outcome: 'selected', optionId: pick.optionId } : { outcome: 'cancelled' };
      this.write({ jsonrpc: '2.0', id: m.id, result: { outcome } });
    } else {
      this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    }
  }

  /** 结束进程：所有 pending 以 err 失败，通知池移除 */
  shutdown(err: Error, opts: { sync?: boolean; unexpected?: boolean } = {}): void {
    if (this.dead) return;
    this.dead = true;
    this.unexpectedExit = !!opts.unexpected;
    this.deathError = err;
    this.ctx.onGone(this);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    if (!this.exited && this.proc.pid) {
      try {
        (opts.sync ? this.ctx.killSync : this.ctx.kill)(this.proc.pid);
      } catch { /* ignore */ }
    }
  }
}

type WatchdogReason = 'first' | 'idle';

type PromptOutcome =
  | { kind: 'done'; result: Omit<BackendResult, 'sessionId'> }
  | { kind: 'stuck'; returned: boolean; reason: WatchdogReason; toolCalls: number }
  | { kind: 'crashed'; error: Error; toolCalls: number };

export class AcpPool {
  private readonly buckets = new Map<string, CwdPool>();
  /** 按 cwd（不含账号）统计的保活引用计数：切账号后新账号的桶也被保活，旧账号的桶按空闲时间正常回收 */
  private readonly cwdHolds = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly spawn: typeof nodeSpawn;
  private readonly kill: (pid: number) => void;
  private readonly now: () => number;
  private readonly activeAccountId: () => string;
  private readonly heldAccountIds?: () => readonly string[];
  private readonly sessionIdleMs: number;
  private readonly processIdleMs: number;
  private readonly extraProcessIdleMs: number;
  private readonly sweepMs: number;
  private readonly firstUpdateMs: number;
  private readonly idleUpdateMs: number;
  private readonly cancelGraceMs: number;
  private readonly requestTimeoutMs: number;
  private readonly modelsRetryMs: number;
  private readonly maxPromptsPerProc: number;
  private readonly maxProcsPerCwd: number;
  private readonly onProcReady?: (accountId: string, pid: number) => void;
  private readonly onRunFinished?: (accountId: string) => void;
  /** (agyPath + accountId) → 最近一次会话报告的可用模型（账号级，与工作区无关） */
  private readonly modelCache = new Map<string, { available: AvailableModel[]; current: string | null; at: number }>();
  /** 进程代际：CLI 升级后递增，旧代进程不再复用并在当前任务结束后自动回收 */
  private generation = 0;

  constructor(opts: AcpPoolOptions = {}) {
    this.spawn = opts.spawn ?? nodeSpawn;
    this.kill = opts.kill ?? killTree;
    this.now = opts.now ?? Date.now;
    this.activeAccountId = opts.activeAccountId ?? (() => DEFAULT_ID);
    this.heldAccountIds = opts.heldAccountIds;
    this.sessionIdleMs = opts.sessionIdleMs ?? 5 * 60_000;
    this.processIdleMs = opts.processIdleMs ?? 10 * 60_000;
    this.extraProcessIdleMs = opts.extraProcessIdleMs ?? 2 * 60_000;
    this.sweepMs = opts.sweepMs ?? 60_000;
    this.firstUpdateMs = opts.firstUpdateMs ?? 90_000;
    this.idleUpdateMs = opts.idleUpdateMs ?? 600_000;
    this.cancelGraceMs = opts.cancelGraceMs ?? 10_000;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.modelsRetryMs = opts.modelsRetryMs ?? 1_000;
    this.maxPromptsPerProc = opts.maxPromptsPerProc ?? 8;
    this.maxProcsPerCwd = opts.maxProcsPerCwd ?? 3;
    this.onProcReady = opts.onProcReady;
    this.onRunFinished = opts.onRunFinished;
  }

  private cwdKeyOf(agyPath: string, cwd: string): string {
    const abs = path.resolve(cwd);
    return agyPath + '\0' + (isWin ? abs.toLowerCase() : abs);
  }

  private keyOf(agyPath: string, cwd: string, accountId: string): string {
    const abs = path.resolve(cwd);
    return agyPath + '\0' + accountId + '\0' + (isWin ? abs.toLowerCase() : abs);
  }

  private modelKeyOf(agyPath: string, accountId: string): string {
    return agyPath + '\0' + accountId;
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
    if (b && b.procs.length === 0 && b.waiters.length === 0) {
      this.buckets.delete(key);
    }
    let anyProcs = false;
    for (const bucket of this.buckets.values()) {
      if (bucket.procs.length > 0) {
        anyProcs = true;
        break;
      }
    }
    if (!anyProcs) this.stopTimer();
  }

  private spawnProc(key: string, bucket: CwdPool, agyPath: string, cwd: string, account: AgyAccountRef): AcpProc {
    const p = new AcpProc(key, agyPath, cwd, account, this.generation, {
      spawn: this.spawn,
      kill: this.kill,
      killSync: this.kill === killTree ? killTreeSync : this.kill,
      now: this.now,
      requestTimeoutMs: this.requestTimeoutMs,
      onGone: (gone) => {
        const idx = bucket.procs.indexOf(gone);
        if (idx >= 0) bucket.procs.splice(idx, 1);
        this.drainWaiters(key, agyPath, cwd, account);
        this.maybeCleanBucket(key);
      },
      onReady: (readyProc) => {
        if (readyProc.pid) this.onProcReady?.(account.id, readyProc.pid);
      },
    });
    bucket.procs.push(p);
    this.startTimer();
    return p;
  }

  private makeLease(proc: AcpProc, key: string, agyPath: string, cwd: string, account: AgyAccountRef): Lease {
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
          this.drainWaiters(key, agyPath, cwd, account);
        }
      },
    };
  }

  /** 尝试同步占一个并发槽位；没有空位且已达进程上限返回 null */
  private tryAcquire(key: string, bucket: CwdPool, agyPath: string, cwd: string, account: AgyAccountRef, sessionId?: string): Lease | null {
    const retired = (p: AcpProc) => p.draining || p.generation !== this.generation;
    let owner: AcpProc | undefined;
    if (sessionId) {
      owner = bucket.procs.find((p) => !p.dead && p.sessions.has(sessionId));
      if (owner) {
        if (owner.sessions.get(sessionId)!.busy) {
          throw new BackendError('该 conversation_id 正在执行中', sessionId, account.id);
        }
        if (!retired(owner) && owner.slots < this.maxPromptsPerProc) {
          owner.slots++;
          return this.makeLease(owner, key, agyPath, cwd, account);
        }
      }
    }

    let best: AcpProc | null = null;
    for (const p of bucket.procs) {
      if (p.dead || retired(p) || p.slots >= this.maxPromptsPerProc) continue;
      if (!best || p.slots < best.slots) best = p;
    }
    if (best) {
      if (owner && owner !== best && sessionId) {
        owner.deleteSession(sessionId);
        owner.request('session/close', { sessionId }).catch(() => {});
      }
      best.slots++;
      return this.makeLease(best, key, agyPath, cwd, account);
    }

    const activeProcs = bucket.procs.filter((p) => !p.dead && !retired(p)).length;
    if (activeProcs < this.maxProcsPerCwd) {
      const p = this.spawnProc(key, bucket, agyPath, cwd, account);
      if (owner && sessionId) {
        owner.deleteSession(sessionId);
        owner.request('session/close', { sessionId }).catch(() => {});
      }
      p.slots++;
      return this.makeLease(p, key, agyPath, cwd, account);
    }

    return null;
  }

  private drainWaiters(key: string, agyPath: string, cwd: string, account: AgyAccountRef): void {
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
        lease = this.tryAcquire(key, bucket, agyPath, cwd, account, w.sessionId);
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
  private async acquireSlot(agyPath: string, cwd: string, account: AgyAccountRef, signal: AbortSignal, sessionId?: string): Promise<Lease> {
    if (signal.aborted) throw cancelled();
    const key = this.keyOf(agyPath, cwd, account.id);
    const bucket = this.getBucket(key, account.id, this.cwdKeyOf(agyPath, cwd));
    let lease = this.tryAcquire(key, bucket, agyPath, cwd, account, sessionId);
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
      const res = await Promise.race([
        lease.proc.ready.then(() => 'ready' as const),
        ab.p,
      ]);
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

  /** 仅用于 models() 读取：取现有进程或起一个，不占 prompt 槽位 */
  private async getAnyProc(agyPath: string, cwd: string, account: AgyAccountRef): Promise<AcpProc> {
    const key = this.keyOf(agyPath, cwd, account.id);
    const bucket = this.getBucket(key, account.id, this.cwdKeyOf(agyPath, cwd));
    let p = bucket.procs.find((x) => !x.dead && !x.draining && x.generation === this.generation);
    if (!p) p = this.spawnProc(key, bucket, agyPath, cwd, account);
    await p.ready;
    return p;
  }

  /** 后台预热该工作区：还没有活进程就起一个，建并关一个临时会话触发后端冷启动，失败静默 */
  prewarm(agyPath: string, cwd: string, account: AgyAccountRef = DEFAULT_ACCOUNT): void {
    const key = this.keyOf(agyPath, cwd, account.id);
    const bucket = this.getBucket(key, account.id, this.cwdKeyOf(agyPath, cwd));
    if (bucket.procs.some((p) => !p.dead && !p.draining && p.generation === this.generation)) return;
    try {
      const p = this.spawnProc(key, bucket, agyPath, cwd, account);
      void p.ready
        .then(async () => {
          if (p.dead || p.draining) return;
          const { sid } = await this.newSession(p, agyPath, cwd);
          await p.request('session/close', { sessionId: sid });
        })
        .catch(() => {});
    } catch { /* 静默 */ }
  }

  /** 持有期间不回收该工作区当前活跃账号的热进程；返回幂等释放函数 */
  hold(agyPath: string, cwd: string): () => void {
    const cwdKey = this.cwdKeyOf(agyPath, cwd);
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

  /** agy 的可用模型；没有缓存（或要求刷新）时在 cwd 的进程上开一个临时会话读取 */
  async models(o: { agyPath: string; cwd: string; refresh?: boolean; account?: AgyAccountRef }): Promise<DelegateModelList> {
    const account = o.account ?? DEFAULT_ACCOUNT;
    const mKey = this.modelKeyOf(o.agyPath, account.id);
    const before = this.modelCache.get(mKey);
    if (o.refresh || !before?.current) {
      for (let i = 0; i < 3; i++) {
        const proc = await this.getAnyProc(o.agyPath, o.cwd, account);
        const { sid, res } = await this.newSession(proc, o.agyPath, o.cwd);
        proc.request('session/close', { sessionId: sid }).catch(() => {});
        if (parseAvailable(res.models).length) break;
        // 冷启动时模型配置可能还没拉到，等一下再要
        await delay(this.modelsRetryMs).p;
      }
    }
    const c = this.modelCache.get(mKey);
    if (!c) throw new Error('没有返回模型列表，请稍后重试');
    return toModelList(c.available, c.current, c.at);
  }

  /** 记下会话报告的模型列表，返回该会话当前的模型。冷启动竞态时列表为空，不记；load 的当前模型是那个会话自己的，不算默认值 */
  private noteModels(agyPath: string, accountId: string, models: Json | undefined, isNew: boolean): string | undefined {
    const available = parseAvailable(models);
    const current = typeof models?.currentModelId === 'string' && models.currentModelId ? models.currentModelId : undefined;
    if (available.length) {
      const mKey = this.modelKeyOf(agyPath, accountId);
      const prev = this.modelCache.get(mKey);
      this.modelCache.set(mKey, { available, current: (isNew ? current : prev?.current) ?? null, at: this.now() });
    }
    return current;
  }

  /** 发 prompt 前把会话切到要用的模型，并报告实际使用的模型 */
  private async applyModel(proc: AcpProc, sid: string, o: AcpRunOptions): Promise<void> {
    const sess = proc.sessions.get(sid);
    if (!sess) return;
    const fresh = !o.sessionId;
    const model = fresh ? (o.defaults?.model ?? undefined) : undefined;
    // 用户设置里的默认强度优先，没填再用智能体定义里的强度
    const effort = fresh ? (o.defaults?.effort ?? o.effort ?? undefined) : undefined;
    const mKey = this.modelKeyOf(o.agyPath, proc.account.id);
    if (model || effort) {
      // 只给了基础模型或强度，得有列表才能拼出完整 id
      const complete = !!model && (!!effort || !!splitModelId(model).effort);
      if (!complete && !this.modelCache.has(mKey)) await this.models({ agyPath: o.agyPath, cwd: o.cwd, account: proc.account }).catch(() => {});
      const available = this.modelCache.get(mKey)?.available ?? [];
      let r = resolveModelId(available, {
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        strictEffort: false,
        current: sess.model ?? null,
      });
      // 用户默认设置的模型在另一账号不可用时：回退到该账号的 current 模型，不让委派整个失败
      if ('error' in r && model) {
        if (effort && sess.model) {
          const fallback = resolveModelId(available, { effort, strictEffort: false, current: sess.model });
          r = 'error' in fallback ? { id: sess.model } : fallback;
        } else if (sess.model) {
          r = { id: sess.model };
        } else {
          r = { id: '' };
        }
      }
      if ('error' in r) throw new BackendError(r.error, sid, proc.account.id);
      if (r.id && sess.model !== r.id) {
        try {
          await proc.request('session/set_model', { sessionId: sid, modelId: r.id });
          sess.model = r.id;
        } catch (e) {
          // 默认设置切模型失败同样回退到 current，不让委派失败
          if (!model) throw new BackendError(`切换模型失败: ${errMsg(e)}`, sid, proc.account.id);
        }
      }
    }
    if (!sess.model) return;
    try {
      o.onModel?.(splitModelId(sess.model));
    } catch { /* 展示出错不影响执行 */ }
  }

  async run(o: AcpRunOptions): Promise<BackendResult> {
    if (o.signal.aborted) throw cancelled();
    const account = o.account ?? DEFAULT_ACCOUNT;
    const authMsg = notLoggedInMessage(account);
    let lease = await this.acquireSlot(o.agyPath, o.cwd, account, o.signal, o.sessionId);
    let sid: string | undefined;
    let reloaded = false;
    let stuckCount = 0;
    let crashed = false;
    let totalToolCalls = 0;
    let promptText = o.prompt;
    try {
      if (o.signal.aborted) throw cancelled();
      sid = await this.openSession(lease.proc, o);
      try {
        o.onSession?.(sid, account.id);
      } catch { /* 回调出错不影响执行 */ }
      for (;;) {
        if (o.signal.aborted) throw cancelled();
        await this.applyModel(lease.proc, sid, o);
        if (o.signal.aborted) throw cancelled();
        const out = await this.promptOnce(lease.proc, sid, o, promptText);
        if (out.kind === 'done') {
          lease.proc.lastActivity = this.now();
          // 冷启动时模型配置还没拉到就建了会话：这次 prompt 以文字形式报错。close 后 load 回来会重建会话配置，重试一次
          if (!reloaded && totalToolCalls === 0 && out.result.toolCalls === 0 && NO_MODEL_RE.test(out.result.response)) {
            reloaded = true;
            await lease.proc.request('session/close', { sessionId: sid }).catch(() => {});
            lease.proc.deleteSession(sid);
            if (o.signal.aborted) throw cancelled();
            await this.loadSession(lease.proc, sid, o);
            continue;
          }
          return { ...out.result, toolCalls: totalToolCalls + out.result.toolCalls, sessionId: sid, accountId: account.id };
        }
        if (out.kind === 'crashed') {
          totalToolCalls += out.toolCalls;
          if (crashed) {
            throw new BackendError(`委派进程意外退出: ${errMsg(out.error)}`, sid, account.id);
          }
          crashed = true;
          lease.release();
          if (o.signal.aborted) throw cancelled();
          lease = await this.acquireSlot(o.agyPath, o.cwd, account, o.signal, sid);
          if (o.signal.aborted) throw cancelled();
          await this.loadSession(lease.proc, sid, o);
          promptText = CRASH_RETRY_PREFIX + o.prompt;
          continue;
        }
        // 卡死：已经 cancel 过；没返回就将进程标为排空，不杀其它在跑的会话
        totalToolCalls += out.toolCalls;
        if (!out.returned) {
          lease.proc.draining = true;
          lease.proc.deleteSession(sid);
        }
        if (stuckCount >= 1) {
          const desc =
            out.reason === 'first'
              ? `${Math.round(this.firstUpdateMs / 1000)}s 内`
              : this.idleUpdateMs >= 60_000
                ? `${Math.round(this.idleUpdateMs / 60_000)} 分钟内`
                : `${Math.max(1, Math.round(this.idleUpdateMs / 1000))}s 内`;
          throw new BackendError(
            `委派任务无响应（${desc}没有任何输出），可以用 conversation_id 重试`,
            sid,
            account.id,
          );
        }
        stuckCount++;
        if (!out.returned) {
          // 换进程，load 回原会话再试
          lease.release();
          lease = await this.acquireSlot(o.agyPath, o.cwd, account, o.signal, sid);
          if (o.signal.aborted) throw cancelled();
          await this.loadSession(lease.proc, sid, o);
        }
      }
    } catch (e) {
      if (e instanceof BackendError || (e instanceof Error && (e.message === '已取消' || e.message === authMsg))) throw e;
      if (sid) throw new BackendError(errMsg(e), sid, account.id);
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      if (sid) {
        const s = lease.proc.sessions.get(sid);
        if (s) {
          s.busy = false;
          s.lastUsed = this.now();
        }
      }
      lease.proc.lastActivity = this.now();
      lease.release();
      if (sid) {
        try {
          this.onRunFinished?.(account.id);
        } catch { /* 回调出错不影响委派结果 */ }
      }
    }
  }

  /** 选定/创建会话，返回 sessionId；返回时该会话已标记 busy */
  private async openSession(proc: AcpProc, o: AcpRunOptions): Promise<string> {
    const id = o.sessionId;
    if (!id) {
      const { sid, model } = await this.newSession(proc, o.agyPath, o.cwd, o.systemPrompt);
      proc.setSession(sid, { busy: true, lastUsed: this.now(), ...(model ? { model } : {}) });
      return sid;
    }
    const s = proc.sessions.get(id);
    if (s) {
      if (s.busy) throw new BackendError('该 conversation_id 正在执行中', id, proc.account.id);
      s.busy = true;
      return id;
    }
    await this.loadSession(proc, id, o);
    return id;
  }

  private async newSession(
    proc: AcpProc,
    agyPath: string,
    cwd: string,
    systemPrompt?: string,
  ): Promise<{ sid: string; res: Json; model: string | undefined }> {
    let res: Json;
    try {
      const params: Json = {
        cwd,
        mcpServers: [],
        ...(systemPrompt ? { _meta: { antigravity: { systemPrompt: { append: systemPrompt } } } } : {}),
      };
      res = await proc.request('session/new', params);
    } catch (e) {
      if (/auth|log ?in|not logged/i.test(errMsg(e))) throw new Error(proc.notLoggedInMsg);
      throw e;
    }
    const sid = res.sessionId;
    if (typeof sid !== 'string' || !sid) throw new Error('session/new 没有返回 sessionId');
    return { sid, res, model: this.noteModels(agyPath, proc.account.id, res.models, true) };
  }

  private async loadSession(proc: AcpProc, id: string, o: AcpRunOptions): Promise<void> {
    // 先占位（busy），避免同 id 并发时重复 load
    const sess: Session = { busy: true, lastUsed: this.now() };
    proc.setSession(id, sess);
    try {
      const res = await proc.request('session/load', { sessionId: id, cwd: o.cwd, mcpServers: [] });
      const model = this.noteModels(o.agyPath, proc.account.id, res.models, false);
      if (model) sess.model = model;
    } catch (e) {
      proc.deleteSession(id);
      const msg = errMsg(e);
      // 会话根本不存在时不附 id，免得上层拿它重试
      throw new BackendError(`无法恢复会话 ${id}: ${msg}`, /not found/i.test(msg) ? undefined : id, proc.account.id);
    }
  }

  /** 发一次 prompt 并等结果；卡死时 cancel 后报告是否返回 */
  private async promptOnce(proc: AcpProc, sid: string, o: AcpRunOptions, promptText: string): Promise<PromptOutcome> {
    let allText = '';
    let afterToolText = '';
    const tools = new Set<string>();
    const activeTools = new Set<string>();
    const usageAdapter = o.onUsage ? new AgyUsageAdapter({ sessionId: sid, model: proc.sessions.get(sid)?.model ?? null }) : null;
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
    proc.listeners.set(sid, (u) => {
      const t = u.sessionUpdate;
      if (!gotFirst && PROGRESS_UPDATES.has(t)) gotFirst = true;
      if (t === 'tool_call' || t === 'tool_call_update') {
        afterToolText = '';
        if (u.toolCallId != null) {
          const tid = String(u.toolCallId);
          if (u.status === 'completed' || u.status === 'failed') {
            tools.add(tid);
            activeTools.delete(tid);
          } else {
            activeTools.add(tid);
          }
        }
      }
      if (gotFirst) {
        if (activeTools.size > 0) clearWd();
        else armWd(this.idleUpdateMs, 'idle');
      }
      if (t === 'agent_message_chunk' && u.content?.type === 'text' && typeof u.content.text === 'string') {
        allText += u.content.text;
        afterToolText += u.content.text;
      }
      try {
        o.onUpdate?.(u);
      } catch { /* 展示出错不影响执行 */ }
      if (usageAdapter && (t === 'usage_update' || t === 'tool_call')) {
        for (const pt of usageAdapter.push(u)) {
          try {
            o.onUsage?.(pt, usageAdapter.window());
          } catch { /* 展示出错不影响执行 */ }
        }
      }
    });
    const done = proc
      .request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: promptText }] }, 0)
      .then((v) => ({ t: 'done' as const, v }), (e) => ({ t: 'err' as const, e: e as Error }));
    try {
      const first = await Promise.race([done, ab.p, wdPromise]);
      if (typeof first === 'object' && first.t !== 'stuck') {
        if (first.t === 'err') {
          if (proc.unexpectedExit && !o.signal.aborted && first.e.message !== proc.notLoggedInMsg) {
            return { kind: 'crashed', error: first.e, toolCalls: tools.size };
          }
          throw first.e;
        }
        const usage = first.v.usage;
        if (usageAdapter && usage && typeof usage === 'object') {
          for (const pt of usageAdapter.push({ type: 'prompt_response', usage })) {
            try {
              o.onUsage?.(pt, usageAdapter.window());
            } catch { /* 展示出错不影响执行 */ }
          }
        }
        return {
          kind: 'done',
          result: {
            stopReason: String(first.v.stopReason ?? 'end_turn'),
            response: afterToolText.trim() ? afterToolText : allText,
            toolCalls: tools.size,
            ...(usage && typeof usage === 'object' ? { usage } : {}),
          },
        };
      }
      // 取消或卡死：都先发 cancel，再等 prompt 返回
      proc.notify('session/cancel', { sessionId: sid });
      const grace = delay(this.cancelGraceMs);
      try {
        if (first === 'abort') {
          const r = await Promise.race([done, grace.p]);
          if (r === 'timeout') {
            proc.draining = true;
            proc.deleteSession(sid);
          }
          throw cancelled();
        }
        const second = await Promise.race([done, grace.p, ab.p]);
        if (second === 'abort') {
          proc.draining = true;
          proc.deleteSession(sid);
          throw cancelled();
        }
        if (second === 'timeout') return { kind: 'stuck', returned: false, reason: first.reason, toolCalls: tools.size };
        if (second.t === 'err') {
          if (proc.unexpectedExit && !o.signal.aborted && second.e.message !== proc.notLoggedInMsg) {
            return { kind: 'crashed', error: second.e, toolCalls: tools.size };
          }
          throw second.e;
        }
        return { kind: 'stuck', returned: true, reason: first.reason, toolCalls: tools.size };
      } finally {
        grace.cancel();
      }
    } finally {
      clearWd();
      ab.off();
      proc.listeners.delete(sid);
    }
  }

  /** 立即执行一次回收 */
  sweep(): void {
    const now = this.now();
    const heldIds = this.heldAccountIds ? this.heldAccountIds() : [this.activeAccountId()];
    for (const [key, bucket] of [...this.buckets]) {
      const held = heldIds.includes(bucket.accountId) && (this.cwdHolds.get(bucket.cwdKey) ?? 0) > 0;
      const primary = bucket.procs.find((p) => !p.dead && !p.draining);
      for (const proc of [...bucket.procs]) {
        if (proc.dead) continue;
        if (proc.draining) {
          if (proc.slots === 0) proc.shutdown(new Error('委派进程排空完成，已终止'));
          continue;
        }
        if (!proc.initialized) continue;
        // 先取空闲时间：下面发 session/close 会刷新 lastActivity
        const idle = now - proc.lastActivity;
        for (const [id, s] of [...proc.sessions]) {
          if (!s.busy && now - s.lastUsed > this.sessionIdleMs) {
            proc.deleteSession(id);
            proc.request('session/close', { sessionId: id }).catch(() => {});
          }
        }
        if (held || proc.busy || proc.slots > 0) continue;
        if (proc === primary) {
          if (idle > this.processIdleMs) proc.shutdown(new Error('空闲回收'));
        } else if (proc.sessions.size === 0 && proc.emptySince !== null && now - proc.emptySince > this.extraProcessIdleMs) {
          proc.shutdown(new Error('空闲回收'));
        }
      }
      this.maybeCleanBucket(key);
    }
  }

  private clearModelCache(accountId: string): void {
    const suffix = '\0' + accountId;
    for (const k of [...this.modelCache.keys()]) {
      if (k.endsWith(suffix)) this.modelCache.delete(k);
    }
  }

  /** 某账号当前存活且已完成初始化的常驻进程 pid 列表（用于直接读取内置 language server 额度） */
  livePids(accountId: string): number[] {
    const pids: number[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.accountId !== accountId) continue;
      for (const p of bucket.procs) {
        if (!p.dead && p.initialized && p.pid) pids.push(p.pid);
      }
    }
    return pids;
  }

  /** 正在执行的委派任务数（含排队中）；传 accountId 时只统计该账号，不传统计全部 */
  runningCount(accountId?: string): number {
    let n = 0;
    for (const bucket of this.buckets.values()) {
      if (accountId !== undefined && bucket.accountId !== accountId) continue;
      n += bucket.waiters.length;
      for (const p of bucket.procs) {
        if (!p.dead) n += p.slots;
      }
    }
    return n;
  }

  /** CLI 更新完成后：递增代际、清空模型缓存、立即回收空闲进程，执行中进程标为排空（不再复用，结束后自动退出） */
  retireAll(): void {
    this.generation++;
    this.modelCache.clear();
    const err = new Error('CLI 已更新，回收旧版委派进程');
    for (const bucket of [...this.buckets.values()]) {
      for (const p of [...bucket.procs]) {
        if (p.dead) continue;
        if (p.busy || p.slots > 0) p.draining = true;
        else p.shutdown(err);
      }
    }
  }

  /** 回收全部常驻进程；force=false 且仍有执行中任务时不动并返回 { stopped: false, running } */
  stopAll(force = false): { stopped: boolean; running: number } {
    const running = this.runningCount();
    if (!force && running > 0) return { stopped: false, running };
    this.generation++;
    this.modelCache.clear();
    const err = new Error(force ? '委派进程已强制重启' : '委派进程已重启');
    for (const [key, bucket] of [...this.buckets]) {
      for (const w of bucket.waiters.splice(0)) {
        w.signal.removeEventListener('abort', w.onAbort);
        w.reject(err);
      }
      for (const p of [...bucket.procs]) {
        if (!p.dead) p.shutdown(err);
      }
      this.maybeCleanBucket(key);
    }
    return { stopped: true, running };
  }

  /** 移除账号前结束该账号所有空闲进程；若仍有执行中任务则不动并返回 false */
  stopAccount(accountId: string): boolean {
    const targets: CwdPool[] = [];
    for (const bucket of this.buckets.values()) {
      if (bucket.accountId !== accountId) continue;
      if (bucket.waiters.length > 0) return false;
      for (const p of bucket.procs) {
        if (!p.dead && (p.busy || p.slots > 0)) return false;
      }
      targets.push(bucket);
    }
    const err = new Error('账号已移除');
    for (const bucket of targets) {
      for (const p of [...bucket.procs]) {
        if (!p.dead) p.shutdown(err);
      }
    }
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
        sessions += p.sessions.size;
        for (const s of p.sessions.values()) if (s.busy) busy++;
      }
    }
    return { processes, sessions, busy };
  }
}

let shared: AcpPool | null = null;

/** 服务端共享的单例；首次创建时注册退出钩子 */
export function sharedAcpPool(): AcpPool {
  if (!shared) {
    const pool = new AcpPool();
    process.once('exit', () => pool.dispose(true));
    shared = pool;
  }
  return shared;
}

export interface AgyBackendOptions {
  pool?: AcpPool;
  /** 测试用：固定 agy 路径（null = 不可用）；不传则每次按需调用 resolveAgy() */
  agyPath?: string | null;
  resolve?: () => string | null;
  /** 多账号来源；不传则始终使用默认账号 */
  accounts?: {
    /** 当前账号；一个账号都没有返回 null（不退回本机 agy 自己的登录） */
    activeAccount(): AgyAccountRef | null;
    accountFor(id: string): AgyAccountRef | null;
    /** 当前账号是否已登录（false = 未登录；true = 已登录；null = 未知） */
    isLoggedIn?(): boolean | null;
    /** 指定账号是否已登录（同上）；不传 = 未知 */
    isAccountLoggedIn?(id: string): boolean | null;
  };
}

export class AgyBackend implements DelegateBackend {
  readonly id = 'agy';
  readonly label = 'Antigravity';
  private readonly pool: AcpPool;
  private readonly fixedPath: string | null | undefined;
  private readonly resolveFn: () => string | null;
  private readonly accounts?: AgyBackendOptions['accounts'];

  constructor(opts: AgyBackendOptions = {}) {
    this.pool = opts.pool ?? sharedAcpPool();
    this.fixedPath = opts.agyPath;
    this.resolveFn = opts.resolve ?? resolveAgy;
    this.accounts = opts.accounts;
  }

  private getPath(): string | null {
    if (this.fixedPath !== undefined) return this.fixedPath;
    return this.resolveFn();
  }

  private resolveAccount(accountId?: string): AgyAccountRef {
    if (accountId !== undefined) {
      if (this.accounts) {
        const acc = this.accounts.accountFor(accountId);
        if (!acc) throw new Error('创建这个委派会话的账号已移除，请新建委派');
        return acc;
      }
      if (accountId === DEFAULT_ID) return DEFAULT_ACCOUNT;
      throw new Error('创建这个委派会话的账号已移除，请新建委派');
    }
    if (!this.accounts) return DEFAULT_ACCOUNT;
    const acc = this.accounts.activeAccount();
    if (!acc) throw new Error(NO_AGY_ACCOUNT);
    return acc;
  }

  /** 新会话的账号：委派路线里选的（不存在报错）> 当前账号 */
  private routeAccount(routeAccountId?: string): AgyAccountRef {
    if (routeAccountId === undefined) return this.resolveAccount();
    if (!this.accounts) {
      if (routeAccountId === DEFAULT_ID) return DEFAULT_ACCOUNT;
      throw new Error('子代理账号不存在，请在子代理设置里重新选择');
    }
    const acc = this.accounts.accountFor(routeAccountId);
    if (!acc) throw new Error('子代理账号不存在，请在子代理设置里重新选择');
    return acc;
  }

  availability(): SubagentAvailability {
    if (this.getPath() === null) return { ok: false, reason: '未安装 Antigravity CLI' };
    if (this.accounts && !this.accounts.activeAccount()) return { ok: false, reason: NO_AGY_ACCOUNT };
    if (this.accounts?.isLoggedIn?.() === false) return { ok: false, reason: 'Antigravity 账号未登录' };
    return { ok: true };
  }

  accountAvailability(accountId: string): SubagentAvailability {
    if (this.getPath() === null) return { ok: false, reason: '未安装 Antigravity CLI' };
    if (!this.accounts) return accountId === DEFAULT_ID ? { ok: true } : { ok: false, reason: 'Antigravity 账号不存在' };
    if (!this.accounts.accountFor(accountId)) return { ok: false, reason: 'Antigravity 账号已移除' };
    if (this.accounts.isAccountLoggedIn?.(accountId) === false) return { ok: false, reason: 'Antigravity 账号未登录' };
    return { ok: true };
  }

  available(): boolean {
    return this.availability().ok;
  }

  async models(o: { cwd: string; refresh?: boolean; accountId?: string }): Promise<DelegateModelList> {
    const agyPath = this.getPath();
    if (!agyPath) throw new Error('没有安装 Antigravity CLI（agy）');
    return this.pool.models({ agyPath, cwd: o.cwd, refresh: o.refresh, account: this.routeAccount(o.accountId) });
  }

  async run(o: BackendRunOptions): Promise<BackendResult> {
    const agyPath = this.getPath();
    if (!agyPath) throw new Error('没有安装 Antigravity CLI（agy）');
    const account = o.accountId !== undefined ? this.resolveAccount(o.accountId) : this.routeAccount(o.routeAccountId);
    return this.pool.run({ ...o, agyPath, account });
  }

  prewarm(cwd: string, accountId?: string): void {
    const agyPath = this.getPath();
    if (!agyPath) return;
    let account: AgyAccountRef;
    try {
      account = this.routeAccount(accountId);
    } catch {
      return;
    }
    this.pool.prewarm(agyPath, cwd, account);
  }

  hold(cwd: string): () => void {
    const agyPath = this.getPath();
    if (!agyPath) return () => {};
    return this.pool.hold(agyPath, cwd);
  }
}

let sharedBackend: AgyBackend | null = null;

export function sharedAgyBackend(): AgyBackend {
  return (sharedBackend ??= new AgyBackend());
}
