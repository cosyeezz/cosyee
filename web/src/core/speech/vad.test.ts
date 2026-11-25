import { describe, expect, it } from 'vitest';
import { Vad } from './vad';

const RATE = 16000;
const FRAME = 1600; // 100ms
const frame = (amp: number) => Float32Array.from({ length: FRAME }, (_, i) => amp * Math.sin(i / 3));

function feed(v: Vad, amp: number, ms: number) {
  const outs = [];
  for (let t = 0; t < ms; t += 100) {
    const u = v.push(frame(amp));
    if (u) outs.push(u);
  }
  return outs;
}

describe('Vad', () => {
  it('说一段话后停顿，交出整句（带开头的预留音频）', () => {
    const v = new Vad({ rate: RATE });
    expect(feed(v, 0.002, 1000)).toEqual([]);
    expect(feed(v, 0.3, 1500)).toEqual([]);
    expect(v.active).toBe(true);
    const outs = feed(v, 0.002, 1500);
    expect(outs).toHaveLength(1);
    const ms = (outs[0]!.length * FRAME * 1000) / RATE;
    expect(ms).toBeGreaterThanOrEqual(1500 + 1100); // 说话 + 结尾静音
    expect(v.active).toBe(false);
  });

  it('短促的响声不算说话', () => {
    const v = new Vad({ rate: RATE });
    feed(v, 0.002, 500);
    expect(feed(v, 0.3, 100)).toEqual([]);
    expect(feed(v, 0.002, 2000)).toEqual([]);
    expect(v.active).toBe(false);
  });

  it('说话中间短暂停顿不会切断', () => {
    const v = new Vad({ rate: RATE });
    feed(v, 0.002, 500);
    feed(v, 0.3, 800);
    expect(feed(v, 0.002, 500)).toEqual([]);
    feed(v, 0.3, 800);
    expect(feed(v, 0.002, 1500)).toHaveLength(1);
  });

  it('超过最长时长直接结束', () => {
    const v = new Vad({ rate: RATE, maxMs: 3000 });
    feed(v, 0.002, 300);
    expect(feed(v, 0.3, 4000)).toHaveLength(1);
  });
});
