// 2FA 面板附属菜单与弹窗：管理菜单、行右键菜单、移动到分组、标签多选、标签管理、删除分组二选一、新建/重命名分组。
// 全部 portal 到 document.body，避免被磨砂弹层裁切或 backdrop-filter 嵌套穿底；按栈叠放 useDismiss。
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { flattenGroupTree, getDescendantIds, normalizeTagColor } from '../../core/twofa/tree';
import {
  TWOFA_TAG_COLORS,
  type TwoFaDeleteGroupMode,
  type TwoFaEntry,
  type TwoFaGroup,
  type TwoFaSync,
  type TwoFaTag,
  type TwoFaTagColor,
} from '../../core/twofa/types';
import { Icon } from '../icons/Icon';
import { useDismiss } from '../sidebar/useDismiss';
import { inertLeaving, useAlwaysPresence } from './motion';

function formatSyncTime(iso?: string): string {
  if (!iso) return '尚未同步';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${m}-${day} ${hh}:${mm}`;
}

/** 固定定位气泡坐标钳制，确保不超出视口 */
function clampMenuPos(x: number, y: number, w: number, h: number): { left: number; top: number } {
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.max(pad, Math.min(x, vw - w - pad));
  const top = Math.max(pad, Math.min(y, vh - h - pad));
  return { left, top };
}

// ───────────── 管理菜单（⚙） ─────────────

export interface ManageMenuProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement>;
  sync: TwoFaSync;
  syncing: boolean;
  onClose: () => void;
  onManageTags: () => void;
  onSyncNow: () => void;
  onCopySetupCmd: () => void;
}

export function ManageMenu({
  open,
  anchorRef,
  sync,
  syncing,
  onClose,
  onManageTags,
  onSyncNow,
  onCopySetupCmd,
}: ManageMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, leaving } = useAlwaysPresence(open, ref, 120);
  useDismiss(open, [ref, anchorRef], onClose);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const ar = anchorRef.current.getBoundingClientRect();
    const w = 228;
    const h = ref.current?.offsetHeight || 220;
    setPos(clampMenuPos(ar.right - w, ar.bottom + 6, w, h));
  }, [open, anchorRef]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={ref}
      className={`cz-2fa-menu cz-2fa-menu--manage${leaving ? ' is-leaving' : ''}`}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label="两步验证管理菜单"
      {...inertLeaving(leaving)}
    >
      <button type="button" className="cz-2fa-mi" role="menuitem" onClick={() => { onClose(); onManageTags(); }}>
        <Icon name="tag" size={14} />
        <span>管理标签</span>
      </button>
      <button
        type="button"
        className="cz-2fa-mi"
        role="menuitem"
        disabled={!sync.configured || syncing}
        title={!sync.configured ? '请先配置同步' : undefined}
        onClick={() => { onClose(); onSyncNow(); }}
      >
        <Icon name="refresh" size={14} className={syncing ? 'cz-2fa-spin' : undefined} />
        <span>{syncing ? '正在同步…' : '立即同步'}</span>
      </button>
      <div className="cz-2fa-menu__hr" role="separator" />
      <div className="cz-2fa-sync-card">
        <div className="cz-2fa-sync-card__head">
          <span className={`cz-2fa-dot${sync.lastError ? ' is-err' : sync.configured ? ' is-ok' : ''}`} />
          <span className="cz-2fa-sync-card__title">
            {sync.configured ? (syncing ? '同步中…' : '同步已开启') : '尚未配置同步'}
          </span>
        </div>
        {sync.configured ? (
          <div className="cz-2fa-sync-card__meta">
            {sync.repo && <div className="cz-2fa-sync-card__line" title={sync.repo}>{sync.repo}</div>}
            <div className="cz-2fa-sync-card__line">上次同步：{formatSyncTime(sync.lastSyncAt)}</div>
            {sync.lastError && (
              <div className="cz-2fa-sync-card__err" title={sync.lastError}>{sync.lastError}</div>
            )}
          </div>
        ) : (
          <div className="cz-2fa-sync-card__meta">
            <div className="cz-2fa-sync-card__line">仅本地保存，可配置私有仓库同步</div>
            <button type="button" className="cz-2fa-sync-card__btn" onClick={() => { onClose(); onCopySetupCmd(); }}>
              <Icon name="copy" size={12} />
              <span>复制配置指令</span>
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

// ───────────── 添加方式菜单（＋） ─────────────

export type AddMethod = 'scan' | 'manual' | 'image' | 'url' | 'file' | 'group';

const ADD_ITEMS: { id: AddMethod; label: string; icon: 'qr' | 'pencil' | 'image' | 'link' | 'file' | 'folder-plus' }[] = [
  { id: 'scan', label: '扫描二维码', icon: 'qr' },
  { id: 'manual', label: '手动输入', icon: 'pencil' },
  { id: 'image', label: '导入二维码图片', icon: 'image' },
  { id: 'url', label: '导入 OTP 链接', icon: 'link' },
  { id: 'file', label: '导入备份文件', icon: 'file' },
  { id: 'group', label: '新建分组', icon: 'folder-plus' },
];

export interface AddMethodMenuProps {
  open: boolean;
  anchorRef: React.RefObject<HTMLElement>;
  onClose: () => void;
  onPick: (m: AddMethod) => void;
}

/** 锚定在「＋」按钮下方的添加方式气泡：从按钮右上角展开 */
export function AddMethodMenu({ open, anchorRef, onClose, onPick }: AddMethodMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const { mounted, leaving } = useAlwaysPresence(open, ref, 120);
  useDismiss(open, [ref, anchorRef], onClose);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const ar = anchorRef.current.getBoundingClientRect();
    const w = 208;
    const h = ref.current?.offsetHeight || 236;
    setPos(clampMenuPos(ar.right - w, ar.bottom + 6, w, h));
  }, [open, anchorRef]);

  if (!mounted) return null;

  return createPortal(
    <div
      ref={ref}
      className={`cz-2fa-menu cz-2fa-menu--add${leaving ? ' is-leaving' : ''}`}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label="添加验证码方式"
      {...inertLeaving(leaving)}
    >
      {ADD_ITEMS.map((it, i) => (
        <div key={it.id} className="cz-2fa-menu__grp" style={{ ['--i' as string]: i }}>
          {it.id === 'group' && <div className="cz-2fa-menu__hr" role="separator" />}
          <button
            type="button"
            className="cz-2fa-mi"
            role="menuitem"
            onClick={() => {
              onClose();
              onPick(it.id);
            }}
          >
            <span className="cz-2fa-mi__ic"><Icon name={it.icon} size={14} /></span>
            <span>{it.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ───────────── 行右键 / 更多操作菜单 ─────────────

export type ContextTarget =
  | { kind: 'entry'; entry: TwoFaEntry; x: number; y: number }
  | { kind: 'group'; group: TwoFaGroup; x: number; y: number };

export interface RowContextMenuProps {
  target: ContextTarget | null;
  onClose: () => void;
  onPinEntry: (entry: TwoFaEntry) => void;
  onEditEntry: (entry: TwoFaEntry) => void;
  onMoveEntry: (entry: TwoFaEntry) => void;
  onTagsEntry: (entry: TwoFaEntry) => void;
  onDeleteEntry: (entry: TwoFaEntry) => void;
  onRenameGroup: (group: TwoFaGroup) => void;
  onNewSubgroup: (parent: TwoFaGroup) => void;
  onMoveGroup: (group: TwoFaGroup) => void;
  onDeleteGroup: (group: TwoFaGroup) => void;
}

export function RowContextMenu({
  target,
  onClose,
  onPinEntry,
  onEditEntry,
  onMoveEntry,
  onTagsEntry,
  onDeleteEntry,
  onRenameGroup,
  onNewSubgroup,
  onMoveGroup,
  onDeleteGroup,
}: RowContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastRef = useRef<ContextTarget | null>(target);
  if (target) lastRef.current = target;
  const shown = target ?? lastRef.current;

  const { mounted, leaving } = useAlwaysPresence(!!target, ref, 110);
  useDismiss(!!target, ref, onClose);

  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  useLayoutEffect(() => {
    if (!target) return;
    const w = ref.current?.offsetWidth || 168;
    const h = ref.current?.offsetHeight || 190;
    setPos(clampMenuPos(target.x, target.y, w, h));
  }, [target]);

  if (!mounted || !shown) return null;

  return createPortal(
    <div
      ref={ref}
      className={`cz-2fa-menu cz-2fa-menu--ctx${leaving ? ' is-leaving' : ''}`}
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      {...inertLeaving(leaving)}
    >
      {shown.kind === 'entry' ? (
        <>
          <button type="button" className="cz-2fa-mi" role="menuitem" onClick={() => { onClose(); onPinEntry(shown.entry); }}>
            <Icon name={shown.entry.pinned ? 'pin-on' : 'pin'} size={14} />
            <span>{shown.entry.pinned ? '取消置顶' : '置顶'}</span>
          </button>
          <button type="button" className="cz-2fa-mi" role="menuitem" onClick={() => { onClose(); onEditEntry(shown.entry); }}>
            <Icon name="pencil" size={14} />
            <span>编辑</span>
          </button>
          <button type="button" className="cz-2fa-mi" role="menuitem" onClick={() => { onClose(); onMoveEntry(shown.entry); }}>
            <Icon name="folder" size={14} />
            <span>移动到…</span>
          </button>
          <button type="button" className="cz-2fa-mi" role="menuitem" onClick={() => { onClose(); onTagsEntry(shown.entry); }}>
            <Icon name="tag" size={14} />
            <span>标签…</span>
          </button>
          <div className="cz-2fa-menu__hr" role="separator" />
          <button type="button" className="cz-2fa-mi is-danger" role="menuitem" onClick={() => { onClose(); onDeleteEntry(shown.entry); }}>
            <Icon name="trash" size={14} />
            <span>删除</span>
          </button>
        </>
      ) : (
        <>
          <button type="button" className="cz-2fa-mi" role="menuitem" onClick={() => { onClose(); onRenameGroup(shown.group); }}>
            <Icon name="pencil" size={14} />
            <span>重命名</span>
          </button>
          <button type="button" className="cz-2fa-mi" role="menuitem" onClick={() => { onClose(); onNewSubgroup(shown.group); }}>
            <Icon name="folder-plus" size={14} />
            <span>新建子分组</span>
          </button>
          <button type="button" className="cz-2fa-mi" role="menuitem" onClick={() => { onClose(); onMoveGroup(shown.group); }}>
            <Icon name="folder" size={14} />
            <span>移动到…</span>
          </button>
          <div className="cz-2fa-menu__hr" role="separator" />
          <button type="button" className="cz-2fa-mi is-danger" role="menuitem" onClick={() => { onClose(); onDeleteGroup(shown.group); }}>
            <Icon name="trash" size={14} />
            <span>删除分组</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}

// ───────────── 通用模态框容器 ─────────────

function ModalShell({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const { mounted, leaving } = useAlwaysPresence(open, cardRef, 130);
  useDismiss(open, cardRef, onClose);

  if (!mounted) return null;

  return createPortal(
    <div className={`cz-2fa-scrim${leaving ? ' is-leaving' : ''}`} {...inertLeaving(leaving)}>
      <div
        ref={cardRef}
        className={`cz-2fa-modal${leaving ? ' is-leaving' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="cz-2fa-modal__head">
          <h3 className="cz-2fa-modal__title">{title}</h3>
          <button type="button" className="cz-2fa-ib" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="cz-2fa-modal__body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ───────────── 移动到分组树弹窗 ─────────────

export function MoveGroupModal({
  open,
  title,
  groups,
  currentGroupId,
  disabledGroupId,
  onSelect,
  onClose,
}: {
  open: boolean;
  title: string;
  groups: TwoFaGroup[];
  currentGroupId: string | null;
  /** 移动分组时禁用自身及子孙 */
  disabledGroupId?: string | null;
  onSelect: (targetGroupId: string | null) => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const flat = flattenGroupTree(groups);
  const forbidden = disabledGroupId ? getDescendantIds(disabledGroupId, groups) : new Set<string>();

  const pick = async (gid: string | null) => {
    if (busy || gid === currentGroupId) {
      if (gid === currentGroupId) onClose();
      return;
    }
    setBusy(true);
    try {
      await onSelect(gid);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell open={open} title={title} onClose={onClose}>
      <div className="cz-2fa-tree-picker">
        <button
          type="button"
          className={`cz-2fa-tree-opt${currentGroupId === null ? ' is-current' : ''}`}
          disabled={busy}
          onClick={() => void pick(null)}
        >
          <Icon name="folder-open" size={14} />
          <span className="cz-2fa-tree-opt__name">根目录（不分组）</span>
          {currentGroupId === null && <Icon name="check" size={13} className="cz-2fa-tree-opt__ck" />}
        </button>
        {flat.map(({ group, depth }) => {
          const disabled = busy || forbidden.has(group.id);
          const isCur = currentGroupId === group.id;
          return (
            <button
              key={group.id}
              type="button"
              className={`cz-2fa-tree-opt${isCur ? ' is-current' : ''}`}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
              disabled={disabled}
              onClick={() => void pick(group.id)}
            >
              <Icon name="folder" size={14} />
              <span className="cz-2fa-tree-opt__name">{group.name}</span>
              {isCur && <Icon name="check" size={13} className="cz-2fa-tree-opt__ck" />}
            </button>
          );
        })}
      </div>
    </ModalShell>
  );
}

// ───────────── 新建 / 重命名分组弹窗 ─────────────

export function GroupNameModal({
  open,
  title,
  initialName,
  submitLabel,
  onSubmit,
  onClose,
}: {
  open: boolean;
  title: string;
  initialName: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setErr(null);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open, initialName]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { setErr('请输入分组名称'); return; }
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(trimmed);
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell open={open} title={title} onClose={onClose}>
      <form className="cz-2fa-mform" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          className="cz-2fa-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="分组名称"
          maxLength={60}
        />
        {err && <div className="cz-2fa-err">{err}</div>}
        <div className="cz-2fa-modal__foot">
          <button type="button" className="cz-2fa-btn" onClick={onClose}>取消</button>
          <button type="submit" className="cz-2fa-btn is-primary" disabled={busy}>
            {busy ? '保存中…' : submitLabel}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ───────────── 删除分组二选一（全部删除需二次确认） ─────────────

export function DeleteGroupModal({
  group,
  entryCount,
  onConfirm,
  onClose,
}: {
  group: TwoFaGroup | null;
  entryCount: number;
  onConfirm: (mode: TwoFaDeleteGroupMode) => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<'choose' | 'confirm-all'>('choose');
  const [busy, setBusy] = useState(false);
  const lastRef = useRef<TwoFaGroup | null>(group);
  if (group) lastRef.current = group;
  const g = group ?? lastRef.current;

  useEffect(() => {
    if (group) setStep('choose');
  }, [group]);

  const run = async (mode: TwoFaDeleteGroupMode) => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm(mode);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell open={!!group} title={`删除分组「${g?.name ?? ''}」`} onClose={onClose}>
      {step === 'choose' ? (
        <div className="cz-2fa-delgroup">
          <p className="cz-2fa-modal__desc">
            {entryCount > 0
              ? `该分组下共有 ${entryCount} 条验证码记录，请选择处理方式：`
              : '请选择删除方式：'}
          </p>
          <button
            type="button"
            className="cz-2fa-choice"
            disabled={busy}
            onClick={() => void run('lift')}
          >
            <strong>内容移到上一级</strong>
            <span>仅删除此分组，子分组和验证码自动保留到上一级目录</span>
          </button>
          <button
            type="button"
            className="cz-2fa-choice is-danger"
            disabled={busy}
            onClick={() => setStep('confirm-all')}
          >
            <strong>连同内容全部删除</strong>
            <span>同时删除该分组内的全部子分组和验证码</span>
          </button>
        </div>
      ) : (
        <div className="cz-2fa-delgroup">
          <p className="cz-2fa-modal__desc is-danger">
            再次确认：即将永久删除「{g?.name}」及其内部的全部子分组和 {entryCount} 条验证码，删除后无法恢复。
          </p>
          <div className="cz-2fa-modal__foot">
            <button type="button" className="cz-2fa-btn" disabled={busy} onClick={() => setStep('choose')}>
              返回上一步
            </button>
            <button type="button" className="cz-2fa-btn is-danger" disabled={busy} onClick={() => void run('all')}>
              {busy ? '删除中…' : '确认全部删除'}
            </button>
          </div>
        </div>
      )}
    </ModalShell>
  );
}

// ───────────── 通用确认弹窗（删除记录 / 删除标签） ─────────────

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel = '删除',
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell open={open} title={title} onClose={onClose}>
      <p className="cz-2fa-modal__desc">{description}</p>
      <div className="cz-2fa-modal__foot">
        <button type="button" className="cz-2fa-btn" disabled={busy} onClick={onClose}>取消</button>
        <button type="button" className="cz-2fa-btn is-danger" disabled={busy} onClick={() => void run()}>
          {busy ? '处理中…' : confirmLabel}
        </button>
      </div>
    </ModalShell>
  );
}

// ───────────── 新建标签弹窗 ─────────────

export function CreateTagModal({
  open,
  onCreate,
  onClose,
}: {
  open: boolean;
  onCreate: (name: string, color: TwoFaTagColor) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [color, setColor] = useState<TwoFaTagColor>('blue');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setColor('blue');
      setErr(null);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = name.trim();
    if (!t) { setErr('请输入标签名'); return; }
    setBusy(true);
    setErr(null);
    try {
      await onCreate(t, color);
      onClose();
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '创建标签失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell open={open} title="新建标签" onClose={onClose}>
      <form className="cz-2fa-mform" onSubmit={submit}>
        <input
          ref={inputRef}
          className="cz-2fa-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="标签名称（例如：生产、金融）"
          maxLength={24}
        />
        <div className="cz-2fa-palette" role="radiogroup" aria-label="标签颜色">
          {TWOFA_TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`cz-2fa-swatch is-c-${c}${color === c ? ' is-selected' : ''}`}
              role="radio"
              aria-checked={color === c}
              aria-label={c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        {err && <div className="cz-2fa-err">{err}</div>}
        <div className="cz-2fa-modal__foot">
          <button type="button" className="cz-2fa-btn" onClick={onClose}>取消</button>
          <button type="submit" className="cz-2fa-btn is-primary" disabled={busy}>
            {busy ? '创建中…' : '创建'}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

// ───────────── 记录标签多选弹窗 ─────────────

export function EntryTagsModal({
  entry,
  tags,
  onSave,
  onCreateTag,
  onClose,
}: {
  entry: TwoFaEntry | null;
  tags: TwoFaTag[];
  onSave: (entry: TwoFaEntry, nextTagIds: string[]) => Promise<void>;
  onCreateTag: (name: string, color: TwoFaTagColor) => Promise<TwoFaTag>;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TwoFaTagColor>('blue');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const lastRef = useRef<TwoFaEntry | null>(entry);
  if (entry) lastRef.current = entry;
  const target = entry ?? lastRef.current;

  useEffect(() => {
    if (entry) {
      setSelected(entry.tags);
      setNewName('');
      setErr(null);
    }
  }, [entry]);

  const toggle = (id: string) => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const addInlineTag = async () => {
    const t = newName.trim();
    if (!t || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await onCreateTag(t, newColor);
      setSelected((prev) => [...prev, created.id]);
      setNewName('');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '创建标签失败');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!target || busy) return;
    setBusy(true);
    try {
      await onSave(target, selected);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell open={!!entry} title={`编辑标签 · ${target?.issuer || target?.account || ''}`} onClose={onClose}>
      <div className="cz-2fa-mform">
        {tags.length > 0 ? (
          <div className="cz-2fa-tag-checks">
            {tags.map((t) => {
              const on = selected.includes(t.id);
              const c = normalizeTagColor(t.color);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={`cz-2fa-chip is-c-${c}${on ? ' is-on' : ''}`}
                  aria-pressed={on}
                  onClick={() => toggle(t.id)}
                >
                  <span className="cz-2fa-chip__dot" />
                  <span>{t.name}</span>
                  {on && <Icon name="check" size={11} />}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="cz-2fa-modal__desc">还没有标签，可在下方直接新建。</p>
        )}
        <div className="cz-2fa-inline-tag">
          <input
            className="cz-2fa-input"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新建标签名…"
            maxLength={24}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addInlineTag();
              }
            }}
          />
          <button type="button" className="cz-2fa-btn" disabled={busy || !newName.trim()} onClick={() => void addInlineTag()}>
            添加
          </button>
        </div>
        <div className="cz-2fa-palette is-compact">
          {TWOFA_TAG_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={`cz-2fa-swatch is-c-${c}${newColor === c ? ' is-selected' : ''}`}
              aria-label={c}
              onClick={() => setNewColor(c)}
            />
          ))}
        </div>
        {err && <div className="cz-2fa-err">{err}</div>}
        <div className="cz-2fa-modal__foot">
          <button type="button" className="cz-2fa-btn" onClick={onClose}>取消</button>
          <button type="button" className="cz-2fa-btn is-primary" disabled={busy} onClick={() => void save()}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </ModalShell>
  );
}

// ───────────── 管理所有标签弹窗 ─────────────

export function TagManagerModal({
  open,
  tags,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: {
  open: boolean;
  tags: TwoFaTag[];
  onCreate: (name: string, color: TwoFaTagColor) => Promise<void>;
  onUpdate: (tag: TwoFaTag, name: string, color: TwoFaTagColor) => Promise<void>;
  onDelete: (tag: TwoFaTag) => Promise<void>;
  onClose: () => void;
}) {
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editColor, setEditColor] = useState<TwoFaTagColor>('blue');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<TwoFaTagColor>('blue');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setEditId(null);
      setErr(null);
    }
  }, [open]);

  const startEdit = (t: TwoFaTag) => {
    setEditId(t.id);
    setEditName(t.name);
    setEditColor(normalizeTagColor(t.color));
    setErr(null);
  };

  const saveEdit = async (t: TwoFaTag) => {
    const trimmed = editName.trim();
    if (!trimmed) { setErr('标签名不能为空'); return; }
    setBusy(true);
    setErr(null);
    try {
      await onUpdate(t, trimmed, editColor);
      setEditId(null);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '更新标签失败');
    } finally {
      setBusy(false);
    }
  };

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) return;
    setBusy(true);
    setErr(null);
    try {
      await onCreate(trimmed, newColor);
      setNewName('');
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '创建标签失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell open={open} title="管理标签" onClose={onClose}>
      <div className="cz-2fa-mform">
        <div className="cz-2fa-tagmgr">
          {tags.length === 0 && <div className="cz-2fa-modal__desc">暂无标签</div>}
          {tags.map((t) => {
            const c = normalizeTagColor(t.color);
            if (editId === t.id) {
              return (
                <div key={t.id} className="cz-2fa-tagmgr__edit">
                  <input
                    className="cz-2fa-input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    maxLength={24}
                  />
                  <div className="cz-2fa-palette is-compact">
                    {TWOFA_TAG_COLORS.map((col) => (
                      <button
                        key={col}
                        type="button"
                        className={`cz-2fa-swatch is-c-${col}${editColor === col ? ' is-selected' : ''}`}
                        onClick={() => setEditColor(col)}
                        aria-label={col}
                      />
                    ))}
                  </div>
                  <div className="cz-2fa-tagmgr__edit-acts">
                    <button type="button" className="cz-2fa-btn is-sm" onClick={() => setEditId(null)}>取消</button>
                    <button type="button" className="cz-2fa-btn is-sm is-primary" disabled={busy} onClick={() => void saveEdit(t)}>保存</button>
                  </div>
                </div>
              );
            }
            return (
              <div key={t.id} className="cz-2fa-tagmgr__row">
                <span className={`cz-2fa-chip is-c-${c} is-static`}>
                  <span className="cz-2fa-chip__dot" />
                  <span>{t.name}</span>
                </span>
                <div className="cz-2fa-tagmgr__acts">
                  <button type="button" className="cz-2fa-ib" title="编辑" aria-label="编辑标签" onClick={() => startEdit(t)}>
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    className="cz-2fa-ib is-danger"
                    title="删除"
                    aria-label="删除标签"
                    disabled={busy}
                    onClick={() => void onDelete(t)}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <form className="cz-2fa-tagmgr__add" onSubmit={handleCreate}>
          <div className="cz-2fa-inline-tag">
            <input
              className="cz-2fa-input"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="新建标签…"
              maxLength={24}
            />
            <button type="submit" className="cz-2fa-btn is-primary" disabled={busy || !newName.trim()}>
              新建
            </button>
          </div>
          <div className="cz-2fa-palette is-compact">
            {TWOFA_TAG_COLORS.map((col) => (
              <button
                key={col}
                type="button"
                className={`cz-2fa-swatch is-c-${col}${newColor === col ? ' is-selected' : ''}`}
                onClick={() => setNewColor(col)}
                aria-label={col}
              />
            ))}
          </div>
        </form>
        {err && <div className="cz-2fa-err">{err}</div>}
      </div>
    </ModalShell>
  );
}
