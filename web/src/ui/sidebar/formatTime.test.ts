import { describe, expect, it } from 'vitest';
import { formatLastActive } from './formatTime';

// 一律用本地时间构造，避免测试依赖运行机器的时区
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('formatLastActive', () => {
  const now = at(2026, 11, 16, 15, 30);

  it('今天显示 HH:mm（补零）', () => {
    expect(formatLastActive(at(2026, 11, 16, 9, 5), now)).toBe('09:05');
    expect(formatLastActive(at(2026, 11, 16, 0, 0), now)).toBe('00:00');
    expect(formatLastActive(at(2026, 11, 16, 15, 30), now)).toBe('15:30');
  });

  it('昨天显示「昨天」', () => {
    expect(formatLastActive(at(2026, 11, 15, 23, 59), now)).toBe('昨天');
    expect(formatLastActive(at(2026, 11, 15, 0, 0), now)).toBe('昨天');
  });

  it('同年更早显示 MM/DD', () => {
    expect(formatLastActive(at(2026, 11, 14, 23, 59), now)).toBe('11/14');
    expect(formatLastActive(at(2026, 1, 3, 8, 0), now)).toBe('01/03');
  });

  it('跨年显示 YYYY/MM/DD', () => {
    expect(formatLastActive(at(2025, 12, 31, 23, 59), now)).toBe('2025/12/31');
    expect(formatLastActive(at(2024, 2, 9, 10, 0), now)).toBe('2024/02/09');
  });

  it('跨午夜：now 为 00:05 时，23:55 属于昨天，00:01 属于今天', () => {
    const justAfterMidnight = at(2026, 11, 16, 0, 5);
    expect(formatLastActive(at(2026, 11, 15, 23, 55), justAfterMidnight)).toBe('昨天');
    expect(formatLastActive(at(2026, 11, 16, 0, 1), justAfterMidnight)).toBe('00:01');
  });

  it('跨年边界：元旦的"昨天"是去年 12/31，仍显示「昨天」', () => {
    const newYear = at(2027, 1, 1, 10, 0);
    expect(formatLastActive(at(2026, 12, 31, 22, 0), newYear)).toBe('昨天');
    expect(formatLastActive(at(2026, 12, 30, 22, 0), newYear)).toBe('2026/12/30');
  });

  it('跨月：1 号的昨天是上月最后一天', () => {
    const firstDay = at(2026, 3, 1, 8, 0);
    expect(formatLastActive(at(2026, 2, 28, 12, 0), firstDay)).toBe('昨天');
    expect(formatLastActive(at(2026, 2, 27, 12, 0), firstDay)).toBe('02/27');
  });
});
