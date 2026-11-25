// 额度面板的文字格式化（纯函数，便于单测）。
import type { UsageLimit } from '@cosyee/shared';

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 「周二03:00 重置」；当天只写时间，不到 1 小时写「N 分钟后重置」 */
export function resetText(at: number | null, now = Date.now()): string {
  if (at == null) return '';
  const diff = at - now;
  if (diff <= 0) return '即将重置';
  if (diff < 3_600_000) return `${Math.max(1, Math.ceil(diff / 60_000))} 分钟后重置`;
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return `今天 ${time} 重置`;
  return `${WEEKDAY[d.getDay()]}${time} 重置`;
}

export function limitTitle(l: UsageLimit): string {
  if (l.kind === 'session') return '当前会话';
  if (l.kind === 'weekly') return '本周';
  return l.model ?? '模型';
}

/** 触发按钮上的环取百分比最高的那条限制 */
export function worstLimit(limits: UsageLimit[]): UsageLimit | null {
  return limits.reduce<UsageLimit | null>((a, l) => (!a || l.percent > a.percent ? l : a), null);
}

/** 账号菜单里一行额度的名字：会话 / 本周 / 模型名 */
export function limitShortTitle(l: UsageLimit): string {
  if (l.kind === 'session') return '会话';
  if (l.kind === 'weekly') return '本周';
  return l.model ?? '模型';
}

/** 紧凑的重置说明：「2小时14分后重置」「周四 09:00 重置」；不到 1 小时写分钟，12 小时内写小时分钟，其余写星期与时间 */
export function resetShort(at: number | null, now = Date.now()): string {
  if (at == null) return '';
  const diff = at - now;
  if (diff <= 0) return '即将重置';
  const mins = Math.max(1, Math.ceil(diff / 60_000));
  if (mins < 60) return `${mins}分钟后重置`;
  if (diff < 12 * 3_600_000) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}小时${m}分后重置` : `${h}小时后重置`;
  }
  const d = new Date(at);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === new Date(now).toDateString()) return `今天 ${time} 重置`;
  return `${WEEKDAY[d.getDay()]} ${time} 重置`;
}

/** 「会话 32% · 2小时14分后重置」 */
export function limitLine(l: UsageLimit, now = Date.now()): string {
  const r = resetShort(l.resetsAt, now);
  return `${limitShortTitle(l)} ${l.percent}%${r ? ` · ${r}` : ''}`;
}

const DAY_MS = 24 * 3_600_000;

function clampMonthDay(year: number, month: number, day: number): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day, lastDay));
}

/** 按订阅开始日的月度周年推算下一个到期日期（本地时区；日号超过当月天数取月末） */
export function nextBillingDate(subscribedAt: number, now = Date.now()): Date | null {
  if (!Number.isFinite(subscribedAt) || subscribedAt <= 0) return null;
  const start = new Date(subscribedAt);
  const day = start.getDate();
  const cur = new Date(now);
  const today = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
  const cand = clampMonthDay(cur.getFullYear(), cur.getMonth(), day);
  if (cand.getTime() > today.getTime()) return cand;
  return clampMonthDay(cur.getFullYear(), cur.getMonth() + 1, day);
}

export interface SubscriptionEstimate {
  text: string;
  title: string;
}

/** 推算的订阅到期说明（明确标明是按月推算，不冒充官方到期日） */
export function subscriptionEstimate(subscribedAt: number | null | undefined, now = Date.now()): SubscriptionEstimate | null {
  if (subscribedAt == null || !Number.isFinite(subscribedAt) || subscribedAt <= 0) return null;
  const next = nextBillingDate(subscribedAt, now);
  if (!next) return null;
  const start = new Date(subscribedAt);
  const startStr = `${start.getFullYear()}/${pad(start.getMonth() + 1)}/${pad(start.getDate())}`;
  const nextStr = `${pad(next.getMonth() + 1)}/${pad(next.getDate())}`;
  return {
    text: `订阅约 ${nextStr} 到期`,
    title: `按订阅开始日 ${startStr} 每月推算；官方未提供准确到期日，年付、已取消等情况以账单为准`,
  };
}

export interface LoginExpiryInfo {
  text: string;
  tone: 'normal' | 'warn' | 'danger';
}

/** 登录凭据失效说明（准确值）：7 天内警告，已过期标红 */
export function loginExpiry(expiresAt: number | null | undefined, now = Date.now()): LoginExpiryInfo | null {
  if (expiresAt == null || !Number.isFinite(expiresAt) || expiresAt <= 0) return null;
  const diff = expiresAt - now;
  if (diff <= 0) return { text: '登录已失效', tone: 'danger' };
  if (diff <= 7 * DAY_MS) {
    const days = Math.max(1, Math.ceil(diff / DAY_MS));
    return { text: `登录 ${days} 天后失效`, tone: 'warn' };
  }
  const d = new Date(expiresAt);
  return { text: `登录至 ${pad(d.getMonth() + 1)}/${pad(d.getDate())}`, tone: 'normal' };
}
