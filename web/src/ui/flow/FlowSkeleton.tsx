// 会话加载骨架：形状和真实会话流一致（右侧用户气泡、状态行、几行答复），贴底排列，和加载完后停在底部的视图对齐。
// 所有色块共用一道斜向柔光，每 1.5 秒从左扫到右（background-attachment: fixed 让光带按视口定位，块与块之间连成一条）。
// 加载完成时骨架原地淡出，真实内容同时自上而下逐块浮现（ConversationView 的 reveal），两者交叠，不跳、不闪白。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { canAnimate, motionOK } from '../motion/reduced';
import './skeleton.css';

/** 骨架淡出的时长；内容的浮现在这段时间里同时进行 */
const LEAVE_MS = 360;

/** 两轮的形状：用户气泡宽度 + 答复各行宽度 */
const SHAPE: { bubble: string; lines: string[] }[] = [
  { bubble: '38%', lines: ['92%', '86%', '58%'] },
  { bubble: '54%', lines: ['96%', '90%', '94%', '42%'] },
];

/**
 * 加载状态 → 骨架的显示阶段。
 * 'on'：加载中；'leaving'：刚加载完，骨架正在淡出（此时 reveal 为 true，真实内容在浮现）；'off'：不显示。
 */
export function useFlowSkeleton(loading: boolean): { phase: 'on' | 'leaving' | 'off'; reveal: boolean } {
  const [prev, setPrev] = useState(loading);
  const [leaving, setLeaving] = useState(false);
  if (loading !== prev) {
    setPrev(loading);
    setLeaving(!loading && motionOK());
  }
  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(false), LEAVE_MS + 40);
    return () => window.clearTimeout(t);
  }, [leaving]);
  // 内容在加载结束的同一次渲染里挂载，reveal 只在挂载那一刻被读取
  return { phase: loading ? 'on' : leaving ? 'leaving' : 'off', reveal: leaving };
}

export function FlowSkeleton({ leaving = false }: { leaving?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  // 淡出从当前不透明度开始（加载很快时淡入可能还没走完），避免先跳到全亮再淡出
  useLayoutEffect(() => {
    const el = ref.current;
    if (!leaving || !canAnimate(el)) return;
    const from = getComputedStyle(el).opacity;
    for (const a of el.getAnimations()) a.cancel();
    el.animate([{ opacity: from }, { opacity: 0 }], { duration: LEAVE_MS, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards' });
  }, [leaving]);
  return (
    <div
      ref={ref}
      className="cz-skel"
      role={leaving ? undefined : 'status'}
      aria-label={leaving ? undefined : '正在加载会话'}
      aria-hidden={leaving || undefined}
    >
      <div className="cz-skel__column">
        {SHAPE.map((t, i) => (
          <div key={i} className="cz-skel__item">
            <div className="cz-skel__user">
              <span className="cz-skel__block cz-skel__bubble" style={{ width: t.bubble }} />
            </div>
            <div className="cz-skel__status">
              <span className="cz-skel__block cz-skel__dot" />
              <span className="cz-skel__block cz-skel__label" />
            </div>
            <div className="cz-skel__lines">
              {t.lines.map((w, j) => (
                <span key={j} className="cz-skel__block cz-skel__line" style={{ width: w }} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
