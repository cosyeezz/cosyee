// 子代理委派路线、旧配置迁移、DelegateJobs 按类型路由、/api/delegate/models 校验与后端 accountAvailability 测试。
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SUBAGENTS, type SubagentAvailability, type SubagentConfig, type SubagentRoute } from '@cosyee/shared';
import { AgyBackend } from './delegate/acp.js';
import type { BackendResult, BackendRunOptions, DelegateBackend } from './delegate/backend.js';
import { ClaudeBackend } from './delegate/claudeBackend.js';
import { DelegateJobs } from './delegate/jobs.js';
import type { DelegateIdRecord } from './delegate/record.js';
import { delegateAvailability, resolveRoute, routeAvailability, routeBackendIds, routeDefaults, routeFallbacks } from './delegate/routes.js';
import { createHandler, type HttpDeps } from './http.js';
import { migrateSubagents, parseSubagents, sanitizeRoute, StateStore, Workspaces } from './workspaces.js';

const temps: string[] = [];
function mkTmp(prefix = 'cosyee-routes-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  while (temps.length) {
    fs.rmSync(temps.pop()!, { recursive: true, force: true });
  }
});

const noGit = async () => {
  throw new Error('no git');
};

function makeFakeBackend(
  id: 'claude' | 'agy',
  opts: {
    avail?: Record<string, SubagentAvailability>;
    defaultAvail?: SubagentAvailability;
    runs?: BackendRunOptions[];
  } = {},
): DelegateBackend {
  return {
    id,
    label: id === 'claude' ? 'Claude' : 'Antigravity',
    available: () => opts.defaultAvail?.ok ?? true,
    accountAvailability: (accountId) => opts.avail?.[accountId] ?? opts.defaultAvail ?? { ok: true },
    models: async () => ({ models: [], current: null, at: 0 }),
    run: async (o): Promise<BackendResult> => {
      opts.runs?.push(o);
      const accId = o.accountId ?? o.routeAccountId ?? 'default';
      const sid = o.sessionId ?? `${id}-${accId}-sid`;
      o.onSession?.(sid, accId);
      return { stopReason: 'end_turn', response: `${id}:${accId}`, sessionId: sid, accountId: accId, toolCalls: 0 };
    },
  };
}

describe('delegate/routes.ts 路线计算', () => {
  it('resolveRoute：类型自有路线可用时用自有路线；不可用时回落默认并带 fallbackReason；默认也不可用返回 null', () => {
    const claude = makeFakeBackend('claude', {
      avail: {
        accOk: { ok: true },
        accBad: { ok: false, reason: 'Claude 账号未登录' },
      },
    });
    const agy = makeFakeBackend('agy', {
      avail: {
        agyOk: { ok: true },
        agyDead: { ok: false, reason: 'Antigravity 账号已移除' },
      },
    });
    const deps = { backendFor: (id: string) => (id === 'claude' ? claude : id === 'agy' ? agy : null) };

    const cfg: SubagentConfig = {
      mode: 'delegate',
      native: { model: 'sonnet', effort: 'medium' },
      delegate: {
        default: { backend: 'claude', accountId: 'accOk', model: 'sonnet', effort: 'medium' },
        agents: {
          Explore: { backend: 'agy', accountId: 'agyOk', model: 'gemini-4-neon', effort: 'low' },
          Plan: { backend: 'agy', accountId: 'agyDead', model: 'gemini-4-pro', effort: 'high' },
        },
      },
    };

    // 1. 类型自有路线可用 -> own: true
    const rExplore = resolveRoute(cfg, 'Explore', deps);
    expect(rExplore).toMatchObject({
      backend: agy,
      route: cfg.delegate.agents!.Explore,
      own: true,
    });
    expect(rExplore?.fallbackReason).toBeUndefined();

    // 2. 类型自有路线不可用 -> 回落默认并带 fallbackReason
    const rPlan = resolveRoute(cfg, 'Plan', deps);
    expect(rPlan).toMatchObject({
      backend: claude,
      route: cfg.delegate.default,
      own: false,
      fallbackReason: 'Antigravity 账号已移除',
    });

    // 3. 未单独配置的类型 -> 跟随默认路线，无 fallbackReason
    const rGeneral = resolveRoute(cfg, 'general-purpose', deps);
    expect(rGeneral).toMatchObject({
      backend: claude,
      route: cfg.delegate.default,
      own: false,
    });
    expect(rGeneral?.fallbackReason).toBeUndefined();

    // 4. routeFallbacks 只包含不可用的自有路线
    expect(routeFallbacks(cfg, deps)).toEqual({ Plan: 'Antigravity 账号已移除' });

    // 5. 默认路线也不可用 -> resolveRoute 返回 null，delegateAvailability 返回 ok: false
    const brokenCfg: SubagentConfig = {
      ...cfg,
      delegate: {
        default: { backend: 'claude', accountId: 'accBad', model: null, effort: null },
        agents: { Plan: { backend: 'agy', accountId: 'agyDead', model: null, effort: null } },
      },
    };
    expect(delegateAvailability(brokenCfg, deps)).toEqual({ ok: false, reason: 'Claude 账号未登录' });
    expect(resolveRoute(brokenCfg, 'Plan', deps)).toBeNull();
    expect(resolveRoute(brokenCfg, 'general-purpose', deps)).toBeNull();

    // 6. routeAvailability / routeBackendIds 边界
    expect(routeAvailability(null, deps)).toEqual({ ok: false, reason: '还没有选择委派账号' });
    expect(routeAvailability({ backend: 'claude', accountId: 'accOk', model: null, effort: null }, { backendFor: () => null })).toEqual({
      ok: false,
      reason: 'Claude 委派不可用',
    });
    expect(routeBackendIds(cfg)).toEqual(['claude', 'agy']);
  });

  it('routeDefaults：自有路线放 agents[name]，默认路线放顶层，Claude 附带 parentModel/parentEffort', () => {
    const claude = makeFakeBackend('claude');
    const agy = makeFakeBackend('agy');

    const ownClaude = routeDefaults(
      { backend: claude, route: { backend: 'claude', accountId: 'default', model: 'opus', effort: null }, own: true },
      'Plan',
      { model: 'sonnet', effort: 'high' },
    );
    expect(ownClaude).toEqual({
      model: null,
      effort: null,
      agents: { Plan: { model: 'opus', effort: null } },
      parentModel: 'sonnet',
      parentEffort: 'high',
    });

    const defClaude = routeDefaults(
      { backend: claude, route: { backend: 'claude', accountId: 'default', model: null, effort: 'low' }, own: false },
      'general-purpose',
      { model: 'opus', effort: 'max' },
    );
    expect(defClaude).toEqual({
      model: null,
      effort: 'low',
      parentModel: 'opus',
      parentEffort: 'max',
    });

    const ownAgy = routeDefaults(
      { backend: agy, route: { backend: 'agy', accountId: 'agy1', model: 'gemini-4-neon', effort: 'low' }, own: true },
      'Explore',
      { model: 'opus', effort: 'max' },
    );
    expect(ownAgy).toEqual({
      model: null,
      effort: null,
      agents: { Explore: { model: 'gemini-4-neon', effort: 'low' } },
    });
    expect(ownAgy.parentModel).toBeUndefined();
    expect(ownAgy.parentEffort).toBeUndefined();

    const defAgy = routeDefaults(
      { backend: agy, route: { backend: 'agy', accountId: 'agy1', model: 'gemini-4-pro', effort: null }, own: false },
      'general-purpose',
      { model: 'opus', effort: 'max' },
    );
    expect(defAgy).toEqual({ model: 'gemini-4-pro', effort: null });
  });
});

describe('workspaces 旧版 subagents 迁移与校验', () => {
  it('migrateSubagents：旧 kind=claude / agy / codex / native 及 agents 覆写迁移', () => {
    // 1. kind=claude：取 accounts.subagent.claude，agents 覆盖搬成自有路线且缺省字段跟随默认
    expect(
      migrateSubagents({
        accounts: { subagent: { claude: 'subAcc1' } },
        subagents: {
          kind: 'claude',
          native: { model: 'opus', effort: 'high' },
          claude: {
            model: 'sonnet',
            effort: 'medium',
            agents: {
              Explore: { model: 'haiku', effort: null },
              Plan: { model: null, effort: 'max' },
            },
          },
        },
      }),
    ).toEqual({
      mode: 'delegate',
      native: { model: 'opus', effort: 'high' },
      delegate: {
        default: { backend: 'claude', accountId: 'subAcc1', model: 'sonnet', effort: 'medium' },
        agents: {
          Explore: { backend: 'claude', accountId: 'subAcc1', model: 'haiku', effort: 'medium' },
          Plan: { backend: 'claude', accountId: 'subAcc1', model: 'sonnet', effort: 'max' },
        },
      },
    });

    // kind=claude 无 accounts.subagent.claude 时退回 'default'
    expect(
      migrateSubagents({
        subagents: { kind: 'claude', claude: { model: null, effort: null } },
      }).delegate.default,
    ).toEqual({ backend: 'claude', accountId: 'default', model: null, effort: null });

    // 2. kind=agy：有 active 用 active，无 active 用 list 第一个，agents 覆盖搬成自有路线
    expect(
      migrateSubagents({
        agyAccounts: {
          active: 'agy2',
          list: [
            { id: 'agy1', label: 'A', dir: '/tmp/a', createdAt: 1 },
            { id: 'agy2', label: 'B', dir: '/tmp/b', createdAt: 2 },
          ],
        },
        subagents: {
          kind: 'agy',
          native: { model: 'sonnet', effort: 'medium' },
          agy: {
            model: 'gemini-4-pro',
            effort: 'high',
            agents: {
              Explore: { model: 'gemini-4-flash', effort: 'low' },
            },
          },
        },
      }),
    ).toEqual({
      mode: 'delegate',
      native: { model: 'sonnet', effort: 'medium' },
      delegate: {
        default: { backend: 'agy', accountId: 'agy2', model: 'gemini-4-pro', effort: 'high' },
        agents: {
          Explore: { backend: 'agy', accountId: 'agy2', model: 'gemini-4-flash', effort: 'low' },
        },
      },
    });

    // kind=agy 无 active 时取 list 第一个
    expect(
      migrateSubagents({
        agyAccounts: {
          active: null,
          list: [{ id: 'agyFirst', label: 'A', dir: '/tmp/a', createdAt: 1 }],
        },
        subagents: { kind: 'agy', agy: { model: 'm1', effort: null } },
      }),
    ).toEqual({
      mode: 'delegate',
      native: { model: 'sonnet', effort: 'medium' },
      delegate: { default: { backend: 'agy', accountId: 'agyFirst', model: 'm1', effort: null } },
    });

    // 3. kind=codex -> 退回原生模式，保留 native 配置
    expect(
      migrateSubagents({
        subagents: {
          kind: 'codex',
          native: { model: 'haiku', effort: 'low' },
          codex: { model: 'gpt-5', effort: 'high' },
        },
      }),
    ).toEqual({
      mode: 'native',
      native: { model: 'haiku', effort: 'low' },
      delegate: { default: null },
    });

    // 4. kind=native -> 原生模式，保留 native 与 native.agents
    expect(
      migrateSubagents({
        subagents: {
          kind: 'native',
          native: { model: 'opus', effort: 'max', agents: { Explore: { model: 'haiku', effort: 'low' } } },
        },
      }),
    ).toEqual({
      mode: 'native',
      native: { model: 'opus', effort: 'max', agents: { Explore: { model: 'haiku', effort: 'low' } } },
      delegate: { default: null },
    });
  });

  it('sanitizeRoute 与 parseSubagents 校验非法输入', () => {
    expect(sanitizeRoute(null)).toBeNull();
    expect(sanitizeRoute([])).toBeNull();
    expect(sanitizeRoute({ backend: 'unknown', accountId: 'a', model: null, effort: null })).toBeNull();
    expect(sanitizeRoute({ backend: 'claude', accountId: '', model: null, effort: null })).toBeNull();
    expect(sanitizeRoute({ backend: 'claude', accountId: 'bad/id', model: null, effort: null })).toBeNull();
    expect(sanitizeRoute({ backend: 'agy', accountId: 'a'.repeat(81), model: null, effort: null })).toBeNull();
    expect(sanitizeRoute({ backend: 'agy', accountId: 'acc_1.ok-2', model: 'bad model!', effort: 'bogus-effort' })).toEqual({
      backend: 'agy',
      accountId: 'acc_1.ok-2',
      model: null,
      effort: null,
    });

    const valid: SubagentConfig = {
      ...structuredClone(DEFAULT_SUBAGENTS),
      mode: 'delegate',
      delegate: { default: { backend: 'claude', accountId: 'default', model: null, effort: null } },
    };
    expect(parseSubagents(valid)).toEqual(valid);
    expect(parseSubagents({ ...valid, mode: 'claude' })).toBeNull();
    expect(parseSubagents({ ...valid, native: { model: 'bad', effort: 'medium' } })).toBeNull();
    expect(parseSubagents({ ...valid, delegate: { default: { backend: 'unknown', accountId: 'x', model: null, effort: null } } })).toBeNull();
    expect(parseSubagents({ ...valid, delegate: { default: { backend: 'agy', accountId: 'bad id', model: null, effort: null } } })).toBeNull();
  });
});

describe('DelegateJobs 按类型路由与续聊隔离', () => {
  it('Explore 路由到 agy 账号 A、Plan 路由到 claude 账号 B；续聊沿用原后端与原账号，不受后续路由变化影响', async () => {
    const cwd = mkTmp('cosyee-jobs-route-');
    const agyRuns: BackendRunOptions[] = [];
    const claudeRuns: BackendRunOptions[] = [];
    const agy = makeFakeBackend('agy', { runs: agyRuns });
    const claude = makeFakeBackend('claude', { runs: claudeRuns });
    const backendFor = (id: string) => (id === 'claude' ? claude : id === 'agy' ? agy : null);
    const savedIds = new Map<string, DelegateIdRecord>();
    const jobs = new DelegateJobs({
      git: noGit,
      ids: {
        saveId: async (id, rec) => { savedIds.set(id, { ...rec }); },
        readId: async (id) => savedIds.get(id) ?? null,
      },
    });
    const scope = { configDir: path.join(cwd, 'cfg'), cwd, disabled: [] as string[] };

    let routes: Record<string, { backend: DelegateBackend; accountId: string; defaults: { model: string | null; effort: 'low' | 'high' | null } }> = {
      Explore: { backend: agy, accountId: 'accA', defaults: { model: 'gemini-4-flash', effort: 'low' } },
      Plan: { backend: claude, accountId: 'accB', defaults: { model: 'opus', effort: 'high' } },
    };

    const ctx = () => ({
      cwd,
      backend: claude,
      backendFor,
      agents: scope,
      route: (agentName: string) => routes[agentName] ?? null,
    });

    // 1. Explore -> agy + routeAccountId=accA
    const rExp = await jobs.callTool(
      'delegate',
      { description: 'explore', prompt: 'find files', agent: 'Explore', run_in_background: false },
      ctx(),
      'tu-exp',
      new AbortController().signal,
    );
    expect(rExp.isError).toBeUndefined();
    expect(agyRuns).toHaveLength(1);
    expect(agyRuns[0]!.routeAccountId).toBe('accA');
    expect(agyRuns[0]!.defaults).toEqual({ model: 'gemini-4-flash', effort: 'low' });
    const expCid = /conversation_id: (dlg_[0-9a-f]{24})/.exec(rExp.content[0].text)![1]!;
    expect(savedIds.get(expCid)).toMatchObject({ backend: 'agy', accountId: 'accA' });

    // 2. Plan -> claude + routeAccountId=accB
    const rPlan = await jobs.callTool(
      'delegate',
      { description: 'plan', prompt: 'make plan', agent: 'Plan', run_in_background: false },
      ctx(),
      'tu-plan',
      new AbortController().signal,
    );
    expect(rPlan.isError).toBeUndefined();
    expect(claudeRuns).toHaveLength(1);
    expect(claudeRuns[0]!.routeAccountId).toBe('accB');
    expect(claudeRuns[0]!.defaults).toEqual({ model: 'opus', effort: 'high' });
    const planCid = /conversation_id: (dlg_[0-9a-f]{24})/.exec(rPlan.content[0].text)![1]!;
    expect(savedIds.get(planCid)).toMatchObject({ backend: 'claude', accountId: 'accB' });

    // 3. 修改路由配置（Explore 改走 claude accC，Plan 改走 agy accD）后，续聊仍沿用原后端与原账号
    routes = {
      Explore: { backend: claude, accountId: 'accC', defaults: { model: 'haiku', effort: 'low' } },
      Plan: { backend: agy, accountId: 'accD', defaults: { model: 'gemini-4-pro', effort: 'high' } },
    };

    await jobs.callTool(
      'delegate_send',
      { conversation_id: expCid, message: 'more explore' },
      ctx(),
      'tu-exp-2',
      new AbortController().signal,
    );
    for (let i = 0; i < 50 && agyRuns.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(agyRuns).toHaveLength(2);
    expect(agyRuns[1]!.sessionId).toBe('agy-accA-sid');
    expect(agyRuns[1]!.accountId).toBe('accA');
    expect(agyRuns[1]!.routeAccountId).toBeUndefined();
    expect(claudeRuns).toHaveLength(1);

    await jobs.callTool(
      'delegate_send',
      { conversation_id: planCid, message: 'more plan' },
      ctx(),
      'tu-plan-2',
      new AbortController().signal,
    );
    for (let i = 0; i < 50 && claudeRuns.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(claudeRuns).toHaveLength(2);
    expect(claudeRuns[1]!.sessionId).toBe('claude-accB-sid');
    expect(claudeRuns[1]!.accountId).toBe('accB');
    expect(claudeRuns[1]!.routeAccountId).toBeUndefined();
  });
});

describe('HTTP GET /api/delegate/models 参数透传与校验', () => {
  it('透传 backend / account / refresh / cwd；非法 backend 或 account 返回 400；底层抛错返回 503', async () => {
    const dir = mkTmp('cosyee-http-models-');
    const ws = path.join(dir, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const store = new StateStore(path.join(dir, 'state.json'));
    const workspaces = new Workspaces(store);
    workspaces.add(ws);

    const calls: { cwd: string; refresh: boolean; backend: string; account: string | null }[] = [];
    let shouldFail = false;

    let port = 0;
    const handler = createHandler({
      port: () => port,
      version: '0.0.0-test',
      webDist: null,
      workspaces,
      sessions: {} as HttpDeps['sessions'],
      manager: {} as HttpDeps['manager'],
      account: { get: async () => null },
      usage: { get: async () => null },
      store,
      previews: {} as HttpDeps['previews'],
      pins: {} as HttpDeps['pins'],
      trash: {} as HttpDeps['trash'],
      pricing: { table: () => ({ source: 'builtin', updatedAt: '', fetchedAt: 0, models: [] }) },
      delegateModels: async (cwd, refresh, backend, account) => {
        calls.push({ cwd, refresh, backend, account });
        if (shouldFail) throw new Error('backend down');
        return { models: [{ value: `${backend}-m1`, displayName: 'M1', efforts: ['low', 'high'] }], current: null, at: 123 };
      },
    });

    const server = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. 缺省 backend=agy, account=null, refresh=false
      const r1 = await fetch(`${base}/api/delegate/models?cwd=${encodeURIComponent(ws)}`);
      expect(r1.status).toBe(200);
      expect(await r1.json()).toMatchObject({ models: [{ value: 'agy-m1' }] });
      expect(calls[0]).toEqual({ cwd: path.resolve(ws), refresh: false, backend: 'agy', account: null });

      // 2. 显式 backend=claude, account=acc_1, refresh=1
      const r2 = await fetch(`${base}/api/delegate/models?backend=claude&account=acc_1&refresh=1&cwd=${encodeURIComponent(ws)}`);
      expect(r2.status).toBe(200);
      expect(await r2.json()).toMatchObject({ models: [{ value: 'claude-m1' }] });
      expect(calls[1]).toEqual({ cwd: path.resolve(ws), refresh: true, backend: 'claude', account: 'acc_1' });

      // 3. 非法 backend -> 400
      expect((await fetch(`${base}/api/delegate/models?backend=unknown`)).status).toBe(400);

      // 4. 非法 account -> 400
      expect((await fetch(`${base}/api/delegate/models?backend=agy&account=`)).status).toBe(400);
      expect((await fetch(`${base}/api/delegate/models?backend=agy&account=${encodeURIComponent('bad id')}`)).status).toBe(400);
      expect((await fetch(`${base}/api/delegate/models?backend=agy&account=${encodeURIComponent('../etc')}`)).status).toBe(400);
      expect((await fetch(`${base}/api/delegate/models?backend=agy&account=${'a'.repeat(81)}`)).status).toBe(400);

      // 5. delegateModels 抛错 -> 503
      shouldFail = true;
      const r503 = await fetch(`${base}/api/delegate/models?backend=claude&account=default`);
      expect(r503.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await store.idle();
    }
  });
});

describe('AgyBackend / ClaudeBackend accountAvailability', () => {
  it('AgyBackend.accountAvailability：未装 CLI / 账号不存在 / 未登录 / 正常', () => {
    // 1. 未装 CLI
    const noCli = new AgyBackend({ resolve: () => null });
    expect(noCli.accountAvailability('agy1')).toEqual({ ok: false, reason: '未安装 Antigravity CLI' });

    // 2. 无 accounts 注入时只认 default
    const noAccStore = new AgyBackend({ resolve: () => 'fake-agy' });
    expect(noAccStore.accountAvailability('default')).toEqual({ ok: true });
    expect(noAccStore.accountAvailability('agy1')).toEqual({ ok: false, reason: 'Antigravity 账号不存在' });

    // 3. 有 accounts 注入：账号已移除 / 未登录 / 已登录 / 探测中(null)
    const statusMap: Record<string, { exists: boolean; loggedIn: boolean | null }> = {
      okAcc: { exists: true, loggedIn: true },
      probingAcc: { exists: true, loggedIn: null },
      outAcc: { exists: true, loggedIn: false },
    };
    const agy = new AgyBackend({
      resolve: () => 'fake-agy',
      accounts: {
        activeAccount: () => ({ id: 'okAcc', dir: '/tmp/ok' }),
        accountFor: (id) => (statusMap[id]?.exists ? { id, dir: `/tmp/${id}` } : null),
        isAccountLoggedIn: (id) => statusMap[id]?.loggedIn ?? null,
      },
    });
    expect(agy.accountAvailability('missing')).toEqual({ ok: false, reason: 'Antigravity 账号已移除' });
    expect(agy.accountAvailability('outAcc')).toEqual({ ok: false, reason: 'Antigravity 账号未登录' });
    expect(agy.accountAvailability('okAcc')).toEqual({ ok: true });
    expect(agy.accountAvailability('probingAcc')).toEqual({ ok: true });
  });

  it('ClaudeBackend.accountAvailability：未装 CLI / 账号不存在 / 未登录 / 正常', () => {
    const noCli = new ClaudeBackend({ resolve: () => null });
    expect(noCli.accountAvailability('default')).toEqual({ ok: false, reason: '未安装 Claude CLI' });

    const loggedMap: Record<string, boolean | null> = {
      default: true,
      unlogged: false,
      removed: null,
    };
    const claude = new ClaudeBackend({
      resolve: () => 'fake-claude',
      isAccountLoggedIn: (id) => (id in loggedMap ? loggedMap[id]! : null),
    });
    expect(claude.accountAvailability('removed')).toEqual({ ok: false, reason: 'Claude 账号已移除' });
    expect(claude.accountAvailability('unknown')).toEqual({ ok: false, reason: 'Claude 账号已移除' });
    expect(claude.accountAvailability('unlogged')).toEqual({ ok: false, reason: 'Claude 账号未登录' });
    expect(claude.accountAvailability('default')).toEqual({ ok: true });
  });
});
