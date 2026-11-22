// 缓存命中率走势：每次 API 请求（一条 assistant 消息）一个点。
// 命中率 = cache_read / (input + cache_creation + cache_read)，数据来自 message.usage（实时事件与历史条目共用）。
// 只收主线程；按 message.id 去重（同一条消息在历史里分成多行、replay 与历史重叠都不会重复计数）；分母为 0 的不记。

import type { CachePoint, CompactMark, SessionMeta } from '@cosyee/shared';
import { arr, isObj, str } from './util';

/** 最多保留的点数（更早的丢弃）；会话花费也从这些点算，所以留得多一些 */
export const MAX_CACHE_POINTS = 2000;

const tok = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

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
function mergeTools(a: string[] | undefined, b: string[] | undefined): string[] | undefined {
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

/** 实时：记录一条主线程 assistant 消息，返回新的 meta（没变化时原样返回） */
export function recordCache(meta: SessionMeta, message: unknown, turn: number): SessionMeta {
  const p = cachePointOf(message, turn);
  if (!p) return meta;
  const list = (meta.cache ?? []).slice();
  return pushCachePoint(list, p) ? { ...meta, cache: list } : meta;
}

/**
 * 实时：message_delta 带的是这条消息的最终 usage，补到同 id 的点上。
 * 有的中转在 message_start 里把缓存字段填 0，只在 message_delta 里给真实值。CLI 收到 delta 后才修正 usage 再写进 transcript，
 * 但 stdout 上的 assistant 事件已经按 message_start 的值发出去了，所以实时图会一直是 0。
 * 规则与 CLI 一致：delta 里 > 0 的字段覆盖，其余沿用。没有同 id 的点时新建一个。没变化时原样返回。
 */
export function recordCacheDelta(meta: SessionMeta, id: string, usage: unknown, turn: number): SessionMeta {
  if (!id || !isObj(usage)) return meta;
  const list = (meta.cache ?? []).slice();
  const at = list.findIndex((x) => x.id === id);
  const o = at >= 0 ? list[at]! : null;
  const pick = (v: unknown, prev: number): number => (tok(v) > 0 ? tok(v) : prev);
  const input = pick(usage.input_tokens, o?.input ?? 0);
  const create = pick(usage.cache_creation_input_tokens, o?.create ?? 0);
  const read = pick(usage.cache_read_input_tokens, o?.read ?? 0);
  const output = pick(usage.output_tokens, o?.output ?? 0);
  const total = input + create + read;
  if (total <= 0) return meta;
  const n: CachePoint = o ? { ...o, input, create, read, output, rate: (read / total) * 100 } : { id, turn, input, create, read, output, rate: (read / total) * 100 };
  const h1 = isObj(usage.cache_creation) ? tok(usage.cache_creation.ephemeral_1h_input_tokens) : 0;
  const create1h = h1 > 0 ? h1 : o?.create1h;
  if (create1h !== undefined) n.create1h = Math.min(create1h, create);
  if (usage.speed === 'fast') n.fast = true;
  if (usage.inference_geo === 'us') n.usGeo = true;
  if (!o) return pushCachePoint(list, n) ? { ...meta, cache: list } : meta;
  if (
    o.input === n.input && o.create === n.create && o.read === n.read && (o.output ?? 0) === n.output &&
    o.create1h === n.create1h && o.fast === n.fast && o.usGeo === n.usGeo
  ) return meta;
  list[at] = n;
  return { ...meta, cache: list };
}

/** 回退 / replay 重放前：丢掉序号 >= turnCount 的轮留下的点与压缩记录 */
export function trimCache(meta: SessionMeta, turnCount: number): SessionMeta {
  let out = meta;
  const list = meta.cache;
  if (list && list.some((p) => p.turn >= turnCount)) out = { ...out, cache: list.filter((p) => p.turn < turnCount) };
  const marks = meta.compactions;
  if (marks && marks.some((m) => m.turn >= turnCount)) out = { ...out, compactions: marks.filter((m) => m.turn < turnCount) };
  return out;
}

/** 最多保留的压缩记录数 */
export const MAX_COMPACT_MARKS = 100;

const optNum = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * compact_boundary → 压缩记录。历史条目是 camelCase（compactMetadata.preTokens），实时事件是 snake_case
 * （compact_metadata.pre_tokens），两种都认；没有 uuid 或 preTokens 的返回 null。
 */
export function compactMarkOf(raw: Record<string, unknown>, turn: number, after: string | null, at: number): CompactMark | null {
  const id = str(raw.uuid);
  const md = isObj(raw.compactMetadata) ? raw.compactMetadata : isObj(raw.compact_metadata) ? raw.compact_metadata : null;
  if (!id || !md) return null;
  const pre = optNum(md.preTokens ?? md.pre_tokens);
  if (pre === null) return null;
  return {
    id,
    turn,
    trigger: md.trigger === 'manual' ? 'manual' : 'auto',
    pre,
    post: optNum(md.postTokens ?? md.post_tokens),
    durationMs: optNum(md.durationMs ?? md.duration_ms),
    after,
    at,
  };
}

/** 就地加入一条压缩记录（同 id 已有则忽略）；返回是否有变化 */
export function pushCompactMark(list: CompactMark[], m: CompactMark): boolean {
  if (list.some((x) => x.id === m.id)) return false;
  list.push(m);
  if (list.length > MAX_COMPACT_MARKS) list.splice(0, list.length - MAX_COMPACT_MARKS);
  return true;
}

/** 实时：记录一次主线程的 compact_boundary，返回新的 meta（没变化时原样返回） */
export function recordCompact(meta: SessionMeta, raw: Record<string, unknown>, turn: number, at: number): SessionMeta {
  const after = meta.cache?.length ? meta.cache[meta.cache.length - 1]!.id : null;
  const m = compactMarkOf(raw, turn, after, at);
  if (!m) return meta;
  const list = (meta.compactions ?? []).slice();
  return pushCompactMark(list, m) ? { ...meta, compactions: list } : meta;
}
