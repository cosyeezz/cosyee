// 数字从 0 缓出滚动到目标值（数据唤醒）。只在 play 变为 true 时从 0 滚一次；之后数值再变（切换会话、刷新），
// 从当前显示的数平滑滚到新值（retween 毫秒），不会跳，也不会再从 0 开始。
// 滚动期间直接改文本，不触发 React 重渲染；减少动效 / 测试环境（没有 element.animate）里直接显示终值。
import { useLayoutEffect, useRef } from 'react';
import { canAnimate, reducedMotion } from './reduced';

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

export function CountUp({
  value,
  format,
  play,
  duration = 900,
  delay = 0,
  retween = 520,
  className,
  testId,
}: {
  value: number;
  format: (n: number) => string;
  play: boolean;
  duration?: number;
  delay?: number;
  /** 数值变化时从旧值滚到新值的时长 */
  retween?: number;
  className?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const valueRef = useRef(value);
  const formatRef = useRef(format);
  valueRef.current = value;
  formatRef.current = format;
  /** 屏幕上现在显示的数 */
  const shown = useRef(value);
  /** 正在进行的滚动：{ raf, to }；to 是这次滚向的目标 */
  const run = useRef<{ raf: number; to: number } | null>(null);

  const roll = (el: HTMLElement, from: number, to: number, ms: number, wait: number) => {
    if (run.current) cancelAnimationFrame(run.current.raf);
    const start = performance.now() + wait;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      const n = t >= 1 ? to : from + (to - from) * easeOutQuart(t);
      shown.current = n;
      el.textContent = formatRef.current(n);
      if (t < 1 && run.current) run.current.raf = requestAnimationFrame(tick);
      else run.current = null;
    };
    shown.current = from;
    el.textContent = formatRef.current(from);
    run.current = { raf: requestAnimationFrame(tick), to };
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!play || !el || reducedMotion() || !canAnimate(el)) return;
    roll(el, 0, valueRef.current, duration, delay);
    return () => {
      if (run.current) cancelAnimationFrame(run.current.raf);
      run.current = null;
      shown.current = valueRef.current;
      el.textContent = formatRef.current(valueRef.current);
    };
  }, [play]); // eslint-disable-line react-hooks/exhaustive-deps

  // 数值变化：从当前显示的数滚过去（React 已经把文本写成了终值，这里在绘制前改回起点）
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (run.current?.to === value) return;
    if (reducedMotion() || !canAnimate(el) || shown.current === value) {
      if (run.current) cancelAnimationFrame(run.current.raf);
      run.current = null;
      shown.current = value;
      return;
    }
    roll(el, shown.current, value, retween, 0);
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  useLayoutEffect(() => () => { if (run.current) cancelAnimationFrame(run.current.raf); }, []);

  return (
    <span ref={ref} className={className} data-testid={testId}>
      {format(value)}
    </span>
  );
}
