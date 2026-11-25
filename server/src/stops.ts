// 会话因错误停止的记录与错误分类。
// 数据存在 state.json 的 stops 里，按 sessionId 索引；服务重启时把 retrying 状态的记录改回 waiting。
import type { StopInfo, StopKind, StopState } from '@cosyee/shared';
import type { StateStore } from './workspaces.js';

/** 额度用尽时在 resetsAt 之后额外等待的缓冲时间（毫秒） */
export const RATE_LIMIT_BUFFER_MS = 60_000;
/** 额度用尽但没有 resetsAt 时的兜底等待时间（毫秒） */
export const RATE_LIMIT_FALLBACK_MS = 5 * 60_000;
/** 临时错误的退避序列：第 1 / 2 / 3 次自动重试前分别等待 1 / 5 / 15 分钟 */
export const TRANSIENT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
/** 服务重启恢复 retrying 状态时的等待时间（毫秒） */
export const RECOVER_RETRY_DELAY_MS = 60_000;
/** 累计自动重试上限（达到后再次失败则转为 gave_up） */
export const MAX_AUTO_RETRIES = 3;

const RATE_LIMIT_RE = /hit your .*limit|usage limit|rate limit/i;
const FATAL_RE = /safeguards|\baup\b|usage policy|not logged in|\b401\b|authentication|invalid api key|prompt is too long/i;
const TRANSIENT_RE =
  /overloaded|\b529\b|\b5\d\d\b|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|network|timed? ?out/i;

export interface RateLimitHint {
  status?: string;
  /** 额度重置时间（epoch 秒，来自 CLI rate_limit_event） */
  resetsAt?: number;
}

export interface ClassifyOptions {
  /** 是否来自进程异常退出（exited + error）：不命中 rate_limit / fatal 时按 transient 处理 */
  processExit?: boolean;
  /** 已自动重试次数（用于计算 transient 退避，默认 0） */
  attempts?: number;
}

export interface StopClassification {
  kind: StopKind;
  state: Extract<StopState, 'waiting' | 'stopped'>;
  retryAt?: number;
}

/** 计算 transient 错误第 attempts 次自动重试前的退避时长（毫秒） */
export function transientRetryDelay(attempts: number): number {
  const idx = Math.max(0, Math.min(Math.floor(attempts), TRANSIENT_BACKOFF_MS.length - 1));
  return TRANSIENT_BACKOFF_MS[idx]!;
}

/**
 * 将一次会话错误归类为 rate_limit / transient / fatal，并计算初始状态与 retryAt。
 * - rate_limit：本轮收到 rate_limit_event 且 status !== 'allowed'，或文本命中额度限制关键字；
 *   有 resetsAt 时 retryAt = resetsAt * 1000 + 60s，否则 now + 5min。
 * - transient：过载 / 5xx / 网络 / 超时 / 进程异常退出；按 1 / 5 / 15 分钟退避。
 * - fatal：安全拦截、未登录、认证失败、上下文过长以及其它无法自动恢复的错误；state = 'stopped'，无 retryAt。
 */
export function classifyStop(
  text: string,
  rateLimit?: RateLimitHint | null,
  now: number = Date.now(),
  opts: ClassifyOptions = {},
): StopClassification {
  const msg = typeof text === 'string' ? text : '';
  const hasRejectedEvent = !!rateLimit && typeof rateLimit.status === 'string' && rateLimit.status !== '' && rateLimit.status !== 'allowed';
  if (hasRejectedEvent || RATE_LIMIT_RE.test(msg)) {
    const resetsAt = rateLimit?.resetsAt;
    const hasReset = typeof resetsAt === 'number' && Number.isFinite(resetsAt) && resetsAt > 0;
    const retryAt = hasReset ? resetsAt * 1000 + RATE_LIMIT_BUFFER_MS : now + RATE_LIMIT_FALLBACK_MS;
    return { kind: 'rate_limit', state: 'waiting', retryAt };
  }
  if (FATAL_RE.test(msg)) {
    return { kind: 'fatal', state: 'stopped' };
  }
  if (TRANSIENT_RE.test(msg) || opts.processExit) {
    return { kind: 'transient', state: 'waiting', retryAt: now + transientRetryDelay(opts.attempts ?? 0) };
  }
  return { kind: 'fatal', state: 'stopped' };
}

export type StopChangeListener = (sessionId: string, info: StopInfo | null) => void;

export interface StopStoreOptions {
  now?: () => number;
  /** 记录变化时调用（新增、更新、清除） */
  onChange?: StopChangeListener;
}

export interface StopEntry {
  sessionId: string;
  info: StopInfo;
}

function cloneStop(info: StopInfo): StopInfo {
  const out: StopInfo = {
    kind: info.kind,
    reason: info.reason,
    attempts: info.attempts,
    state: info.state,
    at: info.at,
  };
  if (typeof info.retryAt === 'number' && Number.isFinite(info.retryAt)) out.retryAt = info.retryAt;
  return out;
}

export class StopStore {
  private readonly now: () => number;
  private readonly listeners = new Set<StopChangeListener>();

  constructor(private readonly store: StateStore, opts: StopStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    if (opts.onChange) this.listeners.add(opts.onChange);
    this.recoverRetrying();
  }

  /** 服务重启时，上一次进程已不在：把残留的 retrying 记录改回 waiting（1 分钟后重试） */
  private recoverRetrying(): void {
    const stops = this.store.state.stops;
    let changed = false;
    const retryAt = this.now() + RECOVER_RETRY_DELAY_MS;
    for (const [id, info] of Object.entries(stops)) {
      if (info.state === 'retrying') {
        stops[id] = { ...cloneStop(info), state: 'waiting', retryAt };
        changed = true;
      }
    }
    if (changed) this.store.save();
  }

  /** 注册变化回调；返回取消订阅函数 */
  onChange(fn: StopChangeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(sessionId: string, info: StopInfo | null): void {
    for (const fn of this.listeners) {
      try {
        fn(sessionId, info ? cloneStop(info) : null);
      } catch { /* 回调异常不影响存储 */ }
    }
  }

  get(sessionId: string): StopInfo | null {
    const info = this.store.state.stops[sessionId];
    return info ? cloneStop(info) : null;
  }

  set(sessionId: string, info: StopInfo): void {
    const next = cloneStop(info);
    this.store.state.stops[sessionId] = next;
    this.store.save();
    this.notify(sessionId, next);
  }

  clear(sessionId: string): boolean {
    if (!this.store.state.stops[sessionId]) return false;
    delete this.store.state.stops[sessionId];
    this.store.save();
    this.notify(sessionId, null);
    return true;
  }

  list(): StopEntry[] {
    return Object.entries(this.store.state.stops).map(([sessionId, info]) => ({
      sessionId,
      info: cloneStop(info),
    }));
  }
}
