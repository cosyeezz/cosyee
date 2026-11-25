// 左下角账户栏 + 账号切换菜单（向上弹出）。分为「Claude」「Antigravity」两个可折叠分组：
// - Claude：切换模式（换账号整页刷新，有执行中的会话时可强制切换）或并行模式（只换新会话用的账号，不刷新）；
// - Antigravity：委派任务用的账号，切换不刷新页面、不关菜单；已有的委派任务继续用原来的账号。
// 没有登录凭据的账号点击后重新登录；悬停可改名 / 移除（默认、当前账号的移除按钮置灰并说明原因）。
// 添加账号走各分组标题右侧的「＋」（有登录进行中时点它会接着那次登录）。
// Claude 账号只显示名字、套餐和备注名，不显示邮箱；Antigravity 账号没起备注名时用登录邮箱当标题，并显示各组模型的额度。
// 套餐做成名字后面的小标签（「Google AI Pro」缩成「Pro」，完整名字在提示里），副标题只放备注名 / 状态。
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Account, AccountApiInfo, AccountDedupeResult, AccountEntry, AccountList, AccountLogin, AgyAccountEntry, AgyAccountList, KiroStatus } from '@cosyee/shared';
import { Reveal, REVEAL_MS } from '../motion/Reveal';
import { motionOK } from '../motion/reduced';
import { leavingProps, usePresence } from '../motion/usePresence';
import { api, ApiError } from '../../core/api';
import { Icon } from '../icons/Icon';
import { ActionButton, ConfirmActionButton } from './ActionButtons';
import { AccountDialog } from './AccountDialog';
import { AddTargetSeg, type AddTarget } from './AddTargetSeg';
import { AgyAccountDialog } from './AgyAccountDialog';
import { ApiAccountDialog, type AddKind } from './ApiAccountDialog';
import { KiroAccountDialog } from './KiroAccountDialog';
import { AccountModeSwitch } from './AccountModeSwitch';
import { AccountQuota, AgyQuotaView, KiroQuotaView, type KiroBalanceState, type QuotaState } from './AccountQuota';
import { loginExpiry, subscriptionEstimate } from '../usage/format';
import { ThemeSwitch } from './ThemeSwitch';
import { avatarColor, avatarInitial } from './avatar';
import { useDismiss } from './useDismiss';

export interface AccountMenuProps {
  account: Account | null;
  /** 账号信息有变化但没有整页刷新时递增：菜单开着就重读列表 */
  version?: number;
}

interface DialogState {
  /** login = claude.ai 登录；api = API 账号；kiro = Kiro 账号；agy = Antigravity 登录 */
  kind: 'login' | 'api' | 'kiro' | 'agy';
  relogin?: { id: string; title: string; active: boolean };
  resume: AccountLogin | null;
  /** 修改的 API 账号 */
  editApi?: { id: string; label: string; title: string; api: AccountApiInfo };
  /** 在添加对话框里切换了方式或分组：换一个组件挂载，但不要再播一遍入场 */
  switched?: boolean;
  /** 从另一分组切过来时的旧值，用于触发 GooeyIndicator 胶囊滑动 */
  fromTarget?: AddTarget;
}

/** 两个分组默认都折叠，展开 / 折叠会记住。v2：旧版默认展开 Claude，换个键让所有人回到默认折叠 */
export const GROUP_STORAGE_KEY = 'cz-acct-groups-v2';

interface GroupOpenState {
  claude: boolean;
  agy: boolean;
}

function readGroupOpen(): GroupOpenState {
  try {
    const raw = localStorage.getItem(GROUP_STORAGE_KEY);
    if (!raw) return { claude: false, agy: false };
    const p = JSON.parse(raw) as Partial<GroupOpenState>;
    return {
      claude: typeof p.claude === 'boolean' ? p.claude : false,
      agy: typeof p.agy === 'boolean' ? p.agy : false,
    };
  } catch {
    return { claude: false, agy: false };
  }
}

function writeGroupOpen(v: GroupOpenState) {
  try {
    localStorage.setItem(GROUP_STORAGE_KEY, JSON.stringify(v));
  } catch { /* 隐私模式 / 配额满时忽略 */ }
}

/** API 账号显示的主机名（Base URL 为空 = 官方） */
export function apiHost(baseUrl: string): string {
  if (!baseUrl) return 'api.anthropic.com';
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** API 账号行在额度位置显示的说明：按量计费 + 模型映射了几项（别名 + 自定义条目） */
export function apiMapNote(info: AccountApiInfo): string {
  const m = info.models;
  const n = Object.keys(m?.alias ?? {}).length + (m?.extra?.length ?? 0);
  return n ? `按量计费 · 已映射 ${n} 个模型` : '按量计费 · 未配置模型映射';
}

/** 整页刷新（单独放一个对象里，测试可以替换） */
export const accountPage = { reload: () => window.location.reload() };

/** 消费 URL 中的 ?add=kiro 参数：只删除 add，保留其它参数、hash 和 history.state */
function consumeAddKiroParam(): boolean {
  const params = new URLSearchParams(window.location.search);
  if (params.get('add') !== 'kiro') return false;
  params.delete('add');
  const search = params.toString();
  const next = `${window.location.pathname}${search ? `?${search}` : ''}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', next);
  return true;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const loginPending = (l: AccountLogin | null | undefined): l is AccountLogin =>
  !!l && (l.status === 'starting' || l.status === 'waiting');

/** 行标题：显示名，读不到时用备注名；都没有就叫「Claude 账号」（没登录的叫「未登录账号」） */
export function entryTitle(a: AccountEntry): string {
  return a.name ?? (a.label || (a.loggedIn ? 'Claude 账号' : '未登录账号'));
}

/** 行副标题：备注名 · 需要登录；API 账号：主机名（套餐另做成名字后面的小标签，见 planChip） */
export function entrySubtitle(a: AccountEntry): string {
  const parts: string[] = [];
  if (a.label && a.label !== entryTitle(a)) parts.push(a.label);
  if (a.api) {
    const host = apiHost(a.api.baseUrl);
    if (host !== entryTitle(a)) parts.push(host);
  }
  if (!a.loggedIn) parts.push('需要登录');
  return parts.join(' · ');
}

/** Claude 账号不能移除的原因（和服务端一致）；能移除返回 null */
export function claudeRemoveBlock(a: AccountEntry): string | null {
  if (a.isDefault) return '默认账号不能移除';
  if (a.active) return '不能移除当前账号，请先切换到其它账号';
  return null;
}

/** Antigravity 账号不能移除的原因（和服务端一致）；能移除返回 null */
export function agyRemoveBlock(a: AgyAccountEntry): string | null {
  if (a.isDefault) return '默认账号不能移除';
  if (a.active) return '不能移除当前账号，请先切换到其它账号';
  if (a.running > 0) return `有 ${a.running} 个委派任务正在执行，结束后才能移除`;
  return null;
}

/** 名字后面的套餐小标签：「Google AI Pro」→「Pro」；没有套餐返回 null */
export function planChip(plan: string | null | undefined): string | null {
  const s = (plan ?? '').replace(/^google\s+ai\s+/i, '').trim();
  return s || null;
}

/** Antigravity 行标题：备注名 → 登录邮箱 → 默认账号「本机登录」 */
export function agyTitle(a: AgyAccountEntry): string {
  return a.label || a.email || (a.isDefault ? '本机登录' : 'Antigravity 账号');
}

/** Antigravity 行副标题：N 个执行中 · 邮箱（标题是备注名时）· 检测中 / 需要登录（任务数放最前，窄侧栏不易截断） */
export function agySubtitle(a: AgyAccountEntry): string {
  const parts: string[] = [];
  if (a.running > 0) parts.push(`${a.running} 个执行中`);
  if (a.email && a.email !== agyTitle(a)) parts.push(a.email);
  if (a.loggedIn === null) parts.push('检测中…');
  else if (!a.loggedIn) parts.push('需要登录');
  return parts.join(' · ');
}

/** 账号头像：名字首字母 + 由名字算出的渐变底色；没登录是虚线空圈 */
function Avatar({ title, loggedIn, size = 'sm' }: { title: string; loggedIn: boolean; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`cz-sidebar__avatar cz-sidebar__avatar--${size}${loggedIn ? '' : ' cz-sidebar__avatar--empty'}`}
      style={loggedIn ? ({ '--av': avatarColor(title) } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {loggedIn ? avatarInitial(title) : '?'}
    </span>
  );
}

/** 名字后面的套餐小标签 */
function PlanChip({ plan }: { plan: string | null | undefined }) {
  const chip = planChip(plan);
  if (!chip) return null;
  return <span className="cz-acct-chip" title={plan ?? undefined}>{chip}</span>;
}

/** 列表里有被隐藏的重复账号时的提示行：「有 N 个重复的账号已隐藏 · 清理」，清理后报告跳过了几个 */
function DuplicateNote({ count, onClean }: { count: number; onClean: () => Promise<AccountDedupeResult> }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  /** 上次清理跳过的个数：剩下的都是暂时删不掉的，就不再给「清理」按钮 */
  const [skipped, setSkipped] = useState(0);
  if (count <= 0 && !note) return null;
  const clean = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await onClean();
      setSkipped(r.skipped);
      setNote(
        r.skipped > 0
          ? `已清理 ${r.removed} 个；${r.skipped} 个正在使用（当前 / 默认账号或有任务在执行），暂时保留`
          : `已清理 ${r.removed} 个重复账号`,
      );
    } catch (e) {
      setNote(`清理失败：${msg(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cz-sidebar__acct-note cz-acct-dup" role="status">
      {count > 0 && (
        <span className="cz-acct-dup__line">
          <span>有 {count} 个重复的账号已隐藏</span>
          {count > skipped && <button
            type="button"
            className="cz-acct-dup__btn"
            disabled={busy}
            title="删除重复添加的同一账号（保留列表里显示的那一个）"
            onClick={() => void clean()}
          >
            {busy ? '清理中…' : '清理'}
          </button>}
        </span>
      )}
      {note && <span className="cz-acct-dup__result">{note}</span>}
    </div>
  );
}

/** 选中账号的标记：实心小圆里一个勾 */
function ActiveMark() {
  return (
    <span className="cz-sidebar__acct-check cz-acct-row__status" aria-hidden="true">
      <Icon name="check" size={10} />
    </span>
  );
}

/** 可折叠账号分组：整行标题按钮 + 品牌徽章 + 账号数 + 折叠态当前账号摘要 + 右侧「＋」按钮 */
function AccountGroup({
  brand, title, count, open, onToggle, summary, attention, onAdd, addLabel, children,
}: {
  brand: 'claude' | 'agy';
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  summary?: { title: string; loggedIn: boolean } | null;
  attention?: string | null;
  onAdd?: () => void;
  addLabel?: string;
  children: ReactNode;
}) {
  const bodyId = useId();
  const secRef = useRef<HTMLElement>(null);
  const was = useRef(open);
  useEffect(() => {
    const opened = open && !was.current;
    was.current = open;
    if (!opened) return;
    const smooth = motionOK();
    const t = window.setTimeout(
      () => secRef.current?.scrollIntoView?.({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' }),
      smooth ? REVEAL_MS : 0,
    );
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    <section ref={secRef} className={`cz-acct-grp cz-acct-grp--${brand}${open ? ' is-open' : ''}`}>
      <div className="cz-acct-grp__bar">
        <button
          type="button"
          className="cz-acct-grp__head"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          onClick={onToggle}
        >
          <span className={`cz-acct-grp__chev${open ? ' is-open' : ''}`} aria-hidden="true">
            <Icon name="chevron-right" size={12} />
          </span>
          <span className={`cz-acct-grp__badge cz-acct-grp__badge--${brand}`} aria-hidden="true">
            {brand === 'claude' ? 'C' : 'A'}
          </span>
          <span className="cz-acct-grp__name">{title}</span>
          {count !== undefined && <span className="cz-acct-grp__count">{count}</span>}
          {attention && (
            <span className="cz-acct-grp__dot" title={attention}>
              <span className="cz-sr-only">{attention}</span>
            </span>
          )}
          {summary && (
            <span className={`cz-acct-grp__summary${open ? ' is-hidden' : ''}`} aria-hidden={open || undefined}>
              <span
                className={`cz-acct-grp__mini-av${summary.loggedIn ? '' : ' is-empty'}`}
                style={summary.loggedIn ? ({ '--av': avatarColor(summary.title) } as CSSProperties) : undefined}
              >
                {summary.loggedIn ? avatarInitial(summary.title) : '?'}
              </span>
              <span className="cz-acct-grp__summary-name">{summary.title}</span>
            </span>
          )}
        </button>
        {onAdd && addLabel && (
          <button
            type="button"
            className="cz-acct-grp__add"
            aria-label={addLabel}
            title={addLabel}
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
          >
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      <Reveal open={open} id={bodyId} className="cz-acct-grp__body">
        {children}
      </Reveal>
    </section>
  );
}

/** Antigravity 账号的行内改备注名：Enter 保存，Esc 取消（通过 useDismiss 分层，不关外层菜单） */
function AgyRenameRow({
  initial, busy, onSave, onCancel,
}: {
  initial: string;
  busy: boolean;
  onSave: (label: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const rowRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(true, rowRef, onCancel);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <div ref={rowRef} className="cz-sidebar__menu-item cz-acct-row cz-acct-row--editing">
      <input
        ref={inputRef}
        className="cz-acct-row__edit-input"
        aria-label="修改备注名"
        value={draft}
        maxLength={40}
        disabled={busy}
        placeholder="输入备注名"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !busy) {
            e.preventDefault();
            onSave(draft.trim());
          }
        }}
      />
      <button
        type="button"
        className="cz-sidebar__act"
        aria-label="保存备注名"
        title="保存"
        disabled={busy}
        onClick={() => onSave(draft.trim())}
      >
        <Icon name="check" size={14} />
      </button>
      <button
        type="button"
        className="cz-sidebar__act"
        aria-label="取消修改"
        title="取消"
        disabled={busy}
        onClick={onCancel}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}

export function AccountMenu({ account, version = 0 }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AccountList | null>(null);
  const [agyData, setAgyData] = useState<AgyAccountList | null>(null);
  const [groups, setGroups] = useState<GroupOpenState>(readGroupOpen);
  const [error, setError] = useState<string | null>(null);
  /** 切换被执行中的会话拦下：等用户决定是否强制切换 */
  const [confirm, setConfirm] = useState<{ id: string; running: number } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [agySwitching, setAgySwitching] = useState<string | null>(null);
  const [editingAgyId, setEditingAgyId] = useState<string | null>(null);
  const [renamingBusy, setRenamingBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** 菜单开着时每分钟推进一次，驱动额度重置倒计时与到期提示刷新；关闭后清理计时器 */
  const [now, setNow] = useState(() => Date.now());
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 关闭时留着播完退场（.cz-pop），退场途中再打开会从当前状态接回去
  const { mounted, leaving } = usePresence(open, menuRef);

  const close = useCallback(() => {
    setOpen(false);
    setConfirm(null);
    setError(null);
    setEditingAgyId(null);
  }, []);
  useDismiss(open && !dialog, wrapRef, close);

  const loadClaude = useCallback(() => {
    api.accounts().then(setData, (e) => setError(msg(e)));
  }, []);
  const loadAgy = useCallback(() => {
    // refresh：额度超过 90 秒没更新的账号后台重新检测，结果通过 agy.changed → version 再读一次
    api.agyAccounts(true).then(
      (res) => setAgyData(res && typeof res.installed === 'boolean' && Array.isArray(res.list) ? res : null),
      () => setAgyData(null),
    );
  }, []);
  const load = useCallback(() => {
    loadClaude();
    loadAgy();
  }, [loadClaude, loadAgy]);

  useEffect(() => {
    if (open) load();
  }, [open, load, version]);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [open]);

  const toggleGroup = (key: keyof GroupOpenState) => {
    setGroups((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeGroupOpen(next);
      return next;
    });
    if (key === 'agy') setEditingAgyId(null);
  };

  const parallel = data?.mode === 'parallel';

  /** 每个已登录订阅账号的额度：菜单打开且 Claude 组展开时并行读取（API 与 Kiro 账号不请求 Claude 订阅额度） */
  const [quotas, setQuotas] = useState<Record<string, QuotaState>>({});
  const quotaIds = (data?.list ?? []).filter((a) => a.loggedIn && !a.api && !a.kiro).map((a) => a.id).join(',');
  useEffect(() => {
    if (!open || !groups.claude || !quotaIds) return;
    let alive = true;
    for (const id of quotaIds.split(',')) {
      api.usage(false, null, id).then(
        (info) => alive && setQuotas((q) => ({ ...q, [id]: info && info.limits.length ? { status: 'ok', info } : { status: 'none' } })),
        () => alive && setQuotas((q) => ({ ...q, [id]: q[id]?.status === 'ok' ? q[id]! : { status: 'fail' } })),
      );
    }
    return () => { alive = false; };
  }, [open, groups.claude, quotaIds]);

  /** 每个已登录 Kiro 账号的额度：菜单打开且 Claude 组展开时按需读取，失败静默显示「额度读取失败」 */
  const [kiroBalances, setKiroBalances] = useState<Record<string, KiroBalanceState>>({});
  const kiroBalanceIds = (data?.list ?? []).filter((a) => a.loggedIn && !!a.kiro).map((a) => a.id).join(',');
  useEffect(() => {
    if (!open || !groups.claude || !kiroBalanceIds) return;
    let alive = true;
    for (const id of kiroBalanceIds.split(',')) {
      api.kiroBalance(id).then(
        (info) => alive && setKiroBalances((b) => ({ ...b, [id]: { status: 'ok', info } })),
        () => alive && setKiroBalances((b) => ({ ...b, [id]: b[id]?.status === 'ok' ? b[id]! : { status: 'fail' } })),
      );
    }
    return () => { alive = false; };
  }, [open, groups.claude, kiroBalanceIds]);

  /** kiro.rs 引擎状态（仅在存在 Kiro 账号时按需读取，用于显示版本与更新入口） */
  const hasKiro = (data?.list ?? []).some((a) => !!a.kiro);
  const [kiroStatus, setKiroStatus] = useState<KiroStatus | null>(null);
  const [kiroChecking, setKiroChecking] = useState(false);
  const [kiroBuilding, setKiroBuilding] = useState(false);
  const [kiroEngineErr, setKiroEngineErr] = useState<string | null>(null);
  const [kiroBuildTick, setKiroBuildTick] = useState(0);

  useEffect(() => {
    if (!open || !groups.claude || !hasKiro) return;
    let alive = true;
    api.kiroStatus().then((s) => alive && setKiroStatus(s), () => {});
    return () => { alive = false; };
  }, [open, groups.claude, hasKiro, version]);

  const kiroBuildRunning = kiroStatus?.engine.build.state === 'running';
  useEffect(() => {
    if (!open || !groups.claude || !kiroBuildRunning) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.kiroStatus().then(
        (next) => {
          if (!alive) return;
          setKiroStatus(next);
          if (next.engine.build.state === 'running') setKiroBuildTick((n) => n + 1);
        },
        () => {
          if (alive) setKiroBuildTick((n) => n + 1);
        },
      );
    }, 1000);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [open, groups.claude, kiroBuildRunning, kiroBuildTick]);

  const checkKiroUpdate = async () => {
    setKiroChecking(true);
    setKiroEngineErr(null);
    try {
      const next = await api.kiroCheck();
      setKiroStatus(next);
    } catch (e) {
      setKiroEngineErr(msg(e));
    } finally {
      setKiroChecking(false);
    }
  };

  const buildKiroEngine = async () => {
    setKiroBuilding(true);
    setKiroEngineErr(null);
    try {
      const next = await api.kiroBuild();
      setKiroStatus(next);
    } catch (e) {
      setKiroEngineErr(msg(e));
    } finally {
      setKiroBuilding(false);
    }
  };

  const doSwitch = async (id: string, force = false) => {
    setError(null);
    setConfirm(null);
    setSwitching(id);
    try {
      await api.switchAccount(id, force);
      if (parallel) {
        setSwitching(null);
        loadClaude();
        close();
      } else accountPage.reload();
    } catch (e) {
      setSwitching(null);
      if (e instanceof ApiError && e.status === 409 && typeof e.data.running === 'number') {
        setConfirm({ id, running: e.data.running });
      } else setError(msg(e));
    }
  };

  const doSwitchAgy = async (id: string) => {
    setError(null);
    setAgySwitching(id);
    try {
      await api.switchAgyAccount(id);
      loadAgy();
    } catch (e) {
      setError(msg(e));
    } finally {
      setAgySwitching(null);
    }
  };

  const pick = (a: AccountEntry) => {
    if (switching) return;
    if (!a.loggedIn) {
      openDialog({ kind: a.kiro ? 'kiro' : 'login', relogin: { id: a.id, title: entryTitle(a), active: a.active }, resume: null });
      return;
    }
    if (a.active) {
      close();
      return;
    }
    void doSwitch(a.id);
  };

  const pickAgy = (a: AgyAccountEntry) => {
    if (agySwitching) return;
    if (a.loggedIn === false) {
      openDialog({ kind: 'agy', relogin: { id: a.id, title: agyTitle(a), active: a.active }, resume: null });
      return;
    }
    if (a.active) return;
    void doSwitchAgy(a.id);
  };

  const claudeReloginOf = (l: AccountLogin | null | undefined) => {
    if (!l?.accountId) return undefined;
    const hit = (data?.list ?? []).find((x) => x.id === l.accountId);
    return { id: l.accountId, title: hit ? entryTitle(hit) : l.accountId, active: !!hit?.active };
  };

  const agyReloginOf = (l: AccountLogin | null | undefined) => {
    if (!l?.accountId) return undefined;
    const hit = (agyData?.list ?? []).find((x) => x.id === l.accountId);
    return { id: l.accountId, title: hit ? agyTitle(hit) : l.accountId, active: !!hit?.active };
  };

  const addClaude = () => {
    const l = data?.login ?? null;
    const resume = loginPending(l) ? l : null;
    openDialog({ kind: 'login', relogin: claudeReloginOf(resume), resume });
  };

  const addAgy = () => {
    const l = agyData?.login ?? null;
    const resume = loginPending(l) ? l : null;
    openDialog({ kind: 'agy', relogin: agyReloginOf(resume), resume });
  };

  const editApi = (a: AccountEntry) => {
    if (!a.api) return;
    openDialog({ kind: 'api', resume: null, editApi: { id: a.id, label: a.label, title: entryTitle(a), api: a.api } });
  };

  const reloginKiro = (a: AccountEntry) => {
    if (!a.kiro) return;
    openDialog({ kind: 'kiro', relogin: { id: a.id, title: entryTitle(a), active: a.active }, resume: null });
  };

  /** 添加账号对话框里切换 Claude 方式（login / api / kiro） */
  const switchAddKind = (kind: AddKind) => setDialog({ kind, resume: null, switched: true });

  /** 添加账号对话框里切换分组（Claude / Antigravity） */
  const switchAddTarget = (target: AddTarget) => {
    const fromTarget: AddTarget = dialog?.kind === 'agy' ? 'agy' : 'claude';
    setDialog({ kind: target === 'agy' ? 'agy' : 'login', resume: null, switched: true, fromTarget });
  };

  const remove = (id: string) => {
    setError(null);
    api.removeAccount(id).then(loadClaude, (e) => setError(msg(e)));
  };

  const removeAgy = (id: string) => {
    setError(null);
    api.removeAgyAccount(id).then(loadAgy, (e) => setError(msg(e)));
  };

  const saveAgyLabel = async (id: string, label: string) => {
    setError(null);
    setRenamingBusy(true);
    try {
      await api.setAgyLabel(id, label);
      setEditingAgyId(null);
      loadAgy();
    } catch (e) {
      setError(msg(e));
    } finally {
      setRenamingBusy(false);
    }
  };

  /** 这次对话框里登录成功了（Claude 当前账号重新登录成功后要刷新整页，名字 / 套餐可能变了） */
  const loginDone = useRef(false);
  const onDialogDone = useCallback(() => {
    loginDone.current = true;
    load();
  }, [load]);

  const openDialog = useCallback((d: DialogState) => {
    loginDone.current = false;
    setEditingAgyId(null);
    setDialog(d);
  }, []);

  useEffect(() => {
    if (consumeAddKiroParam()) openDialog({ kind: 'kiro', resume: null });
  }, [openDialog]);

  const closeDialog = () => {
    const reload = (dialog?.kind === 'login' || dialog?.kind === 'kiro') && !!dialog.relogin?.active && loginDone.current;
    setDialog(null);
    if (reload) accountPage.reload();
    else load();
  };

  const dialogSwitchClaude = (id: string) => {
    setDialog(null);
    setOpen(true);
    void doSwitch(id);
  };

  const dialogSwitchAgy = (id: string) => {
    setDialog(null);
    setOpen(true);
    void doSwitchAgy(id);
  };

  const list = data?.list ?? [];
  const agyList = agyData?.list ?? [];
  const confirmEntry = confirm ? list.find((a) => a.id === confirm.id) : undefined;
  const confirmName = confirmEntry ? entryTitle(confirmEntry) : '该账号';

  const activeClaude = list.find((a) => a.active);
  const claudeSummary = activeClaude
    ? { title: entryTitle(activeClaude), loggedIn: activeClaude.loggedIn }
    : account
      ? { title: account.name, loggedIn: true }
      : null;
  const claudeAttention = loginPending(data?.login)
    ? '登录进行中'
    : activeClaude && !activeClaude.loggedIn
      ? '需要登录'
      : null;

  const activeAgy = agyList.find((a) => a.active);
  const agySummary = activeAgy
    ? { title: agyTitle(activeAgy), loggedIn: activeAgy.loggedIn !== false }
    : null;
  const agyAttention = loginPending(agyData?.login)
    ? '登录进行中'
    : activeAgy?.loggedIn === false
      ? '需要登录'
      : null;

  const showTargetSeg = agyData !== null && dialog !== null && !dialog.relogin && !dialog.editApi && !dialog.resume;
  const targetSeg = showTargetSeg ? (
    <AddTargetSeg
      target={dialog.kind === 'agy' ? 'agy' : 'claude'}
      agyDisabled={!agyData.installed}
      fromTarget={dialog.fromTarget}
      onChange={switchAddTarget}
    />
  ) : undefined;

  return (
    <div className="cz-sidebar__account-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`cz-sidebar__account-main${open ? ' is-open' : ''}`}
        onClick={() => (open ? close() : setOpen(true))}
        aria-label="账户菜单"
        aria-haspopup="true"
        aria-expanded={open}
      >
        {account ? (
          <>
            <Avatar title={account.name} loggedIn size="md" />
            <span className="cz-sidebar__account-text">
              <span className="cz-sidebar__account-name">{account.name}</span>
              {account.plan && <span className="cz-sidebar__account-plan">{account.plan}</span>}
            </span>
          </>
        ) : (
          <>
            <Avatar title="" loggedIn={false} size="md" />
            <span className="cz-sidebar__account-text cz-sidebar__account-text--muted">未登录</span>
          </>
        )}
        <span className={`cz-sidebar__account-chev${open ? ' is-open' : ''}`} aria-hidden="true">
          <Icon name="chevron-up" size={14} />
        </span>
      </button>

      {mounted && (
        <div
          ref={menuRef}
          className={`cz-sidebar__menu cz-sidebar__menu--up cz-pop${leaving ? ' is-leaving' : ''}`}
          role="group"
          aria-label="账号"
          {...leavingProps(leaving)}
          style={{ '--pop-origin': 'bottom left', '--pop-dy': '4px' } as CSSProperties}
        >
          <div className="cz-sidebar__menu-list">
            <AccountGroup
              brand="claude"
              title="Claude"
              count={data ? list.length : undefined}
              open={groups.claude}
              onToggle={() => toggleGroup('claude')}
              summary={claudeSummary}
              attention={claudeAttention}
              onAdd={addClaude}
              addLabel="添加 Claude 账号"
            >
              <AccountModeSwitch mode={data?.mode ?? null} onChanged={loadClaude} />
              {parallel && <div className="cz-sidebar__acct-note">并行模式：选择新会话使用的账号，已有会话继续用各自的账号</div>}
              {data === null && !error && <div className="cz-sidebar__acct-note">正在读取…</div>}
              {list.map((a, i) => {
                const title = entryTitle(a);
                const sub = entrySubtitle(a);
                // 订阅到期推算只对 claude.ai 订阅账号（有 plan、非 API、非 Kiro）显示；登录有效期对已登录非 API 非 Kiro 账号显示
                const subEst = !a.api && !a.kiro && a.loggedIn && a.plan ? subscriptionEstimate(a.subscribedAt, now) : null;
                const loginExp = !a.api && !a.kiro && a.loggedIn ? loginExpiry(a.loginExpiresAt, now) : null;
                // 每行都有移除按钮；默认 / 当前账号置灰，悬停说明原因
                const removeBlock = claudeRemoveBlock(a);
                const editable = !!a.api;
                const kiroReloginable = !!a.kiro;
                const acts = 1 + (editable || kiroReloginable ? 1 : 0);
                return (
                  <div
                    key={a.id}
                    className={`cz-sidebar__menu-item cz-acct-row${a.active ? ' is-active' : ''}${acts ? ' has-actions' : ''}`}
                    style={{ '--row-i': Math.min(i, 5), ...(acts ? { '--acts': acts } : {}) } as CSSProperties}
                  >
                    <button
                      type="button"
                      className="cz-sidebar__menu-main cz-acct-row__main"
                      aria-current={a.active ? 'true' : undefined}
                      disabled={switching !== null}
                      onClick={() => pick(a)}
                    >
                      <Avatar title={title} loggedIn={a.loggedIn} />
                      <span className="cz-sidebar__menu-text cz-acct-row__head">
                        <span className="cz-acct-row__title">
                          <span className="cz-sidebar__menu-name">{title}</span>
                          {a.kiro && <span className="cz-acct-chip">Kiro</span>}
                          {(!a.kiro || planChip(a.plan)?.toLowerCase() !== 'kiro') && <PlanChip plan={a.plan} />}
                        </span>
                        {sub && <span className="cz-sidebar__menu-path">{sub}</span>}
                      </span>
                      {switching === a.id ? (
                        <span className="cz-sidebar__acct-tag cz-acct-row__status">切换中…</span>
                      ) : a.active ? (
                        <ActiveMark />
                      ) : null}
                      {(subEst || loginExp) && (
                        <span className="cz-acct-row__dates">
                          {subEst && (
                            <span className="cz-acct-row__date" title={subEst.title}>{subEst.text}</span>
                          )}
                          {subEst && loginExp && <span className="cz-acct-row__date-sep" aria-hidden="true"> · </span>}
                          {loginExp && (
                            <span className={`cz-acct-row__date${loginExp.tone !== 'normal' ? ` is-${loginExp.tone}` : ''}`}>
                              {loginExp.text}
                            </span>
                          )}
                        </span>
                      )}
                      {a.api ? (
                        <span className="cz-acct-row__extra cz-acctq__hint">{apiMapNote(a.api)}</span>
                      ) : a.kiro ? (
                        <span className="cz-acct-row__extra">
                          {a.kiro.proxy === 'failed' && (
                            <span className="cz-acctq__hint cz-acctq__hint--error" role="status">
                              代理异常：{a.kiro.error ?? '启动失败'}
                            </span>
                          )}
                          {a.loggedIn && <KiroQuotaView state={kiroBalances[a.id] ?? { status: 'loading' }} now={now} />}
                        </span>
                      ) : a.loggedIn ? (
                        <span className="cz-acct-row__extra"><AccountQuota state={quotas[a.id] ?? { status: 'loading' }} now={now} /></span>
                      ) : null}
                    </button>
                    <div className="cz-sidebar__actions">
                      {editable && <ActionButton icon="pencil" label="修改 API 账号与模型映射" onClick={() => editApi(a)} />}
                      {kiroReloginable && <ActionButton icon="refresh" label="重新登录" onClick={() => reloginKiro(a)} />}
                      <ConfirmActionButton
                        icon="trash"
                        label="移除账号"
                        confirmText={`移除账号「${title}」？`}
                        note={
                          a.api
                            ? '会删除该账号保存的 API Key；skill、设置和会话历史是共享的，不受影响'
                            : a.kiro
                              ? '会删除该账号保存的 Kiro 凭据；skill、设置和会话历史是共享的，不受影响'
                              : '只删除该账号的登录信息；skill、设置和会话历史是共享的，不受影响'
                        }
                        confirmLabel="移除"
                        disabled={removeBlock !== null}
                        disabledTitle={removeBlock ?? undefined}
                        onConfirm={() => remove(a.id)}
                      />
                    </div>
                  </div>
                );
              })}
              <DuplicateNote
                count={data?.duplicates ?? 0}
                onClean={async () => {
                  const r = await api.dedupeAccounts();
                  loadClaude();
                  return r;
                }}
              />
              {hasKiro && (
                <div className="cz-sidebar__acct-note cz-kiro-eng">
                  <div className="cz-kiro-eng__line">
                    <span className="cz-kiro-eng__ver">
                      kiro.rs 引擎{kiroStatus?.engine.current?.commit ? ` ${kiroStatus.engine.current.commit.slice(0, 7)}` : ''}
                    </span>
                    {kiroStatus && !kiroStatus.service.enabled && (
                      <span className="cz-kiro-eng__badge">已停止</span>
                    )}
                    {kiroStatus?.engine.build.state === 'running' ? (
                      <span className="cz-kiro-eng__step" role="status">
                        {kiroStatus.engine.build.step ?? '正在更新…'}
                      </span>
                    ) : (
                      <span className="cz-kiro-eng__acts">
                        {kiroStatus?.engine.updateAvailable && (
                          <>
                            <span className="cz-kiro-eng__badge" title={kiroStatus.engine.latest?.title ?? undefined}>有更新</span>
                            <button
                              type="button"
                              className="cz-acct-dup__btn"
                              disabled={kiroBuilding || kiroChecking}
                              onClick={() => void buildKiroEngine()}
                            >
                              {kiroBuilding ? '启动中…' : '更新'}
                            </button>
                          </>
                        )}
                        <button
                          type="button"
                          className="cz-acct-dup__btn"
                          disabled={kiroChecking || kiroBuilding}
                          onClick={() => void checkKiroUpdate()}
                        >
                          {kiroChecking ? '检查中…' : '检查更新'}
                        </button>
                      </span>
                    )}
                  </div>
                  {kiroStatus && kiroStatus.service.outdated > 0 && (
                    <div className="cz-kiro-eng__note">{kiroStatus.service.outdated} 个代理重启后用新版</div>
                  )}
                  {kiroStatus?.engine.build.state === 'failed' && kiroStatus.engine.build.error && (
                    <div className="cz-kiro-eng__err" role="alert">{kiroStatus.engine.build.error}</div>
                  )}
                  {kiroEngineErr && <div className="cz-kiro-eng__err" role="alert">{kiroEngineErr}</div>}
                </div>
              )}
            </AccountGroup>

            {agyData !== null && (
              <>
                <div className="cz-sidebar__menu-sep" />
                <AccountGroup
                  brand="agy"
                  title="Antigravity"
                  count={agyData.installed ? agyList.length : undefined}
                  open={groups.agy}
                  onToggle={() => toggleGroup('agy')}
                  summary={agyData.installed ? agySummary : null}
                  attention={agyData.installed ? agyAttention : null}
                  onAdd={agyData.installed ? addAgy : undefined}
                  addLabel="添加 Antigravity 账号"
                >
                  {!agyData.installed ? (
                    <div className="cz-sidebar__acct-note">没有安装 Antigravity CLI</div>
                  ) : (
                    <>
                      {agyList.length === 0 ? (
                        <div className="cz-sidebar__acct-note">还没有 Antigravity 账号</div>
                      ) : (
                        agyList.map((a, i) => {
                          const title = agyTitle(a);
                          const sub = agySubtitle(a);
                          const renamable = !a.isDefault;
                          const removeBlock = agyRemoveBlock(a);
                          const acts = (renamable ? 1 : 0) + 1;
                          if (editingAgyId === a.id && renamable) {
                            return (
                              <AgyRenameRow
                                key={a.id}
                                initial={a.label}
                                busy={renamingBusy}
                                onSave={(val) => void saveAgyLabel(a.id, val)}
                                onCancel={() => setEditingAgyId(null)}
                              />
                            );
                          }
                          return (
                            <div
                              key={a.id}
                              className={`cz-sidebar__menu-item cz-acct-row cz-acct-row--agy${a.active ? ' is-active' : ''}${acts ? ' has-actions' : ''}`}
                              style={{ '--row-i': Math.min(i, 5), ...(acts ? { '--acts': acts } : {}) } as CSSProperties}
                            >
                              <button
                                type="button"
                                className="cz-sidebar__menu-main cz-acct-row__main"
                                aria-current={a.active ? 'true' : undefined}
                                disabled={agySwitching !== null}
                                onClick={() => pickAgy(a)}
                              >
                                <Avatar title={title} loggedIn={a.loggedIn !== false} />
                                <span className="cz-sidebar__menu-text cz-acct-row__head">
                                  <span className="cz-acct-row__title">
                                    <span className="cz-sidebar__menu-name" title={title}>{title}</span>
                                    <PlanChip plan={a.plan} />
                                  </span>
                                  {sub && <span className="cz-sidebar__menu-path" title={sub}>{sub}</span>}
                                </span>
                                {agySwitching === a.id ? (
                                  <span className="cz-sidebar__acct-tag cz-acct-row__status">切换中…</span>
                                ) : a.active ? (
                                  <ActiveMark />
                                ) : null}
                                {a.loggedIn !== false && a.quota && a.quota.groups.length > 0 && (
                                  <span className="cz-acct-row__extra"><AgyQuotaView quota={a.quota} now={now} /></span>
                                )}
                              </button>
                              <div className="cz-sidebar__actions">
                                {renamable && <ActionButton icon="pencil" label="修改备注名" onClick={() => setEditingAgyId(a.id)} />}
                                <ConfirmActionButton
                                  icon="trash"
                                  label="移除账号"
                                  confirmText={`移除账号「${title}」？`}
                                  note="会删除该账号的登录信息和它的委派会话记录"
                                  confirmLabel="移除"
                                  disabled={removeBlock !== null}
                                  disabledTitle={removeBlock ?? undefined}
                                  onConfirm={() => removeAgy(a.id)}
                                />
                              </div>
                            </div>
                          );
                        })
                      )}
                      <DuplicateNote
                        count={agyData.duplicates ?? 0}
                        onClean={async () => {
                          const r = await api.dedupeAgyAccounts();
                          loadAgy();
                          return r;
                        }}
                      />
                      <div className="cz-sidebar__acct-note">新的委派任务使用选中的账号，已有的委派继续用原来的账号</div>
                    </>
                  )}
                </AccountGroup>
              </>
            )}
          </div>

          {confirm && (
            <div className="cz-sidebar__acct-confirm" role="alert">
              <div className="cz-sidebar__confirm-text">
                有 {confirm.running} 个会话正在执行，切换到「{confirmName}」会停止它们。
              </div>
              <div className="cz-sidebar__confirm-btns">
                <button type="button" className="cz-sidebar__confirm-btn" onClick={() => setConfirm(null)}>取消</button>
                <button
                  type="button"
                  className="cz-sidebar__confirm-btn cz-sidebar__confirm-btn--danger"
                  onClick={() => void doSwitch(confirm.id, true)}
                >
                  强制切换
                </button>
              </div>
            </div>
          )}
          {error && <div className="cz-sidebar__acct-note cz-sidebar__acct-note--error">{error}</div>}

          <div className="cz-sidebar__menu-sep" />
          <ThemeSwitch />
        </div>
      )}

      {dialog?.kind === 'login' && (
        <AccountDialog
          relogin={dialog.relogin}
          resume={dialog.resume}
          onClose={closeDialog}
          onDone={onDialogDone}
          onSwitch={dialogSwitchClaude}
          onChangeKind={dialog.relogin || dialog.resume ? undefined : switchAddKind}
          targetSeg={targetSeg}
          enter={!dialog.switched}
        />
      )}
      {dialog?.kind === 'api' && (
        <ApiAccountDialog
          edit={dialog.editApi}
          onClose={closeDialog}
          onDone={loadClaude}
          onSwitch={dialogSwitchClaude}
          onChangeKind={dialog.editApi ? undefined : switchAddKind}
          targetSeg={targetSeg}
          enter={!dialog.switched}
        />
      )}
      {dialog?.kind === 'kiro' && (
        <KiroAccountDialog
          relogin={dialog.relogin}
          resume={dialog.resume}
          onClose={closeDialog}
          onDone={onDialogDone}
          onSwitch={dialogSwitchClaude}
          onChangeKind={dialog.relogin || dialog.resume ? undefined : switchAddKind}
          targetSeg={targetSeg}
          enter={!dialog.switched}
        />
      )}
      {dialog?.kind === 'agy' && (
        <AgyAccountDialog
          relogin={dialog.relogin}
          resume={dialog.resume}
          onClose={closeDialog}
          onDone={onDialogDone}
          onSwitch={dialogSwitchAgy}
          targetSeg={targetSeg}
          enter={!dialog.switched}
        />
      )}
    </div>
  );
}
