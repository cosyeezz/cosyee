// 自动贴底：内容增长时跟随到底部；用户向上滚动后停止，滚回底部后恢复。
import { useEffect, useRef, type RefObject } from 'react';

const THRESHOLD = 40;

/**
 * @param scrollRef 滚动容器
 * @param contentRef 容器内的内容包裹层（用 ResizeObserver 监听其高度变化）
 */
export function useStickToBottom(scrollRef: RefObject<HTMLElement>, contentRef: RefObject<HTMLElement>): void {
  const stick = useRef(true);

  useEffect(() => {
    const sc = scrollRef.current;
    const ct = contentRef.current;
    if (!sc || !ct) return;

    const toBottom = () => {
      sc.scrollTop = sc.scrollHeight;
    };
    const onScroll = () => {
      stick.current = sc.scrollHeight - sc.scrollTop - sc.clientHeight < THRESHOLD;
    };
    // 用户主动上滚：立即脱离贴底，避免与内容增长抢滚动条
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) stick.current = false;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') stick.current = false;
    };

    sc.addEventListener('scroll', onScroll, { passive: true });
    sc.addEventListener('wheel', onWheel, { passive: true });
    sc.addEventListener('keydown', onKey);
    const ro = new ResizeObserver(() => {
      if (stick.current) toBottom();
    });
    ro.observe(ct);
    toBottom();
    return () => {
      sc.removeEventListener('scroll', onScroll);
      sc.removeEventListener('wheel', onWheel);
      sc.removeEventListener('keydown', onKey);
      ro.disconnect();
    };
  }, [scrollRef, contentRef]);
}
