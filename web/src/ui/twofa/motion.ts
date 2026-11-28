// 2FA 面板专用动效钩子：按用户明确要求始终开启动效，不跟随系统 prefers-reduced-motion。
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const canWebAnimate = (el: Element | null | undefined): el is HTMLElement =>
  !!el && typeof (el as HTMLElement).animate === 'function';

/**
 * 延迟卸载：open 变 false 后保留 DOM 并标记 leaving=true 播完退场过渡再卸载；
 * 退场途中再次打开会立即取消退场，CSS transition 从当前状态平滑接续，不跳变。
 */
export function useAlwaysPresence(
  open: boolean,
  ref: RefObject<HTMLElement>,
  exitMs = 130,
): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);

  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setMounted(true);
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
    const timer = window.setTimeout(end, exitMs + 50);
    return () => {
      el?.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
    };
  }, [leaving, exitMs, ref]);

  return { mounted: mounted || open, leaving };
}

/** 退场期间屏蔽交互，避免重复点击或抢占键盘事件 */
export function inertLeaving(leaving: boolean): Record<string, unknown> {
  return leaving ? { inert: '', 'aria-hidden': true } : {};
}

/**
 * FLIP 列表重排过渡：记录每个 [data-row-key] 的上次 top，顺序变化时从旧位置平滑滑到新位置。
 * 快速连续重排时先取消进行中的动画并读取当前视觉坐标，避免跳变。
 */
export function useFlipList(containerRef: RefObject<HTMLElement>, orderSignature: string): void {
  const prevTops = useRef(new Map<string, number>());
  const runningAnims = useRef(new WeakMap<HTMLElement, Animation>());

  useLayoutEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const rows = Array.from(host.querySelectorAll<HTMLElement>('[data-row-key]'));
    const nextTops = new Map<string, number>();
    // 用「内容坐标」（含滚动偏移）记录位置：拖动自动滚动时滚动量不会被误当成行位移
    const hostTop = host.getBoundingClientRect().top - host.scrollTop;

    for (const el of rows) {
      const key = el.dataset.rowKey;
      if (!key) continue;
      const curRect = el.getBoundingClientRect();
      const top = curRect.top - hostTop;
      nextTops.set(key, top);
      const oldTop = prevTops.current.get(key);
      if (oldTop === undefined) continue;
      const dy = oldTop - top;
      if (Math.abs(dy) < 1.5 || Math.abs(dy) > 480) continue;
      if (!canWebAnimate(el)) continue;

      const prevAnim = runningAnims.current.get(el);
      prevAnim?.cancel();
      const anim = el.animate(
        [
          { transform: `translate3d(0, ${dy.toFixed(1)}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: 240, easing: 'cubic-bezier(.16, 1, .3, 1)' },
      );
      runningAnims.current.set(el, anim);
    }

    prevTops.current = nextTops;
  }, [containerRef, orderSignature]);
}

/**
 * 进出分组横向滑动：direction > 0 表示进入子分组（从右滑入），< 0 表示返回上级（从左滑入）。
 * 连续快速切换时取消上一次动画，从当前位置平滑接续。
 */
export function useNavSlide(
  stageRef: RefObject<HTMLElement>,
  navKey: string,
  direction: -1 | 0 | 1,
): void {
  const animRef = useRef<Animation | null>(null);
  const firstRef = useRef(true);

  useLayoutEffect(() => {
    if (firstRef.current) {
      firstRef.current = false;
      return;
    }
    const el = stageRef.current;
    if (!el || direction === 0 || !canWebAnimate(el)) return;
    animRef.current?.cancel();
    const dx = direction > 0 ? 18 : -18;
    animRef.current = el.animate(
      [
        { opacity: 0.25, transform: `translate3d(${dx}px, 0, 0)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ],
      { duration: 200, easing: 'cubic-bezier(.16, 1, .3, 1)' },
    );
  }, [stageRef, navKey, direction]);
}
