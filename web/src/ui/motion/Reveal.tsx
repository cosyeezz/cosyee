// 通用折叠展开容器：grid-template-rows 0fr ↔ 1fr + opacity，配合 @starting-style 与 usePresence 延迟卸载。
// 中途反向高度连续不跳；退场期间 inert + aria-hidden 屏蔽交互。样式见 styles/motion.css 的 .cz-reveal。
import { useRef, type ReactNode } from 'react';
import { leavingProps, usePresence } from './usePresence';

export const REVEAL_MS = 220;

export interface RevealProps {
  open: boolean;
  id?: string;
  className?: string;
  children: ReactNode;
}

export function Reveal({ open, id, className, children }: RevealProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, leaving } = usePresence(open, ref, REVEAL_MS);
  if (!mounted) return null;
  return (
    <div
      ref={ref}
      id={id}
      className={`cz-reveal${leaving ? ' is-leaving' : ''}${className ? ` ${className}` : ''}`}
      {...leavingProps(leaving)}
    >
      <div className="cz-reveal__in">{children}</div>
    </div>
  );
}
