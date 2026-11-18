// 多账号：共享链接、MCP 三方同步、切换 / 登录流程。全部用临时目录，不碰真实的 ~/.claude。
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Accounts, DEFAULT_ID, RunningError, findLoginUrl, stripAnsi } from './accounts/index.js';
import { ensureLinks, unlinkShared } from './accounts/links.js';
import { syncMcp } from './accounts/mcp-sync.js';
import { claudeEnv } from './claude/bin.js';
import { activeConfigDir, projectsDir, setActiveConfigDir } from './paths.js';
import { StateStore } from './workspaces.js';

let tmp: string;
let base: string;
let root: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-acc-'));
  base = path.join(tmp, 'claude');
  root = path.join(tmp, 'accounts');
  fs.mkdirSync(base, { recursive: true });
  for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_ACCOUNTS_DIR']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.COSYEE_ACCOUNTS_DIR = root;
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

  it('stripAnsi / findLoginUrl', () => {
    expect(stripAnsi('\x1b[1mA\x1b[0m')).toBe('A');
    expect(findLoginUrl('go http://evil/oauth/authorize?x')).toBeNull();
    expect(findLoginUrl('url: https://claude.com/cai/oauth/authorize?a=1&b=2 then')).toBe('https://claude.com/cai/oauth/authorize?a=1&b=2');
  });
});
