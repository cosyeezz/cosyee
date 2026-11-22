// 左下角账户栏 + 账号切换菜单（向上弹出）。菜单顶部（第一个账号上方）是模式切换（AccountModeSwitch）。
// 切换模式：点击一行切换到该账号（成功后整页刷新，保证页面上所有信息都来自新账号）；有执行中的会话时先提示，可以强制切换。
// 并行模式：点击一行只是选择「新会话用哪个账号」，不停止任何会话、不刷新页面（已有会话继续用各自的账号）。
// 没有登录凭据的账号点击后重新登录；添加的账号（非默认、非当前）悬停可移除。
// 只显示名字、套餐和备注名，不显示邮箱。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, AccountApiInfo, AccountEntry, AccountList, AccountLogin } from '@cosyee/shared';
import { api, ApiError } from '../../core/api';
import { Icon } from '../icons/Icon';
import { ActionButton, ConfirmActionButton } from './ActionButtons';
import { AccountDialog } from './AccountDialog';
import { ApiAccountDialog } from './ApiAccountDialog';
import { AccountModeSwitch } from './AccountModeSwitch';
import { AccountQuota, type QuotaState } from './AccountQuota';
import { ThemeSwitch } from './ThemeSwitch';
import { avatarColor, avatarInitial } from './avatar';
import { useDismiss } from './useDismiss';

export interface AccountMenuProps {
  account: Account | null;
  /** 账号信息有变化但没有整页刷新时递增：菜单开着就重读列表 */
  version?: number;
}

interface DialogState {
  /** login = claude.ai 登录（添加 / 重新登录）；api = 添加 / 修改 API 账号 */
  kind: 'login' | 'api';
  relogin?: { id: string; title: string; active: boolean };
  resume: AccountLogin | null;
  /** 修改的 API 账号 */
  editApi?: { id: string; label: string; title: string; api: AccountApiInfo };
  /** 在添加对话框里切换了方式：换一个组件挂载，但不要再播一遍入场 */
  switched?: boolean;
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

/** 整页刷新（单独放一个对象里，测试可以替换） */
export const accountPage = { reload: () => window.location.reload() };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 行标题：显示名，读不到时用备注名；都没有就叫「Claude 账号」（没登录的叫「未登录账号」） */
export function entryTitle(a: AccountEntry): string {
  return a.name ?? (a.label || (a.loggedIn ? 'Claude 账号' : '未登录账号'));
}

/** 行副标题：备注名 · 套餐 · 需要登录；API 账号：API · 主机名 */
export function entrySubtitle(a: AccountEntry): string {
  const parts: string[] = [];
  if (a.label && a.label !== entryTitle(a)) parts.push(a.label);
  if (a.plan) parts.push(a.plan);
  if (a.api) {
    const host = apiHost(a.api.baseUrl);
    if (host !== entryTitle(a)) parts.push(host);
  }
  if (!a.loggedIn) parts.push('需要登录');
  return parts.join(' · ');
}

export function AccountMenu({ account, version = 0 }: AccountMenuProps) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AccountList | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 切换被执行中的会话拦下：等用户决定是否强制切换 */
  const [confirm, setConfirm] = useState<{ id: string; running: number } | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    setConfirm(null);
    setError(null);
  }, []);
  useDismiss(open && !dialog, wrapRef, close);

  const load = useCallback(() => {
    api.accounts().then(setData, (e) => setError(msg(e)));
  }, []);
  useEffect(() => {
    if (open) load();
  }, [open, load, version]);
  const parallel = data?.mode === 'parallel';

  /** 每个已登录账号的额度：菜单打开时并行读取（服务端各账号各自缓存），读不到只显示一行淡提示，不影响切换 */
  const [quotas, setQuotas] = useState<Record<string, QuotaState>>({});
  // API 账号按量计费，没有订阅额度
  const quotaIds = (data?.list ?? []).filter((a) => a.loggedIn && !a.api).map((a) => a.id).join(',');
  useEffect(() => {
    if (!open || !quotaIds) return;
    let alive = true;
    for (const id of quotaIds.split(',')) {
      api.usage(false, null, id).then(
        (info) => alive && setQuotas((q) => ({ ...q, [id]: info && info.limits.length ? { status: 'ok', info } : { status: 'none' } })),
        () => alive && setQuotas((q) => ({ ...q, [id]: q[id]?.status === 'ok' ? q[id]! : { status: 'fail' } })),
      );
    }
    return () => { alive = false; };
  }, [open, quotaIds]);

  const doSwitch = async (id: string, force = false) => {
    setError(null);
    setConfirm(null);
    setSwitching(id);
    try {
      await api.switchAccount(id, force);
      if (parallel) {
        // 并行模式：后端只换了「新会话用的账号」，账户栏由 account.changed 消息刷新
        setSwitching(null);
        load();
        close();
      } else accountPage.reload();
    } catch (e) {
      setSwitching(null);
      if (e instanceof ApiError && e.status === 409 && typeof e.data.running === 'number') {
        setConfirm({ id, running: e.data.running });
      } else setError(msg(e));
    }
  };

  const pick = (a: AccountEntry) => {
    if (switching) return;
    if (!a.loggedIn) {
      openDialog({ kind: 'login', relogin: { id: a.id, title: entryTitle(a), active: a.active }, resume: null });
      return;
    }
    if (a.active) {
      close();
      return;
    }
    void doSwitch(a.id);
  };

  const add = () => {
    const l = data?.login ?? null;
    openDialog({ kind: 'login', resume: l && (l.status === 'starting' || l.status === 'waiting') ? l : null });
  };

  const editApi = (a: AccountEntry) => {
    if (!a.api) return;
    openDialog({ kind: 'api', resume: null, editApi: { id: a.id, label: a.label, title: entryTitle(a), api: a.api } });
  };

  /** 添加账号对话框里切换方式（还没开始登录时） */
  const switchAddKind = (kind: 'login' | 'api') => setDialog({ kind, resume: null, switched: true });

  const remove = (id: string) => {
    setError(null);
    api.removeAccount(id).then(load, (e) => setError(msg(e)));
  };

  /** 这次对话框里登录成功了（当前账号重新登录成功后要刷新整页，名字 / 套餐可能变了） */
  const loginDone = useRef(false);
  const onDialogDone = useCallback(() => {
    loginDone.current = true;
    load();
  }, [load]);

  const openDialog = (d: DialogState) => {
    loginDone.current = false;
    setDialog(d);
  };

  const closeDialog = () => {
    const reload = !!dialog?.relogin?.active && loginDone.current;
    setDialog(null);
    if (reload) accountPage.reload();
    else load();
  };

  const dialogSwitch = (id: string) => {
    setDialog(null);
    setOpen(true);
    void doSwitch(id);
  };

  const list = data?.list ?? [];
  const confirmEntry = confirm ? list.find((a) => a.id === confirm.id) : undefined;
  const confirmName = confirmEntry ? entryTitle(confirmEntry) : '该账号';

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
            <span className="cz-sidebar__avatar" style={{ background: avatarColor(account.name) }}>
              {avatarInitial(account.name)}
            </span>
            <span className="cz-sidebar__account-text">
              {account.name}
              {account.plan ? ` · ${account.plan}` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="cz-sidebar__avatar cz-sidebar__avatar--empty">?</span>
            <span className="cz-sidebar__account-text cz-sidebar__account-text--muted">未登录</span>
          </>
        )}
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>

      {open && (
        <div className="cz-sidebar__menu cz-sidebar__menu--up" role="group" aria-label="账号">
          <AccountModeSwitch mode={data?.mode ?? null} onChanged={load} />
          <div className="cz-sidebar__menu-list">
            {parallel && <div className="cz-sidebar__acct-note">并行模式：选择新会话使用的账号，已有会话继续用各自的账号</div>}
            {data === null && !error && <div className="cz-sidebar__acct-note">正在读取…</div>}
            {list.map((a) => {
              const title = entryTitle(a);
              const sub = entrySubtitle(a);
              const removable = !a.isDefault && !a.active;
              const editable = !!a.api;
              return (
                <div
                  key={a.id}
                  className={`cz-sidebar__menu-item${a.active ? ' is-active' : ''}${removable || editable ? ' has-actions' : ''}`}
                >
                  <button
                    type="button"
                    className="cz-sidebar__menu-main"
                    aria-current={a.active ? 'true' : undefined}
                    disabled={switching !== null}
                    onClick={() => pick(a)}
                  >
                    <span
                      className={`cz-sidebar__avatar cz-sidebar__avatar--sm${a.loggedIn ? '' : ' cz-sidebar__avatar--empty'}`}
                      style={a.loggedIn ? { background: avatarColor(title) } : undefined}
                    >
                      {a.loggedIn ? avatarInitial(title) : '?'}
                    </span>
                    <span className="cz-sidebar__menu-text">
                      <span className="cz-sidebar__menu-name">{title}</span>
                      {sub && <span className="cz-sidebar__menu-path">{sub}</span>}
                      {a.loggedIn && !a.api && <AccountQuota state={quotas[a.id] ?? { status: 'loading' }} />}
                    </span>
                    {switching === a.id ? (
                      <span className="cz-sidebar__acct-tag">切换中…</span>
                    ) : a.active ? (
                      <span className="cz-sidebar__acct-check"><Icon name="check" size={14} /></span>
                    ) : null}
                  </button>
                  {(removable || editable) && (
                    <div className="cz-sidebar__actions">
                      {editable && <ActionButton icon="pencil" label="修改 API 账号" onClick={() => editApi(a)} />}
                      {removable && (
                        <ConfirmActionButton
                          icon="trash"
                          label="移除账号"
                          confirmText={`移除账号「${title}」？`}
                          note={
                            a.api
                              ? '会删除该账号保存的 API Key；skill、设置和会话历史是共享的，不受影响'
                              : '只删除该账号的登录信息；skill、设置和会话历史是共享的，不受影响'
                          }
                          confirmLabel="移除"
                          onConfirm={() => remove(a.id)}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
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
          <div className="cz-sidebar__menu-item">
            <button type="button" className="cz-sidebar__menu-main" disabled={switching !== null} onClick={add}>
              <span className="cz-sidebar__menu-icon"><Icon name="plus" size={16} /></span>
              <span className="cz-sidebar__menu-text">
                <span className="cz-sidebar__menu-name">
                  {data?.login && (data.login.status === 'starting' || data.login.status === 'waiting') ? '继续登录…' : '添加账号'}
                </span>
              </span>
            </button>
          </div>
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
          onSwitch={dialogSwitch}
          onUseApi={dialog.relogin || dialog.resume ? undefined : () => switchAddKind('api')}
          enter={!dialog.switched}
        />
      )}
      {dialog?.kind === 'api' && (
        <ApiAccountDialog
          edit={dialog.editApi}
          onClose={closeDialog}
          onDone={load}
          onSwitch={dialogSwitch}
          onUseLogin={dialog.editApi ? undefined : () => switchAddKind('login')}
          enter={!dialog.switched}
        />
      )}
    </div>
  );
}
