// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, speak, stop } from './player';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

let played: string[] = [];
beforeEach(() => {
  played = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url === '/api/speech/status') return json({ tts: { phase: 'ready' }, stt: { phase: 'ready' } });
    if (url === '/api/tts') return json({ id: 'x', count: 2 });
    return json({});
  }));
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    played.push(this.getAttribute('src') ?? '');
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const lastSrc = () => played[played.length - 1];

describe('朗读播放器', () => {
  it('依次播放各段，播完回到 idle', async () => {
    speak('k', '文本');
    expect(getState().phase).toBe('preparing');
    expect(played[0]).toMatch(/^data:audio\/wav/); // 同步解锁
    await flush(); await flush(); await flush();
    expect(lastSrc()).toBe('/api/tts/x/0');
    expect(getState()).toMatchObject({ key: 'k', phase: 'playing' });
    // 触发 ended：找到页面外的 audio 元素不可达，通过 prototype 事件派发
    const audio = (HTMLMediaElement.prototype.play as unknown as { mock: { contexts: HTMLMediaElement[] } }).mock.contexts[0]!;
    audio.dispatchEvent(new Event('ended'));
    await flush();
    expect(lastSrc()).toBe('/api/tts/x/1');
    audio.dispatchEvent(new Event('ended'));
    await flush();
    expect(getState()).toEqual({ key: null, phase: 'idle' });
  });

  it('stop 回到 idle；同一条再 speak 视为停止', async () => {
    speak('k', '文本');
    await flush(); await flush(); await flush();
    stop();
    expect(getState().phase).toBe('idle');
    speak('k', '文本');
    expect(getState().phase).not.toBe('idle');
    speak('k', '文本');
    expect(getState().phase).toBe('idle');
  });
});
