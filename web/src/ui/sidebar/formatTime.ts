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
