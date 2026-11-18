import { describe, expect, it } from 'vitest';
import { limitTitle, resetText, worstLimit } from './format';

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
