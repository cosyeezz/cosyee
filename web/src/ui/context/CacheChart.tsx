// 缓存命中率走势：手写 SVG 折线图。
// x = 第几次请求（等间距），y = 命中率 0–100%。细线、只有一条极淡的底线；
// 最新一点用实心圆点标出，旁边的大号百分比在标题行；悬停 / 键盘左右键显示十字线与明细。
import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { CachePoint } from '@cosyee/shared';
import { formatTokens } from './formatTokens';

const W = 280;
const H = 76;
const PAD_X = 6;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
const R = 4; // 标记点半径 4 → 直径 8px

const pctText = (n: number) => `${Math.round(n)}%`;

export function CacheChart({ points }: { points: CachePoint[] | undefined }) {
  const list = points ?? [];
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const geo = useMemo(() => {
    const n = list.length;
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_TOP - PAD_BOTTOM;
    const xs = list.map((_, i) => (n === 1 ? W / 2 : PAD_X + (innerW * i) / (n - 1)));
    const ys = list.map((p) => PAD_TOP + innerH * (1 - Math.min(100, Math.max(0, p.rate)) / 100));
    const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${ys[i].toFixed(1)}`).join(' ');
    const base = PAD_TOP + innerH;
    return { xs, ys, d, base };
  }, [list]);

  if (list.length === 0) {
    return <div className="cz-ctx__cache-empty">发送消息后，这里显示缓存命中率走势</div>;
  }

  const last = list.length - 1;
  const active = hover ?? last;
  const cur = list[active];
  const min = Math.min(...list.map((p) => p.rate));
  const max = Math.max(...list.map((p) => p.rate));
  const label =
    `缓存命中率走势，共 ${list.length} 次请求，最新 ${pctText(list[last].rate)}` +
    (list.length > 1 ? `，最低 ${pctText(min)}，最高 ${pctText(max)}` : '');

  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || list.length === 1) {
      setHover(list.length === 1 ? 0 : null);
      return;
    }
    const x = ((e.clientX - box.left) / box.width) * W; // 换算到 viewBox 坐标
    let best = 0;
    for (let i = 1; i < geo.xs.length; i++) if (Math.abs(geo.xs[i] - x) < Math.abs(geo.xs[best] - x)) best = i;
    setHover(best);
  };
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'ArrowLeft') setHover(Math.max(0, active - 1));
    else if (e.key === 'ArrowRight') setHover(Math.min(last, active + 1));
    else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(last);
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const total = cur.input + cur.create + cur.read;
  const tipLeft = Math.min(Math.max((geo.xs[active] / W) * 100, 18), 82); // 夹在两侧，避免溢出面板

  return (
    <div className="cz-ctx__cache">
      <div className="cz-ctx__cache-head">
        <span className="cz-ctx__cache-now" data-testid="cache-now">
          {pctText(list[last].rate)}
        </span>
        <span className="cz-ctx__cache-sub">最新一次请求</span>
      </div>
      <div className="cz-ctx__cache-plot">
        <svg
          ref={svgRef}
          className="cz-ctx__cache-svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={label}
          tabIndex={0}
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
        >
          <line className="cz-ctx__cache-base" x1={PAD_X} x2={W - PAD_X} y1={geo.base} y2={geo.base} />
          {list.length > 1 && <path className="cz-ctx__cache-line" d={geo.d} />}
          {hover !== null && (
            <line className="cz-ctx__cache-cross" x1={geo.xs[hover]} x2={geo.xs[hover]} y1={PAD_TOP} y2={geo.base} />
          )}
          {/* 最新值始终标出；悬停时再标出悬停点 */}
          <circle className="cz-ctx__cache-dot" data-testid="cache-last" cx={geo.xs[last]} cy={geo.ys[last]} r={R} />
          {hover !== null && hover !== last && (
            <circle className="cz-ctx__cache-dot is-hover" cx={geo.xs[hover]} cy={geo.ys[hover]} r={R} />
          )}
        </svg>
        {hover !== null && (
          <div className="cz-ctx__cache-tip" role="status" style={{ left: `${tipLeft}%` }} data-testid="cache-tip">
            <div className="cz-ctx__cache-tip-title">
              第 {cur.turn + 1} 轮 · 第 {active + 1} 次请求 · 命中 {cur.rate.toFixed(1)}%
            </div>
            <div className="cz-ctx__cache-tip-row">读缓存 {formatTokens(cur.read)}</div>
            <div className="cz-ctx__cache-tip-row">写缓存 {formatTokens(cur.create)}</div>
            <div className="cz-ctx__cache-tip-row">未缓存 {formatTokens(cur.input)}</div>
            <div className="cz-ctx__cache-tip-row is-total">输入合计 {formatTokens(total)}</div>
          </div>
        )}
      </div>
    </div>
  );
}
