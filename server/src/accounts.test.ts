// 多账号：共享链接、MCP 三方同步、切换 / 登录流程。全部用临时目录，不碰真实的 ~/.claude。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Accounts, DEFAULT_ID, RunningError, findLoginUrl, stripAnsi } from './accounts/index.js';
import { ensureLinks, unlinkShared } from './accounts/links.js';
import { syncMcp } from './accounts/mcp-sync.js';
import { claudeEnv } from './claude/bin.js';
import { createHandler } from './http.js';
import { activeConfigDir, projectsDir, setActiveConfigDir } from './paths.js';
import { StateStore, Workspaces } from './workspaces.js';

let tmp: string;
let base: string;
let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-acc-'));
  base = path.join(tmp, 'claude');
  root = path.join(tmp, 'accounts');
  fs.mkdirSync(base, { recursive: true });
  for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_ACCOUNTS_DIR', 'COSYEE_SUBAGENT_ACCOUNTS_DIR']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.COSYEE_ACCOUNTS_DIR = root;
  process.env.COSYEE_SUBAGENT_ACCOUNTS_DIR = path.join(tmp, 'subagents');
  setActiveConfigDir(null);
});

afterEach(() => {
  setActiveConfigDir(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const writeJson = (f: string, j: unknown) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(j));
};
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

function loginFiles(dir: string, uuid: string, name: string, plan = 'pro') {
  writeJson(path.join(dir, '.credentials.json'), { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', subscriptionType: plan } });
  writeJson(path.join(dir, '.claude.json'), { oauthAccount: { accountUuid: uuid, displayName: name, emailAddress: `${name}@x.test` } });
}

describe('links', () => {
  it('共享目录与文件链接到基础目录，私有文件不共享', () => {
    fs.mkdirSync(path.join(base, 'projects', 'p1'), { recursive: true });
    fs.writeFileSync(path.join(base, 'settings.json'), '{"a":1}');
    const dir = path.join(root, 'acc1');
    expect(ensureLinks(base, dir)).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'projects', 'p1'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).toBe('{"a":1}');
    // 写账号目录里的共享文件 = 写基础目录
    fs.appendFileSync(path.join(dir, 'history.jsonl'), 'x\n');
    expect(fs.readFileSync(path.join(base, 'history.jsonl'), 'utf8')).toBe('x\n');
    fs.writeFileSync(path.join(dir, '.credentials.json'), 'secret');
    expect(fs.existsSync(path.join(base, '.credentials.json'))).toBe(false);
    // 再调用一次不出错、不变
    expect(ensureLinks(base, dir)).toEqual([]);
  });

  it('链接被换成真实目录 / 文件时合并回基础目录并重新链接', () => {
    const dir = path.join(root, 'acc1');
    ensureLinks(base, dir);
    unlinkShared(dir);
    fs.mkdirSync(path.join(dir, 'skills', 'mine'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', 'mine', 'SKILL.md'), 'hi');
    fs.writeFileSync(path.join(base, 'settings.json'), '{"old":1}');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(base, 'settings.json'), past, past);
    fs.writeFileSync(path.join(dir, 'settings.json'), '{"new":1}');
    expect(ensureLinks(base, dir)).toEqual([]);
    expect(fs.readFileSync(path.join(base, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('hi');
    expect(fs.lstatSync(path.join(dir, 'skills')).isSymbolicLink()).toBe(true);
    expect(readJson(path.join(base, 'settings.json'))).toEqual({ new: 1 });
    expect(fs.readdirSync(base).some((n) => n.startsWith('settings.json.cosyee-bak-'))).toBe(true);
  });

  it('解除链接后删除账号目录不影响基础目录', () => {
    fs.mkdirSync(path.join(base, 'projects', 'p1'), { recursive: true });
    const dir = path.join(root, 'acc1');
    ensureLinks(base, dir);
    expect(unlinkShared(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
    expect(fs.existsSync(path.join(base, 'projects', 'p1'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'settings.json'))).toBe(true);
  });
});

describe('mcp sync', () => {
  it('第一次只拉；之后账号里的改动推回主文件，主文件的改动拉进账号', () => {
    const master = path.join(tmp, 'master.json');
    const acc = path.join(tmp, 'acc.json');
    const snap = path.join(tmp, 'snap.json');
    writeJson(master, { mcpServers: { a: { command: 'a' } }, projects: { P: { mcpServers: {}, disabledMcpServers: ['x'], lastCost: 1 } }, numStartups: 5 });
    writeJson(acc, { oauthAccount: { displayName: 'B' }, projects: { P: { lastCost: 9, allowedTools: ['local'] } } });
    syncMcp(master, acc, snap);
    let a = readJson(acc);
    expect(a.mcpServers).toEqual({ a: { command: 'a' } });
    expect(a.projects.P.disabledMcpServers).toEqual(['x']);
    expect(a.projects.P.allowedTools).toBeUndefined(); // 第一次以主文件为准
    expect(a.projects.P.lastCost).toBe(9); // 其它字段不动
    expect(a.oauthAccount).toEqual({ displayName: 'B' });

    // 账号期间：禁用了另一个服务器、加了用户级 MCP
    a.projects.P.disabledMcpServers = ['x', 'y'];
    a.mcpServers.b = { command: 'b' };
    writeJson(acc, a);
    // 主文件同时被别处改了另一个项目
    const m0 = readJson(master);
    m0.projects.Q = { hasTrustDialogAccepted: true };
    writeJson(master, m0);
    syncMcp(master, acc, snap);
    const m = readJson(master);
    expect(m.projects.P.disabledMcpServers).toEqual(['x', 'y']);
    expect(m.mcpServers.b).toEqual({ command: 'b' });
    expect(m.numStartups).toBe(5);
    expect(m.oauthAccount).toBeUndefined(); // 登录信息绝不进主文件
    a = readJson(acc);
    expect(a.projects.Q.hasTrustDialogAccepted).toBe(true);
  });

  it('文件不是合法 JSON 时什么都不做', () => {
    const master = path.join(tmp, 'master.json');
    const acc = path.join(tmp, 'acc.json');
    fs.writeFileSync(master, '{bad');
    writeJson(acc, { a: 1 });
    expect(syncMcp(master, acc, path.join(tmp, 'snap.json'))).toBeNull();
    expect(readJson(acc)).toEqual({ a: 1 });
  });
});

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = undefined;
  written = '';
  exit(code: number) {
    this.exitCode = code;
    this.emit('close', code);
  }
  kill() {
    this.exit(1);
    return true;
  }
  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => (this.written += d.toString()));
  }
}

function makeAccounts(opts: { running?: number | Record<string, number> } = {}) {
  const store = new StateStore(path.join(tmp, 'state.json'));
  const events: string[] = [];
  /** 最近一次部分停止的匹配函数 */
  let stopMatch: ((id: string | null) => boolean) | null = null;
  let proc: FakeProc | null = null;
  let env: NodeJS.ProcessEnv | null = null;
  const running = (id?: string) => {
    const r = opts.running ?? 0;
    if (typeof r === 'number') return id === undefined ? r : 0;
    return id === undefined ? Object.values(r).reduce((a, b) => a + b, 0) : (r[id] ?? 0);
  };
  const accounts = new Accounts({
    store,
    running,
    processes: (id) => running(id),
    stop: async (match) => {
      events.push(match ? 'stop-some' : 'stop');
      stopMatch = match ?? null;
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
  });
  accounts.init();
  return { store, accounts, events, proc: () => proc!, env: () => env!, stopMatch: () => stopMatch };
}

/** 添加一个已登录的账号，返回 id 和目录 */
function addAccount(a: ReturnType<typeof makeAccounts>, uuid: string, name: string, label = ''): { id: string; dir: string } {
  const login = a.accounts.startLogin({ label });
  const dir = a.env().CLAUDE_CONFIG_DIR!;
  loginFiles(dir, uuid, name);
  a.proc().exit(0);
  return { id: a.accounts.getLogin(login.loginId).accountId!, dir };
}

describe('Accounts', () => {
  it('登录添加账号、列表不含邮箱、切换后子进程带 CLAUDE_CONFIG_DIR，会话目录仍是基础目录', async () => {
    loginFiles(base, 'u-default', 'Main');
    const { accounts, events, proc, env, store } = makeAccounts();
    const login = accounts.startLogin({ label: '工作' });
    expect(login.status).toBe('starting');
    const dir = env().CLAUDE_CONFIG_DIR!;
    expect(path.dirname(dir)).toBe(root);
    proc().stdout.write('Opening browser...\n\x1b]8;;https://claude.com/cai/oauth/authorize?code=true&state=s\x07here\x1b]8;;\x07\n');
    await new Promise((r) => setImmediate(r));
    const st = accounts.getLogin(login.loginId);
    expect(st.status).toBe('waiting');
    expect(st.url).toBe('https://claude.com/cai/oauth/authorize?code=true&state=s');
    accounts.submitCode(login.loginId, 'abc#def');
    expect(proc().written).toBe('abc#def\n');
    loginFiles(dir, 'u-work', 'Work', 'max');
    proc().exit(0);
    const done = accounts.getLogin(login.loginId);
    expect(done.status).toBe('done');
    const id = done.accountId!;

    const list = accounts.list();
    expect(JSON.stringify(list)).not.toContain('@');
    expect(JSON.stringify(list)).not.toContain('u-work');
    expect(list.list.map((a) => [a.id, a.name, a.plan, a.active])).toEqual([
      [DEFAULT_ID, 'Main', 'Pro', true],
      [id, 'Work', 'Max', false],
    ]);
    expect(list.list[1]!.label).toBe('工作');

    await accounts.switchTo(id, false);
    expect(events).toEqual(['stop', 'reload']);
    expect(activeConfigDir()).toBe(dir);
    expect(claudeEnv().CLAUDE_CONFIG_DIR).toBe(dir);
    expect(projectsDir()).toBe(path.join(base, 'projects'));
    expect(store.state.accounts.active).toBe(id);

    await expect(accounts.remove(id)).rejects.toThrow(/当前账号/);
    await accounts.switchTo(DEFAULT_ID, false);
    expect(activeConfigDir()).toBeNull();
    expect(claudeEnv().CLAUDE_CONFIG_DIR).toBe(base); // 默认账号沿用外部环境
    await accounts.remove(id);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(path.join(base, 'projects'))).toBe(true);
    expect(fs.existsSync(path.join(base, 'settings.json'))).toBe(true);
  });

  it('有执行中的会话时不带 force 拒绝切换', async () => {
    loginFiles(base, 'u-default', 'Main');
    const { accounts, events, proc, env } = makeAccounts({ running: 2 });
    const login = accounts.startLogin({});
    loginFiles(env().CLAUDE_CONFIG_DIR!, 'u-2', 'Two');
    proc().exit(0);
    const id = accounts.getLogin(login.loginId).accountId!;
    await expect(accounts.switchTo(id, false)).rejects.toBeInstanceOf(RunningError);
    expect(events).toEqual([]);
    await accounts.switchTo(id, true);
    expect(events).toEqual(['stop', 'reload']);
  });

  it('并行模式：会话按绑定的账号运行，切换当前账号不停进程，只影响新会话', async () => {
    loginFiles(base, 'u-default', 'Main');
    const a = makeAccounts({ running: { [DEFAULT_ID]: 1 } });
    const { accounts, events, store } = a;
    const work = addAccount(a, 'u-work', 'Work', '工作');
    expect(accounts.list().mode).toBe('switch');

    await accounts.setMode('parallel', false);
    expect(accounts.list().mode).toBe('parallel');
    expect(events).toEqual(['refresh']);

    accounts.bind('s-old', DEFAULT_ID);
    await accounts.switchTo(work.id, false); // 默认账号有会话在跑也不拦
    expect(events).toEqual(['refresh', 'refresh']);
    expect(activeConfigDir()).toBe(work.dir);
    expect(accounts.resolve('s-old')).toEqual({ id: DEFAULT_ID, dir: null });
    expect(accounts.resolve('s-new')).toEqual({ id: work.id, dir: work.dir });
    expect(accounts.displayName(work.id)).toBe('工作');
    expect(accounts.displayName(DEFAULT_ID)).toBe('Main');

    // 换回切换模式：其它账号（默认账号）有执行中的会话，要确认
    events.length = 0;
    await expect(accounts.setMode('switch', false)).rejects.toThrow(/其它账号有 1 个会话/);
    expect(events).toEqual([]);
    await accounts.setMode('switch', true);
    expect(events).toEqual(['stop-some', 'reload']);
    expect(a.stopMatch()!(DEFAULT_ID)).toBe(true);
    expect(a.stopMatch()!(work.id)).toBe(false);
    expect(store.state.accounts.mode).toBe('switch');
    // 切换模式下所有会话都用当前账号
    expect(accounts.resolve('s-old')).toEqual({ id: work.id, dir: work.dir });
  });

  it('并行模式：有执行中会话的账号不能移除；移除后绑定它的会话改用当前账号', async () => {
    loginFiles(base, 'u-default', 'Main');
    const running: Record<string, number> = {};
    const a = makeAccounts({ running });
    const { accounts, events, store } = a;
    const two = addAccount(a, 'u-2', 'Two');
    await accounts.setMode('parallel', false);
    accounts.bind('s1', two.id);
    expect(accounts.resolve('s1').id).toBe(two.id);
    running[two.id] = 1;
    await expect(accounts.remove(two.id)).rejects.toThrow(/正在执行/);
    running[two.id] = 0;
    events.length = 0;
    await accounts.remove(two.id);
    expect(events).toEqual([`reset:${two.id}`, 'refresh']);
    expect(store.state.accounts.sessions).toEqual({});
    expect(accounts.resolve('s1')).toEqual({ id: DEFAULT_ID, dir: null });
    await expect(accounts.setMode('bogus', false)).rejects.toThrow(/mode/);
  });

  it('重复添加同一账号失败并清理目录；取消登录也清理目录', async () => {
    loginFiles(base, 'u-default', 'Main');
    const { accounts, proc, env } = makeAccounts();
    const l1 = accounts.startLogin({});
    const d1 = env().CLAUDE_CONFIG_DIR!;
    loginFiles(d1, 'u-default', 'Main');
    proc().exit(0);
    expect(accounts.getLogin(l1.loginId)).toMatchObject({ status: 'failed', error: '该账号已经添加过了' });
    expect(fs.existsSync(d1)).toBe(false);
    expect(fs.existsSync(path.join(base, 'projects'))).toBe(true);

    const l2 = accounts.startLogin({});
    const d2 = env().CLAUDE_CONFIG_DIR!;
    expect(() => accounts.startLogin({})).toThrow(/已有一个登录/);
    accounts.cancelLogin(l2.loginId);
    expect(accounts.getLogin(l2.loginId).status).toBe('failed');
    expect(fs.existsSync(d2)).toBe(false);
    expect(accounts.list().list).toHaveLength(1);
  });

  it('未登录的账号不能切换', async () => {
    const { accounts } = makeAccounts();
    await expect(accounts.switchTo('nope', false)).rejects.toThrow(/不存在/);
  });

  it('API 账号：添加后列表不含密钥、切换后子进程带 API Key / Base URL，修改时留空密钥沿用原来的', async () => {
    loginFiles(base, 'u-default', 'Main');
    const saved = { key: process.env.ANTHROPIC_API_KEY, url: process.env.ANTHROPIC_BASE_URL };
    process.env.ANTHROPIC_API_KEY = 'outer-key';
    process.env.ANTHROPIC_BASE_URL = 'https://outer.test';
    try {
      const { accounts, events } = makeAccounts();
      await expect(accounts.saveApi({ baseUrl: 'ftp://x', apiKey: 'k' })).rejects.toThrow(/Base URL/);
      await expect(accounts.saveApi({ baseUrl: '' })).rejects.toThrow(/API Key/);
      const id = await accounts.saveApi({ label: '代理', baseUrl: ' https://proxy.test/api/ ', apiKey: 'sk-secret-123456', authType: 'authToken' });
      await expect(accounts.saveApi({ baseUrl: 'https://proxy.test/api', apiKey: 'sk-secret-123456' })).rejects.toThrow(/已经添加过/);

      const list = accounts.list();
      expect(JSON.stringify(list)).not.toContain('sk-secret');
      const e = list.list.find((a) => a.id === id)!;
      expect(e).toMatchObject({ name: '代理', plan: 'API', loggedIn: true, api: { baseUrl: 'https://proxy.test/api', authType: 'authToken', keyHint: '3456' } });
      expect(accounts.displayName(id)).toBe('代理');
      expect(() => accounts.startLogin({ accountId: id })).toThrow(/不需要登录/);

      await accounts.switchTo(id, false);
      let env = claudeEnv();
      expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-secret-123456');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined(); // 外部环境的同名变量被去掉
      expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.test/api');

      // 修改：密钥留空沿用，Base URL 留空 = 官方地址
      events.length = 0;
      await accounts.saveApi({ id, baseUrl: '', apiKey: '', authType: 'apiKey' });
      expect(events).toEqual([`reset:${id}`, 'refresh']);
      env = claudeEnv();
      expect(env.ANTHROPIC_API_KEY).toBe('sk-secret-123456');
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(accounts.list().list.find((a) => a.id === id)!.name).toBe('代理');

      // 默认账号 / OAuth 账号不受影响，也不能改成 API 账号
      await accounts.switchTo(DEFAULT_ID, false);
      expect(claudeEnv().ANTHROPIC_API_KEY).toBe('outer-key');
      await expect(accounts.saveApi({ id: DEFAULT_ID, apiKey: 'x' })).rejects.toThrow(/默认账号/);
      await accounts.remove(id);
      expect(accounts.list().list).toHaveLength(1);
    } finally {
      if (saved.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = saved.url;
    }
  });

  it('API 账号：有执行中的会话时不能修改', async () => {
    const running: Record<string, number> = {};
    const { accounts } = makeAccounts({ running });
    const id = await accounts.saveApi({ apiKey: 'sk-1' });
    running[id] = 1;
    await expect(accounts.saveApi({ id, apiKey: 'sk-2' })).rejects.toThrow(/正在执行/);
  });

  it('uuid 缺失时用邮箱哈希兜底判重，且不泄露邮箱', () => {
    // 默认账号只有 emailAddress，没有 accountUuid
    writeJson(path.join(base, '.credentials.json'), { claudeAiOauth: { accessToken: 'a', refreshToken: 'r', subscriptionType: 'pro' } });
    writeJson(path.join(base, '.claude.json'), { oauthAccount: { displayName: 'Main', emailAddress: 'Alice@Example.COM' } });

    const { accounts, proc, env } = makeAccounts();
    // 新登录的账号带 accountUuid 且邮箱大小写/空格不同，仍应命中邮箱兜底判重
    const l1 = accounts.startLogin({});
    const d1 = env().CLAUDE_CONFIG_DIR!;
    writeJson(path.join(d1, '.credentials.json'), { claudeAiOauth: { accessToken: 'b', refreshToken: 'r2', subscriptionType: 'pro' } });
    writeJson(path.join(d1, '.claude.json'), { oauthAccount: { accountUuid: 'u-alice', displayName: 'Alice', emailAddress: ' alice@example.com ' } });
    proc().exit(0);

    const st1 = accounts.getLogin(l1.loginId);
    expect(st1).toMatchObject({ status: 'failed', error: '该账号已经添加过了' });
    expect(JSON.stringify(st1)).not.toContain('alice');
    expect(fs.existsSync(d1)).toBe(false);
    expect(accounts.list().list).toHaveLength(1);
  });

  it('重新登录成另一个已存在账号时拒绝并回滚恢复原凭据，不产生重复条目', () => {
    loginFiles(base, 'u-default', 'Main');
    const a = makeAccounts();
    const { accounts, proc, env, events } = a;
    const work = addAccount(a, 'u-work', 'Work', '工作');
    // 在工作账号的 .claude.json 里放入自定义字段，验证回滚不破坏其它配置
    const workJsonPath = path.join(work.dir, '.claude.json');
    const workJson = readJson(workJsonPath);
    workJson.customKeep = 'stay';
    writeJson(workJsonPath, workJson);

    // 1) 非默认账号重新登录成了默认账号 -> 失败并恢复原凭据
    events.length = 0;
    const relogin = accounts.startLogin({ accountId: work.id });
    expect(env().CLAUDE_CONFIG_DIR).toBe(work.dir);
    // 模拟 CLI 覆盖了目录里的凭据与 oauthAccount
    writeJson(path.join(work.dir, '.credentials.json'), { claudeAiOauth: { accessToken: 'new-dup', refreshToken: 'r-dup', subscriptionType: 'max' } });
    writeJson(workJsonPath, { ...readJson(workJsonPath), oauthAccount: { accountUuid: 'u-default', displayName: 'Main', emailAddress: 'Main@x.test' } });
    proc().exit(0);

    const st = accounts.getLogin(relogin.loginId);
    expect(st.status).toBe('failed');
    expect(st.error).toContain('已经添加过');
    // 原凭据与 oauthAccount 均已恢复，customKeep 保留
    expect(readJson(path.join(work.dir, '.credentials.json')).claudeAiOauth.accessToken).toBe('a');
    expect(readJson(workJsonPath).oauthAccount.accountUuid).toBe('u-work');
    expect(readJson(workJsonPath).customKeep).toBe('stay');
    expect(events).toEqual([]);
    expect(accounts.list().list).toHaveLength(2);

    // 2) 默认账号重新登录成了工作账号 -> 同样失败并恢复默认账号原凭据
    const defRelogin = accounts.startLogin({ accountId: DEFAULT_ID });
    writeJson(path.join(base, '.credentials.json'), { claudeAiOauth: { accessToken: 'hijack', refreshToken: 'r', subscriptionType: 'max' } });
    writeJson(path.join(base, '.claude.json'), { oauthAccount: { accountUuid: 'u-work', displayName: 'Work', emailAddress: 'Work@x.test' } });
    proc().exit(0);

    expect(accounts.getLogin(defRelogin.loginId).status).toBe('failed');
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.accessToken).toBe('a');
    expect(readJson(path.join(base, '.claude.json')).oauthAccount.accountUuid).toBe('u-default');
    expect(accounts.list().list).toHaveLength(2);
  });

  it('历史重复条目在 list() 去重显示（当前 > 默认 > 最早），不静默删除目录且仍可移除', async () => {
    loginFiles(base, 'u-default', 'Main');
    const a = makeAccounts();
    const { accounts, store } = a;

    // 构造历史遗留的重复条目：dupDef 与默认账号同 uuid；dup1/dup2 互为重复；unauth1/unauth2 未登录
    const mkHist = (id: string, createdAt: number, label: string, uuid?: string) => {
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      if (uuid) loginFiles(dir, uuid, label);
      store.state.accounts.list.push({ id, label, dir, createdAt });
      return dir;
    };
    const dirDupDef = mkHist('dupdef01', 100, '重复默认', 'u-default');
    const dirOld = mkHist('dupold01', 200, '早号', 'u-same');
    const dirNew = mkHist('dupnew01', 300, '晚号', 'u-same');
    mkHist('unauth01', 400, '未登1');
    mkHist('unauth02', 500, '未登2');

    // 默认账号是当前：保留 default（隐藏 dupdef01），保留最早的 dupold01（隐藏 dupnew01），两个未登录都保留
    expect(accounts.list().list.map((x) => x.id)).toEqual([DEFAULT_ID, 'dupold01', 'unauth01', 'unauth02']);
    // 不静默删除磁盘目录或底层列表
    expect(fs.existsSync(dirDupDef)).toBe(true);
    expect(fs.existsSync(dirNew)).toBe(true);
    expect(store.state.accounts.list).toHaveLength(5);

    // 若当前活跃账号切换到了 dupnew01：优先显示当前活跃的 dupnew01（隐藏 dupold01）
    await accounts.switchTo('dupnew01', false);
    expect(accounts.list().list.map((x) => x.id)).toEqual([DEFAULT_ID, 'dupnew01', 'unauth01', 'unauth02']);
    expect(accounts.list().list.find((x) => x.id === 'dupnew01')?.active).toBe(true);

    // 隐藏的重复条目仍允许通过 remove 显式清理
    await accounts.remove('dupdef01');
    expect(fs.existsSync(dirDupDef)).toBe(false);
    expect(fs.existsSync(dirOld)).toBe(true);
  });

  it('API 账号：修改为与其它 API 账号相同的 Base URL + Key 时拒绝（409）', async () => {
    const { accounts } = makeAccounts();
    const id1 = await accounts.saveApi({ label: 'A', baseUrl: 'https://a.test', apiKey: 'sk-aaa' });
    const id2 = await accounts.saveApi({ label: 'B', baseUrl: 'https://b.test', apiKey: 'sk-bbb' });
    await expect(accounts.saveApi({ id: id2, baseUrl: 'https://a.test', apiKey: 'sk-aaa' })).rejects.toThrow(/已经添加过/);
    // 改自己的备注名不受影响
    await expect(accounts.saveApi({ id: id1, label: 'A2', baseUrl: 'https://a.test', apiKey: '' })).resolves.toBe(id1);
  });

  it('stripAnsi / findLoginUrl', () => {
    expect(stripAnsi('\x1b[1mA\x1b[0m')).toBe('A');
    expect(findLoginUrl('go http://evil/oauth/authorize?x')).toBeNull();
    expect(findLoginUrl('url: https://claude.com/cai/oauth/authorize?a=1&b=2 then')).toBe('https://claude.com/cai/oauth/authorize?a=1&b=2');
  });

  it('subscribedAt / loginExpiresAt：正常读取并下发，非法值 / API / 未登录不下发，不泄露令牌', async () => {
    const subIso = '2026-11-09T08:30:00.000Z';
    const expMs = 1_800_000_000_000;
    writeJson(path.join(base, '.credentials.json'), {
      claudeAiOauth: { accessToken: 'tok-secret-a', refreshToken: 'tok-secret-r', subscriptionType: 'pro', refreshTokenExpiresAt: expMs },
    });
    writeJson(path.join(base, '.claude.json'), {
      oauthAccount: { accountUuid: 'u-default', displayName: 'Main', emailAddress: 'main@x.test', subscriptionCreatedAt: subIso },
    });

    const a = makeAccounts();
    const { accounts, store } = a;

    // 非法时间值的已登录账号
    const badDir = path.join(root, 'bad01');
    fs.mkdirSync(badDir, { recursive: true });
    writeJson(path.join(badDir, '.credentials.json'), {
      claudeAiOauth: { accessToken: 'tok-b', refreshToken: 'tok-r', subscriptionType: 'max', refreshTokenExpiresAt: -5 },
    });
    writeJson(path.join(badDir, '.claude.json'), {
      oauthAccount: { accountUuid: 'u-bad', displayName: 'BadTime', subscriptionCreatedAt: 'not-a-date' },
    });
    store.state.accounts.list.push({ id: 'bad01', label: '', dir: badDir, createdAt: 100 });

    // 未登录但 .claude.json 里残留 subscriptionCreatedAt 的账号
    const unauthDir = path.join(root, 'unauth01');
    fs.mkdirSync(unauthDir, { recursive: true });
    writeJson(path.join(unauthDir, '.credentials.json'), { claudeAiOauth: { refreshTokenExpiresAt: expMs } });
    writeJson(path.join(unauthDir, '.claude.json'), { oauthAccount: { displayName: 'LoggedOut', subscriptionCreatedAt: subIso } });
    store.state.accounts.list.push({ id: 'unauth01', label: '未登录', dir: unauthDir, createdAt: 200 });

    // API 账号
    const apiId = await accounts.saveApi({ label: '代理', baseUrl: 'https://api.test', apiKey: 'sk-key-1234' });

    const res = accounts.list();
    expect(JSON.stringify(res)).not.toContain('tok-secret');
    const def = res.list.find((x) => x.id === DEFAULT_ID)!;
    expect(def.subscribedAt).toBe(Date.parse(subIso));
    expect(def.loginExpiresAt).toBe(expMs);

    const bad = res.list.find((x) => x.id === 'bad01')!;
    expect(bad.subscribedAt).toBeUndefined();
    expect(bad.loginExpiresAt).toBeUndefined();

    const unauth = res.list.find((x) => x.id === 'unauth01')!;
    expect(unauth.loggedIn).toBe(false);
    expect(unauth.subscribedAt).toBeUndefined();
    expect(unauth.loginExpiresAt).toBeUndefined();

    const apiAcc = res.list.find((x) => x.id === apiId)!;
    expect(apiAcc.subscribedAt).toBeUndefined();
    expect(apiAcc.loginExpiresAt).toBeUndefined();
  });

  it('duplicates 计数与 dedupe()：清理隐藏重复项（含会话解绑）、跳过默认/登录中/有执行中会话，且不碰保留项', async () => {
    loginFiles(base, 'u-default', 'Main');
    const running: Record<string, number> = {};
    const a = makeAccounts({ running });
    const { accounts, store, events } = a;

    // 无重复时省略 duplicates，dedupe 返回 0/0
    expect(accounts.list().duplicates).toBeUndefined();
    expect(await accounts.dedupe()).toEqual({ removed: 0, skipped: 0 });
    expect(events).toEqual([]);

    const mkHist = (id: string, createdAt: number, label: string, uuid: string) => {
      const dir = path.join(root, id);
      fs.mkdirSync(dir, { recursive: true });
      loginFiles(dir, uuid, label);
      store.state.accounts.list.push({ id, label, dir, createdAt });
      return dir;
    };
    // 1) 与默认账号重复的 dupdef01（设为当前活跃 -> 此时默认账号 default 被隐藏，dedupe 时默认账号不可删应计入 skipped）
    const dirDupDef = mkHist('dupdef01', 100, '同默认', 'u-default');
    // 2) u-same 组：保留最早的 keep0001；隐藏可删的 rm000001、执行中的 busy0001、登录中的 login001
    const dirKeep = mkHist('keep0001', 200, '保留早号', 'u-same');
    const dirRm = mkHist('rm000001', 300, '可删重复', 'u-same');
    const dirBusy = mkHist('busy0001', 400, '执行中重复', 'u-same');
    const dirLogin = mkHist('login001', 500, '登录中重复', 'u-same');

    await accounts.setMode('parallel', false);
    await accounts.switchTo('dupdef01', false);
    accounts.bind('s-bound', 'rm000001');
    running['busy0001'] = 1;
    const loginJob = accounts.startLogin({ accountId: 'login001' });

    // 隐藏项：default、rm000001、busy0001、login001 共 4 个
    const before = accounts.list();
    expect(before.list.map((x) => x.id)).toEqual(['dupdef01', 'keep0001']);
    expect(before.duplicates).toBe(4);

    events.length = 0;
    const r1 = await accounts.dedupe();
    expect(r1).toEqual({ removed: 1, skipped: 3 });
    // 可删重复项目录被删、绑定它的会话改用当前账号、触发 reset + refresh
    expect(fs.existsSync(dirRm)).toBe(false);
    expect(store.state.accounts.sessions['s-bound']).toBeUndefined();
    expect(accounts.resolve('s-bound').id).toBe('dupdef01');
    expect(events).toEqual(['reset:rm000001', 'refresh']);
    // 保留显示的条目和被跳过的条目毫发无损
    expect(fs.existsSync(dirDupDef)).toBe(true);
    expect(fs.existsSync(dirKeep)).toBe(true);
    expect(fs.existsSync(dirBusy)).toBe(true);
    expect(fs.existsSync(dirLogin)).toBe(true);
    expect(accounts.list().duplicates).toBe(3);

    // 解除执行中与登录中，再切回默认账号后，剩余 3 个重复项（dupdef01 / busy0001 / login001）均可清掉
    running['busy0001'] = 0;
    accounts.cancelLogin(loginJob.loginId);
    await accounts.switchTo(DEFAULT_ID, false);
    expect(accounts.list().duplicates).toBe(3);

    const r2 = await accounts.dedupe();
    expect(r2).toEqual({ removed: 3, skipped: 0 });
    expect(accounts.list().duplicates).toBeUndefined();
    expect(accounts.list().list.map((x) => x.id)).toEqual([DEFAULT_ID, 'keep0001']);
    expect(fs.existsSync(dirKeep)).toBe(true);
  });

  it('HTTP POST /api/accounts/dedupe 返回 AccountDedupeResult 并同步更新 GET /api/accounts 的 duplicates', async () => {
    loginFiles(base, 'u-default', 'Main');
    const a = makeAccounts();
    const { accounts, store } = a;
    const dirDup = path.join(root, 'httpdup1');
    fs.mkdirSync(dirDup, { recursive: true });
    loginFiles(dirDup, 'u-default', '重复');
    store.state.accounts.list.push({ id: 'httpdup1', label: '重复', dir: dirDup, createdAt: 100 });

    const token = 'test-token-claude';
    let port = 0;
    const handler = createHandler({
      port: () => port,
      version: '0.0.0',
      webDist: null,
      workspaces: new Workspaces(store),
      sessions: {} as any,
      manager: { runningCount: () => 0 } as any,
      account: { get: async () => null },
      usage: { get: async () => null },
      store,
      previews: {} as any,
      pins: {} as any,
      trash: {} as any,
      pricing: { table: () => ({}) as any },
      accounts,
      authToken: token,
    });
    const srv = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as AddressInfo).port;
    const req = async (method: string, urlPath: string, body?: unknown) => {
      const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
        method,
        headers: { 'x-cosyee-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, json: await r.json() };
    };
    try {
      const l0 = await req('GET', '/api/accounts');
      expect(l0.status).toBe(200);
      expect(l0.json.duplicates).toBe(1);

      const d = await req('POST', '/api/accounts/dedupe', {});
      expect(d.status).toBe(200);
      expect(d.json).toEqual({ removed: 1, skipped: 0 });

      const l1 = await req('GET', '/api/accounts');
      expect(l1.status).toBe(200);
      expect(l1.json.duplicates).toBeUndefined();
      expect(fs.existsSync(dirDup)).toBe(false);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
