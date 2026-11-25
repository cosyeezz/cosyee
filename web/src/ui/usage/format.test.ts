import { describe, expect, it } from 'vitest';
import { limitLine, limitShortTitle, limitTitle, loginExpiry, nextBillingDate, resetShort, resetText, subscriptionEstimate, worstLimit } from './format';

describe('resetText', () => {
  const now = new Date(2026, 10, 16, 10, 0).getTime();
  it('null → 空', () => expect(resetText(null, now)).toBe(''));
  it('不到 1 小时', () => expect(resetText(now + 25 * 60_000, now)).toBe('25 分钟后重置'));
  it('当天', () => expect(resetText(new Date(2026, 10, 16, 15, 5).getTime(), now)).toBe('今天 15:05 重置'));
  it('跨天写星期', () => expect(resetText(new Date(2026, 10, 17, 3, 0).getTime(), now)).toBe('周二03:00 重置'));
  it('已过期', () => expect(resetText(now - 1, now)).toBe('即将重置'));
});

describe('limits', () => {
  const a = { kind: 'session', percent: 10, severity: 'normal', resetsAt: null } as const;
  const b = { kind: 'scoped', percent: 90, severity: 'warning', resetsAt: null, model: 'Fable' } as const;
  it('标题', () => { expect(limitTitle(a)).toBe('当前会话'); expect(limitTitle(b)).toBe('Fable'); });
  it('最紧张', () => { expect(worstLimit([a, b])).toBe(b); expect(worstLimit([])).toBeNull(); });
});

describe('resetShort / limitLine', () => {
  const now = new Date(2026, 10, 16, 10, 0).getTime();
  it('分钟 / 小时分钟 / 整小时', () => {
    expect(resetShort(now + 25 * 60_000, now)).toBe('25分钟后重置');
    expect(resetShort(now + (2 * 60 + 14) * 60_000, now)).toBe('2小时14分后重置');
    expect(resetShort(now + 3 * 3_600_000, now)).toBe('3小时后重置');
  });
  it('远期写星期与时间，已过期与空', () => {
    expect(resetShort(new Date(2026, 10, 19, 9, 0).getTime(), now)).toBe('周四 09:00 重置');
    expect(resetShort(now - 1, now)).toBe('即将重置');
    expect(resetShort(null, now)).toBe('');
  });
  it('一行额度文字', () => {
    const s = { kind: 'session', percent: 32, severity: 'normal', resetsAt: now + (2 * 60 + 14) * 60_000 } as const;
    const w = { kind: 'weekly', percent: 58, severity: 'normal', resetsAt: new Date(2026, 10, 19, 9, 0).getTime() } as const;
    expect(limitLine(s, now)).toBe('会话 32% · 2小时14分后重置');
    expect(limitLine(w, now)).toBe('本周 58% · 周四 09:00 重置');
    expect(limitShortTitle({ kind: 'scoped', percent: 1, severity: 'normal', resetsAt: null, model: 'Fable' })).toBe('Fable');
  });
});

describe('subscriptionEstimate / nextBillingDate', () => {
  it('同月已过周年日 → 推算到下月同日', () => {
    const sub = new Date(2026, 10, 9, 10, 0).getTime(); // 2026/11/09
    const now = new Date(2026, 10, 24, 15, 0).getTime(); // 2026/11/24
    const est = subscriptionEstimate(sub, now)!;
    expect(est.text).toBe('订阅约 12/09 到期');
    expect(est.title).toBe('按订阅开始日 2026/11/09 每月推算；官方未提供准确到期日，年付、已取消等情况以账单为准');
  });

  it('同月未到周年日 → 取本月同日；当天 → 推算到下月', () => {
    const sub = new Date(2026, 9, 28, 8, 0).getTime(); // 2026/10/28
    expect(subscriptionEstimate(sub, new Date(2026, 10, 24).getTime())?.text).toBe('订阅约 11/28 到期');
    expect(subscriptionEstimate(sub, new Date(2026, 10, 28).getTime())?.text).toBe('订阅约 12/28 到期');
  });

  it('月末钳位与跨年：31 号在 2 月取 28/29，12 月跨到次年 1 月', () => {
    const sub31 = new Date(2026, 0, 31, 9, 0).getTime(); // 2026/01/31
    // 平年 2 月
    expect(nextBillingDate(sub31, new Date(2026, 1, 10).getTime())).toEqual(new Date(2026, 1, 28));
    // 闰年 2 月
    expect(nextBillingDate(sub31, new Date(2028, 1, 10).getTime())).toEqual(new Date(2028, 1, 29));
    // 2 月 28 当天 → 3 月 31
    expect(nextBillingDate(sub31, new Date(2026, 1, 28).getTime())).toEqual(new Date(2026, 2, 31));
    // 跨年：12/20 → 次年 01/15
    const sub15 = new Date(2026, 5, 15).getTime();
    expect(subscriptionEstimate(sub15, new Date(2026, 11, 20).getTime())?.text).toBe('订阅约 01/15 到期');
  });

  it('空值或非法值返回 null', () => {
    expect(subscriptionEstimate(null)).toBeNull();
    expect(subscriptionEstimate(undefined)).toBeNull();
    expect(subscriptionEstimate(0)).toBeNull();
    expect(subscriptionEstimate(Number.NaN)).toBeNull();
  });
});

describe('loginExpiry', () => {
  const now = new Date(2026, 10, 24, 12, 0).getTime(); // 2026/11/24 12:00
  const DAY = 24 * 3_600_000;

  it('超过 7 天显示具体月日（normal）', () => {
    expect(loginExpiry(new Date(2026, 11, 16, 12, 0).getTime(), now)).toEqual({ text: '登录至 12/16', tone: 'normal' });
  });

  it('7 天内显示剩余天数（warn）', () => {
    expect(loginExpiry(now + 7 * DAY, now)).toEqual({ text: '登录 7 天后失效', tone: 'warn' });
    expect(loginExpiry(now + 2.2 * DAY, now)).toEqual({ text: '登录 3 天后失效', tone: 'warn' });
    expect(loginExpiry(now + 3_600_000, now)).toEqual({ text: '登录 1 天后失效', tone: 'warn' });
  });

  it('已过期显示失效（danger），空值 / 非法值返回 null', () => {
    expect(loginExpiry(now, now)).toEqual({ text: '登录已失效', tone: 'danger' });
    expect(loginExpiry(now - 60_000, now)).toEqual({ text: '登录已失效', tone: 'danger' });
    expect(loginExpiry(null, now)).toBeNull();
    expect(loginExpiry(undefined, now)).toBeNull();
    expect(loginExpiry(-1, now)).toBeNull();
  });
});
