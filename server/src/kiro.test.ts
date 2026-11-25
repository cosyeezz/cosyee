// Kiro 账号后端单测：引擎编译与日志、代理生命周期与端口冲突、5 种登录方式、SSRF/脱敏校验、
// 总开关持久化与 HTTP/1.0 路由、账号集成。全部使用临时目录，绝不读取本机真实 Kiro 登录。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readApiConfig, writeApiConfig } from './accounts/api-config.js';
import { Accounts } from './accounts/index.js';
import { claudeEnv, setBeforeClaudeEnv } from './claude/bin.js';
import { createHandler } from './http.js';
import { KiroEngine, KiroService, KIRO_ENGINE_MISSING, KIRO_SERVICE_STOPPED } from './kiro/index.js';
import {
  KiroProxyManager,
  createProxyConfig,
  kiroConfigPath,
  kiroCredsPath,
  kiroChildEnv,
  readKiroProxyConfig,
} from './kiro/proxy.js';
import { buildKiroCredential, isValidRegion, kiroApiRegion, normalizeStartUrl, sanitizeKiroError } from './kiro/sanitize.js';
import { setActiveConfigDir } from './paths.js';
import { StateStore, Workspaces } from './workspaces.js';

let tmp: string;
let base: string;
let root: string;
let home: string;
const saved: Record<string, string | undefined> = {};

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);
const EXE_NAME = process.platform === 'win32' ? 'kiro-rs.exe' : 'kiro-rs';

class FakeProc extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  pid = undefined;
  killed = false;
  exit(code: number, signal: NodeJS.Signals | null = null) {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('close', code, signal);
  }
  kill() {
    this.killed = true;
    this.exit(0);
    return true;
  }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-kiro-'));
  base = path.join(tmp, 'claude');
  root = path.join(tmp, 'accounts');
  home = path.join(tmp, 'cosyee');
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_ACCOUNTS_DIR', 'COSYEE_HOME', 'COSYEE_KIRO_RS', 'KIRO_API_KEY']) {
    saved[k] = process.env[k];
  }
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.COSYEE_ACCOUNTS_DIR = root;
  process.env.COSYEE_HOME = home;
  delete process.env.COSYEE_KIRO_RS;
  setActiveConfigDir(null);
  setBeforeClaudeEnv(null);
});

afterEach(() => {
  setBeforeClaudeEnv(null);
  setActiveConfigDir(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function createFakeBin(name = 'kiro-rs-fake'): string {
  const p = path.join(tmp, name + (process.platform === 'win32' ? '.exe' : ''));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'fake-binary');
  return p;
}

/** 构造一套完全隔离的测试环境（含 Accounts、KiroService、可控运行会话数与假 admin HTTP 响应） */
function makeHarness(opts: {
  binPath?: string | null;
  fetch?: typeof globalThis.fetch;
  runningMap?: Map<string, number>;
  ideTokenFile?: string;
  cliDbFile?: string;
  adminRefreshOk?: boolean;
  adminBalance?: { subscriptionTitle: string | null; currentUsage: number; usageLimit: number; nextResetAt: number | null } | null;
  spawnOverride?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => FakeProc;
} = {}) {
  const store = new StateStore(path.join(home, 'state.json'));
  const runningMap = opts.runningMap ?? new Map<string, number>();
  const spawned: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv; proc: FakeProc }> = [];
  const fakeBin = opts.binPath === undefined ? createFakeBin() : opts.binPath;

  const ideFile = opts.ideTokenFile ?? path.join(tmp, 'nonexistent-ide-token.json');
  const cliFile = opts.cliDbFile ?? path.join(tmp, 'nonexistent-cli.sqlite3');

  let kiroRef: KiroService | null = null;
  const accounts = new Accounts({
    store,
    running: (id) => (id ? (runningMap.get(id) ?? 0) : [...runningMap.values()].reduce((a, b) => a + b, 0)),
    processes: () => 0,
    stop: async () => {},
    kiroProxyState: (dir) => kiroRef?.proxy.stateOf(dir) ?? { proxy: 'stopped', error: null },
    stopKiroProxy: (dir) => kiroRef?.proxy.stop(dir) ?? Promise.resolve(),
    onChanged: () => {},
  });

  const adminFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('http://127.0.0.1:')) {
      const headers = new Headers(init?.headers);
      const key = headers.get('x-api-key');
      // 校验是否匹配某个账号目录的 adminApiKey
      let matched = false;
      for (const a of accounts.listKiroAccounts()) {
        const cfg = readKiroProxyConfig(a.dir);
        if (cfg && cfg.adminApiKey === key) matched = true;
      }
      // 登录验证时账号尚未登记进 accounts.list，也扫描 accountsRoot
      if (!matched && fs.existsSync(root)) {
        for (const name of fs.readdirSync(root)) {
          const cfg = readKiroProxyConfig(path.join(root, name));
          if (cfg && cfg.adminApiKey === key) matched = true;
        }
      }
      if (!matched) {
        return new Response(JSON.stringify({ error: { message: 'unauthorized' } }), { status: 401 });
      }
      if (url.endsWith('/api/admin/credentials')) {
        return new Response(JSON.stringify({ total: 1, available: 1, currentId: 1, credentials: [{ id: 1 }] }), { status: 200 });
      }
      if (url.endsWith('/refresh')) {
        if (opts.adminRefreshOk === false) {
          return new Response(JSON.stringify({ error: { message: 'invalid refreshToken=secret_tok_123' } }), { status: 400 });
        }
        return new Response(JSON.stringify({ success: true, message: 'ok' }), { status: 200 });
      }
      if (url.endsWith('/balance')) {
        if (opts.adminBalance === null) {
          return new Response(JSON.stringify({ error: { message: 'bad key ksk_leaked_secret_xyz' } }), { status: 401 });
        }
        const b = opts.adminBalance ?? {
          subscriptionTitle: 'KIRO PRO',
          currentUsage: 12.5,
          usageLimit: 500,
          nextResetAt: 1700000000.5,
        };
        return new Response(JSON.stringify({ id: 1, ...b, remaining: b.usageLimit - b.currentUsage, usagePercentage: 2.5 }), { status: 200 });
      }
    }
    if (opts.fetch) return opts.fetch(input, init);
    throw new Error(`Unexpected fetch: ${url}`);
  };

  let nextPort = 29100;
  const kiro = new KiroService({
    accounts: {
      listKiroAccounts: () => accounts.listKiroAccounts(),
      allocateNewDir: () => accounts.allocateKiroDir(),
      existingKiroDir: (id) => accounts.existingKiroDir(id),
      running: (id) => runningMap.get(id) ?? 0,
      stopAccountProcesses: (id) => accounts.stopAccountProcesses(id),
      commitNew: (id, dir, label) => accounts.commitNewKiro(id, dir, label),
      commitRelogin: (id, label) => accounts.commitReloginKiro(id, label),
      discardDir: (dir) => accounts.discardKiroDir(dir),
    },
    engine: {
      env: () => ({ ...process.env, ...(fakeBin ? { COSYEE_KIRO_RS: fakeBin } : {}) }),
    },
    proxy: {
      fetch: adminFetch,
      pickFreePort: async () => nextPort++,
      findFreePortSync: (p) => p,
      readyPollMs: 5,
      readyTimeoutMs: 500,
      spawnProxy: (bin, args, env) => {
        const proc = opts.spawnOverride ? opts.spawnOverride(bin, args, env) : new FakeProc();
        spawned.push({ bin, args, env, proc });
        return proc as unknown as ChildProcess;
      },
    },
    login: {
      fetch: adminFetch,
      kiroIdeTokenPath: () => ideFile,
      kiroCliDbPath: () => cliFile,
      pollDelayMs: () => 5,
    },
  });
  kiroRef = kiro;
  return { store, accounts, kiro, spawned, runningMap };
}

describe('sanitize & validation', () => {
  it('region 与 startUrl 严格校验防 SSRF', () => {
    expect(isValidRegion('us-east-1')).toBe(true);
    expect(isValidRegion('ap-southeast-1')).toBe(true);
    expect(isValidRegion('us-gov-west-1')).toBe(true);
    expect(isValidRegion('us-east-1.evil.com')).toBe(false);
    expect(isValidRegion('us-east-1/foo')).toBe(false);
    expect(isValidRegion('')).toBe(false);

    expect(normalizeStartUrl('https://myorg.awsapps.com/start')).toBe('https://myorg.awsapps.com/start');
    expect(normalizeStartUrl('https://abc.app.aws/start')).toBe('https://abc.app.aws/start');
    expect(normalizeStartUrl('http://myorg.awsapps.com/start')).toBeNull();
    expect(normalizeStartUrl('https://evil.com/awsapps.com')).toBeNull();
    expect(normalizeStartUrl('https://user:pass@myorg.awsapps.com/start')).toBeNull();
    expect(normalizeStartUrl('https://myorg.awsapps.com:8443/start')).toBeNull();
    expect(normalizeStartUrl('https://awsapps.com/start')).toBeNull();
  });

  it('API 区域：profileArn 优先，登录区域没有端点时回退 us-east-1', () => {
    expect(kiroApiRegion('us-east-1', null)).toBe('us-east-1');
    expect(kiroApiRegion('eu-central-1', null)).toBe('eu-central-1');
    expect(kiroApiRegion('ap-southeast-1', null)).toBe('us-east-1');
    expect(kiroApiRegion('us-gov-west-1', null)).toBe('us-gov-west-1');
    expect(kiroApiRegion('us-east-1', 'arn:aws:codewhisperer:eu-central-1:1:profile/X')).toBe('eu-central-1');
    expect(kiroApiRegion('us-east-1', 'arn:aws:x:evil.com/:1:y')).toBe('us-east-1');
  });

  it('错误脱敏不泄露 ksk_ / Bearer / token 字段', () => {
    const s = sanitizeKiroError('failed: ksk_supersecret123 Bearer abcdef123456 refreshToken=rt_secret_999');
    expect(s).not.toContain('supersecret123');
    expect(s).not.toContain('abcdef123456');
    expect(s).not.toContain('rt_secret_999');
  });

  it('buildKiroCredential 只有 accessToken 与未来 expiresAt 同时存在才一起写入', () => {
    const now = Date.parse('2026-11-24T12:00:00Z');
    // 有未来 expiresAt 但缺 accessToken → 都不写
    const c1 = buildKiroCredential({ authMethod: 'social', refreshToken: 'r1', expiresAt: '2026-11-24T13:00:00Z' }, now);
    expect(c1.accessToken).toBeUndefined();
    expect(c1.expiresAt).toBeUndefined();
    // 已过期 → 都不写
    const c2 = buildKiroCredential({ authMethod: 'social', refreshToken: 'r1', accessToken: 'a1', expiresAt: '2026-11-24T11:00:00Z' }, now);
    expect(c2.accessToken).toBeUndefined();
    expect(c2.expiresAt).toBeUndefined();
    // 两者都有且未过期 → 一起写
    const c3 = buildKiroCredential({ authMethod: 'social', refreshToken: 'r1', accessToken: 'a1', expiresAt: '2026-11-24T13:00:00Z' }, now);
    expect(c3.accessToken).toBe('a1');
    expect(c3.expiresAt).toBe('2026-11-24T13:00:00.000Z');
  });
});

describe('KiroEngine', () => {
  it('完整 build 流程、日志截断单调递增、保留当前与上一版、失败保留旧版', async () => {
    let targetSha = SHA_A;
    let cargoFail = false;
    let onUpgradedCalls = 0;
    const commands: string[] = [];

    const engine = new KiroEngine({
      rootDir: () => path.join(home, 'kiro-rs'),
      env: () => ({}),
      findTool: (name) => `/fake/${name}`,
      logMaxLines: 5,
      onUpgraded: () => { onUpgradedCalls++; },
      fetch: async (_url, init) => {
        const h = new Headers(init?.headers);
        expect(h.get('user-agent')).not.toMatch(/cosyee/i);
        return new Response(JSON.stringify({
          sha: targetSha,
          commit: { committer: { date: '2026-11-24T00:00:00Z' }, message: `release ${targetSha.slice(0, 6)}\ndetail` },
        }), { status: 200 });
      },
      runCommand: async (cmd, args, opts) => {
        commands.push(`${path.basename(cmd)} ${args.join(' ')}`);
        opts.onLine?.(`run ${path.basename(cmd)} ${args[0] ?? ''}`);
        const srcDir = path.join(home, 'kiro-rs', 'src');
        if (cmd.endsWith('git') && args[0] === 'clone') {
          fs.mkdirSync(path.join(srcDir, '.git'), { recursive: true });
          return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd.endsWith('git') && args[0] === 'rev-parse') {
          return { code: 0, stdout: targetSha + '\n', stderr: '' };
        }
        if (cmd.endsWith('git') && args[0] === 'status') {
          return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd.endsWith('cargo') && args[0] === 'build') {
          for (let i = 0; i < 6; i++) opts.onLine?.(`compiling crate ${i}`);
          if (cargoFail) return { code: 1, stdout: '', stderr: 'compile err' };
          // 确认 admin-ui/dist/index.html 占位已建立
          expect(fs.existsSync(path.join(srcDir, 'admin-ui', 'dist', 'index.html'))).toBe(true);
          const outBin = path.join(srcDir, 'target', 'release', EXE_NAME);
          fs.mkdirSync(path.dirname(outBin), { recursive: true });
          fs.writeFileSync(outBin, `bin-${targetSha}`);
          return { code: 0, stdout: '', stderr: '' };
        }
        if (args[0] === '--version') {
          return { code: 0, stdout: 'kiro-rs 2026.10.1\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });

    expect(engine.status().source).toBe('none');
    engine.startBuild();
    await engine.waitForBuild();

    const stA = engine.status();
    expect(stA.source).toBe('managed');
    expect(stA.current?.commit).toBe(SHA_A);
    expect(stA.updateAvailable).toBe(false);
    expect(stA.build.state).toBe('idle');
    expect(onUpgradedCalls).toBe(1);
    expect(engine.binaryPath()).toBe(path.join(home, 'kiro-rs', 'bin', SHA_A, EXE_NAME));

    // 日志超过 logMaxLines(5) 被截断，但 next 仍单调且能按 next 增量读
    const log1 = engine.getLog(0);
    expect(log1.lines.length).toBeLessThanOrEqual(5);
    expect(log1.next).toBeGreaterThan(5);
    const log2 = engine.getLog(log1.next);
    expect(log2).toEqual({ lines: [], next: log1.next });

    // 升级到 SHA_B，然后到 SHA_C：清理时保留 SHA_C 与 SHA_B，删掉 SHA_A
    targetSha = SHA_B;
    engine.startBuild();
    await engine.waitForBuild();
    expect(engine.status().current?.commit).toBe(SHA_B);

    targetSha = SHA_C;
    engine.startBuild();
    await engine.waitForBuild();
    expect(engine.status().current?.commit).toBe(SHA_C);
    const bins = fs.readdirSync(path.join(home, 'kiro-rs', 'bin'));
    expect(bins).toContain(SHA_C);
    expect(bins).toContain(SHA_B);
    expect(bins).not.toContain(SHA_A);

    // 新版本编译失败时保留 SHA_C 不动
    targetSha = 'd'.repeat(40);
    cargoFail = true;
    engine.startBuild();
    await engine.waitForBuild();
    expect(engine.status().build.state).toBe('failed');
    expect(engine.status().current?.commit).toBe(SHA_C);
    expect(fs.existsSync(path.join(home, 'kiro-rs', 'bin', 'd'.repeat(40)))).toBe(false);
  });

  it('查找顺序 COSYEE_KIRO_RS > managed，env 来源 adminUi 按 true 处理，总开关 enabled 持久化', () => {
    const envBin = createFakeBin('env-kiro');
    const engine1 = new KiroEngine({ rootDir: () => path.join(home, 'kiro-rs'), env: () => ({ COSYEE_KIRO_RS: envBin }) });
    expect(engine1.status().source).toBe('env');
    expect(engine1.status().adminUi).toBe(true);
    expect(engine1.status().adminUiError).toBeNull();
    expect(engine1.binaryPath()).toBe(envBin);
    expect(engine1.isEnabled()).toBe(true);
    engine1.setEnabled(false);

    const engine2 = new KiroEngine({ rootDir: () => path.join(home, 'kiro-rs'), env: () => ({}) });
    expect(engine2.isEnabled()).toBe(false);
  });

  it('admin-ui 构建：失败退回占位继续编译且不误认残留 dist；同 commit 重建换新目录名并用 npx 回退', async () => {
    let uiShouldFail = true;
    let nowMs = 1_700_000_000_000;
    const ran: Array<{ cmd: string; args: string[] }> = [];

    const engine = new KiroEngine({
      rootDir: () => path.join(home, 'kiro-rs'),
      env: () => ({}),
      now: () => (nowMs += 1000),
      // 没有 pnpm 时自动回退 npx --yes pnpm@11
      findTool: (name) => (name === 'pnpm' ? null : `/fake/${name}`),
      fetch: async () => new Response(JSON.stringify({
        sha: SHA_A,
        commit: { committer: { date: '2026-11-24T00:00:00Z' }, message: 'init' },
      }), { status: 200 }),
      runCommand: async (cmd, args) => {
        ran.push({ cmd: path.basename(cmd), args });
        const srcDir = path.join(home, 'kiro-rs', 'src');
        const uiDir = path.join(srcDir, 'admin-ui');
        if (cmd.endsWith('git') && args[0] === 'clone') {
          fs.mkdirSync(path.join(srcDir, '.git'), { recursive: true });
          fs.mkdirSync(path.join(uiDir, 'dist'), { recursive: true });
          fs.writeFileSync(path.join(uiDir, 'package.json'), '{"name":"ui"}');
          // 预先放一个旧 dist，验证失败时绝不会被误当成本次成功
          fs.writeFileSync(path.join(uiDir, 'dist', 'index.html'), '<html>stale</html>');
          return { code: 0, stdout: '', stderr: '' };
        }
        if (cmd.endsWith('git') && args[0] === 'rev-parse') return { code: 0, stdout: SHA_A + '\n', stderr: '' };
        if (cmd.endsWith('git') && args[0] === 'status') return { code: 0, stdout: '', stderr: '' };
        if (cmd.endsWith('npx')) {
          if (args.includes('install')) {
            // 验证旧 dist 已被清掉
            expect(fs.existsSync(path.join(uiDir, 'dist', 'index.html'))).toBe(false);
            return uiShouldFail ? { code: 1, stdout: '', stderr: 'offline' } : { code: 0, stdout: '', stderr: '' };
          }
          if (args.includes('build')) {
            fs.mkdirSync(path.join(uiDir, 'dist'), { recursive: true });
            fs.writeFileSync(path.join(uiDir, 'dist', 'index.html'), '<html>real admin ui</html>');
            return { code: 0, stdout: '', stderr: '' };
          }
        }
        if (cmd.endsWith('cargo') && args[0] === 'build') {
          expect(fs.existsSync(path.join(uiDir, 'dist', 'index.html'))).toBe(true);
          const outBin = path.join(srcDir, 'target', 'release', EXE_NAME);
          fs.mkdirSync(path.dirname(outBin), { recursive: true });
          fs.writeFileSync(outBin, 'bin');
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: 'kiro-rs 2026.10.1\n', stderr: '' };
      },
    });

    // 第一次：admin-ui 失败，但引擎仍然编译成功，adminUi=false 且带错误原因
    engine.startBuild();
    await engine.waitForBuild();
    const st1 = engine.status();
    expect(st1.source).toBe('managed');
    expect(st1.adminUi).toBe(false);
    expect(st1.adminUiError).toBeTruthy();
    const bin1 = engine.binaryPath()!;
    expect(bin1).toContain(SHA_A);
    expect(ran.some((r) => r.cmd === 'npx' && r.args[0] === '--yes' && r.args[1] === 'pnpm@11' && r.args[2] === 'install' && r.args[3] === '--frozen-lockfile')).toBe(true);

    // 第二次：同一 commit 重新编译（此时网络恢复），换成新目录名，不覆盖旧目录里的 exe
    uiShouldFail = false;
    engine.startBuild();
    await engine.waitForBuild();
    const st2 = engine.status();
    expect(st2.adminUi).toBe(true);
    expect(st2.adminUiError).toBeNull();
    const bin2 = engine.binaryPath()!;
    expect(bin2).not.toBe(bin1);
    expect(fs.existsSync(bin1)).toBe(true); // 旧版目录保留（作为上一版）
    expect(fs.existsSync(bin2)).toBe(true);
  });
});

describe('KiroProxyManager & claudeEnv & api-config', () => {
  it('api-config 往返保留 kiro 字段，kiroChildEnv 删除 KIRO_API_KEY', () => {
    const dir = path.join(root, 'acc-k1');
    writeApiConfig(dir, {
      baseUrl: 'http://127.0.0.1:19999',
      apiKey: 'proxy-key-123456',
      authType: 'apiKey',
      kiro: { method: 'builderId', port: 19999 },
    });
    const back = readApiConfig(dir);
    expect(back?.kiro).toEqual({ method: 'builderId', port: 19999 });
    expect(back?.baseUrl).toBe('http://127.0.0.1:19999');

    const env = kiroChildEnv({ PATH: 'x', KIRO_API_KEY: 'ksk_must_not_leak', kiro_api_key: 'ksk_2' });
    expect(env.KIRO_API_KEY).toBeUndefined();
    expect(env.kiro_api_key).toBeUndefined();
    expect(env.PATH).toBe('x');
  });

  it('端口被真实占用时 ensure 同步换端口并更新 cosyee-api.json 与 config.json，claudeEnv 立刻读到新端口', async () => {
    // 占住一个真实 127.0.0.1 端口
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const occupiedPort = (blocker.address() as AddressInfo).port;

    try {
      const bin = createFakeBin();
      const engine = new KiroEngine({ rootDir: () => path.join(home, 'kiro-rs'), env: () => ({ COSYEE_KIRO_RS: bin }) });
      const dir = path.join(root, 'acc-port');
      const cfg = createProxyConfig(occupiedPort);
      const procs: FakeProc[] = [];
      const proxy = new KiroProxyManager({
        engine,
        spawnProxy: () => {
          const p = new FakeProc();
          procs.push(p);
          return p as unknown as ChildProcess;
        },
      });
      proxy.writeAccountConfigs(dir, 'apiKey', cfg);
      setBeforeClaudeEnv((d) => proxy.ensure(d));

      const env = claudeEnv(dir);
      expect(procs.length).toBe(1);
      const updatedApi = readApiConfig(dir)!;
      const updatedCfg = readKiroProxyConfig(dir)!;
      expect(updatedApi.kiro?.port).not.toBe(occupiedPort);
      expect(updatedCfg.port).toBe(updatedApi.kiro?.port);
      expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${updatedCfg.port}`);
      expect(env.ANTHROPIC_API_KEY).toBe(cfg.apiKey);

      await proxy.stopAll();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('enabled=false 时 ensure 与 claudeEnv 绝不启进程并给出明确错误', () => {
    const bin = createFakeBin();
    const engine = new KiroEngine({ rootDir: () => path.join(home, 'kiro-rs'), env: () => ({ COSYEE_KIRO_RS: bin }) });
    engine.setEnabled(false);
    const dir = path.join(root, 'acc-off');
    const spawnSpy = vi.fn();
    const proxy = new KiroProxyManager({ engine, spawnProxy: spawnSpy });
    proxy.writeAccountConfigs(dir, 'apiKey', createProxyConfig(28888));
    setBeforeClaudeEnv((d) => proxy.ensure(d));

    expect(() => claudeEnv(dir)).toThrow(KIRO_SERVICE_STOPPED);
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('引擎升级后：空闲代理自动重启换新版本，执行中会话的代理留在旧版并计入 outdated', async () => {
    let curBin = createFakeBin('kiro-v1');
    const dirIdle = path.join(root, 'acc-idle');
    const dirBusy = path.join(root, 'acc-busy');
    const store = new StateStore(path.join(home, 'state.json'));
    const runningMap = new Map<string, number>([['busy1', 1], ['idle1', 0]]);
    const spawnedBins: string[] = [];

    const proxy = new KiroProxyManager({
      engine: { binaryPath: () => curBin, isEnabled: () => true },
      findFreePortSync: (p) => p,
      spawnProxy: (bin) => {
        spawnedBins.push(bin);
        return new FakeProc() as unknown as ChildProcess;
      },
    });
    proxy.writeAccountConfigs(dirIdle, 'apiKey', createProxyConfig(28801));
    proxy.writeAccountConfigs(dirBusy, 'apiKey', createProxyConfig(28802));
    store.state.accounts.list.push(
      { id: 'idle1', label: 'Idle', dir: dirIdle, createdAt: 1 },
      { id: 'busy1', label: 'Busy', dir: dirBusy, createdAt: 2 },
    );

    proxy.ensure(dirIdle);
    proxy.ensure(dirBusy);
    expect(proxy.isOutdated(dirIdle)).toBe(false);
    expect(proxy.isOutdated(dirBusy)).toBe(false);

    // 切换新引擎
    curBin = createFakeBin('kiro-v2');
    expect(proxy.isOutdated(dirIdle)).toBe(true);
    expect(proxy.isOutdated(dirBusy)).toBe(true);

    await proxy.restartIdle((dir) => (dir === dirBusy ? (runningMap.get('busy1') ?? 0) > 0 : false));
    expect(proxy.isOutdated(dirIdle)).toBe(false);
    expect(proxy.isOutdated(dirBusy)).toBe(true);
    expect(spawnedBins[spawnedBins.length - 1]).toBe(curBin);

    await proxy.stopAll();
  });
});

describe('KiroLogin（5 种方式、失败清理、重新登录备份恢复）', () => {
  it('未安装引擎或总开关关闭时直接返回 409', () => {
    const hNoEngine = makeHarness({ binPath: null });
    expect(() => hNoEngine.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_12345678' })).toThrow(KIRO_ENGINE_MISSING);

    const hOff = makeHarness();
    hOff.kiro.engine.setEnabled(false);
    expect(() => hOff.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_12345678' })).toThrow(KIRO_SERVICE_STOPPED);
  });

  it('builderId 设备码流程（authorization_pending → slow_down → 成功）且不泄露令牌', async () => {
    let tokenCalls = 0;
    const h = makeHarness({
      fetch: async (input) => {
        const url = String(input);
        if (url === 'https://oidc.us-east-1.amazonaws.com/client/register') {
          return new Response(JSON.stringify({ clientId: 'cid_1', clientSecret: 'csec_super_secret' }), { status: 200 });
        }
        if (url === 'https://oidc.us-east-1.amazonaws.com/device_authorization') {
          return new Response(JSON.stringify({
            deviceCode: 'dev_1',
            userCode: 'ABCD-EFGH',
            verificationUri: 'https://device.sso.us-east-1.amazonaws.com/',
            verificationUriComplete: 'https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH',
            interval: 1,
            expiresIn: 600,
          }), { status: 200 });
        }
        if (url === 'https://oidc.us-east-1.amazonaws.com/token') {
          tokenCalls++;
          if (tokenCalls === 1) return new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 400 });
          if (tokenCalls === 2) return new Response(JSON.stringify({ error: 'slow_down' }), { status: 400 });
          return new Response(JSON.stringify({
            accessToken: 'at_secret_val',
            refreshToken: 'rt_secret_val',
            expiresIn: 3600,
          }), { status: 200 });
        }
        throw new Error(`unexpected ${url}`);
      },
    });

    const job = h.kiro.startLogin({ method: 'builderId', label: '我的 Kiro' });
    await h.kiro.login.waitForLogin();
    const final = h.kiro.getLogin(job.loginId);
    expect(final.status).toBe('done');
    expect(final.userCode).toBe('ABCD-EFGH');
    expect(final.url).toBe('https://device.sso.us-east-1.amazonaws.com/?user_code=ABCD-EFGH');
    expect(final.accountId).toBeTruthy();

    // 检查账号列表：有 kiro、无 api、plan='Kiro'、不含任何令牌
    const listJson = JSON.stringify(h.accounts.list());
    expect(listJson).not.toContain('at_secret_val');
    expect(listJson).not.toContain('rt_secret_val');
    expect(listJson).not.toContain('csec_super_secret');
    const entry = h.accounts.list().list.find((x) => x.id === final.accountId)!;
    expect(entry.api).toBeUndefined();
    expect(entry.plan).toBe('Kiro');
    expect(entry.name).toBe('我的 Kiro');
    expect(entry.kiro).toEqual({ method: 'builderId', proxy: 'ready', error: null });

    // credentials.json 必须是数组格式
    const dir = h.accounts.dirFor(final.accountId!)!;
    const creds = JSON.parse(fs.readFileSync(kiroCredsPath(dir), 'utf8'));
    expect(Array.isArray(creds)).toBe(true);
    expect(creds[0].authMethod).toBe('idc');
    expect(creds[0].refreshToken).toBe('rt_secret_val');
    expect(creds[0].clientId).toBe('cid_1');

    // saveApi 不允许修改 Kiro 账号
    await expect(h.accounts.saveApi({ id: final.accountId!, baseUrl: 'https://x.test', apiKey: 'sk-1' })).rejects.toThrow('Kiro');

    await h.kiro.dispose();
  });

  it('kiroIde 导入（IdC 带 40 位 hex clientIdHash）不修改源文件；非法 hash 被拒绝', async () => {
    const cacheDir = path.join(tmp, 'sso-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const hash = '1'.repeat(40);
    const tokFile = path.join(cacheDir, 'kiro-auth-token.json');
    const cliFile = path.join(cacheDir, `${hash}.json`);
    const origTok = JSON.stringify({
      refreshToken: 'ide_rt_1',
      accessToken: 'ide_at_1',
      expiresAt: '2099-01-01T00:00:00Z',
      authMethod: 'IdC',
      clientIdHash: hash,
      region: 'us-east-1',
    });
    fs.writeFileSync(tokFile, origTok);
    fs.writeFileSync(cliFile, JSON.stringify({ clientId: 'ide_cid', clientSecret: 'ide_csec' }));

    const h = makeHarness({ ideTokenFile: tokFile });
    expect(h.kiro.status().imports.kiroIde).toBe(true);
    const job = h.kiro.startLogin({ method: 'kiroIde' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job.loginId).status).toBe('done');
    expect(fs.readFileSync(tokFile, 'utf8')).toBe(origTok); // 原文件丝毫未动

    // 非法 clientIdHash（路径穿越）被拒绝且不留目录
    fs.writeFileSync(tokFile, JSON.stringify({
      refreshToken: 'ide_rt_2',
      authMethod: 'IdC',
      clientIdHash: '../evil',
    }));
    const beforeDirs = fs.readdirSync(root);
    const job2 = h.kiro.startLogin({ method: 'kiroIde' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job2.loginId).status).toBe('failed');
    expect(fs.readdirSync(root)).toEqual(beforeDirs);

    await h.kiro.dispose();
  });

  it('kiroCli 只读导入临时 SQLite（social 与 odic），不修改数据库', async () => {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req('node:sqlite') as typeof import('node:sqlite');
    const dbFile = path.join(tmp, 'kiro-cli.sqlite3');
    const db = new DatabaseSync(dbFile);
    db.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
      'kirocli:social:token',
      JSON.stringify({
        refresh_token: 'cli_rt_1',
        access_token: 'cli_at_1',
        expires_at: '2099-01-01T00:00:00Z',
        profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/abc',
      }),
    );
    db.close();

    const h = makeHarness({ cliDbFile: dbFile });
    expect(h.kiro.status().imports.kiroCli).toBe(true);
    const job = h.kiro.startLogin({ method: 'kiroCli' });
    await h.kiro.login.waitForLogin();
    const res = h.kiro.getLogin(job.loginId);
    expect(res.status).toBe('done');
    const dir = h.accounts.dirFor(res.accountId!)!;
    const creds = JSON.parse(fs.readFileSync(kiroCredsPath(dir), 'utf8'));
    expect(creds[0].authMethod).toBe('social');
    expect(creds[0].refreshToken).toBe('cli_rt_1');
    expect(creds[0].profileArn).toBe('arn:aws:codewhisperer:us-east-1:123:profile/abc');

    await h.kiro.dispose();
  });

  it('apiKey 登录、验证失败清理目录、重新登录失败恢复旧凭据、执行中会话重新登录 409', async () => {
    // 1. 验证失败：不留目录，错误脱敏
    const hFail = makeHarness({ adminBalance: null });
    const before = fs.readdirSync(root);
    const jFail = hFail.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_leaked_secret_xyz' });
    await hFail.kiro.login.waitForLogin();
    const stFail = hFail.kiro.getLogin(jFail.loginId);
    expect(stFail.status).toBe('failed');
    expect(stFail.error).not.toContain('ksk_leaked_secret_xyz');
    expect(fs.readdirSync(root)).toEqual(before);

    // 2. 正常 apiKey 登录
    let balanceShouldFail = false;
    const h = makeHarness({
      adminBalance: { subscriptionTitle: 'KIRO FREE', currentUsage: 5, usageLimit: 50, nextResetAt: 1700000000 },
    });
    const jOk = h.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_valid_key_001', label: 'Key账号' });
    await h.kiro.login.waitForLogin();
    const accId = h.kiro.getLogin(jOk.loginId).accountId!;
    const dir = h.accounts.dirFor(accId)!;
    const origCreds = fs.readFileSync(kiroCredsPath(dir), 'utf8');

    // 有执行中会话时重新登录返回 409
    h.runningMap.set(accId, 1);
    expect(() => h.kiro.startLogin({ method: 'apiKey', accountId: accId, apiKey: 'ksk_valid_key_002' })).toThrow('正在执行');
    h.runningMap.set(accId, 0);

    // 重新登录验证失败时恢复原 credentials.json
    const origGetBalance = h.kiro.proxy.getBalance.bind(h.kiro.proxy);
    vi.spyOn(h.kiro.proxy, 'getBalance').mockImplementation(async (d) => {
      if (balanceShouldFail) throw new Error('invalid api key');
      return origGetBalance(d);
    });
    balanceShouldFail = true;
    const jRelog = h.kiro.startLogin({ method: 'apiKey', accountId: accId, apiKey: 'ksk_bad_relogin_999' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(jRelog.loginId).status).toBe('failed');
    expect(fs.readFileSync(kiroCredsPath(dir), 'utf8')).toBe(origCreds);

    // 移除账号前停止代理并删目录
    const stopSpy = vi.spyOn(h.kiro.proxy, 'stop');
    await h.accounts.remove(accId);
    expect(stopSpy).toHaveBeenCalledWith(dir);
    expect(fs.existsSync(dir)).toBe(false);

    await h.kiro.dispose();
  });
});

describe('HTTP /api/kiro 路由（含 HTTP/1.0 无请求体、fromLocal 限制、service 启停）', () => {
  it('覆盖 /api/kiro 全部端点，HTTP/1.0 无 Origin 响应无 chunked/gzip，远程 403，忙会话 409', async () => {
    const h = makeHarness();
    // 先建一个 Kiro 账号
    const j = h.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_http_test_001' });
    await h.kiro.login.waitForLogin();
    const accId = h.kiro.getLogin(j.loginId).accountId!;

    const workspaces = new Workspaces(h.store);
    let port = 0;
    const handler = createHandler({
      port: () => port,
      version: '0.0.0-test',
      webDist: null,
      workspaces,
      sessions: {} as never,
      manager: { runningCount: () => 0 } as never,
      account: { get: async () => null },
      accounts: h.accounts,
      kiro: h.kiro,
      usage: { get: async () => null },
      store: h.store,
      previews: {} as never,
      pins: {} as never,
      trash: {} as never,
      pricing: { table: () => ({ source: 'builtin', fetchedAt: 0, models: [] }) },
    });

    const srv = http.createServer((req, res) => { void handler(req, res); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as AddressInfo).port;

    try {
      // 1. GET /api/kiro & GET /api/kiro/balance
      const stRes = await fetch(`http://127.0.0.1:${port}/api/kiro`);
      expect(stRes.status).toBe(200);
      const st = await stRes.json();
      expect(st.service.enabled).toBe(true);
      expect(st.service.accounts).toBe(1);

      const balRes = await fetch(`http://127.0.0.1:${port}/api/kiro/balance?account=${accId}`);
      expect(balRes.status).toBe(200);
      const bal = await balRes.json();
      expect(bal).toEqual({
        subscription: 'KIRO PRO',
        used: 12.5,
        limit: 500,
        resetsAt: 1700000000500,
      });

      // 2. 远程请求（带 Tailscale-User-Login 头）调 engine/build 与 service/stop 返回 403
      const remoteBuild = await fetch(`http://127.0.0.1:${port}/api/kiro/engine/build`, {
        method: 'POST',
        headers: { 'tailscale-user-login': 'alice@example.com' },
      });
      expect(remoteBuild.status).toBe(403);
      const remoteStop = await fetch(`http://127.0.0.1:${port}/api/kiro/service/stop`, {
        method: 'POST',
        headers: { 'tailscale-user-login': 'alice@example.com' },
      });
      expect(remoteStop.status).toBe(403);

      // 3. 有执行中 Kiro 会话时 stop 不带 force 返回 409 { error, running }
      h.runningMap.set(accId, 2);
      const busyStop = await fetch(`http://127.0.0.1:${port}/api/kiro/service/stop`, { method: 'POST' });
      expect(busyStop.status).toBe(409);
      const busyBody = await busyStop.json();
      expect(busyBody.running).toBe(2);

      // 4. 原生 TCP HTTP/1.0 POST /api/kiro/service/stop?force=1（Content-Length: 0、无 Origin）
      const rawResp = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            `POST /api/kiro/service/stop?force=1 HTTP/1.0\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Content-Length: 0\r\n\r\n`,
          );
        });
        let data = '';
        sock.on('data', (c) => { data += c.toString('utf8'); });
        sock.on('end', () => resolve(data));
        sock.on('error', reject);
      });
      const [head, bodyText] = rawResp.split('\r\n\r\n');
      expect(head).toMatch(/^HTTP\/1\.1 200 OK/);
      expect(head!.toLowerCase()).not.toContain('transfer-encoding: chunked');
      expect(head!.toLowerCase()).not.toContain('content-encoding: gzip');
      expect(head!.toLowerCase()).toContain('content-length:');
      const parsed = JSON.parse(bodyText!);
      expect(parsed.service.enabled).toBe(false);
      expect(parsed.service.running).toBe(0);

      // 5. POST /api/kiro/service/start 重新打开并启动代理
      const startRes = await fetch(`http://127.0.0.1:${port}/api/kiro/service/start`, { method: 'POST' });
      expect(startRes.status).toBe(200);
      const startBody = await startRes.json();
      expect(startBody.service.enabled).toBe(true);
      expect(startBody.service.running).toBe(1);
      expect(startBody.service.items).toEqual([{ id: accId, label: 'Kiro', proxy: 'starting' }]);
      // GET /api/kiro 绝不包含 adminApiKey
      const cfg = readKiroProxyConfig(h.accounts.dirFor(accId)!)!;
      expect(JSON.stringify(startBody)).not.toContain(cfg.adminApiKey);

      // 6. POST /api/kiro/service/admin：带 Origin 或 Sec-Fetch-Site/Mode 的网页请求一律 403
      const originAdmin = await fetch(`http://127.0.0.1:${port}/api/kiro/service/admin?account=${accId}`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      expect(originAdmin.status).toBe(403);
      const fetchSiteAdmin = await fetch(`http://127.0.0.1:${port}/api/kiro/service/admin?account=${accId}`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(fetchSiteAdmin.status).toBe(403);
      const fetchModeAdmin = await fetch(`http://127.0.0.1:${port}/api/kiro/service/admin?account=${accId}`, {
        method: 'POST',
        headers: { 'sec-fetch-mode': 'cors' },
      });
      expect(fetchModeAdmin.status).toBe(403);

      // 本机原生 HTTP/1.0 请求 POST /api/kiro/service/admin 成功返回 { url, key } 且 Cache-Control: no-store
      const adminRaw = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            `POST /api/kiro/service/admin?account=${accId} HTTP/1.0\r\n` +
            `Host: 127.0.0.1:${port}\r\n` +
            `Content-Length: 0\r\n\r\n`,
          );
        });
        let data = '';
        sock.on('data', (c) => { data += c.toString('utf8'); });
        sock.on('end', () => resolve(data));
        sock.on('error', reject);
      });
      const [adminHead, adminBody] = adminRaw.split('\r\n\r\n');
      expect(adminHead).toMatch(/^HTTP\/1\.1 200 OK/);
      expect(adminHead!.toLowerCase()).toContain('cache-control: no-store');
      expect(adminHead!.toLowerCase()).not.toContain('transfer-encoding: chunked');
      expect(JSON.parse(adminBody!)).toEqual({
        url: `http://127.0.0.1:${cfg.port}/admin`,
        key: cfg.adminApiKey,
      });

      // 7. 模拟 sidecar / 管理页面改写了 credentials.json：重启代理绝不覆盖 credentials.json
      const credsFile = kiroCredsPath(h.accounts.dirFor(accId)!);
      const refreshedCreds = JSON.stringify([{ authMethod: 'api_key', kiroApiKey: 'ksk_updated_in_admin_ui' }]);
      fs.writeFileSync(credsFile, refreshedCreds);
      await h.kiro.restartService(true);
      expect(fs.readFileSync(credsFile, 'utf8')).toBe(refreshedCreds);

      // 8. 凭据在管理页面被删空时，查询余额给出明确 409 提示而非崩溃
      const emptyProxy = new KiroProxyManager({
        engine: h.kiro.engine,
        findFreePortSync: (p) => p,
        readyPollMs: 5,
        readyTimeoutMs: 300,
        spawnProxy: () => new FakeProc() as unknown as ChildProcess,
        fetch: async () => new Response(JSON.stringify({ total: 0, available: 0, currentId: 0, credentials: [] }), { status: 200 }),
      });
      await expect(emptyProxy.getBalance(h.accounts.dirFor(accId)!)).rejects.toThrow('没有可用凭据');
      await emptyProxy.stopAll();
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      await h.kiro.dispose();
    }
  });
});
