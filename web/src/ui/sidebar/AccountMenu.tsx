// 左下角账户栏 + 账号弹层（向上弹出）。弹层分「主代理 / 子代理」两段（液态玻璃胶囊切换，记住上次选择）：
// - 主代理：模式切换（切换模式 / 并行模式，只对主代理生效）+ 已登录的 Claude 订阅 / API / Kiro 分组，
//   每个账号一行名字 + 一条最先重置的额度「5h ━━━ 94% 2小时14分后」，悬停显示详情卡（AccountCard）；
// - 子代理：按类型三张卡片（原生 / Claude / Antigravity），按 GET /api/subagents 的 effective 标注「正在使用」，
//   原生只读跟随主代理；Claude 从 Claude 账号列表单选（POST /api/accounts/subagent，未登录项置灰并说明）；
//   Antigravity 复用原有 agy 账号组（切换不刷新页面、不关弹层）；
// - 底部是「管理账号」（AccountManager：全部账号的卡片、添加、编辑、改名、移除、清理重复、kiro.rs 引擎）、外观。
// 状态和接口调用都在这里，弹层和管理面板共用。
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import {
  SUBAGENT_KINDS,
  type Account, type AccountApiInfo, type AccountEntry, type AccountList, type AccountLogin, type AgyAccountEntry, type AgyAccountList, type SubagentKind,
} from '@cosyee/shared';
import { LiquidCapsule } from '../motion/LiquidCapsule';
import { reducedMotion } from '../motion/reduced';
import { leavingProps, usePresence } from '../motion/usePresence';
import { api, ApiError } from '../../core/api';
import { BrandIcon } from '../icons/BrandIcon';
import { Icon } from '../icons/Icon';
import { AccountCardLayer, AgyCardBody, ClaudeCardBody, useAccountCard } from './AccountCard';
import { AccountDialog } from './AccountDialog';
import { AgyAccountDialog } from './AgyAccountDialog';
import { ApiAccountDialog } from './ApiAccountDialog';
import { KiroAccountDialog } from './KiroAccountDialog';
import { AccountManager, type AddDialogKind } from './AccountManager';
import { AccountModeSwitch } from './AccountModeSwitch';
import {
  agyWindows, claudeWindows, kiroWindow, nearestWindow, QuotaBrief, type KiroBalanceState, type QuotaState,
} from './AccountQuota';
import {
  ActiveMark, agyTitle, Avatar, claudeKind, claudeUsable, entryTitle, IssueChip, kiroIssue, loginPending, msg, PlanChip, planChip, type ClaudeKind,
} from './accountParts';
import { ThemeSwitch } from './ThemeSwitch';
import { useDismiss } from './useDismiss';

export {
  agyRemoveBlock, agySubtitle, agyTitle, apiHost, apiMapNote, claudeRemoveBlock, entrySubtitle, entryTitle, planChip,
} from './accountParts';

export interface AccountMenuProps {
  account: Account | null;
  /** 账号信息有变化但没有整页刷新时递增：弹层 / 管理面板开着就重读列表 */
  version?: number;
}

interface DialogState {
  /** login = claude.ai 登录；api = API 账号；kiro = Kiro 账号；agy = Antigravity 登录 */
  kind: AddDialogKind;
  relogin?: { id: string; title: string; active: boolean };
  resume: AccountLogin | null;
  /** 修改的 API 账号 */
  editApi?: { id: string; label: string; title: string; api: AccountApiInfo };
}

type AccountTab = 'main' | 'sub';
const TAB_STORAGE_KEY = 'cz-acct-tab';
const TABS: readonly { id: AccountTab; label: string }[] = [
  { id: 'main', label: '主代理' },
  { id: 'sub', label: '子代理' },
];

function readSavedTab(): AccountTab {
  try {
    return localStorage.getItem(TAB_STORAGE_KEY) === 'sub' ? 'sub' : 'main';
  } catch {
    return 'main';
  }
}

function saveTab(tab: AccountTab) {
  try {
    localStorage.setItem(TAB_STORAGE_KEY, tab);
  } catch { /* ignore */ }
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

const MAIN_GROUPS: { kind: ClaudeKind; title: string; tip: string }[] = [
  { kind: 'claude', title: 'Claude 订阅', tip: 'claude.ai 订阅账号' },
  { kind: 'api', title: 'API', tip: '用 API Key 按量计费' },
  { kind: 'kiro', title: 'Kiro', tip: '经 kiro.rs 代理使用 Kiro 额度' },
];

/** 弹层里的一个账号：名字、套餐，右端是选中勾 / 切换中和问题标签，下面一条最近额度。
 *  同组的行共用一套列（CSS subgrid）：套餐标签排成一列，问题标签靠右、和下面的百分比右对齐 */
function PickRow({
  title, plan, issue, active, busy, disabled, quota, card, onPick,
}: {
  title: string;
  plan?: string | null;
  /** 红色问题标签（Kiro 额度用完 / 已停用） */
  issue?: string | null;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  quota: ReactNode;
  /** 悬浮详情卡的事件绑定 */
  card: ReturnType<ReturnType<typeof useAccountCard>['bind']>;
  onPick: () => void;
}) {
  const state = busy ? <span className="cz-sidebar__acct-tag">切换中…</span> : active ? <ActiveMark /> : null;
  return (
    <button
      type="button"
      className={`cz-acct-pick${active ? ' is-active' : ''}`}
      aria-current={active ? 'true' : undefined}
      disabled={disabled}
      {...card}
      onClick={onPick}
    >
      <span className="cz-acct-pick__name"><b>{title}</b></span>
      <PlanChip plan={plan} tip={false} />
      {(state || issue) && (
        <span className="cz-acct-pick__end">
          {state}
          <IssueChip text={issue} />
        </span>
      )}
      {quota}
    </button>
  );
}

/** 子代理 Claude 卡片里的账号单选行：带头像、名字、套餐标签、额度简要，未登录 / 已失效置灰并说明原因 */
function SubClaudeRow({
  title, plan, issue, usable, unavailReason, selected, busy, disabled, tabIndex, btnRef, quota, card, onPick,
}: {
  title: string;
  plan?: string | null;
  issue?: string | null;
  usable: boolean;
  unavailReason: string | null;
  selected: boolean;
  busy: boolean;
  disabled: boolean;
  tabIndex: number;
  btnRef?: (el: HTMLButtonElement | null) => void;
  quota: ReactNode;
  card?: ReturnType<ReturnType<typeof useAccountCard>['bind']>;
  onPick: () => void;
}) {
  return (
    <button
      ref={btnRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={tabIndex}
      className={`cz-acct-pick cz-acct-sub-pick${selected ? ' is-active' : ''}${usable ? '' : ' is-unavail'}`}
      disabled={disabled}
      title={unavailReason ?? undefined}
      {...(card ?? {})}
      onClick={onPick}
    >
      <Avatar title={title} loggedIn={usable} size="xs" />
      <span className="cz-acct-pick__name">
        <b>{title}</b>
        <PlanChip plan={plan} tip={false} />
        <IssueChip text={issue} />
      </span>
      {!usable ? (
        <span className="cz-acct-sub-reason">{unavailReason}</span>
      ) : busy ? (
        <span className="cz-sidebar__acct-tag">切换中…</span>
      ) : selected ? (
        <ActiveMark />
      ) : (
        <span />
      )}
      {quota}
    </button>
  );
}

export function AccountMenu({ account, version = 0 }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  /** 管理账号面板 */
  const [manage, setManage] = useState(false);
  /** 顶部主代理 / 子代理分段（localStorage 记忆） */
  const [tab, setTab] = useState<AccountTab>(readSavedTab);
  const [data, setData] = useState<AccountList | null>(null);
  const [agyData, setAgyData] = useState<AgyAccountList | null>(null);
  const [agyStatus, setAgyStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  /** 当前实际生效的子代理类型（来自 GET /api/subagents） */
  const [subEffective, setSubEffective] = useState<SubagentKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 切换被执行中的会话拦下：等用户决定是否强制切换 */
  const [confirm, setConfirm] = useState<{ id: string; running: number } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [subClaudeSwitching, setSubClaudeSwitching] = useState<string | null>(null);
  const [agySwitching, setAgySwitching] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** 弹层或管理面板开着时每分钟推进一次，驱动额度重置倒计时与到期提示刷新 */
  const [now, setNow] = useState(() => Date.now());
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<AccountTab, HTMLButtonElement | null>>>({});
  const subClaudeRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const aliveRef = useRef(true);
  const claudeSeq = useRef(0);
  const agySeq = useRef(0);
  const subSeq = useRef(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  const tabIdBase = useId();
  // 关闭时留着播完退场（.cz-pop），退场途中再打开会从当前状态接回去
  const { mounted, leaving } = usePresence(open, menuRef);
  const shown = open || manage;
  const card = useAccountCard(open && !manage && !dialog);

  // 分段切换方向（-1 向左、+1 向右、0 首次）与内容区高度平滑过渡（快速切换可打断接续）
  const prevTabRef = useRef<AccountTab>(tab);
  const tabDirRef = useRef<number>(0);
  if (prevTabRef.current !== tab) {
    tabDirRef.current = tab === 'sub' ? 1 : -1;
    prevTabRef.current = tab;
  }
  const paneRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastPaneH = useRef<number | null>(null);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    const stage = stageRef.current;
    if (!open || !pane || !stage) {
      lastPaneH.current = null;
      return;
    }
    const toH = stage.scrollHeight;
    const fromH = lastPaneH.current;
    lastPaneH.current = toH;
    if (fromH === null || Math.abs(toH - fromH) < 1 || reducedMotion()) {
      pane.style.height = '';
      pane.style.overflow = '';
      return;
    }
    pane.style.height = `${fromH}px`;
    pane.style.overflow = 'hidden';
    // 强制同步起始高度，随后过渡到目标高度
    void pane.offsetHeight;
    pane.style.height = `${toH}px`;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pane.style.height = '';
      pane.style.overflow = '';
      lastPaneH.current = stage.scrollHeight;
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === pane && e.propertyName === 'height') finish();
    };
    pane.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(finish, 240);
    return () => {
      pane.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
      const curH = pane.getBoundingClientRect().height;
      if (curH > 0) lastPaneH.current = curH;
    };
  }, [tab, open]);

  // 同分段下异步数据到达后同步高度基准
  useEffect(() => {
    if (open && stageRef.current && paneRef.current && !paneRef.current.style.height) {
      lastPaneH.current = stageRef.current.scrollHeight;
    }
  });

  const selectTab = useCallback((next: AccountTab) => {
    setTab((cur) => {
      if (cur === next) return cur;
      saveTab(next);
      return next;
    });
    card.closeNow();
  }, [card]);

  const onTabKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: AccountTab | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      next = tab === 'main' ? 'sub' : 'main';
    } else if (e.key === 'Home') {
      next = 'main';
    } else if (e.key === 'End') {
      next = 'sub';
    }
    if (!next) return;
    e.preventDefault();
    selectTab(next);
    tabRefs.current[next]?.focus();
  };

  const close = useCallback(() => {
    setOpen(false);
    setConfirm(null);
    setError(null);
  }, []);
  useDismiss(open && !dialog && !manage, wrapRef, close);

  const loadClaude = useCallback(() => {
    const seq = ++claudeSeq.current;
    api.accounts().then(
      (res) => {
        if (!aliveRef.current || seq !== claudeSeq.current) return;
        if (res && Array.isArray(res.list)) {
          setData(res);
          setError(null);
        } else {
          setError('账号数据格式异常');
        }
      },
      (e) => {
        if (!aliveRef.current || seq !== claudeSeq.current) return;
        setError(msg(e));
      },
    );
  }, []);
  const loadAgy = useCallback(() => {
    const seq = ++agySeq.current;
    // refresh：额度超过 90 秒没更新的账号后台重新检测，结果通过 agy.changed → version 再读一次
    api.agyAccounts(true).then(
      (res) => {
        if (!aliveRef.current || seq !== agySeq.current) return;
        if (res && typeof res.installed === 'boolean' && Array.isArray(res.list)) {
          setAgyData(res);
          setAgyStatus('loaded');
        } else {
          setAgyData(null);
          setAgyStatus('error');
        }
      },
      () => {
        if (!aliveRef.current || seq !== agySeq.current) return;
        setAgyData(null);
        setAgyStatus('error');
      },
    );
  }, []);
  const loadSubagents = useCallback(() => {
    const seq = ++subSeq.current;
    api.subagents().then(
      (res) => {
        if (!aliveRef.current || seq !== subSeq.current) return;
        setSubEffective(res && SUBAGENT_KINDS.includes(res.effective) ? res.effective : null);
      },
      () => {
        if (!aliveRef.current || seq !== subSeq.current) return;
        setSubEffective(null);
      },
    );
  }, []);
  const load = useCallback(() => {
    loadClaude();
    loadAgy();
    loadSubagents();
  }, [loadClaude, loadAgy, loadSubagents]);

  useEffect(() => {
    if (shown) load();
  }, [shown, load, version]);

  useEffect(() => {
    if (!shown) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [shown]);

  const parallel = data?.mode === 'parallel';
  const list = data?.list ?? [];
  const agyList = agyData?.list ?? [];

  /** 每个可用的 claude.ai 订阅账号的额度：弹层或管理面板开着时并行读取 */
  const [quotas, setQuotas] = useState<Record<string, QuotaState>>({});
  const quotaIds = list.filter((a) => claudeKind(a) === 'claude' && claudeUsable(a, now)).map((a) => a.id).join(',');
  useEffect(() => {
    if (!shown || !quotaIds) return;
    let alive = true;
    for (const id of quotaIds.split(',')) {
      api.usage(false, null, id).then(
        (info) => alive && setQuotas((q) => ({ ...q, [id]: info && info.limits.length ? { status: 'ok', info } : { status: 'none' } })),
        () => alive && setQuotas((q) => ({ ...q, [id]: q[id]?.status === 'ok' ? q[id]! : { status: 'fail' } })),
      );
    }
    return () => { alive = false; };
  }, [shown, quotaIds]);

  /** 每个已登录 Kiro 账号的额度 */
  const [kiroBalances, setKiroBalances] = useState<Record<string, KiroBalanceState>>({});
  const kiroBalanceIds = list.filter((a) => a.loggedIn && !!a.kiro).map((a) => a.id).join(',');
  useEffect(() => {
    if (!shown || !kiroBalanceIds) return;
    let alive = true;
    for (const id of kiroBalanceIds.split(',')) {
      api.kiroBalance(id).then(
        (info) => alive && setKiroBalances((b) => ({ ...b, [id]: { status: 'ok', info } })),
        () => alive && setKiroBalances((b) => ({ ...b, [id]: b[id]?.status === 'ok' ? b[id]! : { status: 'fail' } })),
      );
    }
    return () => { alive = false; };
  }, [shown, kiroBalanceIds]);

  const doSwitch = async (id: string, force = false) => {
    setError(null);
    setConfirm(null);
    setSwitching(id);
    try {
      await api.switchAccount(id, force);
      if (!aliveRef.current) return;
      if (parallel) {
        setSwitching(null);
        loadClaude();
        if (!manage) close();
      } else accountPage.reload();
    } catch (e) {
      if (!aliveRef.current) return;
      setSwitching(null);
      if (e instanceof ApiError && e.status === 409 && typeof e.data.running === 'number') {
        setConfirm({ id, running: e.data.running });
      } else setError(msg(e));
    }
  };

  const doSwitchSubClaude = async (id: string) => {
    setError(null);
    setSubClaudeSwitching(id);
    const seq = ++claudeSeq.current;
    try {
      const next = await api.setSubagentAccount(id);
      if (!aliveRef.current || seq !== claudeSeq.current) return;
      if (next && Array.isArray(next.list)) setData(next);
      else loadClaude();
    } catch (e) {
      if (!aliveRef.current) return;
      setError(msg(e));
    } finally {
      if (aliveRef.current) setSubClaudeSwitching(null);
    }
  };

  const doSwitchAgy = async (id: string) => {
    setError(null);
    setAgySwitching(id);
    try {
      await api.switchAgyAccount(id);
      if (!aliveRef.current) return;
      loadAgy();
    } catch (e) {
      if (!aliveRef.current) return;
      setError(msg(e));
    } finally {
      if (aliveRef.current) setAgySwitching(null);
    }
  };

  const pick = (a: AccountEntry) => {
    if (switching) return;
    if (a.active) {
      close();
      return;
    }
    void doSwitch(a.id);
  };

  const pickSubClaude = (a: AccountEntry) => {
    if (subClaudeSwitching || !claudeUsable(a, now) || data?.subagent?.claude === a.id) return;
    void doSwitchSubClaude(a.id);
  };

  const pickAgy = (a: AgyAccountEntry) => {
    if (agySwitching || a.active) return;
    void doSwitchAgy(a.id);
  };

  /** 这次对话框里登录成功了（Claude 当前账号重新登录成功后要刷新整页，名字 / 套餐可能变了） */
  const loginDone = useRef(false);
  const onDialogDone = useCallback(() => {
    loginDone.current = true;
    load();
  }, [load]);

  const openDialog = useCallback((d: DialogState) => {
    loginDone.current = false;
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
    if (!manage) setOpen(true);
    void doSwitch(id);
  };

  const dialogSwitchAgy = (id: string) => {
    setDialog(null);
    if (!manage) setOpen(true);
    void doSwitchAgy(id);
  };

  const claudeReloginOf = (l: AccountLogin | null | undefined) => {
    if (!l?.accountId) return undefined;
    const hit = list.find((x) => x.id === l.accountId);
    return { id: l.accountId, title: hit ? entryTitle(hit) : l.accountId, active: !!hit?.active };
  };

  const agyReloginOf = (l: AccountLogin | null | undefined) => {
    if (!l?.accountId) return undefined;
    const hit = agyList.find((x) => x.id === l.accountId);
    return { id: l.accountId, title: hit ? agyTitle(hit) : l.accountId, active: !!hit?.active };
  };

  /** 管理面板里每组的「添加」：登录进行中时接着那次登录 */
  const add = (kind: AddDialogKind) => {
    if (kind === 'login') {
      const l = data?.login ?? null;
      const resume = loginPending(l) ? l : null;
      openDialog({ kind, relogin: claudeReloginOf(resume), resume });
    } else if (kind === 'agy') {
      const l = agyData?.login ?? null;
      const resume = loginPending(l) ? l : null;
      openDialog({ kind, relogin: agyReloginOf(resume), resume });
    } else openDialog({ kind, resume: null });
  };

  const relogin = (a: AccountEntry) =>
    openDialog({ kind: a.kiro ? 'kiro' : 'login', relogin: { id: a.id, title: entryTitle(a), active: a.active }, resume: null });

  const reloginAgy = (a: AgyAccountEntry) =>
    openDialog({ kind: 'agy', relogin: { id: a.id, title: agyTitle(a), active: a.active }, resume: null });

  const editApi = (a: AccountEntry) => {
    if (!a.api) return;
    openDialog({ kind: 'api', resume: null, editApi: { id: a.id, label: a.label, title: entryTitle(a), api: a.api } });
  };

  const rename = async (a: AccountEntry, label: string) => {
    setError(null);
    try {
      await api.setAccountLabel(a.id, label);
      loadClaude();
      return true;
    } catch (e) {
      setError(msg(e));
      return false;
    }
  };

  const renameAgy = async (a: AgyAccountEntry, label: string) => {
    setError(null);
    try {
      await api.setAgyLabel(a.id, label);
      loadAgy();
      return true;
    } catch (e) {
      setError(msg(e));
      return false;
    }
  };

  const remove = (a: AccountEntry) => {
    setError(null);
    api.removeAccount(a.id).then(loadClaude, (e) => setError(msg(e)));
  };

  const removeAgy = (a: AgyAccountEntry) => {
    setError(null);
    api.removeAgyAccount(a.id).then(loadAgy, (e) => setError(msg(e)));
  };

  const confirmEntry = confirm ? list.find((a) => a.id === confirm.id) : undefined;
  const confirmName = confirmEntry ? entryTitle(confirmEntry) : '该账号';
  const confirmBar = confirm && (
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
  );
  const errorBar = error && <div className="cz-sidebar__acct-note cz-sidebar__acct-note--error">{error}</div>;
  const notice = (
    <>
      {confirmBar}
      {errorBar}
    </>
  );

  /** 弹层里的 Claude 类账号：最近额度一行 */
  const claudeBrief = (a: AccountEntry, kind: ClaudeKind) => {
    if (kind === 'claude') {
      const q = quotas[a.id];
      if (!q || q.status === 'loading') return <QuotaBrief win={null} loading />;
      return q.status === 'ok' ? <QuotaBrief win={nearestWindow(claudeWindows(q.info))} now={now} /> : null;
    }
    if (kind === 'kiro') {
      const b = kiroBalances[a.id];
      if (!b || b.status === 'loading') return <QuotaBrief win={null} loading />;
      return b.status === 'ok' ? <QuotaBrief win={kiroWindow(b.info)} now={now} /> : null;
    }
    return null;
  };

  const mainGroupRows = MAIN_GROUPS.map((g) => ({
    g,
    rows: list
      .filter((a) => claudeKind(a) === g.kind && claudeUsable(a, now))
      .map((a) => (
        <PickRow
          key={a.id}
          title={entryTitle(a)}
          plan={g.kind === 'kiro' && planChip(a.plan)?.toLowerCase() === 'kiro' ? null : a.plan}
          issue={kiroIssue(a)}
          active={a.active}
          busy={switching === a.id}
          disabled={switching !== null && switching !== a.id}
          quota={claudeBrief(a, g.kind)}
          card={card.bind(`c:${a.id}`)}
          onPick={() => pick(a)}
        />
      )),
  })).filter((x) => x.rows.length > 0);

  const usableAgy = agyData?.installed ? agyList.filter((a) => a.loggedIn === true) : [];
  const usableClaude = list.filter((a) => claudeUsable(a, now));
  const subClaudeSelected = data?.subagent?.claude ?? null;
  const focusSubClaudeId = usableClaude.some((a) => a.id === subClaudeSelected)
    ? subClaudeSelected
    : (usableClaude[0]?.id ?? null);

  const onSubClaudeKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!usableClaude.length || subClaudeSwitching) return;
    let next: AccountEntry | undefined;
    const focused = usableClaude.find((a) => subClaudeRefs.current[a.id] === document.activeElement);
    const baseId = focused?.id ?? focusSubClaudeId;
    const curIdx = Math.max(0, usableClaude.findIndex((a) => a.id === baseId));
    const len = usableClaude.length;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      next = usableClaude[(curIdx + 1) % len];
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      next = usableClaude[(curIdx - 1 + len) % len];
    } else if (e.key === 'Home') {
      next = usableClaude[0];
    } else if (e.key === 'End') {
      next = usableClaude[len - 1];
    }
    if (!next) return;
    e.preventDefault();
    subClaudeRefs.current[next.id]?.focus();
    pickSubClaude(next);
  };

  // 悬浮详情卡的内容：从最新列表里取，额度读回来后跟着更新；账号不在了就不显示
  const cardClaude = list.find((a) => `c:${a.id}` === card.hover.key);
  const cardAgy = usableAgy.find((a) => `g:${a.id}` === card.hover.key);
  const cardBody = cardClaude ? (
    <ClaudeCardBody a={cardClaude} quota={quotas[cardClaude.id]} balance={kiroBalances[cardClaude.id]} parallel={parallel} now={now} />
  ) : cardAgy ? <AgyCardBody a={cardAgy} now={now} /> : null;

  const subCardCls = (k: SubagentKind) =>
    `cz-acct-sub-card${subEffective === k ? ' is-used' : subEffective !== null ? ' is-dim' : ''}`;

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
            <Avatar title={account.name} loggedIn />
            <span className="cz-sidebar__account-text">
              <span className="cz-sidebar__account-name">{account.name}</span>
              {account.plan && <span className="cz-sidebar__account-plan">{account.plan}</span>}
            </span>
          </>
        ) : (
          <>
            <Avatar title="" loggedIn={false} />
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
          className={`cz-sidebar__menu cz-sidebar__menu--up cz-acct-menu cz-pop${leaving ? ' is-leaving' : ''}`}
          role="group"
          aria-label="账号"
          {...leavingProps(leaving)}
          style={{ '--pop-origin': 'bottom left', '--pop-dy': '4px' } as CSSProperties}
        >
          <div className="cz-acct-tabs" role="tablist" aria-label="账号分组" onKeyDown={onTabKeyDown}>
            <LiquidCapsule activeKey={tab} selector=".cz-acct-tab.is-active" axis="x" />
            {TABS.map((t) => {
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  id={`${tabIdBase}-tab-${t.id}`}
                  ref={(el) => { tabRefs.current[t.id] = el; }}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  aria-controls={`${tabIdBase}-panel-${t.id}`}
                  tabIndex={active ? 0 : -1}
                  className={`cz-acct-tab${active ? ' is-active' : ''}`}
                  onClick={() => selectTab(t.id)}
                >
                  {t.label}
                </button>
              );
            })}
          </div>

          <div ref={paneRef} className="cz-acct-pane">
            <div
              key={tab}
              ref={stageRef}
              id={`${tabIdBase}-panel-${tab}`}
              role="tabpanel"
              aria-labelledby={`${tabIdBase}-tab-${tab}`}
              className="cz-acct-stage"
              style={{ '--tab-dir': tabDirRef.current } as CSSProperties}
            >
              {tab === 'main' ? (
                <>
                  <AccountModeSwitch mode={data?.mode ?? null} onChanged={loadClaude} />
                  <div className="cz-sidebar__menu-list">
                    {data === null && !error && <div className="cz-acct-pick-empty">正在读取…</div>}
                    {data !== null && mainGroupRows.length === 0 && (
                      <div className="cz-acct-pick-empty cz-acct-pick-empty--action">
                        <span>没有可用的账号，可在「管理账号」中登录</span>
                        <button
                          type="button"
                          className="cz-acct-empty-btn"
                          onClick={() => {
                            close();
                            setManage(true);
                          }}
                        >
                          添加账号
                        </button>
                      </div>
                    )}
                    {mainGroupRows.map(({ g, rows }) => (
                      <div key={g.kind} className="cz-acct-pick-sec" role="group" aria-label={g.title}>
                        <div className="cz-acct-pick-grp" title={g.tip}><BrandIcon kind={g.kind} size={13} />{g.title}</div>
                        {rows}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="cz-sidebar__menu-list cz-acct-sub-list">
                  {/* 原生子代理：主进程内运行，只能跟随主代理账号 */}
                  <section className={subCardCls('native')} aria-label="原生">
                    <div className="cz-acct-sub-card__head">
                      <BrandIcon kind="api" size={14} />
                      <b>原生</b>
                      {subEffective === 'native' && <span className="cz-acct-sub-badge">正在使用</span>}
                    </div>
                  </section>

                  {/* Claude 委派：从 Claude 账号列表单选，复用登录态、环境隔离 */}
                  <section className={subCardCls('claude')} aria-label="Claude">
                    <div className="cz-acct-sub-card__head">
                      <BrandIcon kind="claude" size={14} />
                      <b>Claude</b>
                      {subEffective === 'claude' && <span className="cz-acct-sub-badge">正在使用</span>}
                    </div>
                    {data === null && !error ? (
                      <div className="cz-acct-sub-note">正在读取…</div>
                    ) : data && !data.subagent ? (
                      <div className="cz-acct-sub-note">当前服务端不支持单独设置子代理账号</div>
                    ) : data?.subagent ? (
                      <>
                        {data.subagent.claudeError && (
                          <div className="cz-acct-sub-err" role="alert">{data.subagent.claudeError}</div>
                        )}
                        {list.length === 0 ? (
                          <div className="cz-acct-sub-note">没有可用的账号，可在「管理账号」中登录</div>
                        ) : (
                          <div className="cz-acct-sub-rows" role="radiogroup" aria-label="Claude 委派账号" onKeyDown={onSubClaudeKeyDown}>
                            {list.map((a) => {
                              const kind = claudeKind(a);
                              const usable = claudeUsable(a, now);
                              const unavailReason = usable ? null : (!a.loggedIn ? '未登录' : '登录已失效');
                              const selected = data.subagent?.claude === a.id;
                              return (
                                <SubClaudeRow
                                  key={a.id}
                                  btnRef={(el) => { subClaudeRefs.current[a.id] = el; }}
                                  title={entryTitle(a)}
                                  plan={kind === 'kiro' && planChip(a.plan)?.toLowerCase() === 'kiro' ? null : a.plan}
                                  issue={kiroIssue(a)}
                                  usable={usable}
                                  unavailReason={unavailReason}
                                  selected={selected}
                                  busy={subClaudeSwitching === a.id}
                                  disabled={!usable || (subClaudeSwitching !== null && subClaudeSwitching !== a.id)}
                                  tabIndex={usable && a.id === focusSubClaudeId ? 0 : -1}
                                  quota={usable ? claudeBrief(a, kind) : null}
                                  card={usable ? card.bind(`c:${a.id}`) : undefined}
                                  onPick={() => pickSubClaude(a)}
                                />
                              );
                            })}
                          </div>
                        )}
                      </>
                    ) : null}
                  </section>

                  {/* Antigravity 委派：原有 agy 账号组 */}
                  <section className={subCardCls('agy')} aria-label="Antigravity">
                    <div className="cz-acct-sub-card__head">
                      <BrandIcon kind="agy" size={14} />
                      <b>Antigravity</b>
                      {subEffective === 'agy' && <span className="cz-acct-sub-badge">正在使用</span>}
                    </div>
                    {agyData === null ? (
                      <div className="cz-acct-sub-note">
                        {agyStatus === 'loading' ? '正在读取…' : '未能读取 Antigravity 账号'}
                      </div>
                    ) : !agyData.installed ? (
                      <div className="cz-acct-sub-note">未安装 Antigravity CLI</div>
                    ) : usableAgy.length === 0 ? (
                      <div className="cz-acct-sub-note">没有可用的账号，可在「管理账号」中登录</div>
                    ) : (
                      <div className="cz-acct-sub-rows" role="group" aria-label="Antigravity 账号">
                        {usableAgy.map((a) => {
                          const title = agyTitle(a);
                          const win = a.quota && a.quota.groups.length > 0 ? nearestWindow(agyWindows(a.quota)) : null;
                          return (
                            <PickRow
                              key={a.id}
                              title={title}
                              plan={a.plan}
                              active={a.active}
                              busy={agySwitching === a.id}
                              disabled={agySwitching !== null && agySwitching !== a.id}
                              quota={win ? <QuotaBrief win={win} now={now} /> : null}
                              card={card.bind(`g:${a.id}`)}
                              onPick={() => pickAgy(a)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </section>
                </div>
              )}
            </div>
          </div>

          {/* 切换确认条只属于「主代理」分段，切到「子代理」时隐藏但不丢弃 */}
          {!manage && (
            <>
              {tab === 'main' && confirmBar}
              {errorBar}
            </>
          )}

          <div className="cz-sidebar__menu-sep" />
          <button
            type="button"
            className="cz-comp-entry cz-acct-manage"
            onClick={() => {
              close();
              setManage(true);
            }}
          >
            <span className="cz-sidebar__menu-icon"><Icon name="users" size={15} /></span>
            <span className="cz-sidebar__menu-name">管理账号</span>
            <Icon name="chevron-right" size={13} />
          </button>
          <ThemeSwitch />
        </div>
      )}

      <AccountCardLayer ctrl={card}>{cardBody}</AccountCardLayer>

      {manage && (
        <AccountManager
          data={data}
          agyData={agyData}
          error={error}
          quotas={quotas}
          kiroBalances={kiroBalances}
          now={now}
          version={version}
          switching={switching}
          agySwitching={agySwitching}
          covered={!!dialog}
          notice={notice}
          onClose={() => {
            setManage(false);
            setConfirm(null);
            setError(null);
          }}
          onAdd={add}
          onSwitch={(a) => {
            if (!switching && !a.active) void doSwitch(a.id);
          }}
          onRelogin={relogin}
          onEditApi={editApi}
          onRename={rename}
          onRemove={remove}
          onDedupe={async () => {
            const r = await api.dedupeAccounts();
            loadClaude();
            return r;
          }}
          onSwitchAgy={pickAgy}
          onReloginAgy={reloginAgy}
          onRenameAgy={renameAgy}
          onRemoveAgy={removeAgy}
          onDedupeAgy={async () => {
            const r = await api.dedupeAgyAccounts();
            loadAgy();
            return r;
          }}
        />
      )}

      {dialog?.kind === 'login' && (
        <AccountDialog relogin={dialog.relogin} resume={dialog.resume} onClose={closeDialog} onDone={onDialogDone} onSwitch={dialogSwitchClaude} />
      )}
      {dialog?.kind === 'api' && (
        <ApiAccountDialog edit={dialog.editApi} onClose={closeDialog} onDone={loadClaude} onSwitch={dialogSwitchClaude} />
      )}
      {dialog?.kind === 'kiro' && (
        <KiroAccountDialog relogin={dialog.relogin} resume={dialog.resume} onClose={closeDialog} onDone={onDialogDone} onSwitch={dialogSwitchClaude} />
      )}
      {dialog?.kind === 'agy' && (
        <AgyAccountDialog relogin={dialog.relogin} resume={dialog.resume} onClose={closeDialog} onDone={onDialogDone} onSwitch={dialogSwitchAgy} />
      )}
    </div>
  );
}
