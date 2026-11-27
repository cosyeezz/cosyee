// 按代理类型单独配置模型/强度、/api/subagents?cwd=、原生 hook 优先级、
// Claude/agy 委派优先级与续接、只读类型 --disallowedTools、自定义 tools 映射与类型开关测试。
// 全程使用临时目录与 mock，绝不触碰真实 ~/.claude 或 ~/.cosyee。
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SUBAGENTS, type ServerMsg, type SubagentConfig, type SubagentState } from '@cosyee/shared';
import { checkClaudeLoggedIn } from './accounts/index.js';
import { Manager } from './claude/manager.js';
import { type AgentDefaults, Runner } from './claude/runner.js';
import { ComponentUpdater } from './components/updater.js';
import { AgyBackend } from './delegate/acp.js';
import { listAllAgents } from './delegate/agents.js';
import type { BackendResult, BackendRunOptions, DelegateBackend } from './delegate/backend.js';
import { buildClaudeDelegateArgs, ClaudeBackend, READ_ONLY_DISALLOWED_TOOLS } from './delegate/claudeBackend.js';
import { DelegateJobs } from './delegate/jobs.js';
import { DELEGATE_TOOL_NAME, NATIVE_SUBAGENT_TOOLS } from './delegate/mcp.js';
import { createHandler, type HttpDeps } from './http.js';
import { Sessions } from './sessions.js';
import { DotState } from './state.js';
import type { Json } from './transcript.js';
import { parseSubagents, sanitizeSubagents, StateStore, Workspaces } from './workspaces.js';

const temps: string[] = [];
function mkTmp(prefix = 'cosyee-agent-cfg-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    const dir = temps.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const noGit = async () => {
  throw new Error('no git');
};

function writeAgentMd(dir: string, filename: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
}

describe('配置校验与落盘（agents 类型覆写）', () => {
  const base: SubagentConfig = structuredClone(DEFAULT_SUBAGENTS);

  it('合法的 agents 覆写通过校验并落盘；全 null 项与非法项静默丢弃不导致 400', () => {
    const input = {
      ...base,
      native: {
        ...base.native,
        agents: {
          Explore: { model: 'haiku', effort: 'low' },
          Plan: { model: null, effort: 'high' },
          'all-null': { model: null, effort: null },
          'bad name': { model: 'opus', effort: 'high' },
          'bad(paren)': { model: 'opus', effort: 'high' },
          'bad-model': { model: 'gpt-5', effort: 'high' },
          'bad-effort': { model: 'opus', effort: 'ultra' },
          'not-obj': 'opus',
        },
      },
      delegate: {
        default: { backend: 'claude', accountId: 'default', model: 'sonnet', effort: 'medium' },
        agents: {
          'my-agent': { backend: 'claude', accountId: 'default', model: 'opus', effort: null },
          'plugin:review': { backend: 'claude', accountId: 'acc1', model: 'sonnet', effort: 'max' },
          Explore: { backend: 'agy', accountId: 'agy1', model: 'gemini-3-flash', effort: 'low' },
          'too-long': { backend: 'agy', accountId: 'agy1', model: 'a'.repeat(121), effort: null },
          'max-len': { backend: 'agy', accountId: 'agy1', model: 'a'.repeat(120), effort: null },
          'with-space': { backend: 'agy', accountId: 'agy1', model: 'bad model', effort: 'high' },
          'bad-backend': { backend: 'unknown', accountId: 'x', model: null, effort: null },
          'bad-account': { backend: 'claude', accountId: 'bad id!', model: null, effort: null },
          'bad name': { backend: 'claude', accountId: 'default', model: 'opus', effort: null },
        },
      },
    };
    const parsed = parseSubagents(input);
    expect(parsed).not.toBeNull();
    expect(parsed!.native.agents).toEqual({
      Explore: { model: 'haiku', effort: 'low' },
      Plan: { model: null, effort: 'high' },
    });
    expect(parsed!.delegate.agents).toEqual({
      'my-agent': { backend: 'claude', accountId: 'default', model: 'opus', effort: null },
      'plugin:review': { backend: 'claude', accountId: 'acc1', model: 'sonnet', effort: 'max' },
      Explore: { backend: 'agy', accountId: 'agy1', model: 'gemini-3-flash', effort: 'low' },
      'too-long': { backend: 'agy', accountId: 'agy1', model: null, effort: null },
      'max-len': { backend: 'agy', accountId: 'agy1', model: 'a'.repeat(120), effort: null },
      'with-space': { backend: 'agy', accountId: 'agy1', model: null, effort: 'high' },
    });
  });

  it('顶层 agents 非对象（数组 / null / 原始值）返回 null（400）', () => {
    expect(parseSubagents({ ...base, native: { ...base.native, agents: [] } })).toBeNull();
    expect(parseSubagents({ ...base, delegate: { ...base.delegate, agents: null } })).toBeNull();
    expect(parseSubagents({ ...base, delegate: { ...base.delegate, agents: 'bad' } })).toBeNull();
  });

  it('最多保留 200 项；全丢弃时不保留空 agents 字段；老配置无 agents 照常可用', async () => {
    const many: Record<string, { model: string; effort: null }> = {};
    for (let i = 0; i < 230; i++) many[`agent-${i}`] = { model: 'haiku', effort: null };
    const sanitized = sanitizeSubagents({ ...base, native: { ...base.native, agents: many } });
    expect(Object.keys(sanitized.native.agents ?? {})).toHaveLength(200);

    const allDropped = parseSubagents({
      ...base,
      native: { ...base.native, agents: { Explore: { model: null, effort: null } } },
    });
    expect(allDropped).toEqual(base);
    expect(allDropped!.native.agents).toBeUndefined();

    // 老配置落盘与重载兼容
    const dir = mkTmp();
    const sf = path.join(dir, 'state.json');
    fs.writeFileSync(sf, JSON.stringify({ subagents: base }));
    const store = new StateStore(sf);
    expect(store.state.subagents).toEqual(base);
  });
});

describe('GET / POST /api/subagents?cwd= 与代理类型列表', () => {
  it('返回内置与项目/用户自定义智能体（含 frontmatter model/effort、readOnly 标记），已关闭类型仍在列表里', async () => {
    const dir = mkTmp();
    const configDir = path.join(dir, 'claude-config');
    const cwd = path.join(dir, 'project');
    fs.mkdirSync(cwd, { recursive: true });
    writeAgentMd(
      path.join(cwd, '.claude', 'agents'),
      'reviewer.md',
      [
        '---',
        'name: reviewer',
        'description: Project code reviewer',
        'model: opus',
        'effort: high',
        'tools: Read, Grep',
        '---',
        'Review code carefully.',
      ].join('\n'),
    );
    writeAgentMd(
      path.join(configDir, 'agents'),
      'helper.md',
      [
        '---',
        'name: helper',
        'description: User helper agent',
        'model: haiku',
        '---',
        'Help with tasks.',
      ].join('\n'),
    );

    const store = new StateStore(path.join(dir, 'state.json'));
    const workspaces = new Workspaces(store);
    const dots = new DotState(store);
    const sessions = new Sessions(dots);
    const fakeBackend = (id: 'claude' | 'agy'): DelegateBackend => ({
      id,
      label: id,
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ sessionId: 's', response: '', toolCalls: 0, stopReason: 'end_turn' }),
    });
    const manager = new Manager({
      dots,
      sessions,
      delegateBackends: { claude: fakeBackend('claude'), agy: fakeBackend('agy') },
      accounts: {
        resolve: () => ({ id: 'acc1', dir: configDir }),
        activeDir: () => configDir,
        prepare: () => {},
        bind: () => {},
      },
      tools: {
        get: () => store.state.disabledTools,
        set: (names) => { store.state.disabledTools = [...names]; store.save(); },
        agents: () => store.state.disabledAgents,
        setAgents: (names) => { store.state.disabledAgents = [...names]; store.save(); },
      },
      subagents: {
        get: () => store.state.subagents,
        set: (c) => { store.state.subagents = structuredClone(c); store.save(); },
      },
    });

    let port = 0;
    const handler = createHandler({
      port: () => port,
      version: '0.0.0-test',
      webDist: null,
      workspaces,
      sessions,
      manager,
      account: { get: async () => null },
      usage: { get: async () => null },
      store,
      previews: {} as HttpDeps['previews'],
      pins: {} as HttpDeps['pins'],
      trash: {} as HttpDeps['trash'],
      pricing: { table: () => ({ source: 'builtin', updatedAt: '', fetchedAt: 0, models: [] }) },
    });

    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 关掉 Explore 与 reviewer
      await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Explore', enabled: false }),
      });
      await fetch(`${base}/api/agents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'reviewer', enabled: false }),
      });

      // 1. 带合法 cwd：含内置、项目级、用户级，且已关闭的仍在列表里
      const sWithCwd = (await (await fetch(`${base}/api/subagents?cwd=${encodeURIComponent(cwd)}`)).json()) as SubagentState;
      expect(sWithCwd.disabledAgents).toEqual(['Explore', 'reviewer']);
      const byName = new Map((sWithCwd.agents ?? []).map((a) => [a.name, a]));
      expect(byName.get('Explore')).toMatchObject({ source: 'builtin', readOnly: true });
      expect(byName.get('Plan')).toMatchObject({ source: 'builtin', readOnly: true });
      expect(byName.get('general-purpose')).toMatchObject({ source: 'builtin' });
      expect(byName.get('general-purpose')?.readOnly).toBeUndefined();
      expect(byName.get('reviewer')).toMatchObject({
        source: 'projectSettings',
        description: 'Project code reviewer',
        model: 'opus',
        effort: 'high',
      });
      expect(byName.get('helper')).toMatchObject({
        source: 'userSettings',
        description: 'User helper agent',
        model: 'haiku',
      });

      // 2. 缺省或非法 cwd：只含内置与用户级，不含项目级
      const sNoCwd = (await (await fetch(`${base}/api/subagents`)).json()) as SubagentState;
      expect(sNoCwd.agents?.some((a) => a.name === 'helper')).toBe(true);
      expect(sNoCwd.agents?.some((a) => a.name === 'reviewer')).toBe(false);

      const sBadCwd = (await (await fetch(`${base}/api/subagents?cwd=${encodeURIComponent(path.join(dir, 'not-exist'))}`)).json()) as SubagentState;
      expect(sBadCwd.agents?.some((a) => a.name === 'helper')).toBe(true);
      expect(sBadCwd.agents?.some((a) => a.name === 'reviewer')).toBe(false);

      // 3. POST /api/subagents?cwd=... 带覆写保存并在返回的 state 中包含 agents 与 disabledAgents
      const nextCfg: SubagentConfig = {
        ...structuredClone(DEFAULT_SUBAGENTS),
        mode: 'delegate',
        delegate: {
          default: { backend: 'claude', accountId: 'default', model: 'sonnet', effort: 'medium' },
          agents: {
            Explore: { backend: 'claude', accountId: 'default', model: 'haiku', effort: 'low' },
            'bad name': { backend: 'claude', accountId: 'default', model: 'opus', effort: 'high' } as any,
          },
        },
      };
      const postRes = await fetch(`${base}/api/subagents?cwd=${encodeURIComponent(cwd)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nextCfg),
      });
      expect(postRes.status).toBe(200);
      const body = (await postRes.json()) as { ok: boolean; state: SubagentState };
      expect(body.ok).toBe(true);
      expect(body.state.config.delegate.agents).toEqual({
        Explore: { backend: 'claude', accountId: 'default', model: 'haiku', effort: 'low' },
      });
      expect(body.state.agents?.some((a) => a.name === 'reviewer')).toBe(true);
      expect(body.state.disabledAgents).toEqual(['Explore', 'reviewer']);

      // 确认 listAllAgents 与 listAgents 区别
      expect(listAllAgents({ configDir, cwd }).some((a) => a.name === 'Explore')).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.idle();
    }
  });
});

describe('原生 PreToolUse hook（onAgentHook）优先级', () => {
  function makeRunner(cwd: string, configDir: string, defaults: AgentDefaults) {
    const writes: Json[] = [];
    const events: Json[] = [];
    const r = new Runner({
      sessionId: '11111111-2222-4333-8444-555555555555',
      cwd,
      isNew: true,
      config: { model: 'opus', effort: 'high' },
      account: { id: 'acc', dir: configDir },
      agentDefaults: () => defaults,
      hooks: {
        onEvent: (e) => events.push(e as Json),
        onStatus: () => {},
        onSettings: () => {},
        onTurnEnd: () => {},
        onExit: () => {},
      },
    });
    (r as any).writeLine = (o: Json) => writes.push(o);
    const call = (tool_input: Json) => {
      writes.length = 0;
      events.length = 0;
      r.handleMessage({
        type: 'control_request',
        request_id: 'h1',
        request: {
          subtype: 'hook_callback',
          callback_id: 'agent-defaults',
          input: { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'tu_1', tool_input },
        },
      });
      return {
        res: writes[0]!.response.response as Json,
        params: events.find((e) => e.subtype === 'cosyee_agent_params'),
      };
    };
    return { call };
  }

  it('优先级：点名 > 类型单独配置 > 磁盘自定义 frontmatter（不注入）> 原生默认；缺省为 general-purpose；fork 不补', () => {
    const dir = mkTmp();
    const configDir = path.join(dir, 'cfg');
    const cwd = path.join(dir, 'ws');
    fs.mkdirSync(cwd, { recursive: true });
    writeAgentMd(
      path.join(cwd, '.claude', 'agents'),
      'custom.md',
      ['---', 'name: custom', 'description: Custom agent', 'model: haiku', 'effort: low', '---', 'Body'].join('\n'),
    );
    writeAgentMd(
      path.join(cwd, '.claude', 'agents'),
      'inherit-agent.md',
      ['---', 'name: inherit-agent', 'description: Inherit model agent', 'model: inherit', '---', 'Body'].join('\n'),
    );

    const { call } = makeRunner(cwd, configDir, {
      native: {
        model: 'sonnet',
        effort: 'medium',
        agents: {
          'general-purpose': { model: 'opus', effort: 'max' },
          Explore: { model: 'haiku' },
          custom: { effort: 'high' },
        },
      },
    });

    // 1. 缺省 subagent_type -> general-purpose -> 命中 general-purpose 单独配置
    const rDefault = call({ prompt: 'p' });
    expect(rDefault.res.hookSpecificOutput.updatedInput).toEqual({ prompt: 'p', model: 'opus', effort: 'max' });
    expect(rDefault.params).toMatchObject({ model: 'opus', effort: 'max' });

    // 2. 点名的值最高优先
    const rExplicit = call({ prompt: 'p', subagent_type: 'Explore', model: 'opus', effort: 'xhigh' });
    expect(rExplicit.res.hookSpecificOutput.updatedInput).toEqual({ prompt: 'p', subagent_type: 'Explore', model: 'opus', effort: 'xhigh' });
    expect(rExplicit.params).toMatchObject({ model: 'opus', effort: 'xhigh' });

    // 3. Explore：model 用类型覆写 haiku，effort 回退默认 medium
    const rExplore = call({ prompt: 'p', subagent_type: 'Explore' });
    expect(rExplore.res.hookSpecificOutput.updatedInput).toEqual({ prompt: 'p', subagent_type: 'Explore', model: 'haiku', effort: 'medium' });
    expect(rExplore.params).toMatchObject({ model: 'haiku', effort: 'medium' });

    // 4. custom：无 model 覆写且 frontmatter 写了 model: haiku -> 不注入 model（让 CLI 用定义）；effort 有覆写 high -> 注入 high
    const rCustom = call({ prompt: 'p', subagent_type: 'custom' });
    expect(rCustom.res.hookSpecificOutput.updatedInput).toEqual({ prompt: 'p', subagent_type: 'custom', effort: 'high' });
    expect(rCustom.res.hookSpecificOutput.updatedInput.model).toBeUndefined();
    expect(rCustom.params).toMatchObject({ model: 'haiku', effort: 'high' });

    // 5. inherit-agent：frontmatter 写了 model: inherit -> 不注入 model，事件上报主会话模型 opus；effort 未写 -> 注入默认 medium
    const rInherit = call({ prompt: 'p', subagent_type: 'inherit-agent' });
    expect(rInherit.res.hookSpecificOutput.updatedInput).toEqual({ prompt: 'p', subagent_type: 'inherit-agent', effort: 'medium' });
    expect(rInherit.params).toMatchObject({ model: 'opus', effort: 'medium' });

    // 6. fork 不介入
    const rFork = call({ prompt: 'p', subagent_type: 'fork' });
    expect(rFork.res).toEqual({});
    expect(rFork.params).toBeUndefined();
  });
});

describe('委派后端优先级、续接、只读限制、自定义 tools 映射与类型开关', () => {
  function makeStubBackend(id: 'claude' | 'agy') {
    const runs: BackendRunOptions[] = [];
    const backend: DelegateBackend = {
      id,
      label: id,
      available: () => true,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async (o): Promise<BackendResult> => {
        runs.push(o);
        const sid = o.sessionId ?? `${id}-sid-1`;
        o.onSession?.(sid, 'default');
        if (!o.sessionId) {
          o.onModel?.({ model: o.defaults?.model ?? 'default-model', effort: o.defaults?.effort ?? o.effort ?? null });
        }
        return { stopReason: 'end_turn', response: 'ok', sessionId: sid, accountId: 'default', toolCalls: 0 };
      },
    };
    return { backend, runs };
  }

  it('Claude 委派优先级（override > frontmatter > cfg.claude > parent）与续接不改模型', async () => {
    const dir = mkTmp();
    const cwd = path.join(dir, 'ws');
    fs.mkdirSync(cwd, { recursive: true });
    writeAgentMd(
      path.join(cwd, '.claude', 'agents'),
      'fm-only.md',
      ['---', 'name: fm-only', 'description: Frontmatter model and effort', 'model: haiku', 'effort: low', '---', 'Prompt'].join('\n'),
    );
    writeAgentMd(
      path.join(cwd, '.claude', 'agents'),
      'fm-inherit.md',
      ['---', 'name: fm-inherit', 'description: Inherit parent model', 'model: inherit', '---', 'Prompt'].join('\n'),
    );

    const { backend, runs } = makeStubBackend('claude');
    const events: Json[] = [];
    const jobs = new DelegateJobs({ git: noGit, onEvents: (evs) => events.push(...evs) });
    const scope = { configDir: path.join(dir, 'cfg'), cwd, disabled: [] };

    const defaults = {
      model: 'sonnet',
      effort: 'medium' as const,
      parentModel: 'opus',
      parentEffort: 'high' as const,
      agents: {
        Explore: { model: 'haiku', effort: 'low' as const },
      },
    };

    // 1. Explore -> 命中 override
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'Explore', run_in_background: false }, { cwd, backend, defaults, agents: scope }, 'tu1', new AbortController().signal);
    expect(runs[0]!.defaults).toEqual({ model: 'haiku', effort: 'low' });
    expect(events.find((e) => e.subtype === 'cosyee_agent_params' && e.tool_use_id === 'tu1')).toMatchObject({ model: 'haiku', effort: 'low' });

    // 2. fm-only -> 无 override，命中 frontmatter（优先于 cfg.claude）
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'fm-only', run_in_background: false }, { cwd, backend, defaults, agents: scope }, 'tu2', new AbortController().signal);
    expect(runs[1]!.defaults).toEqual({ model: 'haiku', effort: 'low' });

    // 3. fm-inherit -> frontmatter model: inherit 优先于 cfg.claude.model，落到 parentModel (opus)
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'fm-inherit', run_in_background: false }, { cwd, backend, defaults, agents: scope }, 'tu3', new AbortController().signal);
    expect(runs[2]!.defaults).toEqual({ model: 'opus', effort: 'medium' });

    // 4. general-purpose -> 无 override 无 frontmatter -> 用 cfg.claude；若 cfg.claude 为 null -> 落到 parent
    const r4 = await jobs.callTool(
      'delegate',
      { description: 'd', prompt: 'p', run_in_background: false },
      { cwd, backend, defaults: { model: null, effort: null, parentModel: 'opus', parentEffort: 'high' }, agents: scope },
      'tu4',
      new AbortController().signal,
    );
    expect(runs[3]!.defaults).toEqual({ model: 'opus', effort: 'high' });

    // 5. 续接（delegate_send）不传 defaults，不改模型
    const cid = /conversation_id: (dlg_[0-9a-f]{24})/.exec(r4.content[0].text)![1]!;
    await jobs.callTool('delegate_send', { conversation_id: cid, message: 'follow up' }, { cwd, backend, defaults, agents: scope }, 'tu5', new AbortController().signal);
    for (let i = 0; i < 50 && runs.length < 5; i++) await new Promise((r) => setTimeout(r, 10));
    expect(runs[4]!.sessionId).toBe('claude-sid-1');
    expect(runs[4]!.defaults).toBeUndefined();
  });

  it('agy 委派优先级（override > cfg.agy），忽略 frontmatter 的 Claude model', async () => {
    const dir = mkTmp();
    const cwd = path.join(dir, 'ws');
    fs.mkdirSync(cwd, { recursive: true });
    writeAgentMd(
      path.join(cwd, '.claude', 'agents'),
      'claude-fm.md',
      ['---', 'name: claude-fm', 'description: Has Claude model', 'model: opus', 'effort: low', '---', 'Prompt'].join('\n'),
    );

    const { backend, runs } = makeStubBackend('agy');
    const jobs = new DelegateJobs({ git: noGit });
    const scope = { configDir: path.join(dir, 'cfg'), cwd, disabled: [] };
    const defaults = {
      model: 'gemini-3-pro',
      effort: 'medium' as const,
      agents: {
        Explore: { model: 'gemini-3-flash', effort: 'low' as const },
      },
    };

    // 1. Explore -> 命中 override
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'Explore', run_in_background: false }, { cwd, backend, defaults, agents: scope }, 'tu1', new AbortController().signal);
    expect(runs[0]!.defaults).toEqual({ model: 'gemini-3-flash', effort: 'low' });

    // 2. claude-fm -> 忽略 frontmatter 的 opus，使用 cfg.agy.model (gemini-3-pro) 与 cfg.agy.effort (medium)
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'claude-fm', run_in_background: false }, { cwd, backend, defaults, agents: scope }, 'tu2', new AbortController().signal);
    expect(runs[1]!.defaults).toEqual({ model: 'gemini-3-pro', effort: 'medium' });
  });

  it('只读类型 Explore / Plan 在 Claude 后端追加 READ_ONLY_DISALLOWED_TOOLS，自定义 tools / disallowedTools 正确映射', async () => {
    const dir = mkTmp();
    const cwd = path.join(dir, 'ws');
    fs.mkdirSync(cwd, { recursive: true });
    writeAgentMd(
      path.join(cwd, '.claude', 'agents'),
      'narrow.md',
      [
        '---',
        'name: narrow',
        'description: Restricted tools agent',
        'tools:',
        '  - Read',
        '  - Grep',
        '  - Glob',
        'disallowedTools: [Bash, WebFetch]',
        '---',
        'Only read files.',
      ].join('\n'),
    );
    writeAgentMd(
      path.join(cwd, '.claude', 'agents'),
      'star.md',
      ['---', 'name: star', 'description: All tools agent', 'tools: *', '---', 'Use any tool.'].join('\n'),
    );

    const { backend, runs } = makeStubBackend('claude');
    const jobs = new DelegateJobs({ git: noGit });
    const scope = { configDir: path.join(dir, 'cfg'), cwd, disabled: [] };

    // 1. Explore（内置只读）
    const rExp = await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'Explore', run_in_background: false }, { cwd, backend, agents: scope }, 'tu1', new AbortController().signal);
    const expArgs = buildClaudeDelegateArgs(runs[0]!, 'claude');
    const expDisallowed = expArgs[expArgs.indexOf('--disallowedTools') + 1]!.split(',');
    for (const t of [...NATIVE_SUBAGENT_TOOLS, ...READ_ONLY_DISALLOWED_TOOLS]) expect(expDisallowed).toContain(t);
    expect(new Set(expDisallowed).size).toBe(expDisallowed.length);

    // 续接 Explore 依然保留只读 disallowedTools
    const expCid = /conversation_id: (dlg_[0-9a-f]{24})/.exec(rExp.content[0].text)![1]!;
    await jobs.callTool('delegate_send', { conversation_id: expCid, message: 'more' }, { cwd, backend, agents: scope }, 'tu1b', new AbortController().signal);
    for (let i = 0; i < 50 && runs.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const expResumeArgs = buildClaudeDelegateArgs(runs[1]!, 'claude');
    expect(expResumeArgs[expResumeArgs.indexOf('--disallowedTools') + 1]!.split(',')).toEqual(expDisallowed);

    // 2. Plan（内置只读）
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'Plan', run_in_background: false }, { cwd, backend, agents: scope }, 'tu2', new AbortController().signal);
    const planArgs = buildClaudeDelegateArgs(runs[2]!, 'claude');
    expect(planArgs[planArgs.indexOf('--disallowedTools') + 1]!.split(',')).toEqual(expDisallowed);

    // 3. general-purpose（可写）：只有 NATIVE_SUBAGENT_TOOLS
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'general-purpose', run_in_background: false }, { cwd, backend, agents: scope }, 'tu3', new AbortController().signal);
    const gpArgs = buildClaudeDelegateArgs(runs[3]!, 'claude');
    expect(gpArgs[gpArgs.indexOf('--disallowedTools') + 1]!.split(',')).toEqual([...NATIVE_SUBAGENT_TOOLS]);
    expect(gpArgs).not.toContain('--tools');

    // 4. narrow（自定义 tools + disallowedTools）
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'narrow', run_in_background: false }, { cwd, backend, agents: scope }, 'tu4', new AbortController().signal);
    const narrowArgs = buildClaudeDelegateArgs(runs[4]!, 'claude');
    expect(narrowArgs[narrowArgs.indexOf('--tools') + 1]).toBe('Read,Grep,Glob');
    expect(narrowArgs[narrowArgs.indexOf('--disallowedTools') + 1]!.split(',')).toEqual([...NATIVE_SUBAGENT_TOOLS, 'Bash', 'WebFetch']);

    // 5. star（tools: * 不传 --tools）
    await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'star', run_in_background: false }, { cwd, backend, agents: scope }, 'tu5', new AbortController().signal);
    const starArgs = buildClaudeDelegateArgs(runs[5]!, 'claude');
    expect(starArgs).not.toContain('--tools');

    // 6. --tools 只管内置工具：MCP 工具名不传，带规则的写法取工具名；tools 为空视为没写
    const toolsOf = (tools: string[]) => {
      const a = buildClaudeDelegateArgs({ ...runs[4]!, tools }, 'claude');
      return a.includes('--tools') ? a[a.indexOf('--tools') + 1] : undefined;
    };
    expect(toolsOf(['Read', 'mcp__github__search', 'Bash(git:*)', 'Bash(npm test)'])).toBe('Read,Bash');
    expect(toolsOf(['mcp__github__search'])).toBe('');
    expect(toolsOf([])).toBeUndefined();
    expect(toolsOf(['  '])).toBeUndefined();
  });

  it('类型开关：关闭某类型后，委派 resolveAgent 报错拦截，原生 denyList 包含 Agent(name)', async () => {
    const dir = mkTmp();
    const cwd = path.join(dir, 'ws');
    fs.mkdirSync(cwd, { recursive: true });
    const { backend, runs } = makeStubBackend('claude');
    const jobs = new DelegateJobs({ git: noGit });
    const scope = { configDir: path.join(dir, 'cfg'), cwd, disabled: ['Explore'] };

    // 委派拦截
    const res = await jobs.callTool('delegate', { description: 'd', prompt: 'p', agent: 'Explore', run_in_background: false }, { cwd, backend, agents: scope }, 'tu1', new AbortController().signal);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('turned off in settings');
    expect(runs).toHaveLength(0);

    // 原生 denyList 拦截
    const store = new StateStore(path.join(dir, 'state.json'));
    const manager = new Manager({
      dots: new DotState(store),
      sessions: new Sessions(new DotState(store)),
      tools: {
        get: () => store.state.disabledTools,
        set: (n) => { store.state.disabledTools = [...n]; },
        agents: () => store.state.disabledAgents,
        setAgents: (n) => { store.state.disabledAgents = [...n]; },
      },
    });
    await manager.setAgentEnabled('Explore', false);
    expect((manager as any).denyList()).toContain('Agent(Explore)');
  });
});

describe('多窗口同步（subagents.changed 广播）', () => {
  it('setSubagents、setAgentEnabled、开关 delegate 工具各广播一次；无关工具或无变化不广播', async () => {
    const dir = mkTmp();
    const store = new StateStore(path.join(dir, 'state.json'));
    const dots = new DotState(store);
    const sessions = new Sessions(dots);
    const manager = new Manager({
      dots,
      sessions,
      delegateBackends: {
        claude: new ClaudeBackend({ claudePath: 'fake-claude', isLoggedIn: () => true }),
        agy: new AgyBackend({ agyPath: 'fake-agy' }),
      },
      tools: {
        get: () => store.state.disabledTools,
        set: (n) => { store.state.disabledTools = [...n]; },
        agents: () => store.state.disabledAgents,
        setAgents: (n) => { store.state.disabledAgents = [...n]; },
      },
      subagents: {
        get: () => store.state.subagents,
        set: (c) => { store.state.subagents = structuredClone(c); },
      },
    });
    const msgs: ServerMsg[] = [];
    manager.addClient({ send: (m) => msgs.push(m) });
    const countSub = () => msgs.filter((m) => m.t === 'subagents.changed').length;

    // 1. setSubagents 广播一次
    await manager.setSubagents({
      ...structuredClone(DEFAULT_SUBAGENTS),
      mode: 'delegate',
      delegate: { default: { backend: 'claude', accountId: 'default', model: null, effort: null } },
    });
    expect(countSub()).toBe(1);

    // 2. setAgentEnabled 实际变化广播一次，重复设置相同值不再广播
    await manager.setAgentEnabled('Explore', false);
    expect(countSub()).toBe(2);
    await manager.setAgentEnabled('Explore', false);
    expect(countSub()).toBe(2);
    await manager.setAgentEnabled('Explore', true);
    expect(countSub()).toBe(3);

    // 3. 开关普通工具不广播，开关 mcp__cosyee__delegate 广播一次
    await manager.setToolEnabled('WebFetch', false);
    expect(countSub()).toBe(3);
    await manager.setToolEnabled(DELEGATE_TOOL_NAME, false);
    expect(countSub()).toBe(4);
    await manager.setToolEnabled(DELEGATE_TOOL_NAME, false);
    expect(countSub()).toBe(4);
    await manager.setToolEnabled(DELEGATE_TOOL_NAME, true);
    expect(countSub()).toBe(5);
  });

  it('ComponentUpdater 更新成功后触发 onUpdated 回调', async () => {
    const dir = mkTmp();
    const updated: string[] = [];
    const updater = new ComponentUpdater({
      home: () => dir,
      onUpdated: (id) => updated.push(id),
      adapters: [
        {
          id: 'agy',
          name: 'Antigravity CLI',
          updatedBy: 'server',
          installable: true,
          info: async () => ({
            installed: false,
            custom: false,
            version: null,
            latest: '1.0.0',
            updateAvailable: false,
            checkedAt: null,
            checkError: null,
            busy: 0,
            job: null,
          }),
          check: async () => {},
          update: async () => {},
          log: () => ({ lines: [], next: 0 }),
        },
      ],
    });
    await updater.update('agy');
    await updater.waitForJobs();
    expect(updated).toEqual(['agy']);
  });
});

describe('登录检测（防抖动）与 fallbackReason', () => {
  /** 登录检测会读环境变量和基础目录的 settings.json：测试里隔离掉宿主机的真实配置 */
  const isolateAuthEnv = () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', mkTmp());
    for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) {
      vi.stubEnv(k, '');
    }
  };

  it('checkClaudeLoggedIn：订阅凭据 / API / Kiro / macOS oauthAccount / 瞬时截断不抖动', () => {
    isolateAuthEnv();
    const dir = mkTmp();
    // 1. 空目录 -> 未登录
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(false);

    // 2. 写入有效订阅凭据 -> 已登录
    const creds = path.join(dir, '.credentials.json');
    fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: { refreshToken: 'rt_123' } }));
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(true);

    // 3. 凭据刷新瞬间被截断成不完整 JSON -> 沿用 prev 不抖动；没有 prev 时宁可当已登录（不把子代理无故退回原生）
    fs.writeFileSync(creds, '{"claudeAiOauth": {');
    expect(checkClaudeLoggedIn(dir, true, 'win32')).toBe(true);
    expect(checkClaudeLoggedIn(dir, false, 'win32')).toBe(false);
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(true);

    // 4. 明确删除文件（ENOENT）-> 未登录（即使 prev=true）
    fs.rmSync(creds);
    expect(checkClaudeLoggedIn(dir, true, 'win32')).toBe(false);

    // 5. macOS 凭据在钥匙串：.credentials.json 不存在时以 .claude.json 的 oauthAccount 为准
    const claudeJson = path.join(dir, '.claude.json');
    fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: { accountUuid: 'u1' } }));
    expect(checkClaudeLoggedIn(dir, undefined, 'darwin')).toBe(true);
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(false);
    // macOS .claude.json 瞬时损坏时沿用 prev
    fs.writeFileSync(claudeJson, '{broken');
    expect(checkClaudeLoggedIn(dir, true, 'darwin')).toBe(true);
    fs.rmSync(claudeJson);

    // 6. API 账号有 cosyee-api.json -> 已登录；瞬时损坏时沿用 prev
    const apiDir = mkTmp();
    const apiFile = path.join(apiDir, 'cosyee-api.json');
    fs.writeFileSync(apiFile, JSON.stringify({ apiKey: 'sk-test', baseUrl: '' }));
    expect(checkClaudeLoggedIn(apiDir, undefined, 'win32')).toBe(true);
    fs.writeFileSync(apiFile, '{truncated');
    expect(checkClaudeLoggedIn(apiDir, true, 'win32')).toBe(true);
    vi.unstubAllEnvs();
  });

  it('checkClaudeLoggedIn：不走凭据文件的登录方式（环境变量 / settings.json 的 env、apiKeyHelper）', () => {
    isolateAuthEnv();
    const dir = mkTmp();
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(false);

    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'tok');
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(true);
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '0');
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(false);
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '1');
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(true);
    vi.stubEnv('CLAUDE_CODE_USE_BEDROCK', '');

    // 账号目录（共享的）settings.json 里的 env
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-x' } }));
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(true);
    // 基础目录 settings.json 的 apiKeyHelper
    fs.rmSync(path.join(dir, 'settings.json'));
    fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ apiKeyHelper: 'get-key.sh' }));
    expect(checkClaudeLoggedIn(dir, undefined, 'win32')).toBe(true);
    vi.unstubAllEnvs();
  });

  it('ClaudeBackend / AgyBackend availability() 与 Manager.subagentState().fallbackReason', async () => {
    const dir = mkTmp();
    const store = new StateStore(path.join(dir, 'state.json'));
    const dots = new DotState(store);
    const sessions = new Sessions(dots);

    let claudeBin: string | null = 'fake-claude';
    let claudeLoggedIn = false;
    let agyBin: string | null = null;
    let agyLoggedIn: boolean | null = false;

    const claudeBackend = new ClaudeBackend({
      resolve: () => claudeBin,
      isLoggedIn: () => claudeLoggedIn,
      isAccountLoggedIn: () => claudeLoggedIn,
    });
    const agyBackend = new AgyBackend({
      resolve: () => agyBin,
      accounts: {
        activeAccount: () => ({ id: 'default', dir: null }),
        accountFor: () => ({ id: 'default', dir: null }),
        isLoggedIn: () => agyLoggedIn,
        isAccountLoggedIn: () => agyLoggedIn,
      },
    });

    const manager = new Manager({
      dots,
      sessions,
      delegateBackends: { claude: claudeBackend, agy: agyBackend },
      tools: {
        get: () => store.state.disabledTools,
        set: (n) => { store.state.disabledTools = [...n]; },
        agents: () => store.state.disabledAgents,
        setAgents: (n) => { store.state.disabledAgents = [...n]; },
      },
      subagents: {
        get: () => store.state.subagents,
        set: (c) => { store.state.subagents = structuredClone(c); },
      },
    });

    const delegateCfg = (backend: 'claude' | 'agy'): SubagentConfig => ({
      ...structuredClone(DEFAULT_SUBAGENTS),
      mode: 'delegate',
      delegate: { default: { backend, accountId: 'default', model: null, effort: null } },
    });

    // 1. 选 claude 但未登录 -> 退回 native，带 fallbackReason
    const s1 = await manager.setSubagents(delegateCfg('claude'));
    expect(claudeBackend.availability()).toEqual({ ok: false, reason: 'Claude 子代理账号未登录' });
    expect(claudeBackend.accountAvailability('default')).toEqual({ ok: false, reason: 'Claude 账号未登录' });
    expect(s1.effective).toBe('native');
    expect(s1.fallbackReason).toBe('Claude 账号未登录');

    // 2. Claude 登录后 -> 不再退回，无 fallbackReason
    claudeLoggedIn = true;
    const s2 = manager.subagentState();
    expect(claudeBackend.accountAvailability('default')).toEqual({ ok: true });
    expect(s2.effective).toBe('delegate');
    expect(s2.fallbackReason).toBeUndefined();

    // 3. 工具面板停用 delegate -> 退回 native，fallbackReason 为停用原因
    await manager.setToolEnabled(DELEGATE_TOOL_NAME, false);
    const s3 = manager.subagentState();
    expect(s3.effective).toBe('native');
    expect(s3.fallbackReason).toBe('委派工具已在工具面板停用');
    await manager.setToolEnabled(DELEGATE_TOOL_NAME, true);

    // 4. 选 agy 但未安装 -> 退回 native
    const s4 = await manager.setSubagents(delegateCfg('agy'));
    expect(agyBackend.accountAvailability('default')).toEqual({ ok: false, reason: '未安装 Antigravity CLI' });
    expect(s4.effective).toBe('native');
    expect(s4.fallbackReason).toBe('未安装 Antigravity CLI');

    // 5. agy 安装了但未登录 -> 退回 native，原因为未登录
    agyBin = 'fake-agy';
    agyLoggedIn = false;
    const s5 = manager.subagentState();
    expect(agyBackend.accountAvailability('default')).toEqual({ ok: false, reason: 'Antigravity 账号未登录' });
    expect(s5.effective).toBe('native');
    expect(s5.fallbackReason).toBe('Antigravity 账号未登录');

    // 6. agy 未知（null，后台探测中）不误判为未登录
    agyLoggedIn = null;
    const s6 = manager.subagentState();
    expect(agyBackend.accountAvailability('default')).toEqual({ ok: true });
    expect(s6.effective).toBe('delegate');
    expect(s6.fallbackReason).toBeUndefined();

    // 7. claude 未安装时优先报未安装
    claudeBin = null;
    expect(claudeBackend.availability()).toEqual({ ok: false, reason: '未安装 Claude CLI' });
    expect(claudeBackend.accountAvailability('default')).toEqual({ ok: false, reason: '未安装 Claude CLI' });
  });
});
