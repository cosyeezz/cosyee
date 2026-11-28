// 额度窗口百分比走势图：手画 SVG 折线 + 面积渐变，x 轴为窗口 start → end，当前窗口标「现在」虚线。
// 动效（interaction-motion #6 数据唤醒）：折线使用 pathLength="1" + stroke-dashoffset 从左向右绘制（560ms ease-out），
// 面积与数据点错开淡入；不跟随 prefers-reduced-motion，始终开启。
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { LedgerSnapshotPoint } from '@cosyee/shared';
import { formatClockTime } from './format';

const DEFAULT_W = 520;
const H = 136;
const PAD_L = 38;
const PAD_R = 14;
const PAD_T = 18;
const PAD_B = 24;

export interface SnapshotChartProps {
  start: number;
  end: number;
  current: boolean;
  snapshots: readonly LedgerSnapshotPoint[];
  now?: number;
}

export function SnapshotChart({ start, end, current, snapshots, now = Date.now() }: SnapshotChartProps) {
  const gradId = useId();
  const plotRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [plotW, setPlotW] = useState(DEFAULT_W);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // 让 SVG viewBox 宽度与容器实际像素宽度 1:1 对齐，保证坐标轴文字与线宽在桌面/手机下恒定不变形
  useEffect(() => {
    const el = plotRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w >= 120) setPlotW(w);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = plotW;
  const span = Math.max(1, end - start);
  const innerW = Math.max(1, W - PAD_L - PAD_R);
  const innerH = H - PAD_T - PAD_B;
  const xOf = (t: number) => PAD_L + Math.max(0, Math.min(1, (t - start) / span)) * innerW;
  const yOf = (pct: number) => PAD_T + (1 - Math.max(0, Math.min(100, pct)) / 100) * innerH;

  const pts = useMemo(() => {
    const sorted = [...snapshots].sort((a, b) => a.at - b.at);
    return sorted.map((s) => ({
      ...s,
      x: xOf(s.at),
      y: yOf(s.percent),
    }));
  }, [snapshots, start, end, W]); // eslint-disable-line react-hooks/exhaustive-deps

  const linePath = useMemo(() => {
    if (pts.length === 0) return '';
    return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  }, [pts]);

  const areaPath = useMemo(() => {
    if (pts.length < 2) return '';
    const base = PAD_T + innerH;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    return `${linePath} L${last.x.toFixed(1)},${base.toFixed(1)} L${first.x.toFixed(1)},${base.toFixed(1)} Z`;
  }, [pts, linePath, innerH]);

  const showNow = current && now >= start && now <= end;
  const nowX = showNow ? xOf(now) : null;

  if (pts.length === 0) {
    return (
      <div className="cz-ledger-chart cz-ledger-chart--empty">
        <span>本窗口暂无额度快照，无法绘制百分比走势</span>
      </div>
    );
  }

  const pickAt = (clientX: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    const svgX = ((clientX - box.left) / box.width) * W;
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.abs(pts[i]!.x - svgX);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    setHoverIdx(best);
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => pickAt(e.clientX);
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const cur = hoverIdx ?? pts.length - 1;
    if (e.key === 'ArrowLeft') setHoverIdx(Math.max(0, cur - 1));
    else if (e.key === 'ArrowRight') setHoverIdx(Math.min(pts.length - 1, cur + 1));
    else if (e.key === 'Home') setHoverIdx(0);
    else if (e.key === 'End') setHoverIdx(pts.length - 1);
    else if (e.key === 'Escape') setHoverIdx(null);
    else return;
    e.preventDefault();
  };

  const active = hoverIdx !== null ? pts[hoverIdx] ?? null : null;
  const tipLeftPct = active ? Math.max(12, Math.min(88, (active.x / W) * 100)) : 50;

  return (
    <div className="cz-ledger-chart">
      <div className="cz-ledger-chart__head">
        <span className="cz-ledger-chart__label">额度使用曲线</span>
        <span className="cz-ledger-chart__legend">
          <span className="cz-ledger-chart__leg-item">
            <i className="cz-ledger-chart__dot is-event" aria-hidden="true" />事件
          </span>
          <span className="cz-ledger-chart__leg-item">
            <i className="cz-ledger-chart__dot is-probe" aria-hidden="true" />探测
          </span>
        </span>
      </div>
      <div ref={plotRef} className="cz-ledger-chart__plot">
        <svg
          ref={svgRef}
          className="cz-ledger-chart__svg"
          viewBox={`0 0 ${W} ${H}`}
          height={H}
          role="img"
          aria-label={`额度使用曲线，共 ${pts.length} 个快照点，最新 ${Math.round(pts[pts.length - 1]!.percent)}%`}
          tabIndex={0}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverIdx(null)}
          onBlur={() => setHoverIdx(null)}
          onKeyDown={onKeyDown}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {/* 水平参考线：0% / 50% / 100% */}
          {[0, 50, 100].map((v) => {
            const y = yOf(v);
            return (
              <g key={v}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={W - PAD_R}
                  y2={y}
                  className="cz-ledger-chart__grid"
                />
                <text x={PAD_L - 6} y={y + 3} textAnchor="end" className="cz-ledger-chart__axis">
                  {v}%
                </text>
              </g>
            );
          })}

          {/* 当前时刻竖向虚线 */}
          {nowX !== null && (
            <g className="cz-ledger-chart__now">
              <line x1={nowX} y1={PAD_T - 2} x2={nowX} y2={PAD_T + innerH} className="cz-ledger-chart__now-line" />
              <text
                x={Math.min(W - PAD_R - 14, Math.max(PAD_L + 14, nowX))}
                y={PAD_T - 4}
                textAnchor="middle"
                className="cz-ledger-chart__now-label"
              >
                现在
              </text>
            </g>
          )}

          {/* 面积与折线 */}
          {areaPath && <path d={areaPath} fill={`url(#${gradId})`} className="cz-ledger-chart__area" />}
          {pts.length >= 2 && (
            <path d={linePath} pathLength={1} className="cz-ledger-chart__line" />
          )}

          {/* 悬停竖线 */}
          {active && (
            <line
              x1={active.x}
              y1={PAD_T}
              x2={active.x}
              y2={PAD_T + innerH}
              className="cz-ledger-chart__hover-line"
            />
          )}

          {/* 快照数据点 */}
          {pts.map((p, i) => {
            const isActive = hoverIdx === i;
            return (
              <circle
                key={`${p.at}-${i}`}
                cx={p.x}
                cy={p.y}
                r={isActive ? 4.2 : 2.6}
                className={`cz-ledger-chart__pt is-${p.source}${isActive ? ' is-active' : ''}`}
              />
            );
          })}

          {/* x 轴起止时间 */}
          <text x={PAD_L} y={H - 5} textAnchor="start" className="cz-ledger-chart__axis">
            {formatClockTime(start, span)}
          </text>
          <text x={W - PAD_R} y={H - 5} textAnchor="end" className="cz-ledger-chart__axis">
            {formatClockTime(end, span)}
          </text>
        </svg>

        {active && (
          <div
            className="cz-ledger-chart__tip"
            style={{ left: `${tipLeftPct}%` }}
            role="status"
          >
            <strong>{Math.round(active.percent)}%</strong>
            <span>{formatClockTime(active.at, span)}</span>
            <span className="cz-ledger-chart__tip-src">{active.source === 'event' ? '事件' : '探测'}</span>
          </div>
        )}
      </div>
    </div>
  );
}
