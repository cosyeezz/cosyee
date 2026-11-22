// 自动贴底：内容增长时跟随到底部；用户向上滚动后停止，滚回底部后恢复。
import { useCallback, useEffect, useRef, type RefObject } from 'react';

const THRESHOLD = 40;
/** 程序化「跳到底部」后，在这段时间内（平滑滚动动画期间）不因 scroll 事件脱离贴底 */
const PIN_MS = 900;

export interface StickControls {
  /** 滚到底部并恢复贴底（即使平滑滚动过程中内容还在增长也会跟上） */
  pinToBottom: (behavior?: ScrollBehavior) => void;
  /** 正在贴底时立刻同步滚到底（在 layout effect 里调用：内容刚提交、还没绘制，不等下一帧的 ResizeObserver） */
  followIfStuck: () => void;
}

/**
 * @param scrollRef 滚动容器
 * @param contentRef 容器内的内容包裹层（用 ResizeObserver 监听其高度变化）
 */
export function useStickToBottom(scrollRef: RefObject<HTMLElement>, contentRef: RefObject<HTMLElement>): StickControls {
  const stick = useRef(true);
  const pinUntil = useRef(0);

  useEffect(() => {
    const sc = scrollRef.current;
    const ct = contentRef.current;
    if (!sc || !ct) return;

    let lastTop = sc.scrollTop;
    const toBottom = () => {
      sc.scrollTop = sc.scrollHeight;
      lastTop = sc.scrollTop;
    };
    const onScroll = () => {
      const top = sc.scrollTop;
      const prev = lastTop;
      lastTop = top;
      // 平滑滚动到底的过程中会连续触发 scroll，此时还没到底，不能因此脱离贴底
      if (Date.now() < pinUntil.current) return;
      if (sc.scrollHeight - top - sc.clientHeight < THRESHOLD) {
        stick.current = true;
      } else if (top < prev) {
        // 只有「向上」滚才脱离。流式输出时内容先于滚动事件增长，
        // 此刻量到的「离底距离」很大，但那不是用户上滚，不能因此停止跟随
        stick.current = false;
      }
    };
    // 用户主动上滚：立即脱离贴底，避免与内容增长抢滚动条
    const release = () => {
      stick.current = false;
      pinUntil.current = 0;
    };
    const onWheel = (e: WheelEvent) => {
      // Ctrl + 滚轮是调字号（flowZoom.ts），不是上滚
      if (e.deltaY < 0 && !e.ctrlKey && !e.metaKey) release();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') release();
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

  const pinToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const sc = scrollRef.current;
      if (!sc) return;
      stick.current = true;
      pinUntil.current = behavior === 'smooth' ? Date.now() + PIN_MS : 0;
      if (typeof sc.scrollTo === 'function') sc.scrollTo({ top: sc.scrollHeight, behavior });
      else sc.scrollTop = sc.scrollHeight;
    },
    [scrollRef],
  );

  const followIfStuck = useCallback(() => {
    const sc = scrollRef.current;
    if (sc && stick.current) sc.scrollTop = sc.scrollHeight;
  }, [scrollRef]);

  return { pinToBottom, followIfStuck };
}
