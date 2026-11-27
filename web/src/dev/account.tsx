// 账号菜单 + API 账号对话框（模型映射）+ Antigravity 多账号调试页：http://127.0.0.1:5173/?dev=account&w=240
// 不连后端：替换 api 里账号相关的方法，返回假数据。
// w = 侧栏宽度；dlg=api|edit|agy|kiro|codex 直接打开对话框；agy/codex=open|none|missing 控制分组状态；remote=1 模拟远程访问。
import { useState } from 'react';
import {
  type AccountEntry, type AccountList, type AccountLogin, type AccountMode, type AgyAccountEntry, type AgyAccountList, type CodexAccountEntry, type CodexAccountList, type CodexLoginMethod, type ComponentList, type KiroBalance, type KiroStatus, type UsageInfo,
} from '@cosyee/shared';
import '../styles/tokens.css';
import '../styles/motion.css';
import '../ui/layout/AppShell.css';
import '../ui/sidebar/Sidebar.css';
import { api } from '../core/api';
import { AccountMenu } from '../ui/sidebar/AccountMenu';
import { AddTargetSeg } from '../ui/sidebar/AddTargetSeg';
import { AgyAccountDialog } from '../ui/sidebar/AgyAccountDialog';
import { ApiAccountDialog } from '../ui/sidebar/ApiAccountDialog';
import { CodexAccountDialog } from '../ui/sidebar/CodexAccountDialog';
import { KiroAccountDialog } from '../ui/sidebar/KiroAccountDialog';

const params = new URLSearchParams(location.search);
const agyParam = params.get('agy');
const codexParam = params.get('codex');
const remoteParam = params.get('remote') === '1';

const H = 3_600_000;
const D = 24 * H;
const now = Date.now();
let mode: AccountMode = 'parallel';
const list: AccountEntry[] = [
  // 正常：订阅推算 + 登录有效期正常（超过 7 天）
  {
    id: 'default', label: '', name: 'cosyeey', plan: 'Pro', loggedIn: true, active: true, isDefault: true,
    subscribedAt: new Date(2026, 10, 9, 10, 0).getTime(),
    loginExpiresAt: now + 22 * D,
  },
  // 7 天内失效（--warn）
  {
    id: 'a1', label: '', name: 'cosyeex', plan: 'Pro', loggedIn: true, active: false, isDefault: false,
    subscribedAt: new Date(2026, 9, 15, 10, 0).getTime(),
    loginExpiresAt: now + 3.2 * D,
  },
  // 已过期（--danger）
  {
    id: 'a4', label: '主力', name: 'team-max', plan: 'Max', loggedIn: true, active: false, isDefault: false,
    subscribedAt: new Date(2026, 7, 31, 10, 0).getTime(),
    loginExpiresAt: now - 2 * H,
  },
  // 缺项：没有订阅时间与登录到期时间
  {
    id: 'a5', label: '备用', name: 'backup-acct', plan: 'Pro', loggedIn: true, active: false, isDefault: false,
    subscribedAt: null,
    loginExpiresAt: null,
  },
  { id: 'a3', label: '公司', name: 'someone-with-a-really-long-display-name', plan: 'Max', loggedIn: false, active: false, isDefault: false },
  {
    id: 'a2', label: 'RS', name: null, plan: null, loggedIn: true, active: false, isDefault: false,
    api: {
      baseUrl: 'http://100.64.0.10:8990', authType: 'authToken', keyHint: 'abcd',
      models: { alias: { opus: { id: 'glm-4.6', label: 'GLM 4.6', m1: true }, haiku: { id: 'glm-4.5-air' } }, extra: [{ id: 'kimi-k2-turbo-preview', label: 'Kimi' }] },
    },
  },
  {
    id: 'k1', label: 'Kiro 个人', name: 'Kiro 个人', plan: null, loggedIn: true, active: false, isDefault: false,
    kiro: { method: 'builderId', proxy: 'ready', error: null, credential: 'ok' },
  },
  // 额度用完：名字长短不一（邮箱差一个字符），用来检查同组的标签、额度是否对齐
  ...['dev.team@example.com', 'dev.team2@example.com', 'ops@example.com'].map((email, i): AccountEntry => ({
    id: `kq${i}`, label: '', name: email, plan: 'Kiro', loggedIn: true, active: false, isDefault: false,
    kiro: { method: 'idc', proxy: 'ready', error: null, credential: 'quota', credentialReason: 'QuotaExceeded', email },
  })),
];
const kiroBalances: Record<string, KiroBalance> = {
  k1: { subscription: 'Kiro Pro', used: 120, limit: 500, resetsAt: now + 6 * D },
  kq0: { subscription: 'KIRO PRO+', used: 2000, limit: 2000, resetsAt: now + 4 * D },
  kq1: { subscription: 'KIRO PRO+', used: 2000, limit: 2000, resetsAt: now + 4 * D },
  kq2: { subscription: 'KIRO PRO+', used: 1000, limit: 1000, resetsAt: now + 4 * D },
};
const usage: Record<string, UsageInfo> = {
  default: { at: now, limits: [
    { kind: 'session', percent: 71, severity: 'normal', resetsAt: now + 2 * H + 29 * 60_000 },
    { kind: 'weekly', percent: 37, severity: 'normal', resetsAt: now + 3 * 24 * H },
  ] },
  a1: { at: now, limits: [
    { kind: 'session', percent: 94, severity: 'critical', resetsAt: now + 49 * 60_000 },
    { kind: 'weekly', percent: 80, severity: 'warning', resetsAt: now + 5 * 24 * H },
    { kind: 'scoped', model: 'Opus', percent: 12, severity: 'normal', resetsAt: now + 5 * 24 * H },
  ] },
  a4: { at: now, limits: [
    { kind: 'session', percent: 18, severity: 'normal', resetsAt: now + 4 * H + 12 * 60_000 },
    { kind: 'weekly', percent: 55, severity: 'normal', resetsAt: null },
  ] },
  a5: { at: now, limits: [
    { kind: 'session', percent: 5, severity: 'normal', resetsAt: now + 4 * H + 50 * 60_000 },
  ] },
};

const agyInstalled = agyParam !== 'missing';
const agyList: AgyAccountEntry[] = agyParam === 'none' || agyParam === 'missing' ? [] : [
  { id: 'agy-main', label: '', email: 'alex.chen@example.com', quota: null, plan: null, loggedIn: true, active: true, isDefault: false, running: 0 },
  { id: 'agy-work', label: '工作', email: 'alex@studio-example.dev', quota: null, plan: null, loggedIn: true, active: false, isDefault: false, running: 2 },
  { id: 'agy-mail', label: '', email: 'a.very.long.mailbox.name@example-workspace.com', quota: null, plan: null, loggedIn: true, active: false, isDefault: false, running: 0 },
  { id: 'agy-2', label: '备用账号', plan: null, loggedIn: false, active: false, isDefault: false, running: 0 },
];
let agyLoginState: AccountLogin | null = null;
let agyLoginSeq = 0;
let agyPendingMeta: { label: string; accountId?: string } = { label: '' };
let agySubmitCount = 0;

const delay = <T,>(v: T, ms = 150) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const a = api as unknown as Record<string, unknown>;
// dup=N：模拟 N 个被隐藏的重复账号（清理入口）
let dupCount = Number(params.get('dup') ?? 0);
const buildAccountList = (): AccountList => ({
  mode,
  list: list.map((e) => ({ ...e })),
  login: null,
  duplicates: dupCount,
});
a.accounts = () => delay<AccountList>(buildAccountList());
a.dedupeAccounts = () => {
  const r = { removed: Math.max(0, dupCount - 1), skipped: dupCount > 0 ? 1 : 0 };
  dupCount = r.skipped;
  return delay(r);
};
a.usage = (_f: boolean, _s: unknown, id: string) => delay(usage[id] ?? null, 300);
a.setAccountMode = (m: AccountMode) => { mode = m; return delay({ ok: true }); };
a.switchAccount = (id: string) => { for (const e of list) e.active = e.id === id; return delay({ ok: true }); };
a.removeAccount = () => delay({ ok: true });
a.saveApiAccount = () => delay({ ok: true, id: 'a2' });
a.apiModelList = () => delay({ url: 'http://100.64.0.10:8990/v1/models', models: ['glm-4.6', 'glm-4.5-air', 'kimi-k2-turbo-preview', 'deepseek-v3.2-exp', 'qwen3-coder-plus-2025-09-23'] }, 400);

let kiroState: KiroStatus = {
  service: { enabled: true, accounts: 4, running: 1, failed: 0, busySessions: 0, outdated: 0, usable: 1 },
  imports: { kiroIde: true, kiroCli: false },
  login: null,
};
a.kiroStatus = () => delay<KiroStatus>({ ...kiroState });
a.components = () => delay<ComponentList>({ list: [{
  id: 'kiro', name: 'kiro.rs', installed: true, custom: false, version: '0.9.9', latest: '0.9.9', updateAvailable: false,
  checkedAt: now - 10 * 60_000, checkError: null, autoUpdate: true, busy: 0, pending: false, updatedBy: 'server', installable: true, job: null,
  service: { state: 'ready', error: null, enabled: true, outdated: false, port: 21395, accounts: { total: 4, usable: 1 } },
}] });
a.kiroLogin = () => delay<AccountLogin>({ loginId: 'k-L1', status: 'waiting', userCode: 'ABCD-1234', url: 'https://view.awsapps.com/start/#/device', accountId: null, error: null });
a.kiroLoginStatus = () => delay<AccountLogin>({ loginId: 'k-L1', status: 'waiting', userCode: 'ABCD-1234', url: 'https://view.awsapps.com/start/#/device', accountId: null, error: null });
a.kiroLoginCancel = () => delay({ ok: true });
a.kiroBalance = (id: string) => delay<KiroBalance>(kiroBalances[id] ?? kiroBalances.k1!);

a.agyAccounts = () => delay<AgyAccountList>({
  installed: agyInstalled,
  list: agyList.map((e) => ({ ...e })),
  login: agyLoginState && (agyLoginState.status === 'starting' || agyLoginState.status === 'waiting') ? { ...agyLoginState } : null,
});
a.switchAgyAccount = (id: string) => {
  for (const e of agyList) e.active = e.id === id;
  return delay({ ok: true });
};
a.startAgyLogin = (o: { label?: string; accountId?: string }) => {
  agyLoginSeq += 1;
  agyPendingMeta = { label: o.label ?? '', accountId: o.accountId };
  agyLoginState = {
    loginId: `agy-L${agyLoginSeq}`,
    status: 'waiting',
    url: `https://accounts.google.com/o/oauth2/v2/auth?client_id=mock-agy&state=${agyLoginSeq}`,
    accountId: null,
    error: null,
  };
  return delay({ ...agyLoginState });
};
a.agyLogin = () => delay(agyLoginState ? { ...agyLoginState } : { loginId: 'none', status: 'failed', url: null, accountId: null, error: '登录不存在' });
a.submitAgyCode = () => {
  agySubmitCount += 1;
  if (agyLoginState) {
    if (agySubmitCount === 1) {
      // 第一次提交模拟授权码错误，agy 直接退出（status='failed'）
      agyLoginState = { ...agyLoginState, status: 'failed', error: '授权码无效或已过期，请重新登录' };
    } else {
      const target = agyPendingMeta.accountId ? agyList.find((x) => x.id === agyPendingMeta.accountId) : undefined;
      let id: string;
      if (target) {
        target.loggedIn = true;
        id = target.id;
      } else {
        id = `agy-new-${agyLoginSeq}`;
        agyList.push({
          id,
          label: agyPendingMeta.label,
          email: `new.user${agyLoginSeq}@example.com`,
          quota: null,
          plan: null,
          loggedIn: true,
          active: false,
          isDefault: false,
          running: 0,
        });
      }
      agyLoginState = { ...agyLoginState, status: 'done', accountId: id, error: null };
    }
  }
  return delay({ ok: true }, 120);
};
a.cancelAgyLogin = () => {
  agyLoginState = null;
  return delay({ ok: true });
};
a.removeAgyAccount = (id: string) => {
  const i = agyList.findIndex((e) => e.id === id);
  if (i >= 0) agyList.splice(i, 1);
  return delay({ ok: true });
};
a.setAgyLabel = (id: string, label: string) => {
  const hit = agyList.find((e) => e.id === id);
  if (hit) hit.label = label;
  return delay({ ok: true });
};

const codexInstalled = codexParam !== 'missing';
const codexList: CodexAccountEntry[] = codexParam === 'none' || codexParam === 'missing' ? [] : [
  {
    id: 'default', label: '', email: 'dev@openai.com', plan: 'plus', planType: 'plus', authMode: 'chatgpt',
    loggedIn: true, active: true, isDefault: true, running: 0,
    quota: {
      fetchedAt: now,
      planType: 'plus',
      groups: [{
        limitId: 'codex',
        primary: { usedPercent: 42, windowMins: 300, resetsAt: now + 2.4 * H },
        secondary: { usedPercent: 18, windowMins: 10080, resetsAt: now + 4 * D },
      }],
    },
  },
  {
    id: 'codex-pro', label: '主力 Pro', email: 'pro@studio.dev', plan: 'pro', planType: 'pro', authMode: 'chatgpt',
    loggedIn: true, active: false, isDefault: false, running: 1,
    quota: {
      fetchedAt: now,
      planType: 'pro',
      groups: [{
        limitId: 'codex',
        primary: { usedPercent: 86, windowMins: 300, resetsAt: now + 55 * 60_000 },
        secondary: { usedPercent: 92, windowMins: 10080, resetsAt: now + 2.5 * D },
      }],
    },
  },
  {
    id: 'codex-api', label: 'API 备用', email: null, plan: null, planType: null, authMode: 'apiKey',
    loggedIn: true, active: false, isDefault: false, running: 0, quota: null,
  },
  {
    id: 'codex-off', label: '过期账号', email: 'old@example.com', plan: 'free', planType: 'free', authMode: 'chatgpt',
    loggedIn: false, active: false, isDefault: false, running: 0, quota: null,
  },
];
let codexLoginState: AccountLogin | null = null;
let codexLoginSeq = 0;

a.codexAccounts = () => delay<CodexAccountList>({
  installed: codexInstalled,
  list: codexList.map((e) => ({ ...e })),
  login: codexLoginState && (codexLoginState.status === 'starting' || codexLoginState.status === 'waiting') ? { ...codexLoginState } : null,
});
a.switchCodexAccount = (id: string) => {
  for (const e of codexList) e.active = e.id === id;
  return delay({ ok: true });
};
a.startCodexLogin = (o: { method: CodexLoginMethod; label?: string; accountId?: string; apiKey?: string }) => {
  codexLoginSeq += 1;
  if (o.method === 'apiKey') {
    const id = o.accountId ?? `codex-api-${codexLoginSeq}`;
    if (!o.accountId) {
      codexList.push({
        id, label: o.label || `API ${codexLoginSeq}`, email: null, plan: null, planType: null, authMode: 'apiKey',
        loggedIn: true, active: false, isDefault: false, running: 0, quota: null,
      });
    }
    codexLoginState = { loginId: `codex-L${codexLoginSeq}`, method: 'apiKey', status: 'done', url: null, accountId: id, error: null };
    return delay({ ...codexLoginState });
  }
  codexLoginState = o.method === 'deviceAuth'
    ? {
        loginId: `codex-L${codexLoginSeq}`,
        method: 'deviceAuth',
        status: 'waiting',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'WXYZ-9876',
        accountId: o.accountId ?? null,
        error: null,
      }
    : {
        loginId: `codex-L${codexLoginSeq}`,
        method: 'chatgpt',
        status: 'waiting',
        url: `https://auth.openai.com/oauth/authorize?state=${codexLoginSeq}`,
        accountId: o.accountId ?? null,
        error: null,
      };
  return delay({ ...codexLoginState });
};
a.codexLogin = () => delay(codexLoginState ? { ...codexLoginState } : { loginId: 'none', status: 'failed', url: null, accountId: null, error: '登录不存在' });
a.cancelCodexLogin = () => {
  codexLoginState = null;
  return delay({ ok: true });
};
a.removeCodexAccount = (id: string) => {
  const i = codexList.findIndex((e) => e.id === id);
  if (i >= 0) codexList.splice(i, 1);
  return delay({ ok: true });
};
a.dedupeCodexAccounts = () => delay({ removed: 0, skipped: 0 });
a.setCodexLabel = (id: string, label: string) => {
  const hit = codexList.find((e) => e.id === id);
  if (hit) hit.label = label;
  return delay({ ok: true });
};

export default function AccountDev() {
  const w = Number(params.get('w')) || 240;
  const dlg = params.get('dlg');
  const [open, setOpen] = useState(dlg !== null);
  const rs = list.find((e) => e.id === 'a2')!;
  return (
    <div style={{ height: '100dvh', display: 'flex', background: 'var(--bg)' }}>
      <aside className="cz-shell__sidebar" style={{ width: w, height: '100%' }}>
        <div className="cz-sidebar">
          <div style={{ flex: 1 }} />
          <div className="cz-sidebar__account">
            <AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} remote={remoteParam} />
          </div>
        </div>
      </aside>
      {open && dlg === 'agy' && (
        <AgyAccountDialog
          onClose={() => setOpen(false)}
          onDone={() => {}}
          onSwitch={() => {}}
          targetSeg={<AddTargetSeg target="agy" agyDisabled={!agyInstalled} codexDisabled={!codexInstalled} onChange={() => {}} />}
        />
      )}
      {open && dlg === 'codex' && (
        <CodexAccountDialog
          remote={remoteParam}
          onClose={() => setOpen(false)}
          onDone={() => {}}
          onSwitch={() => {}}
          targetSeg={<AddTargetSeg target="codex" agyDisabled={!agyInstalled} codexDisabled={!codexInstalled} onChange={() => {}} />}
        />
      )}
      {open && dlg === 'kiro' && (
        <KiroAccountDialog
          onClose={() => setOpen(false)}
          onDone={() => {}}
          onSwitch={() => {}}
          onChangeKind={() => {}}
        />
      )}
      {open && dlg !== 'agy' && dlg !== 'kiro' && dlg !== 'codex' && (
        <ApiAccountDialog
          edit={dlg === 'edit' ? { id: rs.id, label: rs.label, title: 'RS', api: rs.api! } : undefined}
          onClose={() => setOpen(false)}
          onDone={() => {}}
          onSwitch={() => {}}
          onUseLogin={dlg === 'edit' ? undefined : () => {}}
        />
      )}
    </div>
  );
}
