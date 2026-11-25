import { describe, expect, it } from 'vitest';
import { downsampleToInt16 } from './recorder';

describe('downsampleToInt16', () => {
  it('48k → 16k 长度约为 1/3，并且是区间平均', () => {
    const out = downsampleToInt16([new Float32Array(480).fill(0.5), new Float32Array(480).fill(0.5)], 48000, 16000);
    expect(out.length).toBe(320);
    expect(out[0]).toBe(16384);
  });

  it('超出 [-1, 1] 的样本截断到 Int16 边界', () => {
    const out = downsampleToInt16([Float32Array.from([2, -2, 1, -1])], 16000, 16000);
    expect([...out]).toEqual([32767, -32768, 32767, -32768]);
  });

  it('空输入得到空结果', () => {
    expect(downsampleToInt16([], 48000, 16000).length).toBe(0);
    expect(downsampleToInt16([new Float32Array(0)], 48000, 16000).length).toBe(0);
  });
});
