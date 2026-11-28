// 子代理账号（服务端）：持久化迁移与 sanitize、HTTP 接口、子代理配置空间隔离与共享链接、
// 双向较新者胜凭据同步（含主空间登录中保护与 macOS 钥匙串 mock）、账号移除清理、ClaudeBackend 目录与环境。
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeApiConfig } from './accounts/api-config.js';
import { Accounts, DEFAULT_ID } from './accounts/index.js';
import { SUBAGENT_SHARED_DIRS, SUBAGENT_SHARED_FILES } from './accounts/links.js';
import {
  isNewerCred,
  keychainServiceFor,
  macKeychainServiceName,
  prepareSubagentSpace,
  removeSubagentSpace,
  syncSubagentToMain,
  type KeychainAdapter,
} from './accounts/subagent-space.js';
import { claudeEnv, credStorageDirFor, setBeforeClaudeEnv } from './claude/bin.js';
import { BackendError } from './delegate/backend.js';
import { ClaudeBackend } from './delegate/claudeBackend.js';
import { createHandler } from './http.js';
import { setActiveConfigDir, subagentAccountDir } from './paths.js';
import { StateStore, Workspaces } from './workspaces.js';

let tmp: string;
let base: string;
let root: string;
let subRoot: string;
let cosyeeDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-subacc-'));
  base = path.join(tmp, 'claude');
  root = path.join(tmp, 'accounts');
  subRoot = path.join(tmp, 'subagents');
  cosyeeDir = path.join(tmp, 'cosyee');
  fs.mkdirSync(base, { recursive: true });
  for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_ACCOUNTS_DIR', 'COSYEE_SUBAGENT_ACCOUNTS_DIR', 'COSYEE_HOME']) {
    saved[k] = process.env[k];
  }
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.COSYEE_ACCOUNTS_DIR = root;
  process.env.COSYEE_SUBAGENT_ACCOUNTS_DIR = subRoot;
  process.env.COSYEE_HOME = cosyeeDir;
  setActiveConfigDir(null);
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

const writeJson = (f: string, j: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
};
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

function writeLoginFiles(
  dir: string,
  uuid: string,
  name: string,
  opts: { expiresAt?: number; refreshToken?: string; extraClaudeJson?: Record<string, unknown> } = {},
) {
  writeJson(path.join(dir, '.credentials.json'), {
    claudeAiOauth: {
      accessToken: `acc-${name}-${opts.expiresAt ?? 1000}`,
      refreshToken: opts.refreshToken ?? `ref-${name}`,
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      subscriptionType: 'pro',
    },
  });
  writeJson(path.join(dir, '.claude.json'), {
    oauthAccount: { accountUuid: uuid, displayName: name, emailAddress: `${name}@x.test` },
    lastOnboardingVersion: '2.1.332',
    numStartups: 42,
    tipsHistory: { tipA: 3 },
    projects: { '/some/repo': { lastCost: 12 } },
    ...(opts.extraClaudeJson ?? {}),
  });
}

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 12345;
  exit(code: number) {
    this.exitCode = code;
    this.emit('close', code, null);
  }
  kill() {
    this.exit(1);
    return true;
  }
}

function makeAccounts(opts: { subagentSpace?: Parameters<typeof prepareSubagentSpace>[2] } = {}) {
  const store = new StateStore(path.join(tmp, 'state.json'));
  const events: string[] = [];
  let proc: FakeProc | null = null;
  let env: NodeJS.ProcessEnv | null = null;
  const accounts = new Accounts({
    store,
    running: () => 0,
    processes: () => 0,
    stop: async () => {
      events.push('stop');
    },
    onChanged: (e) => {
      if (e.reset) events.push(`reset:${e.reset}`);
      if (e.notify) events.push(e.notify);
    },
    spawnLogin: (e) => {
      env = e;
      proc = new FakeProc();
      return proc as unknown as ChildProcess;
    },
    subagentSpace: opts.subagentSpace,
  });
  accounts.init();
  return { store, accounts, events, proc: () => proc!, env: () => env! };
}

function addClaudeAccount(
  a: ReturnType<typeof makeAccounts>,
  uuid: string,
  name: string,
  opts: { label?: string; expiresAt?: number; refreshToken?: string } = {},
) {
  const login = a.accounts.startLogin({ label: opts.label ?? '' });
  const dir = a.env().CLAUDE_CONFIG_DIR!;
  writeLoginFiles(dir, uuid, name, { expiresAt: opts.expiresAt, refreshToken: opts.refreshToken });
  a.proc().exit(0);
  return { id: a.accounts.getLogin(login.loginId).accountId!, dir };
}

describe('StateStore 迁移与 sanitize（accounts.subagent）', () => {
  it('老数据没有 subagent 时迁移为当时的 active 账号；active 为 null 时为 default', () => {
    const file = path.join(tmp, 'state-migrate.json');
    const dirA = path.join(root, 'acc001');
    writeJson(file, {
      accounts: {
        list: [{ id: 'acc001', label: 'A', dir: dirA, createdAt: 1 }],
        active: 'acc001',
        mode: 'switch',
        sessions: {},
      },
    });
    const store1 = new StateStore(file);
    expect(store1.state.accounts.subagent).toEqual({ claude: 'acc001' });

    const file2 = path.join(tmp, 'state-migrate-default.json');
    writeJson(file2, {
      accounts: {
        list: [{ id: 'acc001', label: 'A', dir: dirA, createdAt: 1 }],
        active: null,
        mode: 'switch',
        sessions: {},
      },
    });
    const store2 = new StateStore(file2);
    expect(store2.state.accounts.subagent).toEqual({ claude: 'default' });
  });

  it('subagent.claude 指向不存在的账号 id 时退回 default；存在时保留', () => {
    const file = path.join(tmp, 'state-sanitize.json');
    const dirA = path.join(root, 'acc001');
    writeJson(file, {
      accounts: {
        list: [{ id: 'acc001', label: 'A', dir: dirA, createdAt: 1 }],
        active: null,
        mode: 'switch',
        sessions: {},
        subagent: { claude: 'ghost99' },
      },
    });
    expect(new StateStore(file).state.accounts.subagent).toEqual({ claude: 'default' });

    writeJson(file, {
      accounts: {
        list: [{ id: 'acc001', label: 'A', dir: dirA, createdAt: 1 }],
        active: null,
        mode: 'switch',
        sessions: {},
        subagent: { claude: 'acc001' },
      },
    });
    expect(new StateStore(file).state.accounts.subagent).toEqual({ claude: 'acc001' });
  });
});

describe('POST /api/accounts/subagent', () => {
  it('成功设置并返回 AccountList + 广播 refresh；未知 id 404；未登录 400', async () => {
    writeLoginFiles(base, 'u-def', 'Default', { expiresAt: 5000 });
    const a = makeAccounts();
    const work = addClaudeAccount(a, 'u-work', 'Work', { label: '工作', expiresAt: 5000 });
    // 添加一个未登录的账号（手动插入并建空目录）
    const unloggedDir = path.join(root, 'unlog1');
    fs.mkdirSync(unloggedDir, { recursive: true });
    a.store.state.accounts.list.push({ id: 'unlog1', label: '未登录', dir: unloggedDir, createdAt: Date.now() });

    let port = 0;
    const handler = createHandler({
      port: () => port,
      version: '0.0.0',
      webDist: null,
      workspaces: new Workspaces(a.store),
      sessions: {} as never,
      manager: {} as never,
      account: { get: async () => null },
      accounts: a.accounts,
      usage: { get: async () => null },
      store: a.store,
      previews: {} as never,
      pins: {} as never,
      trash: {} as never,
      pricing: { table: () => ({ source: 'builtin', fetchedAt: null, models: [] }) },
    });
    const srv = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as AddressInfo).port;
    const req = async (method: string, urlPath: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: await res.json() };
    };

    try {
      a.events.length = 0;
      const ok = await req('POST', '/api/accounts/subagent', { id: work.id });
      expect(ok.status).toBe(200);
      expect(ok.json.subagent).toEqual({ claude: work.id });
      expect(a.store.state.accounts.subagent.claude).toBe(work.id);
      expect(a.events).toEqual(['refresh']);

      const missing = await req('POST', '/api/accounts/subagent', { id: 'nope99' });
      expect(missing.status).toBe(404);

      const bad = await req('POST', '/api/accounts/subagent', {});
      expect(bad.status).toBe(400);

      const unlogged = await req('POST', '/api/accounts/subagent', { id: 'unlog1' });
      expect(unlogged.status).toBe(400);
      expect(unlogged.json.error).toContain('还没有登录');
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('子代理配置空间：共享链接、隔离项、凭据复制与 .claude.json 过滤', () => {
  it('共享项链接到基础目录，隔离项不链接，.credentials.json 原样复制，.claude.json 只带必要字段', () => {
    fs.mkdirSync(path.join(base, 'skills', 'my-skill'), { recursive: true });
    fs.writeFileSync(path.join(base, 'skills', 'my-skill', 'SKILL.md'), 'hello');
    fs.writeFileSync(path.join(base, 'settings.json'), '{"theme":"dark"}');
    fs.writeFileSync(path.join(base, 'CLAUDE.md'), '# global');
    fs.writeFileSync(path.join(base, 'keybindings.json'), '[]');
    fs.mkdirSync(path.join(base, 'projects', 'main-proj'), { recursive: true });
    fs.writeFileSync(path.join(base, 'history.jsonl'), '{"main":1}\n');

    writeLoginFiles(base, 'u-def', 'Main', {
      expiresAt: 10_000,
      extraClaudeJson: { mcpServers: { demo: { command: 'node', args: ['srv.js'] } } },
    });

    const subDir = prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });
    expect(subDir).toBe(subagentAccountDir(DEFAULT_ID));

    // 共享目录都是符号链接且指向基础目录
    for (const d of SUBAGENT_SHARED_DIRS) {
      expect(fs.lstatSync(path.join(subDir, d)).isSymbolicLink()).toBe(true);
    }
    expect(fs.readFileSync(path.join(subDir, 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toBe('hello');
    // 共享文件内容一致
    for (const f of SUBAGENT_SHARED_FILES) {
      expect(fs.existsSync(path.join(subDir, f))).toBe(true);
    }
    expect(fs.readFileSync(path.join(subDir, 'settings.json'), 'utf8')).toBe('{"theme":"dark"}');

    // 隔离项不存在链接（projects / file-history / todos / plans / tasks / session-env / paste-cache / history.jsonl）
    for (const iso of ['projects', 'file-history', 'todos', 'plans', 'tasks', 'session-env', 'paste-cache', 'history.jsonl']) {
      expect(fs.existsSync(path.join(subDir, iso))).toBe(false);
    }

    // 凭据原样复制
    expect(fs.readFileSync(path.join(subDir, '.credentials.json'), 'utf8')).toBe(
      fs.readFileSync(path.join(base, '.credentials.json'), 'utf8'),
    );

    // .claude.json 只带必要字段，不含 numStartups / tipsHistory / projects
    const subJson = readJson(path.join(subDir, '.claude.json'));
    expect(subJson).toEqual({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      lastOnboardingVersion: '2.1.332',
      oauthAccount: { accountUuid: 'u-def', displayName: 'Main', emailAddress: 'Main@x.test' },
      mcpServers: { demo: { command: 'node', args: ['srv.js'] } },
    });

    // 子代理自己的 .claude.json 运行态字段在再次同步时被保留
    subJson.numStartups = 99;
    writeJson(path.join(subDir, '.claude.json'), subJson);
    prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });
    expect(readJson(path.join(subDir, '.claude.json')).numStartups).toBe(99);
  });

  it('API 账号不复制凭据与 oauthAccount，但保留共享链接和引导字段', () => {
    const apiDir = path.join(root, 'api001');
    writeApiConfig(apiDir, { baseUrl: 'https://proxy.example.com', apiKey: 'sk-test-1234567890', authType: 'apiKey' });
    const subDir = prepareSubagentSpace('api001', apiDir, { platform: 'linux' });
    expect(fs.existsSync(path.join(subDir, '.credentials.json'))).toBe(false);
    const subJson = readJson(path.join(subDir, '.claude.json'));
    expect(subJson.hasCompletedOnboarding).toBe(true);
    expect(subJson.bypassPermissionsModeAccepted).toBe(true);
    expect(subJson.oauthAccount).toBeUndefined();
  });
});

describe('双向较新者胜凭据同步（三个时机 + 主空间登录中保护 + 失败记录）', () => {
  it('时机 ①②③：主→子、子→主、主代理启动前子→主，较新者胜，旧的不覆盖新的', () => {
    writeLoginFiles(base, 'u-def', 'Main', { expiresAt: 1000, refreshToken: 'r1' });
    const a = makeAccounts({ subagentSpace: { platform: 'linux' } });

    // 时机 ①：启动子代理前主→子
    const prep1 = a.accounts.prepareSubagent(DEFAULT_ID)!;
    expect(readJson(path.join(prep1.dir, '.credentials.json')).claudeAiOauth.refreshToken).toBe('r1');

    // 主空间刷新到了更新的 token（expiresAt 2000）→ 再次启动子代理前主→子更新
    writeLoginFiles(base, 'u-def', 'Main', { expiresAt: 2000, refreshToken: 'r2' });
    a.accounts.prepareSubagent(DEFAULT_ID);
    expect(readJson(path.join(prep1.dir, '.credentials.json')).claudeAiOauth.refreshToken).toBe('r2');

    // 子空间刷新到了更新的 token（expiresAt 3000）→ 时机 ② 子代理退出后子→主回写
    writeLoginFiles(prep1.dir, 'u-def', 'Main', { expiresAt: 3000, refreshToken: 'r3' });
    expect(a.accounts.syncSubagentBack(DEFAULT_ID)).toBe(true);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.refreshToken).toBe('r3');

    // 主空间又刷新到了 4000 → 子空间旧的 3000 不能覆盖主空间
    writeLoginFiles(base, 'u-def', 'Main', { expiresAt: 4000, refreshToken: 'r4' });
    expect(a.accounts.syncSubagentBack(DEFAULT_ID)).toBe(false);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.refreshToken).toBe('r4');

    // 时机 ③：子空间有更新的 5000 → runner 启动主代理前（accounts.prepare）子→主回写
    writeLoginFiles(prep1.dir, 'u-def', 'Main', { expiresAt: 5000, refreshToken: 'r5' });
    a.accounts.prepare(DEFAULT_ID);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.refreshToken).toBe('r5');
  });

  it('没有 expiresAt 时按文件 mtime 判断新旧', () => {
    const sOld = { raw: '{"a":1}', expiresAt: null, mtimeMs: 1000 };
    const sNew = { raw: '{"a":2}', expiresAt: null, mtimeMs: 2000 };
    expect(isNewerCred(sNew, sOld)).toBe(true);
    expect(isNewerCred(sOld, sNew)).toBe(false);
  });

  it('主代理空间正在重新登录时禁止子→主回写', () => {
    writeLoginFiles(base, 'u-def', 'Main', { expiresAt: 1000, refreshToken: 'r1' });
    const a = makeAccounts({ subagentSpace: { platform: 'linux' } });
    const prep = a.accounts.prepareSubagent(DEFAULT_ID)!;

    // 开始给默认账号重新登录
    const login = a.accounts.startLogin({ accountId: DEFAULT_ID });
    expect(a.accounts.isLoggingIn(DEFAULT_ID)).toBe(true);

    // 此时子空间即便有更新的 token，也不得写回主空间
    writeLoginFiles(prep.dir, 'u-def', 'Main', { expiresAt: 9999, refreshToken: 'r-sub-new' });
    expect(a.accounts.syncSubagentBack(DEFAULT_ID)).toBe(false);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.refreshToken).toBe('r1');

    // 取消登录后恢复允许回写
    a.accounts.cancelLogin(login.loginId);
    expect(a.accounts.syncSubagentBack(DEFAULT_ID)).toBe(true);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.refreshToken).toBe('r-sub-new');
  });

  it('子代理同步失败记录进 AccountList.subagent.claudeError，恢复后清除；主代理 prepare 失败静默不阻断', () => {
    // 默认账号没有凭据
    const a = makeAccounts({ subagentSpace: { platform: 'linux' } });
    expect(() => a.accounts.prepareSubagent(DEFAULT_ID)).toThrow(/未登录|缺少凭据/);
    expect(a.accounts.list().subagent?.claudeError).toMatch(/未登录|缺少凭据/);

    // 补上凭据后再次准备，claudeError 自动清除
    writeLoginFiles(base, 'u-def', 'Main', { expiresAt: 2000 });
    a.accounts.prepareSubagent(DEFAULT_ID);
    expect(a.accounts.list().subagent?.claudeError).toBeUndefined();

    // 主代理 prepare 即使钥匙串抛错也不阻断
    const brokenKc: KeychainAdapter = {
      read: () => { throw new Error('keychain locked'); },
      write: () => { throw new Error('keychain locked'); },
    };
    const a2 = makeAccounts({ subagentSpace: { platform: 'darwin', keychain: brokenKc } });
    expect(() => a2.accounts.prepare(DEFAULT_ID)).not.toThrow();
  });
});

describe('账号移除清理与主代理模式隔离', () => {
  it('移除账号时删除其子代理空间、保留基础目录共享内容，并让 subagent.claude 退回 default', async () => {
    fs.mkdirSync(path.join(base, 'skills', 'keep-me'), { recursive: true });
    fs.writeFileSync(path.join(base, 'settings.json'), '{"keep":true}');
    writeLoginFiles(base, 'u-def', 'Default', { expiresAt: 1000 });
    const a = makeAccounts({ subagentSpace: { platform: 'linux' } });
    const work = addClaudeAccount(a, 'u-work', 'Work', { label: '工作', expiresAt: 2000 });

    a.accounts.setSubagentClaude(work.id);
    const prep = a.accounts.prepareSubagent(work.id)!;
    expect(fs.existsSync(prep.dir)).toBe(true);

    await a.accounts.remove(work.id);
    expect(fs.existsSync(prep.dir)).toBe(false);
    expect(a.accounts.list().subagent?.claude).toBe(DEFAULT_ID);
    expect(a.store.state.accounts.subagent.claude).toBe(DEFAULT_ID);
    // 基础目录的共享项毫发无损
    expect(fs.existsSync(path.join(base, 'skills', 'keep-me'))).toBe(true);
    expect(fs.readFileSync(path.join(base, 'settings.json'), 'utf8')).toBe('{"keep":true}');
  });

  it('切换主代理账号与改模式（switch <-> parallel）不改变子代理账号', async () => {
    writeLoginFiles(base, 'u-def', 'Default', { expiresAt: 1000 });
    const a = makeAccounts({ subagentSpace: { platform: 'linux' } });
    const work = addClaudeAccount(a, 'u-work', 'Work', { expiresAt: 2000 });

    a.accounts.setSubagentClaude(work.id);
    expect(a.accounts.subagentClaudeId()).toBe(work.id);

    await a.accounts.switchTo(work.id, false);
    expect(a.accounts.subagentClaudeId()).toBe(work.id);

    await a.accounts.switchTo(DEFAULT_ID, false);
    expect(a.accounts.subagentClaudeId()).toBe(work.id);

    await a.accounts.setMode('parallel', false);
    expect(a.accounts.subagentClaudeId()).toBe(work.id);

    await a.accounts.setMode('switch', false);
    expect(a.accounts.subagentClaudeId()).toBe(work.id);
  });
});

describe('凭据存储目录（CLAUDE_SECURESTORAGE_CONFIG_DIR）', () => {
  it('credStorageDirFor：添加的账号用账号目录；默认账号沿用外部变量，都没有时 macOS 为空串、其它平台为 ~/.claude', () => {
    expect(credStorageDirFor('/acc/x', {}, 'linux')).toBe('/acc/x');
    expect(credStorageDirFor(null, { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/sec' }, 'linux')).toBe('/sec');
    expect(credStorageDirFor(null, { CLAUDE_CONFIG_DIR: '/cfg' }, 'darwin')).toBe('/cfg');
    expect(credStorageDirFor(null, {}, 'darwin')).toBe('');
    expect(credStorageDirFor(null, {}, 'win32')).toBe(path.join(os.homedir(), '.claude'));
  });

  it('claudeEnv：添加的账号去掉外部继承的凭据存储变量；显式传入时以传入的为准；默认账号沿用外部环境', () => {
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = '/outer';
    try {
      expect(claudeEnv('/acc/x').CLAUDE_SECURESTORAGE_CONFIG_DIR).toBeUndefined();
      expect(claudeEnv('/sub/x', '/acc/x', '/acc/x').CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/acc/x');
      expect(claudeEnv(null).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe('/outer');
    } finally {
      delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    }
  });
});

describe('ClaudeBackend：新会话 / 续接目录与 API/Kiro 环境来源', () => {
  function mockSpawnSuccess(onCall: (args: string[], env: NodeJS.ProcessEnv) => void) {
    return ((_cmd: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => {
      onCall([...args], opts.env ?? {});
      const p = new FakeProc();
      queueMicrotask(() => {
        p.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sid-sub', model: 'claude-sonnet-5-5' }) + '\n');
        p.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', session_id: 'sid-sub', result: 'ok' }) + '\n');
        p.exit(0);
      });
      return p as unknown as ChildProcess;
    }) as typeof import('node:child_process').spawn;
  }

  it('新会话用 subagent.claude 空间，续接用记录里的 accountId 空间，退出后回写凭据', async () => {
    writeLoginFiles(base, 'u-def', 'Default', { expiresAt: 1000, refreshToken: 'def-r1' });
    const a = makeAccounts({ subagentSpace: { platform: 'linux' } });
    const work = addClaudeAccount(a, 'u-work', 'Work', { expiresAt: 2000, refreshToken: 'work-r1' });
    a.accounts.setSubagentClaude(work.id);

    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    const finishSpy = vi.fn((id: string) => a.accounts.syncSubagentBack(id));
    const backend = new ClaudeBackend({
      claudePath: 'claude',
      subagentAccountId: () => a.accounts.subagentClaudeId(),
      prepareAccount: (id) => a.accounts.prepareSubagent(id),
      finishAccount: finishSpy,
      spawn: mockSpawnSuccess((args, env) => calls.push({ args, env })),
    });

    // 新会话：即便传入主会话 account 为 default，仍应使用 subagent.claude（work.id）的子代理空间
    const r1 = await backend.run({
      cwd: tmp,
      prompt: 'hi',
      account: { id: DEFAULT_ID, dir: null },
      signal: new AbortController().signal,
    });
    expect(r1.accountId).toBe(work.id);
    expect(calls[0]!.env.CLAUDE_CONFIG_DIR).toBe(subagentAccountDir(work.id));
    // 凭据存储指向主代理账号目录：与主会话共用同一份令牌和刷新锁
    expect(calls[0]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(work.dir);
    expect(finishSpy).toHaveBeenCalledWith(work.id);

    // 把 subagent.claude 切回 default，再续接上面用 work.id 创建的会话 → 仍用 work.id 的子代理空间
    a.accounts.setSubagentClaude(DEFAULT_ID);
    const r2 = await backend.run({
      cwd: tmp,
      prompt: 'continue',
      sessionId: 'sid-sub',
      accountId: work.id,
      account: { id: DEFAULT_ID, dir: null },
      signal: new AbortController().signal,
    });
    expect(r2.accountId).toBe(work.id);
    expect(calls[1]!.env.CLAUDE_CONFIG_DIR).toBe(subagentAccountDir(work.id));
    expect(calls[1]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(work.dir);
    expect(calls[1]!.args).toContain('--resume');

    // 默认账号的子代理：凭据存储沿用外部 CLAUDE_CONFIG_DIR（主会话默认账号的凭据目录）
    const r3 = await backend.run({ cwd: tmp, prompt: 'def', account: { id: DEFAULT_ID, dir: null }, signal: new AbortController().signal });
    expect(r3.accountId).toBe(DEFAULT_ID);
    expect(calls[2]!.env.CLAUDE_CONFIG_DIR).toBe(subagentAccountDir(DEFAULT_ID));
    expect(calls[2]!.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(base);

    // 移除 work.id 后再续接 → 抛 BackendError 报清楚错误
    await a.accounts.remove(work.id);
    await expect(
      backend.run({
        cwd: tmp,
        prompt: 'again',
        sessionId: 'sid-sub',
        accountId: work.id,
        signal: new AbortController().signal,
      }),
    ).rejects.toSatisfy((e: unknown) => e instanceof BackendError && /已移除/.test(e.message) && e.accountId === work.id);
  });

  it('API / Kiro 账号：CLAUDE_CONFIG_DIR 指向子代理空间，API 环境变量与 Kiro 钩子来自主代理目录', async () => {
    const a = makeAccounts({ subagentSpace: { platform: 'linux' } });
    const kiroId = await a.accounts.saveApi({
      label: 'API测试',
      baseUrl: 'https://api.custom.test',
      apiKey: 'sk-secret-9999999999',
      authType: 'authToken',
    });
    const mainDir = a.accounts.dirFor(kiroId)!;
    // 改写成 Kiro 配置以验证 beforeClaudeEnvHook 触发且传入主代理目录
    writeApiConfig(mainDir, {
      baseUrl: 'http://127.0.0.1:18999',
      apiKey: 'kiro-key-1234567890',
      authType: 'authToken',
      kiro: { method: 'apiKey', credentialId: 1, keyId: 2 },
    });
    a.accounts.setSubagentClaude(kiroId);

    const hookDirs: string[] = [];
    setBeforeClaudeEnv((d) => hookDirs.push(d));

    let capturedEnv: NodeJS.ProcessEnv | null = null;
    let capturedArgs: string[] = [];
    const backend = new ClaudeBackend({
      claudePath: 'claude',
      subagentAccountId: () => a.accounts.subagentClaudeId(),
      prepareAccount: (id) => a.accounts.prepareSubagent(id),
      spawn: mockSpawnSuccess((args, env) => {
        capturedArgs = args;
        capturedEnv = env;
      }),
    });

    const res = await backend.run({
      cwd: tmp,
      prompt: 'hi',
      signal: new AbortController().signal,
    });
    expect(res.accountId).toBe(kiroId);
    expect(hookDirs).toEqual([mainDir]);
    expect(capturedEnv!.CLAUDE_CONFIG_DIR).toBe(subagentAccountDir(kiroId));
    expect(capturedEnv!.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:18999');
    expect(capturedEnv!.ANTHROPIC_AUTH_TOKEN).toBe('kiro-key-1234567890');
    expect(capturedArgs).toContain('--settings');
  });
});

describe('macOS 钥匙串服务名派生与平台分支 mock', () => {
  it('macKeychainServiceName 严格匹配 Claude CLI 的 sha256(NFC).slice(0, 8) 规则', () => {
    expect(macKeychainServiceName(null)).toBe('Claude Code-credentials');
    expect(macKeychainServiceName('')).toBe('Claude Code-credentials');

    const dir = '/Users/alice/.claude-subagents/acc1';
    const expectedHash = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 8);
    expect(macKeychainServiceName(dir)).toBe(`Claude Code-credentials-${expectedHash}`);

    // NFD 与 NFC 路径派生一致
    const nfc = '/Users/caf\u00e9/.claude-subagents/default';
    const nfd = '/Users/cafe\u0301/.claude-subagents/default';
    expect(macKeychainServiceName(nfd)).toBe(macKeychainServiceName(nfc));

    // keychainServiceFor：默认账号受外部 CLAUDE_CONFIG_DIR 影响
    expect(keychainServiceFor(null, undefined)).toBe('Claude Code-credentials');
    expect(keychainServiceFor(null, '/custom/dir')).toBe(macKeychainServiceName('/custom/dir'));
    expect(keychainServiceFor('/other/dir', '/custom/dir')).toBe(macKeychainServiceName('/other/dir'));
  });

  it('darwin 平台通过 KeychainAdapter 主→子复制、子→主较新者胜回写、移除时清理条目', () => {
    const store = new Map<string, string>();
    const removed: string[] = [];
    const kc: KeychainAdapter = {
      read: (svc) => store.get(svc) ?? null,
      write: (svc, data) => { store.set(svc, data); },
      remove: (svc) => { store.delete(svc); removed.push(svc); },
    };

    const mainSvc = keychainServiceFor(null, '');
    const subDir = subagentAccountDir(DEFAULT_ID);
    const subSvc = macKeychainServiceName(subDir);

    const cred1 = JSON.stringify({ claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1000 } });
    store.set(mainSvc, cred1);

    prepareSubagentSpace(DEFAULT_ID, null, { platform: 'darwin', keychain: kc, envConfigDir: '' });
    expect(store.get(subSvc)).toBe(cred1);

    // 子空间刷新到更新的 token → 子→主回写
    const cred2 = JSON.stringify({ claudeAiOauth: { accessToken: 'a2', refreshToken: 'r2', expiresAt: 2000 } });
    store.set(subSvc, cred2);
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'darwin', keychain: kc, envConfigDir: '' })).toBe(true);
    expect(store.get(mainSvc)).toBe(cred2);

    // 移除时删除子空间的钥匙串条目
    removeSubagentSpace(DEFAULT_ID, { platform: 'darwin', keychain: kc });
    expect(removed).toContain(subSvc);
    expect(store.has(subSvc)).toBe(false);
    expect(store.get(mainSvc)).toBe(cred2);
  });
});
