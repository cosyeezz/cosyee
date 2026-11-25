// 会话悬浮卡片：侧栏所有行共用一张卡片（portal 到 body），会话头部复用同一控制器。
// 控制器状态独立在 SessionCardLayer 里，指针事件不会触发 Sidebar 或 SessionRow 重渲染。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import {
  EFFORTS,
  canonicalModel,
  type PinKind,
  type SessionConfig,
  type SessionDetail,
  type SessionDot,
  type Workspace,
} from '@cosyee/shared';
import { formatTokens } from '../context/formatTokens';
import { prettyModel } from '../flow/format';
import { viewportBounds } from '../layout/viewport';
import { reducedMotion } from '../motion/reduced';
import { leavingProps, usePresence } from '../motion/usePresence';
import { formatFullTime } from './formatTime';
import {
  SessionDetailContext,
  detailCacheKey,
  loadSessionDetail,
  peekSessionDetail,
  type SessionDetailLoader,
} from './sessionDetail';
import { displayTitle, workspaceName } from './sidebarUtil';
import { hasOpenLayer, useDismiss } from './useDismiss';
import './SessionCard.css';

export const COLD_DELAY_MS = 400;
export const WARM_DELAY_MS = 70;
export const WARM_WINDOW_MS = 300;
// 从标题移到卡片要经过行内操作按钮（约 56px）和 8px 间隙，宽限太短会移不进去
export const LEAVE_GRACE_MS = 220;
const LEAVE_ANIM_MS = 120;
const CARD_MAX_W = 320;
const VIEWPORT_MARGIN = 8;

export interface SessionCardTarget {
  kind: 'session' | 'deleted';
  id: string;
  cwd: string;
  title: string;
  /** 正常会话是 lastActiveAt；已删除会话是 deletedAt */
  lastActiveAt: number;
  dot: SessionDot;
  pinned: PinKind | null;
  account?: string | null;
  config?: SessionConfig;
  lastModel?: string;
  workspaceLabel?: string;
  /** 底部弱提示（仅头部卡片使用） */
  hint?: string;
}

type PlacementMode = 'side' | 'below';
type ResolvedSide = 'side' | 'below' | 'above';

interface ActiveState {
  el: HTMLElement;
  target: SessionCardTarget;
  key: string;
}

interface DetailState {
  /** cwd + 会话 id：同一会话刷新时先留着旧内容，不退回骨架 */
  who: string;
  key: string;
  status: 'loading' | 'ready' | 'error';
  data: SessionDetail | null;
  fromCache: boolean;
}

interface ControllerSnapshot {
  open: boolean;
  active: ActiveState | null;
  /** 已开着卡片时切换到另一行：启用外层位移过渡与内容交叉淡化 */
  switching: boolean;
  /** 递增序号：每次真正切到新行时递增，驱动内容交叉淡化 */
  switchSeq: number;
}

export interface SessionCardController {
  enter: (el: HTMLElement, target: SessionCardTarget, pointerType?: string) => void;
  leave: (el: HTMLElement, pointerType?: string) => void;
  focus: (el: HTMLElement, target: SessionCardTarget) => void;
  blur: (el: HTMLElement) => void;
  closeNow: () => void;
  detach: (el: HTMLElement) => void;
  updateTarget: (el: HTMLElement, target: SessionCardTarget) => void;
  cardEnter: () => void;
  cardLeave: () => void;
  subscribe: (fn: () => void) => () => void;
  getSnapshot: () => ControllerSnapshot;
  setCardEl: (el: HTMLElement | null) => void;
  setCardId: (id: string) => void;
}

// 跟踪最近一次输入方式，区分键盘 Tab 聚焦和鼠标点击聚焦
let lastInputWasPointer = false;
let modalityBound = false;
export function ensureModalityListeners() {
  if (modalityBound || typeof document === 'undefined') return;
  modalityBound = true;
  document.addEventListener('pointerdown', () => { lastInputWasPointer = true; }, true);
  document.addEventListener('mousedown', () => { lastInputWasPointer = true; }, true);
  document.addEventListener('keydown', () => { lastInputWasPointer = false; }, true);
}

export function isKeyboardFocus(el: HTMLElement): boolean {
  if (lastInputWasPointer) return false;
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

function targetKey(t: SessionCardTarget): string {
  return detailCacheKey(t.id, t.cwd, t.lastActiveAt, t.kind === 'deleted' ? 'deleted' : t.dot);
}

function targetWho(t: SessionCardTarget): string {
  return `${t.cwd}\0${t.id}`;
}

function createController(): SessionCardController {
  let snapshot: ControllerSnapshot = { open: false, active: null, switching: false, switchSeq: 0 };
  let openTimer: number | undefined;
  let closeTimer: number | undefined;
  let pendingEl: HTMLElement | null = null;
  let lastClosedAt = 0;
  let cardEl: HTMLElement | null = null;
  let cardId = '';
  let describedEl: HTMLElement | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const l of listeners) l();
  };

  const syncDescribedBy = (el: HTMLElement | null) => {
    if (describedEl && describedEl !== el) {
      if (describedEl.getAttribute('aria-describedby') === cardId) {
        describedEl.removeAttribute('aria-describedby');
      }
      describedEl = null;
    }
    if (el && cardId) {
      el.setAttribute('aria-describedby', cardId);
      describedEl = el;
    }
  };

  const clearOpen = () => {
    if (openTimer !== undefined) {
      window.clearTimeout(openTimer);
      openTimer = undefined;
    }
    pendingEl = null;
  };

  const clearClose = () => {
    if (closeTimer !== undefined) {
      window.clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  };

  const openFor = (el: HTMLElement, target: SessionCardTarget) => {
    clearOpen();
    clearClose();
    if (!el.isConnected) return;
    // 卡片没开而别的弹层开着（删除确认、账号菜单等）：不打扰
    if (!snapshot.open && hasOpenLayer()) return;
    const key = targetKey(target);
    const wasOpen = snapshot.open;
    const sameRow = wasOpen && snapshot.active?.el === el && snapshot.active?.key === key;
    if (sameRow) return;
    const switching = wasOpen && snapshot.active?.el !== el;
    snapshot = {
      open: true,
      active: { el, target, key },
      switching,
      switchSeq: switching ? snapshot.switchSeq + 1 : snapshot.switchSeq,
    };
    syncDescribedBy(el);
    emit();
  };

  const closeNow = () => {
    clearOpen();
    clearClose();
    syncDescribedBy(null);
    if (!snapshot.open) return;
    lastClosedAt = Date.now();
    snapshot = { ...snapshot, open: false, switching: false };
    emit();
  };

  const scheduleOpen = (el: HTMLElement, target: SessionCardTarget) => {
    clearClose();
    const key = targetKey(target);
    if (snapshot.open && snapshot.active?.el === el && snapshot.active?.key === key) {
      clearOpen();
      return;
    }
    clearOpen();
    pendingEl = el;
    const warm = snapshot.open || (lastClosedAt > 0 && Date.now() - lastClosedAt <= WARM_WINDOW_MS);
    const delay = warm ? WARM_DELAY_MS : COLD_DELAY_MS;
    openTimer = window.setTimeout(() => {
      openTimer = undefined;
      pendingEl = null;
      openFor(el, target);
    }, delay);
  };

  const scheduleClose = () => {
    clearClose();
    if (!snapshot.open) return;
    closeTimer = window.setTimeout(() => {
      closeTimer = undefined;
      closeNow();
    }, LEAVE_GRACE_MS);
  };

  return {
    enter(el, target, pointerType) {
      if (pointerType && pointerType !== 'mouse') return;
      scheduleOpen(el, target);
    },
    leave(el, pointerType) {
      if (pointerType && pointerType !== 'mouse') return;
      if (pendingEl === el) clearOpen();
      // 不限于当前行：经过别的行时 enter 已取消了关闭计时，没等到切换就离开也要重新计时
      scheduleClose();
    },
    focus(el, target) {
      if (!isKeyboardFocus(el)) return;
      scheduleOpen(el, target);
    },
    blur(el) {
      if (pendingEl === el) clearOpen();
      if (snapshot.open && snapshot.active?.el === el) {
        // 如果焦点移进了卡片内部，不关
        const active = document.activeElement;
        if (cardEl && active && cardEl.contains(active)) return;
        closeNow();
      }
    },
    closeNow,
    detach(el) {
      if (pendingEl === el) clearOpen();
      if (snapshot.active?.el === el) closeNow();
    },
    updateTarget(el, target) {
      if (!snapshot.open || snapshot.active?.el !== el) return;
      // target 由调用方 memo，引用变了就是内容变了
      if (snapshot.active.target === target) return;
      snapshot = { ...snapshot, active: { el, target, key: targetKey(target) } };
      emit();
    },
    cardEnter() {
      clearClose();
    },
    cardLeave() {
      scheduleClose();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    getSnapshot() {
      return snapshot;
    },
    setCardEl(el) {
      cardEl = el;
    },
    setCardId(id) {
      cardId = id;
      if (snapshot.open && snapshot.active) syncDescribedBy(snapshot.active.el);
    },
  };
}

const SessionCardContext = createContext<SessionCardController | null>(null);

export function useSessionCard(): SessionCardController | null {
  return useContext(SessionCardContext);
}

/** 绑定到触发元素（会话行主按钮 / 头部标题按钮 / 已删除行）的稳定事件处理器 */
export function useSessionCardTarget(target: SessionCardTarget | null) {
  const ctrl = useSessionCard();
  const targetRef = useRef<SessionCardTarget | null>(target);
  const elRef = useRef<HTMLElement | null>(null);
  targetRef.current = target;

  useEffect(() => {
    ensureModalityListeners();
  }, []);

  // 目标字段更新或变为 null（如进入改名 / 变为新会话）时同步状态
  useEffect(() => {
    const el = elRef.current;
    if (!ctrl || !el) return;
    if (!target) ctrl.detach(el);
    else ctrl.updateTarget(el, target);
  }, [ctrl, target]);

  // 行被卸载（搜索过滤、分组折叠、删除等）时立即关闭
  useEffect(() => {
    return () => {
      if (ctrl && elRef.current) ctrl.detach(elRef.current);
    };
  }, [ctrl]);

  return useMemo(() => {
    if (!ctrl) return {};
    return {
      onPointerEnter: (e: PointerEvent<HTMLElement>) => {
        elRef.current = e.currentTarget;
        if (targetRef.current) ctrl.enter(e.currentTarget, targetRef.current, e.pointerType);
      },
      onPointerLeave: (e: PointerEvent<HTMLElement>) => {
        ctrl.leave(e.currentTarget, e.pointerType);
      },
      onFocus: (e: FocusEvent<HTMLElement>) => {
        elRef.current = e.currentTarget;
        if (targetRef.current) ctrl.focus(e.currentTarget, targetRef.current);
      },
      onBlur: (e: FocusEvent<HTMLElement>) => {
        ctrl.blur(e.currentTarget);
      },
      onClick: () => {
        ctrl.closeNow();
      },
    };
  }, [ctrl]);
}

export interface SessionCardProviderProps {
  workspaces?: Workspace[];
  placement: PlacementMode;
  /** 可选覆盖详情加载函数，默认走 SessionDetailContext（进而走 api.sessionDetail） */
  loadDetail?: SessionDetailLoader;
  children: ReactNode;
}

export function SessionCardProvider({ workspaces = [], placement, loadDetail, children }: SessionCardProviderProps) {
  const ctrlRef = useRef<SessionCardController | null>(null);
  if (!ctrlRef.current) ctrlRef.current = createController();
  const ctrl = ctrlRef.current;

  useEffect(() => () => ctrl.closeNow(), [ctrl]);

  return (
    <SessionCardContext.Provider value={ctrl}>
      {children}
      <SessionCardLayer ctrl={ctrl} workspaces={workspaces} placement={placement} loadDetail={loadDetail} />
    </SessionCardContext.Provider>
  );
}

export interface CardPos {
  x: number;
  y: number;
  side: ResolvedSide;
  origin: string;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

export function computePosition(
  anchor: HTMLElement,
  cardW: number,
  cardH: number,
  placement: PlacementMode,
): CardPos {
  const vb = viewportBounds();
  const m = VIEWPORT_MARGIN;
  const r = anchor.getBoundingClientRect();
  const maxX = Math.max(vb.left + m, vb.right - m - cardW);
  const maxY = Math.max(vb.top + m, vb.bottom - m - cardH);

  if (placement === 'side') {
    const sidebar = (anchor.closest('.cz-sidebar') ?? anchor).getBoundingClientRect();
    const gap = 8;
    // 侧栏右侧放得下就贴着侧栏右边；放不下（如窄屏抽屉）改为行的下方 / 上方
    if (sidebar.right + gap + cardW <= vb.right - m) {
      const x = sidebar.right + gap;
      const y = clamp(r.top - 8, vb.top + m, maxY);
      const oy = clamp(r.top + r.height / 2 - y, 16, Math.max(16, cardH - 16));
      return { x, y, side: 'side', origin: `0 ${Math.round(oy)}px` };
    }
  }

  // 放在触发元素下方，下方空间不够且上方更宽裕时改放上方
  const x = clamp(r.left, vb.left + m, maxX);
  const belowY = r.bottom + 6;
  const aboveY = r.top - 6 - cardH;
  const fitsBelow = belowY + cardH <= vb.bottom - m;
  const fitsAbove = aboveY >= vb.top + m;
  if (fitsBelow || (!fitsAbove && vb.bottom - r.bottom >= r.top - vb.top)) {
    return { x, y: clamp(belowY, vb.top + m, maxY), side: 'below', origin: 'top left' };
  }
  return { x, y: clamp(aboveY, vb.top + m, maxY), side: 'above', origin: 'bottom left' };
}

function SessionCardLayer({
  ctrl,
  workspaces,
  placement,
  loadDetail,
}: {
  ctrl: SessionCardController;
  workspaces: Workspace[];
  placement: PlacementMode;
  loadDetail?: SessionDetailLoader;
}) {
  const ctxLoader = useContext(SessionDetailContext);
  const loader = loadDetail ?? ctxLoader;
  const cardId = useId();

  const [snap, setSnap] = useState<ControllerSnapshot>(() => ctrl.getSnapshot());
  const posRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ctrl.setCardId(cardId);
    return ctrl.subscribe(() => setSnap(ctrl.getSnapshot()));
  }, [ctrl, cardId]);

  const { mounted, leaving } = usePresence(snap.open, cardRef, LEAVE_ANIM_MS);

  // 同步 cardRef 给 controller（供 blur 判断焦点是否移进卡片）
  useEffect(() => {
    ctrl.setCardEl(mounted ? cardRef.current : null);
    return () => ctrl.setCardEl(null);
  }, [ctrl, mounted]);

  // 与现有 useDismiss 分层协调：Esc 只关最上面那层，且没有焦点在内时也能关
  const dismiss = useCallback(() => ctrl.closeNow(), [ctrl]);
  useDismiss(snap.open, cardRef, dismiss);

  // 详情加载状态
  const activeKey = snap.active?.key ?? '';
  const activeTarget = snap.active?.target ?? null;
  const [detail, setDetail] = useState<DetailState>({ who: '', key: '', status: 'loading', data: null, fromCache: false });

  useEffect(() => {
    if (!snap.open || !activeTarget) return;
    const running = activeTarget.kind === 'session' && activeTarget.dot === 'running';
    const key = activeKey;
    const who = targetWho(activeTarget);
    const cached = peekSessionDetail(loader, key, running);
    if (cached) {
      setDetail({ who, key, status: 'ready', data: cached, fromCache: true });
      return;
    }
    setDetail((prev) => (prev.who === who && prev.data
      ? { ...prev, key }
      : { who, key, status: 'loading', data: null, fromCache: false }));
    let alive = true;
    loadSessionDetail(loader, activeTarget.id, activeTarget.cwd, key, running).then(
      (data) => {
        if (!alive) return;
        setDetail((prev) => ({ who, key, status: 'ready', data, fromCache: prev.data !== null && prev.fromCache }));
      },
      () => {
        if (!alive) return;
        setDetail((prev) => (prev.data ? prev : { who, key, status: 'error', data: null, fromCache: false }));
      },
    );
    return () => { alive = false; };
  }, [snap.open, activeKey, activeTarget?.id, activeTarget?.cwd, activeTarget?.kind, activeTarget?.dot, loader]);

  // 关闭触发：触发元素所在的容器滚动（会话流自己滚、卡片内部滚动都不算）、窗口 resize / blur、侧栏收起
  useEffect(() => {
    if (!snap.open) return;
    const onScroll = (e: Event) => {
      const el = ctrl.getSnapshot().active?.el;
      if (!el || !(e.target as Node).contains(el)) return;
      ctrl.closeNow();
    };
    const onClose = () => ctrl.closeNow();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);

    // 侧栏收起时 AppShell 会给 .cz-shell__sidebar 写 aria-hidden="true"
    const aside = snap.active?.el.closest('.cz-shell__sidebar');
    let mo: MutationObserver | null = null;
    if (aside && typeof MutationObserver !== 'undefined') {
      mo = new MutationObserver(() => {
        if (aside.getAttribute('aria-hidden') === 'true') ctrl.closeNow();
      });
      mo.observe(aside, { attributes: true, attributeFilter: ['aria-hidden'] });
    }

    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
      mo?.disconnect();
    };
  }, [snap.open, snap.active?.el, ctrl]);

  // 定位与平滑高度过渡
  const [pos, setPos] = useState<CardPos | null>(null);
  const [heightPx, setHeightPx] = useState<number | null>(null);
  const [animReady, setAnimReady] = useState(false);

  // 每次完全卸载后重置 animReady，保证下次冷打开直接落位，不从上次位置滑过来
  useEffect(() => {
    if (!mounted) {
      setAnimReady(false);
      setPos(null);
      setHeightPx(null);
    }
  }, [mounted]);

  const measureAndPlace = useCallback(() => {
    const anchor = snap.active?.el;
    const card = cardRef.current;
    const inner = innerRef.current;
    if (!anchor || !card || !inner || !anchor.isConnected) return;

    const vb = viewportBounds();
    const cardW = Math.min(CARD_MAX_W, Math.max(160, vb.right - vb.left - VIEWPORT_MARGIN * 2));
    const maxH = Math.min(vb.bottom - vb.top - VIEWPORT_MARGIN * 2, window.innerHeight * 0.76, 620);
    const contentH = inner.offsetHeight;
    const nextH = contentH > 0 ? Math.min(contentH, maxH) : null;
    if (nextH !== null) setHeightPx(nextH);

    const cardH = nextH !== null ? nextH + 2 : card.offsetHeight || 180;
    setPos(computePosition(anchor, cardW, cardH, placement));
  }, [snap.active?.el, placement]);

  useLayoutEffect(() => {
    if (!mounted || !snap.active) return;
    measureAndPlace();
    if (!animReady && !reducedMotion()) {
      let raf2 = 0;
      const raf1 = window.requestAnimationFrame(() => {
        raf2 = window.requestAnimationFrame(() => setAnimReady(true));
      });
      return () => {
        window.cancelAnimationFrame(raf1);
        window.cancelAnimationFrame(raf2);
      };
    }
  }, [mounted, snap.active, detail.status, detail.key, measureAndPlace, animReady]);

  // 内容高度变化（如字体加载 / 详情填入 / 切换行）时平滑更新高度并重新防溢出夹紧
  useEffect(() => {
    if (!mounted) return;
    const inner = innerRef.current;
    if (!inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measureAndPlace());
    ro.observe(inner);
    return () => ro.disconnect();
  }, [mounted, measureAndPlace]);

  if (!mounted || !snap.active) return null;

  const target = snap.active.target;
  const who = targetWho(target);
  const curDetail: DetailState = detail.who === who ? detail : { who, key: activeKey, status: 'loading' as const, data: null, fromCache: false };
  const resolvedPos = pos ?? { x: -9999, y: -9999, side: placement === 'side' ? 'side' : 'below', origin: placement === 'side' ? 'left center' : 'top left' };
  const moveSmooth = animReady && pos !== null && !reducedMotion();
  const heightSmooth = animReady && pos !== null && !reducedMotion();

  return createPortal(
    <div
      ref={posRef}
      className={`cz-scard-pos${moveSmooth ? ' is-moving' : ''}`}
      style={{ transform: `translate3d(${Math.round(resolvedPos.x)}px, ${Math.round(resolvedPos.y)}px, 0)` }}
    >
      <div
        ref={cardRef}
        id={cardId}
        role="tooltip"
        className={`cz-scard cz-scard--${resolvedPos.side}${leaving ? ' is-leaving' : ''}`}
        style={{ transformOrigin: resolvedPos.origin } as CSSProperties}
        onPointerEnter={(e) => { if (!e.pointerType || e.pointerType === 'mouse') ctrl.cardEnter(); }}
        onPointerLeave={(e) => { if (!e.pointerType || e.pointerType === 'mouse') ctrl.cardLeave(); }}
        {...leavingProps(leaving)}
      >
        <div
          ref={scrollRef}
          className={`cz-scard__scroll${heightSmooth ? ' is-height-anim' : ''}`}
          style={heightPx !== null ? { height: `${heightPx}px` } : undefined}
        >
          <div ref={innerRef} className="cz-scard__inner">
            <div key={snap.switchSeq} className={`cz-scard__content${snap.switching ? ' is-crossfade' : ''}`}>
              <SessionCardBody target={target} detail={curDetail} workspaces={workspaces} />
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ───────────── 卡片正文 ─────────────

function formatModelFact(target: SessionCardTarget, d: SessionDetail | null): string | null {
  if (target.config) {
    const m = prettyModel(canonicalModel(target.config.model) ?? target.config.model);
    const e = EFFORTS.find((x) => x.id === target.config!.effort)?.label;
    return e ? `${m} · 思考 ${e}` : m;
  }
  const raw = d?.model ?? target.lastModel;
  if (!raw) return null;
  return prettyModel(canonicalModel(raw) ?? raw);
}

function statusInfo(target: SessionCardTarget): { cls: string; text: string } {
  if (target.kind === 'deleted') return { cls: 'deleted', text: '已删除' };
  if (target.dot === 'running') return { cls: 'running', text: '执行中' };
  if (target.dot === 'unread') return { cls: 'unread', text: '已完成，未查看' };
  return { cls: 'idle', text: '空闲' };
}

function pinText(pinned: PinKind | null): string | null {
  if (pinned === 'manual') return '已置顶';
  if (pinned === 'auto') return '执行中自动置顶';
  return null;
}

function SessionCardBody({
  target,
  detail,
  workspaces,
}: {
  target: SessionCardTarget;
  detail: DetailState;
  workspaces: Workspace[];
}) {
  const now = Date.now();
  const title = displayTitle(target.title);
  const titleNorm = title.trim();
  const status = statusInfo(target);
  const pin = target.kind === 'deleted' ? null : pinText(target.pinned);
  const ws = target.workspaceLabel ?? workspaceName(target.cwd, workspaces);

  const isLoading = detail.status === 'loading';
  const d = detail.status === 'ready' ? detail.data : null;
  const stagger = detail.status === 'ready' && !detail.fromCache;

  const skelRef = useRef<HTMLDivElement>(null);
  const skelPresence = usePresence(isLoading, skelRef, 140);

  // 最近内容：内容等于标题时不重复显示
  const latestPrompt = d ? (d.lastPrompt ?? d.firstPrompt) : null;
  const showFirst = Boolean(
    d?.firstPrompt &&
    d?.lastPrompt &&
    d.firstPrompt.trim() !== titleNorm &&
    d.firstPrompt.trim() !== d.lastPrompt.trim(),
  );
  const showLatest = Boolean(latestPrompt && latestPrompt.trim() !== titleNorm);
  const showReply = Boolean(d?.lastReply && d.lastReply.trim() !== titleNorm);
  const hasPreview = showFirst || showLatest || showReply;

  // 事实网格条目（没有值的不渲染）
  const modelVal = formatModelFact(target, d);
  const scaleVal = d && (d.userMessages > 0 || d.toolCalls > 0)
    ? `${d.userMessages} 条消息 · ${d.toolCalls} 次工具调用`
    : null;
  const activeTs = target.kind === 'deleted' ? d?.lastMessageAt ?? null : (d?.lastMessageAt ?? target.lastActiveAt);

  const facts: { key: string; label: string; value: ReactNode; mono?: boolean }[] = [];
  if (modelVal) facts.push({ key: 'model', label: '模型', value: modelVal });
  if (d?.branch) facts.push({ key: 'branch', label: '分支', value: d.branch });
  if (d?.contextTokens != null) facts.push({ key: 'ctx', label: '上下文', value: formatTokens(d.contextTokens) });
  if (scaleVal) facts.push({ key: 'scale', label: '规模', value: scaleVal });
  if (d?.createdAt != null) facts.push({ key: 'created', label: '创建时间', value: formatFullTime(d.createdAt, now) });
  if (target.kind === 'deleted') {
    facts.push({ key: 'deletedAt', label: '删除时间', value: formatFullTime(target.lastActiveAt, now) });
    if (activeTs != null) facts.push({ key: 'active', label: '最近活动', value: formatFullTime(activeTs, now) });
  } else if (activeTs != null) {
    facts.push({ key: 'active', label: '最近活动', value: formatFullTime(activeTs, now) });
  }
  facts.push({
    key: 'ws',
    label: '工作空间',
    value: (
      <span className="cz-scard__ws">
        <span className="cz-scard__ws-name">{ws}</span>
        <span className="cz-scard__ws-path">{target.cwd}</span>
      </span>
    ),
  });
  if (target.account) facts.push({ key: 'account', label: '账号', value: target.account });

  let staggerIdx = 0;
  const staggerProps = () => (stagger ? { className: 'cz-scard__stagger', style: { '--stagger': staggerIdx++ } as CSSProperties } : {});

  return (
    <>
      {/* 头部：完整标题 + 状态行 */}
      <div className="cz-scard__head">
        <div className="cz-scard__title">{title}</div>
        <div className="cz-scard__status-row">
          <span className="cz-scard__status">
            <span className={`cz-scard__dot cz-scard__dot--${status.cls}`} />
            <span>{status.text}</span>
          </span>
          {pin && <span className={`cz-scard__pin${target.pinned === 'manual' ? ' is-manual' : ''}`}>{pin}</span>}
        </div>
      </div>

      {/* 详情加载骨架 / 最近内容 / 失败提示 */}
      {(skelPresence.mounted || hasPreview || detail.status === 'error') && (
        <div
          className={`cz-scard__section cz-scard__detail-slot${
            !isLoading && !hasPreview && detail.status !== 'error' ? ' cz-scard__detail-slot--ghost' : ''
          }`}
        >
          {skelPresence.mounted && (
            <div
              ref={skelRef}
              className={`cz-scard__skel${skelPresence.leaving ? ' is-leaving' : ''}`}
              aria-hidden="true"
            >
              <div className="cz-scard__skel-group">
                <span className="cz-scard__skel-bar" style={{ width: '28%', height: 10 }} />
                <span className="cz-scard__skel-bar" style={{ width: '94%', height: 12 }} />
                <span className="cz-scard__skel-bar" style={{ width: '76%', height: 12 }} />
              </div>
              <div className="cz-scard__skel-group">
                <span className="cz-scard__skel-bar" style={{ width: '24%', height: 10 }} />
                <span className="cz-scard__skel-bar" style={{ width: '88%', height: 12 }} />
              </div>
            </div>
          )}

          {hasPreview && (
            <div className="cz-scard__preview">
              {showFirst && (
                <div {...staggerProps()}>
                  <div className="cz-scard__sublabel">最初</div>
                  <div className="cz-scard__excerpt cz-scard__excerpt--2">{d!.firstPrompt}</div>
                </div>
              )}
              {showLatest && (
                <div {...staggerProps()}>
                  <div className="cz-scard__sublabel">最近消息</div>
                  <div className="cz-scard__excerpt cz-scard__excerpt--3">{latestPrompt}</div>
                </div>
              )}
              {showReply && (
                <div {...staggerProps()}>
                  <div className="cz-scard__sublabel">最近回复</div>
                  <div className="cz-scard__excerpt cz-scard__excerpt--3 cz-scard__excerpt--reply">{d!.lastReply}</div>
                </div>
              )}
            </div>
          )}

          {detail.status === 'error' && (
            <div className="cz-scard__error">详情读取失败</div>
          )}
        </div>
      )}

      {/* 事实网格 */}
      <div className="cz-scard__section">
        <dl className={`cz-scard__facts${stagger ? ' cz-scard__stagger' : ''}`} style={stagger ? { '--stagger': staggerIdx++ } as CSSProperties : undefined}>
          {facts.map((f) => (
            <div key={f.key} className="cz-scard__fact">
              <dt className="cz-scard__fact-k">{f.label}</dt>
              <dd className="cz-scard__fact-v">{f.value}</dd>
            </div>
          ))}
        </dl>
      </div>

      {/* 底部弱提示（仅头部卡片） */}
      {target.hint && (
        <div className="cz-scard__foot">{target.hint}</div>
      )}
    </>
  );
}
