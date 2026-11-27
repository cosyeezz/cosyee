// 模型价格与单次请求花费。价格单位：美元 / 百万 token（MTok）；花费单位：美元。
// 内置价格表来源：
// - Anthropic Claude：https://platform.claude.com/docs/en/about-claude/pricing（2026-11-22 核对，服务端会定期抓取更新）
// - OpenAI GPT / Codex：https://openai.com/api/pricing 、https://platform.openai.com/docs/pricing（2026-11-27 核对）
// - Google Gemini：https://ai.google.dev/gemini-api/docs/pricing（2026-11-27 核对）
// 注：OpenAI 与 Google Gemini 采用自动隐式缓存，没有单独的缓存写入加价（未命中缓存的输入按普通 input 价计费），
// 因此 write5m / write1h 均填为等于 input（实际请求 create = 0 时写费用为 0；冷缓存预估时按 input 价算，与官方计费一致）。

export interface TokenPrices {
  /** 未命中缓存的输入 */
  input: number;
  /** 写入 5 分钟缓存 */
  write5m: number;
  /** 写入 1 小时缓存 */
  write1h: number;
  /** 命中缓存（cache hit / refresh） */
  read: number;
  output: number;
}

export interface ModelPrice extends TokenPrices {
  /** 归一后的模型 id（见 modelKey），如 claude-opus-5-5 */
  id: string;
  /** 官方名称，如 Claude Opus 5.5 */
  label: string;
  /** 长上下文价：一次请求的输入（含缓存读写）超过 threshold 时，整次请求都按这套价格 */
  long?: TokenPrices & { threshold: number };
  /** fast 模式的输入 / 输出价；缓存读写按基础价的同等倍率换算 */
  fast?: { input: number; output: number };
}

export interface PriceTable {
  /** builtin = 内置表；official = 服务端从官方页面抓取（与内置表合并） */
  source: 'builtin' | 'official';
  /** 官方页面抓取成功的时间（毫秒）；内置表为 null */
  fetchedAt: number | null;
  models: ModelPrice[];
}

/** inference_geo = us（仅美国境内推理）时所有价格乘这个倍率 */
export const US_GEO_MULTIPLIER = 1.1;

const p = (id: string, label: string, input: number, write5m: number, write1h: number, read: number, output: number, extra: Partial<ModelPrice> = {}): ModelPrice => ({
  id, label, input, write5m, write1h, read, output, ...extra,
});

export const BUILTIN_PRICES: PriceTable = {
  source: 'builtin',
  fetchedAt: null,
  models: [
    p('claude-fable-5-2', 'Claude Fable 5.2', 8, 10, 16, 0.2, 40, { fast: { input: 16, output: 80 } }),
    p('claude-mythos-5-2', 'Claude Mythos 5.2', 8, 10, 16, 0.2, 40, { fast: { input: 16, output: 80 } }),
    p('claude-fable-5-1', 'Claude Fable 5.1', 10, 12.5, 20, 0.25, 50),
    p('claude-mythos-5-1', 'Claude Mythos 5.1', 10, 12.5, 20, 0.25, 50),
    p('claude-fable-5', 'Claude Fable 5', 10, 12.5, 20, 1, 50),
    p('claude-mythos-5', 'Claude Mythos 5', 10, 12.5, 20, 1, 50),
    p('claude-opus-5-5', 'Claude Opus 5.5', 4, 5, 8, 0.2, 20, { fast: { input: 8, output: 40 } }),
    p('claude-opus-5', 'Claude Opus 5', 5, 6.25, 10, 0.5, 25, { fast: { input: 10, output: 50 } }),
    p('claude-opus-4-8', 'Claude Opus 4.8', 5, 6.25, 10, 0.5, 25, { fast: { input: 10, output: 50 } }),
    p('claude-opus-4-7', 'Claude Opus 4.7', 5, 6.25, 10, 0.5, 25),
    p('claude-opus-4-6', 'Claude Opus 4.6', 5, 6.25, 10, 0.5, 25),
    p('claude-opus-4-5', 'Claude Opus 4.5', 5, 6.25, 10, 0.5, 25),
    p('claude-opus-4-1', 'Claude Opus 4.1', 15, 18.75, 30, 1.5, 75),
    p('claude-opus-4', 'Claude Opus 4', 15, 18.75, 30, 1.5, 75),
    p('claude-sonnet-5-5', 'Claude Sonnet 5.5', 2, 2.5, 4, 0.1, 10),
    p('claude-sonnet-5', 'Claude Sonnet 5', 2, 2.5, 4, 0.2, 10),
    p('claude-sonnet-4-6', 'Claude Sonnet 4.6', 3, 3.75, 6, 0.3, 15),
    p('claude-sonnet-4-5', 'Claude Sonnet 4.5', 3, 3.75, 6, 0.3, 15),
    p('claude-sonnet-4', 'Claude Sonnet 4', 3, 3.75, 6, 0.3, 15),
    p('claude-haiku-5-5', 'Claude Haiku 5.5', 0.1, 0.125, 0.2, 0.01, 0.5, {
      long: { threshold: 100_000, input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 },
    }),
    p('claude-haiku-4-5', 'Claude Haiku 4.5', 1, 1.25, 2, 0.1, 5),

    // OpenAI GPT / Codex（https://openai.com/api/pricing ，2026-11-27 核对）
    // 无单独缓存写价，write5m = write1h = input。
    p('gpt-6.2-sol', 'GPT-6.2 Sol', 2, 2, 2, 0.1, 10),
    p('gpt-6.1-sol', 'GPT-6.1 Sol', 2, 2, 2, 0.1, 10),
    p('gpt-6.1-terra', 'GPT-6.1 Terra', 1, 1, 1, 0.05, 5),
    p('gpt-6-luna', 'GPT-6 Luna', 0.1, 0.1, 0.1, 0.01, 0.5),
    p('gpt-5.6-sol', 'GPT-5.6 Sol', 4, 4, 4, 0.4, 20),
    p('gpt-5.6-terra', 'GPT-5.6 Terra', 2, 2, 2, 0.2, 12),
    p('gpt-5.6-luna', 'GPT-5.6 Luna', 0.4, 0.4, 0.4, 0.04, 2.4),
    // GPT-5.4 官方 >272k 另有长上下文倍率（随档位变化），此处取标准档价格
    p('gpt-5.4', 'GPT-5.4', 2.5, 2.5, 2.5, 0.25, 15),
    p('gpt-5.4-mini', 'GPT-5.4 Mini', 0.75, 0.75, 0.75, 0.075, 4.5),
    p('gpt-5.3-codex', 'GPT-5.3 Codex', 1.75, 1.75, 1.75, 0.175, 14),
    p('gpt-5.2', 'GPT-5.2', 1.75, 1.75, 1.75, 0.175, 14),
    p('gpt-5.1', 'GPT-5.1', 1.25, 1.25, 1.25, 0.125, 10),
    p('gpt-5', 'GPT-5', 1.25, 1.25, 1.25, 0.125, 10),
    p('gpt-5-mini', 'GPT-5 Mini', 0.25, 0.25, 0.25, 0.025, 2),

    // Google Gemini（https://ai.google.dev/gemini-api/docs/pricing ，2026-11-27 核对）
    // 无单独缓存写价（仅显式缓存有按小时存储费，单次请求按 input / read / output 计费），write5m = write1h = input。
    p('gemini-4-neon', 'Gemini 4 Neon', 3, 3, 3, 0.15, 15),
    p('gemini-4-carbon', 'Gemini 4 Carbon', 2, 2, 2, 0.1, 10),
    p('gemini-4-argon', 'Gemini 4 Argon', 2, 2, 2, 0.1, 10),
    p('gemini-4-hydrogen', 'Gemini 4 Hydrogen', 1.5, 1.5, 1.5, 0.075, 7.5),
    p('gemini-3.8-flash', 'Gemini 3.8 Flash', 0.75, 0.75, 0.75, 0.075, 3.75),
    p('gemini-3.1-pro', 'Gemini 3.1 Pro', 2, 2, 2, 0.2, 12, {
      long: { threshold: 200_000, input: 4, write5m: 4, write1h: 4, read: 0.4, output: 18 },
    }),
    p('gemini-3-pro', 'Gemini 3 Pro', 2, 2, 2, 0.2, 12, {
      long: { threshold: 200_000, input: 4, write5m: 4, write1h: 4, read: 0.4, output: 18 },
    }),
    p('gemini-3-flash', 'Gemini 3 Flash', 0.5, 0.5, 0.5, 0.05, 3),
    p('gemini-2.5-pro', 'Gemini 2.5 Pro', 1.25, 1.25, 1.25, 0.125, 10, {
      long: { threshold: 200_000, input: 2.5, write5m: 2.5, write1h: 2.5, read: 0.25, output: 15 },
    }),
    p('gemini-2.5-flash', 'Gemini 2.5 Flash', 0.3, 0.3, 0.3, 0.03, 2.5),
  ],
};

/** 已知别名 / 同价变体 → 价格表里的规范 id */
const MODEL_KEY_ALIASES: Record<string, string> = {
  'gpt-5-codex': 'gpt-5',
  'gpt-5.1-codex': 'gpt-5.1',
  'gpt-5.2-codex': 'gpt-5.2',
  'gemini-3.7-flash': 'gemini-3.8-flash',
  'gemini-3.6-flash': 'gemini-3.8-flash',
};

/**
 * 会话记录里的模型 id → 价格表 id：
 * - Claude：claude-sonnet-4-5-20250929 / claude-opus-5-5[1m] / us.anthropic.claude-opus-4-1-20250805-v1:0 / claude-opus-4-5@20251101
 *   归一成 claude-<系列>-<版本>
 * - OpenAI：gpt-5.6-terra / gpt-6.1-sol / gpt-5.3-codex / gpt-5-codex / gpt-5-2025-08-07 等，去掉日期、预览与强度后缀后归一
 * - Gemini：gemini-4-neon-high / gemini-3.1-pro-preview / gemini-2.5-pro-preview-05-06 等，去掉强度、预览与日期后缀后归一
 * 认不出（第三方模型、<synthetic>、旧式 claude-3-5-sonnet）返回 null。
 */
export function modelKey(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  if (!s || s.startsWith('<')) return null;

  const claude = /claude-[a-z]+(?:-\d{1,2}(?!\d))*/.exec(s);
  if (claude) return claude[0];

  // 去掉常见供应商前缀、[1m] 括号后缀、agy 强度后缀、以及尾部的 preview/exp/latest/日期/版本号后缀
  const cleaned = s
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:openai\/|google\/|models\/|publishers\/google\/models\/)/, '')
    .replace(/-(?:low|medium|high|xhigh|max)$/, '')
    .replace(/(?:-(?:preview|exp|latest|chat-latest|00\d|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}|\d{8}))+$/, '');

  const gpt = /^gpt-(\d+(?:\.\d+)?)(?:-(sol|terra|luna|mini|nano|codex))?$/.exec(cleaned);
  if (gpt) {
    const id = gpt[2] ? `gpt-${gpt[1]}-${gpt[2]}` : `gpt-${gpt[1]}`;
    return MODEL_KEY_ALIASES[id] ?? id;
  }

  const gemini = /^gemini-(\d+(?:\.\d+)?)-(neon|carbon|argon|hydrogen|pro|flash|flash-lite)$/.exec(cleaned);
  if (gemini) {
    const id = `gemini-${gemini[1]}-${gemini[2]}`;
    return MODEL_KEY_ALIASES[id] ?? id;
  }

  return null;
}

/** 按模型 id 找价格；找不到返回 null */
export function findPrice(table: PriceTable, model: string | null | undefined): ModelPrice | null {
  const k = modelKey(model);
  if (!k) return null;
  return table.models.find((m) => m.id === k) ?? null;
}

/** 一次 API 请求的用量（token） */
export interface RequestUsage {
  model?: string;
  /** 未命中缓存的输入 */
  input: number;
  /** 写入缓存合计（5 分钟 + 1 小时） */
  create: number;
  /** 其中写入 1 小时缓存的部分；没有明细时视为全部 5 分钟 */
  create1h?: number;
  read: number;
  output: number;
  fast?: boolean;
  /** inference_geo = us */
  usGeo?: boolean;
}

/** 花费按类别拆分（美元） */
export interface CostParts {
  input: number;
  /** 缓存写入（5 分钟 + 1 小时） */
  write: number;
  read: number;
  output: number;
}

export const ZERO_COST: CostParts = Object.freeze({ input: 0, write: 0, read: 0, output: 0 });

export const costTotal = (c: CostParts): number => c.input + c.write + c.read + c.output;

export function addCost(a: CostParts, b: CostParts): CostParts {
  return { input: a.input + b.input, write: a.write + b.write, read: a.read + b.read, output: a.output + b.output };
}

/** 这次请求实际适用的单价（长上下文 / fast / 美国境内推理都算进去） */
export function effectivePrices(mp: ModelPrice, u: Pick<RequestUsage, 'input' | 'create' | 'read' | 'fast' | 'usGeo'>): TokenPrices {
  const prompt = u.input + u.create + u.read;
  let t: TokenPrices = mp.long && prompt > mp.long.threshold ? mp.long : mp;
  if (u.fast && mp.fast) {
    // 缓存倍率叠加在 fast 价上：按基础价的比例换算
    const k = mp.fast.input / t.input;
    t = { input: mp.fast.input, write5m: t.write5m * k, write1h: t.write1h * k, read: t.read * k, output: mp.fast.output };
  }
  if (u.usGeo) {
    const g = US_GEO_MULTIPLIER;
    t = { input: t.input * g, write5m: t.write5m * g, write1h: t.write1h * g, read: t.read * g, output: t.output * g };
  }
  return { input: t.input, write5m: t.write5m, write1h: t.write1h, read: t.read, output: t.output };
}

const M = 1_000_000;

/** 一次请求的花费；模型不在价格表里返回 null */
export function requestCost(table: PriceTable, u: RequestUsage): CostParts | null {
  const mp = findPrice(table, u.model);
  if (!mp) return null;
  const t = effectivePrices(mp, u);
  const h1 = Math.min(u.create, Math.max(0, u.create1h ?? 0));
  return {
    input: (u.input * t.input) / M,
    write: ((u.create - h1) * t.write5m + h1 * t.write1h) / M,
    read: (u.read * t.read) / M,
    output: (u.output * t.output) / M,
  };
}

/** 假如完全不用缓存（所有输入都按未命中价）这次请求要花多少；模型不在价格表里返回 null */
export function uncachedCost(table: PriceTable, u: RequestUsage): number | null {
  const mp = findPrice(table, u.model);
  if (!mp) return null;
  const t = effectivePrices(mp, u);
  return ((u.input + u.create + u.read) * t.input + u.output * t.output) / M;
}

/** CLI 每轮结束时（result.modelUsage）报告的某个模型的累计用量与花费（本进程启动以来） */
export interface CliModelCost {
  model: string;
  input: number;
  output: number;
  read: number;
  create5m: number;
  create1h: number;
  costUSD: number;
  /** 该模型的上下文窗口（来自 CLI result.modelUsage[m].contextWindow） */
  contextWindow?: number;
}

/**
 * 用 CLI 自己算的花费核对价格表：按我们的价格算出可能的区间（普通价 ~ fast / 长上下文价），
 * CLI 的数落在区间外（放宽 3%）就说明价格表可能过期。返回对不上的模型；
 * 不在价格表里的模型、花费太小（< $0.001，舍入误差大）的不核对。
 */
export function cliCostMismatches(table: PriceTable, rows: readonly CliModelCost[]): { model: string; ours: number; cli: number }[] {
  const out: { model: string; ours: number; cli: number }[] = [];
  for (const r of rows) {
    const mp = findPrice(table, r.model);
    if (!mp || r.costUSD < 0.001) continue;
    const cost = (fast: boolean, long: boolean) => {
      const t = effectivePrices(mp, { input: long ? Infinity : 0, create: 0, read: 0, fast });
      return (r.input * t.input + r.create5m * t.write5m + r.create1h * t.write1h + r.read * t.read + r.output * t.output) / M;
    };
    const lo = cost(false, false);
    const hi = Math.max(lo, mp.fast ? cost(true, !!mp.long) : cost(false, !!mp.long));
    if (r.costUSD < lo * 0.97 || r.costUSD > hi * 1.03) out.push({ model: mp.id, ours: lo, cli: r.costUSD });
  }
  return out;
}
