// 统一用量统计：主会话与子代理共用的 CachePoint 构造/合并、UsageTrack 结构、
// 委派后端上报的 cosyee_usage 事件，以及按模型推算默认上下文窗口。
import type { ContextUsage } from './protocol.ts';
import type { CachePoint, CompactMark } from './view.ts';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const tok = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** 最多保留的点数（更早的丢弃）；会话花费也从这些点算，所以留得多一些 */
export const MAX_CACHE_POINTS = 2000;

/** assistant message → 一个点；没有 id / usage 或分母为 0 返回 null */
export function cachePointOf(message: unknown, turn: number): CachePoint | null {
  if (!isObj(message)) return null;
  const id = str(message.id);
  const u = message.usage;
  if (!id || !isObj(u)) return null;
  const input = tok(u.input_tokens);
  const create = tok(u.cache_creation_input_tokens);
  const read = tok(u.cache_read_input_tokens);
  const total = input + create + read;
  if (total <= 0) return null;
  const tools: string[] = [];
  for (const b of arr(message.content)) if (isObj(b) && b.type === 'tool_use' && str(b.id)) tools.push(str(b.id));
  const p: CachePoint = { id, turn, input, create, read, rate: (read / total) * 100 };
  if (tools.length) p.tools = tools;
  // 算花费用：输出 token、模型、1 小时缓存写入、fast / 美国境内推理
  p.output = tok(u.output_tokens);
  const model = str(message.model);
  if (model && !model.startsWith('<')) p.model = model;
  if (isObj(u.cache_creation)) {
    const h1 = tok(u.cache_creation.ephemeral_1h_input_tokens);
    if (h1 > 0) p.create1h = Math.min(h1, create);
  }
  if (u.speed === 'fast') p.fast = true;
  if (u.inference_geo === 'us') p.usGeo = true;
  return p;
}

/** 合并两次看到的 tool_use id（同一条消息在流里 / 历史里分成多段，每段只带一部分 content） */
export function mergeTools(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
  if (!b?.length) return a;
  if (!a?.length) return b;
  const out = a.slice();
  for (const id of b) if (!out.includes(id)) out.push(id);
  return out.length === a.length ? a : out;
}

/** 就地加入一个点（同 id 已存在则更新那一点）；返回是否有变化。list 必须是调用方自己拥有的数组 */
export function pushCachePoint(list: CachePoint[], p: CachePoint): boolean {
  const at = list.findIndex((x) => x.id === p.id);
  if (at >= 0) {
    const o = list[at]!;
    const tools = mergeTools(o.tools, p.tools);
    // 同一条消息分段到达时输出 token 只增不减（流式中间段的 usage 是部分值）
    const output = Math.max(o.output ?? 0, p.output ?? 0);
    const model = p.model ?? o.model;
    if (
      o.input === p.input && o.create === p.create && o.read === p.read && tools === o.tools &&
      (o.output ?? 0) === output && o.model === model && o.create1h === p.create1h && o.fast === p.fast && o.usGeo === p.usGeo
    ) return false;
    const n: CachePoint = { ...p, turn: o.turn, output };
    if (tools) n.tools = tools;
    else delete n.tools;
    if (model) n.model = model;
    list[at] = n;
    return true;
  }
  list.push(p);
  if (list.length > MAX_CACHE_POINTS) list.splice(0, list.length - MAX_CACHE_POINTS);
  return true;
}

/** 计费方式：API 密钥（官方地址）/ 订阅账号（按额度，显示等价 API 价）/ 第三方接口地址（按官方价估算） */
export type UsageBilling = 'api' | 'subscription' | 'thirdParty';

/** 统一的用量统计轨道（主会话与子代理共用） */
export interface UsageTrack {
  /** 逐次 API 请求的缓存与 token 记录 */
  points: CachePoint[];
  /** 模型上下文窗口（token）；未知时为 null */
  window: number | null;
  /** 上下文分类占比明细（仅主会话通过 /context 采集，子代理通常没有） */
  breakdown?: ContextUsage | null;
  /** 会话压缩记录（仅主会话有） */
  compactions?: readonly CompactMark[];
  /** 计费方式 */
  billing: UsageBilling;
}

/** 委派后端上报单次请求用量的 CLI 形状事件 subtype */
export const COSYEE_USAGE_SUBTYPE = 'cosyee_usage' as const;

/** 委派后端把每次请求用量转成的 CLI 形状系统事件 */
export interface CosyeeUsageEvent {
  type: 'system';
  subtype: typeof COSYEE_USAGE_SUBTYPE;
  parent_tool_use_id: string;
  point: CachePoint;
  window?: number;
}

/** 构造一条 cosyee_usage 事件；window 仅在正有限数时写入 */
export function cosyeeUsageEvent(toolUseId: string, point: CachePoint, window?: number): CosyeeUsageEvent {
  return {
    type: 'system',
    subtype: COSYEE_USAGE_SUBTYPE,
    parent_tool_use_id: toolUseId,
    point,
    ...(typeof window === 'number' && Number.isFinite(window) && window > 0 ? { window } : {}),
  };
}

/** 判断一条事件是否为合法的 cosyee_usage 事件 */
export function isCosyeeUsageEvent(e: unknown): e is CosyeeUsageEvent {
  if (!isObj(e) || e.type !== 'system' || e.subtype !== COSYEE_USAGE_SUBTYPE) return false;
  if (typeof e.parent_tool_use_id !== 'string' || !e.parent_tool_use_id) return false;
  const pt = e.point;
  if (!isObj(pt)) return false;
  if (
    typeof pt.id !== 'string' || !pt.id ||
    typeof pt.turn !== 'number' || !Number.isFinite(pt.turn) ||
    typeof pt.input !== 'number' || !Number.isFinite(pt.input) ||
    typeof pt.create !== 'number' || !Number.isFinite(pt.create) ||
    typeof pt.read !== 'number' || !Number.isFinite(pt.read) ||
    typeof pt.rate !== 'number' || !Number.isFinite(pt.rate)
  ) return false;
  if (e.window !== undefined && (typeof e.window !== 'number' || !Number.isFinite(e.window) || e.window <= 0)) return false;
  return true;
}

const CLAUDE_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'fable']);

/**
 * 按模型 id 推算默认上下文窗口（token）；查不到返回 null。
 * 优先级：hint.m1 / `[1m]` 后缀 → 1_000_000；其余按各家官方规格（2026-11-27 核对）：
 * - Claude：5 系列及以后（claude-opus-5*、claude-sonnet-5-5、claude-haiku-5-5、claude-fable-5* 及别名 opus/sonnet/haiku/fable）：1_000_000；
 *   4.x 及更早（claude-sonnet-4-5、claude-haiku-4-5-20251001 等）：200_000（2026-11-27 用 claude -p 的 modelUsage.contextWindow 实测）
 * - OpenAI（gpt-6*、gpt-5.6*、gpt-5.4 非 mini/nano）：1_050_000；
 *   gpt-5 / gpt-5.1 / gpt-5.2 / gpt-5.3-codex / gpt-5.4-mini / gpt-5-mini / gpt-5-nano：400_000；
 *   gpt-4.1*：1_047_576；gpt-4o*：128_000；o3* / o4-mini* / codex-mini*：200_000
 * - Google Gemini：gemini-4*：1_000_000；gemini-3* / gemini-2.5* / gemini-2.0*：1_048_576
 */
export function contextWindowOf(model: string | undefined, hint?: { m1?: boolean }): number | null {
  if (hint?.m1) return 1_000_000;
  if (!model || typeof model !== 'string') return null;
  const raw = model.trim().toLowerCase();
  if (!raw || raw.startsWith('<')) return null;
  if (/\[1m\]$/.test(raw)) return 1_000_000;

  // 去掉 [xxx] 后缀、常见供应商路径前缀、以及 agy 的强度后缀
  const base = raw
    .replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:(?:us|eu|global)\.)?(?:anthropic\.|openai\/|google\/|models\/|publishers\/google\/models\/)/, '')
    .replace(/-(?:low|medium|high|xhigh|max)$/, '');

  // 别名（opus / sonnet / haiku / fable）现在都解析到 5.x；CLI 实测 claude-*-5* 为 1M，4.x 及更早为 200k
  if (CLAUDE_ALIASES.has(base)) return 1_000_000;
  if (base.startsWith('claude-')) return /^claude-(?:opus|sonnet|haiku|fable)-([5-9]|\d{2,})(?:$|[-.])/.test(base) ? 1_000_000 : 200_000;

  // OpenAI GPT / Codex / o 系列
  if (/^gpt-6(?:\.\d+)?(?:$|-)/.test(base)) return 1_050_000;
  if (/^gpt-5\.6(?:$|-)/.test(base)) return 1_050_000;
  if (/^gpt-5\.4-(?:mini|nano)(?:$|-)/.test(base)) return 400_000;
  if (/^gpt-5\.4(?:$|-)/.test(base)) return 1_050_000;
  if (/^gpt-5(?:\.[0-3])?(?:$|-)/.test(base)) return 400_000;
  if (/^gpt-4\.1(?:$|-)/.test(base)) return 1_047_576;
  if (/^gpt-4o(?:$|-)/.test(base)) return 128_000;
  if (/^(?:o3|o4-mini|codex-mini)(?:$|-)/.test(base)) return 200_000;

  // Google Gemini 系列
  if (/^gemini-4(?:\.\d+)?(?:$|-)/.test(base)) return 1_000_000;
  if (/^gemini-(?:3(?:\.\d+)?|2\.5|2\.0)(?:$|-)/.test(base)) return 1_048_576;

  return null;
}
