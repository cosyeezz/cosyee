import { afterEach, describe, expect, it, vi } from 'vitest';
import { Runner, buildArgs, validateConfig } from './claude/runner.js';

type Json = Record<string, any>;

/** 造一个带假进程的 Runner：不 spawn，只用 handleMessage 喂消息。 */
function make(timings: Record<string, number> = {}) {
  const log = { status: [] as string[], events: [] as any[], turnEnds: 0, exits: 0, settings: [] as any[] };
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

  it('排队的消息：第一个 result 不结束，第二个 result 才 idle', () => {
    const { r, anyR, log } = make();
    r.handleMessage(init);
    anyR.queued = 1; // 运行中又发了一条
    r.handleMessage(result);
    expect(r.status).toBe('running');
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
    const { r, anyR } = make();
    r.handleMessage(init);
    anyR.queued = 2;
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
