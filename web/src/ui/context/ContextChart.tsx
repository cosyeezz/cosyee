// 上下文走势：每次 API 请求一根柱子，高度 = 这次送给模型的输入总量（未缓存 + 写缓存 + 读缓存）。
// 比上一次涨了很多的柱子用警示色；悬停看数值，点击在图下方列出这次增长来自哪些工具。
// 数据与缓存命中率走势共用（SessionMeta.cache）。
import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { CachePoint, Turn } from '@cosyee/shared';
import { CountUp } from '../motion/CountUp';
import { ChartTip } from './ChartTip';
import { formatTokens } from './formatTokens';
import { growthOf, inputOf } from './contextGrowth';

const W = 280;
const H = 76;
const PAD_X = 6;
const PAD_TOP = 8;
const PAD_BOTTOM = 8;
/** 比上一次多出这么多 token 就算「打大了」，柱子标警示色 */
export const JUMP_TOKENS = 5000;

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${formatTokens(Math.abs(n))}`;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** intro：面板的数据唤醒期间为 true，最新值滚上来，柱子从左到右依次长出（样式见 ContextPanel.css 的 is-waking） */
export function ContextChart({
  points,
  turns,
  intro = false,
}: {
  points: CachePoint[] | undefined;
  turns: Turn[] | undefined;
  intro?: boolean;
}) {
  const list = points ?? [];
  const [hover, setHover] = useState<number | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const geo = useMemo(() => {
    const n = list.length;
    const innerW = W - PAD_X * 2;
    const innerH = H - PAD_TOP - PAD_BOTTOM;
    const vals = list.map(inputOf);
    const max = Math.max(1, ...vals);
    const slot = innerW / Math.max(n, 1);
    const bw = Math.max(1, Math.min(14, slot > 3 ? slot - 1 : slot));
    const cx = list.map((_, i) => PAD_X + slot * (i + 0.5));
    const hs = vals.map((v) => Math.max(1, (innerH * v) / max));
    const deltas = vals.map((v, i) => (i === 0 ? 0 : v - vals[i - 1]!));
    return { vals, cx, hs, bw, deltas, base: PAD_TOP + innerH };
  }, [list]);

  if (list.length === 0) {
    return <div className="cz-ctx__cache-empty">发送消息后，这里显示每次请求的上下文大小</div>;
  }

  const last = list.length - 1;
  const sel = selId ? list.findIndex((p) => p.id === selId) : -1;
  // 最大的一次增长（第一次请求不算）
  let top = -1;
  for (let i = 1; i < list.length; i++) if (geo.deltas[i]! > 0 && (top < 0 || geo.deltas[i]! > geo.deltas[top]!)) top = i;

  /** 指针位置 → 第几根柱子（按等宽槽位） */
  const indexAt = (clientX: number): number | null => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return null;
    const x = ((clientX - box.left) / box.width) * W;
    return Math.min(last, Math.max(0, Math.floor(((x - PAD_X) / (W - PAD_X * 2)) * list.length)));
  };
  const pick = (e: PointerEvent<SVGSVGElement>) => setHover(indexAt(e.clientX));
  const toggle = (i: number) => setSelId((cur) => (cur === list[i]!.id ? null : list[i]!.id));
  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    const at = hover ?? (sel >= 0 ? sel : last);
    if (e.key === 'ArrowLeft') setHover(Math.max(0, at - 1));
    else if (e.key === 'ArrowRight') setHover(Math.min(last, at + 1));
    else if (e.key === 'Home') setHover(0);
    else if (e.key === 'End') setHover(last);
    else if (e.key === 'Enter' || e.key === ' ') toggle(at);
    else if (e.key === 'Escape') { setHover(null); setSelId(null); }
    else return;
    e.preventDefault();
  };

  const label =
    `上下文走势，共 ${list.length} 次请求，最新 ${formatTokens(geo.vals[last]!)}` +
    (top > 0 ? `，最大增长 ${signed(geo.deltas[top]!)}（第 ${top + 1} 次请求）` : '') +
    '。左右键选择，回车查看这次增长来自哪些工具';
  const tipAt = hover === null ? 0 : geo.cx[hover]! / W;
  const growth = sel >= 0 ? growthOf(list, sel, turns ?? []) : null;

  return (
    <div className="cz-ctx__cache">
      <div className="cz-ctx__cache-head">
        <CountUp className="cz-ctx__cache-now" testId="ctx-now" value={geo.vals[last]!} format={formatTokens} play={intro} delay={160} />
        <span className="cz-ctx__cache-sub">最新一次请求</span>
        {top > 0 && (
          <button type="button" className="cz-ctx__link cz-ctx__grow-top" onClick={() => setSelId(list[top]!.id)}>
            最大增长 {signed(geo.deltas[top]!)}
          </button>
        )}
      </div>
      <div className="cz-ctx__cache-plot">
        <svg
          ref={svgRef}
          className="cz-ctx__ctx-svg"
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
            if (i !== null) toggle(i);
          }}
        >
          <line className="cz-ctx__cache-base" x1={PAD_X} x2={W - PAD_X} y1={geo.base} y2={geo.base} />
          {list.map((p, i) => {
            const cls =
              'cz-ctx__ctx-bar' +
              (geo.deltas[i]! >= JUMP_TOKENS ? ' is-jump' : '') +
              (i === sel ? ' is-sel' : '') +
              (i === hover ? ' is-hover' : '');
            return (
              <rect
                key={p.id}
                className={cls}
                x={geo.cx[i]! - geo.bw / 2}
                y={geo.base - geo.hs[i]!}
                width={geo.bw}
                height={geo.hs[i]!}
                rx={Math.min(2, geo.bw / 2)}
                style={intro ? ({ '--k': i / Math.max(1, last) } as CSSProperties) : undefined}
              />
            );
          })}
        </svg>
        {hover !== null && (
          <ChartTip at={tipAt} testId="ctx-tip">
            <div className="cz-ctx__cache-tip-title">
              第 {list[hover]!.turn + 1} 轮 · 第 {hover + 1} 次请求
            </div>
            <div className="cz-ctx__cache-tip-row">输入 {formatTokens(geo.vals[hover]!)}</div>
            {hover > 0 && <div className="cz-ctx__cache-tip-row">较上次 {signed(geo.deltas[hover]!)}</div>}
            <div className="cz-ctx__cache-tip-row is-total">点击查看来自哪些工具</div>
          </ChartTip>
        )}
      </div>

      {growth && sel >= 0 && (
        <div className="cz-ctx__grow" data-testid="ctx-growth">
          <div className="cz-ctx__grow-head">
            <span className="cz-ctx__grow-title">
              第 {sel + 1} 次请求 · {formatTokens(geo.vals[sel]!)}
              {growth.delta !== null && (
                <span className={`cz-ctx__grow-delta${growth.delta >= JUMP_TOKENS ? ' is-jump' : ''}`}> {signed(growth.delta)}</span>
              )}
            </span>
            <button type="button" className="cz-ctx__link" onClick={() => setSelId(null)} aria-label="关闭明细">
              收起
            </button>
          </div>
          {growth.delta === null ? (
            <div className="cz-ctx__grow-note">会话的第一次请求：系统提示、工具定义和你的第一条消息</div>
          ) : growth.delta < 0 ? (
            <div className="cz-ctx__grow-note">上下文变小了（通常是压缩了会话）</div>
          ) : (
            <>
              {growth.userText !== undefined && (
                <div className="cz-ctx__grow-note">
                  新的一轮，你的消息：「{clip(growth.userText.trim() || '（空）', 60)}」
                </div>
              )}
              {growth.items.length > 0 ? (
                <>
                  <div className="cz-ctx__grow-note">上一次请求调用的工具（参数和结果都进了这次的上下文，大小为估算）：</div>
                  <ul className="cz-ctx__list cz-ctx__list--plain">
                    {growth.items.map((t) => (
                      <li key={t.id} className="cz-ctx__item">
                        <span className="cz-ctx__item-name" title={t.label}>
                          {t.label}
                        </span>
                        <span className="cz-ctx__item-tokens">约 {formatTokens(t.tokens)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                growth.userText === undefined && (
                  <div className="cz-ctx__grow-note">上一次请求没有调用工具，增长来自模型的回复（文字 / 思考）</div>
                )
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
