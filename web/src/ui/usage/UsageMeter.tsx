// 输入框右下角的订阅额度：一个小圆环（颜色随最紧张的那条限制变化），点开看当前会话 / 本周 / 模型专属额度。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { UsageInfo, UsageLimit } from '@cosyee/shared';
import { leavingProps, usePresence } from '../motion/usePresence';
import { useDismiss } from '../sidebar/useDismiss';
import { limitTitle, resetText, worstLimit } from './format';
import './UsageMeter.css';

export interface UsageMeterProps {
  /** 取额度；换成另一个函数（会话 / 账号变了）时重新取，并丢弃旧函数的结果 */
  load: (refresh: boolean) => Promise<UsageInfo | null>;
  /** 一轮结束（running 由 true 变 false）时重新取一次 */
  running: boolean;
}

const RING_R = 6.5;
const RING_C = 2 * Math.PI * RING_R;

function Bar({ l }: { l: UsageLimit }) {
  const segs = l.kind === 'weekly' ? l.shares ?? [] : [];
  const segTotal = Math.min(l.percent, segs.reduce((a, s) => a + s.percent, 0));
  const note = l.kind === 'scoped' && l.allowance != null ? `最多可使用您每周限额的 ${l.allowance}%` : null;
  return (
    <div className={`cz-usage__row is-${l.severity}`}>
      <div className="cz-usage__label">
        <div className="cz-usage__title">{limitTitle(l)}</div>
        {note && <div className="cz-usage__sub">{note}</div>}
        <div className="cz-usage__sub">{resetText(l.resetsAt)}</div>
      </div>
      <div className="cz-usage__track" role="progressbar" aria-valuenow={l.percent} aria-valuemin={0} aria-valuemax={100}>
        <div className="cz-usage__fill" style={{ width: `${l.percent}%` }} />
        {/* 每周额度里被模型专属额度占掉的部分，用较浅的颜色盖在前面 */}
        {segTotal > 0 && <div className="cz-usage__fill cz-usage__fill--share" style={{ width: `${segTotal}%` }} />}
      </div>
      <div className="cz-usage__pct">已使用 {l.percent}%</div>
    </div>
  );
}

export function UsageMeter({ load, running }: UsageMeterProps) {
  const [info, setInfo] = useState<UsageInfo | null>(null);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  /** load 换了（并行模式下切到另一个账号的会话）就递增：旧 load 的迟到结果丢掉，新 load 的第一次结果即使为空也要替换 */
  const gen = useRef(0);
  const fetchIt = useCallback((refresh: boolean, replace = false) => {
    const g = gen.current;
    load(refresh)
      .then((u) => {
        if (!alive.current || g !== gen.current) return;
        if (u || replace) setInfo(u);
      })
      .catch(() => { /* 保留上一次的数据 */ });
  }, [load]);

  useEffect(() => {
    gen.current++;
    fetchIt(false, true);
  }, [fetchIt]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) fetchIt(true);
    wasRunning.current = running;
  }, [running, fetchIt]);

  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, boxRef, close);
  const { mounted, leaving } = usePresence(open, panelRef);

  const worst = info ? worstLimit(info.limits) : null;
  const pct = worst?.percent ?? 0;

  // 没有订阅额度（API / Kiro 账号返回 null，或没有任何限制）就不显示圆环
  if (!info || info.limits.length === 0) return null;

  return (
    <div className="cz-usage" ref={boxRef}>
      <button
        type="button"
        className={`cz-usage__btn is-${worst?.severity ?? 'normal'}${open ? ' is-open' : ''}`}
        title={worst ? `订阅额度：${limitTitle(worst)}已使用 ${pct}%` : '订阅额度'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          if (!open) fetchIt(true);
          setOpen((v) => !v);
        }}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="cz-usage__ring-bg" cx="9" cy="9" r={RING_R} fill="none" strokeWidth="2" />
          <circle
            className="cz-usage__ring"
            cx="9"
            cy="9"
            r={RING_R}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={`${(RING_C * pct) / 100} ${RING_C}`}
            transform="rotate(-90 9 9)"
          />
        </svg>
      </button>
      {mounted && (
        <div ref={panelRef} className={`cz-usage__panel cz-pop${leaving ? ' is-leaving' : ''}`} role="dialog" aria-label="订阅额度" {...leavingProps(leaving)}>
          {info.limits.map((l, i) => <Bar key={`${l.kind}:${l.model ?? ''}:${i}`} l={l} />)}
        </div>
      )}
    </div>
  );
}
