import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PATH_PROMPT, Runner, buildArgs, validateConfig } from './claude/runner.js';

type Json = Record<string, any>;

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures');

/** 造一个带假进程的 Runner：不 spawn，只用 handleMessage 喂消息。 */
function make(timings: Record<string, number> = {}) {
  const log = { status: [] as string[], events: [] as any[], turnEnds: 0, exits: 0, settings: [] as any[], queues: [] as any[][] };
  const writes: Json[] = [];
  const r = new Runner({
    sessionId: '11111111-2222-4333-8444-555555555555',
    cwd: process.cwd(),
    isNew: true,
    config: { model: 'haiku', effort: 'low' },
    timings: { idleMs: 60_000, limboQuietMs: 1000, limboBusyMs: 5000, interruptKillMs: 500, requestTimeoutMs: 1000, ...timings },
    hooks: {
      onEvent: (e) => log.events.push(e),
      onStatus: (s) => log.status.push(s),
      onSettings: (a) => log.settings.push(a),
      onQueue: (items) => log.queues.push(items),
      onTurnEnd: () => log.turnEnds++,
      onExit: () => log.exits++,
    },
  });
  const anyR = r as any;
  anyR.proc = {
    pid: undefined,
    stdin: { writable: true, destroyed: false, write: (s: string) => writes.push(JSON.parse(s)), end() {} },
  };
  return { r, anyR, log, writes };
}

const cfg = { model: 'haiku', effort: 'low' } as const;
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const life = (id: string, state: string) => ({ type: 'command_lifecycle', command_uuid: id, state });
const echo = (id: string, text = 'x') => ({ type: 'user', message: { role: 'user', content: text }, uuid: id, isReplay: true });
/** 等 send 内部的串行写入链跑完 */
const flush = () => new Promise((res) => setTimeout(res, 0));
/** 给最近一个 subtype 的 control_request 回成功响应 */
function respond(r: Runner, writes: Json[], subtype: string, response: Json): void {
  const req = [...writes].reverse().find((w) => w.type === 'control_request' && w.request?.subtype === subtype);
  if (!req) throw new Error('没有找到 control_request ' + subtype);
  r.handleMessage({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response } });
}
/** 读 shared/fixtures 里的 stdout 帧 */
function fixture(name: string): Json[] {
  return fs.readFileSync(path.join(FIX, name + '.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
/** 读 spike 里记录的 stdin：按发送顺序的 user 消息 uuid */
function sentUuids(name: string): string[] {
  const sent = JSON.parse(fs.readFileSync(path.join(FIX, '../../spike', name + '.sent.json'), 'utf8')) as { o: Json }[];
  return sent.filter((x) => x.o.type === 'user').map((x) => x.o.uuid);
}
const users = (events: any[]) => events.filter((e) => e.type === 'cosyee_user');

const init = { type: 'system', subtype: 'init' };
const asst = { type: 'assistant', message: { content: [] } };
const result = { type: 'result', subtype: 'success' };

afterEach(() => vi.useRealTimers());

describe('buildArgs / validateConfig', () => {
  it('新会话用 --session-id，恢复用 --resume', () => {
    const a = buildArgs('sid', true, { model: 'haiku', effort: 'low' });
    expect(a).toContain('--session-id');
    expect(a).not.toContain('--resume');
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 4)).toEqual(['--model', 'haiku', '--effort', 'low']);
    expect(a).toContain('--dangerously-skip-permissions');
    const b = buildArgs('sid', false, { model: 'sonnet', effort: 'high', ultracode: true });
    expect(b.slice(-2)).toEqual(['--resume', 'sid']);
    expect(b).toContain('--settings');
    expect(a).not.toContain('--settings');
    const c = buildArgs('sid', true, { model: 'haiku', effort: 'low', ultracode: true }, { skillOverrides: { pdf: 'off' } });
    expect(JSON.parse(c[c.indexOf('--settings') + 1]!)).toEqual({ skillOverrides: { pdf: 'off' }, ultracode: true });
  });
  it('新建与恢复都追加路径引用约定（Markdown 链接）', () => {
    for (const isNew of [true, false]) {
      const a = buildArgs('sid', isNew, { model: 'haiku', effort: 'low' });
      expect(a[a.indexOf('--append-system-prompt') + 1]).toBe(PATH_PROMPT);
    }
    expect(PATH_PROMPT).toContain('[filename](path)');
  });
  it('非法配置抛错', () => {
    expect(() => validateConfig({ model: 'a b', effort: 'low' })).toThrow();
    expect(() => validateConfig({ model: 'haiku', effort: 'huge' as any })).toThrow();
    expect(() => validateConfig({ model: 'claude-haiku-5-5', effort: 'max' })).not.toThrow();
  });
});

describe('Runner 回合状态机', () => {
  it('idle 时收到 init 视作新一轮，result 后回 idle 并清空缓冲', () => {
    const { r, log } = make();
    r.handleMessage(init);
    expect(r.status).toBe('running');
    r.handleMessage(asst);
    expect(r.snapshot().events).toHaveLength(2);
    r.handleMessage(result);
    expect(r.status).toBe('idle');
    expect(log.turnEnds).toBe(1);
    expect(r.snapshot().events).toHaveLength(0);
    expect(log.status).toEqual(['running', 'idle']);
    expect(log.events).toHaveLength(3);
  });

  it('starting 状态下第一个事件切到 running', () => {
    const { r, anyR, log } = make();
    anyR._status = 'starting';
    r.handleMessage(init);
    expect(log.status).toEqual(['running']);
  });

  it('control_response 不当作事件广播，也不改变状态', () => {
    const { r, log } = make();
    r.handleMessage({ type: 'control_response', response: { subtype: 'success', request_id: 'x', response: {} } });
    expect(log.events).toHaveLength(0);
    expect(r.status).toBe('idle');
  });

  it('CLI 反向 control_request 统一回错误', () => {
    const { r, writes } = make();
    r.handleMessage({ type: 'control_request', request_id: 'q1', request: { subtype: 'can_use_tool' } });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.response).toMatchObject({ subtype: 'error', request_id: 'q1' });
  });

  it('后台任务未完成：result 后保持 running，任务结束后续轮再 result 才 idle', () => {
    const { r, log } = make();
    r.handleMessage(init);
    r.handleMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] });
    r.handleMessage(result);
    expect(r.status).toBe('running');
    expect(log.turnEnds).toBe(0);
    // CLI 在子代理完成后自动续轮
    r.handleMessage({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
    r.handleMessage(init);
    r.handleMessage(asst);
    r.handleMessage(result);
    expect(r.status).toBe('idle');
    expect(log.turnEnds).toBe(1);
  });

  it('后台任务 task_started / task_updated 也被跟踪', () => {
    const { r } = make();
    r.handleMessage(init);
    r.handleMessage({ type: 'system', subtype: 'task_started', task_id: 't9', tool_use_id: 'x' });
    r.handleMessage(result);
    expect(r.status).toBe('running');
    r.handleMessage({ type: 'system', subtype: 'task_updated', task_id: 't9', patch: { status: 'completed' } });
    r.handleMessage(init);
    r.handleMessage(result);
    expect(r.status).toBe('idle');
  });

  it('limbo 兜底：后台任务一直没动静，超时后结束本轮', () => {
    vi.useFakeTimers();
    const { r, log } = make({ limboBusyMs: 3000 });
    r.handleMessage(init);
    r.handleMessage({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 't1' }] });
    r.handleMessage(result);
    vi.advanceTimersByTime(2000);
    expect(r.status).toBe('running');
    // 期间有输出会重新计时
    r.handleMessage({ type: 'system', subtype: 'task_progress', task_id: 't1' });
    vi.advanceTimersByTime(2000);
    expect(r.status).toBe('running');
    vi.advanceTimersByTime(1500);
    expect(r.status).toBe('idle');
    expect(log.turnEnds).toBe(1);
  });

  it('排队的消息：第一个 result 不结束，等 lifecycle started 后第二个 result 才 idle', () => {
    const { r, log } = make();
    r.send('m1', cfg, U1);
    r.send('m2', cfg, U2, 'later'); // 运行中又发了一条
    r.handleMessage(init);
    r.handleMessage(result);
    expect(r.status).toBe('running');
    expect(log.turnEnds).toBe(0);
    r.handleMessage(life(U2, 'started'));
    r.handleMessage(init);
    r.handleMessage(result);
    expect(r.status).toBe('idle');
    expect(log.turnEnds).toBe(1);
  });

  it('interrupt 后的 result（error_during_execution）直接收尾，进程仍然在', () => {
    const { r, anyR, log, writes } = make();
    r.handleMessage(init);
    r.interrupt();
    expect(writes[0]!.request).toEqual({ subtype: 'interrupt' });
    expect(anyR.interrupting).toBe(true);
    r.handleMessage({ type: 'result', subtype: 'error_during_execution' });
    expect(r.status).toBe('idle');
    expect(log.turnEnds).toBe(1);
    expect(r.alive).toBe(true);
    expect(anyR.interrupting).toBe(false);
  });

  it('idle 时 interrupt 无效', () => {
    const { r, writes } = make();
    r.interrupt();
    expect(writes).toHaveLength(0);
  });

  it('有排队消息时 interrupt 不被 limbo 拖住', () => {
    const { r } = make();
    r.send('m1', cfg, U1);
    r.send('m2', cfg, U2, 'later');
    r.send('m3', cfg, U3, 'later');
    r.handleMessage(init);
    r.interrupt();
    r.handleMessage({ type: 'result', subtype: 'error_during_execution' });
    expect(r.status).toBe('idle');
  });
});

describe('Runner 设置与请求', () => {
  it('get_settings 的 applied 只取四个字段', async () => {
    const { r, log, writes } = make();
    const p = r.refreshSettings();
    const id = writes[0]!.request_id;
    r.handleMessage({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response: { applied: { model: 'claude-haiku-5-5', effort: 'low', ultracode: false, ultracodeAvailable: false, apiKey: 'secret' }, other: 1 },
      },
    });
    await p;
    expect(log.settings).toEqual([{ model: 'claude-haiku-5-5', effort: 'low', ultracode: false, ultracodeAvailable: false }]);
  });

  it('启动时开启思考摘要：只发 thinking_display，不改思考预算', () => {
    const { anyR, writes } = make();
    anyR.enableThinkingSummaries();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ type: 'control_request', request: { subtype: 'set_max_thinking_tokens', thinking_display: 'summarized' } });
    expect(writes[0]!.request).not.toHaveProperty('max_thinking_tokens');
  });

  it('旧版 CLI 不支持思考摘要时回错误：静默忽略，不影响后续', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { r, anyR, writes } = make();
    anyR.enableThinkingSummaries();
    r.handleMessage({
      type: 'control_response',
      response: { subtype: 'error', request_id: writes[0]!.request_id, error: 'Unsupported control request subtype', error_code: 'unsupported_request' },
    });
    await new Promise((res) => setTimeout(res, 0));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('idle');
    warn.mockRestore();
  });

  it('request 在进程不在时直接失败', async () => {
    const { r, anyR } = make();
    anyR.proc = null;
    await expect(r.request('get_context_usage')).rejects.toThrow();
  });
});

describe('排队消息（steering / follow-up / 撤回 / 立即发送 / 回退）', () => {
  it('空闲时发送：带 uuid、不带 priority，立即发 cosyee_user mode:start，回显与 lifecycle 不转发', async () => {
    const { r, log, writes } = make();
    r.send('hi', cfg, U1, 'later'); // 空闲时 mode 被忽略
    await flush();
    expect(users(log.events)).toEqual([{ type: 'cosyee_user', text: 'hi', at: expect.any(Number), id: U1, mode: 'start' }]);
    const w = writes.find((x) => x.type === 'user')!;
    expect(w.uuid).toBe(U1);
    expect(w).not.toHaveProperty('priority');
    r.handleMessage(life(U1, 'queued'));
    r.handleMessage(life(U1, 'started'));
    r.handleMessage(init);
    r.handleMessage(echo(U1, 'hi'));
    expect(log.events.map((e) => e.type)).toEqual(['cosyee_user', 'system']);
    expect(log.queues).toEqual([]);
  });

  it('运行中发送：写入带 priority（缺省 next），进排队列表，不发 cosyee_user', async () => {
    const { r, log, writes } = make();
    r.send('m1', cfg, U1);
    r.handleMessage(init);
    r.send('m2', cfg, U2);
    r.send('m3', cfg, U3, 'later');
    await flush();
    const ws = writes.filter((x) => x.type === 'user');
    expect(ws.map((x) => [x.uuid, x.priority])).toEqual([[U1, undefined], [U2, 'next'], [U3, 'later']]);
    expect(users(log.events)).toHaveLength(1);
    expect(r.queueItems().map((q) => [q.id, q.text, q.mode])).toEqual([[U2, 'm2', 'next'], [U3, 'm3', 'later']]);
    expect(log.queues).toHaveLength(2);
  });

  it('A steering：回显时发 cosyee_user mode:next，lifecycle 移出队列，一个 result 后 idle', () => {
    const [u1, u2] = sentUuids('queue-a') as [string, string];
    const { r, log } = make();
    r.send('M1', cfg, u1);
    r.send('M2 steer', cfg, u2, 'next');
    expect(r.queueItems()).toHaveLength(1);
    let userAtEcho = -1;
    for (const m of fixture('queue-a')) {
      r.handleMessage(m);
      if (m.type === 'user' && m.isReplay && m.uuid === u2) userAtEcho = users(log.events).length;
    }
    expect(userAtEcho).toBe(2); // 回显那一刻就发出了
    const us = users(log.events);
    expect(us.map((u) => [u.text, u.id, u.mode])).toEqual([['M1', u1, 'start'], ['M2 steer', u2, 'next']]);
    expect(log.events.some((e) => e.type === 'command_lifecycle' || e.isReplay)).toBe(false);
    expect(r.queueItems()).toEqual([]);
    expect(log.queues.at(-1)).toEqual([]);
    expect(log.events.filter((e) => e.type === 'result')).toHaveLength(1);
    expect(r.status).toBe('idle');
    expect(log.turnEnds).toBe(1);
    expect(log.status).toEqual(['running', 'idle']);
  });

  it('B follow-up：两个 result 之间不回 idle，started 时发 cosyee_user mode:later 并开新一轮', () => {
    const [u1, u2] = sentUuids('queue-b') as [string, string];
    const { r, log } = make();
    r.send('M1', cfg, u1);
    r.send('M2 later', cfg, u2, 'later');
    const frames = fixture('queue-b');
    const firstResult = frames.findIndex((m) => m.type === 'result');
    for (const m of frames.slice(0, firstResult + 1)) r.handleMessage(m);
    expect(r.status).toBe('running');
    expect(log.turnEnds).toBe(0);
    expect(r.queueItems().map((q) => q.id)).toEqual([u2]);
    for (const m of frames.slice(firstResult + 1)) {
      r.handleMessage(m);
      if (m.type === 'command_lifecycle' && m.state === 'started') {
        // 第二轮开始：缓冲已清空，只剩 cosyee_user
        expect(r.snapshot().events.map((e: any) => e.type)).toEqual(['cosyee_user']);
      }
    }
    expect(users(log.events).map((u) => [u.id, u.mode])).toEqual([[u1, 'start'], [u2, 'later']]);
    expect(log.status).toEqual(['running', 'idle']);
    expect(log.turnEnds).toBe(1);
    expect(r.queueItems()).toEqual([]);
  });

  it('started 之后到的回显不会重复发 cosyee_user', () => {
    const { r, log } = make();
    r.send('M1', cfg, U1);
    r.send('M2', cfg, U2, 'later');
    r.handleMessage(init);
    r.handleMessage(result);
    r.handleMessage(life(U2, 'started'));
    r.handleMessage(init);
    r.handleMessage(echo(U2, 'M2'));
    expect(users(log.events)).toHaveLength(2);
  });

  it('D 撤回：cancel_async_message 成功返回原文，队列移除，随后 result 直接 idle', async () => {
    const [u1, u2] = sentUuids('queue-d') as [string, string];
    const { r, log, writes } = make();
    r.send('M1', cfg, u1);
    r.send('M2 later', cfg, u2, 'later');
    const frames = fixture('queue-d');
    const cancelledAt = frames.findIndex((m) => m.type === 'command_lifecycle' && m.state === 'cancelled');
    for (const m of frames.slice(0, cancelledAt - 1)) r.handleMessage(m); // 到 queued(M2) 之前
    r.handleMessage(frames[cancelledAt - 1]!); // queued(M2)
    expect(r.queueItems()).toHaveLength(1);
    const p = r.cancelQueued(u2);
    await flush();
    expect(writes.at(-1)!.request).toEqual({ subtype: 'cancel_async_message', message_uuid: u2 });
    r.handleMessage(frames[cancelledAt]!); // cancelled（先于 control_response）
    expect(r.queueItems()).toEqual([]);
    respond(r, writes, 'cancel_async_message', { cancelled: true, message_uuid: u2 });
    expect(await p).toEqual({ ok: true, text: 'M2 later' });
    for (const m of frames.slice(cancelledAt + 1)) {
      if (m.type === 'control_response') continue; // 已手动回复
      r.handleMessage(m);
    }
    expect(users(log.events)).toHaveLength(1);
    expect(r.status).toBe('idle');
    expect(log.queues.at(-1)).toEqual([]);
  });

  it('撤回失败（cancelled:false）：ok:false，队列不变', async () => {
    const { r, writes } = make();
    r.send('M1', cfg, U1);
    r.send('M2', cfg, U2, 'later');
    const p = r.cancelQueued(U2);
    await flush();
    respond(r, writes, 'cancel_async_message', { cancelled: false });
    expect(await p).toEqual({ ok: false });
    expect(r.queueItems()).toHaveLength(1);
  });

  it('只剩被撤回的消息在等续轮时（limbo），撤回后本轮收尾', () => {
    const { r, log } = make();
    r.send('M1', cfg, U1);
    r.send('M2', cfg, U2, 'later');
    r.handleMessage(init);
    r.handleMessage(result);
    expect(r.status).toBe('running');
    r.handleMessage(life(U2, 'cancelled'));
    expect(r.status).toBe('idle');
    expect(log.turnEnds).toBe(1);
  });

  it('E send_now：发 interrupt{send_now}，被中断的 result 不当错误，下一轮 cosyee_user 发出', async () => {
    const [u1, u2] = sentUuids('queue-e') as [string, string];
    const { r, log, writes } = make();
    r.send('M1', cfg, u1);
    r.send('M2 now', cfg, u2, 'later');
    const frames = fixture('queue-e');
    const ctl = frames.findIndex((m) => m.type === 'control_response');
    for (const m of frames.slice(0, ctl)) r.handleMessage(m);
    const p = r.sendNow(u2);
    await flush();
    expect(writes.at(-1)!.request).toEqual({ subtype: 'interrupt', send_now: true, message_uuid: u2 });
    respond(r, writes, 'interrupt', { still_queued: [u2], send_now: 'stopped' });
    expect(await p).toEqual({ ok: true, state: 'stopped' });
    const abortedAt = frames.findIndex((m) => m.type === 'result');
    for (const m of frames.slice(ctl + 1, abortedAt + 1)) r.handleMessage(m);
    // 被中断那一轮的 result：转发给前端，但状态仍是 running（下一轮紧接着开始），也没有 error
    const res = log.events.find((e) => e.type === 'result')!;
    expect(res.terminal_reason).toBe('aborted_tools');
    expect(r.status).toBe('running');
    expect(log.turnEnds).toBe(0);
    expect(r.queueItems()).toHaveLength(1);
    for (const m of frames.slice(abortedAt + 1)) {
      if (m.type === 'control_response') continue;
      r.handleMessage(m);
    }
    expect(users(log.events).map((u) => [u.id, u.mode])).toEqual([[u1, 'start'], [u2, 'later']]);
    expect(log.status).toEqual(['running', 'idle']);
    expect(log.status).not.toContain('error');
    expect(log.turnEnds).toBe(1);
    expect(r.queueItems()).toEqual([]);
  });

  it('send_now 时消息已不在排队：nothing_waiting → ok:false', async () => {
    const { r, writes } = make();
    const p = r.sendNow(U2);
    await flush();
    respond(r, writes, 'interrupt', { still_queued: [], send_now: 'nothing_waiting' });
    expect(await p).toEqual({ ok: false, state: 'nothing_waiting' });
  });

  it('rewind 执行中：带 interrupt_if_running，中断 result 直接收尾，成功后清空排队列表', async () => {
    const { r, log, writes } = make();
    r.send('M1', cfg, U1);
    r.send('M2', cfg, U2, 'later');
    r.handleMessage(init);
    const p = r.rewind(U1);
    await flush();
    expect(writes.at(-1)!.request).toEqual({ subtype: 'rewind_conversation', target_message_uuid: U1, interrupt_if_running: true });
    // 中断序列先于响应到达；排队里还有 M2，但回退要中断一切，不等续轮
    r.handleMessage({ type: 'result', subtype: 'error_during_execution', terminal_reason: 'aborted_tools', is_error: true });
    expect(r.status).toBe('idle');
    respond(r, writes, 'rewind_conversation', { rewound: true, targetMessageUuid: U1, prefillText: 'M1' });
    expect(await p).toMatchObject({ rewound: true, prefillText: 'M1' });
    expect(r.queueItems()).toEqual([]);
    expect(log.turnEnds).toBe(1);
  });

  it('rewind 空闲时：不带 interrupt_if_running；失败返回内层错误', async () => {
    const { r, writes } = make();
    const p = r.rewind(U1);
    await flush();
    expect(writes.at(-1)!.request).toEqual({ subtype: 'rewind_conversation', target_message_uuid: U1 });
    respond(r, writes, 'rewind_conversation', { rewound: false, error: 'target not found', reason: 'target_not_found' });
    expect(await p).toMatchObject({ rewound: false, reason: 'target_not_found' });
  });

  it('进程退出时清空排队列表', () => {
    const { r, anyR, log } = make();
    r.send('M1', cfg, U1);
    r.send('M2', cfg, U2, 'later');
    anyR.onClose(1, undefined);
    expect(r.queueItems()).toEqual([]);
    expect(log.queues.at(-1)).toEqual([]);
  });
});
