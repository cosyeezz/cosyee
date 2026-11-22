// 每轮花费：手写 SVG 柱状图，一轮一根柱子（主线程实色、子代理同色浅一档叠在上面）。
// 虚线 = 这一轮压缩过会话；悬停看明细，点击跳到会话流里的这一轮。框架与上下文走势共用 cz-ctx__cache-* 样式。
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { costTotal, type CompactMark, type Turn } from '@cosyee/shared';
import { COST_KINDS, formatUsd, type TurnCost } from './cost';

const W = 280;
const H = 76;
const PAD_X = 6;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function CostChart({
  turns: rows,
  flow,
  compactions,
  intro = false,
  onJump,
}: {
  /** sessionCost().turns */
  turns: readonly TurnCost[];
  /** 会话流（悬停时显示这一轮的用户消息） */
  flow?: readonly Turn[];
  compactions?: readonly CompactMark[];
  intro?: boolean;
  /** 点柱子跳到这一轮；不传则只能看 */
  onJump?: (turn: number) => void;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const n = rows.length;

  const geo = useMemo(() => {
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_TOP - PAD_BOTTOM;
    const main = rows.map((r) => costTotal(r.main));
    const sub = rows.map((r) => costTotal(r.sub));
    const vals = main.map((m, i) => m + sub[i]!);
    const max = Math.max(...vals, 1e-9);
    const slot = innerW / Math.max(n, 1);
    const bw = Math.max(1, Math.min(14, slot > 3 ? slot - 1 : slot));
    const cx = rows.map((_, i) => PAD_X + slot * (i + 0.5));
    // 有花费的轮至少 1px 高，免得便宜的轮看不见
    const hMain = main.map((v) => (v > 0 ? Math.max(1, (innerH * v) / max) : 0));
    const hSub = sub.map((v, i) => (v > 0 ? Math.max(1, (innerH * vals[i]!) / max - hMain[i]!) : 0));
    return { vals, main, sub, cx, hMain, hSub, bw, slot, base: PAD_TOP + innerH };
  }, [rows, n]);

  // 压缩标记：画在那一轮的槽位左边缘（同一轮压缩多次只画一条）
  const marks = useMemo(() => {
    const by = new Map<number, CompactMark[]>();
    for (const m of compactions ?? []) if (m.turn < n) by.set(m.turn, [...(by.get(m.turn) ?? []), m]);
    return by;
  }, [compactions, n]);

  if (n === 0 || geo.vals.every((v) => v <= 0)) {
    return <div className="cz-ctx__cache-empty">发送消息后，这里显示每轮的花费</div>;
  }

  const last = n - 1;
  let top = 0;
  for (let i = 1; i < n; i++) if (geo.vals[i]! > geo.vals[top]!) top = i;

  const indexAt = (clientX: number): number | null => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    const x = ((clientX - box.left) / box.width) * W;
    return Math.min(last, Math.max(0, Math.floor(((x - PAD_X) / (W - PAD_X * 2)) * n)));
  };
  const pick = (e: PointerEvent<SVGSVGElement>) => setHover(indexAt(e.clientX));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const at = hover ?? last;
    if (e.key === 'ArrowLeft') setHover(Math.max(0, at - 1));
    else if (e.key === 'ArrowRight') setHover(Math.min(last, at + 1));
    else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(last);
    else if ((e.key === 'Enter' || e.key === ' ') && onJump) onJump(at);
    else if (e.key === 'Escape') setHover(null);
    else return;
    e.preventDefault();
  };

  const label =
    `每轮花费，共 ${n} 轮，最近一轮 ${formatUsd(geo.vals[last]!)}，最贵的是第 ${top + 1} 轮 ${formatUsd(geo.vals[top]!)}` +
    (marks.size > 0 ? `，压缩过 ${[...marks.values()].reduce((s, l) => s + l.length, 0)} 次` : '') +
    (onJump ? '。左右键选择，回车跳到这一轮' : '');
  const tipLeft = hover === null ? 0 : Math.min(Math.max((geo.cx[hover]! / W) * 100, 18), 82);
  const row = hover !== null ? rows[hover]! : null;
  const userText = hover !== null ? flow?.[hover]?.userText : undefined;
  const hoverMarks = hover !== null ? marks.get(hover) : undefined;

  return (
    <div className="cz-ctx__cache">
      <div className="cz-ctx__cache-plot">
        <svg
          ref={svgRef}
          className={`cz-ctx__cost-svg${onJump ? '' : ' is-static'}`}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={label}
          tabIndex={0}
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
          onBlur={() => setHover(null)}
          onKeyDown={onKey}
          onClick={(e) => {
            const i = indexAt(e.clientX) ?? hover;
            if (i !== null && onJump) onJump(i);
          }}
        >
          <line className="cz-ctx__cache-base" x1={PAD_X} x2={W - PAD_X} y1={geo.base} y2={geo.base} />
          {[...marks.keys()].map((t) => {
            const x = PAD_X + geo.slot * t;
            return <line key={`c${t}`} className="cz-ctx__cost-compact" data-testid="cost-compact" x1={x} x2={x} y1={PAD_TOP - 4} y2={geo.base} />;
          })}
          {rows.map((r, i) => {
            if (geo.vals[i]! <= 0) return null;
            const x = geo.cx[i]! - geo.bw / 2;
            const rx = Math.min(2, geo.bw / 2);
            const style = intro ? ({ '--k': i / Math.max(1, last) } as CSSProperties) : undefined;
            const cls = `${i === hover ? ' is-hover' : ''}${i === top && n > 1 ? ' is-top' : ''}`;
            return (
              <g key={r.turn} className={`cz-ctx__cost-col${cls}`} style={style}>
                {geo.hMain[i]! > 0 && (
                  <rect className="cz-ctx__cost-bar" x={x} y={geo.base - geo.hMain[i]!} width={geo.bw} height={geo.hMain[i]!} rx={rx} />
                )}
                {geo.hSub[i]! > 0 && (
                  <rect
                    className="cz-ctx__cost-bar is-sub"
                    x={x}
                    y={geo.base - geo.hMain[i]! - geo.hSub[i]!}
                    width={geo.bw}
                    height={geo.hSub[i]!}
                    rx={rx}
                  />
                )}
              </g>
            );
          })}
        </svg>
        {row && hover !== null && (
          <div className="cz-ctx__cache-tip" role="status" style={{ left: `${tipLeft}%` }} data-testid="cost-tip">
            <div className="cz-ctx__cache-tip-title">
              第 {hover + 1} 轮 · {formatUsd(geo.vals[hover]!)}
            </div>
            {userText !== undefined && userText.trim() && <div className="cz-ctx__cache-tip-row is-quote">「{clip(userText.trim(), 22)}」</div>}
            <div className="cz-ctx__cache-tip-row">
              主线程 {formatUsd(geo.main[hover]!)}（{row.requests} 次请求）
            </div>
            {row.subRuns > 0 && (
              <div className="cz-ctx__cache-tip-row">
                子代理 {formatUsd(geo.sub[hover]!)}（{row.subRuns} 个）
              </div>
            )}
            {COST_KINDS.map((k) => {
              const v = row.main[k.key] + row.sub[k.key];
              return v > 0 ? (
                <div key={k.key} className="cz-ctx__cache-tip-row is-part">
                  {k.label} {formatUsd(v)}
                </div>
              ) : null;
            })}
            {hoverMarks && (
              <div className="cz-ctx__cache-tip-row">
                本轮压缩了会话{hoverMarks.length > 1 ? ` ${hoverMarks.length} 次` : ''}（{hoverMarks.some((m) => m.trigger === 'manual') ? '手动' : '自动'}）
              </div>
            )}
            {onJump && <div className="cz-ctx__cache-tip-row is-total">点击跳到这一轮</div>}
          </div>
        )}
      </div>
    </div>
  );
}
