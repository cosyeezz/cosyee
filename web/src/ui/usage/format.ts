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
