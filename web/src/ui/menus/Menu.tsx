// 通用弹出菜单基础件：定位在锚点上方 / 下方，点外面和 Esc 关闭，↑↓ Enter 键盘操作，
// 支持二级子菜单（悬停 / → 展开，← 返回）、右侧快捷键、勾选、说明小字、开关、数字热键。
// 渲染到 document.body（portal），不受父级 overflow 裁剪。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/Icon';
import './Menu.css';

export interface MenuItem {
  kind?: 'item';
  key: string;
  label: ReactNode;
  /** 右侧快捷键文字，如「1」 */
  shortcut?: string;
  /** 标签后的小徽标，如「默认」「推荐」 */
  badge?: string;
  /** 标题下方说明小字 */
  note?: string;
  /** 勾选标记（当前项） */
  checked?: boolean;
  /** 有值时在右侧显示开关 */
  toggle?: boolean;
  /** 右侧「i」图标的悬停提示 */
  info?: string;
  disabled?: boolean;
  /** 选中后不关闭菜单（如开关） */
  keepOpen?: boolean;
  onSelect?: () => void;
  /** 二级子菜单 */
  submenu?: MenuEntry[];
}
export type MenuEntry =
  | MenuItem
  | { kind: 'sep'; key: string }
  | { kind: 'text'; key: string; text: string };

export interface MenuProps {
  /** 锚点元素（点它不算「点外面」，由触发按钮自己负责切换） */
  anchor: HTMLElement | null;
  items: MenuEntry[];
  onClose: () => void;
  /** 优先位置，放不下时自动翻转 */
  placement?: 'top' | 'bottom';
  align?: 'start' | 'end';
  minWidth?: number;
  /** 菜单打开时的单键热键（如 '1'..'4'），无修饰键时触发 */
  hotkeys?: Record<string, () => void>;
}

const isItem = (e: MenuEntry): e is MenuItem => e.kind === undefined || e.kind === 'item';
const selectable = (es: MenuEntry[]): MenuItem[] => es.filter(isItem).filter((i) => !i.disabled);

export function Menu({ anchor, items, onClose, placement = 'top', align = 'start', minWidth = 220, hotkeys }: MenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [subKey, setSubKey] = useState<string | null>(null);
  const [subActive, setSubActive] = useState<string | null>(null);
  const [level, setLevel] = useState<0 | 1>(0);

  // 用 ref 保存最新状态，让 document 级监听器不必反复重绑
  const st = useRef({ items, active, subKey, subActive, level, hotkeys, onClose });
  st.current = { items, active, subKey, subActive, level, hotkeys, onClose };

  // 定位：首次渲染后测量面板尺寸
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const a = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.offsetHeight;
    const gap = 6;
    const fitsTop = a.top - gap - h >= 8;
    const fitsBottom = a.bottom + gap + h <= window.innerHeight - 8;
    const useTop = placement === 'top' ? fitsTop || !fitsBottom : !fitsBottom && fitsTop;
    const top = useTop ? Math.max(8, a.top - gap - h) : a.bottom + gap;
    let left = align === 'end' ? a.right - w : a.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ left, top });
  }, [anchor, placement, align, items]);

  // 点外面关闭
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchor?.contains(t)) return;
      st.current.onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchor]);

  const activate = useCallback((item: MenuItem) => {
    if (item.disabled) return;
    if (item.submenu) {
      setActive(item.key);
      setSubKey(item.key);
      setSubActive(selectable(item.submenu)[0]?.key ?? null);
      setLevel(1);
      return;
    }
    item.onSelect?.();
    if (!item.keepOpen) st.current.onClose();
  }, []);

  // 键盘
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const s = st.current;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      if (e.key === 'Escape') {
        stop();
        if (s.level === 1) { setLevel(0); setSubKey(null); } else s.onClose();
        return;
      }
      const sub = s.subKey ? (s.items.find((i) => isItem(i) && i.key === s.subKey) as MenuItem | undefined)?.submenu : undefined;
      const list = s.level === 1 && sub ? selectable(sub) : selectable(s.items);
      const cur = s.level === 1 ? s.subActive : s.active;
      const idx = list.findIndex((i) => i.key === cur);
      const setCur = (k: string | null) => (s.level === 1 ? setSubActive(k) : setActive(k));
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        stop();
        if (!list.length) return;
        const d = e.key === 'ArrowDown' ? 1 : -1;
        const n = idx < 0 ? (d === 1 ? 0 : list.length - 1) : (idx + d + list.length) % list.length;
        setCur(list[n].key);
        if (s.level === 0) setSubKey(null);
      } else if (e.key === 'ArrowRight') {
        const it = list[idx];
        if (s.level === 0 && it?.submenu) { stop(); activate(it); }
      } else if (e.key === 'ArrowLeft') {
        if (s.level === 1) { stop(); setLevel(0); setSubKey(null); }
      } else if (e.key === 'Enter' || e.key === ' ') {
        const it = list[idx];
        if (it) { stop(); activate(it); }
      } else if (s.hotkeys && !e.ctrlKey && !e.metaKey && !e.altKey && s.hotkeys[e.key]) {
        stop();
        s.hotkeys[e.key]();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [activate]);

  return createPortal(
    <div
      ref={panelRef}
      className="cz-menu"
      data-cz-menu=""
      role="menu"
      style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, minWidth, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {items.map((e) => {
        if (e.kind === 'sep') return <div key={e.key} className="cz-menu__sep" role="separator" />;
        if (e.kind === 'text') return <div key={e.key} className="cz-menu__text">{e.text}</div>;
        const open = subKey === e.key && !!e.submenu;
        return (
          <div
            key={e.key}
            className="cz-menu__wrap"
            onMouseEnter={() => {
              if (e.disabled) return;
              setActive(e.key);
              setLevel(0);
              if (e.submenu) { setSubKey(e.key); setSubActive(null); } else setSubKey(null);
            }}
          >
            <Row item={e} active={active === e.key} onClick={() => activate(e)} />
            {open && e.submenu && (
              <SubPanel minWidth={minWidth}>
                {e.submenu.map((s) => {
                  if (s.kind === 'sep') return <div key={s.key} className="cz-menu__sep" role="separator" />;
                  if (s.kind === 'text') return <div key={s.key} className="cz-menu__text">{s.text}</div>;
                  return (
                    <div
                      key={s.key}
                      className="cz-menu__wrap"
                      onMouseEnter={() => { if (!s.disabled) { setSubActive(s.key); setLevel(1); } }}
                    >
                      <Row item={s} active={subActive === s.key} onClick={() => activate(s)} />
                    </div>
                  );
                })}
              </SubPanel>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

function Row({ item, active, onClick }: { item: MenuItem; active: boolean; onClick: () => void }) {
  return (
    <div
      className={`cz-menu__row${active ? ' is-active' : ''}${item.disabled ? ' is-disabled' : ''}${item.checked ? ' is-checked' : ''}`}
      role="menuitem"
      aria-disabled={item.disabled || undefined}
      onClick={(ev) => { ev.stopPropagation(); onClick(); }}
    >
      <span className="cz-menu__main">
        <span className="cz-menu__label">
          {item.label}
          {item.badge && <span className="cz-menu__badge">{item.badge}</span>}
          {item.info && <span className="cz-menu__info" title={item.info}><Icon name="info" size={13} /></span>}
        </span>
        {item.note && <span className="cz-menu__note">{item.note}</span>}
      </span>
      {item.toggle !== undefined && (
        <span className={`cz-menu__switch${item.toggle ? ' is-on' : ''}`} role="switch" aria-checked={item.toggle}>
          <span className="cz-menu__knob" />
        </span>
      )}
      {/* 右侧同一槽位：选中项显示蓝色对勾，替代快捷键数字 */}
      {item.checked
        ? <span className="cz-menu__check"><Icon name="check" size={16} /></span>
        : item.shortcut && <span className="cz-menu__shortcut">{item.shortcut}</span>}
      {item.submenu && <Icon name="chevron-right" size={14} className="cz-menu__arrow" />}
    </div>
  );
}

/** 二级菜单：挂在父行旁边，右侧放不下则翻到左侧，纵向超出则上移 */
function SubPanel({ children, minWidth }: { children: ReactNode; minWidth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const r = parent.getBoundingClientRect();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const flip = r.right + w + 4 > window.innerWidth - 8 && r.left - w - 4 >= 8;
    let dy = 0;
    if (r.top + h > window.innerHeight - 8) dy = Math.max(window.innerHeight - 8 - (r.top + h), 8 - r.top);
    setStyle({ visibility: 'visible', top: dy - 6, ...(flip ? { right: '100%', marginRight: -2 } : { left: '100%', marginLeft: -2 }) });
  }, []);
  return (
    <div ref={ref} className="cz-menu cz-menu--sub" role="menu" style={{ ...style, minWidth }}>
      {children}
    </div>
  );
}
