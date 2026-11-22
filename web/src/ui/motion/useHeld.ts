// 数据短暂变空时先留着上一份：切换会话的那几百毫秒里面板不闪成空态，新数据到了直接换上（数字从旧值滚到新值）。
// 超过 ms 还没有新数据才真正变空。减少动效 / 测试环境里不保留，空了就是空。
import { useEffect, useState } from 'react';
import { motionOK } from './reduced';

export function useHeld<T>(value: T | null, ms = 900): { value: T | null; stale: boolean } {
  const [held, setHeld] = useState<T | null>(value);
  const [prev, setPrev] = useState<T | null>(value);
  if (value !== prev) {
    setPrev(value);
    if (value !== null) setHeld(value);
    else if (!motionOK()) setHeld(null);
  }
  useEffect(() => {
    if (value !== null || held === null) return;
    const t = window.setTimeout(() => setHeld(null), ms);
    return () => window.clearTimeout(t);
  }, [value, held, ms]);
  return value !== null ? { value, stale: false } : { value: held, stale: held !== null };
}
