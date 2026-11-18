// 「搜索」导航行：平时是一行普通的侧栏行，点击后变成行内输入框；Esc 或失焦且为空时还原。
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';

export interface SearchRowProps {
  value: string;
  onChange: (v: string) => void;
  /** 未展开时显示的文字，也是输入框的占位符 */
  label?: string;
  ariaLabel?: string;
}

export function SearchRow({ value, onChange, label = '搜索', ariaLabel }: SearchRowProps) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const show = editing || value !== '';

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!show) {
    return (
      <button type="button" className="cz-sidebar__nav" onClick={() => setEditing(true)} aria-label={ariaLabel ?? label}>
        <Icon name="search" size={16} />
        <span>{label}</span>
      </button>
    );
  }

  return (
    <div className="cz-sidebar__nav cz-sidebar__nav--input">
      <Icon name="search" size={16} />
      <input
        ref={inputRef}
        className="cz-sidebar__search-input"
        type="text"
        value={value}
        placeholder={label}
        aria-label={ariaLabel ?? label}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (value === '') setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onChange('');
            setEditing(false);
          }
        }}
      />
    </div>
  );
}
