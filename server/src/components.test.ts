import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgyCommandRunner } from './delegate/agyCli.js';
import { type AdapterInfo, type ComponentAdapter, LogBuffer, fetchJsonLimited } from './components/common.js';
import { CLAUDE_LATEST_URL, createClaudeAdapter } from './components/claude.js';
import { SERVER_LATEST_URL, compareServerVersion, createServerAdapter, parseServerVersion } from './components/server.js';
import {
  CHECK_INTERVAL_MS,
  ComponentSettings,
  ComponentUpdater,
  RETRY_INTERVAL_MS,
  componentRoutes,
} from './components/updater.js';
import { runComponentsCli } from './components/cli.js';
import { type RunningServer, startServer } from './server.js';

const H = 60 * 60_000;
const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-components-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('服务端版本比较', () => {
  it('-main.N 比同基础版本新，按（基础版本, N）排序', () => {
    expect(compareServerVersion('0.1.6-main.3', '0.1.6')).toBe(1);
    expect(compareServerVersion('0.1.6', '0.1.6-main.3')).toBe(-1);
    expect(compareServerVersion('0.1.6-main.4', '0.1.6-main.3')).toBe(1);
    expect(compareServerVersion('0.1.6-main.10', '0.1.6-main.9')).toBe(1);
    expect(compareServerVersion('0.1.7', '0.1.6-main.99')).toBe(1);
    expect(compareServerVersion('0.1.6-main.99', '0.1.7')).toBe(-1);
    expect(compareServerVersion('0.10.0', '0.9.9')).toBe(1);
    expect(compareServerVersion('1.2.3', '1.2.3')).toBe(0);
    expect(compareServerVersion('1.2.3-main.2', '1.2.3-main.2')).toBe(0);
  });

  it('无法解析时按相等处理', () => {
    expect(parseServerVersion('abc')).toBeNull();
    expect(parseServerVersion('1.2.3-beta.1')).toBeNull();
    expect(compareServerVersion('abc', '1.2.3')).toBe(0);
    expect(compareServerVersion('1.2.3', '1.2.3-beta.1')).toBe(0);
  });
});

describe('fetchJsonLimited', () => {
  it('带通用 User-Agent，超出体积上限报错', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonRes({ version: '1.0.0' }));
    expect(await fetchJsonLimited(f, 'https://x.invalid/a')).toEqual({ version: '1.0.0' });
    const init = f.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)['User-Agent']).toBe('cosyee');
    const big = vi.fn<typeof fetch>(async () => new Response('x'.repeat(200)));
    await expect(fetchJsonLimited(big, 'https://x.invalid/a', { maxBytes: 100 })).rejects.toThrow('体积');
    const bad = vi.fn<typeof fetch>(async () => jsonRes({}, 500));
    await expect(fetchJsonLimited(bad, 'https://x.invalid/a')).rejects.toThrow('HTTP 500');
  });
});

describe('claude 组件', () => {
  function make(over: { stdout?: string; code?: number; updateCode?: number; env?: NodeJS.ProcessEnv } = {}) {
    let version = over.stdout ?? '2.1.330 (Claude Code)\n';
    const run = vi.fn<AgyCommandRunner>(async (_cmd, args, opts) => {
      if (args[0] === '--version') return { code: over.code ?? 0, stdout: version, stderr: '' };
      opts.onLine?.('\x1b[32mUpdating\x1b[0m to 2.1.400');
      version = '2.1.400 (Claude Code)\n';
      return { code: over.updateCode ?? 0, stdout: '', stderr: over.updateCode ? 'boom: token=abcdef123456' : '' };
    });
    const fetchFn = vi.fn<typeof fetch>(async () => jsonRes({ version: '2.1.400', name: '@anthropic-ai/claude-code' }));
    let running = 0;
    const a = createClaudeAdapter({
      running: () => running,
      env: () => over.env ?? { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'x' },
      resolvePath: () => '/usr/local/bin/claude',
      runCommand: run,
      fetch: fetchFn,
      statFile: () => ({ mtimeMs: 1, size: 1 }),
      now: () => 1000,
    });
    return { a, run, fetchFn, setRunning: (n: number) => (running = n) };
  }

  it('版本取 claude --version 里的第一个版本号，busy = 运行中的会话数', async () => {
    const { a, run, setRunning } = make();
    setRunning(2);
    const info = await a.info();
    expect(info).toMatchObject({ installed: true, custom: false, version: '2.1.330', busy: 2, latest: null, updateAvailable: false });
    expect(run.mock.calls[0]![0]).toBe('/usr/local/bin/claude');
    expect(run.mock.calls[0]![1]).toEqual(['--version']);
    // 外层 Claude Code 会话的变量不传给子进程
    expect(run.mock.calls[0]![2].env).not.toHaveProperty('CLAUDE_CODE_ENTRYPOINT');
    await a.info();
    expect(run).toHaveBeenCalledTimes(1); // 文件没变：用缓存
  });

  it('没装（--version 失败）→ installed:false', async () => {
    const { a } = make({ code: 127, stdout: '' });
    expect((await a.info()).installed).toBe(false);
  });

  it('COSYEE_CLAUDE 设了就是 custom', async () => {
    const { a } = make({ env: { COSYEE_CLAUDE: '/opt/claude' } });
    expect((await a.info()).custom).toBe(true);
  });

  it('check 请求 npm registry，写入 latest 与 updateAvailable', async () => {
    const { a, fetchFn } = make();
    await a.check();
    expect(fetchFn.mock.calls[0]![0]).toBe(CLAUDE_LATEST_URL);
    expect(await a.info()).toMatchObject({ latest: '2.1.400', updateAvailable: true, checkedAt: 1000 });
    fetchFn.mockResolvedValueOnce(jsonRes({ version: 'latest' }));
    await expect(a.check()).rejects.toThrow('格式无效');
  });

  it('update 运行 `claude update`，日志去掉 ANSI，成功后重新读版本', async () => {
    const { a, run } = make();
    await a.info();
    await a.update();
    const upd = run.mock.calls.find((c) => c[1][0] === 'update')!;
    expect(upd[1]).toEqual(['update']);
    expect(a.log(0).lines).toContain('Updating to 2.1.400');
    expect((await a.info()).version).toBe('2.1.400');
  });

  it('update 失败抛错并把错误写进日志（已脱敏）', async () => {
    const { a } = make({ updateCode: 1 });
    await expect(a.update()).rejects.toThrow('退出码 1');
    expect(a.log(0).lines.join('\n')).toContain('更新失败（退出码 1）');
    expect(a.log(0).lines.join('\n')).not.toContain('abcdef123456');
  });
});

describe('server 组件', () => {
  it('latest 取 server-dist 的 package.json，-main.N 算新版', async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => jsonRes({ version: '0.1.6-main.3' }));
    const a = createServerAdapter({ version: '0.1.6', custom: false, running: () => 0, fetch: fetchFn, now: () => 5 });
    await a.check();
    expect(fetchFn.mock.calls[0]![0]).toBe(SERVER_LATEST_URL);
    expect(await a.info()).toMatchObject({ latest: '0.1.6-main.3', updateAvailable: true, installed: true });
    fetchFn.mockResolvedValueOnce(jsonRes({ version: 'oops' }));
    await expect(a.check()).rejects.toThrow('格式无效');
  });

  it('update 接口 409「由桌面客户端更新」', async () => {
    const a = createServerAdapter({ version: '0.1.6', custom: false, running: () => 0 });
    const u = new ComponentUpdater({ adapters: [a], home: () => tmp });
    await expect(u.update('server')).rejects.toMatchObject({ status: 409, message: '由桌面客户端更新' });
    const r = await componentRoutes(u, { method: 'POST', pathname: '/api/components/server/update', query: new URLSearchParams(), fromLocal: true });
    expect(r).toEqual({ status: 409, body: { error: '由桌面客户端更新' } });
  });
});

/** 可控的假组件 */
function fake(id: AdapterInfoId, over: Partial<AdapterInfo> = {}, updatedBy: 'server' | 'client' = 'server') {
  const st: AdapterInfo & { checks: number; updates: number; failUpdate: boolean; checkedAt: number | null } = {
    installed: true,
    custom: false,
    version: '1.0.0',
    latest: '1.0.0',
    updateAvailable: false,
    checkedAt: null,
    checkError: null,
    busy: 0,
    job: null,
    checks: 0,
    updates: 0,
    failUpdate: false,
    ...over,
  };
  let clock: () => number = () => 0;
  const adapter: ComponentAdapter = {
    id,
    name: id,
    updatedBy,
    info: async () => ({ ...st, job: st.job }),
    check: async () => {
      st.checks++;
      st.latest = '1.1.0';
      st.updateAvailable = true;
      st.checkedAt = clock();
    },
    update: async () => {
      st.updates++;
      if (st.failUpdate) throw new Error('更新失败（退出码 1）');
      st.version = st.latest;
      st.updateAvailable = false;
    },
    log: () => ({ lines: [], next: 0 }),
  };
  return { adapter, st, useClock: (c: () => number) => (clock = c) };
}
type AdapterInfoId = ComponentAdapter['id'];

describe('调度', () => {
  let now: number;
  beforeEach(() => {
    now = 1_000_000_000_000;
  });

  function setup(f: ReturnType<typeof fake>) {
    f.useClock(() => now);
    return new ComponentUpdater({ adapters: [f.adapter], home: () => tmp, now: () => now });
  }

  it('满 24 小时才检查；检查后有新版且空闲时自动更新', async () => {
    const f = fake('claude');
    const u = setup(f);
    await u.tick();
    expect(f.st.checks).toBe(1); // 从没检查过
    await u.waitForJobs();
    expect(f.st.updates).toBe(1);
    expect(f.st.version).toBe('1.1.0');

    now += 23 * H;
    await u.tick();
    expect(f.st.checks).toBe(1); // 不满 24h 不查
    now += 2 * H;
    await u.tick();
    expect(f.st.checks).toBe(2);
  });

  it('忙时只标 pending，不更新；空闲后下一轮更新，pending 消失', async () => {
    const f = fake('claude', { busy: 2 });
    const u = setup(f);
    await u.tick();
    expect(f.st.updates).toBe(0);
    let s = await u.status('claude');
    expect(s).toMatchObject({ updateAvailable: true, pending: true, busy: 2 });
    now += H;
    f.st.busy = 0;
    await u.tick();
    await u.waitForJobs();
    expect(f.st.updates).toBe(1);
    s = await u.status('claude');
    expect(s).toMatchObject({ updateAvailable: false, pending: false, job: null });
  });

  it('custom 和没装的组件既不检查也不更新', async () => {
    const c = fake('claude', { custom: true, updateAvailable: true });
    const n = fake('agy', { installed: false });
    c.useClock(() => now);
    n.useClock(() => now);
    const u = new ComponentUpdater({ adapters: [c.adapter, n.adapter], home: () => tmp, now: () => now });
    await u.tick();
    await u.waitForJobs();
    expect(c.st.checks + n.st.checks).toBe(0);
    expect(c.st.updates + n.st.updates).toBe(0);
    expect((await u.status('claude')).pending).toBe(false);
    await expect(u.update('claude')).rejects.toMatchObject({ status: 409 });
    await expect(u.update('agy')).rejects.toMatchObject({ status: 409 });
  });

  it('自动更新开关关闭：只检查不更新，也不显示 pending；设置持久化到 components.json（0600）', async () => {
    const f = fake('claude', { busy: 1 });
    const u = setup(f);
    const s = await u.setAuto('claude', false);
    expect(s.autoUpdate).toBe(false);
    const file = path.join(tmp, 'components.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ auto: { claude: false, kiro: true, agy: true, codex: true, server: true, browser: true } });
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    await u.tick();
    f.st.busy = 0;
    now += H;
    await u.tick();
    await u.waitForJobs();
    expect(f.st.checks).toBe(1);
    expect(f.st.updates).toBe(0);
    expect((await u.status('claude')).pending).toBe(false);
    // 重新读取：新实例读到同一份设置
    expect(new ComponentSettings(() => tmp).autoUpdate('claude')).toBe(false);
    expect(new ComponentSettings(() => tmp).autoUpdate('kiro')).toBe(true);
  });

  it('更新失败：记录 job.error，24 小时内不重试，之后再试', async () => {
    const f = fake('claude');
    f.st.failUpdate = true;
    const u = setup(f);
    await u.tick();
    await u.waitForJobs();
    expect(f.st.updates).toBe(1);
    let s = await u.status('claude');
    expect(s.job).toEqual({ kind: 'update', state: 'failed', error: '更新失败（退出码 1）' });
    expect(s.updateAvailable).toBe(true);

    for (let i = 0; i < 5; i++) {
      now += H;
      await u.tick();
      await u.waitForJobs();
    }
    expect(f.st.updates).toBe(1);

    now += RETRY_INTERVAL_MS;
    f.st.failUpdate = false;
    await u.tick();
    await u.waitForJobs();
    expect(f.st.updates).toBe(2);
    s = await u.status('claude');
    expect(s.job).toBeNull();
    expect(s.version).toBe('1.1.0');
  });

  it('同一组件同时只跑一个更新任务', async () => {
    const f = fake('claude');
    let release!: () => void;
    f.adapter.update = () => new Promise<void>((r) => (release = r));
    const u = setup(f);
    await u.check('claude');
    const s = await u.update('claude');
    expect(s.job).toEqual({ kind: 'update', state: 'running', error: null });
    await expect(u.update('claude')).rejects.toMatchObject({ status: 409 });
    await u.tick(); // 调度也不会再启动
    release();
    await u.waitForJobs();
    expect((await u.status('claude')).job).toBeNull();
  });

  it('手动更新：组件忙返回 409', async () => {
    const f = fake('claude', { busy: 3, updateAvailable: true });
    const u = setup(f);
    await expect(u.update('claude')).rejects.toMatchObject({ status: 409 });
    expect(f.st.updates).toBe(0);
  });

  it('检查失败记入 checkError，24 小时内不重复检查', async () => {
    const f = fake('kiro');
    f.adapter.check = async () => {
      f.st.checks++;
      throw new Error('网络不通');
    };
    const u = setup(f);
    await u.tick();
    now += H;
    await u.tick();
    expect(f.st.checks).toBe(1);
    const s = await u.status('kiro');
    expect(s.checkError).toBe('网络不通');
    expect(s.checkedAt).toBe(now - H);
    now += CHECK_INTERVAL_MS;
    await u.tick();
    expect(f.st.checks).toBe(2);
  });

  it('server 组件：服务端不更新，但有新版、开关开、忙时仍显示 pending', async () => {
    const f = fake('server', { busy: 1 }, 'client');
    const u = setup(f);
    await u.tick();
    await u.waitForJobs();
    expect(f.st.checks).toBe(1);
    expect(f.st.updates).toBe(0);
    let s = await u.status('server');
    expect(s).toMatchObject({ updatedBy: 'client', updateAvailable: true, pending: true });
    f.st.busy = 0;
    s = await u.status('server');
    expect(s.pending).toBe(false);
    expect(s.updateAvailable).toBe(true);
  });

  it('list 按 claude / kiro / agy / server 顺序返回', async () => {
    const ids = ['server', 'agy', 'kiro', 'claude'] as const;
    const u = new ComponentUpdater({ adapters: ids.map((id) => fake(id).adapter), home: () => tmp, now: () => now });
    expect((await u.list()).list.map((c) => c.id)).toEqual(['claude', 'kiro', 'agy', 'server']);
  });

  it('start：5 分钟后第一次，之后每小时一次；stop 后不再调度', async () => {
    vi.useFakeTimers();
    try {
      const f = fake('claude');
      f.useClock(() => Date.now());
      const u = new ComponentUpdater({ adapters: [f.adapter], home: () => tmp });
      u.start();
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(f.st.checks).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.st.checks).toBe(1);
      await u.waitForJobs();
      await vi.advanceTimersByTimeAsync(H);
      expect(f.st.checks).toBe(1); // 不满 24h
      u.stop();
      await vi.advanceTimersByTimeAsync(48 * H);
      expect(f.st.checks).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('路由', () => {
  const q = (s = '') => new URLSearchParams(s);

  it('非本机的写操作 403；未知 id 404；参数校验', async () => {
    const f = fake('claude');
    const u = new ComponentUpdater({ adapters: [f.adapter], home: () => tmp });
    for (const op of ['check', 'update', 'auto']) {
      const r = await componentRoutes(u, { method: 'POST', pathname: `/api/components/claude/${op}`, query: q('enabled=1'), fromLocal: false });
      expect(r?.status).toBe(403);
    }
    expect(f.st.checks + f.st.updates).toBe(0);
    for (const op of ['check', 'update', 'auto', 'log']) {
      const method = op === 'log' ? 'GET' : 'POST';
      const r = await componentRoutes(u, { method, pathname: `/api/components/nope/${op}`, query: q('enabled=1'), fromLocal: true });
      expect(r?.status).toBe(404);
    }
    expect((await componentRoutes(u, { method: 'POST', pathname: '/api/components/claude/auto', query: q(), fromLocal: true }))?.status).toBe(400);
    expect((await componentRoutes(u, { method: 'POST', pathname: '/api/components/claude/auto', query: q('enabled=1'), fromLocal: true }))?.status).toBe(200);
    expect((await componentRoutes(u, { method: 'GET', pathname: '/api/components/claude/log', query: q('from=x'), fromLocal: false }))?.status).toBe(400);
    // 方法不对 / 路径不认识 → null（调用方回 404）
    expect(await componentRoutes(u, { method: 'GET', pathname: '/api/components/claude/check', query: q(), fromLocal: true })).toBeNull();
    expect(await componentRoutes(u, { method: 'DELETE', pathname: '/api/components', query: q(), fromLocal: true })).toBeNull();
    expect(await componentRoutes(u, { method: 'GET', pathname: '/api/components/claude', query: q(), fromLocal: true })).toBeNull();
  });

  it('GET 列表、check、log 对非本机也开放（读操作）', async () => {
    const f = fake('claude');
    const u = new ComponentUpdater({ adapters: [f.adapter], home: () => tmp });
    const r = await componentRoutes(u, { method: 'GET', pathname: '/api/components', query: q(), fromLocal: false });
    expect(r?.status).toBe(200);
    expect((r!.body as { list: unknown[] }).list).toHaveLength(1);
    const l = await componentRoutes(u, { method: 'GET', pathname: '/api/components/claude/log', query: q('from=0'), fromLocal: false });
    expect(l).toEqual({ status: 200, body: { lines: [], next: 0 } });
  });
});

describe('HTTP 接线', () => {
  let srv: RunningServer;
  beforeEach(async () => {
    srv = await startServer({ port: 0, webDist: null, stateFile: path.join(tmp, 'state.json'), claudePath: path.join(tmp, 'no-such-claude') });
  });
  afterEach(async () => {
    await srv.stop();
  });

  it('GET /api/components 返回六项（含 codex）；源码运行的 server 是 custom；写操作按规则返回', async () => {
    const base = `http://127.0.0.1:${srv.port}`;
    const list = (await (await fetch(`${base}/api/components`)).json()) as { list: Array<{ id: string; custom: boolean; installed: boolean }> };
    expect(list.list.map((c) => c.id)).toEqual(['claude', 'kiro', 'agy', 'codex', 'browser', 'server']);
    expect(list.list.find((c) => c.id === 'server')).toMatchObject({ custom: true, installed: true });
    expect(list.list.find((c) => c.id === 'claude')).toMatchObject({ custom: true, installed: false });
    expect((await fetch(`${base}/api/components/zzz/check`, { method: 'POST' })).status).toBe(404);
    const up = await fetch(`${base}/api/components/server/update`, { method: 'POST' });
    expect(up.status).toBe(409);
    expect(((await up.json()) as { error: string }).error).toBe('由桌面客户端更新');
    const auto = await fetch(`${base}/api/components/claude/auto?enabled=0`, { method: 'POST' });
    expect(auto.status).toBe(200);
    expect(((await auto.json()) as { autoUpdate: boolean }).autoUpdate).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'components.json'))).toBe(true);
  });
});

describe('LogBuffer', () => {
  it('超过上限截断头部，next 单调递增', () => {
    const b = new LogBuffer(3);
    for (let i = 0; i < 5; i++) b.append(`l${i}`);
    expect(b.read(0)).toEqual({ lines: ['l2', 'l3', 'l4'], next: 5 });
    expect(b.read(4)).toEqual({ lines: ['l4'], next: 5 });
    expect(b.read(9)).toEqual({ lines: [], next: 5 });
  });
});

describe('检查结果持久化', () => {
  it('检查后写 component-checks.json，新进程读回时间并恢复最新版；失败时保留上次的最新版', async () => {
    let now = 1000;
    const f = fake('claude', { latest: null });
    f.useClock(() => now);
    const u = new ComponentUpdater({ adapters: [f.adapter], home: () => tmp, now: () => now });
    await u.check('claude');
    const file = path.join(tmp, 'component-checks.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claude: { at: 1000, error: null, latest: '1.1.0' } });

    f.adapter.check = async () => {
      throw new Error('网络不通');
    };
    now = 2000;
    await u.check('claude');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ claude: { at: 2000, error: '网络不通', latest: '1.1.0' } });

    const restored: Array<[string, number]> = [];
    const g = fake('claude', { latest: null });
    g.adapter.restore = (v, at) => restored.push([v, at]);
    const u2 = new ComponentUpdater({ adapters: [g.adapter], home: () => tmp });
    expect(restored).toEqual([['1.1.0', 2000]]);
    expect(await u2.status('claude')).toMatchObject({ checkedAt: 2000, checkError: '网络不通' });
  });

  it('claude 组件 restore：只在本进程没检查过时生效，版本号格式不对忽略', async () => {
    const run: AgyCommandRunner = async () => ({ code: 0, stdout: '2.1.0 (Claude Code)', stderr: '' });
    const a = createClaudeAdapter({ running: () => 0, resolvePath: () => '/x/claude', runCommand: run, statFile: () => null });
    a.restore!('bad', 5);
    expect(await a.info()).toMatchObject({ latest: null, checkedAt: null });
    a.restore!('2.2.0', 5);
    expect(await a.info()).toMatchObject({ latest: '2.2.0', checkedAt: 5, updateAvailable: true });
    a.restore!('2.3.0', 6);
    expect((await a.info()).latest).toBe('2.2.0');
  });
});

describe('组件命令行入口', () => {
  function cli(args: string[], u: ComponentUpdater) {
    const lines: unknown[] = [];
    return runComponentsCli(args, { updater: u, write: (l) => lines.push(JSON.parse(l)), pollMs: 5 }).then((code) => ({ code, lines }));
  }

  it('list / check 输出一行 result', async () => {
    const f = fake('claude');
    const u = new ComponentUpdater({ adapters: [f.adapter], home: () => tmp });
    const l = await cli(['list'], u);
    expect(l.code).toBe(0);
    expect(l.lines).toMatchObject([{ result: { list: [{ id: 'claude' }] } }]);
    const c = await cli(['check', 'claude'], u);
    expect(c).toMatchObject({ code: 0, lines: [{ result: { id: 'claude', latest: '1.1.0' } }] });
  });

  it('update 先输出日志行再输出结果；失败输出 error、退出码 1', async () => {
    const f = fake('agy');
    const log = new LogBuffer();
    f.adapter.log = (from) => log.read(from);
    const inner = f.adapter.update;
    f.adapter.update = async () => {
      log.append('下载中');
      await new Promise((r) => setTimeout(r, 20));
      log.append('完成');
      await inner();
    };
    const u = new ComponentUpdater({ adapters: [f.adapter], home: () => tmp });
    const ok = await cli(['update', 'agy'], u);
    expect(ok.code).toBe(0);
    expect(ok.lines).toEqual([{ log: '下载中' }, { log: '完成' }, { result: expect.objectContaining({ id: 'agy', job: null }) }]);

    f.st.failUpdate = true;
    const bad = await cli(['update', 'agy'], u);
    expect(bad.code).toBe(1);
    expect(bad.lines.at(-1)).toEqual({ error: '更新失败（退出码 1）' });
  });

  it('未知组件和用法错误输出 error', async () => {
    const u = new ComponentUpdater({ adapters: [fake('claude').adapter], home: () => tmp });
    expect(await cli(['update', 'server'], u)).toEqual({ code: 1, lines: [{ error: '未找到' }] });
    expect((await cli(['zzz'], u)).lines[0]).toMatchObject({ error: expect.stringContaining('用法') });
  });
});
