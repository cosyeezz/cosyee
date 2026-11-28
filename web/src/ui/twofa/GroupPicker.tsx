// 2FA 分组选择器：替代原生 <select> 的自绘下拉。树形缩进 + 文件夹图标 + 键盘导航，
// 浮层 portal 到 body（避开磨砂面板的裁切），自动翻转并钳制在视口 / 2FA 面板范围内。
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { flattenGroupTree } from '../../core/twofa/tree';
import type { TwoFaGroup } from '../../core/twofa/types';
import { Icon } from '../icons/Icon';
import { useDismiss } from '../sidebar/useDismiss';
import { inertLeaving, useAlwaysPresence } from './motion';
import './GroupPicker.css';

export interface GroupPickerProps {
  groups: TwoFaGroup[];
  /** null = 根目录（不分组） */
  value: string | null;
  onChange: (id: string | null) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}

interface Row {
  id: string | null;
  name: string;
  depth: number;
  /** 上级路径（不含自己），用于触发器里的次要文字 */
  parentPath: string;
}

const ROOT_LABEL = '根目录（不分组）';

function RootIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.6 7.2 8 2.6l5.4 4.6" />
      <path d="M4 6.4v6.2c0 .4.3.7.7.7h6.6c.4 0 .7-.3.7-.7V6.4" />
    </svg>
  );
}

export function GroupPicker({
  groups,
  value,
  onChange,
  disabled,
  placeholder = '选择分组',
  className,
  'aria-label': ariaLabel,
}: GroupPickerProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number; flip: boolean } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const uid = useId();

  const rows = useMemo<Row[]>(() => {
    const flat = flattenGroupTree(groups);
    return [
      { id: null, name: ROOT_LABEL, depth: -1, parentPath: '' },
      ...flat.map(({ group, depth, path }) => ({
        id: group.id,
        name: group.name,
        depth,
        parentPath: path.slice(0, Math.max(0, path.length - group.name.length)).replace(/ \/ $/, ''),
      })),
    ];
  }, [groups]);

  const selectedIdx = Math.max(0, rows.findIndex((r) => r.id === value));
  const hasValue = value === null || rows.some((r) => r.id === value);
  const selected = rows[selectedIdx];

  const { mounted, leaving } = useAlwaysPresence(open, popRef, 140);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, [popRef, triggerRef], close);

  const openMenu = () => {
    if (disabled) return;
    setActive(selectedIdx);
    setOpen(true);
  };

  const pick = (idx: number) => {
    const r = rows[idx];
    if (!r) return;
    onChange(r.id);
    setOpen(false);
    triggerRef.current?.focus();
  };

  // 定位：优先在触发器下方；放不下且上方更宽裕时向上翻转；水平 / 垂直都钳制在视口与所属面板内
  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const panel = t.closest('.cz-2fa-pop')?.getBoundingClientRect();
    const gap = 6;
    const pad = 8;
    const minTop = Math.max(pad, panel?.top ?? 0);
    const maxBottom = Math.min(window.innerHeight - pad, panel?.bottom ?? window.innerHeight);
    const minLeft = Math.max(pad, panel ? panel.left + 4 : 0);
    const maxRight = Math.min(window.innerWidth - pad, panel ? panel.right - 4 : window.innerWidth);
    const below = maxBottom - r.bottom - gap;
    const above = r.top - minTop - gap;
    const want = Math.min(320, rows.length * 34 + 10);
    const flip = below < Math.min(want, 180) && above > below;
    const room = Math.max(120, flip ? above : below);
    const width = Math.min(Math.max(r.width, 220), maxRight - minLeft);
    const left = Math.min(Math.max(minLeft, r.left), maxRight - width);
    const h = Math.min(want, room, 320);
    setPos({ left, width, maxH: Math.min(320, room), top: flip ? r.top - gap - h : r.bottom + gap, flip });
  }, [rows.length]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  // 打开 / 键盘移动时把当前项滚入视野
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, pos !== null]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    const last = rows.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(last, i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(last);
        break;
      case 'PageDown':
        e.preventDefault();
        setActive((i) => Math.min(last, i + 6));
        break;
      case 'PageUp':
        e.preventDefault();
        setActive((i) => Math.max(0, i - 6));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        pick(active);
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  const listId = `${uid}-list`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`cz-2fa-gp${open ? ' is-open' : ''}${className ? ` ${className}` : ''}`}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
      >
        <span className="cz-2fa-gp__ic">{value === null && hasValue ? <RootIcon /> : <Icon name="folder" size={14} />}</span>
        {hasValue ? (
          <span className="cz-2fa-gp__val">
            <span className="cz-2fa-gp__name">{selected.name}</span>
            {selected.parentPath && <span className="cz-2fa-gp__path">{selected.parentPath}</span>}
          </span>
        ) : (
          <span className="cz-2fa-gp__val is-placeholder">{placeholder}</span>
        )}
        <span className="cz-2fa-gp__chev">
          <Icon name="chevron-down" size={13} />
        </span>
      </button>

      {mounted &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className={`cz-2fa-gp-pop${pos.flip ? ' is-flip' : ''}${leaving ? ' is-leaving' : ''}`}
            style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxH }}
            onKeyDown={onKeyDown}
            {...inertLeaving(leaving)}
          >
            <div ref={listRef} id={listId} className="cz-2fa-gp-list" role="listbox" aria-label="分组">
              {rows.map((r, i) => {
                const isSel = r.id === value;
                return (
                  <div
                    key={r.id ?? '__root'}
                    data-idx={i}
                    role="option"
                    aria-selected={isSel}
                    className={`cz-2fa-gp-opt${i === active ? ' is-active' : ''}${isSel ? ' is-selected' : ''}${r.id === null ? ' is-root' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pick(i)}
                  >
                    {r.depth > 0 &&
                      Array.from({ length: r.depth }, (_, d) => <span key={d} className="cz-2fa-gp-guide" aria-hidden="true" />)}
                    <span className="cz-2fa-gp-opt__ic">{r.id === null ? <RootIcon /> : <Icon name="folder" size={14} />}</span>
                    <span className="cz-2fa-gp-opt__name" title={r.name}>
                      {r.name}
                    </span>
                    <span className="cz-2fa-gp-opt__ck">{isSel && <Icon name="check" size={13} />}</span>
                  </div>
                );
              })}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

export default GroupPicker;
