// 通话模式：像打电话一样和会话对话。
//   听（VAD 判断说完）→ 识别 → 自动发送 → 等这一轮执行完 → 朗读交付 → 再听 ……
// 执行中、朗读中不收音（免得把自己的声音或扬声器里的朗读当成新的话）；挂断随时结束。
// 全应用单例，和 React 无关；页面（MainApp）负责把「这一轮结束了」告诉它（turnFinished）。
import { api } from '../api';
import { ensureSpeech } from './ensure';
import * as player from './player';
import { downsampleToInt16, micSupport, openMic, TARGET_RATE, type Mic } from './recorder';
import { Vad } from './vad';

export type CallPhase =
  | 'off'
  | 'connecting' // 打开麦克风、下载 / 加载模型
  | 'listening' // 等你说话
  | 'hearing' // 正在说
  | 'recognizing'
  | 'waiting' // 已发送，等执行完
  | 'speaking'; // 朗读结果

export interface CallState {
  phase: CallPhase;
  /** connecting 时的说明（如「正在下载识别模型」）和下载进度 */
  note?: string;
  pct?: number | null;
  /** 最近一次识别出、已发送的话 */
  heard?: string;
  /** 最近一次的错误（不中断通话） */
  error?: string;
}

export interface CallDeps {
  /** 发送一条消息；返回 false 表示现在发不了（没有工作空间等） */
  send(text: string): boolean;
  /** 打开通话时会话是否正在执行（是的话先等它执行完、念结果） */
  running(): boolean;
}

let state: CallState = { phase: 'off' };
const listeners = new Set<() => void>();
let mic: Mic | null = null;
let vad: Vad | null = null;
let deps: CallDeps | null = null;
/** 每次开始 / 挂断递增，让过期的异步续体失效 */
let gen = 0;

function set(next: CallState) {
  state = next;
  listeners.forEach((fn) => fn());
}
const patch = (p: Partial<CallState>) => set({ ...state, ...p });

export const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
};
export const getState = (): CallState => state;
export const inCall = (): boolean => state.phase !== 'off';

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function listen(): void {
  vad?.reset();
  patch({ phase: 'listening' });
}

function onFrame(f: Float32Array): void {
  if (!vad || (state.phase !== 'listening' && state.phase !== 'hearing')) return;
  const utt = vad.push(f);
  if (vad.active && state.phase === 'listening') patch({ phase: 'hearing' });
  else if (!vad.active && state.phase === 'hearing' && !utt) patch({ phase: 'listening' }); // 太短，当作噪声
  if (utt) void recognize(utt);
}

async function recognize(chunks: Float32Array[]): Promise<void> {
  const my = gen;
  const rate = mic?.rate ?? TARGET_RATE;
  patch({ phase: 'recognizing' });
  try {
    const { text } = await api.stt(downsampleToInt16(chunks, rate, TARGET_RATE), TARGET_RATE);
    if (my !== gen) return;
    const t = text.trim();
    if (!t || /^[\p{P}\s]*$/u.test(t)) return listen(); // 没听清：继续听
    if (!deps?.send(t)) {
      patch({ error: '现在发不了消息（请先打开一个工作空间）' });
      return listen();
    }
    set({ phase: 'waiting', heard: t });
  } catch (e) {
    if (my !== gen) return;
    patch({ error: `识别失败：${errMsg(e)}` });
    listen();
  }
}

/** 开始通话：必须在点击事件里同步调用（解锁朗读用的 audio 元素、申请麦克风） */
export async function start(d: CallDeps): Promise<void> {
  if (inCall()) return;
  const sup = micSupport();
  if (!sup.ok) {
    set({ phase: 'off', error: sup.reason });
    return;
  }
  player.unlock();
  deps = d;
  const my = ++gen;
  set({ phase: 'connecting' });
  try {
    const m = await openMic(onFrame);
    if (my !== gen) { m.close(); return; }
    mic = m;
    vad = new Vad({ rate: m.rate });
    const pct = (kind: 'tts' | 'stt') => (p: number | null) => { if (my === gen) patch({ pct: p, note: kind === 'tts' ? '下载朗读模型' : '下载识别模型' }); };
    await ensureSpeech('stt', pct('stt'));
    await ensureSpeech('tts', pct('tts'));
    if (my !== gen) return;
    patch({ pct: undefined, note: undefined, error: undefined });
    if (d.running()) set({ phase: 'waiting' });
    else listen();
  } catch (e) {
    if (my !== gen) return;
    hangup();
    set({ phase: 'off', error: `无法开始通话：${errMsg(e)}` });
  }
}

export function hangup(): void {
  gen++;
  mic?.close();
  mic = null;
  vad = null;
  deps = null;
  if (state.phase === 'speaking') player.stop();
  set({ phase: 'off' });
}

/** 这一轮执行完了：念 text（交付文字），念完继续听。不在等待中时忽略。 */
export async function turnFinished(key: string, text: string): Promise<void> {
  if (state.phase !== 'waiting') return;
  const my = gen;
  if (!text.trim()) return listen();
  set({ ...state, phase: 'speaking' });
  const r = await player.speakAndWait(`call:${key}`, text);
  if (my !== gen || getState().phase !== 'speaking') return; // 被打断时 skipSpeaking 已经在听了
  if (r === 'error') patch({ error: player.getState().error });
  listen();
}

/** 朗读中：停下，直接开始听（打断）。其它阶段忽略。 */
export function skipSpeaking(): void {
  if (state.phase === 'speaking') {
    player.stop(); // speakAndWait 返回 stopped，turnFinished 里接着 listen
    listen();
  }
}

/** 页面要求暂停收音（例如正在等你在屏幕上确认）后恢复：在 waiting 时调用 */
export function resumeListening(): void {
  if (state.phase === 'waiting') listen();
}
