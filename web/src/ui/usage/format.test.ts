import { describe, expect, it } from 'vitest';
import { limitLine, limitShortTitle, limitTitle, resetShort, resetText, worstLimit } from './format';

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
