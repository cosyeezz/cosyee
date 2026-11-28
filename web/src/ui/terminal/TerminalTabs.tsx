// 终端多标签栏：嵌入面板标题栏左侧，支持液态滑动选中胶囊、双击内联改名、
// Pointer Events 拖动排序、横向滚动边缘渐隐、溢出「全部终端」下拉与新建按钮（动效始终开启）。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
} from 'react';
import { TERM_TAB_LIMIT, TERM_TAB_NAME_MAX, type TermTabInfo } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { useDismiss } from '../sidebar/useDismiss';
import { tabAutoName, tabDisplayName } from './terminalUtil';

export interface TerminalTabsProps {
  tabs: readonly TermTabInfo[];
  activeId: string | null;
  root: string;
  touch: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRequestClose: (tab: TermTabInfo) => void;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, toIndex: number) => void;
  /** 可选初始处于改名状态的标签 id（调试页截图与测试用） */
  initialRenamingId?: string | null;
}

interface PillBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface DragState {
  id: string;
  fromIndex: number;
  toIndex: number;
  dx: number;
  width: number;
}

/** 阻尼弹簧（0 → 1），用于液态胶囊前沿/后沿的错峰滑动 */
function spring(t: number, settle: number, zeta: number): number {
  if (t <= 0) return 0;
  const w = 4 / (zeta * settle);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}

function softEdge(from: number, to: number, p: number, cap: number): number {
  const dist = to - from;
  const over = (p - 1) * Math.abs(dist);
  const soft = cap > 0 ? cap * Math.tanh(over / cap) : 0;
  return to + Math.sign(dist) * (p >= 1 ? soft : over);
}

function pillDuration(a: PillBox, b: PillBox): number {
  const dist = Math.abs(b.x - a.x);
  return Math.round(Math.min(380, Math.max(280, 260 + dist * 0.35)));
}

/** 横向液态胶囊关键帧：前沿先到、后沿滞后 14% 跟上，沿 X 轴轻微拉伸（上限 1.35×） */
function buildPillFrames(a: PillBox, b: PillBox, steps = 28): Keyframe[] {
  const dur = pillDuration(a, b);
  const lag = dur * 0.14;
  const right = b.x >= a.x;
  const dist = Math.abs(b.x - a.x);
  const cap = Math.min(3, 0.8 + dist * 0.018);
  const rest = Math.max(1, (a.w + b.w) / 2);
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dur;
    const pLead = spring(t, dur * 0.68, 0.84);
    const pTrail = spring(t - lag, dur * 0.7, 0.7);
    const l0 = a.x;
    const r0 = a.x + a.w;
    const l1 = b.x;
    const r1 = b.x + b.w;
    let left: number;
    let rgt: number;
    if (right) {
      rgt = softEdge(r0, r1, pLead, cap);
      left = softEdge(l0, l1, pTrail, cap);
    } else {
      left = softEdge(l0, l1, pLead, cap);
      rgt = softEdge(r0, r1, pTrail, cap);
    }
    if (i === steps) {
      left = l1;
      rgt = r1;
    }
    let w = Math.min(Math.max(rgt - left, b.w * 0.86), b.w * 1.35);
    if (rgt - left > w) left = right ? rgt - w : left;
    if (i === steps) w = b.w;
    const k = w / rest;
    const inset = i === steps ? 0 : Math.max(-0.8, Math.min(2, (k - 1) * 1.6));
    const y = a.y + (b.y - a.y) * Math.min(1, pLead) + inset;
    const h = a.h + (b.h - a.h) * Math.min(1, pLead) - inset * 2;
    frames.push({
      offset: i / steps,
      transform: `translate3d(${left.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${(w / b.w).toFixed(4)}, ${(h / b.h).toFixed(4)})`,
    });
  }
  return frames;
}

function sameBox(a: PillBox | null, b: PillBox | null): boolean {
  return (
    !!a &&
    !!b &&
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5
  );
}

function findTabEl(track: HTMLElement, id: string | null): HTMLElement | null {
  if (!id) return null;
  const list = track.querySelectorAll<HTMLElement>('[data-tab-id]');
  for (let i = 0; i < list.length; i++) {
    if (list[i]!.dataset.tabId === id) return list[i]!;
  }
  return null;
}

export function TerminalTabs({
  tabs,
  activeId,
  root,
  touch,
  onSelect,
  onNew,
  onRequestClose,
  onRename,
  onMove,
  initialRenamingId = null,
}: TerminalTabsProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const allMenuRef = useRef<HTMLDivElement>(null);

  const [renamingId, setRenamingId] = useState<string | null>(initialRenamingId);
  const [renameDraft, setRenameDraft] = useState<string>(() => {
    if (!initialRenamingId) return '';
    return tabs.find((t) => t.id === initialRenamingId)?.name ?? '';
  });
  const [fade, setFade] = useState<{ left: boolean; right: boolean }>({ left: false, right: false });
  const [drag, setDrag] = useState<DragState | null>(null);
  const [allMenuOpen, setAllMenuOpen] = useState(false);

  const pillLastRef = useRef<{ key: string | null; box: PillBox | null }>({ key: null, box: null });
  const pillAnimRef = useRef<Animation | null>(null);
  const suppressClickIdRef = useRef<string | null>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const closeAllMenu = useCallback(() => setAllMenuOpen(false), []);
  useDismiss(allMenuOpen, allMenuRef, closeAllMenu);

  // 更新左右滚动边缘渐隐提示（同时决定是否显示「全部终端」溢出下拉按钮）
  const updateFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 3;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 3;
    setFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useEffect(() => {
    updateFade();
    const el = scrollRef.current;
    if (!el) return;
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateFade) : null;
    ro?.observe(el);
    if (trackRef.current) ro?.observe(trackRef.current);
    return () => ro?.disconnect();
  }, [updateFade, tabs.length]);

  // 切换或新增标签时把当前激活标签滚入可视区
  useEffect(() => {
    if (!activeId || drag) return;
    const track = trackRef.current;
    if (!track) return;
    const el = findTabEl(track, activeId);
    el?.scrollIntoView?.({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    const raf = requestAnimationFrame(updateFade);
    return () => cancelAnimationFrame(raf);
  }, [activeId, tabs.length, drag, updateFade]);

  // 同步液态滑动选中胶囊（用布局属性 offsetLeft/offsetWidth 量测，彻底不受 @starting-style transform 缩放影响）
  const syncPill = useCallback((forceSnap = false) => {
    const pill = pillRef.current;
    const track = trackRef.current;
    if (!pill || !track) return;

    const activeEl = findTabEl(track, activeId);

    if (!activeEl || drag) {
      if (drag) {
        pill.style.opacity = '0';
        return;
      }
      pillAnimRef.current?.cancel();
      pillAnimRef.current = null;
      pill.classList.remove('is-on');
      pillLastRef.current = { key: activeId, box: null };
      return;
    }

    pill.style.opacity = '';
    const w = activeEl.offsetWidth;
    const h = activeEl.offsetHeight;
    if (w === 0 || h === 0) return;

    const target: PillBox = {
      x: activeEl.offsetLeft,
      y: activeEl.offsetTop,
      w,
      h,
    };

    const prev = pillLastRef.current;
    const keyChanged = activeId !== prev.key;
    if (!forceSnap && !keyChanged && sameBox(target, prev.box)) return;

    const from = prev.box;
    pillLastRef.current = { key: activeId, box: target };

    const wasShown = pill.classList.contains('is-on') && from !== null;
    let start = from;
    if (pillAnimRef.current && pillAnimRef.current.playState === 'running' && from) {
      const tr = track.getBoundingClientRect();
      const pr = pill.getBoundingClientRect();
      if (pr.width > 0 && pr.height > 0) {
        start = { x: pr.left - tr.left, y: pr.top - tr.top, w: pr.width, h: pr.height };
      }
    }

    pillAnimRef.current?.cancel();
    pillAnimRef.current = null;
    pill.style.width = `${target.w}px`;
    pill.style.height = `${target.h}px`;
    pill.style.transform = `translate3d(${target.x}px, ${target.y}px, 0) scale(1, 1)`;
    pill.classList.add('is-on');

    if (
      !keyChanged ||
      forceSnap ||
      !wasShown ||
      !start ||
      typeof pill.animate !== 'function'
    ) {
      return;
    }

    const frames = buildPillFrames(start, target);
    pillAnimRef.current = pill.animate(frames, {
      duration: pillDuration(start, target),
      easing: 'linear',
    });
  }, [activeId, drag]);

  useLayoutEffect(() => {
    syncPill(false);
  });

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const onResize = () => syncPill(true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(track);
    window.addEventListener('resize', onResize);
    document.fonts?.ready?.then(onResize).catch(() => {});
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [syncPill]);

  useEffect(() => () => {
    pillAnimRef.current?.cancel();
    pillAnimRef.current = null;
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
  }, []);

  // 进入改名时自动聚焦并全选
  useEffect(() => {
    if (!renamingId) return;
    const raf = requestAnimationFrame(() => {
      const el = renameInputRef.current;
      if (el) {
        el.focus();
        el.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [renamingId]);

  const startRename = (tab: TermTabInfo) => {
    setRenamingId(tab.id);
    setRenameDraft(tab.name ?? '');
  };

  const commitRename = (id: string) => {
    if (renamingId !== id) return;
    setRenamingId(null);
    onRename(id, renameDraft);
  };

  const cancelRename = () => {
    setRenamingId(null);
  };

  const onRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>, id: string) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      commitRename(id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelRename();
    }
  };

  // 鼠标滚轮横向滚动标签栏
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const el = scrollRef.current;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY;
      updateFade();
    }
  };

  // Pointer Events 拖动排序（5px 阈值防误触，实时让位预览）
  const onTabPointerDown = (e: ReactPointerEvent<HTMLDivElement>, tab: TermTabInfo, index: number) => {
    if (e.button !== 0 || renamingId === tab.id || tabs.length < 2) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input')) return;

    const track = trackRef.current;
    if (!track) return;

    const startX = e.clientX;
    const pointerId = e.pointerId;
    const items = Array.from(track.querySelectorAll<HTMLElement>('[data-tab-id]'));
    const rects = items.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.dataset.tabId ?? '', left: r.left, width: r.width, mid: r.left + r.width / 2 };
    });
    const curRect = rects[index];
    if (!curRect) return;

    const gap = rects.length >= 2 ? Math.max(0, rects[1]!.left - (rects[0]!.left + rects[0]!.width)) : 4;
    const shiftSpan = curRect.width + gap;
    let started = false;
    let latestTo = index;

    const onMoveEvt = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      if (!started) {
        if (Math.abs(dx) < 5) return;
        started = true;
        suppressClickIdRef.current = tab.id;
      }
      const draggedMid = curRect.mid + dx;
      let toIndex = index;
      if (dx > 0) {
        for (let i = index + 1; i < rects.length; i++) {
          if (draggedMid > rects[i]!.mid) toIndex = i;
        }
      } else if (dx < 0) {
        for (let i = index - 1; i >= 0; i--) {
          if (draggedMid < rects[i]!.mid) toIndex = i;
        }
      }
      latestTo = toIndex;
      setDrag({ id: tab.id, fromIndex: index, toIndex, dx, width: shiftSpan });
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onMoveEvt);
      window.removeEventListener('pointerup', onUpEvt);
      window.removeEventListener('pointercancel', onUpEvt);
      dragCleanupRef.current = null;
    };

    const onUpEvt = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      if (started) {
        setDrag(null);
        if (latestTo !== index) {
          onMove(tab.id, latestTo);
        }
        requestAnimationFrame(() => {
          if (suppressClickIdRef.current === tab.id) suppressClickIdRef.current = null;
        });
      }
    };

    dragCleanupRef.current?.();
    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onMoveEvt);
    window.addEventListener('pointerup', onUpEvt);
    window.addEventListener('pointercancel', onUpEvt);
  };

  const atLimit = tabs.length >= TERM_TAB_LIMIT;
  const hasOverflow = fade.left || fade.right;
  const scrollCls = [
    'cz-term-tabs__scroll',
    fade.left ? 'has-left' : '',
    fade.right ? 'has-right' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="cz-term-tabs" role="tablist" aria-label="终端标签">
      <div className={scrollCls} ref={scrollRef} onScroll={updateFade} onWheel={onWheel}>
        <div className={`cz-term-tabs__track${drag ? ' is-dragging' : ''}`} ref={trackRef}>
          <span ref={pillRef} className="cz-term-tabs__pill" aria-hidden="true" />
          {tabs.map((tab, idx) => {
            const isActive = tab.id === activeId;
            const isRenaming = tab.id === renamingId;
            const isDragged = drag?.id === tab.id;
            const label = tabDisplayName(tab, root);
            const autoLabel = tabAutoName(tab, root);

            let shiftX = 0;
            if (drag && !isDragged) {
              if (drag.fromIndex < drag.toIndex && idx > drag.fromIndex && idx <= drag.toIndex) {
                shiftX = -drag.width;
              } else if (drag.fromIndex > drag.toIndex && idx >= drag.toIndex && idx < drag.fromIndex) {
                shiftX = drag.width;
              }
            }

            const tabCls = [
              'cz-term-tab',
              isActive ? 'is-active' : '',
              isRenaming ? 'is-renaming' : '',
              isDragged ? 'is-dragged' : '',
              touch ? 'is-touch' : '',
            ]
              .filter(Boolean)
              .join(' ');

            const dragStyle = isDragged
              ? { transform: `translate3d(${drag.dx}px, 0, 0) scale(1.03)` }
              : shiftX !== 0
                ? { transform: `translate3d(${shiftX}px, 0, 0)` }
                : undefined;

            return (
              <div
                key={tab.id}
                role="tab"
                tabIndex={isActive ? 0 : -1}
                aria-selected={isActive}
                data-tab-id={tab.id}
                className={tabCls}
                style={dragStyle}
                title={isRenaming ? undefined : `${label}${tab.cwd ? `\n${tab.cwd}` : ''}`}
                onPointerDown={(e) => onTabPointerDown(e, tab, idx)}
                onClick={() => {
                  if (suppressClickIdRef.current === tab.id) return;
                  if (!isRenaming) onSelect(tab.id);
                }}
                onKeyDown={(e) => {
                  if (isRenaming) return;
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(tab.id);
                  }
                }}
              >
                {tab.status === 'running' ? (
                  <span className="cz-term-tab__dot is-running" aria-label="运行中" />
                ) : tab.status === 'failed' ? (
                  <span className="cz-term-tab__dot is-failed" aria-label="上次命令失败" />
                ) : (
                  <span className="cz-term-tab__ico" aria-hidden="true">
                    <Icon name="terminal" size={12} />
                  </span>
                )}

                {isRenaming ? (
                  <input
                    ref={renameInputRef}
                    type="text"
                    className="cz-term-tab__rename"
                    value={renameDraft}
                    maxLength={TERM_TAB_NAME_MAX}
                    placeholder={autoLabel}
                    aria-label="重命名终端标签"
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(tab.id)}
                    onKeyDown={(e) => onRenameKeyDown(e, tab.id)}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span
                    className="cz-term-tab__name"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRename(tab);
                    }}
                  >
                    {label}
                  </span>
                )}

                <button
                  type="button"
                  className="cz-term-tab__close"
                  tabIndex={-1}
                  title="关闭终端 (Ctrl+Shift+W)"
                  aria-label={`关闭终端 ${label}`}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestClose(tab);
                  }}
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* 标签溢出时提供「全部终端」下拉列表，显示总数并支持一键切换/关闭 */}
      {hasOverflow && (
        <div className="cz-term-tabs__all-wrap" ref={allMenuRef}>
          <button
            type="button"
            className={`cz-term-tabs__all${allMenuOpen ? ' is-open' : ''}`}
            title={`全部终端 (${tabs.length})`}
            aria-label={`全部终端，共 ${tabs.length} 个`}
            aria-haspopup="menu"
            aria-expanded={allMenuOpen}
            onClick={() => setAllMenuOpen((o) => !o)}
          >
            <span className="cz-term-tabs__count">{tabs.length}</span>
            <Icon name="chevron-down" size={11} />
          </button>
          {allMenuOpen && (
            <div className="cz-term__menu cz-term-tabs__menu cz-term-pop" role="menu" aria-label="全部终端">
              {tabs.map((t) => {
                const active = t.id === activeId;
                const label = tabDisplayName(t, root);
                return (
                  <div key={t.id} className={`cz-term-tabs__mrow${active ? ' is-active' : ''}`}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className="cz-term-tabs__mpick"
                      onClick={() => {
                        onSelect(t.id);
                        setAllMenuOpen(false);
                      }}
                    >
                      {t.status === 'running' ? (
                        <span className="cz-term-tab__dot is-running" aria-hidden="true" />
                      ) : t.status === 'failed' ? (
                        <span className="cz-term-tab__dot is-failed" aria-hidden="true" />
                      ) : (
                        <Icon name="terminal" size={12} className="cz-term-tab__ico" />
                      )}
                      <span className="cz-term-tabs__mlabel">{label}</span>
                      {active && <Icon name="check" size={12} className="cz-term__menuitem-ck" />}
                    </button>
                    <button
                      type="button"
                      className="cz-term-tabs__mclose"
                      title={`关闭 ${label}`}
                      aria-label={`关闭终端 ${label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAllMenuOpen(false);
                        onRequestClose(t);
                      }}
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <button
        type="button"
        className="cz-term-tabs__add"
        disabled={atLimit}
        title={atLimit ? `已达上限（最多 ${TERM_TAB_LIMIT} 个终端）` : '新建终端 (Ctrl+Shift+T)'}
        aria-label="新建终端"
        onClick={onNew}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
