// 会话花费：主线程每次请求（SessionMeta.cache 的点）按价格表算，
// 子代理优先取服务端算好的 SubagentCost，运行中或尚未落盘的用 run.cache 实时补齐（按 toolUseId 去重）。
// 纯函数，面板与测试共用。金额单位：美元。
import {
  ZERO_COST, addCost, costTotal, effectivePrices, findPrice, requestCost, uncachedCost,
  type AccountEntry, type CachePoint, type CompactMark, type CostParts, type PriceTable,
  type SubagentAccountOption, type SubagentConfig, type SubagentCost, type SubagentRun, type Turn, type UsageBilling,
} from '@cosyee/shared';

export type CostSource = 'main' | 'native' | 'claude' | 'codex' | 'agy';
export type SubagentCostSource = Exclude<CostSource, 'main'>;

/** 单个子代理运行的花费摘要（用于点击打开浮层） */
export interface SubagentRunCostItem {
  toolUseId: string | null;
  turnId?: string;
  title: string;
  agentType: string;
  source: SubagentCostSource;
  cost: number;
}

/** 按（来源 + 子代理类型）聚合的花费明细 */
export interface SubagentTypeCost {
  agentType: string;
  source: SubagentCostSource;
  count: number;
  cost: number;
  toolUseIds: string[];
  runs: SubagentRunCostItem[];
}

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
  /** 按来源拆分的花费合计 */
  bySource: Record<CostSource, number>;
  /** 按子代理类型（含来源归属）聚合的明细，按金额降序 */
  byType: SubagentTypeCost[];
  /** 有花费且按订阅计费（等价 API 价）的来源列表 */
  subscriptionSources: CostSource[];
  /** 是否同时包含订阅计费与 API/第三方计费的有花费来源 */
  mixedBilling: boolean;
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
  /** 子代理配置：用于推断实时委派 run 的后端来源与计费方式 */
  subagents?: SubagentConfig | null;
  /** 委派可选账号列表（用于判断 Claude 委派账号是否为 API） */
  subagentAccounts?: readonly SubagentAccountOption[];
  /** 主会话账号列表（用于判断 Claude 委派账号的计费方式） */
  accounts?: readonly AccountEntry[];
  /** 主会话计费方式（用于判断是否混合计费以及哪些来源标「等价」） */
  billing?: UsageBilling;
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

const emptyBySource = (): Record<CostSource, number> => ({ main: 0, native: 0, claude: 0, codex: 0, agy: 0 });

/** 推断一个 SubagentRun 的来源后端 */
function inferRunSource(run: SubagentRun, cfg?: SubagentConfig | null): SubagentCostSource {
  if (run.delegate !== true) return 'native';
  const route = (run.subagentType ? cfg?.delegate.agents?.[run.subagentType] : undefined) ?? cfg?.delegate.default;
  if (route) return route.backend;
  const m = (run.cache?.length ? run.cache[run.cache.length - 1]!.model : undefined) ?? run.model ?? '';
  if (/gemini/i.test(m)) return 'agy';
  if (/gpt|codex|^o[34]/i.test(m)) return 'codex';
  return 'claude';
}

function accountBilling(acc: AccountEntry | undefined): UsageBilling {
  if (!acc?.api) return 'subscription';
  const base = acc.api.baseUrl.trim();
  return !base || /^https?:\/\/api\.anthropic\.com(\/|$)/i.test(base) ? 'api' : 'thirdParty';
}

/** 判断某子代理来源是否按订阅计费 */
function isSubSourceSubscription(
  src: SubagentCostSource,
  agentType: string | undefined,
  inp: Pick<CostInput, 'billing' | 'subagents' | 'accounts' | 'subagentAccounts'>,
): boolean {
  if (src === 'agy' || src === 'codex') return true;
  if (src === 'native') return inp.billing === 'subscription';
  // claude 委派：查对应路线或默认路线
  const route =
    (agentType ? inp.subagents?.delegate.agents?.[agentType] : undefined) ??
    inp.subagents?.delegate.default;
  if (route && route.backend === 'claude') {
    const acc = inp.accounts?.find((a) => a.id === route.accountId);
    if (acc) return accountBilling(acc) === 'subscription';
    const opt = inp.subagentAccounts?.find((a) => a.backend === 'claude' && a.id === route.accountId);
    if (opt) return opt.group !== 'api';
  }
  return inp.billing === 'subscription';
}

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
  const bySource = emptyBySource();
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
    const v = costTotal(c);
    main += v;
    uncached += uncachedCost(inp.table, u) ?? 0;
    const t = turns[p.turn];
    if (t) {
      t.main = addCost(t.main, c);
      t.requests++;
    }
  }
  bySource.main = main;

  // 子代理 → 所属轮（同一 toolUseId 跨轮复制时以最新一轮为准，其 cache 最全）
  interface RunLoc {
    turnIdx: number;
    turnId: string;
    run: SubagentRun;
  }
  const byTool = new Map<string, RunLoc>();
  const byTask = new Map<string, RunLoc>();
  turnList.forEach((t, i) => {
    for (const r of t.subagents) {
      const loc: RunLoc = { turnIdx: i, turnId: t.id, run: r };
      byTool.set(r.toolUseId, loc);
      if (r.taskId) byTask.set(r.taskId, loc);
    }
  });

  const typeMap = new Map<string, SubagentTypeCost>();
  const subBillBySource: Partial<Record<SubagentCostSource, { sub: boolean; nonSub: boolean }>> = {};

  const recordType = (item: SubagentRunCostItem) => {
    const k = `${item.source}:${item.agentType}`;
    let g = typeMap.get(k);
    if (!g) {
      g = { agentType: item.agentType, source: item.source, count: 0, cost: 0, toolUseIds: [], runs: [] };
      typeMap.set(k, g);
    }
    g.count++;
    g.cost += item.cost;
    if (item.toolUseId && !g.toolUseIds.includes(item.toolUseId)) g.toolUseIds.push(item.toolUseId);
    g.runs.push(item);

    const isSub = isSubSourceSubscription(item.source, item.agentType, inp);
    const flag = (subBillBySource[item.source] ??= { sub: false, nonSub: false });
    if (isSub) flag.sub = true;
    else flag.nonSub = true;
  };

  let other: CostParts = ZERO_COST;
  const seenToolIds = new Set<string>();
  const seenTaskIds = new Set<string>();

  // 1) 服务端已落盘的子代理花费（含原生与委派）
  for (const s of inp.subs ?? []) {
    if (s.toolUseId) seenToolIds.add(s.toolUseId);
    if (s.agentId) seenTaskIds.add(s.agentId);
    unpriced += s.unpriced;
    if (s.unpriced > 0) for (const m of s.models) if (!findPrice(inp.table, m)) unpricedModels.add(m);
    const priced = s.requests - s.unpriced;
    if (priced <= 0) continue;
    requests += priced;
    parts = addCost(parts, s.cost);
    const sc = costTotal(s.cost);
    sub += sc;
    uncached += s.uncached;
    const hit = (s.toolUseId !== null ? byTool.get(s.toolUseId) : undefined) ?? byTask.get(s.agentId);
    const src: SubagentCostSource = s.source ?? (hit ? inferRunSource(hit.run, inp.subagents) : 'native');
    bySource[src] += sc;
    const t = hit !== undefined ? turns[hit.turnIdx] : undefined;
    if (t) {
      t.sub = addCost(t.sub, s.cost);
      t.subRuns++;
    } else {
      other = addCost(other, s.cost);
    }
    const agentType = s.agentType || hit?.run.subagentType || '其它';
    recordType({
      toolUseId: s.toolUseId ?? hit?.run.toolUseId ?? null,
      turnId: hit?.turnId,
      title: hit?.run.title || agentType,
      agentType,
      source: src,
      cost: sc,
    });
  }

  // 2) 运行中或 subCosts 尚未覆盖的子代理：用实时 run.cache 补算，按 toolUseId 去重
  for (const [toolUseId, loc] of byTool) {
    if (seenToolIds.has(toolUseId)) continue;
    if (loc.run.taskId && seenTaskIds.has(loc.run.taskId)) continue;
    const runPts = loc.run.cache;
    if (!runPts?.length) continue;
    seenToolIds.add(toolUseId);
    if (loc.run.taskId) seenTaskIds.add(loc.run.taskId);

    let runParts: CostParts = ZERO_COST;
    let runUncached = 0;
    let runPriced = 0;
    for (const p of runPts) {
      const u = usageOf(p, loc.run.model ?? inp.fallbackModel);
      const c = requestCost(inp.table, u);
      if (!c) {
        unpriced++;
        unpricedModels.add(u.model ?? '未知模型');
        continue;
      }
      runPriced++;
      runParts = addCost(runParts, c);
      runUncached += uncachedCost(inp.table, u) ?? 0;
    }
    if (runPriced <= 0) continue;
    requests += runPriced;
    parts = addCost(parts, runParts);
    const sc = costTotal(runParts);
    sub += sc;
    uncached += runUncached;
    const src = inferRunSource(loc.run, inp.subagents);
    bySource[src] += sc;
    const t = turns[loc.turnIdx];
    if (t) {
      t.sub = addCost(t.sub, runParts);
      t.subRuns++;
    } else {
      other = addCost(other, runParts);
    }
    const agentType = loc.run.subagentType || '其它';
    recordType({
      toolUseId,
      turnId: loc.turnId,
      title: loc.run.title || agentType,
      agentType,
      source: src,
      cost: sc,
    });
  }

  const byType = [...typeMap.values()].sort((a, b) => b.cost - a.cost);

  // 统计各来源的订阅 / 非订阅分布，判断是否混合计费
  const subscriptionSources: CostSource[] = [];
  let hasSubBilling = false;
  let hasNonSubBilling = false;
  if (inp.billing) {
    if (bySource.main > 0) {
      if (inp.billing === 'subscription') {
        subscriptionSources.push('main');
        hasSubBilling = true;
      } else {
        hasNonSubBilling = true;
      }
    }
    for (const src of ['native', 'claude', 'codex', 'agy'] as const) {
      if (bySource[src] <= 0) continue;
      const flag = subBillBySource[src];
      if (flag?.sub) {
        subscriptionSources.push(src);
        hasSubBilling = true;
      }
      if (flag?.nonSub) hasNonSubBilling = true;
    }
  }

  const total = main + sub;
  return {
    total,
    parts,
    main,
    sub,
    bySource,
    byType,
    subscriptionSources,
    mixedBilling: hasSubBilling && hasNonSubBilling,
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

/** 花费的五个来源（分段条与图例共用；颜色复用 ContextPanel.css 变量） */
export const COST_SOURCES: { key: CostSource; label: string; color: string }[] = [
  { key: 'main', label: '主线程', color: 'var(--cz-ctx-messages)' },
  { key: 'native', label: '原生子代理', color: 'var(--cz-ctx-sys-tools)' },
  { key: 'claude', label: 'Claude 委派', color: 'var(--cz-ctx-sys-prompt)' },
  { key: 'codex', label: 'Codex', color: 'var(--cz-ctx-skills)' },
  { key: 'agy', label: 'Antigravity', color: 'var(--cz-ctx-agents)' },
];
