import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_AGENTS } from './delegate/agents.js';
import type { DelegateBackend } from './delegate/backend.js';
import { CosyeeMcp, DELEGATE_TOOL_NAMES } from './delegate/mcp.js';
import { DelegateJobs } from './delegate/jobs.js';
import { removePrivateSettings, writePrivateSettings } from './claude/bin.js';
import { DELEGATE_PROMPT, PATH_PROMPT, Runner, buildArgs, cliPermissionMode, isDenied, validateConfig } from './claude/runner.js';

type Json = Record<string, any>;

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures');

/** 造一个带假进程的 Runner：不 spawn，只用 handleMessage 喂消息。 */
function make(timings: Record<string, number> = {}) {
  const log = { status: [] as string[], events: [] as any[], turnEnds: 0, exits: 0, settings: [] as any[], queues: [] as any[][], prompts: [] as any[][] };
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
      onPrompts: (items) => log.prompts.push(items),
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

describe('writePrivateSettings', () => {
  it.skipIf(process.platform === 'win32')('目录 0700、文件 0600，用完删掉', () => {
    const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'cosyee-run-'));
    vi.stubEnv('COSYEE_HOME', home);
    try {
      const f = writePrivateSettings('t', { env: { ANTHROPIC_API_KEY: 'sk-x' } });
      expect(fs.statSync(path.dirname(f)).mode & 0o777).toBe(0o700);
      expect(fs.statSync(f).mode & 0o777).toBe(0o600);
      expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-x' } });
      removePrivateSettings(f);
      expect(fs.existsSync(f)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('buildArgs / validateConfig', () => {
  it('新会话用 --session-id，恢复用 --resume', () => {
    const a = buildArgs('sid', true, { model: 'haiku', effort: 'low' });
    expect(a).toContain('--session-id');
    expect(a).not.toContain('--resume');
    expect(a.slice(a.indexOf('--model'), a.indexOf('--model') + 4)).toEqual(['--model', 'haiku', '--effort', 'low']);
    expect(a).not.toContain('--dangerously-skip-permissions');
    expect(a).toContain('--allow-dangerously-skip-permissions');
    const b = buildArgs('sid', false, { model: 'sonnet', effort: 'high', ultracode: true });
    expect(b.slice(-2)).toEqual(['--resume', 'sid']);
    expect(b).toContain('--settings');
    expect(a).not.toContain('--settings');
    const c = buildArgs('sid', true, { model: 'haiku', effort: 'low', ultracode: true }, { skillOverrides: { pdf: 'off' } });
    expect(JSON.parse(c[c.indexOf('--settings') + 1]!)).toEqual({ skillOverrides: { pdf: 'off' }, ultracode: true });
  });
  it('给了 settingsFile 时 --settings 传文件路径而不是 JSON（含密钥的 env 不上命令行）', () => {
    let got: Record<string, unknown> | null = null;
    const a = buildArgs('sid', true, { model: 'haiku', effort: 'low' }, { env: { ANTHROPIC_API_KEY: 'sk-secret' } }, {
      settingsFile: (st) => {
        got = st;
        return '/tmp/private.json';
      },
    });
    expect(a[a.indexOf('--settings') + 1]).toBe('/tmp/private.json');
    expect(a.join(' ')).not.toContain('sk-secret');
    expect(got).toEqual({ env: { ANTHROPIC_API_KEY: 'sk-secret' } });
  });
  it('新建与恢复、任意模型都只追加路径引用约定；没有委派就不加分工提示', () => {
    for (const isNew of [true, false]) {
      for (const model of ['opus', 'sonnet', 'claude-haiku-5-5']) {
        const a = buildArgs('sid', isNew, { model, effort: 'low' });
        const p = a[a.indexOf('--append-system-prompt') + 1]!;
        expect(p).toBe(PATH_PROMPT);
        expect(p).not.toMatch(/[\r\n]/); // .cmd 经 cmd.exe 转发时换行会截断命令行
      }
    }
    expect(PATH_PROMPT).toContain('[filename](path)');
    expect(PATH_PROMPT).not.toMatch(/delegat|subagent|sonnet/i);
  });
  it('权限模式：缺省 / auto 为 bypassPermissions，plan 为 plan；始终带 --permission-prompt-tool stdio', () => {
    const val = (a: string[], f: string) => a[a.indexOf(f) + 1];
    for (const c of [{ model: 'haiku', effort: 'low' }, { model: 'haiku', effort: 'low', permissionMode: 'auto' }] as const) {
      const a = buildArgs('sid', true, c);
      expect(val(a, '--permission-mode')).toBe('bypassPermissions');
      expect(val(a, '--permission-prompt-tool')).toBe('stdio');
    }
    const p = buildArgs('sid', false, { model: 'haiku', effort: 'low', permissionMode: 'plan' });
    expect(val(p, '--permission-mode')).toBe('plan');
    expect(val(p, '--permission-prompt-tool')).toBe('stdio');
    expect(cliPermissionMode('plan')).toBe('plan');
    expect(cliPermissionMode()).toBe('bypassPermissions');
  });
  it('非法 permissionMode 抛错', () => {
    expect(() => validateConfig({ model: 'haiku', effort: 'low', permissionMode: 'yolo' as any })).toThrow();
    expect(() => validateConfig({ model: 'haiku', effort: 'low', permissionMode: 'plan' })).not.toThrow();
    expect(() => validateConfig({ model: 'haiku', effort: 'low', permissionMode: 'auto' })).not.toThrow();
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

  it('空闲时的零散事件（切权限模式的 system/status）照常广播但不进缓冲', () => {
    const { r, log } = make();
    r.handleMessage(init);
    r.handleMessage(result);
    r.handleMessage({ type: 'system', subtype: 'status', status: null, permissionMode: 'plan' });
    expect(r.status).toBe('idle');
    expect(log.events).toHaveLength(3);
    expect(r.snapshot().events).toHaveLength(0);
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

  it('CLI 其它反向 control_request（hook / mcp 等）统一回错误', () => {
    const { r, writes } = make();
    r.handleMessage({ type: 'control_request', request_id: 'q1', request: { subtype: 'hook_callback' } });
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

  it('后台任务变化通过 onBackgroundTasks 通知；limbo 期间新开轮不丢失未结束的后台任务', () => {
    const counts: number[] = [];
    const { r, anyR } = make();
    anyR.hooks.onBackgroundTasks = (n: number) => counts.push(n);
    r.send('m1', cfg, U1);
    r.handleMessage(init);
    r.handleMessage({ type: 'system', subtype: 'task_started', task_id: 't1', tool_use_id: 'x1' });
    expect(counts).toEqual([1]);
    // 后台任务仍在跑时排队发新消息，第 1 轮 result → limbo → 排队消息开第 2 轮
    r.send('m2', cfg, U2, 'later');
    r.handleMessage(result);
    r.handleMessage(life(U2, 'started'));
    r.handleMessage(init);
    // 第 2 轮结束时 t1 仍在跑，不应提前变成 idle
    r.handleMessage(result);
    expect(r.status).toBe('running');
    // t1 结束后通知 0，续轮 result 才 idle
    r.handleMessage({ type: 'system', subtype: 'task_notification', task_id: 't1', status: 'completed' });
    expect(counts).toEqual([1, 0]);
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

describe('Runner 待回应请求（can_use_tool）', () => {
  const ask = (id = 'a1') => ({
    type: 'control_request',
    request_id: id,
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      tool_use_id: 'toolu_1',
      input: {
        questions: [
          { question: 'Pick?', header: 'H', multiSelect: false, junk: 1, options: [{ label: 'A', description: 'da', x: 1 }, { nolabel: true }] },
          { question: 'bad', options: 'nope' },
          null,
        ],
      },
    },
  });
  const plan = (id = 'p1') => ({
    type: 'control_request',
    request_id: id,
    request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', tool_use_id: 'toolu_2', input: { plan: '# P', planFilePath: '/x/p.md' } },
  });
  const resp = (w: Json) => w.response.response as Json;

  it('非交互工具自动放行，原样回传 input', () => {
    const { r, writes, log } = make();
    r.handleMessage({ type: 'control_request', request_id: 'w1', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a' } } });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'w1', response: { behavior: 'allow', updatedInput: { file_path: 'a' } } } });
    expect(r.promptItems()).toEqual([]);
    expect(log.prompts).toHaveLength(0);
  });

  it('AskUserQuestion 成为待回应请求（输入被清洗），并通知 onPrompts', () => {
    const { r, writes, log } = make();
    r.handleMessage(ask());
    expect(writes).toHaveLength(0);
    expect(log.prompts).toHaveLength(1);
    const items = r.promptItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'question',
      id: 'a1',
      toolUseId: 'toolu_1',
      questions: [{ question: 'Pick?', header: 'H', multiSelect: false, options: [{ label: 'A', description: 'da' }] }],
    });
    expect(JSON.stringify(items[0])).not.toContain('junk');
  });

  it('回答：写 allow 且 updatedInput 带 answers，清除待回应', () => {
    const { r, writes, log } = make();
    r.handleMessage(ask());
    expect(r.reply('a1', { kind: 'answer', answers: { 'Pick?': 'A' } })).toBe(true);
    expect(resp(writes[0]!)).toMatchObject({ behavior: 'allow', updatedInput: { answers: { 'Pick?': 'A' } } });
    expect(resp(writes[0]!).updatedInput.questions).toHaveLength(3); // 原始输入原样保留
    expect(r.promptItems()).toEqual([]);
    expect(log.prompts.at(-1)).toEqual([]);
    expect(r.reply('a1', { kind: 'skip' })).toBe(false); // 已回应
  });

  it('跳过：写 deny', () => {
    const { r, writes } = make();
    r.handleMessage(ask());
    expect(r.reply('a1', { kind: 'skip' })).toBe(true);
    expect(resp(writes[0]!).behavior).toBe('deny');
    expect(resp(writes[0]!).message).toContain('chose not to answer');
  });

  it('类型不符 / 未知 id / answers 不合法：返回 false 且不写', () => {
    const { r, writes } = make();
    r.handleMessage(ask());
    r.handleMessage(plan());
    expect(r.reply('a1', { kind: 'approve' })).toBe(false);
    expect(r.reply('p1', { kind: 'answer', answers: {} })).toBe(false);
    expect(r.reply('nope', { kind: 'skip' })).toBe(false);
    expect(r.reply('a1', { kind: 'answer', answers: { q: 1 } as any })).toBe(false);
    expect(writes).toHaveLength(0);
    expect(r.promptItems()).toHaveLength(2);
  });

  it('ExitPlanMode 批准：写 allow，再发 set_permission_mode bypassPermissions', async () => {
    const { r, anyR, writes } = make();
    anyR.applied.permissionMode = 'plan';
    r.handleMessage(plan());
    expect(r.promptItems()[0]).toMatchObject({ kind: 'plan', id: 'p1', plan: '# P', planFilePath: '/x/p.md' });
    expect(r.reply('p1', { kind: 'approve' })).toBe(true);
    expect(resp(writes[0]!)).toMatchObject({ behavior: 'allow', updatedInput: { plan: '# P' } });
    expect(anyR.applied.permissionMode).toBe('auto');
    await flush();
    expect(writes[1]).toMatchObject({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' } });
    expect(r.promptItems()).toEqual([]);
  });

  it('ExitPlanMode 修改意见：写 deny 带上反馈，不切模式', async () => {
    const { r, writes } = make();
    r.handleMessage(plan());
    expect(r.reply('p1', { kind: 'revise', feedback: ' 加上测试 ' })).toBe(true);
    expect(resp(writes[0]!).behavior).toBe('deny');
    expect(resp(writes[0]!).message).toBe('The user did not approve the plan. Their feedback:\n加上测试');
    r.handleMessage(plan('p2'));
    r.reply('p2', { kind: 'revise', feedback: '  ' });
    expect(resp(writes[1]!).message).toContain('did not approve');
    await flush();
    expect(writes).toHaveLength(2);
  });

  it('ExitPlanMode 修改意见带 @"路径"：提示模型用 Read 读附件', () => {
    const { r, writes } = make();
    r.handleMessage(plan());
    r.reply('p1', { kind: 'revise', feedback: '参考 @"/tmp/a.png"' });
    const msg = resp(writes[0]!).message as string;
    expect(msg.startsWith('The user did not approve the plan. Their feedback:\n参考 @"/tmp/a.png"')).toBe(true);
    expect(msg).toContain('Read tool');
  });

  it('control_cancel_request 丢掉对应的待回应请求', () => {
    const { r, log } = make();
    r.handleMessage(ask('a1'));
    r.handleMessage(ask('a2'));
    r.handleMessage({ type: 'control_cancel_request', request_id: 'a1' });
    expect(r.promptItems().map((p) => p.id)).toEqual(['a2']);
    expect(log.prompts.at(-1)).toHaveLength(1);
    r.handleMessage({ type: 'control_cancel_request', request_id: 'zzz' }); // 不存在：无通知
    expect(log.prompts).toHaveLength(3);
  });

  it('interrupt 先拒绝所有待回应请求再发中断', () => {
    const { r, writes, log } = make();
    r.handleMessage(init);
    r.handleMessage(ask());
    r.interrupt();
    expect(resp(writes[0]!)).toMatchObject({ behavior: 'deny', message: 'The user interrupted.' });
    expect(writes[1]!.request).toEqual({ subtype: 'interrupt' });
    expect(r.promptItems()).toEqual([]);
    expect(log.prompts.at(-1)).toEqual([]);
  });

  it('回合结束 / 进程退出时清除待回应请求', () => {
    const a = make();
    a.r.handleMessage(init);
    a.r.handleMessage(ask());
    a.r.handleMessage(result);
    expect(a.r.promptItems()).toEqual([]);
    const b = make();
    b.r.handleMessage(ask());
    b.anyR.onClose(1);
    expect(b.r.promptItems()).toEqual([]);
    expect(b.log.prompts.at(-1)).toEqual([]);
  });

  it('配置里的 permissionMode 变化时发 set_permission_mode', async () => {
    const { r, writes } = make();
    r.setConfig({ ...cfg, permissionMode: 'plan' });
    await flush();
    expect(writes[0]).toMatchObject({ type: 'control_request', request: { subtype: 'set_permission_mode', mode: 'plan' } });
    respond(r, writes, 'set_permission_mode', { mode: 'plan' });
    await flush();
    r.setConfig({ ...cfg, permissionMode: 'plan' }); // 没变：不再发
    await flush();
    expect(writes.filter((w) => w.request?.subtype === 'set_permission_mode')).toHaveLength(1);
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

describe('子代理默认模型 / 强度（PreToolUse hook）', () => {
  const hook = (tool_input: Json, callback_id = 'agent-defaults') => ({
    type: 'control_request', request_id: 'h1',
    request: { subtype: 'hook_callback', callback_id, input: { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'toolu_a', tool_input } },
  });
  const run = (tool_input: Json, d: Json | null = { claude: { model: 'sonnet', effort: 'medium' }, agy: { model: null, effort: null } }) => {
    const { r, anyR, writes, log } = make();
    anyR.agentDefaults = () => d;
    r.handleMessage(hook(tool_input));
    expect(writes[0]).toMatchObject({ type: 'control_response', response: { subtype: 'success', request_id: 'h1' } });
    return { res: writes[0]!.response.response, events: log.events.filter((e) => e.subtype === 'cosyee_agent_params') };
  };
  it('没写的补上，点名的不动，不带 permissionDecision；并告诉前端实际值', () => {
    const a = run({ description: 'd', prompt: 'p', subagent_type: 'Explore' });
    expect(a.res).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { description: 'd', prompt: 'p', subagent_type: 'Explore', model: 'sonnet', effort: 'medium' } } });
    expect(a.events).toEqual([{ type: 'system', subtype: 'cosyee_agent_params', tool_use_id: 'toolu_a', model: 'sonnet', effort: 'medium' }]);
    const b = run({ prompt: 'p', model: 'opus', effort: 'max' });
    expect(b.res.hookSpecificOutput.updatedInput).toEqual({ prompt: 'p', model: 'opus', effort: 'max' });
  });
  it('fork / 没有配置：不介入；只配了强度就只补强度', () => {
    expect(run({ prompt: 'p', subagent_type: 'fork' })).toEqual({ res: {}, events: [] });
    expect(run({ prompt: 'p' }, null)).toEqual({ res: {}, events: [] });
    expect(run({ prompt: 'p' }, { claude: { effort: 'low' }, agy: {} }).res.hookSpecificOutput.updatedInput).toEqual({ prompt: 'p', effort: 'low' });
  });
  it('SessionStart(compact)：有委派状态就作为 additionalContext 返回，没有则不介入', () => {
    const compact = { type: 'control_request', request_id: 'c1', request: { subtype: 'hook_callback', callback_id: 'delegate-compact', input: { hook_event_name: 'SessionStart', source: 'compact' } } };
    const a = make();
    a.anyR.mcp = {};
    a.anyR.delegateJobs = { compactNote: () => 'NOTE' };
    a.r.handleMessage(compact);
    expect(a.writes[0]).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'c1', response: { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'NOTE' } } } });
    const b = make();
    b.anyR.mcp = {};
    b.anyR.delegateJobs = { compactNote: () => null };
    b.r.handleMessage(compact);
    expect(b.writes[0]!.response.response).toEqual({});
  });
  it('不认识的 hook 回错误', () => {
    const { r, writes } = make();
    r.handleMessage(hook({}, 'other'));
    expect(writes[0]).toMatchObject({ response: { subtype: 'error', request_id: 'h1' } });
  });
});

describe('delegate（cosyee MCP）', () => {
  it('buildArgs delegate：带 --mcp-config 与追加提示词；默认不带', () => {
    const a = buildArgs('sid', true, cfg, {}, { delegate: true });
    expect(JSON.parse(a[a.indexOf('--mcp-config') + 1]!)).toEqual({ mcpServers: { cosyee: { type: 'sdk', name: 'cosyee' } } });
    const p = a[a.indexOf('--append-system-prompt') + 1]!;
    expect(p).toBe(`${PATH_PROMPT} ${DELEGATE_PROMPT}`);
    expect(p).not.toContain('\n');
    expect(buildArgs('sid', true, cfg)).not.toContain('--mcp-config');
  });
  it('DELEGATE_PROMPT：只讲何时派；无换行、不提后端 / 模型，不讲配套工具怎么用', () => {
    expect(DELEGATE_PROMPT).not.toMatch(/[\r\n]/);
    expect(DELEGATE_PROMPT).toContain('mcp__cosyee__delegate');
    // 原生 Agent 的说明会写「用户不要求就别派」，这里要明说不用等用户开口
    expect(DELEGATE_PROMPT).toContain('without waiting for the user to ask');
    expect(DELEGATE_PROMPT).not.toMatch(/Antigravity|Gemini|\bagy\b|Claude|subagent|sonnet|opus|haiku|effort/i);
    expect(DELEGATE_PROMPT).not.toMatch(/delegate_(send|result|stop|status|agents)|result_id|conversation_id|background/);
    expect(DELEGATE_PROMPT.length).toBeLessThan(500);
    expect(buildArgs('sid', true, cfg, {}, { delegate: true }).join(' ').length).toBeLessThan(8191);
  });
  it('withNativeDeny：开关关掉且有委派可用才停用整个 Agent；delegate 被停用时不生效；不重复', () => {
    const { anyR } = make();
    anyR.nativeAgents = () => false;
    expect(anyR.withNativeDeny(['Glob'])).toEqual(['Glob']);
    anyR.mcp = {};
    expect(anyR.withNativeDeny(['Glob'])).toEqual(['Glob', 'Agent']);
    expect(anyR.withNativeDeny(['Agent'])).toEqual(['Agent']);
    expect(anyR.withNativeDeny(['mcp__cosyee__delegate'])).toEqual(['mcp__cosyee__delegate']);
    anyR.nativeAgents = () => true;
    expect(anyR.withNativeDeny([])).toEqual([]);
    anyR.nativeAgents = undefined;
    expect(anyR.withNativeDeny([])).toEqual([]);
  });
  it('isDenied：permissions.deny 里整条停用 delegate 才算（启动时据此不注册 cosyee MCP）', () => {
    expect(isDenied({ permissions: { deny: ['Bash', 'mcp__cosyee__delegate'] } }, 'mcp__cosyee__delegate')).toBe(true);
    expect(isDenied({ permissions: { deny: ['Agent(mcp__cosyee__delegate)'] } }, 'mcp__cosyee__delegate')).toBe(false);
    expect(isDenied({}, 'mcp__cosyee__delegate')).toBe(false);
  });
  const mcpReq = (message: Json) => ({ type: 'control_request', request_id: 'm1', request: { subtype: 'mcp_message', server_name: 'cosyee', message } });
  it('mcp_message 交给 CosyeeMcp 并回 control_response', async () => {
    const { r, anyR, writes } = make();
    const fakeBackend: DelegateBackend = {
      id: 'fake',
      label: 'Fake',
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ stopReason: 'end_turn', response: 'r', sessionId: 'conv-x', toolCalls: 0 }),
    };
    const jobs = new DelegateJobs({ run: fakeBackend.run });
    anyR.mcp = new CosyeeMcp({
      jobs,
      agents: BUILTIN_AGENTS,
      ctx: () => ({ cwd: process.cwd(), backend: fakeBackend, agents: { configDir: '', cwd: process.cwd(), disabled: [] } }),
    });
    r.handleMessage(mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    await flush();
    expect(writes).toHaveLength(1);
    const w = writes[0]!;
    expect(w.type).toBe('control_response');
    expect(w.response.subtype).toBe('success');
    expect(w.response.request_id).toBe('m1');
    expect(w.response.response.mcp_response.id).toBe(1);
    expect(w.response.response.mcp_response.result.tools[0].name).toBe('delegate');
  });
  it('没有 mcp 时 mcp_message 仍回错误', async () => {
    const { r, writes } = make();
    r.handleMessage(mcpReq({ jsonrpc: '2.0', id: 1, method: 'tools/list' }));
    await flush();
    expect(writes).toEqual([{ type: 'control_response', response: { subtype: 'error', request_id: 'm1', error: 'not supported by cosyee host' } }]);
  });
});

describe('inject（委派任务完成通知）', () => {
  const frames = (writes: Json[]) => writes.filter((w) => w.type === 'user');
  const text = (w: Json) => w.message.content[0].text;

  it('空闲且进程在：只写入 stdin，不进排队列表、不发 cosyee_user；CLI 开轮后才 running', async () => {
    const { r, log, writes } = make();
    r.inject('<cosyee-delegate-notification>x</cosyee-delegate-notification>', cfg);
    await flush();
    const fs_ = frames(writes);
    expect(fs_).toHaveLength(1);
    expect(text(fs_[0]!)).toContain('cosyee-delegate-notification');
    expect(fs_[0]!.priority).toBeUndefined();
    expect(r.queueItems()).toEqual([]);
    expect(log.queues).toEqual([]);
    expect(users(log.events)).toEqual([]);
    expect(r.status).toBe('idle');
    // 回显 / lifecycle 对未知（注入的）uuid 照样被忽略，不产生 cosyee_user
    r.handleMessage(life(fs_[0]!.uuid, 'started'));
    r.handleMessage(echo(fs_[0]!.uuid));
    expect(users(log.events)).toEqual([]);
    expect(r.status).toBe('idle');
    // CLI 因此开了一轮
    r.handleMessage(init);
    expect(r.status).toBe('running');
    r.handleMessage(asst);
    expect(r.snapshot().events).toHaveLength(2);
    r.handleMessage(result);
    expect(r.status).toBe('idle');
    expect(users(log.events)).toEqual([]);
  });

  it('运行中：priority next；result 先到时不闪 idle，等注入消息开轮', async () => {
    const { r, log, writes } = make();
    r.send('go', cfg, U1);
    await flush();
    r.handleMessage(init);
    r.inject('NOTE', cfg);
    await flush();
    const inj = frames(writes).find((w) => text(w) === 'NOTE')!;
    expect(inj.priority).toBe('next');
    expect(r.queueItems()).toEqual([]);
    expect(log.queues).toEqual([]);
    // 第一个 result：注入的消息还没进对话，保持 running
    r.handleMessage(result);
    expect(r.status).toBe('running');
    expect(log.turnEnds).toBe(0);
    // 它开始执行（回显）：新一轮，没有 cosyee_user
    r.handleMessage(echo(inj.uuid));
    expect(r.status).toBe('running');
    expect(users(log.events).map((e) => e.id)).toEqual([U1]);
    r.handleMessage(init);
    r.handleMessage(asst);
    r.handleMessage(result);
    expect(r.status).toBe('idle');
    expect(log.turnEnds).toBe(1);
  });

  it('运行中：注入的消息已并入当前轮（回显先于 result）则 result 正常结束', async () => {
    const { r, writes } = make();
    r.send('go', cfg, U1);
    await flush();
    r.handleMessage(init);
    r.inject('NOTE', cfg);
    await flush();
    const inj = frames(writes).find((w) => text(w) === 'NOTE')!;
    r.handleMessage(echo(inj.uuid));
    r.handleMessage(result);
    expect(r.status).toBe('idle');
  });

  it('运行中：注入的消息被取消，result 之后在等它的 limbo 直接收尾', async () => {
    const { r, writes } = make();
    r.send('go', cfg, U1);
    await flush();
    r.handleMessage(init);
    r.inject('NOTE', cfg);
    await flush();
    const inj = frames(writes).find((w) => text(w) === 'NOTE')!;
    r.handleMessage(result);
    expect(r.status).toBe('running');
    r.handleMessage(life(inj.uuid, 'cancelled'));
    expect(r.status).toBe('idle');
  });

  it('没有进程：像 send 一样启动并开轮（starting），不发 cosyee_user', async () => {
    const { r, anyR, log, writes } = make();
    anyR.proc = null;
    anyR.probeMode = true;
    anyR.start = function () {
      this.proc = { pid: undefined, stdin: { writable: true, destroyed: false, write: (x: string) => writes.push(JSON.parse(x)), end() {} } };
      this.closed = false;
      this.intentional = false;
      if (!this.probeMode) this.setStatus('starting');
    };
    r.inject('NOTE', cfg);
    await flush();
    expect(r.status).toBe('starting');
    expect(frames(writes).map(text)).toEqual(['NOTE']);
    expect(users(log.events)).toEqual([]);
    expect(r.queueItems()).toEqual([]);
    r.handleMessage(init);
    expect(r.status).toBe('running');
    expect(r.snapshot().events).toHaveLength(1);
  });

  it('进程正在关闭时抛错', () => {
    const { r, anyR } = make();
    anyR.intentional = true;
    expect(() => r.inject('x', cfg)).toThrow();
  });

  it('pushExternal 与 CLI 事件同路径：回合内进缓冲并广播', () => {
    const { r, log } = make();
    r.handleMessage(init);
    r.pushExternal({ type: 'system', subtype: 'x' });
    expect(log.events).toHaveLength(2);
    expect(r.snapshot().events).toHaveLength(2);
  });

  it('空闲回收：有后台委派任务时不回收，没有了才回收', () => {
    vi.useFakeTimers();
    const { r, anyR } = make({ idleMs: 1000 });
    let bg = true;
    anyR.delegateJobs = { hasBackground: () => bg };
    r.handleMessage(init);
    r.handleMessage(result); // finishTurn → armIdle(1000)
    vi.advanceTimersByTime(3500);
    expect(anyR.intentional).toBe(false);
    expect(r.alive).toBe(true);
    bg = false;
    vi.advanceTimersByTime(1000);
    expect(anyR.intentional).toBe(true);
  });
});

describe('内置浏览器插件', () => {
  it('buildArgs 带 --plugin-dir；没有时不带', () => {
    const a = buildArgs('sid', true, cfg, {}, { pluginDir: '/x/claude-plugin' });
    expect(a[a.indexOf('--plugin-dir') + 1]).toBe('/x/claude-plugin');
    expect(buildArgs('sid', true, cfg)).not.toContain('--plugin-dir');
    expect(buildArgs('sid', true, cfg, {}, { pluginDir: null })).not.toContain('--plugin-dir');
  });
});
