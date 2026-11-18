import { describe, expect, it } from 'vitest';
import { formatPercent, formatTokens } from './formatTokens';

describe('formatTokens', () => {
  it('k 格式', () => {
    expect(formatTokens(45200)).toBe('45.2k');
    expect(formatTokens(200000)).toBe('200k');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(10050)).toBe('10.1k');
  });
  it('小于 1000 原样输出', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(999)).toBe('999');
  });
  it('百万', () => {
    expect(formatTokens(1_000_000)).toBe('1m');
    expect(formatTokens(1_500_000)).toBe('1.5m');
  });
});

describe('formatPercent', () => {
  it('保留一位并去掉多余的 0', () => {
    expect(formatPercent(22.6)).toBe('22.6%');
    expect(formatPercent(50)).toBe('50%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.04)).toBe('<0.1%');
  });
});
