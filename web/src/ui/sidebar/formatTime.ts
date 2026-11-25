// 会话列表的"上次活动"时间格式化。纯函数，按本地时区。
// 今天 HH:mm；昨天「昨天」；同年更早 MM/DD；跨年 YYYY/MM/DD。

const pad = (n: number): string => String(n).padStart(2, '0');

/** 本地日历日的"天序号"（只看年月日，用 UTC 构造避免夏令时造成的 23/25 小时问题） */
const dayIndex = (d: Date): number =>
  Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000);

export function formatLastActive(ts: number, now: number = Date.now()): string {
  const t = new Date(ts);
  const n = new Date(now);
  const diffDays = dayIndex(n) - dayIndex(t);

  if (diffDays === 0) return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  if (diffDays === 1) return '昨天';
  if (t.getFullYear() === n.getFullYear()) return `${pad(t.getMonth() + 1)}/${pad(t.getDate())}`;
  return `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())}`;
}

/** 绝对时间：YYYY/MM/DD HH:mm（本地时区） */
export function formatAbsoluteTime(ts: number): string {
  const t = new Date(ts);
  return `${t.getFullYear()}/${pad(t.getMonth() + 1)}/${pad(t.getDate())} ${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const DAY_MS = 24 * HOUR_MS;

/** 相对时间：「刚刚」「N 分钟前」「N 小时前」「N 天前」「N 个月前」「N 年前」 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const diff = now - ts;
  if (diff < MIN_MS) return '刚刚';
  if (diff < HOUR_MS) return `${Math.floor(diff / MIN_MS)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  const days = Math.floor(diff / DAY_MS);
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

/** 悬浮卡片用的完整时间：YYYY/MM/DD HH:mm · 相对说法 */
export function formatFullTime(ts: number, now: number = Date.now()): string {
  return `${formatAbsoluteTime(ts)} · ${formatRelativeTime(ts, now)}`;
}
