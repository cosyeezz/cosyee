// 会话花费：主线程每次请求（SessionMeta.cache 的点）按价格表算，子代理的由服务端算好（SubagentCost）后按轮归入。
// 纯函数，面板与测试共用。金额单位：美元。
import {
  ZERO_COST, addCost, costTotal, effectivePrices, findPrice, requestCost, uncachedCost,
  type CachePoint, type CompactMark, type CostParts, type PriceTable, type SubagentCost, type Turn,
} from '@cosyee/shared';

export interface TurnCost {
  /** 第几轮（= turns 的下标，同 CachePoint.turn） */
  turn: number;
  /** 主线程的花费 */
  main: CostParts;
  /** 本轮派出的子代理的花费 */
  sub: CostParts;
  /** 主线程请求数（能定价的） */
  requests: number;
  /** 本轮有花费记录的子代理个数 */
  subRuns: number;
}

/** 下一次请求的预估：整段上下文都要再送一遍 */
export interface NextEstimate {
  /** 下一次请求的输入大小（token） */
  prompt: number;
  /** 缓存还热（命中缓存）时约多少钱 */
  warm: number;
  /** 缓存过期（全部重新写入缓存）时约多少钱 */
  cold: number;
  /** 其中消息历史（压缩能省掉的大头）按命中缓存算约多少钱；不知道消息历史有多大时为 null */
  history: number | null;
}

export interface SessionCost {
  /** 合计（主线程 + 子代理） */
  total: number;
  parts: CostParts;
  main: number;
  sub: number;
  /** 不用缓存（所有输入按未命中价）要花多少：只算能定价的请求 */
  uncached: number;
  /** 缓存省下的钱 = uncached − total（不会小于 0） */
  saved: number;
  /** 能定价的请求数（主线程 + 子代理） */
  requests: number;
  /** 模型不在价格表里、没算进来的请求数 */
  unpriced: number;
  /** 没算进来的模型（原样 id） */
  unpricedModels: string[];
  /** 每轮的花费，下标 = 第几轮；没有请求的轮也占一格 */
  turns: TurnCost[];
  /** 找不到所属轮的子代理（如压缩时的摘要代理）的花费 */
  other: CostParts;
  next: NextEstimate | null;
}

export interface CostInput {
  points: readonly CachePoint[] | undefined;
  /** 服务端算好的子代理花费；还没取到为 null / undefined */
  subs?: readonly SubagentCost[] | null;
  turns?: readonly Turn[];
  compactions?: readonly CompactMark[];
  table: PriceTable;
  /** 点里没有模型时用的模型（会话的模型） */
  fallbackModel?: string;
  /** 当前上下文里消息历史的 token（/context 的 Messages 分类）；不知道为 null */
  historyTokens?: number | null;
}

const M = 1_000_000;

const usageOf = (p: CachePoint, fallbackModel?: string) => ({
  model: p.model ?? fallbackModel,
  input: p.input,
  create: p.create,
  create1h: p.create1h,
  read: p.read,
  output: p.output ?? 0,
  fast: p.fast,
  usGeo: p.usGeo,
});

const emptyTurn = (turn: number): TurnCost => ({ turn, main: ZERO_COST, sub: ZERO_COST, requests: 0, subRuns: 0 });

export function sessionCost(inp: CostInput): SessionCost {
  const points = inp.points ?? [];
  const turnList = inp.turns ?? [];
  let parts: CostParts = ZERO_COST;
  let main = 0;
  let sub = 0;
  let uncached = 0;
  let requests = 0;
  let unpriced = 0;
  const unpricedModels = new Set<string>();
  const maxTurn = Math.max(turnList.length - 1, ...points.map((p) => p.turn));
  const turns: TurnCost[] = Array.from({ length: Math.max(0, maxTurn + 1) }, (_, i) => emptyTurn(i));

  for (const p of points) {
    const u = usageOf(p, inp.fallbackModel);
    const c = requestCost(inp.table, u);
    if (!c) {
      unpriced++;
      unpricedModels.add(u.model ?? '未知模型');
      continue;
    }
    requests++;
    parts = addCost(parts, c);
    main += costTotal(c);
    uncached += uncachedCost(inp.table, u) ?? 0;
    const t = turns[p.turn];
    if (t) {
      t.main = addCost(t.main, c);
      t.requests++;
    }
  }

  // 子代理 → 所属轮：先按 Agent 调用的 tool_use id，再按 agent id（= SubagentRun.taskId）
  const byTool = new Map<string, number>();
  const byTask = new Map<string, number>();
  turnList.forEach((t, i) => {
    for (const r of t.subagents) {
      byTool.set(r.toolUseId, i);
      if (r.taskId) byTask.set(r.taskId, i);
    }
  });
  let other: CostParts = ZERO_COST;
  for (const s of inp.subs ?? []) {
    unpriced += s.unpriced;
    if (s.unpriced > 0) for (const m of s.models) if (!findPrice(inp.table, m)) unpricedModels.add(m);
    const priced = s.requests - s.unpriced;
    if (priced <= 0) continue;
    requests += priced;
    parts = addCost(parts, s.cost);
    sub += costTotal(s.cost);
    uncached += s.uncached;
    const at = (s.toolUseId !== null ? byTool.get(s.toolUseId) : undefined) ?? byTask.get(s.agentId);
    const t = at !== undefined ? turns[at] : undefined;
    if (t) {
      t.sub = addCost(t.sub, s.cost);
      t.subRuns++;
    } else {
      other = addCost(other, s.cost);
    }
  }

  const total = main + sub;
  return {
    total,
    parts,
    main,
    sub,
    uncached,
    saved: Math.max(0, uncached - total),
    requests,
    unpriced,
    unpricedModels: [...unpricedModels],
    turns,
    other,
    next: nextEstimate(points, inp),
  };
}

/**
 * 下一次请求的预估：最后一次请求的输入 + 它的输出（会成为下一次的输入）；
 * 最后一次请求之后压缩过，就按压缩后的大小。用最后一次请求的模型和计费方式（fast / 美国境内）。
 */
function nextEstimate(points: readonly CachePoint[], inp: CostInput): NextEstimate | null {
  const last = points[points.length - 1];
  if (!last) return null;
  const mp = findPrice(inp.table, last.model ?? inp.fallbackModel);
  if (!mp) return null;
  const mark = inp.compactions?.[inp.compactions.length - 1];
  const compacted = mark && mark.after === last.id && mark.post !== null ? mark.post : null;
  const prompt = compacted ?? last.input + last.create + last.read + (last.output ?? 0);
  if (prompt <= 0) return null;
  // 长上下文价按整次请求的输入判断：把 prompt 当作输入传进去
  const t = effectivePrices(mp, { input: prompt, create: 0, read: 0, fast: last.fast, usGeo: last.usGeo });
  const history = inp.historyTokens != null && inp.historyTokens >= 0 ? (Math.min(inp.historyTokens, prompt) * t.read) / M : null;
  return {
    prompt,
    warm: (prompt * t.read) / M,
    cold: (prompt * (last.create1h ? t.write1h : t.write5m)) / M,
    history,
  };
}

/** 金额显示：$12.34；不到 1 美分保留到 0.1 美分；更小的写「<$0.001」；上千用千分位 */
export function formatUsd(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return '$0';
  if (v < 0.001) return '<$0.001';
  if (v < 0.01) return `$${v.toFixed(3)}`;
  if (v < 1000) return `$${v.toFixed(2)}`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

/** 花费的四个类别（分段条与明细共用；顺序 = 条里从左到右） */
export const COST_KINDS: { key: keyof CostParts; label: string; hint: string }[] = [
  { key: 'read', label: '读缓存', hint: '命中缓存的输入（最便宜）' },
  { key: 'write', label: '写缓存', hint: '写入缓存的输入（比普通输入贵）' },
  { key: 'output', label: '输出', hint: '模型生成的文字、思考与工具调用' },
  { key: 'input', label: '未缓存输入', hint: '没命中也没写入缓存的输入' },
];
