// 订阅用量账本：纯函数窗口切分、请求匹配、花费计算与额度推算。
//
// 推算口径说明（estimate）：
// 1. 窗口汇总（requests / tokens / costUsd / unpricedRequests / rows）统计整个窗口 [start, min(end, now)]
//    （不含右边界 end，避免跨窗口边界重复计数）内所有匹配的账本请求。
// 2. 100% 额度等效美元（usdPer100）推算：
//    - 常规口径：Δ% = endPercent - startPercent，花费只计 [firstSnapshotAt, lastSnapshotAt] 之间的匹配请求，
//      避免把窗口开始到首次快照之前可能存在的未观测用量或外部用量混进分母。
//    - 首快照接近 0% 的补全口径：若首快照 startPercent ≤ 1% 且 [start, firstSnapshotAt) 之间已有本账本的匹配请求，
//      则视为从窗口起点 0% 起算，取 basisStart = start、basisEnd = lastSnapshotAt、basisPercent = endPercent。
//    - basisPercent < 5 个百分点时，样本增幅过小误差大，usdPer100 返回 null。
//    - 若检测到外部用量（external = true），estimate.reliable = false，但仍给出 usdPer100 供参考（前端标灰）。
import {
  costTotal,
  requestCost,
  type LedgerAccountKind,
  type LedgerBackend,
  type LedgerBreakdownRow,
  type LedgerEstimate,
  type LedgerSnapshotPoint,
  type LedgerTokens,
  type LedgerWindowDetail,
  type LedgerWindowKind,
  type LedgerWindowSummary,
  type PriceTable,
} from '@cosyee/shared';
import { FIVE_HOURS_MS, WEEK_MS, type LedgerRequest, type LedgerSnapshot } from './sink.js';

/** 同组快照 resetsAt 相差不超过 15 分钟视为同一额度窗口 */
export const RESETS_CLUSTER_MS = 15 * 60_000;
/** 外部用量判定：相邻快照百分比上涨阈值（百分点） */
export const EXTERNAL_JUMP_PERCENT = 2;
/** 外部用量判定：请求时间匹配容差（前后各 2 分钟） */
export const EXTERNAL_TOLERANCE_MS = 2 * 60_000;
/** 推算 usdPer100 所需的最小百分比增量（百分点） */
export const MIN_ESTIMATE_PERCENT = 5;
/** 首快照接近 0% 的阈值（百分点） */
const NEAR_ZERO_PERCENT = 1;

export interface WindowShell {
  id: string;
  backend: LedgerBackend;
  account: string;
  accountKind: LedgerAccountKind;
  kind: LedgerWindowKind;
  group: string | null;
  start: number;
  end: number;
  /** 窗口内（at ∈ [start, end)）按时间正序排列的原始快照（percent 已按 Kiro 口径归一化） */
  rawSnapshots: LedgerSnapshot[];
}

export function makeWindowId(
  backend: LedgerBackend,
  account: string,
  kind: LedgerWindowKind,
  group: string | null,
  end: number,
): string {
  return `${backend}|${account}|${kind}|${group ?? ''}|${end}`;
}

export function parseWindowId(id: string): {
  backend: LedgerBackend;
  account: string;
  kind: LedgerWindowKind;
  group: string | null;
  end: number;
} | null {
  const parts = id.split('|');
  if (parts.length !== 5) return null;
  const [backend, account, kind, rawGroup, rawEnd] = parts;
  if (backend !== 'claude' && backend !== 'codex' && backend !== 'agy') return null;
  if (!account) return null;
  if (kind !== 'session' && kind !== 'weekly' && kind !== 'scoped' && kind !== 'monthly') return null;
  if (!rawEnd || !/^\d+$/.test(rawEnd)) return null;
  const end = Number(rawEnd);
  if (!Number.isSafeInteger(end) || end <= 0) return null;
  return {
    backend,
    account,
    kind,
    group: rawGroup === '' ? null : rawGroup!,
    end,
  };
}

/** 按 UTC 往前推一个自然月（月末自动钳位到目标月最后一天，如 3/31 → 2/28 或 2/29） */
export function subtractOneCalendarMonth(ms: number): number {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const day = d.getUTCDate();
  // 目标月最后一天：下个月的第 0 天
  const lastDayOfPrevMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfPrevMonth);
  return Date.UTC(
    year,
    month - 1,
    clampedDay,
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** 判断请求模型是否命中窗口分组（group 为空时全部匹配；非空时按非字母数字切词，任一词出现在模型小写里即匹配） */
export function modelMatchesGroup(model: string | null, group: string | null): boolean {
  if (!group) return true;
  const words = group.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return true;
  if (!model) return false;
  const lower = model.toLowerCase();
  return words.some((w) => lower.includes(w));
}

function normalizedPercent(s: LedgerSnapshot): number {
  if (s.kind === 'monthly' && s.used != null && s.limit != null && Number.isFinite(s.used) && Number.isFinite(s.limit) && s.limit > 0) {
    return (s.used / s.limit) * 100;
  }
  return s.percent;
}

function defaultWindowStart(kind: LedgerWindowKind, end: number, windowMs: number | null): number {
  if (windowMs !== null && Number.isFinite(windowMs) && windowMs > 0) {
    return end - windowMs;
  }
  if (kind === 'monthly') {
    return subtractOneCalendarMonth(end);
  }
  if (kind === 'session') {
    return end - FIVE_HOURS_MS;
  }
  return end - WEEK_MS;
}

/**
 * 仅从快照切出窗口骨架（不含请求聚合）：
 * - 丢弃 resetsAt 为 null 的快照；
 * - 按 (backend, account, kind, group) 分组；
 * - 同组内 resetsAt 相差 ≤ 15 分钟聚为同一窗口，end 取该簇最新快照的 resetsAt。
 */
export function sliceWindowShells(snapshots: readonly LedgerSnapshot[]): WindowShell[] {
  const groups = new Map<string, LedgerSnapshot[]>();
  for (const s of snapshots) {
    if (s.resetsAt === null || !Number.isFinite(s.resetsAt)) continue;
    const key = `${s.backend}\0${s.account}\0${s.kind}\0${s.group ?? ''}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(s);
  }

  const shells: WindowShell[] = [];

  for (const list of groups.values()) {
    // 按 resetsAt 升序聚簇（同 resetsAt 按 at 升序）
    const sorted = [...list].sort((a, b) => a.resetsAt! - b.resetsAt! || a.at - b.at);
    const clusters: LedgerSnapshot[][] = [];
    for (const s of sorted) {
      const cur = clusters[clusters.length - 1];
      if (cur && s.resetsAt! - cur[0]!.resetsAt! <= RESETS_CLUSTER_MS) {
        cur.push(s);
      } else {
        clusters.push([s]);
      }
    }

    for (const cluster of clusters) {
      // 该簇中按 at 最新的快照决定 end / accountKind / windowMs
      const byAt = [...cluster].sort((a, b) => a.at - b.at);
      const latest = byAt[byAt.length - 1]!;
      const end = latest.resetsAt!;
      let windowMs: number | null = null;
      for (let i = byAt.length - 1; i >= 0; i--) {
        const w = byAt[i]!.windowMs;
        if (w !== null && Number.isFinite(w) && w > 0) {
          windowMs = w;
          break;
        }
      }
      const start = defaultWindowStart(latest.kind, end, windowMs);
      const rawSnapshots = byAt
        .filter((s) => s.at >= start && s.at < end)
        .map((s) => ({ ...s, percent: normalizedPercent(s) }));

      shells.push({
        id: makeWindowId(latest.backend, latest.account, latest.kind, latest.group, end),
        backend: latest.backend,
        account: latest.account,
        accountKind: latest.accountKind,
        kind: latest.kind,
        group: latest.group,
        start,
        end,
        rawSnapshots,
      });
    }
  }

  shells.sort((a, b) => b.end - a.end || b.start - a.start || a.id.localeCompare(b.id));
  return shells;
}

function emptyTokens(): LedgerTokens {
  return { input: 0, create5m: 0, create1h: 0, read: 0, output: 0, reasoning: 0 };
}

function addTokens(dst: LedgerTokens, r: LedgerRequest): void {
  dst.input += r.input;
  dst.create5m += r.create5m;
  dst.create1h += r.create1h;
  dst.read += r.read;
  dst.output += r.output;
  dst.reasoning += r.reasoning;
}

function calcRequestCost(table: PriceTable, r: LedgerRequest): number | null {
  const parts = requestCost(table, {
    model: r.model ?? undefined,
    input: r.input,
    create: r.create5m + r.create1h,
    create1h: r.create1h,
    read: r.read,
    output: r.output,
    fast: r.fast,
    usGeo: r.usGeo,
  });
  return parts ? costTotal(parts) : null;
}

/** 合并相邻同值快照（保留每段连续相同 percent 的第一个点） */
function mergeAdjacentSnapshots(raw: readonly LedgerSnapshot[]): LedgerSnapshotPoint[] {
  const out: LedgerSnapshotPoint[] = [];
  for (const s of raw) {
    if (out.length === 0 || out[out.length - 1]!.percent !== s.percent) {
      out.push({ at: s.at, percent: s.percent, source: s.source });
    }
  }
  return out;
}

function detectExternalUsage(raw: readonly LedgerSnapshot[], matchedAccountRequests: readonly LedgerRequest[]): boolean {
  for (let i = 1; i < raw.length; i++) {
    const prev = raw[i - 1]!;
    const curr = raw[i]!;
    if (curr.percent - prev.percent >= EXTERNAL_JUMP_PERCENT) {
      const lo = prev.at - EXTERNAL_TOLERANCE_MS;
      const hi = curr.at + EXTERNAL_TOLERANCE_MS;
      const hasReq = matchedAccountRequests.some((r) => r.at >= lo && r.at <= hi);
      if (!hasReq) return true;
    }
  }
  return false;
}

export interface BuildWindowOptions {
  prices: PriceTable;
  now: number;
  accountName: string | null;
}

/** 计算单个窗口的完整详情（含 rows 与 snapshots） */
export function buildWindowDetail(
  shell: WindowShell,
  requests: readonly LedgerRequest[],
  opts: BuildWindowOptions,
): LedgerWindowDetail {
  const { prices, now, accountName } = opts;
  const raw = shell.rawSnapshots;
  const mergedSnapshots = mergeAdjacentSnapshots(raw);

  const first = raw.length > 0 ? raw[0]! : null;
  const last = raw.length > 0 ? raw[raw.length - 1]! : null;
  const startPercent = first ? first.percent : null;
  const endPercent = last ? last.percent : null;
  const firstSnapshotAt = first ? first.at : null;
  const lastSnapshotAt = last ? last.at : null;

  const summaryEnd = Math.min(shell.end, now);

  // 同账号且满足分组条件的请求（含窗口边界前后容差，供 external 判定）
  const accountMatched: LedgerRequest[] = [];
  const windowRequests: Array<{ req: LedgerRequest; cost: number | null }> = [];
  const tokens = emptyTokens();
  let costUsd = 0;
  let unpricedRequests = 0;

  const breakdownMap = new Map<string, LedgerBreakdownRow>();

  for (const r of requests) {
    if (r.backend !== shell.backend || r.account !== shell.account) continue;
    if (!modelMatchesGroup(r.model, shell.group)) continue;
    accountMatched.push(r);

    // 汇总范围：[start, min(end, now)] 且严格 < end（防止跨窗口边界重复计数）
    if (r.at < shell.start || r.at > summaryEnd || r.at >= shell.end) continue;

    const cost = calcRequestCost(prices, r);
    windowRequests.push({ req: r, cost });
    addTokens(tokens, r);
    if (cost === null) {
      unpricedRequests++;
    } else {
      costUsd += cost;
    }

    const rowKey = `${r.model ?? ''}\0${r.layer}\0${r.agent ?? ''}`;
    let row = breakdownMap.get(rowKey);
    if (!row) {
      row = {
        model: r.model,
        layer: r.layer,
        agent: r.agent,
        requests: 0,
        tokens: emptyTokens(),
        costUsd: 0,
        unpricedRequests: 0,
        estimated: false,
      };
      breakdownMap.set(rowKey, row);
    }
    row.requests++;
    addTokens(row.tokens, r);
    if (cost === null) row.unpricedRequests++;
    else row.costUsd += cost;
    if (r.estimated) row.estimated = true;
  }

  const external = detectExternalUsage(raw, accountMatched);

  // 推算 100% 额度等效美元
  let basisPercent = 0;
  let basisCost = 0;
  if (first && last) {
    const hasEarlierReq =
      first.percent <= NEAR_ZERO_PERCENT &&
      windowRequests.some(({ req }) => req.at >= shell.start && req.at < first.at);

    const basisStart = hasEarlierReq ? shell.start : first.at;
    const basisEnd = last.at;
    basisPercent = Math.max(0, hasEarlierReq ? last.percent : last.percent - first.percent);

    for (const { req, cost } of windowRequests) {
      if (req.at >= basisStart && req.at <= basisEnd && cost !== null) {
        basisCost += cost;
      }
    }
  }

  const usdPer100 = basisPercent >= MIN_ESTIMATE_PERCENT ? (basisCost / basisPercent) * 100 : null;
  const estimate: LedgerEstimate = {
    usdPer100,
    basisPercent,
    basisCost,
    reliable: !external,
  };

  const rows = [...breakdownMap.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.requests - a.requests || (a.model ?? '').localeCompare(b.model ?? ''),
  );

  const summary: LedgerWindowSummary = {
    id: shell.id,
    backend: shell.backend,
    account: shell.account,
    accountName,
    accountKind: shell.accountKind,
    kind: shell.kind,
    group: shell.group,
    start: shell.start,
    end: shell.end,
    current: now >= shell.start && now < shell.end,
    startPercent,
    endPercent,
    firstSnapshotAt,
    lastSnapshotAt,
    ...(shell.kind === 'monthly'
      ? {
          used: last?.used ?? null,
          limit: last?.limit ?? null,
        }
      : {}),
    requests: windowRequests.length,
    tokens,
    costUsd,
    unpricedRequests,
    estimate,
    external,
  };

  return {
    ...summary,
    rows,
    snapshots: mergedSnapshots,
  };
}

/** 去掉 detail 的 rows / snapshots，返回列表项摘要 */
export function toWindowSummary(detail: LedgerWindowDetail): LedgerWindowSummary {
  const { rows: _rows, snapshots: _snapshots, ...summary } = detail;
  return summary;
}

/** 一步从快照 + 请求构建窗口摘要列表（按 end 倒序），适合纯函数调用与单元测试 */
export function computeWindows(
  snapshots: readonly LedgerSnapshot[],
  requests: readonly LedgerRequest[],
  opts: {
    prices: PriceTable;
    now: number;
    accountName?: (backend: LedgerBackend, account: string) => string | null;
  },
): LedgerWindowDetail[] {
  const shells = sliceWindowShells(snapshots);
  return shells.map((shell) =>
    buildWindowDetail(shell, requests, {
      prices: opts.prices,
      now: opts.now,
      accountName: opts.accountName ? opts.accountName(shell.backend, shell.account) : null,
    }),
  );
}
