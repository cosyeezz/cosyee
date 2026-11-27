import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SUBAGENTS, type SubagentConfig } from '@cosyee/shared';
import { findClaude } from './claude/bin.js';
import { Manager } from './claude/manager.js';
import { Runner } from './claude/runner.js';
import { AgyBackend } from './delegate/acp.js';
import { BackendError, type BackendResult, type BackendRunOptions, type DelegateBackend } from './delegate/backend.js';
import { ClaudeBackend, ClaudeStreamTranslator } from './delegate/claudeBackend.js';
import { DelegateJobs } from './delegate/jobs.js';
import { CosyeeMcp, DELEGATE_TOOL_NAME, DELEGATE_TOOL_NAMES, NATIVE_SUBAGENT_TOOLS } from './delegate/mcp.js';
import type { DelegateIdRecord, PersistedJobs } from './delegate/record.js';
import { startServer } from './server.js';

const noGit = async () => {
  throw new Error('no git');
};

describe('Bug 复现：Windows .cmd 转义 / ClaudeBackend / DelegateJobs / Runner', () => {
  let tmp: string;
  let fakeBin: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-bug- 空格 中文-'));
    const js = path.join(tmp, 'fake-claude.cjs');
    fs.writeFileSync(
      js,
      String.raw`
const args = process.argv.slice(2);
let prompt = '';
process.stdin.on('data', (d) => { prompt += d.toString('utf8'); });
process.stdin.on('end', () => {
  if (prompt === 'ECHO_ARGS') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-args', model: 'claude-sonnet-5-5' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 'sid-args', result: JSON.stringify({ args, prompt, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }) }) + '\n');
    return;
  }
  if (prompt === 'RESULT_THEN_HANG') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-rhang', model: 'claude-sonnet-5-5' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 'sid-rhang', result: 'done-before-hang' }) + '\n');
    setInterval(() => {}, 1000);
    return;
  }
  if (prompt === 'STDOUT_END_THEN_HANG') {
    process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-ehang', model: 'claude-sonnet-5-5' }) + '\n');
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 'sid-ehang', result: 'done-eof' }) + '\n');
    process.stdout.end();
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-ok', model: 'claude-sonnet-5-5' }) + '\n');
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 'sid-ok', result: 'ok:' + prompt }) + '\n');
});
`,
    );
    if (process.platform === 'win32') {
      fakeBin = path.join(tmp, 'fake-claude.cmd');
      // 模拟 npm 生成的 .cmd shim（用 %~dp0 避开 UTF-8/GBK 代码页对硬编码中文路径的影响）
      fs.writeFileSync(fakeBin, `@"${process.execPath}" "%~dp0fake-claude.cjs" %*\r\n`);
    } else {
      fakeBin = path.join(tmp, 'fake-claude.sh');
      fs.writeFileSync(fakeBin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
    }
  });

  afterAll(async () => {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });

  it('Bug 1: Windows .cmd 下 systemPrompt 含引号、&、|、>、%VAR%、^、末尾反斜杠时应原样传递且不命令注入', async () => {
    const b = new ClaudeBackend({ claudePath: fakeBin });
    const dangerousPrompt = 'Use "a & echo INJECTED" and "a | b" and "a > b" with %TEMP% ^caret \\';
    const res = await b.run({
      cwd: tmp,
      prompt: 'ECHO_ARGS',
      systemPrompt: dangerousPrompt,
      account: { id: 'default', dir: null },
      signal: new AbortController().signal,
    });
    const parsed = JSON.parse(res.response) as { args: string[] };
    const idx = parsed.args.indexOf('--append-system-prompt');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(parsed.args[idx + 1]).toBe(dangerousPrompt);
  });

  it('Bug 1b: findClaude 在 Windows PATH 条目带双引号时仍能找到 claude', () => {
    if (process.platform !== 'win32') return;
    const binDir = path.join(tmp, 'quoted path bin');
    fs.mkdirSync(binDir, { recursive: true });
    const target = path.join(binDir, 'claude.cmd');
    fs.writeFileSync(target, '@echo off\r\n');
    const found = findClaude({ PATH: `"${binDir}"` });
    expect(found).toBe(target);
  });

  it('Bug 2: spawnFn 同步抛错时应抛 BackendError（不报 TDZ ReferenceError）并清理临时 settings 文件', async () => {
    const fakeHome = path.join(tmp, 'cosyee-home');
    vi.stubEnv('COSYEE_HOME', fakeHome);
    const apiDir = path.join(tmp, 'api-acc');
    fs.mkdirSync(apiDir, { recursive: true });
    fs.writeFileSync(path.join(apiDir, 'cosyee-api.json'), JSON.stringify({ apiKey: 'sk-test', baseUrl: 'https://example.com' }));
    try {
      const b = new ClaudeBackend({
        claudePath: fakeBin,
        prepareAccount: () => ({ id: 'acc1', dir: apiDir, mainDir: apiDir }),
        spawn: () => {
          throw new Error('EACCES sync');
        },
      });
      await expect(
        b.run({
          cwd: tmp,
          prompt: 'hi',
          signal: new AbortController().signal,
        }),
      ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && e.message.includes('EACCES sync'));

      const runDir = path.join(fakeHome, 'run');
      const left = fs.existsSync(runDir) ? fs.readdirSync(runDir) : [];
      expect(left).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('Bug 3: 收到 result 或 stdout 结束后进程卡住不退出，应在宽限期后杀进程并正常返回结果', async () => {
    const killed: number[] = [];
    const finishCalls: string[] = [];
    const b = new ClaudeBackend({
      claudePath: fakeBin,
      finishAccount: (id) => finishCalls.push(id),
      exitGraceMs: 150,
    });
    const res = await b.run({
      cwd: tmp,
      prompt: 'STDOUT_END_THEN_HANG',
      account: { id: 'default', dir: null },
      signal: new AbortController().signal,
    });
    expect(res.response).toBe('done-eof');
    expect(res.sessionId).toBe('sid-ehang');
    expect(finishCalls).toEqual(['default']);
    void killed;
  }, 3000);

  it('Bug 4: stream_event 缺少顶层 api_message_id 时，应从 message_start.message.id 去重不重复输出', () => {
    const tr = new ClaudeStreamTranslator();
    tr.push({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm-no-top', model: 'claude-sonnet-5-5' } } });
    const d1 = tr.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } },
    });
    expect(d1.updates).toHaveLength(1);
    const a1 = tr.push({
      type: 'assistant',
      message: { id: 'm-no-top', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(a1.updates).toEqual([]);
    expect(tr.finalText).toBe('hello');
  });

  it('Bug 5: 首轮在后端 A 未拿到 sessionId 就失败，切到后端 B 用 delegate_send 重试后应更新记录的 backend 为 B', async () => {
    const savedIds = new Map<string, DelegateIdRecord>();
    const claudeRuns: BackendRunOptions[] = [];
    const agyRuns: BackendRunOptions[] = [];
    const claudeB: DelegateBackend = {
      id: 'claude',
      label: 'Claude',
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async (o) => {
        claudeRuns.push(o);
        throw new Error('claude 首次启动失败');
      },
    };
    const agyB: DelegateBackend = {
      id: 'agy',
      label: 'Antigravity',
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async (o): Promise<BackendResult> => {
        agyRuns.push(o);
        const sid = o.sessionId ?? 'agy-sess-1';
        o.onSession?.(sid, 'default');
        return { stopReason: 'end_turn', response: 'from-agy', sessionId: sid, accountId: 'default', toolCalls: 0 };
      },
    };
    const backendFor = (id: string) => (id === 'claude' ? claudeB : id === 'agy' ? agyB : null);
    const jobs = new DelegateJobs({
      git: noGit,
      ids: {
        saveId: async (id, rec) => { savedIds.set(id, { ...rec }); },
        readId: async (id) => savedIds.get(id) ?? null,
      },
    });
    const baseScope = { configDir: '', cwd: tmp, disabled: [] };

    // 1. claude 首次启动失败，未拿到 sessionId
    const r1 = await jobs.callTool(
      'delegate',
      { description: 'd', prompt: 'p1', run_in_background: false },
      { cwd: tmp, backend: claudeB, backendFor, agents: baseScope },
      't1',
      new AbortController().signal,
    );
    expect(r1.isError).toBe(true);
    const cid = jobs.list()[0]!.conversationId;

    // 2. 切到 agy 后用 delegate_send 重试，成功创建 agy 会话
    await jobs.callTool(
      'delegate_send',
      { conversation_id: cid, message: 'p2' },
      { cwd: tmp, backend: agyB, backendFor, agents: baseScope },
      't2',
      new AbortController().signal,
    );
    for (let i = 0; i < 50 && jobs.list()[0]!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(agyRuns).toHaveLength(1);
    expect(savedIds.get(cid)?.backend).toBe('agy');
    expect(savedIds.get(cid)?.sessionId).toBe('agy-sess-1');

    // 3. 再次续接时（即使当前切回 claude），应按记录找回 agy 而不是把 agy-sess-1 传给 claude
    await jobs.callTool(
      'delegate_send',
      { conversation_id: cid, message: 'p3' },
      { cwd: tmp, backend: claudeB, backendFor, agents: baseScope },
      't3',
      new AbortController().signal,
    );
    for (let i = 0; i < 50 && jobs.list()[0]!.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(agyRuns).toHaveLength(2);
    expect(agyRuns[1]!.sessionId).toBe('agy-sess-1');
    expect(claudeRuns).toHaveLength(1);
  });

  it('Bug 6: Runner.effectiveSubagent 未传 baseDeny 时也应尊重 flagSettings 中停用的 mcp__cosyee__delegate', () => {
    let denied: string[] = [];
    const agyBackend: DelegateBackend = {
      id: 'agy',
      label: 'Agy',
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ stopReason: 'end_turn', response: '', sessionId: 's', toolCalls: 0 }),
    };
    const r = new Runner({
      sessionId: '11111111-2222-4333-8444-555555555555',
      cwd: tmp,
      isNew: true,
      config: { model: 'haiku', effort: 'low' },
      delegateBackends: { agy: agyBackend },
      subagents: () => ({
        mode: 'delegate',
        native: { model: 'sonnet', effort: 'medium' },
        delegate: { default: { backend: 'agy', accountId: 'default', model: null, effort: null } },
      }),
      flagSettings: () => (denied.length ? { permissions: { deny: denied } } : {}),
      hooks: {
        onEvent: () => {},
        onStatus: () => {},
        onSettings: () => {},
        onTurnEnd: () => {},
        onExit: () => {},
      },
    });
    expect(r.effectiveSubagent()).toBe('delegate');
    denied = [DELEGATE_TOOL_NAME];
    expect(r.effectiveSubagent()).toBe('native');
  });

  it('Bug 7: Manager 运行中切换子代理类型（apply_flag_settings 全量替换）正确停用原生子代理工具且切回原生不误放用户停用的项', async () => {
    let subCfg: SubagentConfig = structuredClone(DEFAULT_SUBAGENTS);
    let userDisabled: string[] = ['SendMessage', 'Glob'];
    const okBackend = (id: string): DelegateBackend => ({
      id,
      label: id,
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ stopReason: 'end_turn', response: '', sessionId: 's', toolCalls: 0 }),
    });
    const m = new Manager({
      dots: {} as never,
      sessions: {} as never,
      delegateBackends: { claude: okBackend('claude'), agy: okBackend('agy') },
      subagents: {
        get: () => subCfg,
        set: (c) => { subCfg = structuredClone(c); },
      },
      tools: {
        get: () => userDisabled,
        set: (list) => { userDisabled = [...list]; },
      },
    });

    const pushedDenies: string[][] = [];
    const r = (m as any).createRunner('11111111-1111-4111-8111-111111111111', tmp, false, { model: 'sonnet', effort: 'medium' }, false) as Runner;
    (r as any).mcp = {};
    Object.defineProperty(r, 'alive', { get: () => true });
    (r as any).request = async (subtype: string, extra: any) => {
      if (subtype === 'apply_flag_settings') pushedDenies.push(extra.settings.permissions.deny);
      return {};
    };
    (m as any).runners.set(r.sessionId, r);

    const delegateCfg = (backend: 'claude' | 'agy'): SubagentConfig => ({
      ...structuredClone(DEFAULT_SUBAGENTS),
      mode: 'delegate',
      delegate: { default: { backend, accountId: 'default', model: null, effort: null } },
    });

    // 1. 切到 claude：补齐全部原生子代理工具，SendMessage 不重复，保留用户停用的 Glob
    await m.setSubagents(delegateCfg('claude'));
    expect(pushedDenies.at(-1)).toEqual(['SendMessage', 'Glob', 'Agent', 'ListAgents', 'TeamCreate', 'TeamDelete']);
    expect(pushedDenies.at(-1)).not.toContain('TaskStop');
    expect(pushedDenies.at(-1)).not.toContain('Monitor');

    // 2. 切到 agy：同样全量停用原生子代理工具
    await m.setSubagents(delegateCfg('agy'));
    expect(pushedDenies.at(-1)).toEqual(['SendMessage', 'Glob', 'Agent', 'ListAgents', 'TeamCreate', 'TeamDelete']);

    // 3. 切回 native：移除我们加的 Agent/ListAgents/TeamCreate/TeamDelete，但保留用户停用的 SendMessage 与 Glob，并停用 delegate 系列
    await m.setSubagents({ ...structuredClone(DEFAULT_SUBAGENTS), mode: 'native' });
    expect(pushedDenies.at(-1)).toEqual(['SendMessage', 'Glob', ...DELEGATE_TOOL_NAMES]);

    // 4. 确认 NATIVE_SUBAGENT_TOOLS 导出值
    expect(NATIVE_SUBAGENT_TOOLS).toEqual(['Agent', 'SendMessage', 'ListAgents', 'TeamCreate', 'TeamDelete']);
  });

  it('Bug 8: AgyBackend.getPath 不应永久缓存 null 或已卸载路径，安装/卸载 agy 后 available() 应实时反映', () => {
    let current: string | null = null;
    const b = new AgyBackend({ resolve: () => current });
    expect(b.available()).toBe(false);
    // 运行中安装 agy
    current = '/usr/local/bin/agy';
    expect(b.available()).toBe(true);
    // 运行中卸载 agy
    current = null;
    expect(b.available()).toBe(false);
  });

  it('Bug 9: 启动时未注册 cosyee MCP 的会话，后续切到 claude/agy 时 fetchContext 应按该 runner 实际状态上报 nativeAgents: true', async () => {
    let subCfg: SubagentConfig = {
      ...structuredClone(DEFAULT_SUBAGENTS),
      mode: 'delegate',
      delegate: { default: { backend: 'claude', accountId: 'default', model: null, effort: null } },
    };
    const okBackend = (id: string): DelegateBackend => ({
      id,
      label: id,
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ stopReason: 'end_turn', response: '', sessionId: 's', toolCalls: 0 }),
    });
    const m = new Manager({
      dots: {} as never,
      sessions: {} as never,
      delegateBackends: { claude: okBackend('claude'), agy: okBackend('agy') },
      subagents: {
        get: () => subCfg,
        set: (c) => { subCfg = structuredClone(c); },
      },
    });
    const sid = '22222222-2222-4222-8222-222222222222';
    const r = (m as any).createRunner(sid, tmp, false, { model: 'sonnet', effort: 'medium' }, false) as Runner;
    // 模拟启动时未注册 cosyee MCP（如启动时 delegate 被停用或无可用后端）
    (r as any).mcp = null;
    (r as any).request = async (subtype: string) => {
      if (subtype === 'get_context_usage') return { categories: [], totalTokens: 10, maxTokens: 100, percentage: 10 };
      return null;
    };
    const usage = await (m as any).fetchContext(r);
    // 该进程未注册 MCP，实际仍在用原生 Agent，nativeAgents 应为 true
    expect(usage.nativeAgents).toBe(true);

    // 若注册了 MCP，则按 claude 模式生效，nativeAgents 为 false
    (r as any).mcp = {};
    const usage2 = await (m as any).fetchContext(r);
    expect(usage2.nativeAgents).toBe(false);
  });

  it('Bug 10: Manager.pushDeny 并发调用时应串行化且不让早先的调用乱序覆盖 contextCache', async () => {
    let subCfg: SubagentConfig = structuredClone(DEFAULT_SUBAGENTS);
    let userDisabled: string[] = [];
    const okBackend = (id: string): DelegateBackend => ({
      id,
      label: id,
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ stopReason: 'end_turn', response: '', sessionId: 's', toolCalls: 0 }),
    });
    const m = new Manager({
      dots: {} as never,
      sessions: {} as never,
      delegateBackends: { claude: okBackend('claude'), agy: okBackend('agy') },
      subagents: {
        get: () => subCfg,
        set: (c) => { subCfg = structuredClone(c); },
      },
      tools: {
        get: () => userDisabled,
        set: (list) => { userDisabled = [...list]; },
      },
    });

    // 一个活着但响应快慢不一的 runner，用于制造并发乱序窗口
    const sidAlive = '33333333-3333-4333-8333-333333333333';
    const rAlive = (m as any).createRunner(sidAlive, tmp, false, { model: 'sonnet', effort: 'medium' }, false) as Runner;
    (rAlive as any).mcp = {};
    Object.defineProperty(rAlive, 'alive', { get: () => true });
    const resolvers: (() => void)[] = [];
    const applyOrder: string[][] = [];
    (rAlive as any).request = (subtype: string, extra: any) => {
      if (subtype === 'apply_flag_settings') {
        applyOrder.push(extra.settings.permissions.deny);
        return new Promise<void>((res) => { resolvers.push(() => res()); });
      }
      return Promise.resolve({});
    };
    (m as any).runners.set(sidAlive, rAlive);

    // 一个无活进程、但面板开着的会话（命中 contextCache 路径）
    const sidIdle = '44444444-4444-4444-8444-444444444444';
    const emitted: any[] = [];
    (m as any).subs.set(sidIdle, new Set([{ send: (msg: any) => emitted.push(msg) }]));
    (m as any).contextCache.set(sidIdle, {
      categories: [],
      totalTokens: 0,
      maxTokens: 100,
      percentage: 0,
      skills: [],
      mcpServers: [],
      disabledTools: [],
      disabledAgents: [],
      nativeAgents: true,
    });

    // 先发起第一次切换（delegate）并等待它进入在途的 apply_flag_settings
    const p1 = m.setSubagents({
      ...structuredClone(DEFAULT_SUBAGENTS),
      mode: 'delegate',
      delegate: { default: { backend: 'claude', accountId: 'default', model: null, effort: null } },
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolvers).toHaveLength(1);

    // p1 仍在 await 期间并发发起第二次切换（native）：串行链应让 p2 排队，不并发发出第二个 request
    const p2 = m.setSubagents({ ...structuredClone(DEFAULT_SUBAGENTS), mode: 'native' });
    await new Promise((r) => setTimeout(r, 10));
    expect(resolvers).toHaveLength(1);
    resolvers.shift()!();
    await new Promise((r) => setTimeout(r, 10));
    expect(resolvers).toHaveLength(1);
    resolvers.shift()!();
    await Promise.all([p1, p2]);

    // 最终 contextCache 必须反映最后一次（native）状态
    expect(m.getContext(sidIdle)?.nativeAgents).toBe(true);
    expect(emitted.at(-1)?.usage?.nativeAgents).toBe(true);
    // 发给 CLI 的顺序也严格先 claude 后 native
    expect(applyOrder).toHaveLength(2);
    expect(applyOrder[0]).toEqual([...NATIVE_SUBAGENT_TOOLS]);
    expect(applyOrder[1]).toEqual([...DELEGATE_TOOL_NAMES]);
  });

  it('Bug 11: server.ts 的 Accounts.running(id) 应计入运行中的 Claude 委派子进程（主代理无会话时禁止删除/修改该账号）', async () => {
    const srvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-srv-accrun-'));
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_HOME', 'COSYEE_ACCOUNTS_DIR', 'COSYEE_SUBAGENT_ACCOUNTS_DIR', 'COSYEE_AGY_ACCOUNTS_DIR']) {
      savedEnv[k] = process.env[k];
    }
    process.env.CLAUDE_CONFIG_DIR = path.join(srvDir, 'claude-home');
    process.env.COSYEE_HOME = path.join(srvDir, 'cosyee-home');
    process.env.COSYEE_ACCOUNTS_DIR = path.join(srvDir, 'accounts');
    process.env.COSYEE_SUBAGENT_ACCOUNTS_DIR = path.join(srvDir, 'subagents');
    process.env.COSYEE_AGY_ACCOUNTS_DIR = path.join(srvDir, 'agy-accounts');
    fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });

    const hangJs = path.join(srvDir, 'hang-claude.cjs');
    fs.writeFileSync(
      hangJs,
      String.raw`
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-accrun', model: 'claude-sonnet-5-5' }) + '\n');
  setInterval(() => {}, 1000);
});
`,
    );
    const hangBin = process.platform === 'win32' ? path.join(srvDir, 'hang-claude.cmd') : path.join(srvDir, 'hang-claude.sh');
    if (process.platform === 'win32') {
      fs.writeFileSync(hangBin, `@"${process.execPath}" "%~dp0hang-claude.cjs" %*\r\n`);
    } else {
      fs.writeFileSync(hangBin, `#!/bin/sh\nexec "${process.execPath}" "${hangJs}" "$@"\n`, { mode: 0o755 });
    }

    const srv = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(srvDir, 'state.json'),
      claudePath: hangBin,
    });
    const base = `http://127.0.0.1:${srv.port}`;
    try {
      // 添加一个 API 账号并设为 Claude 子代理账号
      const addResp = await fetch(`${base}/api/accounts/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'SubApi', baseUrl: 'https://example.invalid', apiKey: 'sk-test-1' }),
      });
      expect(addResp.status).toBe(200);
      const { id: accId } = (await addResp.json()) as { ok: boolean; id: string };
      expect(accId).toBeTruthy();

      const setSubResp = await fetch(`${base}/api/accounts/subagent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: accId }),
      });
      expect(setSubResp.status).toBe(200);

      // 主代理无任何会话，直接用 server 内部的 claudeBackend 启动一个委派进程
      const claudeBackend = (srv.manager as any).delegateBackends.claude as ClaudeBackend;
      const ac = new AbortController();
      let started = false;
      const runP = claudeBackend.run({
        cwd: srvDir,
        prompt: 'wait',
        signal: ac.signal,
        onSession: () => { started = true; },
      });
      for (let i = 0; i < 100 && !started; i++) await new Promise((r) => setTimeout(r, 20));
      expect(started).toBe(true);
      expect(claudeBackend.runningCount(accId)).toBe(1);

      // 运行中尝试删除账号 -> 必须返回 409 拒绝
      const delBusy = await fetch(`${base}/api/accounts/remove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: accId }),
      });
      expect(delBusy.status).toBe(409);

      // 运行中尝试修改该账号 API 配置 -> 必须返回 409 拒绝
      const editBusy = await fetch(`${base}/api/accounts/api`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: accId, label: 'SubApi', baseUrl: 'https://example.invalid', apiKey: 'sk-test-2' }),
      });
      expect(editBusy.status).toBe(409);

      // 停止委派子进程后，runningCount 归零，允许删除账号
      ac.abort();
      await expect(runP).rejects.toThrow('已取消');
      expect(claudeBackend.runningCount(accId)).toBe(0);

      const delOk = await fetch(`${base}/api/accounts/remove`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: accId }),
      });
      expect(delOk.status).toBe(200);
    } finally {
      await srv.stop();
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      for (let i = 0; i < 10; i++) {
        try {
          fs.rmSync(srvDir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  }, 15_000);

  it('端到端集成：ClaudeBackend + DelegateJobs 续接（--resume）、原后端不可用、stop 不发通知与重复 stop、超时、steer / queue', async () => {
    const js = path.join(tmp, 'e2e-claude.cjs');
    fs.writeFileSync(
      js,
      String.raw`
const args = process.argv.slice(2);
const resumeIdx = args.indexOf('--resume');
const resumed = resumeIdx >= 0 ? args[resumeIdx + 1] : null;
let prompt = '';
process.stdin.on('data', (d) => { prompt += d.toString('utf8'); });
process.stdin.on('end', () => {
  const sid = resumed || 'claude-sess-e2e';
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-sonnet-5-5' }) + '\n');
  if (prompt.includes('SLOW_HANG')) {
    process.stdout.write(JSON.stringify({ type: 'stream_event', api_message_id: 'm1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'working...' } } }) + '\n');
    setInterval(() => {}, 1000);
    return;
  }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: sid, result: 'resumed=' + String(resumed) + '|body=' + prompt.split('\n').pop() }) + '\n');
});
`,
    );
    const e2eBin = process.platform === 'win32' ? path.join(tmp, 'e2e-claude.cmd') : path.join(tmp, 'e2e-claude.sh');
    if (process.platform === 'win32') {
      fs.writeFileSync(e2eBin, `@"${process.execPath}" "%~dp0e2e-claude.cjs" %*\r\n`);
    } else {
      fs.writeFileSync(e2eBin, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
    }

    let claudeAvail = true;
    const claudeB = new ClaudeBackend({ resolve: () => (claudeAvail ? e2eBin : null) });
    const agyB: DelegateBackend = {
      id: 'agy',
      label: 'Antigravity',
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ stopReason: 'end_turn', response: 'agy-reply', sessionId: 'agy-s', toolCalls: 0 }),
    };
    const backendFor = (id: string) => (id === 'claude' ? claudeB : id === 'agy' ? agyB : null);
    const finished: any[] = [];
    const jobs = new DelegateJobs({
      git: noGit,
      onFinish: (n) => finished.push(n),
    });
    const scope = { configDir: '', cwd: tmp, disabled: [] };

    // 1. 新建任务走 claude，随后切换默认后端为 agy，delegate_send 仍找回 claude 并传 --resume
    const r1 = await jobs.callTool(
      'delegate',
      { description: 'first', prompt: 'STEP1', run_in_background: false },
      { cwd: tmp, backend: claudeB, backendFor, agents: scope },
      'tu-1',
      new AbortController().signal,
    );
    expect(r1.isError).toBeUndefined();
    const cid = /conversation_id: (dlg_[0-9a-f]{24})/.exec(r1.content[0].text)![1]!;
    expect(r1.content[0].text).toContain('resumed=null|body=STEP1');

    const r2 = await jobs.callTool(
      'delegate_send',
      { conversation_id: cid, message: 'STEP2' },
      { cwd: tmp, backend: agyB, backendFor, agents: scope },
      'tu-2',
      new AbortController().signal,
    );
    expect(r2.isError).toBeUndefined();
    for (let i = 0; i < 100 && finished.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(finished).toHaveLength(1);
    expect(finished[0].status).toBe('done');
    expect(finished[0].result).toContain('resumed=claude-sess-e2e|body=STEP2');

    // 2. 原后端不可用时续接报错
    claudeAvail = false;
    await jobs.callTool(
      'delegate_send',
      { conversation_id: cid, message: 'STEP3' },
      { cwd: tmp, backend: agyB, backendFor, agents: scope },
      'tu-3',
      new AbortController().signal,
    );
    for (let i = 0; i < 100 && finished.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    expect(finished[1].status).toBe('error');
    expect(finished[1].result).toContain('当前不可用');
    claudeAvail = true;

    // 3. 后台任务被 delegate_stop 停止：不发通知，重复 stop 安全返回
    const rHang = await jobs.callTool(
      'delegate',
      { description: 'hang', prompt: 'SLOW_HANG', run_in_background: true },
      { cwd: tmp, backend: claudeB, backendFor, agents: scope },
      'tu-hang',
      new AbortController().signal,
    );
    const hangCid = /conversation_id: (dlg_[0-9a-f]{24})/.exec(rHang.content[0].text)![1]!;
    for (let i = 0; i < 100 && !jobs.list().find((j) => j.conversationId === hangCid)?.tail; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const stop1 = await jobs.callTool('delegate_stop', { conversation_id: hangCid }, { cwd: tmp, backend: claudeB, backendFor, agents: scope }, 'tu-s1', new AbortController().signal);
    expect(stop1.content[0].text).toContain('Stopped delegate');
    const stop2 = await jobs.callTool('delegate_stop', { conversation_id: hangCid }, { cwd: tmp, backend: claudeB, backendFor, agents: scope }, 'tu-s2', new AbortController().signal);
    expect(stop2.content[0].text).toContain('already stopped');
    await new Promise((r) => setTimeout(r, 80));
    expect(finished).toHaveLength(2); // stop 后没有新通知

    // 4. 运行中 steer 打断并带 --resume 重跑
    const rSteer = await jobs.callTool(
      'delegate',
      { description: 'steer', prompt: 'SLOW_HANG', run_in_background: true },
      { cwd: tmp, backend: claudeB, backendFor, agents: scope },
      'tu-st',
      new AbortController().signal,
    );
    const steerCid = /conversation_id: (dlg_[0-9a-f]{24})/.exec(rSteer.content[0].text)![1]!;
    for (let i = 0; i < 100 && !jobs.list().find((j) => j.conversationId === steerCid)?.tail; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const sendSteer = await jobs.callTool(
      'delegate_send',
      { conversation_id: steerCid, message: 'REDIRECTED', mode: 'steer' },
      { cwd: tmp, backend: claudeB, backendFor, agents: scope },
      'tu-st2',
      new AbortController().signal,
    );
    expect(sendSteer.content[0].text).toContain('interrupted and restarts');
    for (let i = 0; i < 100 && finished.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    expect(finished[2].status).toBe('done');
    expect(finished[2].result).toContain('working...');
    expect(finished[2].result).toContain('interrupted by a new message');
    expect(finished[2].result).toContain('resumed=claude-sess-e2e|body=REDIRECTED');

    // 5. 超时自动停止并通知（独立 DelegateJobs 设短 maxJobMs，避免并发负载下误伤前面步骤）
    const timeoutFinished: any[] = [];
    const timeoutJobs = new DelegateJobs({
      git: noGit,
      maxJobMs: 300,
      onFinish: (n) => timeoutFinished.push(n),
    });
    await timeoutJobs.callTool(
      'delegate',
      { description: 'timeout', prompt: 'SLOW_HANG', run_in_background: true },
      { cwd: tmp, backend: claudeB, backendFor, agents: scope },
      'tu-to',
      new AbortController().signal,
    );
    for (let i = 0; i < 100 && timeoutFinished.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    expect(timeoutFinished).toHaveLength(1);
    expect(timeoutFinished[0].status).toBe('error');
    expect(timeoutFinished[0].result).toContain('超时');
  }, 15_000);

  it('续聊时传 agent 参数在内存 job 下也生效并同步更新 idRecord 与持久化 jobs；不传则沿用原 agent', async () => {
    const ws = fs.mkdtempSync(path.join(tmp, 'resume-agent-'));
    const agentsDir = path.join(ws, '.claude', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, 'narrow-reviewer.md'),
      ['---', 'name: narrow-reviewer', 'description: Restricted reviewer', 'tools: Read, Grep', 'disallowedTools: [Bash]', '---', 'Review only.'].join('\n'),
    );

    const runs: BackendRunOptions[] = [];
    const savedIds = new Map<string, DelegateIdRecord>();
    let persisted: PersistedJobs | null = null;
    const stubBackend: DelegateBackend = {
      id: 'claude',
      label: 'Claude',
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async (o): Promise<BackendResult> => {
        runs.push(o);
        const sid = o.sessionId ?? 'claude-sid-resume-1';
        o.onSession?.(sid, 'default');
        return { stopReason: 'end_turn', response: 'ok', sessionId: sid, accountId: 'default', toolCalls: 0 };
      },
    };
    const jobs = new DelegateJobs({
      git: noGit,
      ids: {
        saveId: async (id, rec) => { savedIds.set(id, { ...rec }); },
        readId: async (id) => savedIds.get(id) ?? null,
      },
      persist: {
        save: async (data) => { persisted = structuredClone(data); },
        load: () => persisted,
      },
    });
    const scope = { configDir: '', cwd: ws, disabled: [] as string[] };

    // 1. 新建：general-purpose
    const r1 = await jobs.callTool(
      'delegate',
      { description: 'first', prompt: 'p1', run_in_background: false },
      { cwd: ws, backend: stubBackend, agents: scope },
      'tu-1',
      new AbortController().signal,
    );
    expect(r1.isError).toBeUndefined();
    const cid = jobs.list()[0]!.conversationId;
    expect(savedIds.get(cid)?.agent).toBe('general-purpose');
    await jobs.flushPersist();
    expect(persisted!.jobs[0]!.agent).toBe('general-purpose');

    // 2. 内存非 restored job 续聊并显式切换 agent -> 生效且更新 idRecord 与 persisted
    const r2 = await jobs.callTool(
      'delegate',
      { conversation_id: cid, description: 'second', prompt: 'p2', agent: 'narrow-reviewer', run_in_background: false },
      { cwd: ws, backend: stubBackend, agents: scope },
      'tu-2',
      new AbortController().signal,
    );
    expect(r2.isError).toBeUndefined();
    expect(runs[1]!.sessionId).toBe('claude-sid-resume-1');
    expect(runs[1]!.tools).toEqual(['Read', 'Grep']);
    expect(runs[1]!.disallowedTools).toEqual(['Bash']);
    expect(savedIds.get(cid)?.agent).toBe('narrow-reviewer');
    await jobs.flushPersist();
    expect(persisted!.jobs[0]!.agent).toBe('narrow-reviewer');

    // 3. 再次续聊不传 agent -> 沿用 narrow-reviewer
    const r3 = await jobs.callTool(
      'delegate',
      { conversation_id: cid, description: 'third', prompt: 'p3', run_in_background: false },
      { cwd: ws, backend: stubBackend, agents: scope },
      'tu-3',
      new AbortController().signal,
    );
    expect(r3.isError).toBeUndefined();
    expect(runs[2]!.tools).toEqual(['Read', 'Grep']);
    expect(runs[2]!.disallowedTools).toEqual(['Bash']);

    // 4. 续聊传入被禁用的 agent -> 拒绝，不改原记录
    const r4 = await jobs.callTool(
      'delegate',
      { conversation_id: cid, description: 'fourth', prompt: 'p4', agent: 'Explore', run_in_background: false },
      { cwd: ws, backend: stubBackend, agents: { ...scope, disabled: ['Explore'] } },
      'tu-4',
      new AbortController().signal,
    );
    expect(r4.isError).toBe(true);
    expect(r4.content[0].text).toContain('turned off in settings');
    expect(savedIds.get(cid)?.agent).toBe('narrow-reviewer');

    // 5. 续聊切到内置 Explore -> 同步更新 idRecord
    const r5 = await jobs.callTool(
      'delegate',
      { conversation_id: cid, description: 'fifth', prompt: 'p5', agent: 'Explore', run_in_background: false },
      { cwd: ws, backend: stubBackend, agents: scope },
      'tu-5',
      new AbortController().signal,
    );
    expect(r5.isError).toBeUndefined();
    expect(savedIds.get(cid)?.agent).toBe('Explore');
    expect(runs[3]!.disallowedTools).toContain('Edit');
    expect(runs[3]!.tools).toBeUndefined();
  });

  it('CosyeeMcp tools/list 动态按最新磁盘智能体与 disabledAgents 刷新 delegate 工具描述', async () => {
    const ws = fs.mkdtempSync(path.join(tmp, 'mcp-refresh-'));
    const agentsDir = path.join(ws, '.claude', 'agents');
    let disabled: string[] = [];
    const stubBackend: DelegateBackend = {
      id: 'claude',
      label: 'Claude',
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ stopReason: 'end_turn', response: 'ok', sessionId: 's', toolCalls: 0 }),
    };
    const jobs = new DelegateJobs({ git: noGit });
    const mcp = new CosyeeMcp({
      jobs,
      ctx: () => ({ cwd: ws, backend: stubBackend, agents: { configDir: '', cwd: ws, disabled } }),
    });

    const delegateDesc = async () => {
      const res = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      return (res.result.tools as { name: string; description: string }[]).find((t) => t.name === 'delegate')!.description;
    };

    // 1. 初始无自定义智能体
    expect(await delegateDesc()).not.toContain('Others:');

    // 2. 运行中新增磁盘自定义智能体 -> 立即出现在 tools/list
    fs.mkdirSync(agentsDir, { recursive: true });
    const mdPath = path.join(agentsDir, 'hot-agent.md');
    fs.writeFileSync(mdPath, ['---', 'name: hot-agent', 'description: Hot loaded agent', '---', 'Body'].join('\n'));
    expect(await delegateDesc()).toContain('Others: hot-agent.');

    // 3. 禁用该智能体 -> 从 tools/list 消失
    disabled = ['hot-agent'];
    expect(await delegateDesc()).not.toContain('hot-agent');

    // 4. 重新启用 -> 恢复；删除磁盘文件 -> 再次消失
    disabled = [];
    expect(await delegateDesc()).toContain('Others: hot-agent.');
    fs.unlinkSync(mdPath);
    expect(await delegateDesc()).not.toContain('hot-agent');
  });
});
