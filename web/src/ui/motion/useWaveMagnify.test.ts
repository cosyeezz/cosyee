import { describe, expect, it } from 'vitest';
import { waveAmount } from './useWaveMagnify';

describe('waveAmount', () => {
  it('光标正对的行放大最多，到半径处降到 0', () => {
    expect(waveAmount(0, 84)).toBe(1);
    expect(waveAmount(84, 84)).toBe(0);
    expect(waveAmount(-200, 84)).toBe(0);
  });

  it('上下对称、离得越远越小', () => {
    expect(waveAmount(-30, 84)).toBe(waveAmount(30, 84));
    const near = waveAmount(30, 84);
    const far = waveAmount(60, 84);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
  });
});
