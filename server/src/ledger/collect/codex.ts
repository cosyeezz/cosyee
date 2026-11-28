// Codex 额度快照采集：将 account/rateLimits/updated（及探测结果）解析出的 CodexQuota 写入账本。
import type { CodexQuota, CodexQuotaWindow, LedgerAccountKind, LedgerWindowKind } from '@cosyee/shared';
import { FIVE_HOURS_MS, WEEK_MS, ledger } from '../sink.js';
import { clampPercent } from './common.js';

function classifyCodexWindow(
  w: CodexQuotaWindow,
  slot: 'primary' | 'secondary',
): { kind: LedgerWindowKind; windowMs: number } {
  const mins = w.windowMins;
  if (typeof mins === 'number' && Number.isFinite(mins) && mins > 0) {
    const kind: LedgerWindowKind = mins <= 300 ? 'session' : mins >= 10080 ? 'weekly' : slot === 'primary' ? 'session' : 'weekly';
    return { kind, windowMs: Math.round(mins * 60_000) };
  }
  return slot === 'primary'
    ? { kind: 'session', windowMs: FIVE_HOURS_MS }
    : { kind: 'weekly', windowMs: WEEK_MS };
}

/**
 * 将 Codex 限额快照写入账本。API Key 账号无订阅额度窗口，直接跳过。
 * 内部 try/catch，永不抛错。
 */
export function recordCodexRateLimits(
  accountId: string,
  accountKind: LedgerAccountKind,
  quota: CodexQuota | null | undefined,
  source: 'event' | 'probe' = 'event',
): void {
  try {
    if (!quota || accountKind !== 'subscription') return;
    const at = typeof quota.fetchedAt === 'number' && Number.isFinite(quota.fetchedAt) ? quota.fetchedAt : Date.now();
    for (const g of quota.groups) {
      // 主组 'codex' 的 group 记为 null；若有其它子组则保留组名
      const group = g.limitId === 'codex' ? null : (g.limitName || g.limitId || null);
      const slots: Array<['primary' | 'secondary', CodexQuotaWindow | null]> = [
        ['primary', g.primary],
        ['secondary', g.secondary],
      ];
      for (const [slot, w] of slots) {
        if (!w) continue;
        const { kind, windowMs } = classifyCodexWindow(w, slot);
        ledger.snapshot({
          backend: 'codex',
          account: accountId,
          accountKind,
          kind,
          group,
          at,
          percent: clampPercent(w.usedPercent),
          resetsAt: w.resetsAt,
          windowMs,
          source,
        });
      }
    }
  } catch { /* 绝不影响正常请求 */ }
}
