// account-mock 效果图用的假数据（不连后端）。
import type { AgyQuota, CodexQuota, KiroBalance, UsageInfo, UsageSeverity } from '@cosyee/shared';

const H = 3_600_000;
const D = 24 * H;
export const NOW = Date.now();

const sev = (p: number): UsageSeverity => (p >= 90 ? 'critical' : p >= 75 ? 'warning' : 'normal');
const lim = (kind: 'session' | 'weekly' | 'scoped', percent: number, inMs: number, model?: string) => ({
  kind, percent, severity: sev(percent), resetsAt: NOW + inMs, ...(model ? { model } : {}),
});

export type MockKind = 'claude' | 'api' | 'kiro' | 'agy' | 'codex';

export interface MockAccount {
  id: string;
  kind: MockKind;
  title: string;
  /** 备注名 / 邮箱 / 主机名等副信息（只在管理面板显示） */
  sub?: string;
  plan?: string;
  loggedIn: boolean;
  active?: boolean;
  isDefault?: boolean;
  /** Claude 订阅 */
  usage?: UsageInfo;
  subscribedAt?: number;
  loginExpiresAt?: number;
  /** API */
  host?: string;
  mapped?: number;
  /** Kiro */
  kiro?: KiroBalance;
  /** Antigravity */
  quota?: AgyQuota;
  /** Codex */
  codexQuota?: CodexQuota;
  running?: number;
}

const agyQ = (g5: number, gw: number, c5: number, cw: number): AgyQuota => ({
  at: NOW,
  groups: [
    { name: 'Gemini', buckets: [
      { window: '5h', percent: g5, severity: sev(g5), resetsAt: NOW + 3.2 * H },
      { window: 'weekly', percent: gw, severity: sev(gw), resetsAt: NOW + 4.5 * D },
    ] },
    { name: 'Claude · GPT', buckets: [
      { window: '5h', percent: c5, severity: sev(c5), resetsAt: NOW + 1.5 * H },
      { window: 'weekly', percent: cw, severity: sev(cw), resetsAt: NOW + 4.5 * D },
    ] },
  ],
});

export const ACCOUNTS: MockAccount[] = [
  {
    id: 'default', kind: 'claude', title: 'cosyeey', plan: 'Pro', loggedIn: true, active: true, isDefault: true,
    subscribedAt: new Date(2026, 10, 9, 10).getTime(), loginExpiresAt: NOW + 22 * D,
    usage: { at: NOW, limits: [lim('session', 71, 2.5 * H), lim('weekly', 37, 3.2 * D)] },
  },
  {
    id: 'a1', kind: 'claude', title: 'cosyeex', plan: 'Pro', loggedIn: true,
    subscribedAt: new Date(2026, 9, 15, 10).getTime(), loginExpiresAt: NOW + 3.2 * D,
    usage: { at: NOW, limits: [lim('session', 94, 49 * 60_000), lim('weekly', 80, 5 * D), lim('scoped', 12, 5 * D, 'Opus')] },
  },
  {
    id: 'a2', kind: 'claude', title: 'team-max', sub: '主力', plan: 'Max', loggedIn: true,
    subscribedAt: new Date(2026, 9, 30, 10).getTime(), loginExpiresAt: NOW - 2 * H,
    usage: { at: NOW, limits: [lim('session', 18, 4.2 * H), lim('weekly', 55, 2 * D)] },
  },
  {
    id: 'a3', kind: 'claude', title: 'backup-acct', sub: '备用', plan: 'Pro', loggedIn: true, loginExpiresAt: NOW + 30 * D,
    usage: { at: NOW, limits: [lim('weekly', 33, 6 * D), lim('session', 5, 4.8 * H)] },
  },
  { id: 'a4', kind: 'claude', title: 'someone-with-a-long-name', sub: '公司', plan: 'Max', loggedIn: false },
  { id: 'api1', kind: 'api', title: 'RS', loggedIn: true, host: '100.64.0.10:8990', mapped: 3 },
  { id: 'api2', kind: 'api', title: '官方 API', loggedIn: true, host: 'api.anthropic.com', mapped: 0 },
  {
    id: 'k1', kind: 'kiro', title: 'Kiro 个人', plan: 'Kiro', loggedIn: true,
    kiro: { subscription: 'Kiro Pro', used: 120, limit: 500, resetsAt: NOW + 6 * D },
  },
  { id: 'g1', kind: 'agy', title: 'alex.chen@example.com', plan: 'Google AI Pro', loggedIn: true, active: true, isDefault: true, quota: agyQ(12, 4, 63, 41) },
  { id: 'g2', kind: 'agy', title: '工作', sub: 'alex@studio-example.com', plan: 'Google AI Ultra', loggedIn: true, running: 2, quota: agyQ(86, 52, 100, 90) },
  { id: 'g3', kind: 'agy', title: 'a.very.long.mailbox.name@gmail.com', plan: 'Google AI Pro', loggedIn: true, quota: agyQ(0, 0, 0, 0) },
  { id: 'g4', kind: 'agy', title: '备用账号', loggedIn: false },
  {
    id: 'x1', kind: 'codex', title: 'dev@openai.com', plan: 'plus', loggedIn: true, active: true, isDefault: true,
    codexQuota: {
      fetchedAt: NOW,
      planType: 'plus',
      groups: [{
        limitId: 'codex',
        primary: { usedPercent: 42, windowMins: 300, resetsAt: NOW + 2.4 * H },
        secondary: { usedPercent: 18, windowMins: 10080, resetsAt: NOW + 4 * D },
      }],
    },
  },
  {
    id: 'x2', kind: 'codex', title: '主力 Pro', sub: 'pro@studio.dev', plan: 'pro', loggedIn: true, running: 1,
    codexQuota: {
      fetchedAt: NOW,
      planType: 'pro',
      groups: [{
        limitId: 'codex',
        primary: { usedPercent: 86, windowMins: 300, resetsAt: NOW + 55 * 60_000 },
        secondary: { usedPercent: 92, windowMins: 10080, resetsAt: NOW + 2.5 * D },
      }],
    },
  },
  { id: 'x3', kind: 'codex', title: 'API 备用', plan: 'apiKey', loggedIn: true },
  { id: 'x4', kind: 'codex', title: '过期账号', sub: 'old@example.com', plan: 'free', loggedIn: false },
];

export const GROUPS: { kind: MockKind; title: string; tip: string; add: string }[] = [
  { kind: 'claude', title: 'Claude 订阅', tip: 'claude.ai 订阅账号，会话使用', add: '用 claude.ai 登录' },
  { kind: 'api', title: 'API', tip: '用 API Key 按量计费，可配置模型映射', add: '添加 API Key' },
  { kind: 'kiro', title: 'Kiro', tip: '经 kiro.rs 代理使用 Kiro 额度', add: '登录 Kiro' },
  { kind: 'agy', title: 'Antigravity', tip: '委派任务用的账号：新的委派使用选中的账号，已有的委派继续用原来的账号', add: '登录 Antigravity' },
  { kind: 'codex', title: 'Codex', tip: '委派任务用的 OpenAI Codex 账号：新的委派使用选中的账号，已有的委派继续用原来的账号', add: '登录 Codex' },
];

/** 登录是否可用：未登录或 Claude 登录已过期都算不可用（弹层里不显示） */
export const usable = (a: MockAccount) => a.loggedIn && !(a.loginExpiresAt != null && a.loginExpiresAt <= NOW);
