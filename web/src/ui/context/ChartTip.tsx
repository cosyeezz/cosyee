// 图表气泡：以数据点为中心，但按自身实际宽度夹在图表内，任何面板宽度都不会撑出横向滚动。
import { useLayoutEffect, useRef, type ReactNode } from 'react';

export function ChartTip({ at, testId, children }: { /** 数据点的横向位置（图宽的 0–1） */ at: number; testId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  // 每次渲染都量：换到另一个点时内容（宽度）也会变
  useLayoutEffect(() => {
    const el = ref.current;
    const plot = el?.parentElement;
    if (!el || !plot) return;
    const max = Math.max(0, plot.clientWidth - el.offsetWidth);
    el.style.transform = `translate(${Math.round(Math.min(Math.max(at * plot.clientWidth - el.offsetWidth / 2, 0), max))}px, -100%)`;
  });
  return (
    <div ref={ref} className="cz-ctx__cache-tip" role="status" data-testid={testId}>
      {children}
    </div>
  );
}
