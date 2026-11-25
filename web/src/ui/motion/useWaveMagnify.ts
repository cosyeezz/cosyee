// 竖排列表的波浪放大：按光标到每一行中心的距离连续算放大量，写进行上的 --m（0~1），
// 光标在列表里上下划过、或滚轮让行从光标下滚过时，放大像波浪一样依次经过各行。
// 只写 CSS 变量、不触发 React 渲染；pointermove / scroll 用 rAF 合并。具体怎么放大由 CSS 读 --m 决定。
// 触屏（非鼠标指针）和减少动效时不放大。
import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import { reducedMotion } from './reduced';

export interface WaveMagnifyOptions {
  /** 行的选择器（在列表容器里查找） */
  rowSelector: string;
  /** 影响半径（px）：离光标超过这个距离的行不放大 */
  radius?: number;
}

/** 距离 → 放大量：中心为 1，到半径处平滑降到 0（两端导数都是 0，波峰圆润、边缘不突兀） */
export function waveAmount(distance: number, radius: number): number {
  const t = Math.abs(distance) / radius;
  if (t >= 1) return 0;
  const k = 1 - t * t;
  return k * k;
}

export function useWaveMagnify<T extends HTMLElement>({ rowSelector, radius = 84 }: WaveMagnifyOptions) {
  const ref = useRef<T>(null);
  /** 光标的视口 y；null = 光标不在列表上 */
  const pointerY = useRef<number | null>(null);
  const frame = useRef(0);

  const apply = useCallback(() => {
    frame.current = 0;
    const host = ref.current;
    if (!host) return;
    const y = pointerY.current;
    for (const row of host.querySelectorAll<HTMLElement>(rowSelector)) {
      let m = 0;
      if (y !== null) {
        const r = row.getBoundingClientRect();
        m = waveAmount(y - (r.top + r.height / 2), radius);
      }
      const v = m < 0.005 ? '0' : m.toFixed(3);
      if (row.style.getPropertyValue('--m') !== v) row.style.setProperty('--m', v);
    }
  }, [rowSelector, radius]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(apply);
  }, [apply]);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || reducedMotion()) return;
    pointerY.current = e.clientY;
    schedule();
  }, [schedule]);
  const onPointerLeave = useCallback(() => {
    if (pointerY.current === null) return;
    pointerY.current = null;
    schedule();
  }, [schedule]);
  // 滚轮滚动：光标没动，行从它下面滚过去，按原来的光标位置重算
  const onScroll = useCallback(() => {
    if (pointerY.current !== null) schedule();
  }, [schedule]);

  return { ref, onPointerMove, onPointerLeave, onScroll };
}
