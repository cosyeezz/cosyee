// 管理账号：居中对话框，按 Claude 订阅 / API / Kiro / Antigravity 分组，用卡片列出全部账号（包括没登录、登录已失效的）。
// 卡片上有全部信息（日期、全部额度和重置时间、主机名 / 邮箱、执行中的委派数）和操作（切换、重新登录、编辑、改名、移除）。
// 每组标题右侧的按钮直接添加这一类账号。Kiro 组下面是 kiro.rs 引擎的版本与更新入口。
// 状态和接口调用都在 AccountMenu 里，这里只负责展示和回调；kiro.rs 引擎状态自己读。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AccountDedupeResult, AccountEntry, AccountList, AgyAccountEntry, AgyAccountList, KiroStatus } from '@cosyee/shared';
import { api } from '../../core/api';
import { BrandIcon } from '../icons/BrandIcon';
import { Icon } from '../icons/Icon';
import { useMorph } from '../motion/morph';
import { loginExpiry, subscriptionEstimate } from '../usage/format';
import { ConfirmActionButton } from './ActionButtons';
import { AccountQuota, AgyQuotaView, KiroQuotaView, type KiroBalanceState, type QuotaState } from './AccountQuota';
import {
  agyRemoveBlock, agyTitle, apiHost, apiMapNote, claudeKind, claudeRemoveBlock, claudeUsable,
  DuplicateNote, entryTitle, msg, PlanChip, planChip, type ClaudeKind,
} from './accountParts';
import { useDismiss } from './useDismiss';
import { useFocusTrap } from './useFocusTrap';

export type AddDialogKind = 'login' | 'api' | 'kiro' | 'agy';

export interface AccountManagerProps {
  data: AccountList | null;
  agyData: AgyAccountList | null;
  error: string | null;
  quotas: Record<string, QuotaState>;
  kiroBalances: Record<string, KiroBalanceState>;
  now: number;
  /** 账号信息有变化时递增：重读 kiro.rs 引擎状态 */
  version: number;
  switching: string | null;
  agySwitching: string | null;
  /** 上面叠着添加 / 重新登录对话框：Esc、点外面、Tab 循环都让给它 */
  covered: boolean;
  /** 切换确认、错误提示等（放在标题下面） */
  notice?: ReactNode;
  onClose: () => void;
  onAdd: (kind: AddDialogKind) => void;
  onSwitch: (a: AccountEntry) => void;
  onRelogin: (a: AccountEntry) => void;
  onEditApi: (a: AccountEntry) => void;
  /** 保存备注名，成功返回 true */
  onRename: (a: AccountEntry, label: string) => Promise<boolean>;
  onRemove: (a: AccountEntry) => void;
  onDedupe: () => Promise<AccountDedupeResult>;
  onSwitchAgy: (a: AgyAccountEntry) => void;
  onReloginAgy: (a: AgyAccountEntry) => void;
  onRenameAgy: (a: AgyAccountEntry, label: string) => Promise<boolean>;
  onRemoveAgy: (a: AgyAccountEntry) => void;
  onDedupeAgy: () => Promise<AccountDedupeResult>;
}

const SECTIONS: { kind: ClaudeKind | 'agy'; title: string; tip: string; add: string; dialog: AddDialogKind; empty: string }[] = [
  { kind: 'claude', title: 'Claude 订阅', tip: 'claude.ai 订阅账号', add: '用 claude.ai 登录', dialog: 'login', empty: '还没有 Claude 订阅账号' },
  { kind: 'api', title: 'API', tip: '用 API Key 按量计费，可配置模型映射', add: '添加 API Key', dialog: 'api', empty: '还没有 API 账号' },
  { kind: 'kiro', title: 'Kiro', tip: '经 kiro.rs 代理使用 Kiro 额度', add: '登录 Kiro', dialog: 'kiro', empty: '还没有 Kiro 账号' },
  { kind: 'agy', title: 'Antigravity', tip: '委派任务用的账号：新的委派使用选中的账号，已有的委派继续用原来的账号', add: '登录 Antigravity', dialog: 'agy', empty: '还没有 Antigravity 账号' },
];

const REMOVE_NOTE: Record<ClaudeKind | 'agy', string> = {
  claude: '只删除该账号的登录信息；skill、设置和会话历史是共享的，不受影响',
  api: '会删除该账号保存的 API Key；skill、设置和会话历史是共享的，不受影响',
  kiro: '会删除该账号保存的 Kiro 凭据；skill、设置和会话历史是共享的，不受影响',
  agy: '会删除该账号的登录信息和它的委派会话记录',
};

/** 卡片里改备注名：Enter 保存，Esc 取消（通过 useDismiss 分层，不关外层面板） */
function RenameField({ initial, onSave, onCancel }: { initial: string; onSave: (v: string) => Promise<boolean>; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  useDismiss(true, boxRef, onCancel);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const save = async () => {
    if (busy) return;
    setBusy(true);
    const ok = await onSave(draft.trim());
    if (!ok) setBusy(false);
  };
  return (
    <div ref={boxRef} className="cz-acct-card__edit">
      <input
        ref={inputRef}
        className="cz-acct-card__input"
        aria-label="修改备注名"
        value={draft}
        maxLength={40}
        disabled={busy}
        placeholder="输入备注名"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void save();
          }
        }}
      />
      <button type="button" className="cz-acct-mgr__btn" aria-label="保存备注名" disabled={busy} onClick={() => void save()}>保存</button>
      <button type="button" className="cz-acct-mgr__btn" aria-label="取消修改" disabled={busy} onClick={onCancel}>取消</button>
    </div>
  );
}

interface CardProps {
  title: string;
  plan?: string | null;
  sub?: string;
  active: boolean;
  /** 不能直接使用（没登录 / 登录已失效） */
  off: boolean;
  badge?: { text: string; danger?: boolean } | null;
  meta?: ReactNode;
  quota?: ReactNode;
  /** 改备注名时替换名字那一块 */
  editing?: ReactNode;
  children: ReactNode;
}

function Card({ title, plan, sub, active, off, badge, meta, quota, editing, children }: CardProps) {
  return (
    <div className={`cz-acct-card${active ? ' is-active' : ''}${off ? ' is-off' : ''}`} aria-current={active ? 'true' : undefined}>
      <div className="cz-acct-card__top">
        {editing ?? (
          <div className="cz-acct-card__head">
            <div className="cz-acct-card__name">
              <b title={title}>{title}</b>
              <PlanChip plan={plan} />
            </div>
            {sub && <div className="cz-acct-card__sub" title={sub}>{sub}</div>}
          </div>
        )}
        {badge && !editing && <span className={`cz-acct-card__badge${badge.danger ? ' is-danger' : ''}`}>{badge.text}</span>}
      </div>
      {meta && <div className="cz-acct-card__meta">{meta}</div>}
      {quota}
      <div className="cz-acct-card__acts">{children}</div>
    </div>
  );
}

const shortCommit = (c: string) => (/^[0-9a-f]{40}$/i.test(c) ? c.slice(0, 7) : c);

/** kiro.rs 引擎：版本、已停止、有更新 / 更新 / 检查更新；更新进行中每秒读一次状态 */
function KiroEngineNote({ version }: { version: number }) {
  const [status, setStatus] = useState<KiroStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api.kiroStatus().then((s) => alive && setStatus(s), () => {});
    return () => { alive = false; };
  }, [version]);

  const running = status?.engine.build.state === 'running';
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.kiroStatus().then(
        (next) => {
          if (!alive) return;
          setStatus(next);
          if (next.engine.build.state === 'running') setTick((n) => n + 1);
        },
        () => alive && setTick((n) => n + 1),
      );
    }, 1000);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [running, tick]);

  const run = async (call: () => Promise<KiroStatus>, setBusy: (b: boolean) => void) => {
    setBusy(true);
    setErr(null);
    try {
      setStatus(await call());
    } catch (e) {
      setErr(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const commit = status?.engine.current?.commit;
  return (
    <div className="cz-acct-mgr__note cz-kiro-eng">
      <div className="cz-kiro-eng__line">
        <span className="cz-kiro-eng__ver">kiro.rs 引擎{commit ? ` ${shortCommit(commit)}` : ''}</span>
        {status && !status.service.enabled && <span className="cz-kiro-eng__badge">已停止</span>}
        {running ? (
          <span className="cz-kiro-eng__step" role="status">{status.engine.build.step ?? '正在更新…'}</span>
        ) : (
          <span className="cz-kiro-eng__acts">
            {status?.engine.updateAvailable && (
              <>
                <span className="cz-kiro-eng__badge" title={status.engine.latest?.title ?? undefined}>有更新</span>
                <button
                  type="button"
                  className="cz-acct-mgr__btn is-primary"
                  disabled={building || checking}
                  onClick={() => void run(api.kiroBuild, setBuilding)}
                >
                  {building ? '下载中…' : '更新'}
                </button>
              </>
            )}
            <button
              type="button"
              className="cz-acct-mgr__btn"
              disabled={checking || building}
              onClick={() => void run(api.kiroCheck, setChecking)}
            >
              {checking ? '检查中…' : '检查更新'}
            </button>
          </span>
        )}
      </div>
      {status && status.service.outdated > 0 && <div className="cz-kiro-eng__note">kiro.rs 服务重启后用新版</div>}
      {status?.engine.build.state === 'failed' && status.engine.build.error && (
        <div className="cz-kiro-eng__err" role="alert">{status.engine.build.error}</div>
      )}
      {err && <div className="cz-kiro-eng__err" role="alert">{err}</div>}
    </div>
  );
}

export function AccountManager(p: AccountManagerProps) {
  const { data, agyData, quotas, kiroBalances, now, switching, agySwitching, covered } = p;
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true });
  useFocusTrap(panelRef, !covered);
  const close = () => requestClose(p.onClose);
  useDismiss(!covered, panelRef, close);
  /** 正在改备注名的卡片：c:<id> 或 g:<id> */
  const [editing, setEditing] = useState<string | null>(null);

  const list = data?.list ?? [];
  const hasKiro = list.some((a) => !!a.kiro);

  const claudeCard = (a: AccountEntry) => {
    const kind = claudeKind(a);
    const title = entryTitle(a);
    const usable = claudeUsable(a, now);
    const sub = [
      a.label && a.label !== title ? a.label : null,
      a.api && apiHost(a.api.baseUrl) !== title ? apiHost(a.api.baseUrl) : null,
    ].filter(Boolean).join(' · ');
    const subEst = kind === 'claude' && a.loggedIn && a.plan ? subscriptionEstimate(a.subscribedAt, now) : null;
    const exp = kind === 'claude' && a.loggedIn ? loginExpiry(a.loginExpiresAt, now) : null;
    const badge = !a.loggedIn ? { text: '需要登录', danger: true }
      : !usable ? { text: '登录已失效', danger: true }
        : a.active ? { text: '当前' } : null;
    const meta = (
      <>
        {subEst && <span title={subEst.title}>{subEst.text}</span>}
        {exp && exp.tone !== 'danger' && <span className={exp.tone === 'warn' ? 'is-warn' : undefined}>{exp.text}</span>}
        {a.api && <span>{apiMapNote(a.api)}</span>}
        {a.kiro?.proxy === 'failed' && <span className="is-danger" role="status">代理异常：{a.kiro.error ?? '启动失败'}</span>}
      </>
    );
    const hasMeta = !!(subEst || (exp && exp.tone !== 'danger') || a.api || a.kiro?.proxy === 'failed');
    const quota = !usable ? null
      : kind === 'claude' ? <AccountQuota state={quotas[a.id] ?? { status: 'loading' }} now={now} />
        : kind === 'kiro' ? <KiroQuotaView state={kiroBalances[a.id] ?? { status: 'loading' }} now={now} />
          : null;
    const removeBlock = claudeRemoveBlock(a);
    const key = `c:${a.id}`;
    return (
      <Card
        key={a.id}
        title={title}
        plan={kind === 'kiro' && planChip(a.plan)?.toLowerCase() === 'kiro' ? null : a.plan}
        sub={sub}
        active={a.active}
        off={!usable}
        badge={badge}
        meta={hasMeta ? meta : null}
        quota={quota}
        editing={editing === key ? (
          <RenameField
            initial={a.label}
            onCancel={() => setEditing(null)}
            onSave={async (v) => {
              const ok = await p.onRename(a, v);
              if (ok) setEditing(null);
              return ok;
            }}
          />
        ) : null}
      >
        {!usable ? (
          kind !== 'api' && <button type="button" className="cz-acct-mgr__btn is-primary" onClick={() => p.onRelogin(a)}>重新登录</button>
        ) : !a.active && (
          <button type="button" className="cz-acct-mgr__btn" disabled={switching !== null} onClick={() => p.onSwitch(a)}>
            {switching === a.id ? '切换中…' : '切换'}
          </button>
        )}
        {a.api && <button type="button" className="cz-acct-mgr__btn" onClick={() => p.onEditApi(a)}>编辑</button>}
        {kind === 'kiro' && usable && <button type="button" className="cz-acct-mgr__btn" onClick={() => p.onRelogin(a)}>重新登录</button>}
        {!a.isDefault && !a.api && <button type="button" className="cz-acct-mgr__btn" onClick={() => setEditing(key)}>改名</button>}
        <ConfirmActionButton
          icon="trash"
          text="移除"
          className="cz-acct-mgr__btn is-danger"
          label={`移除账号「${title}」`}
          confirmText={`移除账号「${title}」？`}
          note={REMOVE_NOTE[kind]}
          confirmLabel="移除"
          disabled={removeBlock !== null}
          disabledTitle={removeBlock ?? undefined}
          onConfirm={() => p.onRemove(a)}
        />
      </Card>
    );
  };

  const agyCard = (a: AgyAccountEntry) => {
    const title = agyTitle(a);
    const off = a.loggedIn === false;
    const sub = [
      a.running > 0 ? `${a.running} 个委派执行中` : null,
      a.email && a.email !== title ? a.email : null,
      a.loggedIn === null ? '检测中…' : null,
    ].filter(Boolean).join(' · ');
    const badge = off ? { text: '需要登录', danger: true } : a.active ? { text: '当前' } : null;
    const removeBlock = agyRemoveBlock(a);
    const key = `g:${a.id}`;
    return (
      <Card
        key={a.id}
        title={title}
        plan={a.plan}
        sub={sub}
        active={a.active}
        off={off}
        badge={badge}
        quota={!off && a.quota && a.quota.groups.length > 0 ? <AgyQuotaView quota={a.quota} now={now} /> : null}
        editing={editing === key ? (
          <RenameField
            initial={a.label}
            onCancel={() => setEditing(null)}
            onSave={async (v) => {
              const ok = await p.onRenameAgy(a, v);
              if (ok) setEditing(null);
              return ok;
            }}
          />
        ) : null}
      >
        {off ? (
          <button type="button" className="cz-acct-mgr__btn is-primary" onClick={() => p.onReloginAgy(a)}>重新登录</button>
        ) : !a.active && (
          <button type="button" className="cz-acct-mgr__btn" disabled={agySwitching !== null} onClick={() => p.onSwitchAgy(a)}>
            {agySwitching === a.id ? '切换中…' : '切换'}
          </button>
        )}
        {!a.isDefault && <button type="button" className="cz-acct-mgr__btn" onClick={() => setEditing(key)}>改名</button>}
        <ConfirmActionButton
          icon="trash"
          text="移除"
          className="cz-acct-mgr__btn is-danger"
          label={`移除账号「${title}」`}
          confirmText={`移除账号「${title}」？`}
          note={REMOVE_NOTE.agy}
          confirmLabel="移除"
          disabled={removeBlock !== null}
          disabledTitle={removeBlock ?? undefined}
          onConfirm={() => p.onRemoveAgy(a)}
        />
      </Card>
    );
  };

  return createPortal(
    <div ref={scrimRef} className="cz-acct-dlg__scrim cz-modal-scrim">
      <div ref={panelRef} className="cz-acct-mgr cz-modal" role="dialog" aria-modal="true" aria-label="管理账号">
        <div className="cz-acct-mgr__head">
          <h2 className="cz-acct-mgr__title">管理账号</h2>
          <button type="button" className="cz-acct-mgr__x" aria-label="关闭" title="关闭" onClick={close}>
            <Icon name="close" size={14} />
          </button>
        </div>
        {p.notice}
        {data === null && !p.error && <div className="cz-acct-mgr__empty">正在读取…</div>}
        {SECTIONS.map((s) => {
          if (s.kind === 'agy') {
            if (agyData === null) return null;
            const rows = agyData.list;
            return (
              <section key={s.kind} className="cz-acct-mgr__sec" aria-label={s.title}>
                <div className="cz-acct-mgr__sec-head">
                  <h3><BrandIcon kind={s.kind} size={15} />{s.title}</h3>
                  {agyData.installed && <span className="cz-acct-mgr__count">{rows.length}</span>}
                  <span className="cz-acct-mgr__tip" title={s.tip}>{agyData.installed ? s.tip : '没有安装 Antigravity CLI'}</span>
                  {agyData.installed && (
                    <button type="button" className="cz-acct-mgr__add" onClick={() => p.onAdd(s.dialog)}>
                      <Icon name="plus" size={12} />{s.add}
                    </button>
                  )}
                </div>
                {agyData.installed && (rows.length
                  ? <div className="cz-acct-mgr__cards">{rows.map(agyCard)}</div>
                  : <div className="cz-acct-mgr__empty">{s.empty}</div>)}
                {agyData.installed && <DuplicateNote count={agyData.duplicates ?? 0} onClean={p.onDedupeAgy} />}
              </section>
            );
          }
          if (data === null) return null;
          const rows = list.filter((a) => claudeKind(a) === s.kind);
          return (
            <section key={s.kind} className="cz-acct-mgr__sec" aria-label={s.title}>
              <div className="cz-acct-mgr__sec-head">
                <h3><BrandIcon kind={s.kind} size={15} />{s.title}</h3>
                <span className="cz-acct-mgr__count">{rows.length}</span>
                <span className="cz-acct-mgr__tip" title={s.tip}>{s.tip}</span>
                <button type="button" className="cz-acct-mgr__add" onClick={() => p.onAdd(s.dialog)}>
                  <Icon name="plus" size={12} />{s.add}
                </button>
              </div>
              {rows.length
                ? <div className="cz-acct-mgr__cards">{rows.map(claudeCard)}</div>
                : <div className="cz-acct-mgr__empty">{s.empty}</div>}
              {s.kind === 'claude' && <DuplicateNote count={data.duplicates ?? 0} onClean={p.onDedupe} />}
              {s.kind === 'kiro' && hasKiro && <KiroEngineNote version={p.version} />}
            </section>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}
