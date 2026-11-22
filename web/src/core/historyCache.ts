// 最近看过的会话历史（按后端返回的版本号）：切回时带上版本号，后端说没变就直接复用构建好的状态，
// 省掉下载、JSON 解析和 fromHistory 重建。ConvState 是不可变的，复用同一份对象是安全的。
// 只缓存进程不在跑的会话（在跑的会话文件一直在变，缓存不会命中）。
import type { ConvState } from './reducer';

interface Entry {
  version: string;
  conv: ConvState;
}

/** 最多缓存几个会话（大会话的状态可能有几十 MB，不宜多） */
const MAX = 6;
const cache = new Map<string, Entry>();

const keyOf = (cwd: string, id: string) => `${cwd}\n${id}`;

export function getHistory(cwd: string, id: string): Entry | undefined {
  const k = keyOf(cwd, id);
  const e = cache.get(k);
  if (e) {
    // 最近用过的挪到末尾
    cache.delete(k);
    cache.set(k, e);
  }
  return e;
}

export function putHistory(cwd: string, id: string, version: string, conv: ConvState): void {
  const k = keyOf(cwd, id);
  cache.delete(k);
  cache.set(k, { version, conv });
  while (cache.size > MAX) cache.delete(cache.keys().next().value!);
}

export function dropHistory(cwd: string, id: string): void {
  cache.delete(keyOf(cwd, id));
}

/** 测试用 */
export function clearHistoryCache(): void {
  cache.clear();
}
