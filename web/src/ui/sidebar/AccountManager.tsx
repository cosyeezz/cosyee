// 管理账号：居中对话框，按 Claude 订阅 / API / Kiro / Antigravity 分组，用卡片列出全部账号（包括没登录、登录已失效的）。
// 卡片上有全部信息（日期、全部额度和重置时间、主机名 / 邮箱、执行中的委派数）和操作（切换、重新登录、编辑、改名、移除）。
// 每组标题右侧的按钮直接添加这一类账号。Kiro 组下面是 kiro.rs 引擎的版本与更新入口。
// 状态和接口调用都在 AccountMenu 里，这里只负责展示和回调；kiro.rs 引擎状态自己读。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AccountDedupeResult, AccountEntry, AccountList, AgyAccountEntry, AgyAccountList, CodexAccountEntry, CodexAccountList, ComponentStatus } from '@cosyee/shared';
import { api } from '../../core/api';
import { BrandIcon } from '../icons/BrandIcon';
import { Icon } from '../icons/Icon';
import { LedgerPanel, type LedgerTarget } from '../ledger/LedgerPanel';
import { useMorph } from '../motion/morph';
import { loginExpiry, subscriptionEstimate } from '../usage/format';
import { ConfirmActionButton } from './ActionButtons';
import { AccountQuota, AgyQuotaView, CodexQuotaView, codexWindows, KiroQuotaView, type KiroBalanceState, type QuotaState } from './AccountQuota';
import {
  agyRemoveBlock, agyTitle, apiHost, apiMapNote, claudeKind, claudeRemoveBlock, claudeUsable,
  codexPlan, codexRemoveBlock, codexTitle, DuplicateNote, entryTitle, kiroIssue, msg, PlanChip, planChip, type ClaudeKind,
} from './accountParts';
import { useDismiss } from './useDismiss';
import { useFocusTrap } from './useFocusTrap';

/** 某一类账号的重复条目数；旧服务端没有分类时全部算在订阅账号上 */
function dupCount(data: AccountList, kind: ClaudeKind): number {
  if (data.duplicateKinds) return data.duplicateKinds[kind] ?? 0;
  return kind === 'claude' ? data.duplicates ?? 0 : 0;
}

export type AddDialogKind = 'login' | 'api' | 'kiro' | 'agy' | 'codex';

export interface AccountManagerProps {
  data: AccountList | null;
  agyData: AgyAccountList | null;
  codexData?: CodexAccountList | null;
  error: string | null;
  quotas: Record<string, QuotaState>;
  kiroBalances: Record<string, KiroBalanceState>;
  now: number;
  /** 账号信息有变化时递增：重读 kiro.rs 引擎状态 */
  version: number;
  switching: string | null;
  agySwitching: string | null;
  codexSwitching?: string | null;
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
  onSwitchCodex?: (a: CodexAccountEntry) => void;
  onReloginCodex?: (a: CodexAccountEntry) => void;
  onRenameCodex?: (a: CodexAccountEntry, label: string) => Promise<boolean>;
  onRemoveCodex?: (a: CodexAccountEntry) => void;
  onDedupeCodex?: () => Promise<AccountDedupeResult>;
}

const SECTIONS: { kind: ClaudeKind | 'agy' | 'codex'; title: string; tip: string; add: string; dialog: AddDialogKind; empty: string }[] = [
  { kind: 'claude', title: 'Claude 订阅', tip: 'claude.ai 订阅账号', add: '用 claude.ai 登录', dialog: 'login', empty: '还没有 Claude 订阅账号' },
  { kind: 'api', title: 'API', tip: '用 API Key 按量计费，可配置模型映射', add: '添加 API Key', dialog: 'api', empty: '还没有 API 账号' },
  { kind: 'kiro', title: 'Kiro', tip: '经 kiro.rs 代理使用 Kiro 额度', add: '登录 Kiro', dialog: 'kiro', empty: '还没有 Kiro 账号' },
  { kind: 'agy', title: 'Antigravity', tip: '委派任务用的账号：新的委派使用选中的账号，已有的委派继续用原来的账号', add: '登录 Antigravity', dialog: 'agy', empty: '' },
  { kind: 'codex', title: 'Codex', tip: '委派任务用的 OpenAI Codex 账号：新的委派使用选中的账号，已有的委派继续用原来的账号', add: '登录 Codex', dialog: 'codex', empty: '' },
];

const REMOVE_NOTE: Record<ClaudeKind | 'agy' | 'codex', string> = {
  claude: '只删除该账号的登录信息；skill、设置和会话历史是共享的，不受影响',
  api: '会删除该账号保存的 API Key；skill、设置和会话历史是共享的，不受影响',
  kiro: '会删除该账号保存的 Kiro 凭据；skill、设置和会话历史是共享的，不受影响',
  agy: '会删除该账号的登录信息和它的委派会话记录',
  codex: '会删除该账号的登录信息和它的委派会话记录',
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
  /** 红色问题标签（Kiro 额度用完 / 已停用） */
  issue?: string | null;
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

function Card({ title, plan, issue, sub, active, off, badge, meta, quota, editing, children }: CardProps) {
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
        {/* 右上角的状态徽标：问题标签放最后，同一组卡片里都贴着右边 */}
        {!editing && (badge || issue) && (
          <span className="cz-acct-card__badges">
            {badge && <span className={`cz-acct-card__badge${badge.danger ? ' is-danger' : ''}`}>{badge.text}</span>}
            {issue && <span className="cz-acct-card__badge is-danger">{issue}</span>}
          </span>
        )}
      </div>
      {meta && <div className="cz-acct-card__meta">{meta}</div>}
      {quota}
      <div className="cz-acct-card__acts">{children}</div>
    </div>
  );
}

const shortCommit = (c: string) => (/^[0-9a-f]{40}$/i.test(c) ? c.slice(0, 7) : c);

const SERVICE_TEXT: Record<NonNullable<ComponentStatus['service']>['state'], string> = {
  stopped: '已停止',
  starting: '启动中',
  ready: '运行中',
  failed: '启动失败',
};

/** kiro.rs 组件的一行状态：版本 · 服务状态 · 可用账号数；没装时给「安装」按钮，安装中每秒读一次状态。更新、启停在桌面客户端的组件页 */
function KiroEngineNote({ version }: { version: number }) {
  const [comp, setComp] = useState<ComponentStatus | null>(null);
  const [installing, setInstalling] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const load = () => api.components().then((l) => l.list.find((c) => c.id === 'kiro') ?? null);

  useEffect(() => {
    let alive = true;
    load().then((c) => alive && setComp(c), () => {});
    return () => { alive = false; };
  }, [version]);

  const running = comp?.job?.state === 'running';
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const t = window.setTimeout(() => {
      load().then(
        (c) => {
          if (!alive) return;
          setComp(c);
          if (c?.job?.state === 'running') setTick((n) => n + 1);
        },
        () => alive && setTick((n) => n + 1),
      );
    }, 1000);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [running, tick]);

  const install = async () => {
    setInstalling(true);
    setErr(null);
    try {
      setComp(await api.updateComponent('kiro'));
    } catch (e) {
      setErr(msg(e));
    } finally {
      setInstalling(false);
    }
  };

  if (!comp) return null;
  const svc = comp.service;
  const parts: string[] = [];
  if (svc) {
    parts.push(svc.state === 'stopped' && !svc.enabled ? '已手动停止' : SERVICE_TEXT[svc.state]);
    if (svc.state === 'ready' && svc.accounts.total > 0) parts.push(`${svc.accounts.usable}/${svc.accounts.total} 账号可用`);
    if (svc.outdated) parts.push('重启后用新版');
  }
  const short = svc && svc.state === 'ready' && svc.accounts.usable < svc.accounts.total;
  return (
    <div className="cz-acct-mgr__note cz-kiro-eng">
      <div className="cz-kiro-eng__line">
        <span className="cz-kiro-eng__ver">kiro.rs{comp.version ? ` ${shortCommit(comp.version)}` : ''}</span>
        {!comp.installed ? (
          running ? (
            <span className="cz-kiro-eng__step" role="status">正在安装…</span>
          ) : (
            <span className="cz-kiro-eng__acts">
              <span className="cz-kiro-eng__badge">未安装</span>
              <button type="button" className="cz-acct-mgr__btn is-primary" disabled={installing} onClick={() => void install()}>
                {installing ? '安装中…' : '安装'}
              </button>
            </span>
          )
        ) : (
          parts.length > 0 && (
            <span className={`cz-kiro-eng__step${short ? ' is-warn' : ''}`} role="status" title={svc?.error ?? undefined}>
              {parts.join(' · ')}
            </span>
          )
        )}
      </div>
      {svc?.state === 'failed' && svc.error && <div className="cz-kiro-eng__err" role="alert">{svc.error}</div>}
      {comp.job?.state === 'failed' && comp.job.error && <div className="cz-kiro-eng__err" role="alert">{comp.job.error}</div>}
      {err && <div className="cz-kiro-eng__err" role="alert">{err}</div>}
    </div>
  );
}

export function AccountManager(p: AccountManagerProps) {
  const { data, agyData, codexData = null, quotas, kiroBalances, now, switching, agySwitching, codexSwitching = null, covered } = p;
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true });
  /** 正在查看用量统计的账号 */
  const [ledgerTarget, setLedgerTarget] = useState<LedgerTarget | null>(null);
  const modalCovered = covered || ledgerTarget !== null;
  useFocusTrap(panelRef, !modalCovered);
  const close = () => requestClose(p.onClose);
  useDismiss(!modalCovered, panelRef, close);
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
      a.kiro?.email && a.kiro.email !== title ? a.kiro.email : null,
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
        issue={kiroIssue(a)}
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
        <button
          type="button"
          className="cz-acct-mgr__btn cz-acct-mgr__btn--ico"
          aria-label={`查看「${title}」用量统计`}
          title="查看用量统计"
          onClick={() => setLedgerTarget({
            backend: 'claude',
            account: a.id,
            accountName: title,
            brand: kind,
            plan: kind === 'kiro' && planChip(a.plan)?.toLowerCase() === 'kiro' ? null : a.plan,
          })}
        >
          <Icon name="chart" size={11} />
          用量
        </button>
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
        quota={!off && a.quota && a.quota.groups.length > 0 ? <AgyQuotaView quota={a.quota} now={now} showUpdated /> : null}
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
        <button type="button" className="cz-acct-mgr__btn" onClick={() => setEditing(key)}>改名</button>
        <button
          type="button"
          className="cz-acct-mgr__btn cz-acct-mgr__btn--ico"
          aria-label={`查看「${title}」用量统计`}
          title="查看用量统计"
          onClick={() => setLedgerTarget({
            backend: 'agy',
            account: a.id,
            accountName: title,
            brand: 'agy',
            plan: a.plan,
          })}
        >
          <Icon name="chart" size={11} />
          用量
        </button>
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

  const codexCard = (a: CodexAccountEntry) => {
    const title = codexTitle(a);
    const plan = codexPlan(a);
    const off = a.loggedIn === false;
    const sub = [
      a.running > 0 ? `${a.running} 个委派执行中` : null,
      a.email && a.email !== title ? a.email : null,
      a.loggedIn === null ? '正在检测…' : null,
    ].filter(Boolean).join(' · ');
    const badge = off ? { text: '需要登录', danger: true } : a.active ? { text: '当前' } : null;
    const meta = !off && a.authMode === 'apiKey' ? <span>按量计费（API Key）</span> : null;
    const quota = !off && a.authMode !== 'apiKey' && a.quota && codexWindows(a.quota).length > 0
      ? <CodexQuotaView quota={a.quota} now={now} />
      : null;
    const removeBlock = codexRemoveBlock(a);
    const key = `x:${a.id}`;
    return (
      <Card
        key={a.id}
        title={title}
        plan={plan}
        sub={sub}
        active={a.active}
        off={off}
        badge={badge}
        meta={meta}
        quota={quota}
        editing={editing === key ? (
          <RenameField
            initial={a.label}
            onCancel={() => setEditing(null)}
            onSave={async (v) => {
              const ok = await (p.onRenameCodex?.(a, v) ?? Promise.resolve(false));
              if (ok) setEditing(null);
              return ok;
            }}
          />
        ) : null}
      >
        {off ? (
          <button type="button" className="cz-acct-mgr__btn is-primary" onClick={() => p.onReloginCodex?.(a)}>重新登录</button>
        ) : !a.active && a.loggedIn === true && (
          <button type="button" className="cz-acct-mgr__btn" disabled={codexSwitching !== null} onClick={() => p.onSwitchCodex?.(a)}>
            {codexSwitching === a.id ? '切换中…' : '切换'}
          </button>
        )}
        {!a.isDefault && <button type="button" className="cz-acct-mgr__btn" onClick={() => setEditing(key)}>改名</button>}
        <button
          type="button"
          className="cz-acct-mgr__btn cz-acct-mgr__btn--ico"
          aria-label={`查看「${title}」用量统计`}
          title="查看用量统计"
          onClick={() => setLedgerTarget({
            backend: 'codex',
            account: a.id,
            accountName: title,
            brand: 'codex',
            plan,
          })}
        >
          <Icon name="chart" size={11} />
          用量
        </button>
        <ConfirmActionButton
          icon="trash"
          text="移除"
          className="cz-acct-mgr__btn is-danger"
          label={`移除账号「${title}」`}
          confirmText={`移除账号「${title}」？`}
          note={REMOVE_NOTE.codex}
          confirmLabel="移除"
          disabled={removeBlock !== null}
          disabledTitle={removeBlock ?? undefined}
          onConfirm={() => p.onRemoveCodex?.(a)}
        />
      </Card>
    );
  };

  return (
    <>
      {createPortal(
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
                {/* 没有账号时下面留空，不提示去登录 */}
                {agyData.installed && rows.length > 0 && <div className="cz-acct-mgr__cards">{rows.map(agyCard)}</div>}
                {agyData.installed && <DuplicateNote count={agyData.duplicates ?? 0} onClean={p.onDedupeAgy} />}
              </section>
            );
          }
          if (s.kind === 'codex') {
            if (codexData === null) return null;
            const rows = codexData.list;
            return (
              <section key={s.kind} className="cz-acct-mgr__sec" aria-label={s.title}>
                <div className="cz-acct-mgr__sec-head">
                  <h3><BrandIcon kind={s.kind} size={15} />{s.title}</h3>
                  {codexData.installed && <span className="cz-acct-mgr__count">{rows.length}</span>}
                  <span className="cz-acct-mgr__tip" title={s.tip}>{codexData.installed ? s.tip : '没有安装 Codex CLI'}</span>
                  {codexData.installed && (
                    <button type="button" className="cz-acct-mgr__add" onClick={() => p.onAdd(s.dialog)}>
                      <Icon name="plus" size={12} />{s.add}
                    </button>
                  )}
                </div>
                {codexData.installed && rows.length > 0 && <div className="cz-acct-mgr__cards">{rows.map(codexCard)}</div>}
                {codexData.installed && p.onDedupeCodex && <DuplicateNote count={codexData.duplicates ?? 0} onClean={p.onDedupeCodex} />}
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
              <DuplicateNote count={dupCount(data, s.kind)} onClean={p.onDedupe} />
              {s.kind === 'kiro' && hasKiro && <KiroEngineNote version={p.version} />}
            </section>
          );
        })}
          </div>
        </div>,
        document.body,
      )}
      {ledgerTarget && (
        <LedgerPanel target={ledgerTarget} onClose={() => setLedgerTarget(null)} />
      )}
    </>
  );
}
