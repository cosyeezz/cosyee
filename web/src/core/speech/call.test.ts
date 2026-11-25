import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  onFrame: null as ((f: Float32Array) => void) | null,
  close: vi.fn(),
  stt: vi.fn(async () => ({ text: '帮我跑一下测试' })),
  speak: vi.fn(async () => 'done' as const),
}));
vi.mock('./recorder', async (orig) => ({
  ...(await orig<typeof import('./recorder')>()),
  micSupport: () => ({ ok: true }),
  openMic: async (fn: (f: Float32Array) => void) => { h.onFrame = fn; return { rate: 16000, close: h.close }; },
}));
vi.mock('./ensure', () => ({ ensureSpeech: async () => {} }));
vi.mock('../api', () => ({ api: { stt: h.stt } }));
vi.mock('./player', () => ({ unlock: vi.fn(), stop: vi.fn(), speakAndWait: h.speak, getState: () => ({}) }));

import * as call from './call';

const frame = (amp: number) => Float32Array.from({ length: 1600 }, (_, i) => amp * Math.sin(i / 3));
const say = () => {
  for (let i = 0; i < 5; i++) h.onFrame!(frame(0.002));
  for (let i = 0; i < 10; i++) h.onFrame!(frame(0.3));
  for (let i = 0; i < 15; i++) h.onFrame!(frame(0.002));
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('通话模式', () => {
  beforeEach(() => { h.stt.mockClear(); h.speak.mockClear(); h.close.mockClear(); });
  afterEach(() => call.hangup());

  it('听 → 识别 → 发送 → 等执行完 → 朗读 → 再听', async () => {
    const send = vi.fn(() => true);
    await call.start({ send, running: () => false });
    expect(call.getState().phase).toBe('listening');

    say();
    await flush();
    expect(send).toHaveBeenCalledWith('帮我跑一下测试');
    expect(call.getState()).toMatchObject({ phase: 'waiting', heard: '帮我跑一下测试' });

    // 等待中说话不收
    say();
    await flush();
    expect(h.stt).toHaveBeenCalledTimes(1);

    await call.turnFinished('t1', '测试全部通过。');
    expect(h.speak).toHaveBeenCalledWith('call:t1', '测试全部通过。');
    expect(call.getState().phase).toBe('listening');

    call.hangup();
    expect(call.getState().phase).toBe('off');
    expect(h.close).toHaveBeenCalled();
  });

  it('没识别出文字时继续听，不发送', async () => {
    h.stt.mockResolvedValueOnce({ text: '。' });
    const send = vi.fn(() => true);
    await call.start({ send, running: () => false });
    say();
    await flush();
    expect(send).not.toHaveBeenCalled();
    expect(call.getState().phase).toBe('listening');
  });

  it('打开时正在执行：先等这一轮结束', async () => {
    await call.start({ send: () => true, running: () => true });
    expect(call.getState().phase).toBe('waiting');
  });
});
