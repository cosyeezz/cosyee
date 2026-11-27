import { describe, expect, it } from 'vitest';
import { Vad, type VadPushOptions } from './vad';

const RATE = 16000;
const FRAME = 1600; // 100ms
const frame = (amp: number) => Float32Array.from({ length: FRAME }, (_, i) => amp * Math.sin(i / 3));

function feed(v: Vad, amp: number, ms: number, opts?: VadPushOptions) {
  const outs = [];
  for (let t = 0; t < ms; t += 100) {
    const u = v.push(frame(amp), opts);
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
    expect(ms).toBeGreaterThanOrEqual(1500 + 1300); // 说话 + 结尾静音
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
    expect(feed(v, 0.002, 700)).toEqual([]);
    feed(v, 0.3, 800);
    expect(feed(v, 0.002, 1500)).toHaveLength(1);
  });

  it('滞回：进入说话态后，介于 0.6× 与 1× 之间的轻声字尾仍维持说话', () => {
    // base 阈值 = max(0.012, floor*3) ≈ 0.012；正弦波 rms ≈ amp / sqrt(2)
    // amp=0.014 -> rms≈0.0099，低于开始阈值 0.012，但高于滞回阈值 0.012*0.6=0.0072
    const v = new Vad({ rate: RATE });
    feed(v, 0.002, 500);
    // 先验证 amp=0.014 不能触发开始
    feed(v, 0.014, 500);
    expect(v.active).toBe(false);

    // 正常开口进入说话态
    feed(v, 0.05, 400);
    expect(v.active).toBe(true);
    // 随后持续 2000ms 的轻声（高于滞回阈值），不应在 1300ms 处被切断
    expect(feed(v, 0.014, 2000)).toEqual([]);
    expect(v.active).toBe(true);
    // 真正静音后才结束
    expect(feed(v, 0.002, 1500)).toHaveLength(1);
  });

  it('严格模式：需要更高阈值与更长开始时间，且不污染底噪估计', () => {
    const v = new Vad({ rate: RATE });
    feed(v, 0.002, 500);
    // amp=0.025 -> rms≈0.0177：高于普通阈值 0.012，但低于严格阈值 0.024
    feed(v, 0.025, 1000, { strict: true });
    expect(v.active).toBe(false);

    // 切回普通模式后，底噪未被刚才的回声抬高，amp=0.025 仍能正常触发
    feed(v, 0.025, 300, { strict: false });
    expect(v.active).toBe(true);
    v.reset();

    // 严格模式下高音量也需要至少 strictStartMs (250ms)：200ms 不触发，300ms 触发
    feed(v, 0.3, 200, { strict: true });
    expect(v.active).toBe(false);
    feed(v, 0.3, 100, { strict: true });
    expect(v.active).toBe(true);
  });

  it('超过最长时长直接交出识别，并且后续继续收音', () => {
    const v = new Vad({ rate: RATE, maxMs: 3000 });
    feed(v, 0.002, 300);
    const first = feed(v, 0.3, 4000);
    expect(first).toHaveLength(1);
    // 后续继续说并停顿，能收到第二段
    const second = [...feed(v, 0.3, 1000), ...feed(v, 0.002, 1500)];
    expect(second).toHaveLength(1);
  });
});
