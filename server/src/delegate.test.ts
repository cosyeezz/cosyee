import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DELEGATE_BG_MARKER,
  type DelegateJobInfo,
  type DelegateNotification,
  formatDelegateNotification,
  parseDelegateNotification,
} from '@cosyee/shared';
import { BUILTIN_AGENTS, type DelegateAgent } from './delegate/agents.js';
import { resolveAgy } from './delegate/agy.js';
import { BackendError, type BackendResult, type BackendRunOptions, type DelegateBackend } from './delegate/backend.js';
import type { GitRunner } from './delegate/context.js';
import { type DelegateCtx, DelegateJobs, type DelegateJobsOptions, normFilePath } from './delegate/jobs.js';
import { CosyeeMcp, DELEGATE_TOOL_NAME, DELEGATE_TOOL_NAMES, DELEGATE_TOOLS, delegateTool } from './delegate/mcp.js';
import { AcpProgress } from './delegate/progress.js';
import type { DelegateIdRecord } from './delegate/record.js';

type Json = Record<string, any>;

const STEER_PREFIX =
  '(Your previous turn was interrupted to deliver this message from the coordinator. Take it into account and continue the task.)\n\n';
const DLG_RE = /^dlg_[0-9a-f]{24}$/;

const tick = () => new Promise((r) => setTimeout(r, 5));
const noGit: GitRunner = async () => {
  throw new Error('no git');
};

function makeFakeBackend(run?: (o: BackendRunOptions) => Promise<BackendResult>): DelegateBackend {
  return {
    id: 'fake',
    label: 'Fake',
    available: () => true,
    models: async () => ({ models: [], current: null, at: 0 }),
    run: run ?? (async () => ({ stopReason: 'end_turn', response: '搞定', sessionId: 'sess-1', toolCalls: 0 })),
  };
}

function makeCtx(over: Partial<DelegateCtx> = {}): DelegateCtx {
  return {
    cwd: '/work',
    backend: makeFakeBackend(),
    agents: { configDir: '', cwd: '', disabled: [] },
    ...over,
  };
}

describe('resolveAgy', () => {
  const tmps: string[] = [];
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-test-'));
    tmps.push(d);
    return d;
  };
  afterEach(() => {
    for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';

  it('COSYEE_AGY 优先', () => {
    expect(resolveAgy({ COSYEE_AGY: 'X:/my/agy', PATH: '' })).toBe('X:/my/agy');
  });
  it('什么都没有返回 null', () => {
    const home = tmp();
    const env = { PATH: '', LOCALAPPDATA: home, HOME: home, USERPROFILE: home };
    if (process.platform !== 'win32') return;
    expect(resolveAgy(env)).toBeNull();
  });
  it('PATH 里找得到', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, exe), '');
    expect(resolveAgy({ PATH: d })).toBe(path.join(d, exe));
  });
  it('默认安装目录兜底（win）', () => {
    if (process.platform !== 'win32') return;
    const d = tmp();
    fs.mkdirSync(path.join(d, 'agy', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(d, 'agy', 'bin', exe), '');
    expect(resolveAgy({ PATH: '', LOCALAPPDATA: d })).toBe(path.join(d, 'agy', 'bin', exe));
  });
});

describe('CosyeeMcp', () => {
  const okResult: BackendResult = { stopReason: 'end_turn', response: '搞定', sessionId: 'sess-9999', toolCalls: 2, usage: { inputTokens: 10, outputTokens: 20 } };
  const mk = (
    run: any = vi.fn(async () => okResult),
    extra: Partial<DelegateJobsOptions> = {},
    agents: DelegateAgent[] = BUILTIN_AGENTS,
    ctxOver: Partial<DelegateCtx> = {},
  ) => {
    const jobs = new DelegateJobs({ run, git: noGit, ...extra });
    const ctx = makeCtx(ctxOver);
    const mcp = new CosyeeMcp({ jobs, agents, ctx: () => ctx });
    return { mcp, run, jobs };
  };
  const call = (args: Json, id: number | string = 1, name = 'delegate') => ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: name === 'delegate' ? { run_in_background: false, ...args } : args },
  });

  it('initialize / tools/list：5 个工具全部 readOnlyHint，delegate_agents 无 alwaysLoad，无后端品牌字样，不含自定义正文与描述', async () => {
    const custom: DelegateAgent[] = [
      ...BUILTIN_AGENTS,
      {
        name: 'secret-auditor',
        description: 'UNIQUE_CUSTOM_DESCRIPTION_TEXT',
        prompt: 'UNIQUE_CUSTOM_BODY_TEXT',
        source: 'projectSettings',
        omitClaudeMd: false,
        omitGitStatus: false,
      },
    ];
    const { mcp } = mk(undefined, {}, custom);
    expect((await mcp.handle({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).result).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'cosyee', version: '1' },
    });
    const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools: Json[] = list.result.tools;
    expect(tools.map((t) => t.name)).toEqual(['delegate', 'delegate_send', 'delegate_stop', 'delegate_result', 'delegate_agents']);
    for (const t of tools) {
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.description).not.toMatch(/Antigravity|Gemini|\bagy\b/i);
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('delegate')!._meta?.['anthropic/alwaysLoad']).toBe(true);
    expect(byName.get('delegate_send')!._meta?.['anthropic/alwaysLoad']).toBe(true);
    expect(byName.get('delegate_stop')!._meta?.['anthropic/alwaysLoad']).toBe(true);
    expect(byName.get('delegate_result')!._meta?.['anthropic/alwaysLoad']).toBe(true);
    expect(byName.get('delegate_agents')!._meta).toBeUndefined();

    const props = byName.get('delegate')!.inputSchema.properties;
    expect(props).toHaveProperty('agent');
    expect(props).toHaveProperty('run_in_background');
    expect(props).not.toHaveProperty('model');
    expect(props).not.toHaveProperty('effort');

    const serialized = JSON.stringify(tools);
    expect(serialized).toContain('Others: secret-auditor.');
    expect(serialized).not.toContain('UNIQUE_CUSTOM_DESCRIPTION_TEXT');
    expect(serialized).not.toContain('UNIQUE_CUSTOM_BODY_TEXT');
    expect(serialized).not.toMatch(/Antigravity|Gemini|\bagy\b/i);

    // 没有自定义智能体时不含 Others:
    expect(delegateTool(BUILTIN_AGENTS).description).not.toContain('Others:');

    expect(DELEGATE_TOOLS).toHaveLength(5);
    expect(DELEGATE_TOOL_NAMES).toEqual([
      'mcp__cosyee__delegate',
      'mcp__cosyee__delegate_send',
      'mcp__cosyee__delegate_stop',
      'mcp__cosyee__delegate_result',
      'mcp__cosyee__delegate_agents',
    ]);
    expect(DELEGATE_TOOL_NAME).toBe('mcp__cosyee__delegate');
  });

  it('delegate_agents 列出智能体并支持 query 过滤', async () => {
    const { mcp } = mk();
    const all = await mcp.handle(call({}, 1, 'delegate_agents'));
    expect(all.result.isError).toBeUndefined();
    expect(all.result.content[0].text).toContain('- Explore:');
    expect(all.result.content[0].text).toContain('- Plan:');
    expect(all.result.content[0].text).toContain('- general-purpose:');

    const filtered = await mcp.handle(call({ query: 'architect' }, 2, 'delegate_agents'));
    expect(filtered.result.content[0].text).toContain('- Plan:');
    expect(filtered.result.content[0].text).not.toContain('- Explore:');
  });

  it('tools/call 成功：带 hand-back 框、缩进正文、conversation_id 与 usage 页脚', async () => {
    let t = 1000;
    const run = vi.fn(async (_o: BackendRunOptions) => {
      t = 1250;
      return okResult;
    });
    const { mcp } = mk(run, { now: () => t });
    const r = await mcp.handle(call({ description: 'd', prompt: 'do work' }, 7));
    expect(r.error).toBeUndefined();
    const out: string = r.result.content[0].text;
    expect(out).toContain('[Delegate hand-back]');
    expect(out).toContain('\n  搞定\n');
    expect(out).toMatch(/conversation_id: dlg_[0-9a-f]{24} \(use delegate_send to continue this conversation\)/);
    expect(out).toContain('<usage>total_tokens: 30\ntool_uses: 2\nduration_ms: 250</usage>');

    // 首条新会话带 systemPrompt 与 taskContext
    const callArg = run.mock.calls[0]![0];
    expect(callArg.systemPrompt).toContain('Notes:');
    expect(callArg.prompt).toContain('<system-reminder>');
    expect(callArg.prompt.endsWith('\n\ndo work')).toBe(true);
  });

  it('空报告输出占位行；max_tokens 等截断照常返回并附说明（不含 Antigravity）', async () => {
    const a = mk(vi.fn(async () => ({ stopReason: 'end_turn', response: '', sessionId: 's1', toolCalls: 0 })));
    const outA: string = (await a.mcp.handle(call({ description: '', prompt: 'p' }))).result.content[0].text;
    expect(outA).toContain('  (Delegate completed but returned no output.)');
    expect(outA).not.toContain('total_tokens');

    const b = mk(vi.fn(async () => ({ ...okResult, stopReason: 'max_tokens' })));
    const outB: string = (await b.mcp.handle(call({ description: '', prompt: 'p' }))).result.content[0].text;
    expect(outB).toContain('委派任务提前结束：max_tokens');
    expect(outB).not.toMatch(/Antigravity|Gemini/i);
  });

  it('参数校验失败与未知智能体都是工具错误', async () => {
    const { mcp, run } = mk();
    const bad: Json[] = [
      { description: 'd' },
      { description: 'd', prompt: '  ' },
      { description: 5, prompt: 'p' },
      { description: 'd', prompt: 'p', agent: 123 },
      { description: 'd', prompt: 'p', agent: 'nonexistent-agent' },
      { description: 'd', prompt: 'p', conversation_id: 'short' },
      { description: 'd', prompt: 'p', run_in_background: 'yes' },
    ];
    for (const a of bad) {
      const r = await mcp.handle(call(a));
      expect(r.error).toBeUndefined();
      expect(r.result.isError).toBe(true);
    }
    const others: [string, Json][] = [
      ['delegate_send', { conversation_id: 'abcd-1234', message: ' ' }],
      ['delegate_send', { conversation_id: 'x', message: 'm' }],
      ['delegate_send', { conversation_id: 'abcd-1234', message: 'm', mode: 'now' }],
      ['delegate_stop', {}],
      ['delegate_result', {}],
      ['delegate_result', { result_id: '../../x' }],
      ['delegate_result', { result_id: `res_${'0'.repeat(32)}` }],
      ['delegate_result', { result_id: `res_${'0'.repeat(32)}`, offset: -1 }],
      ['delegate_agents', { query: 123 }],
      ['delegate_status', {}],
    ];
    for (const [name, a] of others) expect((await mcp.handle(call(a, 1, name))).result.isError).toBe(true);
    const r = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'other', arguments: {} } });
    expect(r.result.isError).toBe(true);
    expect(run).not.toHaveBeenCalled();
  });

  it('其它 stopReason / 抛错 -> isError，BackendError 带页脚', async () => {
    const a = mk(vi.fn(async () => ({ ...okResult, stopReason: 'refusal', response: '' })));
    const resA = (await a.mcp.handle(call({ description: 'd', prompt: 'p' }))).result;
    expect(resA.isError).toBe(true);
    expect(resA.content[0].text).toContain('委派任务异常结束（refusal）');
    expect(resA.content[0].text).not.toMatch(/Antigravity|Gemini/i);

    const b = mk(vi.fn(async () => { throw new Error('未登录'); }));
    expect((await b.mcp.handle(call({ description: 'd', prompt: 'p' }))).result.content[0].text).toContain('未登录');

    const c = mk(vi.fn(async () => { throw new BackendError('卡住了', 'sess-1111'); }));
    const resC = (await c.mcp.handle(call({ description: 'd', prompt: 'p' }))).result;
    expect(resC.isError).toBe(true);
    expect(resC.content[0].text).toContain('卡住了');
    expect(resC.content[0].text).toMatch(/conversation_id: dlg_[0-9a-f]{24}/);
  });

  it('defaults 按调用读取；实际模型报告成 cosyee_agent_params', async () => {
    const run = vi.fn(async (o: BackendRunOptions) => {
      o.onModel?.({ model: 'gemini-4-neon', effort: 'high' });
      o.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
      return okResult;
    });
    const evs: Json[] = [];
    let agy: any = { model: 'neon', effort: null };
    const jobs = new DelegateJobs({ run, git: noGit, onEvents: (e) => evs.push(...e) });
    const mcp = new CosyeeMcp({
      jobs,
      agents: BUILTIN_AGENTS,
      ctx: () => makeCtx({ defaults: agy }),
    });
    const args = { description: 'd', prompt: 'p', run_in_background: false };
    await mcp.handle({ ...call(args), params: { name: 'delegate', arguments: args, _meta: { 'claudecode/toolUseId': 'toolu_1' } } });
    expect(run.mock.calls[0]![0]).toMatchObject({ defaults: { model: 'neon', effort: null } });
    expect(evs[0]).toEqual({ type: 'system', subtype: 'cosyee_agent_params', tool_use_id: 'toolu_1', model: 'gemini-4-neon', effort: 'high' });
    expect(evs[1].event.message.model).toBe('gemini-4-neon');
    agy = { model: null, effort: null };
    await mcp.handle(call({ description: 'd', prompt: 'p' }));
    expect(run.mock.calls[1]![0]).not.toHaveProperty('defaults');
  });

  it('notifications/cancelled 中止对应前台调用；abortAll 中止全部前台调用', async () => {
    let sig: AbortSignal | undefined;
    const run = vi.fn((o: BackendRunOptions) => new Promise<BackendResult>((_, rej) => {
      sig = o.signal;
      o.signal.addEventListener('abort', () => rej(new Error('已取消')));
    }));
    const { mcp } = mk(run as any);
    const pending = mcp.handle(call({ description: 'd', prompt: 'p' }, 5));
    await until(() => !!sig);
    expect(sig!.aborted).toBe(false);
    const ack = await mcp.handle({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
    expect(ack).toEqual({ jsonrpc: '2.0', id: 0, result: {} });
    expect(sig!.aborted).toBe(true);
    expect((await pending).result.isError).toBe(true);

    sig = undefined;
    const p2 = mcp.handle(call({ description: 'd', prompt: 'p' }, 6));
    await until(() => !!sig);
    mcp.abortAll();
    expect(sig!.aborted).toBe(true);
    await p2;
  });
});

/** 可手动放行的假 run：支持延迟触发 onSession */
function fakeRun(opts: { autoSession?: boolean } = {}) {
  interface Call {
    o: BackendRunOptions;
    sessionId: string;
    emitSession(): void;
    chunk(t: string): void;
    finish(response: string, stopReason?: string, toolCalls?: number): void;
    fail(e: Error): void;
  }
  const calls: Call[] = [];
  let fresh = 0;
  const run = vi.fn(
    (o: BackendRunOptions) =>
      new Promise<BackendResult>((resolve, reject) => {
        const sessionId = o.sessionId ?? `backend-sess-${++fresh}`;
        const emitSession = () => o.onSession?.(sessionId);
        if (opts.autoSession !== false) emitSession();
        o.signal.addEventListener('abort', () => reject(new Error('已取消')));
        calls.push({
          o,
          sessionId,
          emitSession,
          chunk: (text) => o.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }),
          finish: (response, stopReason = 'end_turn', toolCalls = 0) => resolve({ stopReason, response, sessionId, toolCalls }),
          fail: reject,
        });
      }),
  );
  return { run, calls };
}

async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe('DelegateJobs', () => {
  const ctx = makeCtx();
  const text = (r: Json): string => r.content[0].text;
  const sig = () => new AbortController().signal;
  const setup = (extra: Partial<DelegateJobsOptions> = {}, runOpts?: { autoSession?: boolean }) => {
    const f = fakeRun(runOpts);
    const evs: Json[] = [];
    const finished: DelegateNotification[] = [];
    const changes: DelegateJobInfo[][] = [];
    const jobs = new DelegateJobs({
      run: f.run,
      git: noGit,
      onEvents: (e) => evs.push(...e),
      onChange: (j) => changes.push(j),
      onFinish: (n) => finished.push(n),
      tailThrottleMs: 0,
      ...extra,
    });
    const tool = (name: string, args: Json, toolUseId = 'toolu_1', signal = sig(), customCtx = ctx) =>
      jobs.callTool(name, args, customCtx, toolUseId, signal);
    const bg = (toolUseId = 'toolu_1', customCtx = ctx) =>
      tool('delegate', { description: '写测试', prompt: 'do it' }, toolUseId, sig(), customCtx);
    return { ...f, evs, finished, changes, jobs, tool, bg };
  };

  it('后台立刻返回 dlg_ id（不等后端会话建立），启动文本匹配约定；同 cwd 并行附提示', async () => {
    const s = setup({}, { autoSession: false });
    const r = await s.bg('toolu_1');
    const out = text(r);
    const lines = out.split('\n');
    expect(lines[0]).toBe(DELEGATE_BG_MARKER);
    const id = s.jobs.list()[0]!.conversationId;
    expect(id).toMatch(DLG_RE);
    expect(lines[1]).toBe(`conversation_id: ${id} (internal ID - do not mention to user. Use delegate_send to continue this conversation.)`);
    expect(lines[2]).toContain('You know nothing about its results until that notification arrives');
    expect(out).not.toContain('already running in this same working directory');
    expect(r.isError).toBeUndefined();
    // 此时尚未 emitSession，但后台已返回
    expect(s.jobs.hasBackground()).toBe(true);

    // 同一 cwd 再起一个后台任务：附同目录并行提示
    const r2 = await s.bg('toolu_2');
    expect(text(r2)).toContain('Note: another write-capable delegate is already running in this same working directory');

    // 只读的 Explore：不附提示（自己只读，也不算别人的写冲突）
    const rx = await s.tool('delegate', { description: 'look', prompt: 'find', agent: 'Explore' }, 'toolu_x');
    expect(text(rx)).not.toContain('already running in this same working directory');

    // 不同 cwd 起后台任务：不附同目录提示
    const r3 = await s.bg('toolu_3', makeCtx({ cwd: '/other' }));
    expect(text(r3)).not.toContain('already running in this same working directory');

    await until(() => s.calls.length === 3);
    s.calls[0]!.emitSession();
    s.calls[0]!.finish('全部完成', 'end_turn', 3);
    await until(() => s.finished.length === 1);
    expect(s.finished[0]).toMatchObject({
      conversationId: id,
      toolUseId: 'toolu_1',
      status: 'done',
      description: '写测试',
      resultId: expect.stringMatching(/^res_[0-9a-f]{32}$/),
    });
    expect(s.finished[0]!.result).toContain('[Delegate hand-back]');
    expect(s.finished[0]!.result).toContain('\n  全部完成\n');
    expect(s.finished[0]!.result).toContain(`conversation_id: ${id}`);
    expect(s.finished[0]!.result).toContain('tool_uses: 3');
  });

  it('后台会话建立失败：仍走完成通知（status error）', async () => {
    const s = setup({ run: vi.fn(async () => { throw new Error('未登录'); }) });
    const r = await s.bg();
    expect(r.isError).toBeUndefined();
    expect(text(r).startsWith(DELEGATE_BG_MARKER)).toBe(true);
    await until(() => s.finished.length === 1);
    expect(s.finished[0]).toMatchObject({ status: 'error' });
    expect(s.finished[0]!.result).toContain('未登录');
    expect(s.jobs.list()[0]).toMatchObject({ state: 'error', error: '未登录' });
  });

  it('id 映射落盘并可被新 DelegateJobs 实例加载续聊；续聊不带 systemPrompt 和 taskContext', async () => {
    const idStore = new Map<string, DelegateIdRecord>();
    const ids = {
      saveId: async (id: string, rec: DelegateIdRecord) => void idStore.set(id, { ...rec }),
      readId: async (id: string) => idStore.get(id) ?? null,
    };
    const s1 = setup({ ids });
    await s1.bg();
    const dlgId = s1.jobs.list()[0]!.conversationId;
    await until(() => s1.calls.length === 1);
    expect(s1.calls[0]!.o.sessionId).toBeUndefined();
    expect(s1.calls[0]!.o.systemPrompt).toBeDefined();
    expect(s1.calls[0]!.o.prompt).toContain('<system-reminder>');
    s1.calls[0]!.finish('done 1');
    await until(() => s1.finished.length === 1);
    expect(idStore.get(dlgId)?.sessionId).toBe('backend-sess-1');

    // 模拟重启：新的 DelegateJobs 实例凭借落盘的 ids 续聊
    const s2 = setup({ ids });
    const r = await s2.tool('delegate_send', { conversation_id: dlgId, message: 'follow up' }, 'toolu_9');
    expect(r.isError).toBeUndefined();
    await until(() => s2.calls.length === 1);
    expect(s2.calls[0]!.o.sessionId).toBe('backend-sess-1');
    expect(s2.calls[0]!.o.systemPrompt).toBeUndefined();
    expect(s2.calls[0]!.o.prompt).toBe('follow up');
    s2.calls[0]!.finish('done 2');
    await until(() => s2.finished.length === 1);
    expect(s2.finished[0]!.conversationId).toBe(dlgId);
  });

  it('旧格式 UUID/字母数字 conversation_id 视作 legacy sessionId 续聊', async () => {
    const s = setup();
    const legacyId = '11111111-2222-4333-8444-555555555555';
    const r = await s.tool('delegate_send', { conversation_id: legacyId, message: '继续旧的' }, 'toolu_7');
    expect(r.isError).toBeUndefined();
    await until(() => s.calls.length === 1);
    expect(s.calls[0]!.o.sessionId).toBe(legacyId);
    expect(s.calls[0]!.o.systemPrompt).toBeUndefined();
    expect(s.calls[0]!.o.prompt).toBe('继续旧的');
    s.calls[0]!.finish('好了');
    await until(() => s.finished.length === 1);
    expect(s.finished[0]!.conversationId).toBe(legacyId);
  });

  it('steer 与 queue：steer 打断并带前缀，queue 顺序执行并拼入结果', async () => {
    const s = setup();
    await s.bg();
    const dlgId = s.jobs.list()[0]!.conversationId;
    await until(() => s.calls.length === 1);

    const r1 = await s.tool('delegate_send', { conversation_id: dlgId, message: '换方向' }, 'toolu_2');
    expect(text(r1)).toContain('interrupted');
    await until(() => s.calls.length === 2);
    expect(s.calls[1]!.o.prompt).toBe(STEER_PREFIX + '换方向');
    expect(s.calls[1]!.o.sessionId).toBe('backend-sess-1');
    expect(s.calls[1]!.o.systemPrompt).toBeUndefined();

    const r2 = await s.tool('delegate_send', { conversation_id: dlgId, message: '再做一步', mode: 'queue' }, 'toolu_3');
    expect(text(r2)).toContain('Queued');
    s.calls[1]!.finish('第一步');
    await until(() => s.calls.length === 3);
    expect(s.calls[2]!.o.prompt).toBe('再做一步');
    s.calls[2]!.finish('第二步');
    await until(() => s.finished.length === 1);
    expect(s.finished[0]!.result).toContain('  第一步\n  \n  ---\n  \n  第二步');
  });

  it('compactNote：列出在跑的任务与已送达未读的结果，读过即移除', async () => {
    const s = setup();
    expect(s.jobs.compactNote()).toBeNull();
    await s.bg();
    const dlgId = s.jobs.list()[0]!.conversationId;
    await until(() => s.calls.length === 1);
    expect(s.jobs.compactNote()).toContain(`running: conversation_id ${dlgId}, agent general-purpose`);
    s.calls[0]!.finish('ok');
    await until(() => s.finished.length === 1);
    const n = s.finished[0]!;
    // 还没送达：不算未读（送达后才会出现在模型上下文里）
    expect(s.jobs.compactNote()).toBeNull();
    s.jobs.ackNotification(n);
    const note = s.jobs.compactNote()!;
    expect(note).toContain(`result_id ${n.resultId}, status done`);
    expect(note).not.toContain('running:');
    expect(note).not.toMatch(/[Aa]ntigravity|[Gg]emini|\bagy\b|Claude/);
    await s.tool('delegate_result', { result_id: n.resultId });
    expect(s.jobs.compactNote()).toBeNull();
  });

  it('delegate_stop / stopByToolUse / delegate_result 分段与落盘', async () => {
    const disk = new Map<string, string>();
    const results = { saveResult: async (id: string, t: string) => void disk.set(id, t), readResult: async (id: string) => disk.get(id) ?? null };
    const s = setup({ results });
    await s.bg();
    const dlgId = s.jobs.list()[0]!.conversationId;
    await until(() => s.calls.length === 1);
    s.calls[0]!.finish('a'.repeat(20_000) + 'b'.repeat(5000));
    await until(() => s.finished.length === 1);
    const resId = s.finished[0]!.resultId!;

    const other = setup({ results });
    const p1 = text(await other.tool('delegate_result', { result_id: resId }));
    expect(p1).toContain('[Delegate hand-back]');
    expect(p1).toContain('continue with offset: 20000');
    const p2 = text(await other.tool('delegate_result', { result_id: resId, offset: 20_000 }));
    expect(p2).toContain('bbbb');

    // stopByToolUse
    const s2 = setup();
    await s2.bg();
    await until(() => s2.calls.length === 1);
    s2.calls[0]!.chunk('部分');
    expect(s2.jobs.stopByToolUse('toolu_1')).toBe(true);
    expect(s2.finished[0]).toMatchObject({ status: 'stopped' });
    expect(s2.finished[0]!.result).toContain('部分');

    // delegate_stop：返回 result_id + 尾部输出，完整部分输出可读
    const s3 = setup();
    await s3.bg();
    const id3 = s3.jobs.list()[0]!.conversationId;
    await until(() => s3.calls.length === 1);
    const bigPartial = 'H'.repeat(3000) + 'TAIL_END';
    s3.calls[0]!.chunk(bigPartial);
    const st = await s3.tool('delegate_stop', { conversation_id: id3 });
    const stText = text(st);
    expect(stText).toContain(`Stopped delegate ${id3}`);
    expect(stText).toMatch(/result_id: res_[0-9a-f]{32}/);
    expect(stText).toContain('TAIL_END');
    expect(stText.endsWith('\n[tool_use_id: toolu_1]')).toBe(true);
    const stopResId = /result_id: (res_[0-9a-f]{32})/.exec(stText)![1]!;
    const stopFull = text(await s3.tool('delegate_result', { result_id: stopResId }));
    expect(stopFull).toContain(bigPartial);
    await tick();
    expect(s3.finished).toEqual([]);
  });

  it('steer 遇到进行中的工具调用时等待其结束（合并期间追加的 steer），或超 steerWaitMs 后强制打断', async () => {
    const s = setup({ steerWaitMs: 5000 });
    await s.bg();
    const dlgId = s.jobs.list()[0]!.conversationId;
    await until(() => s.calls.length === 1);

    // 模拟一个进行中的工具调用
    s.calls[0]!.o.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'tc1', kind: 'execute', status: 'in_progress' });
    s.calls[0]!.chunk('打断前文字');
    await s.tool('delegate_send', { conversation_id: dlgId, message: '指令A' });
    await s.tool('delegate_send', { conversation_id: dlgId, message: '指令B' });
    await tick();
    // 工具还没完成：尚未 abort
    expect(s.calls[0]!.o.signal.aborted).toBe(false);

    // 工具完成后立刻 abort 并合并两条 steer，且保留打断前的文字
    s.calls[0]!.o.onUpdate?.({ sessionUpdate: 'tool_call_update', toolCallId: 'tc1', status: 'completed' });
    await until(() => s.calls.length === 2);
    expect(s.calls[0]!.o.signal.aborted).toBe(true);
    expect(s.calls[1]!.o.prompt).toBe(STEER_PREFIX + '指令A\n\n指令B');
    s.calls[1]!.finish('最终结论');
    await until(() => s.finished.length === 1);
    expect(s.finished[0]!.result).toContain('打断前文字');
    expect(s.finished[0]!.result).toContain('(interrupted by a new message)');
    expect(s.finished[0]!.result).toContain('最终结论');

    // 超时兜底：工具一直不结束，超过 steerWaitMs 后自动打断
    const s2 = setup({ steerWaitMs: 30 });
    await s2.bg();
    const id2 = s2.jobs.list()[0]!.conversationId;
    await until(() => s2.calls.length === 1);
    s2.calls[0]!.o.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'tc_slow', kind: 'execute', status: 'in_progress' });
    await s2.tool('delegate_send', { conversation_id: id2, message: '别等了' });
    expect(s2.calls[0]!.o.signal.aborted).toBe(false);
    await until(() => s2.calls.length === 2);
    expect(s2.calls[0]!.o.signal.aborted).toBe(true);
    expect(s2.calls[1]!.o.prompt).toBe(STEER_PREFIX + '别等了');
  });

  it('用户 stopByToolUse 通知的 result_id 保存完整部分输出（含已完成轮次与超 2000 字的当前轮）', async () => {
    const s = setup();
    await s.bg();
    const dlgId = s.jobs.list()[0]!.conversationId;
    await until(() => s.calls.length === 1);
    await s.tool('delegate_send', { conversation_id: dlgId, message: '第二轮', mode: 'queue' });
    s.calls[0]!.finish('第一轮完整回答');
    await until(() => s.calls.length === 2);
    const bigTurn = 'Z'.repeat(3500) + '_END';
    s.calls[1]!.chunk(bigTurn);
    expect(s.jobs.stopByToolUse('toolu_1')).toBe(true);
    expect(s.finished).toHaveLength(1);
    const resId = s.finished[0]!.resultId!;
    const full = text(await s.tool('delegate_result', { result_id: resId }));
    expect(full).toContain('第一轮完整回答');
    expect(full).toContain(bigTurn);
  });

  it('files_changed 页脚：收集 edit/delete/move 路径，无变更省略，超过 20 个截断并附 (+N more)', async () => {
    const s = setup();
    const p = s.tool('delegate', { description: '改文件', prompt: 'edit', run_in_background: false });
    await until(() => s.calls.length === 1);
    const upd = (u: Json) => s.calls[0]!.o.onUpdate?.(u);
    // 读操作不计入
    upd({ sessionUpdate: 'tool_call', toolCallId: 'r1', kind: 'read', locations: [{ path: '/work/ignored.ts' }], status: 'completed' });
    // edit / delete / move 计入且去重
    upd({ sessionUpdate: 'tool_call', toolCallId: 'e0', kind: 'edit', locations: [{ path: '/work/a.ts' }], status: 'in_progress' });
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'e0', locations: [{ path: '/work/a.ts' }, { path: '/work/b.ts' }], status: 'completed' });
    upd({ sessionUpdate: 'tool_call', toolCallId: 'd1', kind: 'delete', locations: [{ path: '/work/c.ts' }], status: 'completed' });
    upd({ sessionUpdate: 'tool_call', toolCallId: 'm1', kind: 'move', locations: [{ path: '/work/d.ts' }], status: 'completed' });
    for (let i = 0; i < 19; i++) {
      upd({ sessionUpdate: 'tool_call', toolCallId: `x${i}`, kind: 'edit', locations: [{ path: `/work/f${i}.ts` }], status: 'completed' });
    }
    s.calls[0]!.finish('done');
    const out = text(await p);
    expect(out).not.toContain('/work/ignored.ts');
    expect(out).toMatch(/conversation_id: dlg_[0-9a-f]{24}[^\n]*\nfiles_changed: \/work\/a\.ts, \/work\/b\.ts, \/work\/c\.ts, \/work\/d\.ts,.*\(\+3 more\)\n<usage>/);
  });

  it('files_changed 路径归一：同一文件的不同写法只算一次（实测后端会同时报 F:/x 与 /F:/x）', () => {
    const win = process.platform === 'win32';
    const cwd = win ? 'F:\\repo' : '/repo';
    const a = normFilePath(win ? 'F:/repo/a.txt' : '/repo/a.txt', cwd);
    expect(a).toBe(win ? 'F:/repo/a.txt' : '/repo/a.txt');
    expect(normFilePath('a.txt', cwd)).toBe(a);
    expect(normFilePath(win ? 'file:///F:/repo/a.txt' : 'file:///repo/a.txt', cwd)).toBe(a);
    if (win) {
      expect(normFilePath('/F:/repo/a.txt', cwd)).toBe(a);
      expect(normFilePath('F:\\repo\\sub\\..\\a.txt', cwd)).toBe(a);
    }
  });

  it('计划模式（ctx.readOnly）：拒绝可写智能体及续聊，放行内置 Explore / Plan', async () => {
    const idStore = new Map<string, DelegateIdRecord>();
    const ids = {
      saveId: async (id: string, rec: DelegateIdRecord) => void idStore.set(id, { ...rec }),
      readId: async (id: string) => idStore.get(id) ?? null,
    };
    const s = setup({ ids });
    const roCtx = makeCtx({ readOnly: true });

    // 计划模式下默认 general-purpose 被拒
    const err1 = await s.tool('delegate', { description: 'd', prompt: 'p' }, 'toolu_1', sig(), roCtx);
    expect(err1.isError).toBe(true);
    expect(text(err1)).toBe('Plan mode is read-only: only the Explore and Plan agents can run now. Exit plan mode to delegate implementation work.');

    // 内置 Explore 放行
    const okExplore = await s.tool('delegate', { description: 'd', prompt: 'p', agent: 'Explore' }, 'toolu_2', sig(), roCtx);
    expect(okExplore.isError).toBeUndefined();
    const exploreId = s.jobs.list()[0]!.conversationId;
    await until(() => s.calls.length === 1);
    s.calls[0]!.finish('found');

    // 正常模式启动一个 general-purpose，完成后切到计划模式续聊被拒
    await s.tool('delegate', { description: 'd', prompt: 'p' }, 'toolu_3', sig(), ctx);
    const gpId = s.jobs.list()[1]!.conversationId;
    await until(() => s.calls.length === 2);
    s.calls[1]!.finish('edited');

    const errSend = await s.tool('delegate_send', { conversation_id: gpId, message: 'more' }, 'toolu_4', sig(), roCtx);
    expect(errSend.isError).toBe(true);
    expect(text(errSend)).toContain('Plan mode is read-only');

    // 模拟重启后从 id 记录恢复的会话：Explore 允许在计划模式续聊，general-purpose 拒绝
    const s2 = setup({ ids });
    const errRestored = await s2.tool('delegate_send', { conversation_id: gpId, message: 'more' }, 'toolu_5', sig(), roCtx);
    expect(errRestored.isError).toBe(true);
    expect(text(errRestored)).toContain('Plan mode is read-only');
    const okRestored = await s2.tool('delegate_send', { conversation_id: exploreId, message: 'more' }, 'toolu_6', sig(), roCtx);
    expect(okRestored.isError).toBeUndefined();
  });

  it('jobs 持久化与重启恢复：running 变 error 并生成中断待送达通知；已完成任务保留在 list 中', async () => {
    let saved: any = null;
    const persist = {
      save: async (d: any) => { saved = structuredClone(d); },
      load: () => (saved ? structuredClone(saved) : null),
    };
    const resultsMap = new Map<string, string>();
    const results = {
      saveResult: async (id: string, t: string) => void resultsMap.set(id, t),
      readResult: async (id: string) => resultsMap.get(id) ?? null,
    };

    const s1 = setup({ persist, results });
    await s1.bg('toolu_done');
    const doneId = s1.jobs.list()[0]!.conversationId;
    await until(() => s1.calls.length === 1);
    s1.calls[0]!.finish('ok');
    await until(() => s1.finished.length === 1);
    s1.jobs.ackNotification(s1.finished[0]!);

    await s1.bg('toolu_run');
    const runId = s1.jobs.list()[1]!.conversationId;
    await until(() => s1.calls.length === 2);
    await s1.jobs.flushPersist();
    // 模拟服务端关闭：abortAll 不覆写磁盘上的 running 状态
    s1.jobs.abortAll();
    expect(saved.jobs.find((j: any) => j.conversationId === runId).state).toBe('running');

    // 服务重启：新实例加载 jobs.json
    const s2 = setup({ persist, results });
    const list = s2.jobs.list();
    expect(list.find((j) => j.conversationId === doneId)).toMatchObject({ state: 'done' });
    expect(list.find((j) => j.conversationId === runId)).toMatchObject({
      state: 'error',
      error: 'Interrupted because the service restarted',
    });
    const pending = s2.jobs.pendingNotifications();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.fromRestart).toBe(true);
    expect(pending[0]!.n).toMatchObject({ conversationId: runId, status: 'error' });
    expect(pending[0]!.n.result).toContain('The delegate was interrupted because the service restarted.');
    expect(pending[0]!.n.result).toContain(`conversation_id: ${runId}`);
    // 通知里的原因不带页脚
    expect(formatDelegateNotification(pending[0]!.n)).toMatch(/\nerror: The delegate was interrupted .* if needed\.\n/);
    // 恢复通知的结果也可凭 result_id 取出
    expect(text(await s2.tool('delegate_result', { result_id: pending[0]!.n.resultId! }))).toContain('service restarted');
  });

  it('通知经 shared 的 format / parse 往返', async () => {
    const s = setup();
    await s.bg();
    await until(() => s.calls.length === 1);
    s.calls[0]!.finish('第一行\n第二行');
    await until(() => s.finished.length === 1);
    const wire = formatDelegateNotification(s.finished[0]!);
    expect(wire).not.toContain('第一行');
    expect(wire).toContain('delegate_result');
    expect(parseDelegateNotification(wire)).toEqual({ ...s.finished[0], result: '' });
  });

  it('会话账号绑定：新会话随 onSession 落盘 accountId，续接时传回原 accountId（旧记录缺失视为 default）', async () => {
    const savedIds = new Map<string, DelegateIdRecord>();
    const calls: BackendRunOptions[] = [];
    const run = vi.fn(async (o: BackendRunOptions): Promise<BackendResult> => {
      calls.push(o);
      const sid = o.sessionId ?? 'backend-s1';
      const acc = o.accountId ?? 'acc22222';
      o.onSession?.(sid, acc);
      return { stopReason: 'end_turn', response: 'ok', sessionId: sid, accountId: acc, toolCalls: 0 };
    });
    const jobs = new DelegateJobs({
      run,
      git: noGit,
      ids: {
        saveId: async (id, rec) => { savedIds.set(id, { ...rec }); },
        readId: async (id) => savedIds.get(id) ?? null,
      },
    });
    const ctx = makeCtx();
    // 1) 新会话落盘 accountId
    const r1 = await jobs.callTool('delegate', { description: 'd', prompt: 'p1', run_in_background: false }, ctx, 't1', new AbortController().signal);
    const cid = /conversation_id: (dlg_[0-9a-f]{24})/.exec(r1.content[0].text)![1]!;
    expect(savedIds.get(cid)?.accountId).toBe('acc22222');
    expect(calls[0]!.accountId).toBeUndefined();

    // 2) 续接时传回原 accountId
    await jobs.callTool('delegate', { description: 'd2', prompt: 'p2', conversation_id: cid, run_in_background: false }, ctx, 't2', new AbortController().signal);
    expect(calls[1]!.accountId).toBe('acc22222');

    // 3) 旧记录缺失 accountId 时视为 'default'
    const oldCid = `dlg_${'9'.repeat(24)}`;
    savedIds.set(oldCid, { backend: 'agy', sessionId: 'old-sess', agent: 'general-purpose', cwd: '/work', createdAt: 1 });
    await jobs.callTool('delegate', { description: 'old', prompt: 'p3', conversation_id: oldCid, run_in_background: false }, ctx, 't3', new AbortController().signal);
    expect(calls[2]!.accountId).toBe('default');
  });
});

describe('AcpProgress', () => {
  const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
  const call = (id: string, extra: Json = {}) => ({ sessionUpdate: 'tool_call', toolCallId: id, name: 'run_command', rawInput: { cmd: 'ls' }, status: 'in_progress', ...extra });
  const upd = (id: string, extra: Json) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, ...extra });

  it('文字流：首块开 message，工具调用切段，finish 关块', () => {
    const p = new AcpProgress('P', 'gemini-x');
    const a = p.push(chunk('he'));
    expect(a.map((e) => e.event.type)).toEqual(['message_start', 'content_block_start', 'content_block_delta']);
    const t = p.push(call('c1'));
    expect(t[0]).toMatchObject({ api_message_id: 'agy-P-t0', event: { type: 'content_block_stop' } });
    const f = p.finish();
    expect(f[0]).toMatchObject({ type: 'user', parent_tool_use_id: 'P' });
    expect(p.finish()).toEqual([]);
  });

  it('tool_use / tool_result 各只发一次；failed -> is_error', () => {
    const p = new AcpProgress('P');
    expect(p.push(call('c1'))).toHaveLength(1);
    expect(p.push(upd('c1', { status: 'in_progress' }))).toEqual([]);
    const done = p.push(upd('c1', { status: 'completed', rawOutput: 'out' }));
    expect(done[0].message.content[0]).toMatchObject({ content: 'out', is_error: false });
    expect(p.push(upd('c1', { status: 'completed', rawOutput: 'again' }))).toEqual([]);
  });
});
