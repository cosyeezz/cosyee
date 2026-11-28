import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegateJobInfo, PendingPrompt, QueueItem, ServerMsg, StopInfo } from '@cosyee/shared';
import { Manager, retryPromptText } from './claude/manager.js';
import { Runner, type RunnerStopInfo } from './claude/runner.js';
import { Pins } from './pins.js';
import { DotState } from './state.js';
import {
  RATE_LIMIT_BUFFER_MS,
  RATE_LIMIT_FALLBACK_MS,
  RECOVER_RETRY_DELAY_MS,
  StopStore,
  TRANSIENT_BACKOFF_MS,
  classifyStop,
  transientRetryDelay,
} from './stops.js';
import { Trash } from './trash.js';
import { StateStore } from './workspaces.js';

type Json = Record<string, any>;

const SID = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const MSG_ID = '33333333-3333-4333-8333-333333333333';
const cfg = { model: 'sonnet', effort: 'medium' } as const;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-stops-'));
});
afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ───────────── classifyStop ─────────────

describe('classifyStop', () => {
  const NOW = 1_700_000_000_000;

  it('rate_limit：rejected rate_limit_event 带 resetsAt 时按 resetsAt*1000 + 60s 计算 retryAt', () => {
    const resetsAt = 1_700_003_600; // 秒
    const c = classifyStop("You've hit your 5-hour limit · resets 9pm", { status: 'rejected', resetsAt }, NOW);
    expect(c).toEqual({
      kind: 'rate_limit',
      state: 'waiting',
      retryAt: resetsAt * 1000 + RATE_LIMIT_BUFFER_MS,
    });
  });

  it('rate_limit：无 resetsAt 时兜底 now + 5min；仅文本匹配也识别为 rate_limit', () => {
    const c1 = classifyStop('You hit your weekly limit', undefined, NOW);
    expect(c1).toEqual({ kind: 'rate_limit', state: 'waiting', retryAt: NOW + RATE_LIMIT_FALLBACK_MS });

    const c2 = classifyStop('API Error: rate limit exceeded', { status: 'allowed' }, NOW);
    expect(c2).toEqual({ kind: 'rate_limit', state: 'waiting', retryAt: NOW + RATE_LIMIT_FALLBACK_MS });

    const c3 = classifyStop('usage limit reached', null, NOW);
    expect(c3.kind).toBe('rate_limit');
  });

  it('rate_limit_event status=allowed 不误判为 rate_limit', () => {
    const c = classifyStop('API Error: 529 overloaded', { status: 'allowed', resetsAt: 1_700_003_600 }, NOW);
    expect(c.kind).toBe('transient');
  });

  it('transient：5xx / overloaded / 网络 / 超时 / 进程异常退出，按 1/5/15 分钟退避', () => {
    const samples = [
      'API Error: 529 overloaded',
      'API Error: 500 Internal Server Error',
      'API Error: 503 Service Unavailable',
      'Error: read ECONNRESET',
      'connect ETIMEDOUT',
      'getaddrinfo ENOTFOUND api.anthropic.com',
      'getaddrinfo EAI_AGAIN',
      'TypeError: fetch failed',
      'socket hang up',
      'network error occurred',
      'Request timed out',
    ];
    for (const s of samples) {
      const c = classifyStop(s, null, NOW);
      expect(c, s).toEqual({ kind: 'transient', state: 'waiting', retryAt: NOW + TRANSIENT_BACKOFF_MS[0] });
    }
    expect(classifyStop('claude 退出码 1', null, NOW, { processExit: true })).toEqual({
      kind: 'transient',
      state: 'waiting',
      retryAt: NOW + TRANSIENT_BACKOFF_MS[0],
    });
    expect(transientRetryDelay(0)).toBe(60_000);
    expect(transientRetryDelay(1)).toBe(5 * 60_000);
    expect(transientRetryDelay(2)).toBe(15 * 60_000);
    expect(transientRetryDelay(5)).toBe(15 * 60_000);
    expect(classifyStop('overloaded', null, NOW, { attempts: 1 }).retryAt).toBe(NOW + 5 * 60_000);
    expect(classifyStop('overloaded', null, NOW, { attempts: 2 }).retryAt).toBe(NOW + 15 * 60_000);
  });

  it('fatal：safeguards / aup / usage policy / 未登录 / 401 / authentication / invalid api key / prompt is too long / 其它未知错误', () => {
    const samples = [
      "API Error: Opus 5.5's safeguards flagged this message",
      'Violates our AUP policy',
      'Blocked by usage policy',
      'Not logged in · Please run /login',
      'API Error: 401 Unauthorized',
      'authentication_error: invalid credentials',
      'Invalid API key provided',
      'prompt is too long: 210000 tokens > 200000 maximum',
      'Some completely unknown error',
    ];
    for (const s of samples) {
      const c = classifyStop(s, null, NOW);
      expect(c, s).toEqual({ kind: 'fatal', state: 'stopped' });
      expect(c.retryAt).toBeUndefined();
    }
  });
});

// ───────────── StopStore 落盘与重启恢复 ─────────────

describe('StopStore 持久化与重启恢复', () => {
  it('set/get/list/clear 触发 onChange，重启时把 retrying 改回 waiting (now + 1min)', async () => {
    const file = path.join(dir, 'state.json');
    const store1 = new StateStore(file);
    const changes: [string, StopInfo | null][] = [];
    const stops1 = new StopStore(store1, { onChange: (id, info) => changes.push([id, info]) });

    stops1.set(SID, { kind: 'transient', reason: '529 overloaded', attempts: 1, state: 'retrying', at: 1000 });
    stops1.set(SID2, { kind: 'fatal', reason: 'Not logged in', attempts: 0, state: 'stopped', at: 2000 });
    expect(stops1.get(SID)?.state).toBe('retrying');
    expect(stops1.list()).toHaveLength(2);
    expect(changes).toHaveLength(2);
    await store1.idle();

    // 模拟服务重启
    const T_BOOT = 10_000;
    const store2 = new StateStore(file);
    const stops2 = new StopStore(store2, { now: () => T_BOOT });
    expect(stops2.get(SID)).toEqual({
      kind: 'transient',
      reason: '529 overloaded',
      attempts: 1,
      state: 'waiting',
      retryAt: T_BOOT + RECOVER_RETRY_DELAY_MS,
      at: 1000,
    });
    expect(stops2.get(SID2)?.state).toBe('stopped');

    expect(stops2.clear(SID)).toBe(true);
    expect(stops2.get(SID)).toBeNull();
    expect(stops2.clear(SID)).toBe(false);
    await store2.idle();
  });

  it('软删除会话时自动清除停止记录', () => {
    const store = new StateStore(path.join(dir, 'state.json'));
    const dots = new DotState(store);
    const pins = new Pins(store);
    const stops = new StopStore(store);
    const trash = new Trash(store, dots, pins, Date.now, stops);

    stops.set(SID, { kind: 'transient', reason: '500', attempts: 0, state: 'waiting', retryAt: 9999, at: 1000 });
    trash.softDelete(SID, dir, 'title');
    expect(stops.get(SID)).toBeNull();
    pins.dispose();
  });
});

// ───────────── Runner 停止检测 ─────────────

function makeRunner(timings: Record<string, number> = {}) {
  const stopped: RunnerStopInfo[] = [];
  let turnOks = 0;
  let turnEnds = 0;
  const r = new Runner({
    sessionId: SID,
    cwd: dir,
    isNew: true,
    config: cfg,
    timings: { idleMs: 60_000, limboQuietMs: 1000, limboBusyMs: 3000, interruptKillMs: 500, requestTimeoutMs: 1000, ...timings },
    hooks: {
      onEvent: () => {},
      onStatus: () => {},
      onSettings: () => {},
      onTurnEnd: () => { turnEnds++; },
      onStopped: (info) => stopped.push(info),
      onTurnOk: () => { turnOks++; },
      onExit: () => {},
    },
  });
  const anyR = r as any;
  anyR.proc = {
    pid: undefined,
    stdin: { writable: true, destroyed: false, write: () => {}, end() {} },
  };
  return { r, anyR, stopped, getTurnOks: () => turnOks, getTurnEnds: () => turnEnds };
}

describe('Runner onStopped / onTurnOk', () => {
  const init = { type: 'system', subtype: 'init' };

  it('rate_limit result + rejected rate_limit_event → onStopped 带 resetsAt', () => {
    const { r, stopped, getTurnOks } = makeRunner();
    const resetsAt = 1_700_005_000;
    r.handleMessage(init);
    r.handleMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt } });
    r.handleMessage({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: "You've hit your 5-hour limit · resets 9pm",
    });
    expect(stopped).toEqual([
      { kind: 'rate_limit', reason: "You've hit your 5-hour limit · resets 9pm", resetsAt },
    ]);
    expect(getTurnOks()).toBe(0);
  });

  it('有后台任务时不立即发 onStopped；续轮成功后丢弃暂存并发 onTurnOk', () => {
    const { r, stopped, getTurnOks } = makeRunner();
    r.handleMessage(init);
    r.handleMessage({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'u1', task_type: 'local_agent' });
    r.handleMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_700_005_000 } });
    r.handleMessage({ type: 'result', is_error: true, result: "You've hit your 5-hour limit" });
    // 仍在 limbo，尚未发 onStopped
    expect(r.status).toBe('running');
    expect(stopped).toHaveLength(0);

    // 后台任务完成，CLI 自动续轮并成功
    r.handleMessage({ type: 'system', subtype: 'task_notification', task_id: 'bg1', status: 'completed' });
    r.handleMessage(init);
    r.handleMessage({ type: 'result', subtype: 'success', is_error: false });
    expect(r.status).toBe('idle');
    expect(stopped).toHaveLength(0);
    expect(getTurnOks()).toBe(1);
  });

  it('有后台任务且 limbo 超时后才发 onStopped', () => {
    vi.useFakeTimers();
    const { r, stopped } = makeRunner({ limboBusyMs: 2000 });
    r.handleMessage(init);
    r.handleMessage({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'u1', task_type: 'local_agent' });
    r.handleMessage({ type: 'result', is_error: true, result: 'API Error: 529 overloaded' });
    expect(stopped).toHaveLength(0);
    vi.advanceTimersByTime(2100);
    expect(r.status).toBe('idle');
    expect(stopped).toEqual([{ kind: 'transient', reason: 'API Error: 529 overloaded' }]);
  });

  it('用户中断（aborted_tools）不触发 onStopped，按未出错收尾（清掉自动重试轮的记录）', () => {
    const { r, stopped, getTurnOks } = makeRunner();
    r.handleMessage(init);
    r.handleMessage({ type: 'result', is_error: true, subtype: 'error_during_execution', terminal_reason: 'aborted_tools', result: 'interrupted' });
    expect(stopped).toHaveLength(0);
    expect(getTurnOks()).toBe(1);
  });

  it('空闲时异常退出不触发 onStopped', () => {
    const { anyR, stopped } = makeRunner();
    anyR._status = 'idle';
    anyR.onClose(1, undefined);
    expect(stopped).toHaveLength(0);
  });

  it('错误 result 后在 limbo 中进程退出：按暂存的额度错误登记', () => {
    vi.useFakeTimers();
    const { r, anyR, stopped } = makeRunner({ limboBusyMs: 60_000 });
    r.handleMessage(init);
    r.handleMessage({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000 } });
    r.handleMessage({ type: 'system', subtype: 'task_started', task_id: 'bg1', tool_use_id: 'u1', task_type: 'local_agent' });
    r.handleMessage({ type: 'result', is_error: true, result: "You've hit your 5-hour limit · resets 9pm" });
    expect(stopped).toHaveLength(0);
    anyR.onClose(1, undefined);
    expect(stopped).toEqual([{ kind: 'rate_limit', reason: "You've hit your 5-hour limit · resets 9pm", resetsAt: 1_900_000_000 }]);
  });

  it('非 intentional 异常退出触发 onStopped (transient)，intentional 退出不触发', () => {
    const { anyR, stopped } = makeRunner();
    anyR._status = 'running';
    anyR.onClose(1, undefined);
    expect(stopped).toHaveLength(1);
    expect(stopped[0]!.kind).toBe('transient');

    const r2 = makeRunner();
    r2.anyR._status = 'running';
    r2.anyR.intentional = true;
    r2.anyR.onClose(1, undefined);
    expect(r2.stopped).toHaveLength(0);
  });
});

// ───────────── Manager 自动重试与协议处理 ─────────────

interface FakeRunner {
  sessionId: string;
  cwd: string;
  alive: boolean;
  status: 'idle' | 'starting' | 'running' | 'exited';
  accountId: string | null;
  sent: { text: string; config: any }[];
  queue: QueueItem[];
  prompts: PendingPrompt[];
  send: (text: string, config: any) => void;
  queueItems: () => QueueItem[];
  promptItems: () => PendingPrompt[];
  snapshot: () => { status: 'idle' | 'starting' | 'running' | 'exited'; events: unknown[] };
  shutdown: () => void;
  killSync: () => void;
}

function makeFakeRunner(id: string, cwd: string): FakeRunner {
  const r: FakeRunner = {
    sessionId: id,
    cwd,
    alive: true,
    status: 'idle',
    accountId: null,
    sent: [],
    queue: [],
    prompts: [],
    send(text, config) {
      r.sent.push({ text, config });
      r.status = 'running';
    },
    queueItems: () => r.queue,
    promptItems: () => r.prompts,
    snapshot: () => ({ status: r.status, events: [] }),
    shutdown: () => { r.alive = false; },
    killSync: () => { r.alive = false; },
  };
  return r;
}

describe('Manager 错误停止与自动重试', () => {
  function setupManager(opts: { now?: () => number; retryPollMs?: number } = {}) {
    const store = new StateStore(path.join(dir, 'state.json'));
    const dots = new DotState(store);
    const stops = new StopStore(store, { now: opts.now });
    const sessions = { findCwd: async (id: string) => (id === SID ? dir : null) } as any;
    const m = new Manager({
      dots,
      sessions,
      stops,
      retryPollMs: opts.retryPollMs ?? 60_000,
      now: opts.now,
    });
    return { store, dots, stops, m, anyM: m as any };
  }

  it('到期且空闲时轮询发出重试消息，忙时跳过', async () => {
    vi.useFakeTimers();
    let now = 1_700_000_000_000;
    const { m, anyM, stops, dots } = setupManager({ now: () => now, retryPollMs: 1000 });
    const fake = makeFakeRunner(SID, dir);
    anyM.runners.set(SID, fake);
    anyM.cwdOf.set(SID, dir);

    // 写入一条即将到期的 transient 记录
    stops.set(SID, { kind: 'transient', reason: '529 overloaded', attempts: 0, state: 'waiting', retryAt: now + 500, at: now });

    // 未到期不触发
    await m.pollRetries();
    expect(fake.sent).toHaveLength(0);

    // 到期但 runner 正在运行 → 跳过
    now += 1000;
    fake.status = 'running';
    await m.pollRetries();
    expect(fake.sent).toHaveLength(0);

    // idle 但队列非空 → 跳过
    fake.status = 'idle';
    fake.queue = [{ id: MSG_ID, text: 'q', mode: 'later', at: now }];
    await m.pollRetries();
    expect(fake.sent).toHaveLength(0);
    fake.queue = [];

    // idle 但有待回应 prompt → 跳过
    fake.prompts = [{ kind: 'plan', id: 'p1', plan: 'p', at: now }];
    await m.pollRetries();
    expect(fake.sent).toHaveLength(0);
    fake.prompts = [];

    // idle 但有后台任务计数 → 跳过
    dots.setBackground(SID, 1, 'claude');
    await m.pollRetries();
    expect(fake.sent).toHaveLength(0);
    dots.setBackground(SID, 0, 'claude');

    // idle 但有运行中的委派任务 → 跳过
    const jobs = anyM.jobsFor(SID);
    const origList = jobs.list.bind(jobs);
    jobs.list = (): DelegateJobInfo[] => [{ toolUseId: 't1', conversationId: 'c1', description: 'd', background: true, state: 'running', startedAt: now, pending: 0, tail: '' }];
    await m.pollRetries();
    expect(fake.sent).toHaveLength(0);
    jobs.list = origList;

    // 全部空闲，定时器推进触发轮询 → 发出重试消息
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.text).toBe(retryPromptText('transient'));
    expect(stops.get(SID)).toEqual({
      kind: 'transient',
      reason: '529 overloaded',
      attempts: 1,
      state: 'retrying',
      at: now,
    });
    expect(stops.get(SID)?.retryAt).toBeUndefined();

    vi.useRealTimers();
    anyM.runners.delete(SID);
    await m.shutdown(100);
  });

  it('用户 send 清除停止记录，而自动重试不清除；重试成功（onTurnOk）后清除', async () => {
    let now = 1_700_000_000_000;
    const { m, anyM, stops } = setupManager({ now: () => now, retryPollMs: 60_000 });
    const fake = makeFakeRunner(SID, dir);
    anyM.runners.set(SID, fake);
    anyM.cwdOf.set(SID, dir);

    const clientMsgs: ServerMsg[] = [];
    const client = { send: (msg: ServerMsg) => clientMsgs.push(msg) };
    m.addClient(client);
    anyM.subs.set(SID, new Set([client]));

    // 自动重试不清除记录，转为 retrying
    stops.set(SID, { kind: 'rate_limit', reason: 'limit', attempts: 0, state: 'waiting', retryAt: now, at: now });
    await m.pollRetries();
    expect(stops.get(SID)?.state).toBe('retrying');
    expect(fake.sent[0]!.text).toBe(retryPromptText('rate_limit'));

    // 模拟重试成功（Runner onTurnOk hook）→ 清除记录并广播 stop: null
    const probeRunner = anyM.createRunner(SID, dir, false, cfg, true);
    probeRunner.hooks.onTurnOk();
    expect(stops.get(SID)).toBeNull();
    expect(clientMsgs.filter((x) => x.t === 'stop').at(-1)).toEqual({ t: 'stop', sessionId: SID, info: null });

    // 用户手动 send 清除记录
    fake.status = 'idle';
    stops.set(SID, { kind: 'fatal', reason: 'safeguards', attempts: 0, state: 'stopped', at: now });
    m.handle(client, { t: 'send', sessionId: SID, cwd: dir, isNew: false, text: 'hello', config: cfg, id: MSG_ID });
    expect(stops.get(SID)).toBeNull();

    await m.shutdown(100);
  });

  it('transient 累计自动重试 3 次仍失败 → gave_up；rate_limit 带新 resetsAt 不受 3 次限制', async () => {
    let now = 1_700_000_000_000;
    const { m, anyM, stops } = setupManager({ now: () => now, retryPollMs: 60_000 });
    const fake = makeFakeRunner(SID, dir);
    anyM.runners.set(SID, fake);
    anyM.cwdOf.set(SID, dir);

    // 初始失败
    anyM.onRunnerStopped(SID, { kind: 'transient', reason: '500' });
    expect(stops.get(SID)).toMatchObject({ state: 'waiting', attempts: 0, retryAt: now + 60_000 });

    // 第 1 次自动重试 → 失败 → 等待 5 分钟
    now += 60_000;
    await m.pollRetries();
    expect(stops.get(SID)).toMatchObject({ state: 'retrying', attempts: 1 });
    fake.status = 'idle';
    anyM.onRunnerStopped(SID, { kind: 'transient', reason: '500' });
    expect(stops.get(SID)).toMatchObject({ state: 'waiting', attempts: 1, retryAt: now + 5 * 60_000 });

    // 第 2 次自动重试 → 失败 → 等待 15 分钟
    now += 5 * 60_000;
    await m.pollRetries();
    expect(stops.get(SID)).toMatchObject({ state: 'retrying', attempts: 2 });
    fake.status = 'idle';
    anyM.onRunnerStopped(SID, { kind: 'transient', reason: '500' });
    expect(stops.get(SID)).toMatchObject({ state: 'waiting', attempts: 2, retryAt: now + 15 * 60_000 });

    // 第 3 次自动重试 → 失败 → gave_up（无 retryAt）
    now += 15 * 60_000;
    await m.pollRetries();
    expect(stops.get(SID)).toMatchObject({ state: 'retrying', attempts: 3 });
    fake.status = 'idle';
    anyM.onRunnerStopped(SID, { kind: 'transient', reason: '500' });
    expect(stops.get(SID)).toEqual({ kind: 'transient', reason: '500', attempts: 3, state: 'gave_up', at: now });

    // rate_limit 且拿到新 resetsAt：即使 attempts 已 >= 3 仍进入 waiting
    stops.set(SID, { kind: 'rate_limit', reason: 'limit', attempts: 3, state: 'retrying', at: now });
    const nextReset = Math.floor(now / 1000) + 3600;
    anyM.onRunnerStopped(SID, { kind: 'rate_limit', reason: 'limit again', resetsAt: nextReset });
    expect(stops.get(SID)).toMatchObject({
      kind: 'rate_limit',
      state: 'waiting',
      attempts: 3,
      retryAt: nextReset * 1000 + RATE_LIMIT_BUFFER_MS,
    });

    await m.shutdown(100);
  });

  it('subscribe 紧跟 status 补发 stop；retry.now 与 retry.cancel 正常工作', async () => {
    const now = 1_700_000_000_000;
    const { m, anyM, stops } = setupManager({ now: () => now, retryPollMs: 60_000 });
    const fake = makeFakeRunner(SID, dir);
    anyM.runners.set(SID, fake);
    anyM.cwdOf.set(SID, dir);

    const sent: ServerMsg[] = [];
    const client = { send: (msg: ServerMsg) => sent.push(msg) };
    m.addClient(client);

    // 无记录时 subscribe 紧跟 status 发 stop: null
    m.handle(client, { t: 'subscribe', sessionId: SID });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]).toEqual({ t: 'status', sessionId: SID, status: 'idle' });
    expect(sent[1]).toEqual({ t: 'stop', sessionId: SID, info: null });

    // 无记录时 retry.now 回 error
    sent.length = 0;
    m.handle(client, { t: 'retry.now', sessionId: SID });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.some((x) => x.t === 'error')).toBe(true);

    // 有记录时 subscribe 紧跟 status 发该记录
    const info: StopInfo = { kind: 'transient', reason: '500', attempts: 0, state: 'waiting', retryAt: now + 60_000, at: now };
    stops.set(SID, info);
    sent.length = 0;
    m.handle(client, { t: 'subscribe', sessionId: SID });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent[0]).toEqual({ t: 'status', sessionId: SID, status: 'idle' });
    expect(sent[1]).toEqual({ t: 'stop', sessionId: SID, info });

    // retry.cancel：state 改 stopped 且去掉 retryAt
    m.handle(client, { t: 'retry.cancel', sessionId: SID });
    expect(stops.get(SID)).toEqual({ kind: 'transient', reason: '500', attempts: 0, state: 'stopped', at: now });

    // retry.now：对 fatal 用【重试】文案
    stops.set(SID, { kind: 'fatal', reason: 'safeguards', attempts: 0, state: 'stopped', at: now });
    m.handle(client, { t: 'retry.now', sessionId: SID });
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.text).toBe(retryPromptText('fatal'));
    expect(stops.get(SID)?.state).toBe('retrying');

    // 会话忙时 retry.now 回 error
    sent.length = 0;
    m.handle(client, { t: 'retry.now', sessionId: SID });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.some((x) => x.t === 'error')).toBe(true);

    await m.shutdown(100);
  });

  it('服务重启恢复：执行中会话补记 interrupted 并标未读，inflight 清空', async () => {
    const file = path.join(dir, 'state.json');
    const store1 = new StateStore(file);
    const dots1 = new DotState(store1);
    const stops1 = new StopStore(store1);
    const sessions = { findCwd: async () => null } as any;
    const m1 = new Manager({ dots: dots1, sessions, stops: stops1, retryPollMs: 60_000 });
    const runner1 = (m1 as any).createRunner(SID, dir, false, cfg, true);
    (m1 as any).runners.set(SID, runner1);

    // 进入执行中 → 写入 inflight
    runner1.hooks.onStatus('running');
    expect(store1.state.inflight[SID]?.cwd).toBe(dir);
    await store1.idle();
    (m1 as any).runners.delete(SID);
    await m1.shutdown(100);

    // 用同一 state.json 模拟服务重启
    const T_BOOT = 1_700_000_050_000;
    const store2 = new StateStore(file);
    const dots2 = new DotState(store2);
    const stops2 = new StopStore(store2, { now: () => T_BOOT });
    const m2 = new Manager({ dots: dots2, sessions, stops: stops2, retryPollMs: 60_000, now: () => T_BOOT });

    expect(stops2.get(SID)).toEqual({
      kind: 'interrupted',
      reason: '服务重启，这一轮没有执行完',
      attempts: 0,
      state: 'stopped',
      at: T_BOOT,
    });
    expect(dots2.dot(SID)).toBe('unread');
    expect(m2.knownCwd(SID)).toBe(dir);
    expect(store2.state.inflight).toEqual({});

    await store2.idle();
    await m2.shutdown(100);
  });

  it('服务重启恢复：已有 retrying 记录时保持 waiting 不被 interrupted 覆盖，同时标未读', async () => {
    const file = path.join(dir, 'state.json');
    const store1 = new StateStore(file);
    const dots1 = new DotState(store1);
    const stops1 = new StopStore(store1);
    stops1.set(SID, { kind: 'transient', reason: '529 overloaded', attempts: 1, state: 'retrying', at: 1000 });
    dots1.markInflight(SID, dir);
    await store1.idle();

    const T_BOOT = 20_000;
    const store2 = new StateStore(file);
    const dots2 = new DotState(store2);
    const stops2 = new StopStore(store2, { now: () => T_BOOT });
    const m2 = new Manager({ dots: dots2, sessions: { findCwd: async () => null } as any, stops: stops2, retryPollMs: 60_000, now: () => T_BOOT });

    expect(stops2.get(SID)).toEqual({
      kind: 'transient',
      reason: '529 overloaded',
      attempts: 1,
      state: 'waiting',
      retryAt: T_BOOT + RECOVER_RETRY_DELAY_MS,
      at: 1000,
    });
    expect(dots2.dot(SID)).toBe('unread');
    expect(store2.state.inflight).toEqual({});

    await store2.idle();
    await m2.shutdown(100);
  });

  it('正常结束（idle，非 shuttingDown）清除 inflight，重启后无中断记录', async () => {
    const file = path.join(dir, 'state.json');
    const store1 = new StateStore(file);
    const dots1 = new DotState(store1);
    const stops1 = new StopStore(store1);
    const sessions = { findCwd: async () => null } as any;
    const m1 = new Manager({ dots: dots1, sessions, stops: stops1, retryPollMs: 60_000 });
    const runner1 = (m1 as any).createRunner(SID, dir, false, cfg, true);
    (m1 as any).runners.set(SID, runner1);

    runner1.hooks.onStatus('running');
    expect(store1.state.inflight[SID]).toBeDefined();
    runner1.hooks.onStatus('idle');
    expect(store1.state.inflight[SID]).toBeUndefined();
    await store1.idle();
    (m1 as any).runners.delete(SID);
    await m1.shutdown(100);

    const store2 = new StateStore(file);
    const dots2 = new DotState(store2);
    const stops2 = new StopStore(store2);
    const m2 = new Manager({ dots: dots2, sessions, stops: stops2, retryPollMs: 60_000 });

    expect(stops2.get(SID)).toBeNull();
    expect(dots2.dot(SID)).toBeNull();
    await m2.shutdown(100);
  });

  it('shuttingDown 期间或被替换旧 runner 变 idle 不清除 inflight 标记', async () => {
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file);
    const dots = new DotState(store);
    const stops = new StopStore(store);
    const m = new Manager({ dots, sessions: { findCwd: async () => null } as any, stops, retryPollMs: 60_000 });
    const anyM = m as any;
    const oldRunner = anyM.createRunner(SID, dir, false, cfg, true);
    const newRunner = anyM.createRunner(SID, dir, false, cfg, true);

    anyM.runners.set(SID, oldRunner);
    oldRunner.hooks.onStatus('running');
    expect(store.state.inflight[SID]).toBeDefined();

    // 被新 runner 替换后，旧 runner 变 idle 不清标记
    anyM.runners.set(SID, newRunner);
    oldRunner.hooks.onStatus('idle');
    expect(store.state.inflight[SID]).toBeDefined();

    // shuttingDown=true 时当前 runner 变 idle 不清标记
    anyM.shuttingDown = true;
    newRunner.hooks.onStatus('idle');
    expect(store.state.inflight[SID]).toBeDefined();
    anyM.shuttingDown = false;

    await store.idle();
    anyM.runners.delete(SID);
    await m.shutdown(100);
  });

  it('retryPromptText(interrupted) 返回重试文案，workspaces sanitize 保留 interrupted 与 inflight', () => {
    const prompt = retryPromptText('interrupted');
    expect(prompt).toContain('服务重启');
    expect(prompt).toContain('重试');

    const file = path.join(dir, 'state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        stops: {
          [SID]: { kind: 'interrupted', reason: '服务重启，这一轮没有执行完', attempts: 0, state: 'stopped', at: 1234 },
        },
        inflight: {
          [SID]: { cwd: dir, at: 5678 },
          [SID2]: { cwd: dir, at: 9999 },
          '../bad': { cwd: dir, at: 1 },
        },
        deleted: {
          [SID2]: { cwd: dir, title: 'deleted', deletedAt: 100 },
        },
      }),
      'utf8',
    );
    const store = new StateStore(file);
    expect(store.state.stops[SID]).toEqual({
      kind: 'interrupted',
      reason: '服务重启，这一轮没有执行完',
      attempts: 0,
      state: 'stopped',
      at: 1234,
    });
    expect(store.state.inflight).toEqual({
      [SID]: { cwd: dir, at: 5678 },
    });
  });
});
