// 订阅一个媒体查询；没有 matchMedia（测试环境）时视为不匹配。
import { useSyncExternalStore } from 'react';

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
      const m = window.matchMedia(query);
      m.addEventListener?.('change', cb);
      return () => m.removeEventListener?.('change', cb);
    },
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    () => false,
  );
}

/** 窄屏（手机）：两侧栏改为浮层抽屉 */
export const NARROW_QUERY = '(max-width: 760px)';
