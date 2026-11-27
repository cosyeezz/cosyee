// 通用弹出菜单基础件：定位在锚点上方 / 下方，点外面和 Esc 关闭，↑↓ Enter 键盘操作，
// 支持二级子菜单（悬停 / → 展开，← 返回）、右侧快捷键、勾选、说明小字、开关、行尾复制按钮、数字热键。
// 渲染到 document.body（portal），不受父级 overflow 裁剪。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CopyButton } from '../files/PathActions';
import { Icon } from '../icons/Icon';
import { viewportBounds } from '../layout/viewport';
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
  /** 有值时行尾显示复制按钮，复制这段文字；点按钮不会选中该项，也不关菜单 */
  copy?: string;
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
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight?: number } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [subKey, setSubKey] = useState<string | null>(null);
  const [subActive, setSubActive] = useState<string | null>(null);
  const [level, setLevel] = useState<0 | 1>(0);
  // 窄屏（手机）：两栏并排放不下，二级菜单改成「钻入」——在同一个面板里替换成子项，顶上一行返回
  const [drill, setDrill] = useState(() => isDrill(minWidth));
  const subItem = subKey ? (items.find((i) => isItem(i) && i.key === subKey) as MenuItem | undefined) : undefined;
  const drilled = drill && !!subItem?.submenu;
  // 没有绝对定位的二级面板时，面板本身可以限高滚动（overflow 会裁掉挂在旁边的二级面板）
  const scrollable = drill || !items.some((i) => isItem(i) && i.submenu);

  // 用 ref 保存最新状态，让 document 级监听器不必反复重绑
  const st = useRef({ items, active, subKey, subActive, level, hotkeys, onClose });
  st.current = { items, active, subKey, subActive, level, hotkeys, onClose };

  // 定位：渲染后测量面板尺寸；上下都放不下时选空间大的一侧并限高
  const place = useCallback(() => {
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const vb = viewportBounds();
    const m = 8;
    const a = anchor.getBoundingClientRect();
    const w = panel.offsetWidth;
    const h = panel.scrollHeight + (panel.offsetHeight - panel.clientHeight);
    const gap = 6;
    const roomTop = a.top - gap - (vb.top + m);
    const roomBottom = vb.bottom - m - (a.bottom + gap);
    const fitsTop = h <= roomTop;
    const fitsBottom = h <= roomBottom;
    const useTop = fitsTop || fitsBottom
      ? (placement === 'top' ? fitsTop || !fitsBottom : !fitsBottom && fitsTop)
      : roomTop >= roomBottom;
    const room = Math.max(80, useTop ? roomTop : roomBottom);
    const maxHeight = scrollable && h > room ? room : undefined;
    const hh = maxHeight ?? h;
    const top = useTop ? Math.max(vb.top + m, a.top - gap - hh) : a.bottom + gap;
    let left = align === 'end' ? a.right - w : a.left;
    left = Math.max(vb.left + m, Math.min(left, vb.right - w - m));
    setPos({ left, top, maxHeight });
  }, [anchor, placement, align, scrollable]);

  // scrollHeight 是内容的完整高度，不受当前限高影响，内容变少时也能缩回
  useLayoutEffect(place, [place, items, drilled]);

  // 旋转屏幕、键盘弹起 / 收起：重新判断钻入模式并重新定位
  useEffect(() => {
    const on = () => {
      setDrill(isDrill(minWidth));
      place();
    };
    const vv = window.visualViewport;
    window.addEventListener('resize', on);
    vv?.addEventListener('resize', on);
    vv?.addEventListener('scroll', on);
    return () => {
      window.removeEventListener('resize', on);
      vv?.removeEventListener('resize', on);
      vv?.removeEventListener('scroll', on);
    };
  }, [place, minWidth]);

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

  const back = () => { setLevel(0); setSubKey(null); setSubActive(null); };
  const subRows = (list: MenuEntry[]) =>
    list.map((s) => {
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
    });

  return createPortal(
    <div
      ref={panelRef}
      className={`cz-menu${scrollable ? ' cz-menu--scroll' : ''}`}
      data-cz-menu=""
      role="menu"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        maxHeight: pos?.maxHeight,
        minWidth: drill ? Math.min(minWidth, window.innerWidth - 16) : minWidth,
        visibility: pos ? 'visible' : 'hidden',
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      {drilled && subItem?.submenu ? (
        <>
          <div className="cz-menu__wrap">
            <div className="cz-menu__row cz-menu__back" role="menuitem" onClick={(ev) => { ev.stopPropagation(); back(); }}>
              <Icon name="chevron-right" size={14} className="cz-menu__back-icon" />
              <span className="cz-menu__main"><span className="cz-menu__label">{subItem.label}</span></span>
            </div>
          </div>
          <div className="cz-menu__sep" role="separator" />
          {subRows(subItem.submenu)}
        </>
      ) : items.map((e) => {
        if (e.kind === 'sep') return <div key={e.key} className="cz-menu__sep" role="separator" />;
        if (e.kind === 'text') return <div key={e.key} className="cz-menu__text">{e.text}</div>;
        const open = !drill && subKey === e.key && !!e.submenu;
        return (
          <div
            key={e.key}
            className="cz-menu__wrap"
            onMouseEnter={() => {
              if (e.disabled) return;
              setActive(e.key);
              setLevel(0);
              // 钻入模式下只有点击才进子级：触屏点按会先合成 mouseenter，不能让它抢先切换
              if (drill) return;
              if (e.submenu) { setSubKey(e.key); setSubActive(null); } else setSubKey(null);
            }}
          >
            <Row item={e} active={active === e.key} onClick={() => activate(e)} />
            {open && e.submenu && <SubPanel minWidth={minWidth}>{subRows(e.submenu)}</SubPanel>}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

/** 视口放不下「主菜单 + 二级菜单」并排时改为钻入式 */
function isDrill(minWidth: number): boolean {
  return typeof window !== 'undefined' && window.innerWidth < minWidth * 2 + 40;
}

function Row({ item, active, onClick }: { item: MenuItem; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  // 键盘 ↑↓ 移到可滚动面板的可视区外时滚进来；鼠标悬停激活的不滚，免得列表在指针下面跳
  useEffect(() => {
    const el = ref.current;
    if (active && el && !el.matches(':hover')) el.scrollIntoView?.({ block: 'nearest' });
  }, [active]);
  return (
    <div
      ref={ref}
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
      {item.copy && (
        // 拦住点击，不让它冒泡到行上（那会选中该项并关菜单）
        <span className="cz-menu__copy-slot" onClick={(ev) => ev.stopPropagation()}>
          <CopyButton text={item.copy} label={`复制 ${item.copy}`} className="cz-menu__copy" />
        </span>
      )}
      {item.submenu && <Icon name="chevron-right" size={14} className="cz-menu__arrow" />}
    </div>
  );
}

/** 二级菜单：挂在父行旁边，右侧放不下则翻到左侧；纵向超出则上移，比可用高度还高时限高滚动 */
function SubPanel({ children, minWidth }: { children: ReactNode; minWidth: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });
  useLayoutEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    const vb = viewportBounds();
    const m = 8;
    const r = parent.getBoundingClientRect();
    const w = el.offsetWidth;
    const full = el.offsetHeight;
    const room = vb.bottom - vb.top - 2 * m;
    const h = Math.min(full, room);
    const flip = r.right + w + 4 > vb.right - m && r.left - w - 4 >= vb.left + m;
    // 首行与父行对齐（上移 6px 抵消内边距）；下面放不下就上移，但不越过可用区域顶部
    const top = Math.max(vb.top + m, Math.min(r.top - 6, vb.bottom - m - h));
    setStyle({
      visibility: 'visible',
      top: top - r.top,
      maxHeight: full > room ? room : undefined,
      ...(flip ? { right: '100%', marginRight: -2 } : { left: '100%', marginLeft: -2 }),
    });
  }, []);
  return (
    <div ref={ref} className="cz-menu cz-menu--sub cz-menu--scroll" role="menu" style={{ ...style, minWidth }}>
      {children}
    </div>
  );
}
