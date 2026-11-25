// 朗读播放器：全应用单例，同一时间只播一段回答。
import { api } from '../api';
import { ensureSpeech } from './ensure';

export interface SpeakState {
  key: string | null;
  phase: 'idle' | 'downloading' | 'preparing' | 'playing';
  pct?: number | null;
  error?: string;
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
/** 最近一次自然念完的那次 speak 的 gen（区分「念完」和「被打断」） */
let doneGen = -1;

function set(next: SpeakState) {
  state = next;
  listeners.forEach((fn) => fn());
}

export const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const getState = (): SpeakState => state;

export function stop(): void {
  gen++; // 让还在等待中的异步续体失效
  abort?.abort();
  abort = null;
  if (audio) {
    audio.onended = null;
    audio.onerror = null;
    audio.pause();
    audio.removeAttribute('src');
  }
  if (state.phase !== 'idle' || state.error) set({ key: null, phase: 'idle' });
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function speak(key: string, markdown: string): void {
  const wasActive = state.key === key && state.phase !== 'idle';
  stop();
  if (wasActive) return; // 再点同一条 = 停止
  if (!audio) audio = new Audio();
  const el = audio;
  // 必须同步（在任何 await 之前）播一段静音：Android WebView 只放行用户手势内的 play()，
  // 元素被解锁后，后面异步换 src 再 play() 就不受限了
  el.src = SILENT;
  void Promise.resolve(el.play()).catch(() => {});

  const my = ++gen;
  const ctl = new AbortController();
  abort = ctl;
  set({ key, phase: 'preparing' }); // 模型已就绪时不闪「下载」；真要下载时 ensureSpeech 会回报进度

  void (async () => {
    try {
      await ensureSpeech('tts', (pct) => { if (my === gen) set({ key, phase: 'downloading', pct }); }, ctl.signal);
      if (my !== gen) return;
      set({ key, phase: 'preparing' });
      const { id, count } = await api.ttsPrepare(markdown);
      if (my !== gen) return;
      if (count <= 0) throw new Error('没有可朗读的内容');
      for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve, reject) => {
          el.onended = () => resolve();
          el.onerror = () => reject(new Error('音频播放失败'));
          el.src = api.ttsAudioUrl(id, i);
          if (i === 0) set({ key, phase: 'playing' });
          Promise.resolve(el.play()).catch(reject);
        });
        if (my !== gen) return;
      }
      el.onended = null;
      el.onerror = null;
      doneGen = my;
      set({ key: null, phase: 'idle' });
    } catch (e) {
      if (my !== gen) return; // 已被 stop / 新的 speak 取代
      el.onended = null;
      el.onerror = null;
      set({ key, phase: 'idle', error: errMsg(e) }); // 错误挂在发起朗读的那条回答上
    }
  })();
}

/** 在用户手势里调用：解锁 audio 元素，之后不在手势里的 speak()（通话模式自动朗读）也能出声 */
export function unlock(): void {
  if (state.phase !== 'idle') return; // 正在播，本来就是解锁的
  if (!audio) audio = new Audio();
  audio.src = SILENT;
  void Promise.resolve(audio.play()).catch(() => {});
}

/** 朗读并等它结束：done = 念完；stopped = 被 stop / 别的朗读打断；error = 失败（getState().error 有原因） */
export function speakAndWait(key: string, markdown: string): Promise<'done' | 'stopped' | 'error'> {
  if (state.key === key && state.phase !== 'idle') stop(); // 同 key 再 speak 是「停止」，这里要的是重新念
  speak(key, markdown);
  const my = gen;
  return new Promise((resolve) => {
    const check = () => {
      if (gen === my && state.key === key && state.phase !== 'idle') return;
      off();
      resolve(doneGen === my ? 'done' : gen === my && state.error ? 'error' : 'stopped');
    };
    const off = subscribe(check);
    check();
  });
}
