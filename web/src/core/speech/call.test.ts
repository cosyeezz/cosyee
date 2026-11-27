import type { Turn } from '@cosyee/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpeakOwner, SpeakState } from './player';

const h = vi.hoisted(() => {
  const playerListeners = new Set<() => void>();
  let pState: SpeakState = { key: null, phase: 'idle' };
  const setPlayer = (next: SpeakState) => {
    pState = next;
    playerListeners.forEach((fn) => fn());
  };
  return {
    onFrame: null as ((f: Float32Array) => void) | null,
    onEnded: null as (() => void) | null,
    close: vi.fn(),
    resume: vi.fn(),
    alive: vi.fn(() => true),
    stt: vi.fn(async (_pcm: Int16Array, _rate: number) => ({ text: '帮我跑一下测试' })),
    unlock: vi.fn(),
    enqueue: vi.fn((key: string, _text: string, owner: SpeakOwner = 'call') => {
      setPlayer({ key, phase: 'playing', owner });
    }),
    stop: vi.fn(() => {
      if (pState.phase !== 'idle') setPlayer({ key: null, phase: 'idle' });
    }),
    setPlayer,
    getPlayer: () => pState,
    subscribePlayer: (fn: () => void) => {
      playerListeners.add(fn);
      return () => { playerListeners.delete(fn); };
    },
    isBusy: () => pState.phase !== 'idle',
  };
});

vi.mock('./recorder', async (orig) => ({
  ...(await orig<typeof import('./recorder')>()),
  micSupport: () => ({ ok: true }),
  openMic: async (fn: (f: Float32Array) => void, onEnded?: () => void) => {
    h.onFrame = fn;
    h.onEnded = onEnded ?? null;
    return { rate: 16000, alive: h.alive, resume: h.resume, close: h.close };
  },
}));
vi.mock('./ensure', () => ({ ensureSpeech: async () => {} }));
vi.mock('../api', () => ({ api: { stt: h.stt } }));
vi.mock('./player', () => ({
  unlock: h.unlock,
  stop: h.stop,
  enqueue: h.enqueue,
  getState: h.getPlayer,
  isBusy: h.isBusy,
  subscribe: h.subscribePlayer,
}));

import * as call from './call';

const frame = (amp: number) => Float32Array.from({ length: 1600 }, (_, i) => amp * Math.sin(i / 3)); // 100ms
const say = (amp = 0.3, speechFrames = 10) => {
  for (let i = 0; i < 5; i++) h.onFrame!(frame(0.002));
  for (let i = 0; i < speechFrames; i++) h.onFrame!(frame(amp));
  for (let i = 0; i < 16; i++) h.onFrame!(frame(0.002));
};
const flush = () => new Promise((r) => setTimeout(r, 0));

const mkTurn = (overrides: Partial<Turn> = {}): Turn => ({
  id: 't0',
  userText: 'hi',
  attachments: [],
  status: 'done',
  statusText: '',
  steps: [],
  answer: '',
  subagents: [],
  startedAt: 0,
  ...overrides,
});

describe('全双工通话模式', () => {
  beforeEach(() => {
    h.stt.mockReset().mockResolvedValue({ text: '帮我跑一下测试' });
    h.enqueue.mockClear();
    h.stop.mockClear();
    h.close.mockClear();
    h.setPlayer({ key: null, phase: 'idle' });
  });
  afterEach(() => call.hangup());

  it('基础全双工流程：说话 → 识别 → 发送 → 边做边说 → 挂断', async () => {
    const send = vi.fn(() => true);
    const interrupt = vi.fn();
    await call.start({ send, interrupt, running: () => false });
    expect(call.getState()).toMatchObject({ phase: 'active', agent: 'idle', user: 'silent' });

    // 建立基线
    call.syncSession({ sessionId: 's1', loading: false, running: false, turns: [], answerStreaming: false, prompts: [] });

    say();
    await flush();
    expect(send).toHaveBeenCalledWith('帮我跑一下测试');
    expect(call.getState()).toMatchObject({ phase: 'active', agent: 'working', user: 'silent', heard: '帮我跑一下测试' });

    // 边做边说：流式中不念
    const t0 = mkTurn({ id: 't0', status: 'running', answer: '我先看看' });
    call.syncSession({ sessionId: 's1', loading: false, running: true, turns: [t0], answerStreaming: true, prompts: [] });
    expect(h.enqueue).not.toHaveBeenCalled();

    // 文本块完成：立即加入朗读队列
    call.syncSession({ sessionId: 's1', loading: false, running: true, turns: [t0], answerStreaming: false, prompts: [] });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith('s1:t0:text:0', '我先看看', 'call');
    expect(call.getState().agent).toBe('speaking');

    // 之后该块被 flushAnswer 移入 steps，绝不重复念
    const t0Flushed = mkTurn({ id: 't0', status: 'running', steps: [{ kind: 'text', text: '我先看看' }], answer: '修好了' });
    call.syncSession({ sessionId: 's1', loading: false, running: true, turns: [t0Flushed], answerStreaming: false, prompts: [] });
    expect(h.enqueue).toHaveBeenCalledTimes(2);
    expect(h.enqueue).toHaveBeenLastCalledWith('s1:t0:text:1', '修好了', 'call');

    // 整轮结束（已念过文本，不再念兜底）
    const t0Done = { ...t0Flushed, status: 'done' as const };
    call.syncSession({ sessionId: 's1', loading: false, running: false, turns: [t0Done], answerStreaming: false, prompts: [] });
    expect(h.enqueue).toHaveBeenCalledTimes(2);

    call.hangup();
    expect(call.getState().phase).toBe('off');
    expect(h.close).toHaveBeenCalled();
  });

  it('朗读中用户开口打断（barge-in）：立即停播并照常识别发送；中等回声不误打断', async () => {
    const send = vi.fn(() => true);
    await call.start({ send, interrupt: vi.fn(), running: () => false });
    h.setPlayer({ key: 's1:t0:text:0', phase: 'playing', owner: 'call' });
    expect(call.getState().agent).toBe('speaking');

    // 低于严格阈值（2×）的中等回声不触发打断
    for (let i = 0; i < 6; i++) h.onFrame!(frame(0.025));
    expect(h.stop).not.toHaveBeenCalled();

    // 用户真实开口（高音量持续 ≥250ms）：立刻停播，再说完后识别发送
    h.stt.mockResolvedValueOnce({ text: '等下，改成用 vitest' });
    for (let i = 0; i < 4; i++) h.onFrame!(frame(0.3));
    expect(h.stop).toHaveBeenCalledTimes(1);
    expect(call.getState().user).toBe('talking');
    for (let i = 0; i < 16; i++) h.onFrame!(frame(0.002));
    await flush();
    expect(send).toHaveBeenCalledWith('等下，改成用 vitest');
  });

  it('执行中说话照常识别发送，不丢帧；识别在途时第二句排队识别', async () => {
    let resolveFirst!: (v: { text: string }) => void;
    h.stt
      .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
      .mockResolvedValueOnce({ text: '顺便把类型也检查一下' });

    const send = vi.fn(() => true);
    await call.start({ send, interrupt: vi.fn(), running: () => true });
    expect(call.getState().agent).toBe('working');

    say();
    expect(call.getState().user).toBe('recognizing');
    // 第一句还在识别中，继续说第二句不丢帧
    say();
    expect(h.stt).toHaveBeenCalledTimes(1);

    resolveFirst({ text: '先改 vad.ts' });
    await flush(); await flush();
    expect(send).toHaveBeenNthCalledWith(1, '先改 vad.ts');
    expect(send).toHaveBeenNthCalledWith(2, '顺便把类型也检查一下');
    expect(call.getState().user).toBe('silent');
  });

  it('执行中说出简短停止指令 → 触发 interrupt 且停播，不发送文字', async () => {
    const send = vi.fn(() => true);
    const interrupt = vi.fn();
    await call.start({ send, interrupt, running: () => true });

    for (const phrase of ['停', '停下！', '不对，停下。', '等一下...', '别做了']) {
      send.mockClear();
      interrupt.mockClear();
      h.stop.mockClear();
      h.stt.mockResolvedValueOnce({ text: phrase });
      say();
      await flush();
      expect(interrupt).toHaveBeenCalledTimes(1);
      expect(h.stop).toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    }
  });

  it('isStopCommand 不会误杀正常长句', () => {
    expect(call.isStopCommand('停一下')).toBe(true);
    expect(call.isStopCommand('不对，停下！')).toBe(true);
    expect(call.isStopCommand('等一下帮我看看这个报错')).toBe(false);
    expect(call.isStopCommand('暂停一下然后继续改测试')).toBe(false);
  });

  it('文字发送（onUserTextSent）立即停止朗读', async () => {
    await call.start({ send: () => true, interrupt: vi.fn(), running: () => false });
    h.setPlayer({ key: 'manual-1', phase: 'playing', owner: 'manual' });
    call.onUserTextSent();
    expect(h.stop).toHaveBeenCalledTimes(1);
  });

  it('切换会话清空朗读队列，不把新会话历史回复念出来', async () => {
    await call.start({ send: () => true, interrupt: vi.fn(), running: () => false });
    call.syncSession({ sessionId: 's1', loading: false, running: false, turns: [mkTurn({ id: 't0', answer: '旧会话回答' })], answerStreaming: false, prompts: [] });
    expect(h.enqueue).not.toHaveBeenCalled();

    // 切到 s2，先处于 loading
    h.setPlayer({ key: 's1:t1:text:0', phase: 'playing', owner: 'call' });
    call.syncSession({ sessionId: 's2', loading: true, running: false, turns: [], answerStreaming: false, prompts: [] });
    expect(h.stop).toHaveBeenCalled();

    // s2 历史加载完成：建立基线，不念历史回答
    call.syncSession({
      sessionId: 's2',
      loading: false,
      running: false,
      turns: [mkTurn({ id: 't0', answer: 's2 历史回复' })],
      answerStreaming: false,
      prompts: [],
    });
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('整轮无文本时念兜底（成功 / 出错），权限确认念提示一次', async () => {
    await call.start({ send: () => true, interrupt: vi.fn(), running: () => false });
    call.syncSession({ sessionId: 's1', loading: false, running: false, turns: [], answerStreaming: false, prompts: [] });

    // 权限请求出现
    const t0 = mkTurn({ id: 't0', status: 'running' });
    call.syncSession({ sessionId: 's1', loading: false, running: true, turns: [t0], answerStreaming: false, prompts: [{ id: 'p1' }] });
    call.syncSession({ sessionId: 's1', loading: false, running: true, turns: [t0], answerStreaming: false, prompts: [{ id: 'p1' }] });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith('s1:prompt:p1', '需要你在屏幕上确认一下', 'call');

    // t0 无文本成功结束 → 兜底
    call.syncSession({ sessionId: 's1', loading: false, running: false, turns: [{ ...t0, status: 'done' }], answerStreaming: false, prompts: [] });
    expect(h.enqueue).toHaveBeenLastCalledWith('s1:t0:fallback', '执行完了。', 'call');

    // t1 无文本出错结束 → 出错兜底
    const t1 = mkTurn({ id: 't1', status: 'error' });
    call.syncSession({ sessionId: 's1', loading: false, running: false, turns: [{ ...t0, status: 'done' }, t1], answerStreaming: false, prompts: [] });
    expect(h.enqueue).toHaveBeenLastCalledWith('s1:t1:fallback', '执行出错了，请看屏幕。', 'call');
  });

  it('手动朗读不会搞乱通话状态，且期间启用严格模式防回声', async () => {
    await call.start({ send: () => true, interrupt: vi.fn(), running: () => false });
    h.setPlayer({ key: 'turn-old', phase: 'playing', owner: 'manual' });
    // agent 保持 idle，不误判为 call 正在说
    expect(call.getState().agent).toBe('idle');
    // 手动朗读期间中等回声不触发收音
    for (let i = 0; i < 6; i++) h.onFrame!(frame(0.025));
    expect(call.getState().user).toBe('silent');
  });

  it('隐藏本地命令（/compact）结束后 agent 回到 idle，不卡在 working', async () => {
    await call.start({ send: () => true, interrupt: vi.fn(), running: () => false });
    const t0 = mkTurn({ id: 't0', status: 'done', answer: 'hi' });
    call.syncSession({ sessionId: 's1', loading: false, running: false, turns: [t0], answerStreaming: false, prompts: [] });

    // /compact 跑起来，shownTurns 没变
    call.syncSession({ sessionId: 's1', loading: false, running: true, turns: [t0], answerStreaming: false, prompts: [] });
    expect(call.getState().agent).toBe('working');

    // /compact 结束，running 变 false
    call.syncSession({ sessionId: 's1', loading: false, running: false, turns: [t0], answerStreaming: false, prompts: [] });
    expect(call.getState().agent).toBe('idle');
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
