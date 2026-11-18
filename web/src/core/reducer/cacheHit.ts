// 缓存命中率走势：每次 API 请求（一条 assistant 消息）一个点。
// 命中率 = cache_read / (input + cache_creation + cache_read)，数据来自 message.usage（实时事件与历史条目共用）。
// 只收主线程；按 message.id 去重（同一条消息在历史里分成多行、replay 与历史重叠都不会重复计数）；分母为 0 的不记。

import type { CachePoint, SessionMeta } from '@cosyee/shared';
import { isObj, str } from './util';

/** 最多保留的点数（更早的丢弃） */
export const MAX_CACHE_POINTS = 400;

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
  return { id, turn, input, create, read, rate: (read / total) * 100 };
}

/** 就地加入一个点（同 id 已存在则更新那一点）；返回是否有变化。list 必须是调用方自己拥有的数组 */
export function pushCachePoint(list: CachePoint[], p: CachePoint): boolean {
  const at = list.findIndex((x) => x.id === p.id);
  if (at >= 0) {
    const o = list[at]!;
    if (o.input === p.input && o.create === p.create && o.read === p.read) return false;
    list[at] = { ...p, turn: o.turn };
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

/** 回退 / replay 重放前：丢掉序号 >= turnCount 的轮留下的点 */
export function trimCache(meta: SessionMeta, turnCount: number): SessionMeta {
  const list = meta.cache;
  if (!list || !list.some((p) => p.turn >= turnCount)) return meta;
  return { ...meta, cache: list.filter((p) => p.turn < turnCount) };
}
