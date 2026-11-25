// 上下文栏的折叠小节：整行标题可点，箭头旋转，内容展开 / 收起；退场播完才卸载。
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import { motionOK } from '../motion/reduced';
import { leavingProps, usePresence } from '../motion/usePresence';

const REVEAL_MS = 220;

/** 展开 / 收起一块内容（样式见 ContextPanel.css 的 .cz-ctx__reveal）；用 transition，中途反向会从当前高度接着走 */
export function Reveal({ open, id, children }: { open: boolean; id?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, leaving } = usePresence(open, ref, REVEAL_MS);
  if (!mounted) return null;
  return (
    <div ref={ref} id={id} className={`cz-ctx__reveal${leaving ? ' is-leaving' : ''}`} {...leavingProps(leaving)}>
      <div className="cz-ctx__reveal-in">{children}</div>
    </div>
  );
}

/** 旋转箭头：收起朝右，展开朝下 */
export function Chevron({ open, size = 14 }: { open: boolean; size?: number }) {
  return (
    <span className={`cz-ctx__chev${open ? ' is-open' : ''}`} aria-hidden="true">
      <Icon name="chevron-right" size={size} />
    </span>
  );
}

export function Fold({
  title, count, extra, open, onToggle, className, children,
}: {
  title: string;
  /** 条目数；0 时不可展开。不传则不显示数字、总能展开 */
  count?: number;
  /** 标题右侧的摘要（如「3 开」），放不下时省略 */
  extra?: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const ref = useRef<HTMLElement>(null);
  const shown = open && count !== 0;
  const was = useRef(shown);
  // 靠近底部的小节展开后内容在可视区外：展开完滚进来（比可视区高的则保持标题在上）
  useEffect(() => {
    const opened = shown && !was.current;
    was.current = shown;
    if (!opened) return;
    const smooth = motionOK();
    const t = window.setTimeout(
      () => ref.current?.scrollIntoView?.({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' }),
      smooth ? REVEAL_MS : 0,
    );
    return () => window.clearTimeout(t);
  }, [shown]);

  // 标题有没有真的吸在顶上：吸住时比滚动区上沿高 1px，恰好露不全
  const btn = useRef<HTMLButtonElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = btn.current;
    const root = el?.closest('.cz-ctx__body');
    if (!shown || !el || !root || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (es) => {
        const e = es[es.length - 1];
        setStuck(!!e && e.isIntersecting && e.intersectionRatio < 1 && !!e.rootBounds && e.boundingClientRect.top < e.rootBounds.top);
      },
      { root, threshold: [0, 1] },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      setStuck(false);
    };
  }, [shown]);

  return (
    <section ref={ref} className={`cz-ctx__section cz-ctx__section--fold${shown ? ' is-open' : ''}${className ? ` ${className}` : ''}`}>
      <button
        ref={btn}
        type="button"
        className={`cz-ctx__fold${stuck ? ' is-stuck' : ''}`}
        onClick={onToggle}
        aria-expanded={shown}
        aria-controls={shown ? id : undefined}
        disabled={count === 0}
      >
        <Chevron open={shown} />
        <span className="cz-ctx__fold-title">{title}</span>
        {extra && count !== 0 && <span className="cz-ctx__fold-extra" title={extra}>{extra}</span>}
        {count !== undefined && <span className="cz-ctx__fold-count">{count}</span>}
      </button>
      <Reveal open={shown} id={id}>{children}</Reveal>
    </section>
  );
}
