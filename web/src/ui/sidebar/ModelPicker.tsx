// 「实际请求模型」那一栏的输入框 + 下拉：可直接手输，也可从拉取到的模型列表里挑（带搜索）。
// 下拉和输入框同宽；下方（到滚动容器 / 窗口底边）放不下时往上弹出。键盘：搜索框里 ↓ 进入候选，候选间 ↑↓ 移动，Esc 收起并回到下拉按钮。
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useDismiss } from './useDismiss';

export interface ModelPickerProps {
  value: string;
  onChange: (v: string) => void;
  /** 拉取到的模型 id；空数组 = 还没拉取，只能手输 */
  options: string[];
  placeholder?: string;
  ariaLabel: string;
  /** 在输入框里按回车（比如「添加一个模型…」回车直接添加） */
  onEnter?: () => void;
}

/** 下拉大约要占的高度：搜索框 + 最多 240px 的列表 + 内边距 */
const DROP_H = 290;

/** 最近的会滚动的祖先（对话框内容区），没有就是窗口 */
function scrollBox(el: HTMLElement): { top: number; bottom: number } {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy === 'auto' || oy === 'scroll') {
      const r = p.getBoundingClientRect();
      return { top: Math.max(r.top, 0), bottom: Math.min(r.bottom, window.innerHeight) };
    }
  }
  return { top: 0, bottom: window.innerHeight };
}

export function ModelPicker({ value, onChange, options, placeholder, ariaLabel, onEnter }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const caretRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDismiss(open, wrapRef, () => setOpen(false));

  // 打开前量一下：下方放不下、上方更宽裕就往上弹
  useLayoutEffect(() => {
    if (!open || !wrapRef.current) return;
    const r = wrapRef.current.getBoundingClientRect();
    const box = scrollBox(wrapRef.current);
    const below = box.bottom - r.bottom;
    const above = r.top - box.top;
    setUp(below < DROP_H && above > below);
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus({ preventScroll: true });
    else setQ('');
  }, [open]);

  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? options.filter((o) => o.toLowerCase().includes(s)) : options;
  }, [options, q]);

  const pick = (id: string) => {
    onChange(id);
    closeToCaret(); // 候选按钮马上卸载，焦点先还给下拉按钮，别掉到 body
  };

  const closeToCaret = () => {
    setOpen(false);
    caretRef.current?.focus();
  };

  const optionButtons = () => Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('.cz-mmap__opt') ?? []);

  const onSearchKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeToCaret(); }
    else if (e.key === 'Enter' && hits.length === 1) { e.preventDefault(); pick(hits[0]!); } // 不拦的话这次回车会接着点开刚拿到焦点的下拉按钮
    else if (e.key === 'ArrowDown') { e.preventDefault(); optionButtons()[0]?.focus(); }
  };

  const onListKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeToCaret(); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = optionButtons();
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
    if (next < 0) searchRef.current?.focus();
    else btns[Math.min(next, btns.length - 1)]?.focus();
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
        title={value || undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(); }
          else if (e.key === 'ArrowDown' && e.altKey && options.length) { e.preventDefault(); setOpen(true); }
        }}
      />
      <button
        ref={caretRef}
        type="button"
        className={`cz-mmap__caret${open ? ' is-on' : ''}`}
        disabled={!options.length}
        title={options.length ? '从拉取到的模型列表里选' : '先点「获取模型列表」'}
        aria-label="选择模型"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 6.5 8 10.5 12 6.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div
          className={`cz-mmap__drop cz-pop${up ? ' is-up' : ''}`}
          style={{ '--pop-origin': up ? 'bottom right' : 'top right', '--pop-dy': up ? '4px' : '-4px' } as CSSProperties}
        >
          <input
            ref={searchRef}
            className="cz-mmap__search"
            value={q}
            placeholder="搜索模型…"
            aria-label="搜索模型"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
          />
          <div ref={listRef} className="cz-mmap__list" role="listbox" aria-label={`${ariaLabel}：候选`} onKeyDown={onListKey}>
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
