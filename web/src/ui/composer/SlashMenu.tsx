// `/` 命令菜单：浮在输入框上方。不接管焦点，键盘由 Composer 的编辑区统一处理。
import { useEffect, useRef } from 'react';
import type { SlashItem } from './slash';

export interface SlashMenuProps {
  items: SlashItem[];
  activeIndex: number;
  onHover: (i: number) => void;
  onPick: (item: SlashItem) => void;
}

export function SlashMenu({ items, activeIndex, onHover, onPick }: SlashMenuProps) {
  const activeRef = useRef<HTMLDivElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [activeIndex]);
  const firstSkill = items.findIndex((i) => i.group === 'skill');
  const firstCmd = items.findIndex((i) => i.group === 'command');
  return (
    <div className="cz-slash" role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {items.map((it, i) => (
        <div key={`${it.group}:${it.name}`}>
          {i === firstCmd && <div className="cz-slash__group">命令</div>}
          {i === firstSkill && <div className="cz-slash__group">Skill</div>}
          <div
            ref={i === activeIndex ? activeRef : undefined}
            role="option"
            aria-selected={i === activeIndex}
            className={`cz-slash__item${i === activeIndex ? ' is-active' : ''}`}
            onMouseEnter={() => onHover(i)}
            onClick={() => onPick(it)}
          >
            <span className="cz-slash__name">/{it.name}</span>
            {it.group === 'skill' && <span className="cz-slash__tag">skill</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
