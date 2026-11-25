// 会话悬浮卡片的详情加载与缓存。
// 模块级 Map 缓存（上限 100 条；执行中的会话最多缓存 5 秒）；同键并发合并；失败不缓存。
// 通过 React Context 注入取数函数，默认走 api.sessionDetail，调试页和单测可替换为假实现。
import { createContext } from 'react';
import type { SessionDetail, SessionDot } from '@cosyee/shared';
import { api } from '../../core/api';

export type SessionDetailLoader = (id: string, cwd: string) => Promise<SessionDetail>;

export const SessionDetailContext = createContext<SessionDetailLoader>(api.sessionDetail);

const MAX_CACHE = 100;
const RUNNING_TTL_MS = 5000;

interface CacheEntry {
  data: SessionDetail;
  at: number;
}

interface LoaderBucket {
  cache: Map<string, CacheEntry>;
  inflight: Map<string, Promise<SessionDetail>>;
}

// 按取数函数分桶：生产环境永远是 api.sessionDetail 这一个桶；测试 / 调试页传入不同函数时互不污染
const buckets = new WeakMap<SessionDetailLoader, LoaderBucket>();

function bucketOf(loader: SessionDetailLoader): LoaderBucket {
  let b = buckets.get(loader);
  if (!b) {
    b = { cache: new Map(), inflight: new Map() };
    buckets.set(loader, b);
  }
  return b;
}

/** 缓存键：cwd + id + lastActiveAt + dot */
export function detailCacheKey(id: string, cwd: string, lastActiveAt: number, dot: SessionDot | 'deleted'): string {
  return `${cwd}\0${id}\0${lastActiveAt}\0${dot ?? ''}`;
}

function isFresh(entry: CacheEntry, running: boolean, now: number): boolean {
  if (!running) return true;
  return now - entry.at <= RUNNING_TTL_MS;
}

/** 同步检查缓存命中（命中时卡片直接显示，不放骨架、不重播入场动效） */
export function peekSessionDetail(
  loader: SessionDetailLoader,
  key: string,
  running: boolean,
  now = Date.now(),
): SessionDetail | null {
  const b = buckets.get(loader);
  if (!b) return null;
  const hit = b.cache.get(key);
  if (!hit) return null;
  if (!isFresh(hit, running, now)) {
    b.cache.delete(key);
    return null;
  }
  return hit.data;
}

/** 加载详情：命中缓存直接返回；同键并发共用一个请求；失败不缓存 */
export function loadSessionDetail(
  loader: SessionDetailLoader,
  id: string,
  cwd: string,
  key: string,
  running: boolean,
): Promise<SessionDetail> {
  const b = bucketOf(loader);
  const hit = b.cache.get(key);
  if (hit && isFresh(hit, running, Date.now())) {
    // 刷新 LRU 顺序
    b.cache.delete(key);
    b.cache.set(key, hit);
    return Promise.resolve(hit.data);
  }
  if (hit) b.cache.delete(key);

  const existing = b.inflight.get(key);
  if (existing) return existing;

  const p = loader(id, cwd).then(
    (data) => {
      b.inflight.delete(key);
      // 超过上限时淘汰最旧的一条
      if (b.cache.size >= MAX_CACHE) {
        const oldest = b.cache.keys().next().value;
        if (oldest !== undefined) b.cache.delete(oldest);
      }
      b.cache.set(key, { data, at: Date.now() });
      return data;
    },
    (err) => {
      b.inflight.delete(key);
      throw err;
    },
  );
  b.inflight.set(key, p);
  return p;
}

/** 仅用于测试清理指定取数函数的缓存 */
export function clearSessionDetailCache(loader: SessionDetailLoader = api.sessionDetail): void {
  buckets.delete(loader);
}
