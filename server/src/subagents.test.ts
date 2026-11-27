// 子代理配置、迁移、权限 deny 互斥、退回原生、settings.json 隔离与并发串行化测试。
// 全程使用临时目录与 mock，绝不触碰真实 ~/.claude 或 ~/.cosyee。
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SUBAGENTS, type SubagentConfig, type SubagentState } from '@cosyee/shared';
import type { DelegateBackend } from './delegate/backend.js';
import { DELEGATE_TOOL_NAMES } from './delegate/mcp.js';
import { createHandler, type HttpDeps } from './http.js';
import { Manager } from './claude/manager.js';
import { DotState } from './state.js';
import { Sessions } from './sessions.js';
import { StateStore, Workspaces, migrateSubagents, parseSubagents, sanitizeSubagents } from './workspaces.js';

const temps: string[] = [];
function mkTmp(prefix = 'cosyee-subagents-'): string {
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

const routeOf = (
  backend: 'claude' | 'agy',
  accountId = 'default',
  model: string | null = null,
  effort: SubagentConfig['native']['effort'] | null = null,
) => ({ backend, accountId, model, effort });

const cfgOf = (mode: SubagentConfig['mode'], overrides: Partial<SubagentConfig> = {}): SubagentConfig => ({
  ...structuredClone(DEFAULT_SUBAGENTS),
  mode,
  ...overrides,
});

const delegateCfg = (backend: 'claude' | 'agy', accountId = 'default'): SubagentConfig =>
  cfgOf('delegate', { delegate: { default: routeOf(backend, accountId) } });

describe('StateStore 老配置迁移与健壮性', () => {
  it('只有 agentModels：保留 native 模型，mode 默认 native，不丢其它状态', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        workspaces: [{ path: dir, name: 'ws' }],
        current: dir,
        disabledTools: ['WebFetch'],
        disabledAgents: ['Explore'],
        agentModels: {
          claude: { model: 'opus', effort: 'high' },
          agy: { model: 'gemini-4-neon', effort: 'low' },
        },
      }),
    );

    const store = new StateStore(file);
    expect(store.state.subagents).toEqual({
      mode: 'native',
      native: { model: 'opus', effort: 'high' },
      delegate: { default: null },
    });
    // 其它用户数据完整保留
    expect(store.state.workspaces).toEqual([{ path: dir, name: 'ws' }]);
    expect(store.state.current).toBe(dir);
    expect(store.state.disabledTools).toEqual(['WebFetch']);
    expect(store.state.disabledAgents).toEqual(['Explore']);

    // 落盘后再次启动：幂等且不再含旧字段
    store.save();
    await store.idle();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    expect(saved.subagents).toEqual(store.state.subagents);
    expect(saved.agentModels).toBeUndefined();
    expect(saved.nativeAgents).toBeUndefined();

    const reloaded = new StateStore(file);
    expect(reloaded.state.subagents).toEqual(store.state.subagents);
  });

  it('只有 nativeAgents=false：有 agy 账号时迁移为 delegate(agy)，无账号退回 native；nativeAgents=true 迁移为 native', () => {
    const dir = mkTmp();
    const f1 = path.join(dir, 's1.json');
    const f2 = path.join(dir, 's2.json');
    const f3 = path.join(dir, 's3.json');
    fs.writeFileSync(
      f1,
      JSON.stringify({
        nativeAgents: false,
        agyAccounts: { list: [{ id: 'agy1', label: 'A', dir: path.join(dir, 'agy1'), createdAt: 1 }], active: 'agy1' },
      }),
    );
    fs.writeFileSync(f2, JSON.stringify({ nativeAgents: true }));
    fs.writeFileSync(f3, JSON.stringify({ nativeAgents: false }));

    expect(new StateStore(f1).state.subagents).toEqual(delegateCfg('agy', 'agy1'));
    expect(new StateStore(f2).state.subagents).toEqual(cfgOf('native'));
    expect(new StateStore(f3).state.subagents).toEqual(cfgOf('native'));
  });

  it('agentModels 与 nativeAgents 同时存在时，按 nativeAgents 决定 mode 并保留对应模型设置', () => {
    // nativeAgents=false（启用 agy）且有 agy 账号，保留 native 模型并建 agy 默认路线
    expect(
      migrateSubagents({
        nativeAgents: false,
        agyAccounts: { list: [{ id: 'agy1', label: 'A', dir: '/tmp/agy1', createdAt: 1 }], active: 'agy1' },
        agentModels: { claude: { model: 'haiku', effort: 'xhigh' } },
      }),
    ).toEqual({
      mode: 'delegate',
      native: { model: 'haiku', effort: 'xhigh' },
      delegate: { default: { backend: 'agy', accountId: 'agy1', model: null, effort: null } },
    });

    // nativeAgents=true：保持 native，不生成 delegate 路线
    expect(
      migrateSubagents({
        nativeAgents: true,
        agentModels: { agy: { model: 'provider/model:tag', effort: 'max' } },
      }),
    ).toEqual({
      mode: 'native',
      native: { model: 'sonnet', effort: 'medium' },
      delegate: { default: null },
    });
  });

  it('字段缺失、类型错误、损坏 JSON、顶层数组均安全降级为默认值且不抛错', () => {
    // 部分字段缺失：合法字段保留，缺失/非法字段落回默认
    expect(
      migrateSubagents({
        nativeAgents: 'false', // 非布尔，按非 false 处理 -> native
        agentModels: {
          claude: { model: 'opus' }, // 缺 effort
          agy: { model: 'bad model with space', effort: 'high' },
        },
      }),
    ).toEqual({
      mode: 'native',
      native: { model: 'opus', effort: 'medium' },
      delegate: { default: null },
    });

    // 损坏 JSON / 顶层数组 / 顶层原始值
    const dir = mkTmp();
    for (const [name, content] of [
      ['corrupt.json', '{bad json!!!'],
      ['array.json', '[{"subagents": {"mode": "delegate"}}]'],
      ['null.json', 'null'],
      ['string.json', '"hello"'],
    ]) {
      const f = path.join(dir, name);
      fs.writeFileSync(f, content);
      const store = new StateStore(f);
      expect(store.state.subagents).toEqual(DEFAULT_SUBAGENTS);
    }
  });

  it('已有 subagents 时不覆盖新配置，即使旧字段仍残留在文件中', () => {
    const dir = mkTmp();
    const file = path.join(dir, 'state.json');
    const current = cfgOf('delegate', {
      native: { model: 'haiku', effort: 'low' },
      delegate: {
        default: routeOf('claude', 'default', 'opus', 'max'),
        agents: { Explore: routeOf('agy', 'agy1', 'gemini-4-neon', 'medium') },
      },
    });
    fs.writeFileSync(
      file,
      JSON.stringify({
        nativeAgents: false,
        agentModels: { claude: { model: 'sonnet', effort: 'high' }, agy: { model: 'old-model', effort: 'low' } },
        subagents: current,
      }),
    );

    const s1 = new StateStore(file);
    expect(s1.state.subagents).toEqual(current);
    // 未修改重启也幂等
    const s2 = new StateStore(file);
    expect(s2.state.subagents).toEqual(current);
  });

  it('parseSubagents 与 sanitizeSubagents 拒绝非法类型/超长模型名并剥离多余字段', () => {
    const base = delegateCfg('claude');
    expect(parseSubagents({ ...base, extra: 'ignored' })).toEqual(base);
    expect((parseSubagents({ ...base, extra: 'ignored' }) as Record<string, unknown> | null)?.extra).toBeUndefined();
    expect(parseSubagents([])).toBeNull();
    expect(parseSubagents('claude')).toBeNull();
    expect(parseSubagents({ ...base, mode: 123 })).toBeNull();
    expect(parseSubagents({ ...base, native: [] })).toBeNull();
    expect(parseSubagents({ ...base, delegate: null })).toBeNull();
    expect(parseSubagents({ ...base, delegate: 'x' })).toBeNull();
    expect(parseSubagents({ ...base, native: { model: 'sonnet' } })).toBeNull();
    expect(parseSubagents({ ...base, native: { effort: 'medium' } })).toBeNull();
    expect(parseSubagents({ ...base, delegate: { default: { backend: 'unknown', accountId: 'default', model: null, effort: null } } })).toBeNull();
    expect(parseSubagents({ ...base, delegate: { default: { backend: 'claude', accountId: 'bad id!', model: null, effort: null } } })).toBeNull();
    expect(parseSubagents({ ...base, delegate: { default: null, agents: [] } })).toBeNull();
    expect(
      parseSubagents({ ...base, delegate: { default: { backend: 'agy', accountId: 'agy1', model: 'a'.repeat(120), effort: null } } }),
    ).not.toBeNull();
    expect(
      sanitizeSubagents({
        mode: 'delegate',
        delegate: { default: { backend: 'agy', accountId: 'agy1', model: 'a'.repeat(121), effort: 'high' } },
      }).delegate.default,
    ).toEqual({
      backend: 'agy',
      accountId: 'agy1',
      model: null,
      effort: 'high',
    });
  });

  it('StateStore 并发快速多次 save 不会损坏 state.json 且最终落盘为最新状态', async () => {
    const dir = mkTmp();
    const file = path.join(dir, 'state.json');
    const store = new StateStore(file);
    const cfgs: SubagentConfig[] = [
      delegateCfg('claude'),
      delegateCfg('agy'),
      cfgOf('native'),
      delegateCfg('claude'),
      delegateCfg('agy'),
      cfgOf('native'),
      delegateCfg('claude'),
    ];
    for (const c of cfgs) {
      store.state.subagents = c;
      store.save();
    }
    await store.idle();
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { subagents: SubagentConfig };
    expect(raw.subagents.mode).toBe('delegate');
    expect(raw.subagents.delegate.default?.backend).toBe('claude');
    // 临时文件应全部清理干净
    const leftTmp = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftTmp).toEqual([]);
  });
});

describe('委派后端不可用退回原生与恢复', () => {
  function makeBackend(id: 'claude' | 'agy', isAvailable: () => boolean): DelegateBackend {
    return {
      id,
      label: id,
      available: isAvailable,
      models: async () => ({ models: [], current: null, at: 0 }),
      run: async () => ({ sessionId: 's1', response: '', toolCalls: 0, stopReason: 'end_turn' }),
    };
  }

  it('默认路线后端不可用时 effective 退回 native，后端恢复可用后切回 delegate', async () => {
    const dir = mkTmp();
    const store = new StateStore(path.join(dir, 'state.json'));
    const dots = new DotState(store);
    const sessions = new Sessions(dots);
    let claudeAvail = false;
    let agyAvail = false;

    const manager = new Manager({
      dots,
      sessions,
      delegateBackends: {
        claude: makeBackend('claude', () => claudeAvail),
        agy: makeBackend('agy', () => agyAvail),
      },
      tools: {
        get: () => store.state.disabledTools,
        set: (names) => {
          store.state.disabledTools = [...names];
          store.save();
        },
        agents: () => store.state.disabledAgents,
        setAgents: (names) => {
          store.state.disabledAgents = [...names];
          store.save();
        },
      },
      subagents: {
        get: () => store.state.subagents,
        set: (c) => {
          store.state.subagents = structuredClone(c);
          store.save();
        },
      },
    });

    // 1. 切到 claude 默认路线，但 claude 后端不可用 -> effective 退回 native
    const s1 = await manager.setSubagents(delegateCfg('claude'));
    expect(s1.config.mode).toBe('delegate');
    expect(s1.effective).toBe('native');
    expect(s1.fallbackReason).toBeTruthy();

    // 2. claude 后端恢复可用 -> subagentState 立即切回 delegate
    claudeAvail = true;
    const s2 = manager.subagentState();
    expect(s2.effective).toBe('delegate');
    expect(s2.fallbackReason).toBeUndefined();

    // 3. 切到 agy 默认路线，但 agy 不可用 -> effective 退回 native（不会误用 claude）
    const s3 = await manager.setSubagents(delegateCfg('agy'));
    expect(s3.config.mode).toBe('delegate');
    expect(s3.effective).toBe('native');
    expect(s3.fallbackReason).toBeTruthy();

    // 4. agy 恢复可用 -> effective 切回 delegate
    agyAvail = true;
    const s4 = manager.subagentState();
    expect(s4.effective).toBe('delegate');
    expect(s4.fallbackReason).toBeUndefined();

    // 5. 手动停用 mcp__cosyee__delegate -> effective 退回 native；重新启用后恢复 delegate
    await manager.setToolEnabled('mcp__cosyee__delegate', false);
    expect(manager.subagentState().effective).toBe('native');
    await manager.setToolEnabled('mcp__cosyee__delegate', true);
    expect(manager.subagentState().effective).toBe('delegate');

    await store.idle();
  });
});

describe('HTTP 层 /api/subagents、/api/tools、/api/agents 并发串行化', () => {
  it('并发快速切换子代理类型时，manager.setSubagents 串行执行，不会出现乱序或重叠', async () => {
    const dir = mkTmp();
    const store = new StateStore(path.join(dir, 'state.json'));
    const workspaces = new Workspaces(store);
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    let current = structuredClone(DEFAULT_SUBAGENTS);

    // 第一次调用故意延迟，验证第二次调用必须等第一次完成后才进入
    let callCount = 0;
    const fakeManager = {
      subagentState: (): SubagentState => ({
        config: structuredClone(current),
        effective: current.mode,
        accounts: [],
        routeFallbacks: {},
      }),
      setSubagents: async (c: SubagentConfig): Promise<SubagentState> => {
        const idx = ++callCount;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(`start:${idx}:${c.mode}`);
        await new Promise((r) => setTimeout(r, idx === 1 ? 60 : 5));
        current = structuredClone(c);
        order.push(`end:${idx}:${c.mode}`);
        inFlight--;
        return fakeManager.subagentState();
      },
      setToolEnabled: async (name: string, enabled: boolean): Promise<string[]> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(`tool:${name}:${enabled}`);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return enabled ? [] : [name];
      },
      setAgentEnabled: async (name: string, enabled: boolean): Promise<string[]> => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        order.push(`agent:${name}:${enabled}`);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return enabled ? [] : [name];
      },
    };

    let port = 0;
    const handler = createHandler({
      port: () => port,
      version: '0.0.0-test',
      webDist: null,
      workspaces,
      sessions: {} as HttpDeps['sessions'],
      manager: fakeManager as unknown as HttpDeps['manager'],
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
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    try {
      const [r1, r2, r3] = await Promise.all([
        post('/api/subagents', delegateCfg('claude')),
        post('/api/tools', { name: 'WebFetch', enabled: false }),
        post('/api/subagents', cfgOf('native')),
      ]);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      expect(r3.status).toBe(200);
      // 关键断言：不能重叠执行
      expect(maxInFlight).toBe(1);
      // 第一次（delegate）必须完整结束后，后续操作才开始
      expect(order.indexOf('end:1:delegate')).toBeLessThan(order.indexOf('start:2:native'));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('DELEGATE_TOOL_NAMES 与 Agent 互斥集合非空且无重叠', () => {
    expect(DELEGATE_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(DELEGATE_TOOL_NAMES).not.toContain('Agent');
  });
});
