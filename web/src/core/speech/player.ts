// 朗读播放器：全应用单例，支持队列播放（通话模式边做边说）与手动朗读（AnswerActions），
// 并在播放当前段时预取下一段音频（Blob URL），消除段间等待。
import type { TtsPrepared } from '@cosyee/shared';
import { api } from '../api';
import { ensureSpeech } from './ensure';

export type SpeakOwner = 'manual' | 'call';

export interface SpeakState {
  key: string | null;
  phase: 'idle' | 'downloading' | 'preparing' | 'playing';
  /** 当前播放来源：manual = 手动朗读按钮，call = 通话模式队列 */
  owner?: SpeakOwner;
  pct?: number | null;
  error?: string;
}

interface QueueItem {
  key: string;
  text: string;
  owner: SpeakOwner;
  prepared?: Promise<TtsPrepared>;
}

interface PrefetchedSeg {
  src: string;
  revoke?: () => void;
}

/** 生成一段极短的静音 WAV（8kHz 单声道 16 位）的 data URI，用来在用户手势里解锁 audio 元素 */
function silentWav(): string {
  const samples = 80;
  const buf = new Uint8Array(44 + samples * 2);
  const dv = new DataView(buf.buffer);
  const tag = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  tag(0, 'RIFF'); dv.setUint32(4, 36 + samples * 2, true); tag(8, 'WAVE');
  tag(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, 8000, true); dv.setUint32(28, 16000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  tag(36, 'data'); dv.setUint32(40, samples * 2, true);
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return 'data:audio/wav;base64,' + btoa(bin);
}
const SILENT = silentWav();

let state: SpeakState = { key: null, phase: 'idle' };
const listeners = new Set<() => void>();
let audio: HTMLAudioElement | null = null;
let gen = 0;
let abort: AbortController | null = null;
let queue: QueueItem[] = [];
let draining = false;
const liveBlobUrls = new Set<string>();

function set(next: SpeakState) {
  state = next;
  listeners.forEach((fn) => fn());
}

function revokeAllBlobs(): void {
  if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    for (const u of liveBlobUrls) {
      try { URL.revokeObjectURL(u); } catch { /* ignore */ }
    }
  }
  liveBlobUrls.clear();
}

async function prefetchSegment(url: string, signal: AbortSignal): Promise<PrefetchedSeg> {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
    return { src: url };
  }
  try {
    const res = await fetch(url, { signal });
    if (!res.ok || signal.aborted) return { src: url };
    const blob = await res.blob();
    if (signal.aborted) return { src: url };
    const blobUrl = URL.createObjectURL(blob);
    liveBlobUrls.add(blobUrl);
    return {
      src: blobUrl,
      revoke: () => {
        if (liveBlobUrls.delete(blobUrl)) {
          try { URL.revokeObjectURL(blobUrl); } catch { /* ignore */ }
        }
      },
    };
  } catch {
    return { src: url };
  }
}

export const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const getState = (): SpeakState => state;
export const isBusy = (): boolean => state.phase !== 'idle' || queue.length > 0;

export function stop(): void {
  gen++; // 让还在等待中的异步续体失效
  queue = [];
  draining = false;
  abort?.abort();
  abort = null;
  revokeAllBlobs();
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
  }
  if (state.phase !== 'idle' || state.error || state.owner) set({ key: null, phase: 'idle' });
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ensureAudio(): HTMLAudioElement {
  if (!audio) audio = new Audio();
  return audio;
}

async function playOne(el: HTMLAudioElement, item: QueueItem, my: number, ctl: AbortController): Promise<void> {
  set({ key: item.key, phase: 'preparing', owner: item.owner });
  await ensureSpeech('tts', (pct) => { if (my === gen) set({ key: item.key, phase: 'downloading', owner: item.owner, pct }); }, ctl.signal);
  if (my !== gen) return;
  set({ key: item.key, phase: 'preparing', owner: item.owner });
  const { id, count } = await (item.prepared ?? api.ttsPrepare(item.text));
  if (my !== gen) return;
  if (count <= 0) throw new Error('没有可朗读的内容');

  let nextPrefetch: Promise<PrefetchedSeg> | null = null;
  for (let i = 0; i < count; i++) {
    const seg: PrefetchedSeg = i === 0
      ? { src: api.ttsAudioUrl(id, 0) }
      : await (nextPrefetch ?? Promise.resolve({ src: api.ttsAudioUrl(id, i) }));
    if (my !== gen) {
      seg.revoke?.();
      return;
    }

    // 播放当前段的同时预取下一段（或下一条排队文本的 ttsPrepare），消除段间等待
    if (i + 1 < count) {
      nextPrefetch = prefetchSegment(api.ttsAudioUrl(id, i + 1), ctl.signal);
    } else {
      nextPrefetch = null;
      const upcoming = queue[0];
      if (upcoming && !upcoming.prepared) {
        upcoming.prepared = api.ttsPrepare(upcoming.text);
        upcoming.prepared.catch(() => {}); // 避免未消费前触发 unhandledRejection
      }
    }

    try {
      await new Promise<void>((resolve, reject) => {
        el.onended = () => resolve();
        el.onerror = () => reject(new Error('音频播放失败'));
        el.src = seg.src;
        if (i === 0) set({ key: item.key, phase: 'playing', owner: item.owner });
        Promise.resolve(el.play()).catch(reject);
      });
    } finally {
      seg.revoke?.();
    }
    if (my !== gen) return;
  }
  el.onended = null;
  el.onerror = null;
}

function startDrain(): void {
  if (draining) return;
  draining = true;
  const my = ++gen;
  const ctl = new AbortController();
  abort = ctl;
  const el = ensureAudio();

  void (async () => {
    while (my === gen && queue.length > 0) {
      const item = queue.shift()!;
      try {
        await playOne(el, item, my, ctl);
      } catch (e) {
        if (my !== gen) return;
        el.onended = null;
        el.onerror = null;
        set({ key: item.key, phase: 'idle', owner: item.owner, error: errMsg(e) });
        if (item.owner === 'manual') {
          queue = [];
          draining = false;
          return;
        }
      }
    }
    if (my !== gen) return;
    draining = false;
    abort = null;
    if (!state.error) set({ key: null, phase: 'idle' });
  })();
}

/** 手动朗读（AnswerActions）：抢占并清空当前队列；再点同一条 = 停止 */
export function speak(key: string, markdown: string): void {
  const wasActive = state.key === key && state.phase !== 'idle';
  stop();
  if (wasActive) return;
  const el = ensureAudio();
  // 必须同步（在任何 await 之前）播一段静音：Android WebView 只放行用户手势内的 play()，
  // 元素被解锁后，后面异步换 src 再 play() 就不受限了
  el.src = SILENT;
  void Promise.resolve(el.play()).catch(() => {});

  queue.push({ key, text: markdown, owner: 'manual' });
  set({ key, phase: 'preparing', owner: 'manual' });
  startDrain();
}

/** 加入朗读队列（通话模式默认 owner='call'）：依次播放，不打断当前正在念的内容 */
export function enqueue(key: string, markdown: string, owner: SpeakOwner = 'call'): void {
  if (!markdown.trim()) return;
  queue.push({ key, text: markdown, owner });
  if (!draining) {
    set({ key, phase: 'preparing', owner });
    startDrain();
  }
}

/** 在用户手势里调用：解锁 audio 元素，之后不在手势里的 enqueue()（通话模式自动朗读）也能出声 */
export function unlock(): void {
  if (state.phase !== 'idle') return; // 正在播，本来就是解锁的
  const el = ensureAudio();
  el.src = SILENT;
  void Promise.resolve(el.play()).catch(() => {});
}
