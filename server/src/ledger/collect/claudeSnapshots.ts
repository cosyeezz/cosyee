// Claude 订阅额度快照采集：
// 1. CLI stdout 的 rate_limit_event（主会话与 Claude 委派进程都会推送）；
// 2. control_request get_usage 返回的 UsageInfo（空闲探测与 /api/usage 调用）。
import type { LedgerAccountKind, LedgerWindowKind, UsageInfo } from '@cosyee/shared';
import { FIVE_HOURS_MS, WEEK_MS, ledger } from '../sink.js';
import { clampPercent, isObj, str, toEpochMs, utilizationToPercent } from './common.js';

interface WindowSpec {
  kind: LedgerWindowKind;
  group: string | null;
  windowMs: number;
}

/** 将 rate_limit_event 的窗口键（five_hour / seven_day / seven_day_opus / seven_day_sonnet ...）映射到账本窗口类型 */
function classifyClaudeWindowKey(rawKey: string): WindowSpec | null {
  const key = rawKey.trim().toLowerCase();
  if (!key) return null;
  if (key === 'five_hour' || key === '5h' || key === 'session') {
    return { kind: 'session', group: null, windowMs: FIVE_HOURS_MS };
  }
  if (key === 'seven_day' || key === '7d' || key === 'weekly' || key === 'weekly_all') {
    return { kind: 'weekly', group: null, windowMs: WEEK_MS };
  }
  const m = /^seven_day_(.+)$/.exec(key);
  if (m && m[1]) {
    // 排除非按模型的特殊配额桶（如 oauth_apps / overage）
    if (m[1] === 'oauth_apps' || m[1] === 'overage') return null;
    return { kind: 'scoped', group: m[1], windowMs: WEEK_MS };
  }
  return null;
}

/**
 * 解析并记录 Claude CLI 的 rate_limit_event。
 * 仅对订阅账号生效（API / Kiro 账号无 Claude 订阅额度窗口）。内部 try/catch，永不抛错。
 */
export function recordClaudeRateLimitEvent(
  ev: unknown,
  account: string,
  accountKind: LedgerAccountKind,
  at: number = Date.now(),
): void {
  try {
    if (accountKind !== 'subscription') return;
    if (!isObj(ev) || ev.type !== 'rate_limit_event') return;
    const info = ev.rate_limit_info;
    if (!isObj(info)) return;

    const unified = info.unifiedWindows;
    if (isObj(unified)) {
      let wrote = false;
      for (const [k, rawWin] of Object.entries(unified)) {
        if (!isObj(rawWin)) continue;
        const spec = classifyClaudeWindowKey(k);
        if (!spec) continue;
        const percent = utilizationToPercent(rawWin.utilization);
        if (percent === null) continue;
        const resetsAt = toEpochMs(rawWin.resetsAt ?? rawWin.resets_at);
        ledger.snapshot({
          backend: 'claude',
          account,
          accountKind,
          kind: spec.kind,
          group: spec.group,
          at,
          percent,
          resetsAt,
          windowMs: spec.windowMs,
          source: 'event',
        });
        wrote = true;
      }
      if (wrote) return;
    }

    // 兼容单窗口形态：rate_limit_info 顶层带 rateLimitType / utilization / resetsAt
    const topType = str(info.rateLimitType ?? info.rate_limit_type);
    const spec = classifyClaudeWindowKey(topType);
    const percent = utilizationToPercent(info.utilization);
    if (spec && percent !== null) {
      ledger.snapshot({
        backend: 'claude',
        account,
        accountKind,
        kind: spec.kind,
        group: spec.group,
        at,
        percent,
        resetsAt: toEpochMs(info.resetsAt ?? info.resets_at),
        windowMs: spec.windowMs,
        source: 'event',
      });
    }
  } catch { /* 绝不影响正常请求 */ }
}

/**
 * 将 get_usage（parseUsage）返回的 UsageInfo 写入账本快照。
 * 仅对订阅账号生效。内部 try/catch，永不抛错。
 */
export function recordClaudeUsageSnapshot(
  info: UsageInfo | null | undefined,
  account: string,
  accountKind: LedgerAccountKind,
  source: 'event' | 'probe' = 'probe',
): void {
  try {
    if (!info || accountKind !== 'subscription') return;
    const at = typeof info.at === 'number' && Number.isFinite(info.at) ? info.at : Date.now();
    for (const lim of info.limits) {
      if (lim.kind === 'session') {
        ledger.snapshot({
          backend: 'claude',
          account,
          accountKind,
          kind: 'session',
          group: null,
          at,
          percent: clampPercent(lim.percent),
          resetsAt: lim.resetsAt,
          windowMs: FIVE_HOURS_MS,
          source,
        });
      } else if (lim.kind === 'weekly') {
        ledger.snapshot({
          backend: 'claude',
          account,
          accountKind,
          kind: 'weekly',
          group: null,
          at,
          percent: clampPercent(lim.percent),
          resetsAt: lim.resetsAt,
          windowMs: WEEK_MS,
          source,
        });
      } else if (lim.kind === 'scoped') {
        const group = (lim.model ?? '').trim().toLowerCase();
        if (!group) continue;
        ledger.snapshot({
          backend: 'claude',
          account,
          accountKind,
          kind: 'scoped',
          group,
          at,
          percent: clampPercent(lim.percent),
          resetsAt: lim.resetsAt,
          windowMs: WEEK_MS,
          source,
        });
      }
    }
  } catch { /* 绝不影响正常请求 */ }
}
