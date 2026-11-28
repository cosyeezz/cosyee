// Antigravity（agy）额度快照：AgyAccounts 每次拿到新额度（活委派进程的 language server 或后台探测）时写入账本。
import type { AgyQuota, LedgerWindowKind } from '@cosyee/shared';
import { FIVE_HOURS_MS, WEEK_MS, ledger } from '../sink.js';
import { clampPercent } from './common.js';

function classifyAgyBucket(window: string): { kind: LedgerWindowKind; windowMs: number } | null {
  const w = window.trim().toLowerCase();
  if (w === '5h' || w === 'five_hour' || w === 'session') {
    return { kind: 'session', windowMs: FIVE_HOURS_MS };
  }
  if (w === 'weekly' || w === '7d' || w === 'seven_day') {
    return { kind: 'weekly', windowMs: WEEK_MS };
  }
  return null;
}

/** 将 RetrieveUserQuotaSummary 解析出的 AgyQuota 写入账本快照 */
export function recordAgyQuotaSnapshot(
  accountId: string,
  quota: AgyQuota | null | undefined,
  source: 'event' | 'probe' = 'probe',
): void {
  try {
    if (!quota) return;
    const at = typeof quota.at === 'number' && Number.isFinite(quota.at) ? quota.at : Date.now();
    for (const g of quota.groups) {
      for (const b of g.buckets) {
        const spec = classifyAgyBucket(b.window);
        if (!spec) continue;
        ledger.snapshot({
          backend: 'agy',
          account: accountId,
          accountKind: 'subscription',
          kind: spec.kind,
          group: g.name || null,
          at,
          percent: clampPercent(b.percent),
          resetsAt: b.resetsAt,
          windowMs: spec.windowMs,
          source,
        });
      }
    }
  } catch { /* 绝不影响正常请求 */ }
}
