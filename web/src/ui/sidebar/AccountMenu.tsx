// 左下角账户栏 + 账号弹层（向上弹出）。弹层只负责切换和展示：
// - 顶部是模式切换（切换模式 / 并行模式，说明在悬停提示里）；
// - 已登录的账号按 Claude 订阅 / API / Kiro / Antigravity 分组（组名前是各家官方图标），每个账号一行名字 + 一条最先重置的额度「5h ━━━ 94%」，
//   悬停显示详情卡（AccountCard）；
//   没登录、登录已失效的账号不在这里出现，到「管理账号」里重新登录；
// - 底部是「管理账号」（AccountManager：全部账号的卡片、添加、编辑、改名、移除、清理重复、kiro.rs 引擎）、外观。
// Claude 类账号：切换模式下换账号整页刷新（有执行中的会话时可强制切换）；并行模式只换新会话用的账号，不刷新。
// Antigravity：委派任务用的账号，切换不刷新页面、不关弹层。
// 状态和接口调用都在这里，弹层和管理面板共用。
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { Account, AccountApiInfo, AccountEntry, AccountList, AccountLogin, AgyAccountEntry, AgyAccountList } from '@cosyee/shared';
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
  ActiveMark, agyTitle, Avatar, claudeKind, claudeUsable, entryTitle, loginPending, msg, PlanChip, planChip, type ClaudeKind,
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

const GROUPS: { kind: ClaudeKind | 'agy'; title: string; tip: string }[] = [
  { kind: 'claude', title: 'Claude 订阅', tip: 'claude.ai 订阅账号' },
  { kind: 'api', title: 'API', tip: '用 API Key 按量计费' },
  { kind: 'kiro', title: 'Kiro', tip: '经 kiro.rs 代理使用 Kiro 额度' },
  { kind: 'agy', title: 'Antigravity', tip: '委派任务用的账号：新的委派使用选中的账号，已有的委派继续用原来的账号' },
];

/** 弹层里的一个账号：名字 + 套餐、选中勾 / 切换中，下面一条最近额度 */
function PickRow({
  title, plan, active, busy, disabled, quota, card, onPick,
}: {
  title: string;
  plan?: string | null;
  active: boolean;
  busy: boolean;
  disabled: boolean;
  quota: ReactNode;
  /** 悬浮详情卡的事件绑定 */
  card: ReturnType<ReturnType<typeof useAccountCard>['bind']>;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      className={`cz-acct-pick${active ? ' is-active' : ''}`}
      aria-current={active ? 'true' : undefined}
      disabled={disabled}
      {...card}
      onClick={onPick}
    >
      <span className="cz-acct-pick__name">
        <b>{title}</b>
        <PlanChip plan={plan} tip={false} />
      </span>
      {busy ? <span className="cz-sidebar__acct-tag">切换中…</span> : active ? <ActiveMark /> : <span />}
      {quota}
    </button>
  );
}

export function AccountMenu({ account, version = 0 }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  /** 管理账号面板 */
  const [manage, setManage] = useState(false);
  const [data, setData] = useState<AccountList | null>(null);
  const [agyData, setAgyData] = useState<AgyAccountList | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 切换被执行中的会话拦下：等用户决定是否强制切换 */
  const [confirm, setConfirm] = useState<{ id: string; running: number } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [agySwitching, setAgySwitching] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  /** 弹层或管理面板开着时每分钟推进一次，驱动额度重置倒计时与到期提示刷新 */
  const [now, setNow] = useState(() => Date.now());
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // 关闭时留着播完退场（.cz-pop），退场途中再打开会从当前状态接回去
  const { mounted, leaving } = usePresence(open, menuRef);
  const shown = open || manage;
  const card = useAccountCard(open && !manage && !dialog);

  const close = useCallback(() => {
    setOpen(false);
    setConfirm(null);
    setError(null);
  }, []);
  useDismiss(open && !dialog && !manage, wrapRef, close);

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
      if (parallel) {
        setSwitching(null);
        loadClaude();
        if (!manage) close();
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
    if (a.active) {
      close();
      return;
    }
    void doSwitch(a.id);
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
  const notice = (
    <>
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

  const usableAgy = agyData?.installed ? agyList.filter((a) => a.loggedIn === true) : [];
  const groupRows = GROUPS.map((g) => {
    if (g.kind === 'agy') {
      return {
        g,
        rows: usableAgy.map((a) => {
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
        }),
      };
    }
    return {
      g,
      rows: list
        .filter((a) => claudeKind(a) === g.kind && claudeUsable(a, now))
        .map((a) => (
          <PickRow
            key={a.id}
            title={entryTitle(a)}
            plan={g.kind === 'kiro' && planChip(a.plan)?.toLowerCase() === 'kiro' ? null : a.plan}
            active={a.active}
            busy={switching === a.id}
            disabled={switching !== null && switching !== a.id}
            quota={claudeBrief(a, g.kind as ClaudeKind)}
            card={card.bind(`c:${a.id}`)}
            onPick={() => pick(a)}
          />
        )),
    };
  }).filter((x) => x.rows.length > 0);

  // 悬浮详情卡的内容：从最新列表里取，额度读回来后跟着更新；账号不在了就不显示
  const cardClaude = list.find((a) => `c:${a.id}` === card.hover.key);
  const cardAgy = usableAgy.find((a) => `g:${a.id}` === card.hover.key);
  const cardBody = cardClaude ? (
    <ClaudeCardBody a={cardClaude} quota={quotas[cardClaude.id]} balance={kiroBalances[cardClaude.id]} parallel={parallel} now={now} />
  ) : cardAgy ? <AgyCardBody a={cardAgy} now={now} /> : null;

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
          <AccountModeSwitch mode={data?.mode ?? null} onChanged={loadClaude} />
          <div className="cz-sidebar__menu-list">
            {data === null && !error && <div className="cz-acct-pick-empty">正在读取…</div>}
            {groupRows.map(({ g, rows }) => (
              <div key={g.kind} className="cz-acct-pick-sec" role="group" aria-label={g.title}>
                <div className="cz-acct-pick-grp" title={g.tip}><BrandIcon kind={g.kind} size={13} />{g.title}</div>
                {rows}
              </div>
            ))}
          </div>
          {!manage && notice}

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
