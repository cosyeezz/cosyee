// 「实际请求模型」那一栏的输入框 + 下拉：可直接手输，也可从拉取到的模型列表里挑（带搜索）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDismiss } from './useDismiss';

export interface ModelPickerProps {
  value: string;
  onChange: (v: string) => void;
  /** 拉取到的模型 id；空数组 = 还没拉取，只能手输 */
  options: string[];
  placeholder?: string;
  ariaLabel: string;
}

export function ModelPicker({ value, onChange, options, placeholder, ariaLabel }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  useDismiss(open, wrapRef, () => setOpen(false));

  useEffect(() => {
    if (open) searchRef.current?.focus();
    else setQ('');
  }, [open]);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.toLowerCase().includes(s)) : options;
  }, [options, q]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <div ref={wrapRef} className="cz-mmap__picker">
      <input
        className="cz-acct-dlg__input cz-mmap__input"
        value={value}
        maxLength={120}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className={`cz-mmap__caret${open ? ' is-on' : ''}`}
        disabled={!options.length}
        title={options.length ? '从拉取到的模型列表里选' : '先点「获取模型列表」'}
        aria-label="选择模型"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 6.5 8 10.5 12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="cz-mmap__drop" role="listbox" aria-label={`${ariaLabel}：候选`}>
          <input
            ref={searchRef}
            className="cz-mmap__search"
            value={q}
            placeholder="搜索模型…"
            aria-label="搜索模型"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
              if (e.key === 'Enter' && hits.length === 1) pick(hits[0]!);
            }}
          />
          <div className="cz-mmap__list">
            {hits.length === 0 && <div className="cz-mmap__empty">没有匹配的模型</div>}
            {hits.map((o) => (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={o === value}
                className={`cz-mmap__opt${o === value ? ' is-on' : ''}`}
                onClick={() => pick(o)}
              >
                {o}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
