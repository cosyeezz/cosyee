// 统一用量统计计算层（主会话与子代理共用）：
// 复用 sessionCost 与 inputOf，提供占用分段、走势、缓存命中率、花费、按请求柱状数据及子代理窗口推算。
import { useMemo } from 'react';
import {
  ZERO_COST, contextWindowOf, modelKey, requestCost,
  type AccountEntry, type ApiModelMap, type CachePoint, type CliModelCost, type PriceTable,
  type SubagentAccountOption, type SubagentConfig, type SubagentCost, type SubagentRun, type Turn, type UsageTrack,
} from '@cosyee/shared';
import { inputOf } from './contextGrowth';
import { sessionCost, type SessionCost, type TurnCost } from './cost';

export interface OccupancySegment {
  key: string;
  label: string;
  tokens: number;
  color: string;
}

export interface OccupancyStats {
  /** 已用 token（有 breakdown 用 breakdown.usedTokens，否则取最后一次请求的 input + create + read） */
  used: number;
  /** 模型上下文窗口（token）；未知为 null */
  window: number | null;
  /** 占用百分比 0–100；窗口未知或无数据时为 null */
  percent: number | null;
  /** 分段条数据（已过滤掉 tokens <= 0 的项） */
  segments: OccupancySegment[];
  /** 是否来自 /context 分类明细（false 表示按缓存三段：读缓存 / 未缓存 / 写缓存） */
  hasBreakdown: boolean;
}

export interface UsageStatsOptions {
  pricing: PriceTable;
  fallbackModel?: string;
  turns?: readonly Turn[];
  subs?: readonly SubagentCost[] | null;
  mode?: 'session' | 'subagent';
  historyTokens?: number | null;
  subagents?: SubagentConfig | null;
  subagentAccounts?: readonly SubagentAccountOption[];
  accounts?: readonly AccountEntry[];
}

export interface UsageStats {
  occupancy: OccupancyStats;
  trend: CachePoint[];
  hitRate: {
    now: number | null;
    avg: number | null;
  };
  cost: SessionCost;
  perRequest: boolean;
}

/** 分类名 → 颜色变量（与 ContextPanel.css 对齐） */
export function categoryColor(name: string): string {
  const k = name.trim().toLowerCase();
  if (k.includes('free')) return 'var(--cz-ctx-free)';
  if (k.includes('autocompact') || k.includes('buffer')) return 'var(--cz-ctx-buffer)';
  if (k.includes('mcp') && k.includes('instruction')) return 'var(--cz-ctx-mcp-instr)';
  if (k.includes('mcp')) return 'var(--cz-ctx-mcp-tools)';
  if (k.includes('system tools')) return 'var(--cz-ctx-sys-tools)';
  if (k.includes('system prompt')) return 'var(--cz-ctx-sys-prompt)';
  if (k.includes('message')) return 'var(--cz-ctx-messages)';
  if (k.includes('skill')) return 'var(--cz-ctx-skills)';
  if (k.includes('agent')) return 'var(--cz-ctx-agents)';
  return 'var(--cz-ctx-other)';
}

/** 缓存三段颜色（读缓存 / 未缓存 / 写缓存），与 CostSection 视觉一致 */
export const CACHE_SEGMENT_COLORS = {
  read: 'var(--cz-ctx-messages)',
  input: 'var(--cz-ctx-other)',
  create: 'var(--cz-ctx-sys-prompt)',
} as const;

/** 纯函数：计算统一的四块统计数据 */
export function computeUsageStats(track: UsageTrack, opts: UsageStatsOptions): UsageStats {
  const points = track.points;
  const perRequest = opts.mode === 'subagent';

  let occupancy: OccupancyStats;
  if (track.breakdown) {
    const bd = track.breakdown;
    const window = bd.totalTokens > 0 ? bd.totalTokens : (track.window && track.window > 0 ? track.window : null);
    occupancy = {
      used: bd.usedTokens,
      window,
      percent: bd.percent,
      segments: bd.categories
        .filter((c) => c.tokens > 0)
        .map((c) => ({ key: c.name, label: c.name, tokens: c.tokens, color: categoryColor(c.name) })),
      hasBreakdown: true,
    };
  } else {
    const last = points[points.length - 1];
    const used = last ? inputOf(last) : 0;
    const window = track.window != null && Number.isFinite(track.window) && track.window > 0 ? track.window : null;
    const percent = last && window !== null ? (used / window) * 100 : null;
    const segments: OccupancySegment[] = [];
    if (last) {
      if (last.read > 0) segments.push({ key: 'read', label: '读缓存', tokens: last.read, color: CACHE_SEGMENT_COLORS.read });
      if (last.input > 0) segments.push({ key: 'input', label: '未缓存', tokens: last.input, color: CACHE_SEGMENT_COLORS.input });
      if (last.create > 0) segments.push({ key: 'create', label: '写缓存', tokens: last.create, color: CACHE_SEGMENT_COLORS.create });
    }
    occupancy = { used, window, percent, segments, hasBreakdown: false };
  }

  let totalRead = 0;
  let totalIn = 0;
  for (const p of points) {
    totalRead += p.read;
    totalIn += inputOf(p);
  }
  const hitRate = {
    now: points.length > 0 ? points[points.length - 1]!.rate : null,
    avg: totalIn > 0 ? (totalRead / totalIn) * 100 : null,
  };

  const rawCost = sessionCost({
    points,
    turns: opts.turns,
    compactions: track.compactions,
    subs: opts.subs,
    table: opts.pricing,
    fallbackModel: opts.fallbackModel,
    historyTokens: opts.historyTokens ?? null,
    subagents: opts.subagents,
    subagentAccounts: opts.subagentAccounts,
    accounts: opts.accounts,
    billing: track.billing,
  });
  // 子代理不显示「下一次请求预估」
  const cost: SessionCost = perRequest ? { ...rawCost, next: null } : rawCost;

  return { occupancy, trend: points, hitRate, cost, perRequest };
}

/** Hook 包装：缓存计算结果 */
export function useUsageStats(track: UsageTrack, opts: UsageStatsOptions): UsageStats {
  const { pricing, fallbackModel, turns, subs, mode, historyTokens, subagents, subagentAccounts, accounts } = opts;
  return useMemo(
    () => computeUsageStats(track, { pricing, fallbackModel, turns, subs, mode, historyTokens, subagents, subagentAccounts, accounts }),
    [track, pricing, fallbackModel, turns, subs, mode, historyTokens, subagents, subagentAccounts, accounts],
  );
}

/** 单轮（子代理）按请求映射成 CostChart 可用的 TurnCost[]（每次请求一根柱） */
export function requestCostRows(
  points: readonly CachePoint[],
  table: PriceTable,
  fallbackModel?: string,
): { rows: TurnCost[]; estimated: boolean[] } {
  const rows: TurnCost[] = [];
  const estimated: boolean[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const c = requestCost(table, {
      model: p.model ?? fallbackModel,
      input: p.input,
      create: p.create,
      create1h: p.create1h,
      read: p.read,
      output: p.output ?? 0,
      fast: p.fast,
      usGeo: p.usGeo,
    });
    rows.push({
      turn: i,
      main: c ?? ZERO_COST,
      sub: ZERO_COST,
      requests: c ? 1 : 0,
      subRuns: 0,
    });
    estimated.push(p.estimated === true);
  }
  return { rows, estimated };
}

/** 从模型映射判断指定模型是否开启了 1M 上下文 */
function isModelM1(model: string | undefined, modelMap?: ApiModelMap | null): boolean {
  if (!model) return false;
  if (/\[1m\]$/i.test(model.trim())) return true;
  if (!modelMap) return false;
  const low = model.trim().toLowerCase();
  if (modelMap.alias) {
    for (const [alias, target] of Object.entries(modelMap.alias)) {
      if (!target) continue;
      if (alias.toLowerCase() === low || target.id.toLowerCase() === low) {
        if (target.m1) return true;
      }
    }
  }
  if (modelMap.extra) {
    for (const target of modelMap.extra) {
      if (target.id.toLowerCase() === low && target.m1) return true;
    }
  }
  return false;
}

/**
 * 子代理上下文窗口选择器：
 * 优先级：run.contextWindow → 本会话 CLI modelUsage 里该模型的 contextWindow → contextWindowOf(model, { m1 })。
 */
export function resolveSubagentContextWindow(opts: {
  run: Pick<SubagentRun, 'contextWindow' | 'model' | 'cache'>;
  cliCost?: readonly CliModelCost[];
  modelMap?: ApiModelMap | null;
  fallbackModel?: string;
}): number | null {
  const { run, cliCost, modelMap, fallbackModel } = opts;
  if (typeof run.contextWindow === 'number' && Number.isFinite(run.contextWindow) && run.contextWindow > 0) {
    return run.contextWindow;
  }
  const lastModel = run.cache?.length ? run.cache[run.cache.length - 1]!.model : undefined;
  const model = lastModel ?? run.model ?? fallbackModel;
  if (model && cliCost?.length) {
    const exact = cliCost.find((c) => c.model === model && typeof c.contextWindow === 'number' && c.contextWindow > 0);
    if (exact?.contextWindow) return exact.contextWindow;
    const key = modelKey(model);
    if (key) {
      const byKey = cliCost.find((c) => modelKey(c.model) === key && typeof c.contextWindow === 'number' && c.contextWindow > 0);
      if (byKey?.contextWindow) return byKey.contextWindow;
    }
  }
  return contextWindowOf(model, { m1: isModelM1(model, modelMap) });
}
