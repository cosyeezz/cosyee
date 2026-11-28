// Kiro 账号余额快照采集：
// - Kiro 账号走 Claude 后端，accountKind='kiro'；
// - 每轮结束后节流（同账号每分钟最多一次，单飞）通过内置 kiro.rs Admin API 查一次余额，写入 kind='monthly' 快照；
// - 仅在 kiro.rs 服务已运行时查询，绝不额外启动进程；失败静默忽略，绝不阻塞。
import type { KiroBalance } from '@cosyee/shared';
import { ledger } from '../sink.js';
import { clampPercent } from './common.js';

const DEFAULT_THROTTLE_MS = 60_000;

/** 将 KiroBalance 写入账本 monthly 快照（windowMs=null，由账本核心按 resetsAt 往前推一个自然月） */
export function recordKiroBalanceSnapshot(
  accountId: string,
  bal: KiroBalance | null | undefined,
  at: number = Date.now(),
  source: 'event' | 'probe' = 'probe',
): void {
  try {
    if (!bal) return;
    const used = typeof bal.used === 'number' && Number.isFinite(bal.used) && bal.used >= 0 ? bal.used : 0;
    const limit = typeof bal.limit === 'number' && Number.isFinite(bal.limit) && bal.limit >= 0 ? bal.limit : 0;
    const percent = limit > 0 ? clampPercent((used / limit) * 100) : 0;
    const resetsAt = typeof bal.resetsAt === 'number' && Number.isFinite(bal.resetsAt) && bal.resetsAt > 0
      ? Math.round(bal.resetsAt)
      : null;
    ledger.snapshot({
      backend: 'claude',
      account: accountId,
      accountKind: 'kiro',
      kind: 'monthly',
      group: null,
      at,
      percent,
      resetsAt,
      windowMs: null,
      source,
      used,
      limit,
    });
  } catch { /* 绝不影响正常请求 */ }
}

export interface KiroBalanceCollectorOptions {
  /** 查余额函数（应保证不额外拉起 kiro.rs 服务；服务未运行时返回 null） */
  fetchBalance: (accountId: string) => Promise<KiroBalance | null>;
  /** 同账号最小查询间隔（毫秒），默认 60 秒 */
  throttleMs?: number;
  now?: () => number;
}

export class KiroBalanceCollector {
  private readonly lastPoll = new Map<string, number>();
  private readonly inflight = new Set<string>();
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(private readonly opts: KiroBalanceCollectorOptions) {
    this.throttleMs = opts.throttleMs ?? DEFAULT_THROTTLE_MS;
    this.now = opts.now ?? Date.now;
  }

  /** 节流触发一次 Kiro 余额查询（fire-and-forget，不阻塞、不抛错） */
  poll(accountId: string): void {
    try {
      if (!accountId) return;
      const now = this.now();
      if (this.inflight.has(accountId)) return;
      const prev = this.lastPoll.get(accountId);
      if (prev !== undefined && now - prev < this.throttleMs) return;

      this.lastPoll.set(accountId, now);
      this.inflight.add(accountId);
      void this.opts
        .fetchBalance(accountId)
        .then((bal) => {
          if (bal) recordKiroBalanceSnapshot(accountId, bal, this.now(), 'probe');
        })
        .catch(() => {})
        .finally(() => {
          this.inflight.delete(accountId);
        });
    } catch { /* 绝不影响正常请求 */ }
  }
}
