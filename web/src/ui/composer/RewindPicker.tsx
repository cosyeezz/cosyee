// 双击 Esc 打开的「回退到哪条消息」选择浮层：浮在输入框上方，列出可回退的用户消息（旧 → 新），默认选中最新一条。
// 键盘（↑↓ 选择、Enter 确认、Esc 关闭）在 document 捕获阶段统一处理，不抢编辑区焦点；鼠标点击也可直接确认。
import { useEffect, useRef, useState } from 'react';

export interface RewindTarget {
  /** 用户消息 id（Turn.userId） */
  id: string;
  /** 显示用的消息正文（标签处为占位名） */
  text: string;
}

export interface RewindPickerProps {
  items: RewindTarget[];
  onPick: (id: string) => void;
  onClose: () => void;
}

/** 单行显示：取首个非空行 */
function oneLine(text: string): string {
  const line = text.split('\n').find((l) => l.trim()) ?? '';
  return line.trim() || '（空消息）';
}

export function RewindPicker({ items, onPick, onClose }: RewindPickerProps) {
  const [idx, setIdx] = useState(Math.max(0, items.length - 1));
  const activeRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ items, idx, onPick, onClose });
  latest.current = { items, idx, onPick, onClose };

  useEffect(() => { activeRef.current?.scrollIntoView?.({ block: 'nearest' }); }, [idx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const { items: list, idx: cur, onPick: pick, onClose: close } = latest.current;
      const swallow = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        swallow();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setIdx((i) => Math.min(list.length - 1, Math.max(0, i + d)));
      } else if (e.key === 'Enter') {
        swallow();
        const it = list[Math.min(cur, list.length - 1)];
        if (it) pick(it.id);
      } else if (e.key === 'Escape') {
        swallow();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="cz-rewind" role="listbox" aria-label="回退到消息" onMouseDown={(e) => e.preventDefault()}>
      <div className="cz-rewind__title">回退到哪条消息？（↑↓ 选择，Enter 确认，Esc 取消）</div>
      <div className="cz-rewind__list">
        {items.map((it, i) => (
          <div
            key={it.id}
            ref={i === idx ? activeRef : undefined}
            role="option"
            aria-selected={i === idx}
            className={`cz-rewind__item${i === idx ? ' is-active' : ''}`}
            title={it.text}
            onMouseEnter={() => setIdx(i)}
            onClick={() => onPick(it.id)}
          >
            {oneLine(it.text)}
          </div>
        ))}
      </div>
      <div className="cz-rewind__note">该消息及之后的对话将从上下文中移除，原文会填回输入框</div>
    </div>
  );
}
