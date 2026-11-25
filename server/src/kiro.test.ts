// Kiro 账号后端单测：内置 kiro.rs 单实例服务（启停、端口冲突）、账号与服务里凭据/分组/Key 的映射（添加、重新登录、移除、回滚）、
// 旧格式账号迁移、模型映射、5 种登录方式、SSRF/脱敏校验、HTTP/1.0 路由。
// 全部使用临时目录和一个内存里的假 kiro.rs（Admin API + /v1/models），绝不读取本机真实 Kiro 登录、不联网。
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
import { createKiroAdapter } from './components/kiro.js';
import { ComponentUpdater } from './components/updater.js';
import { createHandler } from './http.js';
import { KiroEngine, KiroService, KIRO_ENGINE_MISSING, KIRO_SERVICE_STOPPED } from './kiro/index.js';
import { buildKiroModelMap } from './kiro/models.js';
import {
  KiroProxyManager,
  createServiceConfig,
  kiroChildEnv,
  kiroConfigPath,
  kiroCredsPath,
  readKiroServiceConfig,
  writeKiroServiceConfig,
} from './kiro/proxy.js';
import { buildKiroCredential, isValidRegion, kiroApiRegion, normalizeStartUrl, sanitizeKiroError } from './kiro/sanitize.js';
import { setActiveConfigDir } from './paths.js';
import { StateStore, Workspaces } from './workspaces.js';

let tmp: string;
let base: string;
let root: string;
let home: string;
const saved: Record<string, string | undefined> = {};

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

/** 内置服务的数据目录（与 KiroService 默认值一致：<COSYEE_HOME>/kiro-rs/service） */
function serviceDir(): string {
  return path.join(home, 'kiro-rs', 'service');
}

interface FakeCred {
  id: number;
  body: Record<string, unknown>;
  groups: string[];
  /** kiro.rs 查过额度后才有的登录邮箱 */
  email?: string;
  /** kiro.rs 自动禁用（比如额度用完 QuotaExceeded） */
  disabled?: boolean;
  disabledReason?: string;
}
interface FakeKey {
  id: number;
  key: string;
  name: string;
  group: string;
}

/**
 * 内存里的假 kiro.rs：按 config.json 里的 adminApiKey 认 Admin API，模拟分组、凭据、客户端 Key、余额与 /v1/models。
 * 只认 127.0.0.1 的请求，其他地址交给 fallback。
 */
class FakeKiroServer {
  groups = new Set<string>();
  creds = new Map<number, FakeCred>();
  keys = new Map<number, FakeKey>();
  calls: string[] = [];
  nextCred = 1;
  nextKey = 1;
  /** 返回 true 时该凭据的余额查询失败（502） */
  balanceFail: (c: FakeCred) => boolean = () => false;
  /** 返回字符串时添加该凭据失败（400，消息为该字符串） */
  addFail: (body: Record<string, unknown>) => string | null = () => null;
  /** 为 true 时创建客户端 Key 失败（500） */
  keyFail = false;
  /** 新凭据的登录邮箱（模拟 kiro.rs 验证额度后读到的邮箱） */
  emailOf: (body: Record<string, unknown>) => string | undefined = () => undefined;
  /** 让 /v1/models 返回错误状态 */
  modelsStatus = 200;
  models = ['claude-sonnet-4-5', 'claude-sonnet-4-5-thinking', 'claude-opus-4-5', 'claude-haiku-4-5'];
  balance = { subscriptionTitle: 'KIRO PRO', currentUsage: 12.5, usageLimit: 500, nextResetAt: 1700000000.5 };

  private adminKey(): string | null {
    return readKiroServiceConfig(serviceDir())?.adminApiKey ?? null;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }

  private err(status: number, message: string): Response {
    return this.json(status, { error: { type: 'error', message } });
  }

  callsOf(prefix: string): string[] {
    return this.calls.filter((c) => c.startsWith(prefix));
  }

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    if (url.hostname !== '127.0.0.1') throw new Error(`Unexpected fetch: ${url.toString()}`);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = new Headers(init?.headers).get('x-api-key');
    const body: Record<string, unknown> = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    if (url.pathname === '/v1/models') {
      const k = [...this.keys.values()].find((x) => x.key === key);
      if (!k) return this.err(401, 'invalid key');
      const has = [...this.creds.values()].some((c) => c.groups.includes(k.group));
      if (!has) return this.err(401, 'no credentials in group');
      this.calls.push(`${method} /v1/models`);
      if (this.modelsStatus !== 200) return this.err(this.modelsStatus, 'models failed');
      return this.json(200, { data: this.models.map((id) => ({ id })) });
    }

    const pfx = '/api/admin';
    if (!url.pathname.startsWith(pfx)) return this.err(404, 'not found');
    if (!key || key !== this.adminKey()) return this.err(401, 'unauthorized');
    const p = url.pathname.slice(pfx.length);
    this.calls.push(`${method} ${p}`);
    let m: RegExpExecArray | null;

    if (method === 'GET' && p === '/credentials') {
      const list = [...this.creds.values()].map((c) => ({
        id: c.id, groups: c.groups, email: c.email ?? null, disabled: c.disabled ?? false, disabledReason: c.disabledReason ?? null,
      }));
      return this.json(200, { total: list.length, available: list.length, currentId: list[0]?.id ?? 0, credentials: list });
    }
    if (method === 'POST' && p === '/credentials') {
      const fail = this.addFail(body);
      if (fail) return this.err(400, fail);
      const dup = [...this.creds.values()].some(
        (c) =>
          (typeof body.refreshToken === 'string' && c.body.refreshToken === body.refreshToken) ||
          (typeof body.kiroApiKey === 'string' && c.body.kiroApiKey === body.kiroApiKey),
      );
      if (dup) return this.err(400, '凭据已存在');
      const id = this.nextCred++;
      const { groups, ...rest } = body;
      const email = this.emailOf(rest);
      this.creds.set(id, { id, body: rest, groups: Array.isArray(groups) ? (groups as string[]) : [], ...(email ? { email } : {}) });
      return this.json(200, { success: true, message: 'ok', credentialId: id });
    }
    if (method === 'DELETE' && (m = /^\/credentials\/(\d+)$/.exec(p))) {
      const id = Number(m[1]);
      if (!this.creds.delete(id)) return this.err(404, '凭据不存在');
      return this.json(200, { success: true, message: 'deleted' });
    }
    if (method === 'GET' && (m = /^\/credentials\/(\d+)\/balance$/.exec(p))) {
      const c = this.creds.get(Number(m[1]));
      if (!c) return this.err(404, '凭据不存在');
      if (this.balanceFail(c)) return this.err(502, 'upstream rejected ksk_leaked_secret_xyz');
      const b = this.balance;
      return this.json(200, { id: c.id, ...b, remaining: b.usageLimit - b.currentUsage, usagePercentage: 2.5 });
    }
    if (method === 'POST' && p === '/groups') {
      const name = String(body.name ?? '');
      if (this.groups.has(name)) return this.err(409, '分组已存在');
      this.groups.add(name);
      return this.json(200, { success: true, message: 'ok' });
    }
    if (method === 'DELETE' && (m = /^\/groups\/([^/]+)$/.exec(p))) {
      const name = decodeURIComponent(m[1]!);
      if (!this.groups.delete(name)) return this.err(404, '分组不存在');
      for (const [id, k] of this.keys) if (k.group === name) this.keys.delete(id);
      return this.json(200, { success: true, message: 'ok' });
    }
    if (method === 'POST' && p === '/client-keys') {
      if (this.keyFail) return this.err(500, 'key store broken');
      const group = String(body.group ?? '');
      if (!this.groups.has(group)) return this.err(400, '分组不存在');
      const id = this.nextKey++;
      const k: FakeKey = { id, key: `sk-fake-${id}-${'x'.repeat(24)}`, name: String(body.name ?? ''), group };
      this.keys.set(id, k);
      return this.json(200, { id, key: k.key, name: k.name, createdAt: '2026-01-01T00:00:00Z' });
    }
    if (method === 'DELETE' && (m = /^\/client-keys\/(\d+)$/.exec(p))) {
      if (!this.keys.delete(Number(m[1]))) return this.err(404, 'Key 不存在');
      return this.json(200, { success: true, message: 'ok' });
    }
    return this.err(404, `unhandled ${method} ${p}`);
  };
}

/** 构造一套完全隔离的测试环境（Accounts、KiroService、可控运行会话数、假 kiro.rs） */
function makeHarness(opts: {
  binPath?: string | null;
  /** 非 127.0.0.1 的请求（OIDC 等）走这里 */
  fetch?: typeof globalThis.fetch;
  runningMap?: Map<string, number>;
  ideTokenFile?: string;
  cliDbFile?: string;
  server?: FakeKiroServer;
  spawnOverride?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => FakeProc;
} = {}) {
  const store = new StateStore(path.join(home, 'state.json'));
  const runningMap = opts.runningMap ?? new Map<string, number>();
  const spawned: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv; proc: FakeProc }> = [];
  const fakeBin = opts.binPath === undefined ? createFakeBin() : opts.binPath;
  const server = opts.server ?? new FakeKiroServer();
  const logs: string[] = [];
  const modelsChanged: string[] = [];
  const changes: Array<{ reset?: string; notify?: 'reload' | 'refresh' }> = [];

  const ideFile = opts.ideTokenFile ?? path.join(tmp, 'nonexistent-ide-token.json');
  const cliFile = opts.cliDbFile ?? path.join(tmp, 'nonexistent-cli.sqlite3');

  let kiroRef: KiroService | null = null;
  const accounts = new Accounts({
    store,
    running: (id) => (id ? (runningMap.get(id) ?? 0) : [...runningMap.values()].reduce((a, b) => a + b, 0)),
    processes: () => 0,
    stop: async () => {},
    kiroState: (id, dir) => kiroRef?.accountState(id, dir) ?? { proxy: 'stopped', error: null, credential: 'unknown' },
    removeKiroAccount: (id, dir) => kiroRef?.removeAccount(id, dir) ?? Promise.resolve(),
    onChanged: (e) => changes.push(e),
  });

  const loginFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith('http://127.0.0.1:')) return server.fetch(input, init);
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
      kiroEmailTaken: (email, except) => accounts.kiroEmailTaken(email, except),
      modelsChanged: (id) => modelsChanged.push(id),
      infoChanged: () => accounts.kiroInfoChanged(),
    },
    engine: {
      env: () => ({ ...process.env, ...(fakeBin ? { COSYEE_KIRO_RS: fakeBin } : {}) }),
      // 引擎的自动检查永远连不上网，绝不联网
      fetch: async () => {
        throw new Error('offline');
      },
    },
    proxy: {
      fetch: server.fetch,
      pickFreePort: async () => nextPort++,
      isPortFree: async () => true,
      readyPollMs: 5,
      readyTimeoutMs: 500,
      spawnProxy: (bin, args, env) => {
        const proc = opts.spawnOverride ? opts.spawnOverride(bin, args, env) : new FakeProc();
        spawned.push({ bin, args, env, proc });
        return proc as unknown as ChildProcess;
      },
    },
    admin: { fetch: server.fetch, log: (m) => logs.push(m) },
    login: {
      fetch: loginFetch,
      kiroIdeTokenPath: () => ideFile,
      kiroCliDbPath: () => cliFile,
      pollDelayMs: () => 5,
    },
  });
  kiroRef = kiro;
  return { store, accounts, kiro, spawned, runningMap, server, logs, modelsChanged, changes };
}

type Harness = ReturnType<typeof makeHarness>;

/** 用 apiKey 方式登录一个新账号并等完成，返回账号 id 与目录 */
async function loginApiKey(h: Harness, apiKey: string, label?: string): Promise<{ id: string; dir: string }> {
  const job = h.kiro.startLogin({ method: 'apiKey', apiKey, ...(label ? { label } : {}) });
  await h.kiro.login.waitForLogin();
  const st = h.kiro.getLogin(job.loginId);
  if (st.status !== 'done') throw new Error(`login failed: ${st.error}`);
  const id = st.accountId!;
  return { id, dir: h.accounts.dirFor(id)! };
}

/** 造一个旧格式账号（每账号一个进程时代）：cosyee-api.json 里是 {method, port}，凭据在 <dir>/kiro/credentials.json */
function makeLegacyAccount(h: Harness, id: string, cred: Record<string, unknown> | null, method: 'builderId' | 'apiKey' = 'builderId'): string {
  const dir = path.join(root, id);
  fs.mkdirSync(path.join(dir, 'kiro'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'cosyee-api.json'),
    JSON.stringify({ baseUrl: 'http://127.0.0.1:19999', apiKey: 'legacy-proxy-key', authType: 'apiKey', kiro: { method, port: 19999 } }),
  );
  if (cred) fs.writeFileSync(path.join(dir, 'kiro', 'credentials.json'), JSON.stringify([cred]));
  h.store.state.accounts.list.push({ id, label: `旧 ${id}`, dir, createdAt: 1 });
  return dir;
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

describe('buildKiroModelMap（模型映射）', () => {
  it('每个系列取版本最高的做别名，其余进 extra，-thinking 丢掉', () => {
    const map = buildKiroModelMap([
      'claude-sonnet-4-5',
      'claude-sonnet-4-5-thinking',
      'claude-sonnet-4',
      'claude-opus-4-5',
      'claude-opus-4-1',
      'claude-haiku-4-5',
      'auto',
    ]);
    expect(map).toEqual({
      alias: { opus: { id: 'claude-opus-4-5' }, sonnet: { id: 'claude-sonnet-4-5' }, haiku: { id: 'claude-haiku-4-5' } },
      extra: [{ id: 'claude-sonnet-4' }, { id: 'claude-opus-4-1' }, { id: 'auto' }],
    });
    expect(JSON.stringify(map)).not.toContain('thinking');
  });

  it('Kiro 的点号版本号（claude-sonnet-5.5）也能比出最高版本', () => {
    const map = buildKiroModelMap([
      'auto', 'claude-haiku-4.5', 'claude-haiku-5.5', 'claude-opus-4.8', 'claude-opus-5', 'claude-opus-5.5',
      'claude-sonnet-4.6', 'claude-sonnet-5', 'claude-sonnet-5.5', 'glm-5',
    ]);
    expect(map?.alias).toEqual({
      opus: { id: 'claude-opus-5.5' }, sonnet: { id: 'claude-sonnet-5.5' }, haiku: { id: 'claude-haiku-5.5' },
    });
    expect(map?.extra?.map((m) => m.id)).toContain('claude-opus-5');
  });

  it('只有 fable 5-1 时只配 fable；版本按数字比较而不是字符串（4-10 > 4-9）', () => {
    expect(buildKiroModelMap(['claude-fable-5-1'])).toEqual({ alias: { fable: { id: 'claude-fable-5-1' } } });
    const m = buildKiroModelMap(['claude-sonnet-4-9', 'claude-sonnet-4-10']);
    expect(m?.alias?.sonnet?.id).toBe('claude-sonnet-4-10');
  });

  it('同版本带日期后缀的取日期最新的；没有可用模型返回 null', () => {
    const m = buildKiroModelMap(['claude-sonnet-4-5-20250101', 'claude-sonnet-4-5-20250929']);
    expect(m?.alias?.sonnet?.id).toBe('claude-sonnet-4-5-20250929');
    expect(buildKiroModelMap([])).toBeNull();
    expect(buildKiroModelMap(['claude-opus-4-5-thinking'])).toBeNull();
  });
});

describe('api-config 与 kiroChildEnv', () => {
  it('新格式 {method, credentialId, keyId} 往返，旧格式 {method, port} 仍可识别并原样写回', () => {
    const dir = path.join(root, 'acc-k1');
    writeApiConfig(dir, {
      baseUrl: 'http://127.0.0.1:19999',
      apiKey: 'proxy-key-123456',
      authType: 'apiKey',
      kiro: { method: 'builderId', credentialId: 3, keyId: 7 },
    });
    expect(readApiConfig(dir)?.kiro).toEqual({ method: 'builderId', credentialId: 3, keyId: 7 });
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'cosyee-api.json'), 'utf8')).kiro).toEqual({
      method: 'builderId',
      credentialId: 3,
      keyId: 7,
    });

    const old = path.join(root, 'acc-old');
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(
      path.join(old, 'cosyee-api.json'),
      JSON.stringify({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k-123456', authType: 'apiKey', kiro: { method: 'apiKey', port: 18080 } }),
    );
    expect(readApiConfig(old)?.kiro).toEqual({ method: 'apiKey', legacyPort: 18080 });
    writeApiConfig(old, readApiConfig(old)!);
    expect(JSON.parse(fs.readFileSync(path.join(old, 'cosyee-api.json'), 'utf8')).kiro).toEqual({ method: 'apiKey', port: 18080 });
  });

  it('kiroChildEnv 删除 KIRO_API_KEY', () => {
    const env = kiroChildEnv({ PATH: 'x', KIRO_API_KEY: 'ksk_must_not_leak', kiro_api_key: 'ksk_2' });
    expect(env.KIRO_API_KEY).toBeUndefined();
    expect(env.kiro_api_key).toBeUndefined();
    expect(env.PATH).toBe('x');
  });
});

describe('KiroProxyManager（单实例服务）', () => {
  function makeProxy(opts: { bin?: () => string | null; enabled?: () => boolean; server?: FakeKiroServer; accounts?: () => Array<{ id: string; dir: string; label: string }> } = {}) {
    const server = opts.server ?? new FakeKiroServer();
    const procs: FakeProc[] = [];
    const bins: string[] = [];
    const args: string[][] = [];
    const envs: NodeJS.ProcessEnv[] = [];
    const defaultBin = createFakeBin();
    const proxy = new KiroProxyManager({
      engine: { binaryPath: opts.bin ?? (() => defaultBin), isEnabled: opts.enabled ?? (() => true) },
      dataDir: serviceDir,
      listKiroAccounts: opts.accounts ?? (() => []),
      fetch: server.fetch,
      isPortFree: async () => true,
      pickFreePort: async () => 31000,
      readyPollMs: 5,
      readyTimeoutMs: 500,
      spawnProxy: (bin, a, env) => {
        const p = new FakeProc();
        procs.push(p);
        bins.push(bin);
        args.push(a);
        envs.push(env);
        return p as unknown as ChildProcess;
      },
    });
    return { proxy, server, procs, bins, args, envs };
  }

  it('start 创建 config.json（0600、两个不同的随机密钥）与空 credentials.json，只起一个进程，并发 / 重复调用幂等', async () => {
    const { proxy, procs, args, envs } = makeProxy();
    process.env.KIRO_API_KEY = 'ksk_must_not_leak';
    await Promise.all([proxy.start(), proxy.start()]);
    await proxy.start();
    expect(procs.length).toBe(1);

    const cfg = readKiroServiceConfig(serviceDir())!;
    expect(cfg.apiKey).not.toBe(cfg.adminApiKey);
    expect(args[0]).toEqual(['--config', kiroConfigPath(serviceDir()), '--credentials', kiroCredsPath(serviceDir())]);
    expect(JSON.parse(fs.readFileSync(kiroCredsPath(serviceDir()), 'utf8'))).toEqual([]);
    expect(JSON.parse(fs.readFileSync(kiroConfigPath(serviceDir()), 'utf8')).updateAutoApply).toBe(false);
    if (process.platform !== 'win32') {
      expect(fs.statSync(kiroConfigPath(serviceDir())).mode & 0o777).toBe(0o600);
    }
    expect(envs[0]!.KIRO_API_KEY).toBeUndefined();

    expect(proxy.serviceState()).toEqual({ proxy: 'ready', error: null });
    expect(proxy.baseUrl()).toBe(`http://127.0.0.1:${cfg.port}`);
    await proxy.stop();
  });

  it('stop 后状态为 stopped、进程被杀；kick 在后台重新启动', async () => {
    const { proxy, procs } = makeProxy();
    await proxy.start();
    await proxy.stop();
    expect(procs[0]!.killed).toBe(true);
    expect(proxy.serviceState().proxy).toBe('stopped');
    proxy.kick();
    await proxy.start();
    expect(procs.length).toBe(2);
    proxy.killSync();
    expect(proxy.isRunning()).toBe(false);
  });

  it('enabled=false 与没有引擎时 start / kick / claudeEnv 绝不启进程并给出明确错误', async () => {
    const off = makeProxy({ enabled: () => false });
    expect(() => off.proxy.kick()).toThrow(KIRO_SERVICE_STOPPED);
    await expect(off.proxy.start()).rejects.toThrow(KIRO_SERVICE_STOPPED);
    expect(off.procs.length).toBe(0);

    const none = makeProxy({ bin: () => null });
    expect(() => none.proxy.kick()).toThrow(KIRO_ENGINE_MISSING);
    await expect(none.proxy.start()).rejects.toThrow(KIRO_ENGINE_MISSING);
    expect(none.procs.length).toBe(0);

    const dir = path.join(root, 'acc-off');
    writeApiConfig(dir, { baseUrl: 'http://127.0.0.1:1', apiKey: 'k-123456', authType: 'apiKey', kiro: { method: 'apiKey', credentialId: 1, keyId: 1 } });
    setBeforeClaudeEnv(() => off.proxy.kick());
    expect(() => claudeEnv(dir)).toThrow(KIRO_SERVICE_STOPPED);
  });

  it('配置里的端口被真实占用时 start 换端口：写 config.json 并改写全部账号的 baseUrl，旧格式账号不动', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const occupied = (blocker.address() as AddressInfo).port;
    try {
      const server = new FakeKiroServer();
      const bin = createFakeBin();
      const dirA = path.join(root, 'acc-a');
      const dirB = path.join(root, 'acc-b');
      const dirLegacy = path.join(root, 'acc-legacy');
      for (const [d, id] of [[dirA, 1], [dirB, 2]] as const) {
        writeApiConfig(d, {
          baseUrl: `http://127.0.0.1:${occupied}`,
          apiKey: `client-key-${id}`,
          authType: 'apiKey',
          kiro: { method: 'apiKey', credentialId: id, keyId: id },
        });
      }
      fs.mkdirSync(dirLegacy, { recursive: true });
      fs.writeFileSync(
        path.join(dirLegacy, 'cosyee-api.json'),
        JSON.stringify({ baseUrl: 'http://127.0.0.1:19999', apiKey: 'legacy-k', authType: 'apiKey', kiro: { method: 'apiKey', port: 19999 } }),
      );
      const cfg0 = createServiceConfig(occupied);
      writeKiroServiceConfig(serviceDir(), cfg0);

      const procs: FakeProc[] = [];
      const proxy = new KiroProxyManager({
        // 不替换 isPortFree：走真实的端口检测
        engine: { binaryPath: () => bin, isEnabled: () => true },
        dataDir: serviceDir,
        fetch: server.fetch,
        readyPollMs: 5,
        readyTimeoutMs: 500,
        listKiroAccounts: () => [
          { id: 'a', dir: dirA, label: 'A' },
          { id: 'b', dir: dirB, label: 'B' },
          { id: 'l', dir: dirLegacy, label: 'L' },
        ],
        spawnProxy: () => {
          const p = new FakeProc();
          procs.push(p);
          return p as unknown as ChildProcess;
        },
      });
      await proxy.start();
      setBeforeClaudeEnv(() => proxy.kick());

      const env = claudeEnv(dirA);
      expect(procs.length).toBe(1);
      const cfg = readKiroServiceConfig(serviceDir())!;
      expect(cfg.port).not.toBe(occupied);
      expect(cfg.apiKey).toBe(cfg0.apiKey);
      expect(env.ANTHROPIC_BASE_URL).toBe(`http://127.0.0.1:${cfg.port}`);
      expect(env.ANTHROPIC_API_KEY).toBe('client-key-1');
      expect(readApiConfig(dirB)!.baseUrl).toBe(`http://127.0.0.1:${cfg.port}`);
      // 旧格式账号还没迁移，不改它
      expect(readApiConfig(dirLegacy)!.baseUrl).toBe('http://127.0.0.1:19999');
      await proxy.stop();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('进程启动后报端口被占用时，ready 用异步分配的新端口重试一次', async () => {
    const server = new FakeKiroServer();
    const procs: FakeProc[] = [];
    const bin = createFakeBin();
    const proxy = new KiroProxyManager({
      engine: { binaryPath: () => bin, isEnabled: () => true },
      dataDir: serviceDir,
      listKiroAccounts: () => [],
      // 第一个进程起不来（端口被别人占了），探测连不上；第二个进程起来后才有响应
      fetch: async (input, init) => {
        if (procs.length < 2) throw new Error('connect ECONNREFUSED');
        return server.fetch(input, init);
      },
      isPortFree: async () => true,
      pickFreePort: async () => 31234,
      readyPollMs: 5,
      readyTimeoutMs: 500,
      spawnProxy: () => {
        const p = new FakeProc();
        procs.push(p);
        if (procs.length === 1) {
          // 第一次启动：立刻报端口占用并退出
          setTimeout(() => {
            p.stderr.write('Error: Address already in use (os error 48)');
            setTimeout(() => p.exit(1), 2);
          }, 1);
        }
        return p as unknown as ChildProcess;
      },
    });
    await proxy.start();
    expect(procs.length).toBe(2);
    expect(readKiroServiceConfig(serviceDir())!.port).toBe(31234);
    expect(proxy.serviceState().proxy).toBe('ready');
    await proxy.stop();
  });

  it('引擎升级后：空闲时 restartIdle 换新版本，有执行中会话时保持 outdated', async () => {
    let cur = createFakeBin('kiro-v1');
    const { proxy, bins } = makeProxy({ bin: () => cur });
    await proxy.start();
    expect(proxy.isOutdated()).toBe(false);

    cur = createFakeBin('kiro-v2');
    expect(proxy.isOutdated()).toBe(true);
    await proxy.restartIdle(() => true);
    expect(proxy.isOutdated()).toBe(true);
    expect(bins.length).toBe(1);

    await proxy.restartIdle(() => false);
    expect(proxy.isOutdated()).toBe(false);
    expect(bins[bins.length - 1]).toBe(cur);
    await proxy.stop();
  });

  it('request 用管理密钥访问 Admin API（按需启动服务）；adminEndpoint 给出管理页面地址与密钥', async () => {
    const { proxy } = makeProxy();
    const r = await proxy.request('GET', '/credentials');
    expect(r.ok).toBe(true);
    expect((r.json as { total: number }).total).toBe(0);

    const ep = await proxy.adminEndpoint();
    expect(ep.url).toBe(`http://127.0.0.1:${proxy.port()}/admin`);
    expect(ep.key).toBe(readKiroServiceConfig(serviceDir())!.adminApiKey);

    await proxy.stop();
  });
});

describe('账号与内置服务的映射（添加、回滚、重新登录、移除、额度、模型）', () => {
  it('添加账号：分组 → 凭据 → 余额验证 → 客户端 Key → cosyee-api.json，不下发系统 Key', async () => {
    const h = makeHarness();
    const { id, dir } = await loginApiKey(h, 'ksk_valid_key_001', 'Key账号');
    const svc = readKiroServiceConfig(serviceDir())!;

    expect([...h.server.groups]).toEqual([id]);
    expect(h.server.creds.size).toBe(1);
    const cred = [...h.server.creds.values()][0]!;
    expect(cred.groups).toEqual([id]);
    expect(cred.body).toMatchObject({ authMethod: 'api_key', kiroApiKey: 'ksk_valid_key_001' });
    expect(h.server.keys.size).toBe(1);
    const key = [...h.server.keys.values()][0]!;
    expect(key.group).toBe(id);
    expect(key.name).toBe(`cosyee ${id}`);

    // 顺序：先分组，再凭据，再余额验证，最后客户端 Key
    const order = h.server.calls.filter((c) => /^(POST \/groups|POST \/credentials|GET \/credentials\/\d+\/balance|POST \/client-keys)$/.test(c));
    expect(order).toEqual(['POST /groups', 'POST /credentials', `GET /credentials/${cred.id}/balance`, 'POST /client-keys']);

    const api = readApiConfig(dir)!;
    expect(api.kiro).toEqual({ method: 'apiKey', credentialId: cred.id, keyId: key.id });
    expect(api.apiKey).toBe(key.key);
    expect(api.apiKey).not.toBe(svc.apiKey); // 系统 Key 绝不下发给账号
    expect(api.apiKey).not.toBe(svc.adminApiKey);
    expect(api.authType).toBe('apiKey');
    expect(api.baseUrl).toBe(`http://127.0.0.1:${svc.port}`);
    expect(api.models).toEqual({
      alias: { opus: { id: 'claude-opus-4-5' }, sonnet: { id: 'claude-sonnet-4-5' }, haiku: { id: 'claude-haiku-4-5' } },
    });
    expect(h.modelsChanged).toEqual([]); // 登录时写入映射不触发重置

    // 账号列表：有 kiro（含 models）、无 api，不含任何密钥
    const entry = h.accounts.list().list.find((x) => x.id === id)!;
    expect(entry.api).toBeUndefined();
    expect(entry.plan).toBe('Kiro');
    expect(entry.name).toBe('Key账号');
    expect(entry.kiro).toEqual({ method: 'apiKey', proxy: 'ready', error: null, credential: 'unknown', email: null, models: api.models });
    // 凭据状态读出来后变成 ok
    await h.kiro.loadCredentials();
    expect(h.accounts.list().list.find((x) => x.id === id)!.kiro?.credential).toBe('ok');
    const listJson = JSON.stringify(h.accounts.list());
    expect(listJson).not.toContain(key.key);
    expect(listJson).not.toContain('ksk_valid_key_001');
    expect(listJson).not.toContain(svc.adminApiKey);

    // saveApi 不允许修改 Kiro 账号
    await expect(h.accounts.saveApi({ id, baseUrl: 'https://x.test', apiKey: 'sk-1' })).rejects.toThrow('Kiro');
    await h.kiro.dispose();
  });

  it('两个账号各有独立的分组、凭据与 Key，Key 只能用自己分组的凭据', async () => {
    const h = makeHarness();
    const a = await loginApiKey(h, 'ksk_acc_a_0001');
    const b = await loginApiKey(h, 'ksk_acc_b_0001');
    expect(h.server.groups.size).toBe(2);
    expect(h.server.creds.size).toBe(2);
    expect(readApiConfig(a.dir)!.apiKey).not.toBe(readApiConfig(b.dir)!.apiKey);
    expect(readApiConfig(a.dir)!.kiro).not.toEqual(readApiConfig(b.dir)!.kiro);
    expect(readApiConfig(a.dir)!.baseUrl).toBe(readApiConfig(b.dir)!.baseUrl);
    await h.kiro.dispose();
  });

  it('builderId 设备码流程（authorization_pending → slow_down → 成功），凭据按 idc 写入服务，不泄露令牌', async () => {
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
          return new Response(JSON.stringify({ accessToken: 'at_secret_val', refreshToken: 'rt_secret_val', expiresIn: 3600 }), { status: 200 });
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

    const listJson = JSON.stringify(h.accounts.list());
    for (const s of ['at_secret_val', 'rt_secret_val', 'csec_super_secret']) expect(listJson).not.toContain(s);
    const entry = h.accounts.list().list.find((x) => x.id === final.accountId)!;
    expect(entry.name).toBe('我的 Kiro');
    expect(entry.kiro).toMatchObject({ method: 'builderId', proxy: 'ready', error: null });

    const cred = [...h.server.creds.values()][0]!;
    expect(cred.body).toMatchObject({ authMethod: 'idc', refreshToken: 'rt_secret_val', clientId: 'cid_1', clientSecret: 'csec_super_secret' });
    expect(cred.groups).toEqual([final.accountId]);
    expect(readApiConfig(h.accounts.dirFor(final.accountId!)!)!.kiro).toMatchObject({ method: 'builderId', credentialId: cred.id });
    await h.kiro.dispose();
  });

  it('kiroIde 导入（IdC 带 40 位 hex clientIdHash）不修改源文件；非法 hash 被拒绝且不留目录和服务数据', async () => {
    const cacheDir = path.join(tmp, 'sso-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const hash = '1'.repeat(40);
    const tokFile = path.join(cacheDir, 'kiro-auth-token.json');
    const origTok = JSON.stringify({
      refreshToken: 'ide_rt_1',
      accessToken: 'ide_at_1',
      expiresAt: '2099-01-01T00:00:00Z',
      authMethod: 'IdC',
      clientIdHash: hash,
      region: 'us-east-1',
    });
    fs.writeFileSync(tokFile, origTok);
    fs.writeFileSync(path.join(cacheDir, `${hash}.json`), JSON.stringify({ clientId: 'ide_cid', clientSecret: 'ide_csec' }));

    const h = makeHarness({ ideTokenFile: tokFile });
    expect(h.kiro.status().imports.kiroIde).toBe(true);
    const job = h.kiro.startLogin({ method: 'kiroIde' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job.loginId).status).toBe('done');
    expect(fs.readFileSync(tokFile, 'utf8')).toBe(origTok);
    expect([...h.server.creds.values()][0]!.body).toMatchObject({ authMethod: 'idc', clientId: 'ide_cid', refreshToken: 'ide_rt_1' });

    fs.writeFileSync(tokFile, JSON.stringify({ refreshToken: 'ide_rt_2', authMethod: 'IdC', clientIdHash: '../evil' }));
    const beforeDirs = fs.readdirSync(root);
    const job2 = h.kiro.startLogin({ method: 'kiroIde' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job2.loginId).status).toBe('failed');
    expect(fs.readdirSync(root)).toEqual(beforeDirs);
    expect(h.server.creds.size).toBe(1);
    await h.kiro.dispose();
  });

  it('kiroCli 只读导入临时 SQLite（social），不修改数据库', async () => {
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
    expect(h.kiro.getLogin(job.loginId).status).toBe('done');
    expect([...h.server.creds.values()][0]!.body).toMatchObject({
      authMethod: 'social',
      refreshToken: 'cli_rt_1',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/abc',
    });
    await h.kiro.dispose();
  });

  it('未安装引擎或总开关关闭时直接返回 409', () => {
    const hNoEngine = makeHarness({ binPath: null });
    expect(() => hNoEngine.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_12345678' })).toThrow(KIRO_ENGINE_MISSING);
    const hOff = makeHarness();
    hOff.kiro.engine.setEnabled(false);
    expect(() => hOff.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_12345678' })).toThrow(KIRO_SERVICE_STOPPED);
  });

  it('回滚：apiKey 余额验证失败 → 服务里的凭据与分组被删，不留目录，错误脱敏', async () => {
    const h = makeHarness();
    h.server.balanceFail = () => true;
    const before = fs.readdirSync(root);
    const job = h.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_leaked_secret_xyz' });
    await h.kiro.login.waitForLogin();
    const st = h.kiro.getLogin(job.loginId);
    expect(st.status).toBe('failed');
    expect(st.error).not.toContain('ksk_leaked_secret_xyz');
    expect(h.server.creds.size).toBe(0);
    expect(h.server.keys.size).toBe(0);
    expect(h.server.groups.size).toBe(0);
    expect(fs.readdirSync(root)).toEqual(before);
    expect(h.accounts.listKiroAccounts()).toEqual([]);
    await h.kiro.dispose();
  });

  it('回滚：服务拒绝凭据（刷新失败）→ 分组被删，错误不含令牌', async () => {
    const h = makeHarness();
    h.server.addFail = () => 'refresh failed for refreshToken=secret_tok_123';
    const job = h.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_whatever_001' });
    await h.kiro.login.waitForLogin();
    const st = h.kiro.getLogin(job.loginId);
    expect(st.status).toBe('failed');
    expect(st.error).not.toContain('secret_tok_123');
    expect(h.server.groups.size).toBe(0);
    expect(h.server.creds.size).toBe(0);
    await h.kiro.dispose();
  });

  it('回滚：创建客户端 Key 失败 → 凭据与分组被删', async () => {
    const h = makeHarness();
    h.server.keyFail = true;
    const job = h.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_key_step_001' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job.loginId).status).toBe('failed');
    expect(h.server.creds.size).toBe(0);
    expect(h.server.groups.size).toBe(0);
    expect(h.accounts.listKiroAccounts()).toEqual([]);
    await h.kiro.dispose();
  });

  it('同一份凭据已属于另一个账号：新账号失败，不动原账号的凭据，只回滚自己新建的分组', async () => {
    const h = makeHarness();
    const a = await loginApiKey(h, 'ksk_shared_key_01');
    const job = h.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_shared_key_01' });
    await h.kiro.login.waitForLogin();
    const st = h.kiro.getLogin(job.loginId);
    expect(st.status).toBe('failed');
    expect(st.error).toContain('这个 Kiro 账号已经添加过了');
    expect(h.server.creds.size).toBe(1);
    expect(h.server.keys.size).toBe(1);
    expect([...h.server.groups]).toEqual([a.id]);
    await h.kiro.dispose();
  });

  it('登录被取消：服务里不留数据', async () => {
    const h = makeHarness();
    h.server.balanceFail = () => true;
    const job = h.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_cancel_me_01' });
    h.kiro.cancelLogin(job.loginId);
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job.loginId).status).not.toBe('done');
    expect(h.server.creds.size).toBe(0);
    expect(h.server.groups.size).toBe(0);
    expect(h.accounts.listKiroAccounts()).toEqual([]);
    await h.kiro.dispose();
  });

  it('重新登录：新凭据加入同一分组，旧凭据删除，客户端 Key 不变，其他字段保持', async () => {
    const h = makeHarness();
    const { id, dir } = await loginApiKey(h, 'ksk_first_key_001');
    const before = readApiConfig(dir)!;
    const oldId = (before.kiro as { credentialId: number }).credentialId;

    const job = h.kiro.startLogin({ method: 'apiKey', accountId: id, apiKey: 'ksk_second_key_002' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job.loginId).status).toBe('done');

    const after = readApiConfig(dir)!;
    const newId = (after.kiro as { credentialId: number }).credentialId;
    expect(newId).not.toBe(oldId);
    expect((after.kiro as { keyId: number }).keyId).toBe((before.kiro as { keyId: number }).keyId);
    expect(after.apiKey).toBe(before.apiKey);
    expect(after.baseUrl).toBe(before.baseUrl);
    expect(after.models).toEqual(before.models);
    expect([...h.server.creds.keys()]).toEqual([newId]);
    expect(h.server.creds.get(newId)!.groups).toEqual([id]);
    expect(h.server.creds.get(newId)!.body.kiroApiKey).toBe('ksk_second_key_002');
    expect(h.server.keys.size).toBe(1);
    expect(h.server.groups.size).toBe(1);
    await h.kiro.dispose();
  });

  it('重新登录失败：新凭据被删，旧凭据与配置原样保留；有执行中会话时 409', async () => {
    const h = makeHarness();
    const { id, dir } = await loginApiKey(h, 'ksk_valid_key_001');
    const origCfg = fs.readFileSync(path.join(dir, 'cosyee-api.json'), 'utf8');
    const origCreds = [...h.server.creds.keys()];

    h.runningMap.set(id, 1);
    expect(() => h.kiro.startLogin({ method: 'apiKey', accountId: id, apiKey: 'ksk_valid_key_002' })).toThrow('正在执行');
    h.runningMap.set(id, 0);

    h.server.balanceFail = (c) => c.body.kiroApiKey === 'ksk_bad_relogin_999';
    const job = h.kiro.startLogin({ method: 'apiKey', accountId: id, apiKey: 'ksk_bad_relogin_999' });
    await h.kiro.login.waitForLogin();
    const st = h.kiro.getLogin(job.loginId);
    expect(st.status).toBe('failed');
    expect(st.error).not.toContain('ksk_leaked_secret_xyz');
    expect([...h.server.creds.keys()]).toEqual(origCreds);
    expect(fs.readFileSync(path.join(dir, 'cosyee-api.json'), 'utf8')).toBe(origCfg);
    expect(h.accounts.listKiroAccounts().map((a) => a.id)).toEqual([id]);
    await h.kiro.dispose();
  });

  it('重新登录用服务里已存在的同一份凭据：视为成功，凭据与 Key 都不变', async () => {
    const h = makeHarness();
    const { id, dir } = await loginApiKey(h, 'ksk_same_key_0001');
    const before = fs.readFileSync(path.join(dir, 'cosyee-api.json'), 'utf8');
    const job = h.kiro.startLogin({ method: 'apiKey', accountId: id, apiKey: 'ksk_same_key_0001' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job.loginId).status).toBe('done');
    expect(fs.readFileSync(path.join(dir, 'cosyee-api.json'), 'utf8')).toBe(before);
    expect(h.server.creds.size).toBe(1);
    await h.kiro.dispose();
  });

  it('同一个登录邮箱不能添加两次；重新登录成别的已添加账号时拒绝，原凭据不动', async () => {
    const h = makeHarness();
    h.server.emailOf = (b) => (String(b.kiroApiKey).includes('_a_') ? 'Same@Example.com' : 'other@example.com');
    const a = await loginApiKey(h, 'ksk_acc_a_0001');
    const b = await loginApiKey(h, 'ksk_acc_b_0001');
    const credsBefore = [...h.server.creds.keys()];

    // 同邮箱（大小写不同）的另一份凭据：失败，服务里新建的分组 / 凭据 / Key 全部回滚，不留目录
    const job = h.kiro.startLogin({ method: 'apiKey', apiKey: 'ksk_acc_a_0002' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job.loginId)).toMatchObject({ status: 'failed', error: '这个 Kiro 账号已经添加过了' });
    expect([...h.server.creds.keys()]).toEqual(credsBefore);
    expect(h.server.groups.size).toBe(2);
    expect(h.server.keys.size).toBe(2);
    expect(h.accounts.listKiroAccounts().map((x) => x.id).sort()).toEqual([a.id, b.id].sort());

    // 账号 b 重新登录成了 a 的邮箱：拒绝，b 的旧凭据和配置不变
    const cfgB = fs.readFileSync(path.join(b.dir, 'cosyee-api.json'), 'utf8');
    const job2 = h.kiro.startLogin({ method: 'apiKey', accountId: b.id, apiKey: 'ksk_acc_a_0003' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job2.loginId).status).toBe('failed');
    expect(h.kiro.getLogin(job2.loginId).error).toContain('已经添加过了');
    expect([...h.server.creds.keys()]).toEqual(credsBefore);
    expect(fs.readFileSync(path.join(b.dir, 'cosyee-api.json'), 'utf8')).toBe(cfgB);

    // 自己用同一个邮箱重新登录可以
    const job3 = h.kiro.startLogin({ method: 'apiKey', accountId: a.id, apiKey: 'ksk_acc_a_0004' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job3.loginId).status).toBe('done');
    await h.kiro.dispose();
  });

  it('历史重复的 Kiro 账号（同一邮箱）：列表隐藏后来的，按类型计数，dedupe 删掉它在服务里的数据', async () => {
    const h = makeHarness();
    const a = await loginApiKey(h, 'ksk_acc_a_0001');
    const b = await loginApiKey(h, 'ksk_acc_b_0001');
    const c = await loginApiKey(h, 'ksk_acc_c_0001');
    // 绕过添加时的检查，直接造出同邮箱的两个账号（老版本留下的）
    for (const [x, email] of [[a, 'dup@example.com'], [b, 'DUP@example.com'], [c, 'c@example.com']] as const) {
      const cfg = readApiConfig(x.dir)!;
      writeApiConfig(x.dir, { ...cfg, kiro: { ...cfg.kiro!, email } as typeof cfg.kiro });
    }
    const l = h.accounts.list();
    expect(l.list.filter((x) => x.kiro).map((x) => x.id)).toEqual([a.id, c.id]);
    expect(l.duplicates).toBe(1);
    expect(l.duplicateKinds).toEqual({ kiro: 1 });
    expect(h.accounts.kiroEmailTaken('dup@EXAMPLE.com')).toBe(true);
    expect(h.accounts.kiroEmailTaken('c@example.com', c.id)).toBe(false);

    const bCred = (readApiConfig(b.dir)!.kiro as { credentialId: number }).credentialId;
    expect(await h.accounts.dedupe()).toEqual({ removed: 1, skipped: 0 });
    expect(h.server.creds.has(bCred)).toBe(false);
    expect(h.server.groups.has(b.id)).toBe(false);
    expect(fs.existsSync(b.dir)).toBe(false);
    expect(h.accounts.list().duplicates).toBeUndefined();
    await h.kiro.dispose();
  });

  it('移除账号：删除服务里的凭据、Key 和分组（force），不影响其他账号，并删除账号目录', async () => {
    const h = makeHarness();
    const a = await loginApiKey(h, 'ksk_acc_a_0001');
    const b = await loginApiKey(h, 'ksk_acc_b_0001');
    const keyB = readApiConfig(b.dir)!.kiro as { credentialId: number; keyId: number };

    await h.accounts.remove(a.id);
    expect(fs.existsSync(a.dir)).toBe(false);
    expect([...h.server.groups]).toEqual([b.id]);
    expect([...h.server.creds.keys()]).toEqual([keyB.credentialId]);
    expect([...h.server.keys.keys()]).toEqual([keyB.keyId]);
    expect(h.server.callsOf('DELETE /groups/')).toEqual([`DELETE /groups/${a.id}`]);

    await h.accounts.remove(b.id);
    expect(h.server.groups.size + h.server.creds.size + h.server.keys.size).toBe(0);
    await h.kiro.dispose();
  });

  it('移除账号时服务已关闭：账号仍被移除，清理失败只记日志', async () => {
    const h = makeHarness();
    const { id, dir } = await loginApiKey(h, 'ksk_acc_off_0001');
    await h.kiro.stopService(true);
    await h.accounts.remove(id);
    expect(fs.existsSync(dir)).toBe(false);
    expect(h.logs.some((l) => l.includes('无法清理'))).toBe(true);
    expect(h.server.creds.size).toBe(1); // 已知局限：服务关闭时凭据留在服务里
    await h.kiro.dispose();
  });

  it('额度：从服务读取并换算重置时间；凭据不在服务里时给出重新登录提示', async () => {
    const h = makeHarness();
    const { id } = await loginApiKey(h, 'ksk_valid_key_001');
    expect(await h.kiro.balance(id)).toEqual({ subscription: 'KIRO PRO', used: 12.5, limit: 500, resetsAt: 1700000000500 });

    h.server.creds.clear();
    await expect(h.kiro.balance(id)).rejects.toThrow('重新登录');
    await h.kiro.dispose();
  });

  it('邮箱：查额度时从服务同步进账号，列表显示为标题并刷新；读不到时保留旧值', async () => {
    const h = makeHarness();
    const { id, dir } = await loginApiKey(h, 'ksk_valid_key_001');
    expect(h.accounts.list().list.find((x) => x.id === id)!.name).toBe('Kiro');
    await h.kiro.loadCredentials();
    const before = h.changes.length;

    const cred = [...h.server.creds.values()][0]!;
    cred.email = 'kiro.user@example.com';
    await h.kiro.balance(id);
    expect((readApiConfig(dir)!.kiro as { email?: string }).email).toBe('kiro.user@example.com');
    const entry = h.accounts.list().list.find((x) => x.id === id)!;
    expect(entry.name).toBe('kiro.user@example.com');
    expect(entry.kiro?.email).toBe('kiro.user@example.com');
    expect(h.changes.slice(before)).toEqual([{ notify: 'refresh' }]);

    // 没变化不再通知；服务里暂时没有邮箱时保留旧值
    await h.kiro.balance(id);
    delete cred.email;
    await h.kiro.balance(id);
    expect(h.changes.length).toBe(before + 1);
    expect((readApiConfig(dir)!.kiro as { email?: string }).email).toBe('kiro.user@example.com');
    await h.kiro.dispose();
  });

  it('额度查询失败返回脱敏的 502', async () => {
    const h = makeHarness();
    const { id } = await loginApiKey(h, 'ksk_valid_key_001');
    h.server.balanceFail = () => true;
    const err = await h.kiro.balance(id).catch((e: Error & { status?: number }) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as { status?: number }).status).toBe(502);
    expect((err as Error).message).not.toContain('ksk_leaked_secret_xyz');
    await h.kiro.dispose();
  });

  it('刷新模型：有变化时写回映射并通知；无变化不通知；拉取失败保留旧映射', async () => {
    const h = makeHarness();
    const { id, dir } = await loginApiKey(h, 'ksk_valid_key_001');
    const first = readApiConfig(dir)!.models;
    expect(await h.kiro.refreshModels(id)).toBe(false);
    expect(h.modelsChanged).toEqual([]);

    h.server.models = ['claude-sonnet-4-5', 'claude-sonnet-4-6', 'claude-sonnet-4-6-thinking', 'claude-fable-5-1', 'claude-opus-4-5'];
    expect(await h.kiro.refreshModels(id)).toBe(true);
    expect(h.modelsChanged).toEqual([id]);
    expect(readApiConfig(dir)!.models).toEqual({
      alias: { opus: { id: 'claude-opus-4-5' }, sonnet: { id: 'claude-sonnet-4-6' }, fable: { id: 'claude-fable-5-1' } },
      extra: [{ id: 'claude-sonnet-4-5' }],
    });

    const second = readApiConfig(dir)!.models;
    h.server.modelsStatus = 500;
    h.server.models = ['claude-haiku-4-5'];
    expect(await h.kiro.refreshModels(id)).toBe(false);
    expect(readApiConfig(dir)!.models).toEqual(second);
    expect(second).not.toEqual(first);
    expect(h.logs.some((l) => l.includes('刷新 Kiro 模型列表失败'))).toBe(true);
    expect(h.modelsChanged).toEqual([id]);
    await h.kiro.dispose();
  });
});

describe('随 cosyee 启动与账号凭据状态', () => {
  it('init：装了 kiro.rs 且没手动停止时直接启动服务（不管有没有账号）；手动停止后 init 不启动', async () => {
    const h = makeHarness();
    h.kiro.init();
    await h.kiro.proxy.start();
    expect(h.spawned.length).toBe(1);
    expect(h.kiro.componentService()).toMatchObject({ state: 'ready', enabled: true, accounts: { total: 0, usable: 0 } });
    await h.kiro.stopService(false);
    await h.kiro.dispose();

    const h2 = makeHarness();
    h2.kiro.init();
    await new Promise((r) => setTimeout(r, 20));
    expect(h2.spawned.length).toBe(0);
    expect(h2.kiro.componentService().state).toBe('stopped');
    await h2.kiro.startService();
    expect(h2.spawned.length).toBe(1);
    await h2.kiro.dispose();
  });

  it('凭据状态：QuotaExceeded → quota，其它禁用 → disabled，服务里没有 → missing；变化时刷新账号列表', async () => {
    const h = makeHarness();
    const a = await loginApiKey(h, 'ksk_state_a_0001', 'A');
    const b = await loginApiKey(h, 'ksk_state_b_0001', 'B');
    const c = await loginApiKey(h, 'ksk_state_c_0001', 'C');
    const d = await loginApiKey(h, 'ksk_state_d_0001', 'D');
    const credOf = (dir: string) => h.server.creds.get((readApiConfig(dir)!.kiro as { credentialId: number }).credentialId)!;
    credOf(b.dir).disabled = true;
    credOf(b.dir).disabledReason = 'QuotaExceeded';
    credOf(c.dir).disabled = true;
    credOf(c.dir).disabledReason = 'TooManyFailures';
    h.server.creds.delete((readApiConfig(d.dir)!.kiro as { credentialId: number }).credentialId);

    h.changes.length = 0;
    await h.kiro.loadCredentials();
    expect(h.kiro.accountState(a.id, a.dir)).toMatchObject({ proxy: 'ready', credential: 'ok' });
    expect(h.kiro.accountState(b.id, b.dir)).toMatchObject({ credential: 'quota', credentialReason: 'QuotaExceeded' });
    expect(h.kiro.accountState(c.id, c.dir)).toMatchObject({ credential: 'disabled', credentialReason: 'TooManyFailures' });
    expect(h.kiro.accountState(d.id, d.dir)).toMatchObject({ credential: 'missing' });
    expect(h.kiro.componentService().accounts).toEqual({ total: 4, usable: 1 });
    expect(h.kiro.serviceStatus().usable).toBe(1);
    expect(h.changes.length).toBeGreaterThan(0);

    const kb = h.accounts.list().list.find((x) => x.id === b.id)!;
    expect(kb.kiro).toMatchObject({ credential: 'quota', credentialReason: 'QuotaExceeded' });

    // 没变化时不再通知
    h.changes.length = 0;
    await h.kiro.loadCredentials();
    expect(h.changes.length).toBe(0);

    // 服务停了：状态未知
    await h.kiro.stopService(true);
    expect(h.kiro.accountState(a.id, a.dir)).toMatchObject({ proxy: 'stopped', credential: 'unknown' });
    await h.kiro.dispose();
  });
});

describe('旧格式（每账号一个进程）账号', () => {
  const idcCred = { authMethod: 'builder-id', refreshToken: 'legacy_rt_1', accessToken: 'legacy_at', clientId: 'legacy_cid', clientSecret: 'legacy_csec', region: 'us-east-1' };

  it('旧格式账号：额度查询提示重新登录；重新登录等同于重新添加并归档旧目录', async () => {
    const h = makeHarness();
    const dir = makeLegacyAccount(h, 'legacy2', idcCred, 'apiKey');
    await expect(h.kiro.balance('legacy2')).rejects.toThrow('请重新登录');

    const job = h.kiro.startLogin({ method: 'apiKey', accountId: 'legacy2', apiKey: 'ksk_relogin_legacy' });
    await h.kiro.login.waitForLogin();
    expect(h.kiro.getLogin(job.loginId).status).toBe('done');
    const api = readApiConfig(dir)!;
    expect('credentialId' in api.kiro!).toBe(true);
    expect(fs.existsSync(path.join(dir, 'kiro'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'kiro.migrated'))).toBe(true);
    expect([...h.server.creds.values()][0]!.body.kiroApiKey).toBe('ksk_relogin_legacy');
    await h.kiro.dispose();
  });

  it('移除尚未迁移的旧格式账号不碰服务', async () => {
    const h = makeHarness();
    const dir = makeLegacyAccount(h, 'legacy3', idcCred);
    await h.accounts.remove('legacy3');
    expect(fs.existsSync(dir)).toBe(false);
    expect(h.server.calls).toEqual([]);
    await h.kiro.dispose();
  });
});

describe('HTTP /api/kiro 与 /api/components/kiro 路由（含 HTTP/1.0 无请求体、fromLocal 限制、服务启停）', () => {
  it('覆盖 kiro 端点与组件启停，HTTP/1.0 无 Origin 响应无 chunked/gzip，远程 403，忙会话 409', async () => {
    const h = makeHarness();
    // 先建一个 Kiro 账号
    const { id: accId } = await loginApiKey(h, 'ksk_http_test_001');

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
      components: new ComponentUpdater({ adapters: [createKiroAdapter(h.kiro)], home: () => home }),
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

      // 2. 远程请求（带 Tailscale-User-Login 头）调 update 与 stop 返回 403；旧接口已删除
      expect((await fetch(`http://127.0.0.1:${port}/api/kiro/engine/build`, { method: 'POST' })).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/api/kiro/service/stop`, { method: 'POST' })).status).toBe(404);
      const remoteBuild = await fetch(`http://127.0.0.1:${port}/api/components/kiro/update`, {
        method: 'POST',
        headers: { 'tailscale-user-login': 'alice@example.com' },
      });
      expect(remoteBuild.status).toBe(403);
      const remoteStop = await fetch(`http://127.0.0.1:${port}/api/components/kiro/stop`, {
        method: 'POST',
        headers: { 'tailscale-user-login': 'alice@example.com' },
      });
      expect(remoteStop.status).toBe(403);

      // 3. 有执行中 Kiro 会话时 stop 不带 force 返回 409 { error, running }
      h.runningMap.set(accId, 2);
      const busyStop = await fetch(`http://127.0.0.1:${port}/api/components/kiro/stop`, { method: 'POST' });
      expect(busyStop.status).toBe(409);
      const busyBody = await busyStop.json();
      expect(busyBody.running).toBe(2);

      // 4. 原生 TCP HTTP/1.0 POST /api/components/kiro/stop?force=1（Content-Length: 0、无 Origin）
      const rawResp = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            `POST /api/components/kiro/stop?force=1 HTTP/1.0\r\n` +
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
      expect(parsed.id).toBe('kiro');
      expect(parsed.service).toMatchObject({ enabled: false, state: 'stopped' });
      h.runningMap.clear();

      // 5. POST /api/components/kiro/start 重新打开并启动服务，等就绪后返回；凭据状态读出来了
      const startRes = await fetch(`http://127.0.0.1:${port}/api/components/kiro/start`, { method: 'POST' });
      expect(startRes.status).toBe(200);
      const startBody = await startRes.json();
      expect(startBody.service).toMatchObject({ enabled: true, state: 'ready', accounts: { total: 1, usable: 1 } });
      const listed = await (await fetch(`http://127.0.0.1:${port}/api/components`)).json();
      expect(listed.list.map((c: { id: string }) => c.id)).toEqual(['kiro']);
      // GET /api/kiro 绝不包含 adminApiKey
      const cfg = readKiroServiceConfig(serviceDir())!;
      expect(JSON.stringify(startBody)).not.toContain(cfg.adminApiKey);
      expect(JSON.stringify(startBody)).not.toContain(cfg.apiKey);

      // 6. POST /api/kiro/service/admin：带 Origin 或 Sec-Fetch-Site/Mode 的网页请求一律 403
      const originAdmin = await fetch(`http://127.0.0.1:${port}/api/kiro/service/admin`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      expect(originAdmin.status).toBe(403);
      const fetchSiteAdmin = await fetch(`http://127.0.0.1:${port}/api/kiro/service/admin`, {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
      });
      expect(fetchSiteAdmin.status).toBe(403);
      const fetchModeAdmin = await fetch(`http://127.0.0.1:${port}/api/kiro/service/admin`, {
        method: 'POST',
        headers: { 'sec-fetch-mode': 'cors' },
      });
      expect(fetchModeAdmin.status).toBe(403);

      // 本机原生 HTTP/1.0 请求 POST /api/kiro/service/admin 成功返回 { url, key } 且 Cache-Control: no-store
      const adminRaw = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => {
          sock.write(
            `POST /api/kiro/service/admin HTTP/1.0\r\n` +
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

      // 7. 模拟管理页面改写了 credentials.json：重启服务绝不覆盖它
      const credsFile = kiroCredsPath(serviceDir());
      const refreshedCreds = JSON.stringify([{ authMethod: 'api_key', kiroApiKey: 'ksk_updated_in_admin_ui' }]);
      fs.writeFileSync(credsFile, refreshedCreds);
      await h.kiro.restartService(true);
      expect(fs.readFileSync(credsFile, 'utf8')).toBe(refreshedCreds);
      expect(h.spawned.length).toBe(3); // 登录时一次、stop 后 start 一次、restart 一次
      expect(h.spawned[2]!.args).toEqual(['--config', kiroConfigPath(serviceDir()), '--credentials', credsFile]);

      // 8. 凭据在服务里被删掉时，查询余额给出明确 409 提示而非崩溃
      h.server.creds.clear();
      const missing = await fetch(`http://127.0.0.1:${port}/api/kiro/balance?account=${accId}`);
      expect(missing.status).toBe(409);
      expect((await missing.json()).error).toContain('重新登录');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
      await h.kiro.dispose();
    }
  });
});
