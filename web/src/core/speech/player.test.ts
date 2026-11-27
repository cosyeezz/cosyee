// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enqueue, getState, isBusy, speak, stop } from './player';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

let played: string[] = [];
let ttsCalls: string[] = [];
let fetchedUrls: string[] = [];

beforeEach(() => {
  played = [];
  ttsCalls = [];
  fetchedUrls = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    fetchedUrls.push(url);
    if (url === '/api/speech/status') return json({ tts: { phase: 'ready' }, stt: { phase: 'ready' } });
    if (url === '/api/tts') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
      ttsCalls.push(body.text ?? '');
      return json({ id: `x${ttsCalls.length}`, count: 2 });
    }
    return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
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
const lastAudio = () => {
  const ctxs = (HTMLMediaElement.prototype.play as unknown as { mock: { contexts: HTMLMediaElement[] } }).mock.contexts;
  return ctxs[ctxs.length - 1]!;
};

describe('朗读播放器', () => {
  it('依次播放各段，播完回到 idle', async () => {
    speak('k', '文本');
    expect(getState().phase).toBe('preparing');
    expect(getState().owner).toBe('manual');
    expect(played[0]).toMatch(/^data:audio\/wav/); // 同步解锁
    await flush(); await flush(); await flush();
    expect(lastSrc()).toBe('/api/tts/x1/0');
    expect(getState()).toMatchObject({ key: 'k', phase: 'playing', owner: 'manual' });
    const audio = lastAudio();
    audio.dispatchEvent(new Event('ended'));
    await flush(); await flush();
    expect(lastSrc()).toBe('/api/tts/x1/1');
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

  it('enqueue 按队列依次播放，stop 清空队列', async () => {
    enqueue('c1', '第一句');
    enqueue('c2', '第二句');
    expect(isBusy()).toBe(true);
    await flush(); await flush(); await flush();
    expect(getState()).toMatchObject({ key: 'c1', phase: 'playing', owner: 'call' });
    expect(lastSrc()).toBe('/api/tts/x1/0');

    const audio = lastAudio();
    audio.dispatchEvent(new Event('ended'));
    await flush(); await flush();
    expect(lastSrc()).toBe('/api/tts/x1/1');
    // 播第一条最后一段时已预热第二条的 /api/tts
    expect(ttsCalls).toEqual(['第一句', '第二句']);

    audio.dispatchEvent(new Event('ended'));
    await flush(); await flush(); await flush();
    expect(getState()).toMatchObject({ key: 'c2', phase: 'playing', owner: 'call' });
    expect(lastSrc()).toBe('/api/tts/x2/0');

    // stop 清空剩余队列
    enqueue('c3', '第三句');
    stop();
    expect(isBusy()).toBe(false);
    expect(getState()).toEqual({ key: null, phase: 'idle' });
    await flush(); await flush();
    expect(ttsCalls).toEqual(['第一句', '第二句']); // 第三句不会被准备
  });

  it('播放当前段时预取下一段为 blob URL，播完或 stop 时释放', async () => {
    let seq = 0;
    const created: string[] = [];
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => {
      const u = `blob:seg-${++seq}`;
      created.push(u);
      return u;
    });
    URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });

    try {
      enqueue('c1', '两段文本');
      await flush(); await flush(); await flush();
      expect(lastSrc()).toBe('/api/tts/x1/0');
      // 播第 0 段时已预取第 1 段
      expect(fetchedUrls).toContain('/api/tts/x1/1');
      expect(created).toEqual(['blob:seg-1']);

      const audio = lastAudio();
      audio.dispatchEvent(new Event('ended'));
      await flush(); await flush();
      expect(lastSrc()).toBe('blob:seg-1');

      audio.dispatchEvent(new Event('ended'));
      await flush();
      expect(revoked).toEqual(['blob:seg-1']);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
