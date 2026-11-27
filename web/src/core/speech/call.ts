// 全双工通话模式：像两个人打电话一样和会话对话。
//   - 麦克风与 VAD 全程运行，任何阶段都不丢帧；识别在途时继续收音并排队识别。
//   - 状态拆分为两维：agent（idle / working / speaking）与 user（silent / talking / recognizing）。
//   - 朗读中用户开口立即打断（barge-in），朗读期间 VAD 启用严格开始判定抗回声。
//   - 执行中用户说话 = 打断：页面按「立即发送」处理（中断当前这一轮，马上执行这句话）；简短停止指令则只中断执行并停播。
//   - 边做边说：每完成一个文本块即加入朗读队列，去重不重复念，整轮无文本时念兜底，权限确认时提醒。
//   - 全应用单例，与 React 无关；页面（MainApp）通过 syncSession 把当前会话状态同步进来。
import type { Turn } from '@cosyee/shared';
import { api } from '../api';
import { ensureSpeech } from './ensure';
import * as player from './player';
import { downsampleToInt16, effectiveRate, micSupport, openMic, TARGET_RATE, type Mic } from './recorder';
import { Vad } from './vad';
import { acquireWakeLock } from './wakeLock';

export type CallPhase = 'off' | 'connecting' | 'active';
export type AgentState = 'idle' | 'working' | 'speaking';
export type UserState = 'silent' | 'talking' | 'recognizing';

export interface CallState {
  phase: CallPhase;
  agent: AgentState;
  user: UserState;
  /** connecting 时的说明（如「正在下载识别模型」）和下载进度 */
  note?: string;
  pct?: number | null;
  /** 最近一次识别出、已发送（或触发中断）的话 */
  heard?: string;
  /** 最近一次的错误（不中断通话） */
  error?: string;
}

export interface CallDeps {
  /** 发送一条消息；返回 false 表示现在发不了（没有工作空间等） */
  send(text: string): boolean;
  /** 中断当前执行（与 CallBar「停止执行」相同） */
  interrupt(): void;
  /** 当前会话是否正在执行 */
  running(): boolean;
}

export interface SessionSnapshot {
  sessionId: string | null;
  /** 历史仍在加载中：不做基线也不播报 */
  loading: boolean;
  /** 会话是否正在执行（status === 'running' || 'starting'） */
  running: boolean;
  /** 当前会话可见轮次（shownTurns） */
  turns: readonly Turn[];
  /** 最后一轮的 answer 是否仍在流式生成中 */
  answerStreaming: boolean;
  /** 待用户在屏幕上确认的请求列表（view.prompts） */
  prompts: readonly { id: string }[];
}

const STOP_CMD_RE =
  /^(?:停|停下|停一下|停一停|先停|先停下|先停一下|停止|停止执行|等一下|等等|等一等|暂停|别做了|别弄了|别干了|不要做了|不对停下|stop)$/i;

/** 是否为简短的停止指令（允许前后标点及内部逗号/空格） */
export function isStopCommand(text: string): boolean {
  const norm = text
    .trim()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
    .replace(/[，,、\s]+/g, '');
  return STOP_CMD_RE.test(norm);
}

const isTurnActive = (t: Pick<Turn, 'status'>): boolean =>
  t.status === 'understanding' || t.status === 'running';

const IDLE_STATE: CallState = { phase: 'off', agent: 'idle', user: 'silent' };

let state: CallState = IDLE_STATE;
const listeners = new Set<() => void>();
let mic: Mic | null = null;
let vad: Vad | null = null;
let deps: CallDeps | null = null;
let gen = 0;
let releaseWake: (() => void) | null = null;
let offPlayer: (() => void) | null = null;
let visBound = false;
let reopening = false;
let ackCtx: AudioContext | null = null;

// 状态追踪
let sessionRunning = false;
let currentUtteranceBargeIn = false;
let recQueue: { chunks: Float32Array[]; rate: number; bargeIn: boolean }[] = [];
let recDraining = false;
let recPending = 0;

// 边做边说与会话基线追踪
let trackedSessionId: string | null = null;
let sessionBaselined = false;
let wasRunning = false;
const spokenBlocks = new Set<string>();
const spokenInTurn = new Set<string>();
const baselinedDoneTurns = new Set<string>();
const fallbackChecked = new Set<string>();

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

function deriveAgent(): AgentState {
  const ps = player.getState();
  if (ps.phase !== 'idle' && ps.owner === 'call') return 'speaking';
  return sessionRunning ? 'working' : 'idle';
}

function deriveUser(): UserState {
  if (vad?.active) return 'talking';
  if (recPending > 0) return 'recognizing';
  return 'silent';
}

function syncDerived(): void {
  if (state.phase !== 'active') return;
  const agent = deriveAgent();
  const user = deriveUser();
  if (agent !== state.agent || user !== state.user) {
    patch({ agent, user });
  }
}

/** 识别并发出后播放一段极短很轻的提示音（~80ms），告知用户「听到了」 */
function playAckTone(): void {
  try {
    if (typeof window === 'undefined') return;
    const Ctx: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    if (!ackCtx || ackCtx.state === 'closed') ackCtx = new Ctx();
    if (ackCtx.state === 'suspended') void ackCtx.resume().catch(() => {});
    const now = ackCtx.currentTime;
    const osc = ackCtx.createOscillator();
    const gain = ackCtx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(740, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.075);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    osc.connect(gain);
    gain.connect(ackCtx.destination);
    osc.start(now);
    osc.stop(now + 0.085);
  } catch {
    /* 测试环境或浏览器不支持时忽略 */
  }
}

function onFrame(f: Float32Array): void {
  if (state.phase !== 'active' || !vad) return;
  const wasActive = vad.active;
  // 只要播放器在发声（通话朗读或手动朗读），都启用严格判定抗扬声器回声
  const strict = player.isBusy();
  const utt = vad.push(f, { strict });

  if (!wasActive && vad.active) {
    // 刚越过开始阈值：如果正在朗读，立刻停播并清空队列（barge-in）
    currentUtteranceBargeIn = strict;
    if (strict) player.stop();
    syncDerived();
  } else if (wasActive && !vad.active && !utt) {
    // 太短，当作噪声丢弃
    currentUtteranceBargeIn = false;
    syncDerived();
  }

  if (utt) {
    const bargeIn = currentUtteranceBargeIn;
    currentUtteranceBargeIn = false;
    recQueue.push({ chunks: utt, rate: mic?.rate ?? TARGET_RATE, bargeIn });
    recPending++;
    syncDerived();
    void drainRecognition(gen);
  }
}

async function drainRecognition(my: number): Promise<void> {
  if (recDraining) return;
  recDraining = true;
  try {
    while (my === gen && recQueue.length > 0) {
      const item = recQueue.shift()!;
      try {
        const outRate = effectiveRate(item.rate, TARGET_RATE);
        const { text } = await api.stt(downsampleToInt16(item.chunks, item.rate, TARGET_RATE), outRate);
        if (my !== gen) return;
        const t = text.trim();
        if (t && !/^[\p{P}\s]*$/u.test(t)) {
          const working = sessionRunning || !!deps?.running();
          if (isStopCommand(t) && (working || item.bargeIn)) {
            player.stop();
            if (working) deps?.interrupt();
            playAckTone();
            patch({ heard: t, error: undefined, agent: deriveAgent() });
          } else {
            player.stop();
            if (!deps?.send(t)) {
              patch({ error: '现在发不了消息（请先打开一个工作空间）' });
            } else {
              playAckTone();
              sessionRunning = true;
              patch({ heard: t, error: undefined, agent: deriveAgent() });
            }
          }
        }
      } catch (e) {
        if (my !== gen) return;
        patch({ error: `识别失败：${errMsg(e)}` });
      } finally {
        if (my === gen) {
          recPending = Math.max(0, recPending - 1);
          syncDerived();
        }
      }
    }
  } finally {
    if (my === gen) recDraining = false;
  }
}

async function reopenMic(my: number): Promise<void> {
  if (reopening || my !== gen || state.phase !== 'active') return;
  reopening = true;
  try {
    mic?.close();
    mic = null;
    const m = await openMic(onFrame, () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void reopenMic(my);
      }
    });
    if (my !== gen) {
      m.close();
      return;
    }
    mic = m;
    if (!vad || vad.rate !== m.rate) vad = new Vad({ rate: m.rate });
    else vad.reset();
  } catch (e) {
    if (my === gen) patch({ error: `麦克风恢复失败：${errMsg(e)}` });
  } finally {
    reopening = false;
  }
}

function onVisibilityChange(): void {
  if (state.phase !== 'active') return;
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  if (mic) {
    mic.resume();
    if (!mic.alive()) void reopenMic(gen);
  } else {
    void reopenMic(gen);
  }
}

function resetTracking(): void {
  trackedSessionId = null;
  sessionBaselined = false;
  wasRunning = false;
  spokenBlocks.clear();
  spokenInTurn.clear();
  baselinedDoneTurns.clear();
  fallbackChecked.clear();
}

function baselineSession(snap: SessionSnapshot): void {
  const sid = snap.sessionId!;
  const lastIdx = snap.turns.length - 1;
  for (let i = 0; i < snap.turns.length; i++) {
    const turn = snap.turns[i]!;
    const turnKey = `${sid}:${turn.id}`;
    const isLast = i === lastIdx;
    let ord = 0;
    for (const s of turn.steps) {
      if (s.kind === 'text' && s.text.trim()) {
        spokenBlocks.add(`${turnKey}:text:${ord++}`);
      }
    }
    const answerStreaming = isLast && isTurnActive(turn) && snap.answerStreaming;
    if (!answerStreaming && turn.answer.trim()) {
      spokenBlocks.add(`${turnKey}:text:${ord}`);
    }
    if (!isTurnActive(turn)) {
      baselinedDoneTurns.add(turnKey);
      fallbackChecked.add(turnKey);
    }
  }
  for (const p of snap.prompts) {
    spokenBlocks.add(`${sid}:prompt:${p.id}`);
  }
}

/** 同步当前会话状态：边做边说、切会话重置基线、兜底播报、权限确认提醒、更新 agent 状态 */
export function syncSession(snap: SessionSnapshot): void {
  if (state.phase !== 'active') return;

  // 切换会话：清空朗读队列，待新会话加载完重新建立基线
  if (snap.sessionId !== trackedSessionId) {
    trackedSessionId = snap.sessionId;
    sessionBaselined = false;
    wasRunning = false;
    if (player.getState().owner === 'call' || player.isBusy()) player.stop();
    sessionRunning = snap.running;
    syncDerived();
    if (!snap.sessionId || snap.loading) return;
  }

  if (!snap.sessionId || snap.loading) return;

  if (!sessionBaselined) {
    sessionBaselined = true;
    baselineSession(snap);
    wasRunning = snap.running;
    sessionRunning = snap.running;
    syncDerived();
    return;
  }

  const sid = snap.sessionId;
  sessionRunning = snap.running;

  // 1. 权限 / 提问确认提醒：同一批新出现的 prompt 只念一次
  const newPrompts = snap.prompts.filter((p) => !spokenBlocks.has(`${sid}:prompt:${p.id}`));
  if (newPrompts.length > 0) {
    for (const p of newPrompts) spokenBlocks.add(`${sid}:prompt:${p.id}`);
    player.enqueue(`${sid}:prompt:${newPrompts[0]!.id}`, '需要你在屏幕上确认一下', 'call');
  }

  // 2. 边做边说：扫描所有未完全基线化的轮次，把新完成的文本块加入朗读队列
  const lastIdx = snap.turns.length - 1;
  for (let i = 0; i < snap.turns.length; i++) {
    const turn = snap.turns[i]!;
    const turnKey = `${sid}:${turn.id}`;
    if (baselinedDoneTurns.has(turnKey)) continue;
    const isLast = i === lastIdx;
    let ord = 0;
    for (const s of turn.steps) {
      if (s.kind === 'text' && s.text.trim()) {
        const key = `${turnKey}:text:${ord++}`;
        if (!spokenBlocks.has(key)) {
          spokenBlocks.add(key);
          spokenInTurn.add(turnKey);
          player.enqueue(key, s.text, 'call');
        }
      }
    }
    const streaming = isLast && isTurnActive(turn) && snap.answerStreaming;
    if (!streaming && turn.answer.trim()) {
      const key = `${turnKey}:text:${ord}`;
      if (!spokenBlocks.has(key)) {
        spokenBlocks.add(key);
        spokenInTurn.add(turnKey);
        player.enqueue(key, turn.answer, 'call');
      }
    }
  }

  // 3. 整轮结束兜底：如果这一轮一个字都没念过（且不是被用户中断），念兜底提示
  if (!snap.running) {
    const last = snap.turns[lastIdx];
    if (last && !isTurnActive(last)) {
      const turnKey = `${sid}:${last.id}`;
      if (!fallbackChecked.has(turnKey)) {
        fallbackChecked.add(turnKey);
        if (!spokenInTurn.has(turnKey) && last.status !== 'interrupted') {
          const fb = last.status === 'error' ? '执行出错了，请看屏幕。' : '执行完了。';
          player.enqueue(`${turnKey}:fallback`, fb, 'call');
        }
      }
    }
  }

  wasRunning = snap.running;
  syncDerived();
}

/** 外部通过文字发送消息时调用：立刻停止朗读并清空队列 */
export function onUserTextSent(): void {
  player.stop();
  syncDerived();
}

/** 开始通话：必须在点击事件里同步调用（解锁朗读用的 audio 元素、申请麦克风） */
export async function start(d: CallDeps): Promise<void> {
  if (inCall()) return;
  const sup = micSupport();
  if (!sup.ok) {
    set({ ...IDLE_STATE, error: sup.reason });
    return;
  }
  player.unlock();
  deps = d;
  resetTracking();
  recQueue = [];
  recDraining = false;
  recPending = 0;
  currentUtteranceBargeIn = false;
  reopening = false;
  const my = ++gen;
  releaseWake = acquireWakeLock();
  set({ phase: 'connecting', agent: 'idle', user: 'silent' });
  try {
    const m = await openMic(onFrame, () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        void reopenMic(my);
      }
    });
    if (my !== gen) { m.close(); return; }
    mic = m;
    vad = new Vad({ rate: m.rate });
    const pct = (kind: 'tts' | 'stt') => (p: number | null) => {
      if (my === gen) patch({ pct: p, note: kind === 'tts' ? '下载朗读模型' : '下载识别模型' });
    };
    await ensureSpeech('stt', pct('stt'));
    await ensureSpeech('tts', pct('tts'));
    if (my !== gen) return;

    offPlayer = player.subscribe(() => {
      if (my !== gen) return;
      const ps = player.getState();
      if (ps.owner === 'call' && ps.error && ps.error !== state.error) {
        patch({ error: ps.error, agent: deriveAgent() });
      } else {
        syncDerived();
      }
    });
    if (!visBound && typeof document !== 'undefined') {
      visBound = true;
      document.addEventListener('visibilitychange', onVisibilityChange);
    }

    sessionRunning = d.running();
    set({
      phase: 'active',
      agent: deriveAgent(),
      user: 'silent',
    });
  } catch (e) {
    if (my !== gen) return;
    hangup();
    set({ ...IDLE_STATE, error: `无法开始通话：${errMsg(e)}` });
  }
}

export function hangup(): void {
  gen++;
  if (visBound && typeof document !== 'undefined') {
    visBound = false;
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }
  offPlayer?.();
  offPlayer = null;
  releaseWake?.();
  releaseWake = null;
  mic?.close();
  mic = null;
  vad = null;
  deps = null;
  recQueue = [];
  recDraining = false;
  recPending = 0;
  currentUtteranceBargeIn = false;
  reopening = false;
  sessionRunning = false;
  resetTracking();
  if (ackCtx) {
    void ackCtx.close().catch(() => {});
    ackCtx = null;
  }
  if (player.getState().owner === 'call') player.stop();
  set(IDLE_STATE);
}

/** 手动点「打断」按钮：停播并清空朗读队列 */
export function skipSpeaking(): void {
  if (state.phase !== 'active') return;
  player.stop();
  syncDerived();
}
