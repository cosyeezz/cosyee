// 两步验证（2FA / TOTP）主浮层面板。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { copyText } from '../../core/browser';
import { useTwoFaStore, type TwoFaClient } from '../../core/twofa/store';
import { formatTotpCode, generateTotp, totpRemaining } from '../../core/twofa/totp';
import {
  buildRecursiveCounts,
  buildViewModel,
  getDescendantIds,
  issuerColorKey,
  issuerInitial,
  normalizeTagColor,
  sortBetween,
  type EntryViewItem,
  type GroupViewItem,
} from '../../core/twofa/tree';
import type {
  TwoFaCreateEntryInput,
  TwoFaData,
  TwoFaDeleteGroupMode,
  TwoFaEntry,
  TwoFaGroup,
  TwoFaImportResult,
  TwoFaTag,
  TwoFaTagColor,
} from '../../core/twofa/types';
import { Icon } from '../icons/Icon';
import { EntryForm } from './TwoFactorForms';
import { TwoFactorImportView, type TwoFaImportMethod } from './TwoFactorImport';
import {
  AddMethodMenu,
  ConfirmModal,
  CreateTagModal,
  DeleteGroupModal,
  EntryTagsModal,
  GroupNameModal,
  ManageMenu,
  MoveGroupModal,
  RowContextMenu,
  TagManagerModal,
  type AddMethod,
  type ContextTarget,
} from './TwoFactorMenus';
import { inertLeaving, useAlwaysPresence, useFlipList, useNavSlide } from './motion';
import { useTwoFaDrag, type DragKind, type DragResult } from './useTwoFaDrag';
import './TwoFactorPanel.css';

const SETUP_CMD = '/cosyee:2fa 第一次使用，请帮我配置 2FA 同步';
const RING_R = 9.5;
const RING_C = 2 * Math.PI * RING_R;
/** 排序值步长：新增 / 追加 / 重排时的间距，给后续中点插入留足空间 */
const SORT_STEP = 1024;
/** 全局倒计时对应的标准周期 */
const STD_PERIOD = 30;
const EMPTY_GROUP_HINT = '把验证码拖到这里，或用「移动到…」';

export interface TwoFactorPanelProps {
  open: boolean;
  onClose: () => void;
  /** 可选自定义数据源（用于 ?dev=2fa 调试页与单测） */
  client?: TwoFaClient;
  /** 是否订阅全局 WS 2fa.changed（默认 true） */
  subscribeSocket?: boolean;
  /** 可选初始固定时间戳（仅调试/截图演示用，例如展示最后 5 秒警示态） */
  fixedNowMs?: number;
  /** 可选初始分组 ID（仅调试/截图演示用） */
  initialGroupId?: string | null;
  /** 可选初始已复制条目的 ID（仅调试/截图演示用） */
  initialCopiedId?: string | null;
  /** 可选强制窄屏全屏样式（仅调试/截图演示用） */
  forceNarrow?: boolean;
  /** 禁用外部点击自动关闭（仅调试多场景同屏截图用） */
  disableOutsideClose?: boolean;
  /** 可选初始打开「添加方式」气泡（仅调试/截图演示用） */
  initialAddMenuOpen?: boolean;
}

type PanelMode =
  | { kind: 'list' }
  | { kind: 'add' }
  | { kind: 'edit'; entry: TwoFaEntry }
  | { kind: 'import'; method: TwoFaImportMethod };

type NavRow =
  | { kind: 'entry'; key: string; item: EntryViewItem }
  | { kind: 'group'; key: string; item: GroupViewItem };

/** 「＋」菜单里的导入类方式 → 导入视图的方式名 */
const IMPORT_METHOD_OF: Partial<Record<AddMethod, TwoFaImportMethod>> = {
  scan: 'scan',
  image: 'image',
  url: 'link',
  file: 'backup',
};

/** 乐观覆盖：拖动提交后、服务端回写前，本地先按新顺序 / 新归属显示 */
interface EntryOverride {
  sort?: number;
  groupId?: string | null;
}
interface GroupOverride {
  sort?: number;
  parentId?: string | null;
}

function formatFooterSyncTime(iso?: string): string {
  if (!iso) return '尚未同步';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return '刚刚同步';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前同步`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前同步`;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${m}-${day} 同步`;
}

/** 把拖动后的新顺序按 id 套到列表上；缺失 / 多余时退回原列表，避免丢行 */
function applyOrder<T>(items: T[], idOf: (t: T) => string, order: string[] | null): T[] {
  if (!order) return items;
  const map = new Map(items.map((it) => [idOf(it), it] as const));
  const out: T[] = [];
  for (const id of order) {
    const it = map.get(id);
    if (it) out.push(it);
  }
  return out.length === items.length ? out : items;
}

/**
 * 计算一次拖动排序要写入的 sort。
 * 优先只改被拖项：取新邻居的中点（分组要求整数，向下取整）；
 * 中点落不进两邻居之间（间距耗尽 / 邻居同值）时，整段按 i*1024 重排，只写入值有变化的项。
 */
function planSorts(order: string[], id: string, sorts: Map<string, number>, integer: boolean): Array<[string, number]> {
  const idx = order.indexOf(id);
  if (idx < 0) return [];
  const prev = idx > 0 ? (sorts.get(order[idx - 1]!) ?? null) : null;
  const next = idx < order.length - 1 ? (sorts.get(order[idx + 1]!) ?? null) : null;
  let cand = sortBetween(prev, next);
  if (integer) cand = Math.floor(cand);
  const fits = (prev === null || cand > prev) && (next === null || cand < next);
  if (fits) return [[id, cand]];
  const out: Array<[string, number]> = [];
  order.forEach((x, i) => {
    const v = i * SORT_STEP;
    if (sorts.get(x) !== v) out.push([x, v]);
  });
  return out;
}

/** 倒计时环：用 rAF 直接更新 stroke-dashoffset，避免整面板每秒 60 次重渲染。inline 时数字写在环右侧（顶栏总倒计时用） */
function CountdownRing({
  period,
  fixedNowMs,
  size = 22,
  inline = false,
}: {
  period: number;
  fixedNowMs?: number;
  size?: number;
  inline?: boolean;
}) {
  const circleRef = useRef<SVGCircleElement>(null);
  const p = period > 0 ? period : STD_PERIOD;
  const initial = totpRemaining(p, fixedNowMs ?? Date.now());
  const [remaining, setRemaining] = useState(initial.remaining);

  useEffect(() => {
    if (fixedNowMs !== undefined) {
      const r = totpRemaining(p, fixedNowMs);
      setRemaining(r.remaining);
      if (circleRef.current) {
        circleRef.current.style.strokeDashoffset = String(RING_C * (1 - r.progress));
      }
      return;
    }
    let rafId = 0;
    let lastSec = -1;
    const tick = () => {
      const r = totpRemaining(p, Date.now());
      if (circleRef.current) {
        circleRef.current.style.strokeDashoffset = String(RING_C * (1 - r.progress));
      }
      if (r.remaining !== lastSec) {
        lastSec = r.remaining;
        setRemaining(r.remaining);
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [p, fixedNowMs]);

  const warn = remaining <= 5;
  const initialOffset = RING_C * (1 - initial.progress);

  return (
    <span
      className={`cz-2fa-ring${inline ? ' is-inline' : ''}${warn ? ' is-warn' : ''}`}
      title={`验证码剩余 ${remaining} 秒`}
    >
      <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
        <circle className="cz-2fa-ring__track" cx="12" cy="12" r={RING_R} />
        <circle
          ref={circleRef}
          className="cz-2fa-ring__arc"
          cx="12"
          cy="12"
          r={RING_R}
          strokeDasharray={RING_C}
          strokeDashoffset={initialOffset}
        />
      </svg>
      <span className="cz-2fa-ring__num">{inline ? `${remaining}s` : remaining}</span>
    </span>
  );
}

export default function TwoFactorPanel({
  open,
  onClose,
  client,
  subscribeSocket = true,
  fixedNowMs,
  initialGroupId = null,
  initialCopiedId = null,
  forceNarrow = false,
  disableOutsideClose = false,
  initialAddMenuOpen = false,
}: TwoFactorPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const gearRef = useRef<HTMLButtonElement>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const tagsRowRef = useRef<HTMLDivElement>(null);

  const { mounted, leaving } = useAlwaysPresence(open, panelRef, 130);

  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number>(0);
  const flashToast = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const store = useTwoFaStore({
    open,
    client,
    subscribeSocket,
    onToast: flashToast,
  });
  const storeRef = useRef(store);
  storeRef.current = store;

  // 导航与筛选状态
  const [mode, setMode] = useState<PanelMode>({ kind: 'list' });
  const [currentGroupId, setCurrentGroupId] = useState<string | null>(initialGroupId);
  const [navDir, setNavDir] = useState<-1 | 0 | 1>(0);
  const [query, setQuery] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);

  // 复制就地变形状态
  const [copiedId, setCopiedId] = useState<string | null>(initialCopiedId);
  const copiedTimer = useRef<number>(0);
  const [setupCopied, setSetupCopied] = useState(false);
  const setupTimer = useRef<number>(0);

  // 附属菜单与弹窗状态
  const [manageOpen, setManageOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(initialAddMenuOpen);
  const [ctxTarget, setCtxTarget] = useState<ContextTarget | null>(null);
  const [moveEntryTarget, setMoveEntryTarget] = useState<TwoFaEntry | null>(null);
  const [moveGroupTarget, setMoveGroupTarget] = useState<TwoFaGroup | null>(null);
  const [tagsEntryTarget, setTagsEntryTarget] = useState<TwoFaEntry | null>(null);
  const [deleteEntryTarget, setDeleteEntryTarget] = useState<TwoFaEntry | null>(null);
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<TwoFaGroup | null>(null);
  const [createSubgroupParent, setCreateSubgroupParent] = useState<{ parentId: string | null } | null>(null);
  const [renameGroupTarget, setRenameGroupTarget] = useState<TwoFaGroup | null>(null);
  const [createTagOpen, setCreateTagOpen] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);

  const hasSubOverlay =
    manageOpen ||
    addOpen ||
    !!ctxTarget ||
    !!moveEntryTarget ||
    !!moveGroupTarget ||
    !!tagsEntryTarget ||
    !!deleteEntryTarget ||
    !!deleteGroupTarget ||
    !!createSubgroupParent ||
    !!renameGroupTarget ||
    createTagOpen ||
    tagManagerOpen;

  // 打开面板时自动聚焦搜索框
  useEffect(() => {
    if (!open) {
      setManageOpen(false);
      setAddOpen(false);
      setCtxTarget(null);
      return;
    }
    if (mode.kind === 'list') {
      const t = window.setTimeout(() => {
        searchRef.current?.focus({ preventScroll: true });
      }, 30);
      return () => window.clearTimeout(t);
    }
  }, [open, mode.kind]);

  // 定时计算 TOTP 验证码（每秒检查一次，仅在秒边界更新）
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [timeSlotKey, setTimeSlotKey] = useState(() =>
    Math.floor((fixedNowMs ?? Date.now()) / 1000),
  );

  useEffect(() => {
    if (!open) return;
    if (fixedNowMs !== undefined) {
      setTimeSlotKey(Math.floor(fixedNowMs / 1000));
      return;
    }
    const tick = () => setTimeSlotKey(Math.floor(Date.now() / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [open, fixedNowMs]);

  useEffect(() => {
    if (!open || store.data.entries.length === 0) return;
    let alive = true;
    void Promise.all(
      store.data.entries.map(async (e) => {
        try {
          const code = await generateTotp(e, timeSlotKey);
          return [e.id, code] as const;
        } catch {
          return [e.id, '------'] as const;
        }
      }),
    ).then((pairs) => {
      if (!alive) return;
      const next: Record<string, string> = {};
      for (const [id, code] of pairs) next[id] = code;
      setCodes(next);
    });
    return () => { alive = false; };
  }, [open, store.data.entries, timeSlotKey]);

  // ───────── 乐观覆盖 + 串行更新队列（拖动排序 / 拖入分组） ─────────
  const [entryOv, setEntryOv] = useState<Record<string, EntryOverride>>({});
  const [groupOv, setGroupOv] = useState<Record<string, GroupOverride>>({});

  /** 合并了乐观覆盖的数据：视图模型与计数都基于它，拖完立刻就位，不等网络往返 */
  const data = useMemo<TwoFaData>(() => {
    const eKeys = Object.keys(entryOv);
    const gKeys = Object.keys(groupOv);
    if (eKeys.length === 0 && gKeys.length === 0) return store.data;
    return {
      ...store.data,
      entries: eKeys.length
        ? store.data.entries.map((e) => (entryOv[e.id] ? { ...e, ...entryOv[e.id] } : e))
        : store.data.entries,
      groups: gKeys.length
        ? store.data.groups.map((g) => (groupOv[g.id] ? { ...g, ...groupOv[g.id] } : g))
        : store.data.groups,
    };
  }, [store.data, entryOv, groupOv]);
  const dataRef = useRef(data);
  dataRef.current = data;
  const rawDataRef = useRef(store.data);
  rawDataRef.current = store.data;

  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const versionsRef = useRef(new Map<string, number>());
  const pendingRef = useRef(new Map<string, number>());

  /** 把一次 PATCH 排进串行队列：逐个提交，版本号取「本地已知最新」避免自己和自己 409 */
  const queuePatch = useCallback(
    (kind: DragKind, id: string, patch: { sort?: number; groupId?: string | null; parentId?: string | null }) => {
      const key = `${kind}:${id}`;
      if (kind === 'entry') {
        setEntryOv((prev) => ({ ...prev, [id]: { ...prev[id], sort: patch.sort ?? prev[id]?.sort, ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}) } }));
      } else {
        setGroupOv((prev) => ({ ...prev, [id]: { ...prev[id], sort: patch.sort ?? prev[id]?.sort, ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}) } }));
      }
      pendingRef.current.set(key, (pendingRef.current.get(key) ?? 0) + 1);
      queueRef.current = queueRef.current.then(async () => {
        try {
          const raw = rawDataRef.current;
          const cur = kind === 'entry' ? raw.entries.find((e) => e.id === id) : raw.groups.find((g) => g.id === id);
          if (!cur) return;
          const version = Math.max(versionsRef.current.get(key) ?? 0, cur.version);
          const s = storeRef.current;
          const res =
            kind === 'entry'
              ? await s.updateEntry(id, {
                  version,
                  ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
                  ...(patch.groupId !== undefined ? { groupId: patch.groupId } : {}),
                })
              : await s.updateGroup(id, {
                  version,
                  ...(patch.sort !== undefined ? { sort: patch.sort } : {}),
                  ...(patch.parentId !== undefined ? { parentId: patch.parentId } : {}),
                });
          const nv = (res as { version?: number } | undefined)?.version;
          if (typeof nv === 'number') versionsRef.current.set(key, nv);
        } catch {
          // 冲突 / 失败已由 store 提示并刷新；这里只需要让覆盖退场，回到服务端数据
        } finally {
          const left = (pendingRef.current.get(key) ?? 1) - 1;
          if (left <= 0) {
            pendingRef.current.delete(key);
            if (kind === 'entry') {
              setEntryOv((prev) => {
                if (!(id in prev)) return prev;
                const { [id]: _drop, ...rest } = prev;
                return rest;
              });
            } else {
              setGroupOv((prev) => {
                if (!(id in prev)) return prev;
                const { [id]: _drop, ...rest } = prev;
                return rest;
              });
            }
          } else {
            pendingRef.current.set(key, left);
          }
        }
      });
    },
    [],
  );

  // 视图模型
  const vm = useMemo(
    () => buildViewModel(data, currentGroupId, query, selectedTags),
    [data, currentGroupId, query, selectedTags],
  );

  const recursiveCounts = useMemo(
    () => buildRecursiveCounts(data.entries, data.groups),
    [data.entries, data.groups],
  );

  const tagMap = useMemo(() => {
    const m = new Map<string, TwoFaTag>();
    for (const t of store.data.tags) m.set(t.id, t);
    return m;
  }, [store.data.tags]);

  // ───────── 拖动 ─────────
  const dragEnabled = open && mode.kind === 'list' && vm.mode !== 'search' && !hasSubOverlay;

  const canDropInto = useCallback((kind: DragKind, id: string, groupId: string | null) => {
    const d = dataRef.current;
    if (kind === 'entry') {
      const e = d.entries.find((x) => x.id === id);
      return !!e && e.groupId !== groupId;
    }
    if (groupId === null) {
      const g = d.groups.find((x) => x.id === id);
      return !!g && g.parentId !== null;
    }
    const g = d.groups.find((x) => x.id === id);
    if (!g || g.parentId === groupId) return false;
    return !getDescendantIds(id, d.groups).has(groupId);
  }, []);

  const handleDragCommit = useCallback(
    (r: DragResult) => {
      const d = dataRef.current;
      const groupName = (gid: string | null) => (gid ? (d.groups.find((g) => g.id === gid)?.name ?? '分组') : '全部');
      if (r.type === 'reorder') {
        if (r.kind === 'entry') {
          const sorts = new Map(d.entries.map((e) => [e.id, e.sort] as const));
          for (const [id, sort] of planSorts(r.order, r.id, sorts, false)) queuePatch('entry', id, { sort });
        } else {
          const sorts = new Map(d.groups.map((g) => [g.id, g.sort] as const));
          for (const [id, sort] of planSorts(r.order, r.id, sorts, true)) queuePatch('group', id, { sort });
        }
        return;
      }
      // 拖入分组 / 面包屑：排到目标末尾
      const target = r.groupId;
      if (r.kind === 'entry') {
        const sibs = d.entries.filter((e) => e.groupId === target && e.id !== r.id);
        const sort = sibs.length ? Math.max(...sibs.map((e) => e.sort)) + SORT_STEP : 0;
        queuePatch('entry', r.id, { groupId: target, sort });
      } else {
        const sibs = d.groups.filter((g) => g.parentId === target && g.id !== r.id);
        const sort = sibs.length ? Math.max(...sibs.map((g) => g.sort)) + SORT_STEP : 0;
        queuePatch('group', r.id, { parentId: target, sort });
      }
      flashToast(`已移到「${groupName(target)}」`);
    },
    [flashToast, queuePatch],
  );

  const handleTapHold = useCallback((kind: DragKind, id: string, x: number, y: number) => {
    const d = dataRef.current;
    if (kind === 'entry') {
      const entry = d.entries.find((e) => e.id === id);
      if (entry) setCtxTarget({ kind: 'entry', entry, x, y });
    } else {
      const group = d.groups.find((g) => g.id === id);
      if (group) setCtxTarget({ kind: 'group', group, x, y });
    }
  }, []);

  const { drag, rowHandlers } = useTwoFaDrag({
    enabled: dragEnabled,
    panelRef,
    bodyRef: listRef,
    canDropInto,
    onCommit: handleDragCommit,
    onTapHold: handleTapHold,
  });

  /** 当前显示的各分区列表（拖动中按虚拟顺序排列，被拖项留在插入位置当占位） */
  const view = useMemo(() => {
    const ord = (section: string) => (drag && drag.section === section ? drag.order : null);
    if (vm.mode === 'search') return { pinned: [], groups: [], entries: vm.entries };
    if (vm.mode === 'root') {
      return {
        pinned: applyOrder(vm.pinned, (i) => i.entry.id, ord('pinned')),
        groups: applyOrder(vm.groups, (i) => i.group.id, ord('groups')),
        entries: applyOrder(vm.ungrouped, (i) => i.entry.id, ord('entries')),
      };
    }
    return {
      pinned: [],
      groups: applyOrder(vm.groups, (i) => i.group.id, ord('groups')),
      entries: applyOrder(vm.entries, (i) => i.entry.id, ord('entries')),
    };
  }, [vm, drag]);

  // 扁平键盘导航列表
  const navRows = useMemo<NavRow[]>(() => {
    if (vm.mode === 'search') {
      return view.entries.map((item) => ({ kind: 'entry', key: `s:${item.entry.id}`, item }));
    }
    const entryPrefix = vm.mode === 'root' ? 'u' : 'e';
    return [
      ...view.pinned.map((item): NavRow => ({ kind: 'entry', key: `p:${item.entry.id}`, item })),
      ...view.groups.map((item): NavRow => ({ kind: 'group', key: `g:${item.group.id}`, item })),
      ...view.entries.map((item): NavRow => ({ kind: 'entry', key: `${entryPrefix}:${item.entry.id}`, item })),
    ];
  }, [vm.mode, view]);

  // FLIP 顺序签名 & 进出分组滑动
  const orderSignature = useMemo(() => navRows.map((r) => r.key).join('|'), [navRows]);
  useFlipList(listRef, orderSignature);
  useNavSlide(stageRef, `${vm.mode}:${currentGroupId ?? 'root'}`, navDir);

  // 标签行左右渐隐遮罩状态
  const [tagFade, setTagFade] = useState({ left: false, right: false });
  const updateTagFade = useCallback(() => {
    const el = tagsRowRef.current;
    if (!el) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setTagFade((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  useLayoutEffect(() => {
    updateTagFade();
    const el = tagsRowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateTagFade);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateTagFade, store.data.tags.length, mounted]);

  // 进入/返回分组
  const enterGroup = useCallback((groupId: string) => {
    setNavDir(1);
    setCurrentGroupId(groupId);
    setActiveKey(null);
  }, []);

  const navigateBreadcrumb = useCallback((targetGroupId: string | null) => {
    if (targetGroupId === currentGroupId) return;
    setNavDir(-1);
    setCurrentGroupId(targetGroupId);
    setActiveKey(null);
  }, [currentGroupId]);

  const goUpOneLevel = useCallback(() => {
    if (vm.mode !== 'group') return false;
    const parentId = vm.breadcrumb.length >= 2 ? vm.breadcrumb[vm.breadcrumb.length - 2]!.id : null;
    setNavDir(-1);
    setCurrentGroupId(parentId);
    setActiveKey(null);
    return true;
  }, [vm]);

  // 点击外部关闭（忽略标题栏和顶栏触发按钮，也忽略打开的子弹窗/菜单）
  useEffect(() => {
    if (!open || disableOutsideClose) return;
    const onDown = (e: MouseEvent) => {
      if (hasSubOverlay) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest('[data-twofa-trigger]') || target.closest('cosyee-titlebar')) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, disableOutsideClose, hasSubOverlay, onClose]);

  // 复制验证码 + 记录使用次数
  const handleCopyEntry = useCallback(
    async (entry: TwoFaEntry) => {
      let code = codes[entry.id];
      if (!code || code === '------') {
        try {
          code = await generateTotp(entry, Math.floor((fixedNowMs ?? Date.now()) / 1000));
        } catch {
          flashToast('生成验证码失败');
          return;
        }
      }
      const ok = await copyText(code);
      if (!ok) {
        flashToast('复制失败，请手动复制');
        return;
      }
      setCopiedId(entry.id);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1300);
      void store.recordUsage(entry.id);
    },
    [codes, fixedNowMs, flashToast, store],
  );

  // 复制未配置同步时的引导命令
  const handleCopySetupCmd = useCallback(async () => {
    const ok = await copyText(SETUP_CMD);
    if (!ok) {
      flashToast('复制失败');
      return;
    }
    setSetupCopied(true);
    window.clearTimeout(setupTimer.current);
    setupTimer.current = window.setTimeout(() => setSetupCopied(false), 2400);
    flashToast('已复制，粘贴到对话里发送');
  }, [flashToast]);

  // 键盘导航与 Esc 逐级返回
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (hasSubOverlay) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (mode.kind !== 'list') {
          setMode({ kind: 'list' });
          return;
        }
        if (query || selectedTags.length > 0) {
          setQuery('');
          setSelectedTags([]);
          return;
        }
        if (goUpOneLevel()) return;
        onClose();
        return;
      }
      if (mode.kind !== 'list') return;

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (navRows.length === 0) return;
        e.preventDefault();
        const curIdx = navRows.findIndex((r) => r.key === activeKey);
        const nextIdx =
          curIdx < 0
            ? e.key === 'ArrowDown'
              ? 0
              : navRows.length - 1
            : (curIdx + (e.key === 'ArrowDown' ? 1 : navRows.length - 1)) % navRows.length;
        const nextKey = navRows[nextIdx]!.key;
        setActiveKey(nextKey);
        const el = listRef.current?.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(nextKey)}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        const targetRow = navRows.find((r) => r.key === activeKey) ?? (query.trim() && navRows.length === 1 ? navRows[0] : undefined);
        if (!targetRow) return;
        e.preventDefault();
        if (targetRow.kind === 'group') enterGroup(targetRow.item.group.id);
        else void handleCopyEntry(targetRow.item.entry);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, hasSubOverlay, mode.kind, query, selectedTags.length, goUpOneLevel, onClose, navRows, activeKey, enterGroup, handleCopyEntry]);

  const handleSearchKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !query && currentGroupId !== null && selectedTags.length === 0) {
      e.preventDefault();
      goUpOneLevel();
    }
  };

  // 导入完成：汇总提示并回到列表
  const handleImportDone = (res: TwoFaImportResult) => {
    const parts: string[] = [];
    if (res.added > 0) parts.push(`导入 ${res.added} 条`);
    if (res.skipped > 0) parts.push(`跳过重复 ${res.skipped} 条`);
    if (res.unsupported > 0) parts.push(`不支持 ${res.unsupported} 条`);
    if (res.errors.length > 0) parts.push(res.errors[0]!);
    flashToast(parts.length ? parts.join('，') : '未发现可导入的验证码');
    setMode({ kind: 'list' });
  };

  // 「＋」菜单选择
  const handleAddPick = (m: AddMethod) => {
    if (m === 'manual') {
      setMode({ kind: 'add' });
    } else if (m === 'group') {
      setCreateSubgroupParent({ parentId: currentGroupId });
    } else {
      const method = IMPORT_METHOD_OF[m];
      if (method) setMode({ kind: 'import', method });
    }
  };

  // 立即同步
  const handleSyncNow = async () => {
    try {
      const s = await store.syncNow();
      flashToast(s.lastError ? `同步失败：${s.lastError}` : '同步完成');
    } catch (ex) {
      flashToast(ex instanceof Error ? ex.message : '同步失败');
    }
  };

  // 置顶切换
  const handleTogglePin = async (entry: TwoFaEntry) => {
    try {
      await store.updateEntry(entry.id, { version: entry.version, pinned: !entry.pinned });
    } catch {
      // 409 已由 store 提示并刷新
    }
  };

  const openEntryContext = (entry: TwoFaEntry, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxTarget({ kind: 'entry', entry, x: e.clientX, y: e.clientY });
  };

  const openGroupContext = (group: TwoFaGroup, e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxTarget({ kind: 'group', group, x: e.clientX, y: e.clientY });
  };

  const toggleFilterTag = (tagId: string) => {
    setSelectedTags((prev) => (prev.includes(tagId) ? prev.filter((x) => x !== tagId) : [...prev, tagId]));
  };

  const handleCreateOrEditSubmit = async (values: TwoFaCreateEntryInput) => {
    if (mode.kind === 'add') {
      await store.createEntry(values);
      flashToast('已添加验证码');
    } else if (mode.kind === 'edit') {
      await store.updateEntry(mode.entry.id, { version: mode.entry.version, ...values });
      flashToast('已保存修改');
    }
    setMode({ kind: 'list' });
  };

  // 渲染单个验证码行
  const renderEntryRow = (item: EntryViewItem, rowKey: string, showPath: boolean, section: string | null) => {
    const { entry, groupPath } = item;
    const isActive = activeKey === rowKey;
    const isCopied = copiedId === entry.id;
    const isGhost = !!drag && drag.kind === 'entry' && drag.id === entry.id;
    const rawCode = codes[entry.id] ?? '------';
    const displayCode = formatTotpCode(rawCode);
    const avColor = issuerColorKey(entry.issuer || entry.account);
    const initial = issuerInitial(entry.issuer, entry.account);
    const entryTags = entry.tags.map((id) => tagMap.get(id)).filter((t): t is TwoFaTag => !!t);
    const dragProps = section ? { 'data-drag-id': entry.id, ...rowHandlers('entry', entry.id, section) } : {};

    return (
      <div
        key={rowKey}
        data-row-key={rowKey}
        {...(isGhost ? { 'data-drag-ghost': '' } : {})}
        className={`cz-2fa-row${isActive ? ' is-active' : ''}${isCopied ? ' is-copied' : ''}${isGhost ? ' is-ghost' : ''}`}
        role="button"
        tabIndex={-1}
        onClick={() => void handleCopyEntry(entry)}
        onMouseEnter={() => setActiveKey(rowKey)}
        onContextMenu={(e) => openEntryContext(entry, e)}
        {...dragProps}
      >
        <span className={`cz-2fa-av is-c-${avColor}`} aria-hidden="true">
          {initial}
        </span>

        <div className="cz-2fa-row__info">
          <div className="cz-2fa-row__top">
            {entry.pinned && (
              <Icon name="pin-on" size={11} className="cz-2fa-pin-mark" title="已置顶" />
            )}
            <span className="cz-2fa-row__issuer" title={entry.issuer}>{entry.issuer}</span>
            {entryTags.length > 0 && (
              <span className="cz-2fa-row__dots" title={entryTags.map((t) => t.name).join(' · ')}>
                {entryTags.slice(0, 4).map((t) => (
                  <span key={t.id} className={`cz-2fa-tdot is-c-${normalizeTagColor(t.color)}`} />
                ))}
              </span>
            )}
          </div>
          <div className="cz-2fa-row__sub">
            {entry.account && (
              <span className="cz-2fa-row__account" title={entry.account}>{entry.account}</span>
            )}
            {showPath && groupPath && (
              <span className="cz-2fa-row__path" title={groupPath}>
                {entry.account ? '· ' : ''}{groupPath}
              </span>
            )}
          </div>
        </div>

        <div className={`cz-2fa-code-slot${isCopied ? ' is-copied' : ''}`}>
          <span className="cz-2fa-code" aria-label={`验证码 ${rawCode}`}>{displayCode}</span>
          <span className="cz-2fa-copied" aria-live="polite">
            <Icon name="check" size={12} />
            <span>已复制</span>
          </span>
        </div>

        {/* 行尾槽位：平时是非 30 秒周期的小环（30 秒的由顶栏总倒计时代表），悬停 / 聚焦时淡入「⋯」 */}
        <div className="cz-2fa-tail">
          <span className="cz-2fa-tail__idle">
            {entry.period !== STD_PERIOD && <CountdownRing period={entry.period} fixedNowMs={fixedNowMs} />}
          </span>
          <button
            type="button"
            className="cz-2fa-more"
            title="更多操作"
            aria-label="更多操作"
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setCtxTarget({ kind: 'entry', entry, x: r.right - 160, y: r.bottom + 4 });
            }}
          >
            <Icon name="more" size={15} />
          </button>
        </div>
      </div>
    );
  };

  // 渲染单个分组行
  const renderGroupRow = (item: GroupViewItem) => {
    const { group, entryCount } = item;
    const rowKey = `g:${group.id}`;
    const isActive = activeKey === rowKey;
    const isGhost = !!drag && drag.kind === 'group' && drag.id === group.id;
    const isDropTarget = !!drag && drag.intoGroupId === group.id;
    return (
      <div
        key={rowKey}
        data-row-key={rowKey}
        data-drag-id={group.id}
        data-drop-group={group.id}
        {...(isGhost ? { 'data-drag-ghost': '' } : {})}
        className={`cz-2fa-row cz-2fa-row--group${isActive ? ' is-active' : ''}${isGhost ? ' is-ghost' : ''}${isDropTarget ? ' is-drop-target' : ''}`}
        role="button"
        tabIndex={-1}
        onClick={() => enterGroup(group.id)}
        onMouseEnter={() => setActiveKey(rowKey)}
        onContextMenu={(e) => openGroupContext(group, e)}
        {...rowHandlers('group', group.id, 'groups')}
      >
        <span className="cz-2fa-folder-ic" aria-hidden="true">
          <Icon name={isDropTarget ? 'folder-open' : 'folder'} size={17} />
        </span>
        <span className="cz-2fa-group__name" title={group.name}>{group.name}</span>
        <span className="cz-2fa-group__count" title={`${entryCount} 个验证码`}>{entryCount}</span>
        <div className="cz-2fa-tail">
          <span className="cz-2fa-tail__idle">
            <Icon name="chevron-right" size={14} className="cz-2fa-group__chev" />
          </span>
          <button
            type="button"
            className="cz-2fa-more"
            title="分组操作"
            aria-label="分组操作"
            aria-haspopup="menu"
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              setCtxTarget({ kind: 'group', group, x: r.right - 160, y: r.bottom + 4 });
            }}
          >
            <Icon name="more" size={15} />
          </button>
        </div>
      </div>
    );
  };

  // 渲染面包屑（层级 > 2 时中间折叠为 …）。除当前层外的每一段都是拖放目标（data-crumb；空串 = 根）
  const renderBreadcrumb = (chain: TwoFaGroup[]) => {
    const collapsed = chain.length > 2;
    const middleNames = collapsed ? chain.slice(0, -2).map((g) => g.name).join(' / ') : '';
    const parentGroup = collapsed ? chain[chain.length - 2]! : chain.length === 2 ? chain[0]! : null;
    const currentGroup = chain[chain.length - 1]!;
    const dropOn = (gid: string | null) => (drag && drag.crumbId === gid ? ' is-drop' : '');

    return (
      <div className="cz-2fa-crumbbar">
        <nav className="cz-2fa-crumbs" aria-label="分组路径">
          <button
            type="button"
            className={`cz-2fa-crumb is-root${dropOn(null)}`}
            data-crumb=""
            onClick={() => navigateBreadcrumb(null)}
          >
            全部
          </button>
          {collapsed && (
            <>
              <span className="cz-2fa-crumb-sep">/</span>
              <button
                type="button"
                className={`cz-2fa-crumb is-ellipsis${dropOn(chain[chain.length - 3]!.id)}`}
                data-crumb={chain[chain.length - 3]!.id}
                title={middleNames}
                onClick={() => navigateBreadcrumb(chain[chain.length - 3]!.id)}
              >
                …
              </button>
            </>
          )}
          {parentGroup && (
            <>
              <span className="cz-2fa-crumb-sep">/</span>
              <button
                type="button"
                className={`cz-2fa-crumb${dropOn(parentGroup.id)}`}
                data-crumb={parentGroup.id}
                title={parentGroup.name}
                onClick={() => navigateBreadcrumb(parentGroup.id)}
              >
                {parentGroup.name}
              </button>
            </>
          )}
          <span className="cz-2fa-crumb-sep">/</span>
          <span className="cz-2fa-crumb is-cur" title={currentGroup.name}>
            {currentGroup.name}
          </span>
        </nav>
        <button
          type="button"
          className="cz-2fa-subbtn"
          title="在此分组下新建子分组"
          onClick={() => setCreateSubgroupParent({ parentId: currentGroup.id })}
        >
          <Icon name="folder-plus" size={13} />
          <span>新建子分组</span>
        </button>
      </div>
    );
  };

  if (!mounted) return null;

  const isEmptyVault = store.loaded && store.data.entries.length === 0 && store.data.groups.length === 0;
  const syncConfigured = store.data.sync.configured;
  const hasStdPeriod = store.data.entries.some((e) => e.period === STD_PERIOD);
  const noTags = store.data.tags.length === 0;
  const dragging = !!drag;

  return createPortal(
    <>
      <div
        ref={panelRef}
        className={`cz-2fa-pop${leaving ? ' is-leaving' : ''}${forceNarrow ? ' is-narrow' : ''}${dragging ? ' is-dragging' : ''}${dragging && (drag?.intoGroupId != null || drag?.crumbId !== undefined) ? ' is-into' : ''}`}
        role="dialog"
        aria-label="两步验证"
        {...inertLeaving(leaving)}
      >
        {mode.kind === 'import' ? (
          <div className="cz-2fa-page" key={`import:${mode.method}`}>
            <TwoFactorImportView
              method={mode.method}
              groups={store.data.groups}
              defaultGroupId={currentGroupId}
              previewImport={store.previewImport}
              importText={store.importText}
              onBack={() => setMode({ kind: 'list' })}
              onDone={handleImportDone}
              onSwitchMethod={(m) => setMode({ kind: 'import', method: m })}
            />
          </div>
        ) : mode.kind !== 'list' ? (
          <div className="cz-2fa-page" key={mode.kind}>
            <EntryForm
              mode={mode.kind}
              initial={mode.kind === 'edit' ? mode.entry : undefined}
              defaultGroupId={currentGroupId}
              groups={store.data.groups}
              tags={store.data.tags}
              onCreateTag={(name, color) => store.createTag({ name, color })}
              onSubmit={handleCreateOrEditSubmit}
              onCancel={() => setMode({ kind: 'list' })}
            />
          </div>
        ) : (
          <>
            {/* 吸顶顶栏：搜索框 + 总倒计时 + ⚙ + ＋ */}
            <header className="cz-2fa-head">
              <div className="cz-2fa-search">
                <Icon name="search" size={14} className="cz-2fa-search__ic" />
                <input
                  ref={searchRef}
                  className="cz-2fa-search__input"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="搜索网站、账号、分组或标签…"
                  aria-label="搜索验证码"
                />
                {query ? (
                  <button
                    type="button"
                    className="cz-2fa-search__clear"
                    aria-label="清空搜索"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                  >
                    <Icon name="close" size={12} />
                  </button>
                ) : (
                  noTags && (
                    <button
                      type="button"
                      className="cz-2fa-search__tag"
                      title="新建标签"
                      aria-label="新建标签"
                      onClick={() => setCreateTagOpen(true)}
                    >
                      <Icon name="tag" size={13} />
                    </button>
                  )
                )}
              </div>

              {hasStdPeriod && (
                <div className="cz-2fa-gcd" aria-label="验证码刷新倒计时">
                  <CountdownRing period={STD_PERIOD} fixedNowMs={fixedNowMs} size={20} inline />
                </div>
              )}

              <button
                ref={gearRef}
                type="button"
                className={`cz-2fa-ib${manageOpen ? ' is-open' : ''}`}
                aria-label="管理与同步"
                aria-expanded={manageOpen}
                title="管理与同步"
                onClick={() => setManageOpen((v) => !v)}
              >
                <Icon name="settings" size={15} />
                {store.data.sync.lastError && <span className="cz-2fa-ib__dot is-err" />}
              </button>

              <button
                ref={addRef}
                type="button"
                className={`cz-2fa-ib is-accent${addOpen ? ' is-open' : ''}`}
                aria-label="添加验证码"
                aria-haspopup="menu"
                aria-expanded={addOpen}
                title="添加验证码"
                onClick={() => setAddOpen((v) => !v)}
              >
                <Icon name="plus" size={15} className="cz-2fa-ib__plus" />
              </button>

              <button
                type="button"
                className="cz-2fa-ib cz-2fa-close-narrow"
                aria-label="关闭两步验证"
                title="关闭"
                onClick={onClose}
              >
                <Icon name="close" size={15} />
              </button>
            </header>

            {/* 标签筛选行：可多选（交集）、横向滚动、两端渐隐。没有任何标签时整行折叠，入口收进搜索框右侧的小图标 */}
            {!noTags && (
              <div
                className={`cz-2fa-tags-wrap${tagFade.left ? ' has-left' : ''}${tagFade.right ? ' has-right' : ''}`}
              >
                <div
                  ref={tagsRowRef}
                  className="cz-2fa-tags"
                  onScroll={updateTagFade}
                  role="toolbar"
                  aria-label="按标签筛选"
                >
                  {store.data.tags.map((t) => {
                    const on = selectedTags.includes(t.id);
                    const c = normalizeTagColor(t.color);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        className={`cz-2fa-chip is-c-${c}${on ? ' is-on' : ''}`}
                        aria-pressed={on}
                        onClick={() => toggleFilterTag(t.id)}
                      >
                        <span className="cz-2fa-chip__dot" />
                        <span>{t.name}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className="cz-2fa-chip is-add"
                    title="新建标签"
                    aria-label="新建标签"
                    onClick={() => setCreateTagOpen(true)}
                  >
                    <Icon name="plus" size={11} />
                  </button>
                </div>
              </div>
            )}

            {/* 未配置同步提示条 */}
            {store.loaded && !syncConfigured && (
              <div className="cz-2fa-banner">
                <div className="cz-2fa-banner__text">
                  <span className="cz-2fa-banner__title">尚未开启云端加密同步</span>
                  <span className="cz-2fa-banner__desc">复制指令发到对话，即可自动配置私有仓库备份</span>
                </div>
                <button
                  type="button"
                  className={`cz-2fa-banner__btn${setupCopied ? ' is-copied' : ''}`}
                  onClick={() => void handleCopySetupCmd()}
                >
                  <Icon name={setupCopied ? 'check' : 'copy'} size={12} />
                  <span>{setupCopied ? '已复制' : '复制'}</span>
                </button>
              </div>
            )}

            {/* 分组面包屑 */}
            {vm.mode === 'group' && renderBreadcrumb(vm.breadcrumb)}

            {/* 列表滚动主区 */}
            <div ref={listRef} className="cz-2fa-body">
              <div ref={stageRef} className="cz-2fa-stage">
                {store.loading && !store.loaded ? (
                  <div className="cz-2fa-state">
                    <div className="cz-2fa-skel" />
                    <div className="cz-2fa-skel" />
                    <div className="cz-2fa-skel" />
                  </div>
                ) : store.error && !store.loaded ? (
                  <div className="cz-2fa-empty">
                    <Icon name="info" size={22} className="cz-2fa-empty__ic" />
                    <div className="cz-2fa-empty__title">无法加载验证码</div>
                    <div className="cz-2fa-empty__desc">{store.error}</div>
                    <button type="button" className="cz-2fa-btn" onClick={() => void store.refresh(false)}>
                      重试
                    </button>
                  </div>
                ) : isEmptyVault && vm.mode !== 'search' ? (
                  <div className="cz-2fa-empty">
                    <span className="cz-2fa-empty__badge">
                      <Icon name="twofa" size={22} />
                    </span>
                    <div className="cz-2fa-empty__title">还没有两步验证码</div>
                    <div className="cz-2fa-empty__desc">扫描二维码、手动输入，或从其他验证器导入备份</div>
                    <div className="cz-2fa-empty__acts">
                      <button type="button" className="cz-2fa-btn is-primary" onClick={() => setAddOpen(true)}>
                        <Icon name="plus" size={13} />
                        <span>添加验证码</span>
                      </button>
                      <button
                        type="button"
                        className="cz-2fa-btn"
                        onClick={() => setMode({ kind: 'import', method: 'backup' })}
                      >
                        <Icon name="upload" size={13} />
                        <span>导入</span>
                      </button>
                    </div>
                  </div>
                ) : vm.mode === 'search' ? (
                  view.entries.length === 0 ? (
                    <div className="cz-2fa-empty">
                      <Icon name="search" size={20} className="cz-2fa-empty__ic" />
                      <div className="cz-2fa-empty__title">没有匹配的验证码</div>
                      <div className="cz-2fa-empty__desc">换个关键词，或减少已选标签试试</div>
                      <button
                        type="button"
                        className="cz-2fa-btn"
                        onClick={() => {
                          setQuery('');
                          setSelectedTags([]);
                          searchRef.current?.focus();
                        }}
                      >
                        清空筛选
                      </button>
                    </div>
                  ) : (
                    <div className="cz-2fa-list">
                      {view.entries.map((item) => renderEntryRow(item, `s:${item.entry.id}`, true, null))}
                    </div>
                  )
                ) : vm.mode === 'root' ? (
                  <div className="cz-2fa-list">
                    {view.pinned.length > 0 && (
                      <div className="cz-2fa-sec" data-drag-section-el="pinned">
                        {view.pinned.map((item) => renderEntryRow(item, `p:${item.entry.id}`, true, 'pinned'))}
                      </div>
                    )}
                    {view.groups.length > 0 && (
                      <div className="cz-2fa-sec" data-drag-section-el="groups">
                        {view.groups.map((g) => renderGroupRow(g))}
                      </div>
                    )}
                    {view.entries.length > 0 && (
                      <div className="cz-2fa-sec" data-drag-section-el="entries">
                        {view.entries.map((item) => renderEntryRow(item, `u:${item.entry.id}`, false, 'entries'))}
                      </div>
                    )}
                  </div>
                ) : view.groups.length === 0 && view.entries.length === 0 ? (
                  <div className="cz-2fa-empty">
                    <span className="cz-2fa-empty__badge is-folder">
                      <Icon name="folder-open" size={22} />
                    </span>
                    <div className="cz-2fa-empty__title">这个分组还是空的</div>
                    <div className="cz-2fa-empty__desc">{EMPTY_GROUP_HINT}</div>
                    <div className="cz-2fa-empty__acts">
                      <button type="button" className="cz-2fa-btn is-primary" onClick={() => setAddOpen(true)}>
                        <Icon name="plus" size={13} />
                        <span>在此添加</span>
                      </button>
                      <button
                        type="button"
                        className="cz-2fa-btn"
                        onClick={() => setCreateSubgroupParent({ parentId: currentGroupId })}
                      >
                        <Icon name="folder-plus" size={13} />
                        <span>新建子分组</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="cz-2fa-list">
                    {view.groups.length > 0 && (
                      <div className="cz-2fa-sec" data-drag-section-el="groups">
                        {view.groups.map((g) => renderGroupRow(g))}
                      </div>
                    )}
                    {view.entries.length > 0 && (
                      <div className="cz-2fa-sec" data-drag-section-el="entries">
                        {view.entries.map((item) => renderEntryRow(item, `e:${item.entry.id}`, false, 'entries'))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* 已配置同步时的轻量底栏状态 */}
            {store.loaded && syncConfigured && (
              <footer className="cz-2fa-foot">
                <button
                  type="button"
                  className="cz-2fa-foot__sync"
                  disabled={store.syncing}
                  onClick={() => void handleSyncNow()}
                  title={store.data.sync.lastError || store.data.sync.repo || '点击立即同步'}
                >
                  <span
                    className={`cz-2fa-dot${store.data.sync.lastError ? ' is-err' : ' is-ok'}${store.syncing ? ' is-busy' : ''}`}
                  />
                  <span className="cz-2fa-foot__txt">
                    {store.syncing
                      ? '正在同步…'
                      : store.data.sync.lastError
                        ? `同步异常：${store.data.sync.lastError}`
                        : formatFooterSyncTime(store.data.sync.lastSyncAt)}
                  </span>
                </button>
                <span className="cz-2fa-foot__count">{store.data.entries.length} 项</span>
              </footer>
            )}
          </>
        )}

        {/* 浮层内轻提示 */}
        {toast && (
          <div className="cz-2fa-toast" role="status" aria-live="polite">
            {toast}
          </div>
        )}
      </div>

      {/* 附属菜单与弹窗 */}
      <ManageMenu
        open={manageOpen}
        anchorRef={gearRef}
        sync={store.data.sync}
        syncing={store.syncing}
        onClose={() => setManageOpen(false)}
        onManageTags={() => setTagManagerOpen(true)}
        onSyncNow={() => void handleSyncNow()}
        onCopySetupCmd={() => void handleCopySetupCmd()}
      />

      <AddMethodMenu
        open={addOpen}
        anchorRef={addRef}
        onClose={() => setAddOpen(false)}
        onPick={handleAddPick}
      />

      <RowContextMenu
        target={ctxTarget}
        onClose={() => setCtxTarget(null)}
        onPinEntry={(entry) => void handleTogglePin(entry)}
        onEditEntry={(entry) => setMode({ kind: 'edit', entry })}
        onMoveEntry={(entry) => setMoveEntryTarget(entry)}
        onTagsEntry={(entry) => setTagsEntryTarget(entry)}
        onDeleteEntry={(entry) => setDeleteEntryTarget(entry)}
        onRenameGroup={(group) => setRenameGroupTarget(group)}
        onNewSubgroup={(parent) => setCreateSubgroupParent({ parentId: parent.id })}
        onMoveGroup={(group) => setMoveGroupTarget(group)}
        onDeleteGroup={(group) => setDeleteGroupTarget(group)}
      />

      <MoveGroupModal
        open={!!moveEntryTarget}
        title={`移动「${moveEntryTarget?.issuer ?? ''}」到`}
        groups={store.data.groups}
        currentGroupId={moveEntryTarget?.groupId ?? null}
        onSelect={async (gid) => {
          if (!moveEntryTarget) return;
          // 排到目标分组末尾，和拖入保持一致
          const sibs = dataRef.current.entries.filter((e) => e.groupId === gid && e.id !== moveEntryTarget.id);
          const sort = sibs.length ? Math.max(...sibs.map((e) => e.sort)) + SORT_STEP : 0;
          await store.updateEntry(moveEntryTarget.id, { version: moveEntryTarget.version, groupId: gid, sort });
          flashToast('已移动');
        }}
        onClose={() => setMoveEntryTarget(null)}
      />

      <MoveGroupModal
        open={!!moveGroupTarget}
        title={`移动分组「${moveGroupTarget?.name ?? ''}」到`}
        groups={store.data.groups}
        currentGroupId={moveGroupTarget?.parentId ?? null}
        disabledGroupId={moveGroupTarget?.id ?? null}
        onSelect={async (pid) => {
          if (!moveGroupTarget) return;
          await store.updateGroup(moveGroupTarget.id, { version: moveGroupTarget.version, parentId: pid });
          flashToast('已移动分组');
        }}
        onClose={() => setMoveGroupTarget(null)}
      />

      <EntryTagsModal
        entry={tagsEntryTarget}
        tags={store.data.tags}
        onSave={async (entry, nextTagIds) => {
          await store.updateEntry(entry.id, { version: entry.version, tags: nextTagIds });
          flashToast('已更新标签');
        }}
        onCreateTag={(name, color) => store.createTag({ name, color })}
        onClose={() => setTagsEntryTarget(null)}
      />

      <ConfirmModal
        open={!!deleteEntryTarget}
        title="删除验证码"
        description={`确定删除「${deleteEntryTarget?.issuer || deleteEntryTarget?.account || ''}」吗？删除后将同步移除。`}
        onConfirm={async () => {
          if (!deleteEntryTarget) return;
          await store.deleteEntry(deleteEntryTarget.id, deleteEntryTarget.version);
          flashToast('已删除');
        }}
        onClose={() => setDeleteEntryTarget(null)}
      />

      <DeleteGroupModal
        group={deleteGroupTarget}
        entryCount={deleteGroupTarget ? (recursiveCounts.get(deleteGroupTarget.id) ?? 0) : 0}
        onConfirm={async (delMode: TwoFaDeleteGroupMode) => {
          if (!deleteGroupTarget) return;
          await store.deleteGroup(deleteGroupTarget.id, delMode, deleteGroupTarget.version);
          if (currentGroupId === deleteGroupTarget.id) setCurrentGroupId(deleteGroupTarget.parentId);
          flashToast(delMode === 'lift' ? '已删除分组，内容已移至上一级' : '已连同内容删除分组');
        }}
        onClose={() => setDeleteGroupTarget(null)}
      />

      <GroupNameModal
        open={!!createSubgroupParent}
        title={createSubgroupParent?.parentId ? '新建子分组' : '新建分组'}
        initialName=""
        submitLabel="创建"
        onSubmit={async (name) => {
          await store.createGroup({ name, parentId: createSubgroupParent?.parentId ?? null });
          flashToast('已创建分组');
        }}
        onClose={() => setCreateSubgroupParent(null)}
      />

      <GroupNameModal
        open={!!renameGroupTarget}
        title="重命名分组"
        initialName={renameGroupTarget?.name ?? ''}
        submitLabel="保存"
        onSubmit={async (name) => {
          if (!renameGroupTarget) return;
          await store.updateGroup(renameGroupTarget.id, { version: renameGroupTarget.version, name });
          flashToast('已重命名');
        }}
        onClose={() => setRenameGroupTarget(null)}
      />

      <CreateTagModal
        open={createTagOpen}
        onCreate={async (name: string, color: TwoFaTagColor) => {
          await store.createTag({ name, color });
          flashToast('已创建标签');
        }}
        onClose={() => setCreateTagOpen(false)}
      />

      <TagManagerModal
        open={tagManagerOpen}
        tags={store.data.tags}
        onCreate={async (name, color) => {
          await store.createTag({ name, color });
        }}
        onUpdate={async (tag, name, color) => {
          await store.updateTag(tag.id, { version: tag.version, name, color });
        }}
        onDelete={async (tag) => {
          await store.deleteTag(tag.id, tag.version);
          setSelectedTags((prev) => prev.filter((id) => id !== tag.id));
        }}
        onClose={() => setTagManagerOpen(false)}
      />
    </>,
    document.body,
  );
}
