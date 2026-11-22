// 延迟卸载：open 变假后先留着元素、带上 is-leaving 播退场过渡，过渡结束（或超时）再真正卸载。
// 退场途中又打开：直接回到显示态，CSS transition 会从当前位置接着走，不会跳。
// 减少动效 / 测试环境里不留，关了就卸载。样式见 styles/motion.css 的 .cz-pop。
import { useEffect, useState, type RefObject } from 'react';
import { motionOK } from './reduced';

export function usePresence(open: boolean, ref: RefObject<HTMLElement>, ms = 160): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setMounted(true);
    else if (!motionOK()) setMounted(false);
  }
  const leaving = mounted && !open;

  useEffect(() => {
    if (!leaving) return;
    const el = ref.current;
    const end = () => setMounted(false);
    const onEnd = (e: TransitionEvent) => {
      if (e.target === el && e.propertyName === 'opacity') end();
    };
    el?.addEventListener('transitionend', onEnd);
    const t = window.setTimeout(end, ms + 50);
    return () => {
      el?.removeEventListener('transitionend', onEnd);
      window.clearTimeout(t);
    };
  }, [leaving, ms, ref]);

  return { mounted: mounted || open, leaving };
}

/** 退场中的元素不可聚焦、不可点（React 18 不认 inert 布尔值，用空字符串） */
export function leavingProps(leaving: boolean): Record<string, unknown> {
  return leaving ? { inert: '', 'aria-hidden': true } : {};
}
