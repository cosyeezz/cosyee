// Antigravity（agy）多账号：只管理在 Cosyee 里登录的账号，没有默认账号、不探测登录态。
// 覆盖环境变量/参数隔离、登录/取消/超时/判重/重新登录、令牌文件邮箱、移除与 junction 安全、sanitize 兼容与 HTTP 路由。
// 全部使用假 spawn 与临时目录，绝不运行真实 agy 登录或触碰真实 ~/.gemini / 系统凭据库。
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgyAccounts, extractIdentityHash, findAgyLoginUrl, hashEmail, readTokenEmail } from './accounts/agy.js';
import { agyAccountArgs, agyAccountEnv, agyLoginEnv } from './accounts/agy-env.js';
import { type AgyStatus, findLsPort, parseQuota, quotaGroupName } from './accounts/agy-status.js';
import type { AgyQuota } from '@cosyee/shared';
import { createHandler } from './http.js';
import { HttpError, StateStore, Workspaces } from './workspaces.js';

let tmp: string;
let agyRoot: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-agy-acc-'));
  agyRoot = path.join(tmp, 'agy-accounts');
  for (const k of ['COSYEE_HOME', 'COSYEE_AGY_ACCOUNTS_DIR']) saved[k] = process.env[k];
  process.env.COSYEE_HOME = path.join(tmp, 'home');
  process.env.COSYEE_AGY_ACCOUNTS_DIR = agyRoot;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

class FakeLoginProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid: number | undefined = undefined;
  written = '';
  stdinEnded = false;
  killed = false;

  constructor() {
    super();
    this.stdin.on('data', (d: Buffer) => (this.written += d.toString('utf8')));
    this.stdin.on('end', () => { this.stdinEnded = true; });
  }

  exit(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit('close', code);
  }

  kill() {
    this.killed = true;
    this.exit(1);
    return true;
  }
}

const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function makeHarness(opts: {
  agyPath?: string | null;
  running?: Record<string, number>;
  livePids?: (id: string) => number[];
  stopAccount?: (id: string) => boolean;
  loginTimeoutMs?: number;
  probeTimeoutMs?: number;
  liveRetryDelaysMs?: readonly number[];
  now?: () => number;
  probeStatus?: (logDir: string, pid: number | undefined) => Promise<AgyStatus | null>;
  spawnProbe?: (agyPath: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcess;
} = {}) {
  const store = new StateStore(path.join(tmp, 'state.json'));
  const changed = vi.fn();
  const resetAccount = vi.fn();
  const stopAccount = vi.fn(opts.stopAccount ?? (() => true));
  const loginSpawns: { proc: FakeLoginProc; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const probeSpawns: { proc: FakeLoginProc; args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const accounts = new AgyAccounts({
    store,
    running: (id) => opts.running?.[id] ?? 0,
    livePids: opts.livePids,
    stopAccount,
    resetAccount,
    onChanged: changed,
    resolveAgy: () => (opts.agyPath === undefined ? '/fake/agy' : opts.agyPath),
    loginTimeoutMs: opts.loginTimeoutMs,
    probeTimeoutMs: opts.probeTimeoutMs,
    liveRetryDelaysMs: opts.liveRetryDelaysMs,
    now: opts.now,
    probeStatus: opts.probeStatus,
    spawnLogin: (_agyPath, args, env) => {
      const proc = new FakeLoginProc();
      loginSpawns.push({ proc, args, env });
      return proc as unknown as ChildProcess;
    },
    spawnProbe: opts.spawnProbe ?? ((_agyPath, args, env, cwd) => {
      const proc = new FakeLoginProc();
      probeSpawns.push({ proc, args, env, cwd });
      queueMicrotask(() => proc.exit(1));
      return proc as unknown as ChildProcess;
    }),
  });
  return { store, accounts, changed, resetAccount, stopAccount, loginSpawns, probeSpawns };
}

/** 从 --gemini-dir / --app-data-dir 参数解析账号目录 */
function dirFromArgs(args: string[]): string | null {
  const gi = args.indexOf('--gemini-dir');
  const ai = args.indexOf('--app-data-dir');
  if (gi < 0 || ai < 0) return null;
  return path.join(args[gi + 1]!, args[ai + 1]!);
}

/** 与 agy 写出的令牌文件同结构 */
function tokenJson(email: string | null, access = 'secret-token'): string {
  return JSON.stringify({
    token: { access_token: access, token_type: 'Bearer', refresh_token: 'refresh-secret', expiry: '2026-12-01T00:00:00Z' },
    auth_method: 'oauth',
    ...(email ? { id_token_email: email } : {}),
  });
}

/** 完成一次假登录（写令牌文件 + 输出成功邮箱 + 退出码 0），返回登录状态与目录 */
async function completeLogin(
  h: ReturnType<typeof makeHarness>,
  opts: { label?: string; accountId?: string; email?: string; tokenContent?: string; printEmail?: boolean } = {},
) {
  const email = opts.email ?? 'User@Example.COM';
  const login = h.accounts.startLogin({ label: opts.label, accountId: opts.accountId });
  const spawned = h.loginSpawns[h.loginSpawns.length - 1]!;
  spawned.proc.stdout.write(
    'Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=test&state=xyz\n\nThen paste the authorization code:\n',
  );
  await until(() => h.accounts.getLogin(login.loginId).status === 'waiting');
  h.accounts.submitCode(login.loginId, '4/test-auth-code-123456');
  const dir = dirFromArgs(spawned.args);
  if (dir) {
    fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), opts.tokenContent ?? tokenJson(email.trim()));
    fs.writeFileSync(path.join(dir, 'acp-auth-state.json'), JSON.stringify({ ok: true }));
  }
  if (opts.printEmail !== false) spawned.proc.stdout.write(`Successfully authenticated as ${email}.\n`);
  spawned.proc.exit(0);
  await until(() => {
    const s = h.accounts.getLogin(login.loginId).status;
    return s === 'done' || s === 'failed';
  });
  return { login: h.accounts.getLogin(login.loginId), dir, spawned };
}

/** 直接往 state 里放一个账号（模拟历史数据），返回目录 */
function addStored(
  h: ReturnType<typeof makeHarness>,
  id: string,
  createdAt: number,
  o: { identityHash?: string; token?: string | null } = {},
): string {
  const dir = path.join(agyRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  if (o.token !== null) fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), o.token ?? tokenJson(null));
  h.store.state.agyAccounts.list.push({ id, label: id, dir, createdAt, ...(o.identityHash ? { identityHash: o.identityHash } : {}) });
  return dir;
}

const hashOf = (email: string) => extractIdentityHash(`Successfully authenticated as ${email}`)!;

describe('agy-env', () => {
  it('不带目录时不加 FORCE_FILE 与参数；添加账号不改 USERPROFILE/HOME，只加 FORCE_FILE 与 --gemini-dir/--app-data-dir', () => {
    const base = { USERPROFILE: 'C:\\Users\\real', HOME: '/home/real', PATH: '/bin', CLAUDECODE: '1' };
    const defEnv = agyAccountEnv(null, base);
    expect(defEnv.USERPROFILE).toBe('C:\\Users\\real');
    expect(defEnv.HOME).toBe('/home/real');
    expect(defEnv.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined();
    expect(defEnv.SSH_CONNECTION).toBeUndefined();
    expect(defEnv.CLAUDECODE).toBeUndefined();
    expect(agyAccountArgs(null)).toEqual([]);

    const dir = path.join(agyRoot, 'abcd1234');
    const accEnv = agyAccountEnv(dir, base);
    expect(accEnv.USERPROFILE).toBe('C:\\Users\\real');
    expect(accEnv.HOME).toBe('/home/real');
    expect(accEnv.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1');
    expect(accEnv.SSH_CONNECTION).toBeUndefined();
    expect(agyAccountArgs(dir)).toEqual(['--gemini-dir', path.resolve(agyRoot), '--app-data-dir', 'abcd1234']);

    const accLogin = agyLoginEnv(dir, base);
    expect(accLogin.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1');
    expect(accLogin.SSH_CONNECTION).toBe('127.0.0.1 54321 127.0.0.1 22');
  });

  it('findAgyLoginUrl 与 extractIdentityHash（两种成功文案）', () => {
    expect(findAgyLoginUrl('  https://accounts.google.com/o/oauth2/auth?client_id=1&scope=a\n')).toBe(
      'https://accounts.google.com/o/oauth2/auth?client_id=1&scope=a',
    );
    const h1 = extractIdentityHash('Successfully authenticated as Foo@Bar.COM.');
    const h2 = extractIdentityHash('Successfully authenticated as foo@bar.com');
    const h3 = extractIdentityHash('✓ Authenticated successfully as foo@bar.com');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
    expect(h3).toBe(h1);
    expect(hashEmail('FOO@bar.com')).toBe(h1);
    expect(extractIdentityHash('login cancelled: no authorization code was entered')).toBeNull();
  });

  it('readTokenEmail：只认合法 JSON 里的 id_token_email，其它情况返回 null', () => {
    const dir = path.join(tmp, 'tok');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'antigravity-oauth-token');
    expect(readTokenEmail(dir)).toBeNull(); // 没有文件
    fs.writeFileSync(f, tokenJson('Me@Example.com'));
    expect(readTokenEmail(dir)).toBe('Me@Example.com');
    fs.writeFileSync(f, 'not json at all!');
    expect(readTokenEmail(dir)).toBeNull();
    fs.writeFileSync(f, tokenJson(null) + ' ');
    expect(readTokenEmail(dir)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ id_token_email: 'not an email' }));
    expect(readTokenEmail(dir)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ id_token_email: 'big@example.com', pad: 'x'.repeat(70 * 1024) }));
    expect(readTokenEmail(dir)).toBeNull();
    fs.rmSync(f);
    fs.mkdirSync(f); // 不是普通文件
    expect(readTokenEmail(dir)).toBeNull();
  });
});

describe('AgyAccounts 没有账号时', () => {
  it('列表为空、没有当前账号、未登录', () => {
    const h = makeHarness();
    h.accounts.init();
    expect(h.accounts.list()).toEqual({ installed: true, list: [], login: null });
    expect(h.accounts.activeId()).toBeNull();
    expect(h.accounts.activeAccount()).toBeNull();
    expect(h.accounts.activeLoggedIn()).toBe(false);
    expect(h.accounts.accountFor('default')).toBeNull();
    h.accounts.dispose();
  });

  it('agy 未安装：installed=false、list=[]、startLogin 503', () => {
    const h = makeHarness({ agyPath: null });
    expect(h.accounts.list()).toEqual({ installed: false, list: [], login: null });
    expect(() => h.accounts.startLogin({})).toThrow(HttpError);
    try {
      h.accounts.startLogin({});
    } catch (e) {
      expect((e as HttpError).status).toBe(503);
    }
    h.accounts.dispose();
  });
});

describe('AgyAccounts 登录、判重与重新登录', () => {
  it('登录成功：第一个账号自动成为当前账号；列表显示令牌里的邮箱；state.json 不含邮箱/授权码/令牌、只存哈希', async () => {
    const h = makeHarness();
    const r1 = await completeLogin(h, { email: 'Alice@Example.com' });
    expect(r1.login.status).toBe('done');
    const id1 = r1.login.accountId!;
    expect(id1).toBeTruthy();
    expect(r1.spawned.args).toEqual(['acp', '--login', '--gemini-dir', path.resolve(agyRoot), '--app-data-dir', id1]);
    expect(r1.spawned.env.SSH_CONNECTION).toBeTruthy();
    expect(r1.spawned.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1');
    expect(h.accounts.activeId()).toBe(id1);
    expect(h.accounts.activeAccount()).toEqual({ id: id1, dir: r1.dir, label: '' });
    expect(h.accounts.activeLoggedIn()).toBe(true);

    const r2 = await completeLogin(h, { email: 'Bob@Example.com' });
    expect(r2.login.status).toBe('done');
    // 第二个账号不抢当前
    expect(h.accounts.activeId()).toBe(id1);

    const list = h.accounts.list();
    expect(list.installed).toBe(true);
    expect(list.list.map((a) => a.label)).toEqual(['', '']);
    expect(list.list.map((a) => a.email)).toEqual(['Alice@Example.com', 'Bob@Example.com']);
    expect(list.list.map((a) => a.active)).toEqual([true, false]);
    expect(list.list.every((a) => a.loggedIn === true && a.isDefault === false && a.plan === null && a.quota === null)).toBe(true);

    await h.store.idle();
    const state = fs.readFileSync(path.join(tmp, 'state.json'), 'utf8');
    expect(state).not.toContain('Alice');
    expect(state).not.toContain('alice');
    expect(state).not.toContain('Example.com');
    const serialized = JSON.stringify(list) + state;
    expect(serialized).not.toContain('4/test-auth-code');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('refresh-secret');
    expect(h.store.state.agyAccounts.list[0]!.identityHash).toBe(hashOf('alice@example.com'));
    h.accounts.dispose();
  });

  it('授权码错误退出码 1 -> failed 并给出提示、清理临时目录；submitCode 不可重复提交（409）', async () => {
    const h = makeHarness();
    const login = h.accounts.startLogin({});
    const spawned = h.loginSpawns[0]!;
    const dir = dirFromArgs(spawned.args)!;
    spawned.proc.stdout.write('https://accounts.google.com/o/oauth2/auth?x=1\n');
    await until(() => h.accounts.getLogin(login.loginId).status === 'waiting');

    h.accounts.submitCode(login.loginId, 'bad-code');
    expect(() => h.accounts.submitCode(login.loginId, 'second-code')).toThrow(HttpError);
    try {
      h.accounts.submitCode(login.loginId, 'second-code');
    } catch (e) {
      expect((e as HttpError).status).toBe(409);
    }

    spawned.proc.stdout.write(`couldn't log in: token exchange failed: oauth2: "invalid_grant" "Malformed auth code."\n`);
    spawned.proc.exit(1);
    await until(() => h.accounts.getLogin(login.loginId).status === 'failed');
    expect(h.accounts.getLogin(login.loginId).error).toBe('授权码无效或已过期，请重新登录');
    await until(() => !fs.existsSync(dir));
    h.accounts.dispose();
  });

  it('退出码 0 但没写出令牌：不登记账号；没填授权码给出明确提示', async () => {
    const h = makeHarness();
    // 1) agy 提示没填授权码就退出
    const l1 = h.accounts.startLogin({});
    const s1 = h.loginSpawns[0]!;
    const d1 = dirFromArgs(s1.args)!;
    s1.proc.stdout.write('https://accounts.google.com/o/oauth2/auth?x=1\n');
    await until(() => h.accounts.getLogin(l1.loginId).status === 'waiting');
    s1.proc.stdout.write('login cancelled: no authorization code was entered\n');
    s1.proc.exit(0);
    await until(() => h.accounts.getLogin(l1.loginId).status === 'failed');
    expect(h.accounts.getLogin(l1.loginId).error).toBe('没有填写授权码，登录已取消');
    await until(() => !fs.existsSync(d1));

    // 2) 其它原因没有令牌
    const l2 = h.accounts.startLogin({});
    const s2 = h.loginSpawns[1]!;
    s2.proc.exit(0);
    await until(() => h.accounts.getLogin(l2.loginId).status === 'failed');
    expect(h.accounts.getLogin(l2.loginId).error).toBe('登录没有完成');

    expect(h.store.state.agyAccounts.list).toHaveLength(0);
    expect(h.accounts.activeId()).toBeNull();
    h.accounts.dispose();
  });

  it('取消登录：关闭 stdin，失败并清理未登记目录', async () => {
    const h = makeHarness();
    const login = h.accounts.startLogin({});
    const spawned = h.loginSpawns[0]!;
    const dir = dirFromArgs(spawned.args)!;
    expect(fs.existsSync(dir)).toBe(true);

    h.accounts.cancelLogin(login.loginId);
    expect(spawned.proc.stdin.writableEnded).toBe(true);
    expect(h.accounts.getLogin(login.loginId).status).toBe('failed');
    expect(h.accounts.getLogin(login.loginId).error).toBe('已取消');
    spawned.proc.exit(1);
    await until(() => !fs.existsSync(dir));
    h.accounts.dispose();
  });

  it('登录超时：终止进程、failed 并清理目录', async () => {
    const h = makeHarness({ loginTimeoutMs: 40 });
    const login = h.accounts.startLogin({});
    const spawned = h.loginSpawns[0]!;
    const dir = dirFromArgs(spawned.args)!;
    await until(() => h.accounts.getLogin(login.loginId).status === 'failed');
    expect(h.accounts.getLogin(login.loginId).error).toBe('登录超时');
    expect(spawned.proc.killed).toBe(true);
    await until(() => !fs.existsSync(dir));
    h.accounts.dispose();
  });

  it('重新登录不存在的账号 404，accountId 类型不对 400', () => {
    const h = makeHarness();
    expect(() => h.accounts.startLogin({ accountId: 'default' })).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => h.accounts.startLogin({ accountId: 123 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(h.loginSpawns).toHaveLength(0);
    h.accounts.dispose();
  });

  it('重复账号：相同邮箱（忽略大小写）拒绝添加并清理新目录', async () => {
    const h = makeHarness();
    const r1 = await completeLogin(h, { email: 'dup@example.com' });
    expect(r1.login.status).toBe('done');

    const r2 = await completeLogin(h, { email: '  DUP@EXAMPLE.COM ' });
    expect(r2.login.status).toBe('failed');
    expect(r2.login.error).toBe('这个账号已经添加过了');
    expect(h.store.state.agyAccounts.list).toHaveLength(1);
    await until(() => !fs.existsSync(r2.dir!));
    h.accounts.dispose();
  });

  it('登录输出没有邮箱时用令牌文件里的邮箱算哈希并拦截重复添加', async () => {
    const h = makeHarness();
    const r1 = await completeLogin(h, { email: 'Fallback@Example.com', printEmail: false });
    expect(r1.login.status).toBe('done');
    expect(h.store.state.agyAccounts.list[0]!.identityHash).toBe(hashOf('fallback@example.com'));

    const r2 = await completeLogin(h, { email: 'fallback@example.com', printEmail: false });
    expect(r2.login.status).toBe('failed');
    expect(r2.login.error).toBe('这个账号已经添加过了');
    expect(h.store.state.agyAccounts.list).toHaveLength(1);
    await until(() => !fs.existsSync(r2.dir!));
    h.accounts.dispose();
  });

  it('重新登录：成功只替换令牌与认证状态文件，保留 conversations/ 且更新哈希；失败不破坏原目录', async () => {
    const h = makeHarness();
    const r1 = await completeLogin(h, { email: 'a@example.com', tokenContent: 'old-token' });
    const id = r1.login.accountId!;
    const accDir = r1.dir!;
    const convFile = path.join(accDir, 'conversations', 'c1.json');
    fs.mkdirSync(path.dirname(convFile), { recursive: true });
    fs.writeFileSync(convFile, '{"keep":true}');

    // 添加第二个账号用于测试重复冲突
    await completeLogin(h, { email: 'b@example.com' });

    // 1) 重新登录成另一个已添加的账号 -> 失败且不破坏原目录
    const failDup = await completeLogin(h, { accountId: id, email: 'b@example.com', tokenContent: 'bad-token' });
    expect(failDup.login.status).toBe('failed');
    expect(failDup.login.error).toBe('这个账号已经添加过了');
    expect(fs.readFileSync(path.join(accDir, 'antigravity-oauth-token'), 'utf8')).toBe('old-token');
    expect(fs.readFileSync(convFile, 'utf8')).toBe('{"keep":true}');
    await until(() => !fs.existsSync(failDup.dir!));

    // 2) 重新登录成新邮箱 -> 成功，令牌更新、conversations 保留、哈希更新、调用 resetAccount、临时目录删除
    const ok = await completeLogin(h, { accountId: id, email: 'c@example.com', tokenContent: 'new-token' });
    expect(ok.login.status).toBe('done');
    expect(h.resetAccount).toHaveBeenCalledWith(id);
    expect(fs.readFileSync(path.join(accDir, 'antigravity-oauth-token'), 'utf8')).toBe('new-token');
    expect(fs.readFileSync(convFile, 'utf8')).toBe('{"keep":true}');
    expect(h.store.state.agyAccounts.list.find((x) => x.id === id)!.identityHash).toBe(hashOf('c@example.com'));
    await until(() => !fs.existsSync(ok.dir!));
    h.accounts.dispose();
  });

  it('已有账号重新登录：replaceAuthFiles 成功前后各调用一次 resetAccount', async () => {
    const h = makeHarness();
    const r1 = await completeLogin(h, { email: 'reset@example.com', tokenContent: 'old-tok' });
    const id = r1.login.accountId!;
    h.resetAccount.mockClear();

    const r2 = await completeLogin(h, { accountId: id, email: 'reset@example.com', tokenContent: 'new-tok' });
    expect(r2.login.status).toBe('done');
    const callsForId = h.resetAccount.mock.calls.filter(([arg]) => arg === id);
    expect(callsForId).toHaveLength(2);
    h.accounts.dispose();
  });

  it('错误文案不自带「登录失败：」前缀，无可用末行时给出简短中文原因', async () => {
    const h = makeHarness();

    const l1 = h.accounts.startLogin({});
    const s1 = h.loginSpawns[0]!;
    s1.proc.stdout.write('some unexpected cli error\n');
    s1.proc.exit(1);
    await until(() => h.accounts.getLogin(l1.loginId).status === 'failed');
    const err1 = h.accounts.getLogin(l1.loginId).error!;
    expect(err1).toBe('some unexpected cli error');
    expect(err1).not.toMatch(/^登录失败/);

    const l2 = h.accounts.startLogin({});
    const s2 = h.loginSpawns[1]!;
    s2.proc.exit(1);
    await until(() => h.accounts.getLogin(l2.loginId).status === 'failed');
    const err2 = h.accounts.getLogin(l2.loginId).error!;
    expect(err2).not.toMatch(/^登录失败/);
    expect(err2.length).toBeGreaterThan(0);
    h.accounts.dispose();
  });
});

describe('AgyAccounts 切换、移除与启动整理', () => {
  it('switchTo：不存在 404、目录没了 410、没有令牌 400', async () => {
    const h = makeHarness();
    const ok = addStored(h, 'aaaa1111', 1);
    addStored(h, 'bbbb2222', 2, { token: null });
    const gone = addStored(h, 'cccc3333', 3);
    fs.rmSync(gone, { recursive: true, force: true });

    await expect(h.accounts.switchTo('nope0000')).rejects.toMatchObject({ status: 404 });
    await expect(h.accounts.switchTo('cccc3333')).rejects.toMatchObject({ status: 410 });
    await expect(h.accounts.switchTo('bbbb2222')).rejects.toMatchObject({ status: 400, message: '该账号还没有登录' });
    await h.accounts.switchTo('aaaa1111');
    expect(h.accounts.activeAccount()).toMatchObject({ id: 'aaaa1111', dir: ok });
    expect(h.accounts.list().list.find((a) => a.id === 'bbbb2222')!.loggedIn).toBe(false);
    h.accounts.dispose();
  });

  it('init()：没有记录当前账号时取第一个；记录的当前账号已不存在时同样回落', async () => {
    const h = makeHarness();
    addStored(h, 'aaaa1111', 1);
    addStored(h, 'bbbb2222', 2);
    h.store.state.agyAccounts.active = null;
    h.accounts.init();
    expect(h.store.state.agyAccounts.active).toBe('aaaa1111');
    expect(h.accounts.activeId()).toBe('aaaa1111');

    h.store.state.agyAccounts.active = 'gone0000';
    expect(h.accounts.activeId()).toBe('aaaa1111');
    h.accounts.dispose();
  });

  it('init() 清理遗留的超过 1 小时的未登记目录，不碰 1 小时内、已登记目录与 symlink', async () => {
    const now = 10_000_000;
    const h = makeHarness({ now: () => now });
    fs.mkdirSync(agyRoot, { recursive: true });
    const oldOrphan = path.join(agyRoot, 'aaaa1111');
    const freshOrphan = path.join(agyRoot, 'bbbb2222');
    const nonIdDir = path.join(agyRoot, 'not_an_id!');
    const outside = path.join(tmp, 'outside-target');
    fs.mkdirSync(oldOrphan);
    fs.mkdirSync(freshOrphan);
    fs.mkdirSync(nonIdDir);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'keep.txt'), 'safe');
    const linkDir = path.join(agyRoot, 'cccc3333');
    fs.symlinkSync(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    const registered = addStored(h, 'dddd4444', 1);

    const oldTime = new Date(now - 2 * 60 * 60_000);
    const freshTime = new Date(now - 10 * 60_000);
    fs.utimesSync(oldOrphan, oldTime, oldTime);
    fs.utimesSync(freshOrphan, freshTime, freshTime);
    fs.utimesSync(registered, oldTime, oldTime);

    h.accounts.init();
    await until(() => !fs.existsSync(oldOrphan));
    expect(fs.existsSync(freshOrphan)).toBe(true);
    expect(fs.existsSync(nonIdDir)).toBe(true);
    expect(fs.existsSync(registered)).toBe(true);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    h.accounts.dispose();
  });

  it('移除：登录中 / 执行中 409；当前账号可以移除并自动换到下一个；junction/symlink 安全删除', async () => {
    const running: Record<string, number> = {};
    const h = makeHarness({ running });
    const r = await completeLogin(h, { email: 'rem@example.com' });
    const id = r.login.accountId!;
    const accDir = r.dir!;
    const r2 = await completeLogin(h, { email: 'next@example.com' });
    const id2 = r2.login.accountId!;
    expect(h.accounts.activeId()).toBe(id);

    await expect(h.accounts.remove('nope0000')).rejects.toMatchObject({ status: 404 });

    // 执行中任务 409
    running[id] = 1;
    await expect(h.accounts.remove(id)).rejects.toMatchObject({ status: 409 });
    running[id] = 0;

    // 正在重新登录 409
    const relogin = h.accounts.startLogin({ accountId: id });
    await expect(h.accounts.remove(id)).rejects.toMatchObject({ status: 409 });
    h.accounts.cancelLogin(relogin.loginId);
    h.loginSpawns[h.loginSpawns.length - 1]!.proc.exit(1);

    // 在账号目录内放一个指向外部目录的 junction/symlink，确保删除账号时绝不删除外部目标内容
    const external = path.join(tmp, 'external-precious');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'secret.txt'), 'do-not-delete');
    fs.symlinkSync(external, path.join(accDir, 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir');

    h.changed.mockClear();
    await h.accounts.remove(id);
    expect(h.stopAccount).toHaveBeenCalledWith(id);
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(accDir)).toBe(false);
    expect(fs.readFileSync(path.join(external, 'secret.txt'), 'utf8')).toBe('do-not-delete');
    expect(h.accounts.activeId()).toBe(id2);
    expect(h.store.state.agyAccounts.active).toBe(id2);

    // 移除最后一个：列表为空、没有当前账号
    await h.accounts.remove(id2);
    expect(h.accounts.list().list).toEqual([]);
    expect(h.accounts.activeId()).toBeNull();
    expect(h.store.state.agyAccounts.active).toBeNull();
    h.accounts.dispose();
  });
});

describe('StateStore sanitize 兼容旧 state.json', () => {
  it('旧 state.json 无 agyAccounts 正常加载；过滤非法 id、相对路径、重复目录、无效 active 与非法哈希', () => {
    const file = path.join(tmp, 'old-state.json');
    fs.writeFileSync(file, JSON.stringify({ workspaces: [], current: null }));
    const s1 = new StateStore(file);
    expect(s1.state.agyAccounts).toEqual({ list: [], active: null });

    const dir1 = path.join(agyRoot, 'aaaa1111');
    const dir2 = path.join(agyRoot, 'bbbb2222');
    fs.writeFileSync(
      file,
      JSON.stringify({
        agyAccounts: {
          active: 'nonexistent',
          list: [
            { id: 'bad/id', label: 'x', dir: dir1, createdAt: 1 },
            { id: 'aaaa1111', label: 'A', dir: 'relative/path', createdAt: 1 },
            { id: 'aaaa1111', label: 'A', dir: dir1, createdAt: 10, identityHash: 'a'.repeat(64) },
            { id: 'cccc3333', label: 'dup-dir', dir: dir1, createdAt: 20 },
            { id: 'bbbb2222', label: 'B', dir: dir2, createdAt: 30, identityHash: 'not-a-hash' },
          ],
        },
      }),
    );
    const s2 = new StateStore(file);
    expect(s2.state.agyAccounts.active).toBeNull();
    expect(s2.state.agyAccounts.list).toEqual([
      { id: 'aaaa1111', label: 'A', dir: dir1, createdAt: 10, identityHash: 'a'.repeat(64) },
      { id: 'bbbb2222', label: 'B', dir: dir2, createdAt: 30 },
    ]);
  });
});

function startHttp(h: ReturnType<typeof makeHarness>, token: string) {
  let port = 0;
  const handler = createHandler({
    port: () => port,
    version: '0.0.0',
    webDist: null,
    workspaces: new Workspaces(h.store),
    sessions: {} as any,
    manager: { runningCount: () => 0 } as any,
    account: { get: async () => null },
    usage: { get: async () => null },
    store: h.store,
    previews: {} as any,
    pins: {} as any,
    trash: {} as any,
    pricing: { table: () => ({}) as any },
    agyAccounts: h.accounts,
    authToken: token,
  });
  const srv = http.createServer((req, res) => void handler(req, res));
  const ready = new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => {
    port = (srv.address() as AddressInfo).port;
    r();
  }));
  const req = async (method: string, urlPath: string, body?: unknown, withToken = true) => {
    const r = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(withToken ? { 'x-cosyee-token': token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: await r.json() };
  };
  const close = () => new Promise<void>((r) => srv.close(() => r()));
  return { ready, req, close };
}

describe('HTTP /api/agy-accounts 路由', () => {
  it('完整覆盖 GET/POST 路由与 authToken 鉴权', async () => {
    const h = makeHarness();
    const s = startHttp(h, 'test-secret-token');
    await s.ready;
    const { req } = s;
    try {
      // 无令牌 403
      expect((await req('GET', '/api/agy-accounts', undefined, false)).status).toBe(403);

      // 没有账号时列表为空
      const l0 = await req('GET', '/api/agy-accounts');
      expect(l0.status).toBe(200);
      expect(l0.json).toEqual({ installed: true, list: [], login: null });

      // 登录 -> 查进度 -> 提交授权码 -> 完成
      const start = await req('POST', '/api/agy-accounts/login', { label: '工作' });
      expect(start.status).toBe(200);
      const loginId = start.json.loginId as string;
      const spawned = h.loginSpawns[0]!;
      spawned.proc.stdout.write('https://accounts.google.com/o/oauth2/auth?s=1\n');
      await until(() => h.accounts.getLogin(loginId).status === 'waiting');

      const poll = await req('GET', `/api/agy-accounts/login/${loginId}`);
      expect(poll.status).toBe(200);
      expect(poll.json.status).toBe('waiting');

      const submit = await req('POST', `/api/agy-accounts/login/${loginId}/code`, { code: '4/code-ok' });
      expect(submit.status).toBe(200);
      const accDir = dirFromArgs(spawned.args)!;
      fs.writeFileSync(path.join(accDir, 'antigravity-oauth-token'), tokenJson('http@example.com'));
      spawned.proc.stdout.write('Successfully authenticated as http@example.com.\n');
      spawned.proc.exit(0);
      await until(() => h.accounts.getLogin(loginId).status === 'done');
      const accId = h.accounts.getLogin(loginId).accountId!;

      const l1 = await req('GET', '/api/agy-accounts');
      expect(l1.json.list).toHaveLength(1);
      expect(l1.json.list[0]).toMatchObject({ id: accId, label: '工作', active: true, loggedIn: true, email: 'http@example.com' });

      // 改备注名
      expect((await req('POST', '/api/agy-accounts/label', { id: accId, label: '新备注' })).status).toBe(200);
      expect(h.accounts.list().list.find((a) => a.id === accId)!.label).toBe('新备注');

      // 切换账号
      expect((await req('POST', '/api/agy-accounts/switch', { id: accId })).status).toBe(200);
      expect(h.accounts.activeId()).toBe(accId);
      // 缺少 id 400
      expect((await req('POST', '/api/agy-accounts/switch', {})).status).toBe(400);

      // 当前账号也能移除
      expect((await req('POST', '/api/agy-accounts/remove', { id: accId })).status).toBe(200);
      expect((await req('GET', '/api/agy-accounts')).json.list).toEqual([]);

      // 取消登录路由
      const start2 = await req('POST', '/api/agy-accounts/login', {});
      const cancel = await req('POST', `/api/agy-accounts/login/${start2.json.loginId}/cancel`);
      expect(cancel.status).toBe(200);
      h.loginSpawns[1]!.proc.exit(1);
    } finally {
      h.accounts.dispose();
      await s.close();
    }
  });

  it('POST /api/agy-accounts/dedupe 返回 AccountDedupeResult 并更新 duplicates', async () => {
    const h = makeHarness();
    const dupHash = hashOf('same@example.com');
    const dirKeep = addStored(h, 'keep0001', 100, { identityHash: dupHash });
    const dirDup = addStored(h, 'dup00001', 200, { identityHash: dupHash });
    const s = startHttp(h, 'test-token-agy-dedupe');
    await s.ready;
    try {
      const l0 = await s.req('GET', '/api/agy-accounts');
      expect(l0.status).toBe(200);
      expect(l0.json.duplicates).toBe(1);

      const d = await s.req('POST', '/api/agy-accounts/dedupe', {});
      expect(d.status).toBe(200);
      expect(d.json).toEqual({ removed: 1, skipped: 0 });

      const l1 = await s.req('GET', '/api/agy-accounts');
      expect(l1.status).toBe(200);
      expect(l1.json.duplicates).toBeUndefined();
      expect(fs.existsSync(dirKeep)).toBe(true);
      expect(fs.existsSync(dirDup)).toBe(false);
    } finally {
      h.accounts.dispose();
      await s.close();
    }
  });
});

describe('历史重复条目', () => {
  it('list() 去重显示（当前 > 最早），没有哈希的按令牌邮箱判断，不静默删目录', async () => {
    const h = makeHarness();
    const dupHash = hashOf('same@example.com');
    addStored(h, 'early001', 200, { identityHash: dupHash });
    const dirLate = addStored(h, 'late0001', 300, { token: tokenJson('Same@Example.com') }); // 旧数据：没有 identityHash
    addStored(h, 'other001', 400, { token: tokenJson('other@example.com') });
    h.accounts.init();

    // 当前是 early001：隐藏 late0001
    expect(h.accounts.list().list.map((x) => x.id)).toEqual(['early001', 'other001']);
    expect(h.accounts.list().duplicates).toBe(1);
    expect(fs.existsSync(dirLate)).toBe(true);
    expect(h.store.state.agyAccounts.list).toHaveLength(3);

    // 切到 late0001 后，当前账号优先显示（隐藏 early001）
    await h.accounts.switchTo('late0001');
    expect(h.accounts.list().list.map((x) => x.id)).toEqual(['late0001', 'other001']);
    expect(h.accounts.list().list.find((x) => x.id === 'late0001')?.active).toBe(true);

    // 隐藏的重复条目仍可显式移除
    await h.accounts.remove('early001');
    expect(h.accounts.list().duplicates).toBeUndefined();
    h.accounts.dispose();
  });

  it('dedupe()：删掉可删重复项，跳过登录中 / 有执行中委派任务的，绝不碰保留项', async () => {
    const running: Record<string, number> = {};
    const h = makeHarness({ running });
    expect(h.accounts.list().duplicates).toBeUndefined();
    expect(await h.accounts.dedupe()).toEqual({ removed: 0, skipped: 0 });

    const dupHash = hashOf('same@example.com');
    const dirKeep = addStored(h, 'keep0001', 200, { identityHash: dupHash });
    const dirRm = addStored(h, 'rm000001', 300, { identityHash: dupHash });
    const dirBusy = addStored(h, 'busy0001', 400, { identityHash: dupHash });
    const dirLogin = addStored(h, 'login001', 500, { identityHash: dupHash });
    h.accounts.init();
    running['busy0001'] = 1;
    const loginJob = h.accounts.startLogin({ accountId: 'login001' });

    const before = h.accounts.list();
    expect(before.list.map((x) => x.id)).toEqual(['keep0001']);
    expect(before.duplicates).toBe(3);

    h.changed.mockClear();
    const r1 = await h.accounts.dedupe();
    expect(r1).toEqual({ removed: 1, skipped: 2 });
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dirRm)).toBe(false);
    expect(fs.existsSync(dirKeep)).toBe(true);
    expect(fs.existsSync(dirBusy)).toBe(true);
    expect(fs.existsSync(dirLogin)).toBe(true);

    running['busy0001'] = 0;
    h.accounts.cancelLogin(loginJob.loginId);
    h.loginSpawns[h.loginSpawns.length - 1]!.proc.exit(1);
    await tick();
    const r2 = await h.accounts.dedupe();
    expect(r2).toEqual({ removed: 2, skipped: 0 });
    expect(h.accounts.list().duplicates).toBeUndefined();
    expect(h.accounts.list().list.map((x) => x.id)).toEqual(['keep0001']);
    expect(fs.existsSync(dirKeep)).toBe(true);
    h.accounts.dispose();
  });
});

describe('agy-status 解析', () => {
  it('findLsPort：只认该 pid 的 acp-server 日志里的 HTTP 端口（不是 HTTPS）', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'log-'));
    fs.writeFileSync(path.join(dir, 'acp-server-20261124_170404-111.log'),
      'I1124 server.go:1308] Language server listening on random port at 53867 for HTTPS (gRPC)\n'
      + 'I1124 server.go:1316] Language server listening on random port at 53868 for HTTP\n');
    fs.writeFileSync(path.join(dir, 'acp-server-20261124_170404-222.log'), 'listening on random port at 1 for HTTP\n');
    expect(findLsPort(dir, 111)).toBe(53868);
    expect(findLsPort(dir, 333)).toBeNull();
    expect(findLsPort(dir, undefined)).toBeNull();
    expect(findLsPort(path.join(dir, 'missing'), 111)).toBeNull();
  });

  it('parseQuota：剩余比例换成已用百分比，5 小时在前，省略的 remainingFraction 视为用完', () => {
    const q = parseQuota({ response: { groups: [
      { displayName: 'Gemini Models', buckets: [
        { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.75, resetTime: '2026-12-02T02:17:08Z' },
        { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.12, resetTime: '2026-11-25T07:17:08Z' },
      ] },
      { displayName: 'Claude and GPT models', buckets: [{ bucketId: '3p-5h', window: '5h' }] },
      { displayName: 'empty', buckets: [] },
    ] } }, 42)!;
    expect(q.at).toBe(42);
    expect(q.groups.map((g) => g.name)).toEqual(['Gemini', 'Claude · GPT']);
    expect(q.groups[0]!.buckets).toEqual([
      { window: '5h', percent: 88, severity: 'warning', resetsAt: Date.parse('2026-11-25T07:17:08Z') },
      { window: 'weekly', percent: 25, severity: 'normal', resetsAt: Date.parse('2026-12-02T02:17:08Z') },
    ]);
    expect(q.groups[1]!.buckets[0]).toMatchObject({ percent: 100, severity: 'critical', resetsAt: null });
    expect(parseQuota({}, 1)).toBeNull();
    expect(quotaGroupName('Gemini Models')).toBe('Gemini');
  });
});

function sampleQuota(percent: number, at: number): AgyQuota {
  return {
    at,
    groups: [{ name: 'Gemini', buckets: [{ window: '5h', percent, severity: percent >= 80 ? 'warning' : 'normal', resetsAt: at + 3_600_000 }] }],
  };
}

/** 构造自动响应 initialize + session/new 的假探测进程 */
function makeAutoProbeProc(opts: {
  sessionId?: string;
  tierName?: string | null;
  hang?: boolean;
  onSessionNew?: () => void;
} = {}): FakeLoginProc {
  const proc = new FakeLoginProc();
  let buf = '';
  proc.stdin.on('data', (d: Buffer) => {
    buf += d.toString('utf8');
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line || opts.hang) continue;
      const m = JSON.parse(line) as { id?: number; method?: string };
      if (m.method === 'initialize') {
        proc.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
      } else if (m.method === 'session/new') {
        opts.onSessionNew?.();
        proc.stdout.write(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            result: {
              sessionId: opts.sessionId ?? '11111111-2222-4333-8444-555555555555',
              ...(opts.tierName !== undefined ? { _meta: { antigravity: { tier: { name: opts.tierName } } } } : {}),
            },
          }) + '\n',
        );
      }
    }
  });
  return proc;
}

describe('AgyAccounts 额度与账号信息刷新', () => {
  it('有存活委派进程时：list 优先直接读其 language server（不起探测进程），更新额度并触发 onChanged；90 秒内不重复刷新，超时后再刷', async () => {
    let clock = 1_000_000;
    let pct = 20;
    const probeStatus = vi.fn(async (_logDir: string, pid: number | undefined): Promise<AgyStatus | null> => {
      if (pid !== 7777) return null;
      return { email: 'live@example.com', quota: sampleQuota(pct, clock) };
    });
    const spawnProbe = vi.fn(() => makeAutoProbeProc() as unknown as ChildProcess);
    const h = makeHarness({
      now: () => clock,
      livePids: (id) => (id === 'acc00001' ? [7777] : []),
      probeStatus,
      spawnProbe,
    });
    const dir = addStored(h, 'acc00001', 1, { token: tokenJson('tok@example.com') });

    // 首次 list 不阻塞，立即返回 quota=null，后台异步刷新
    const l0 = h.accounts.list();
    expect(l0.list[0]!.quota).toBeNull();
    expect(l0.list[0]!.email).toBe('tok@example.com');
    await until(() => h.accounts.list().list[0]!.quota !== null);

    expect(spawnProbe).not.toHaveBeenCalled();
    expect(probeStatus).toHaveBeenCalledTimes(1);
    expect(probeStatus).toHaveBeenCalledWith(path.join(dir, 'log'), 7777);
    expect(h.changed).toHaveBeenCalledTimes(1);
    const l1 = h.accounts.list();
    // 邮箱仍以令牌文件为准
    expect(l1.list[0]!.email).toBe('tok@example.com');
    expect(l1.list[0]!.quota?.groups[0]!.buckets[0]!.percent).toBe(20);

    // 90 秒内再调用 list / list({ refresh: true }) 都不重复刷新
    clock += 89_000;
    h.accounts.list();
    h.accounts.list({ refresh: true });
    await tick();
    expect(probeStatus).toHaveBeenCalledTimes(1);

    // 超过 90 秒后再次刷新，额度变化触发 onChanged
    clock += 2_000;
    pct = 45;
    h.accounts.list();
    await until(() => h.accounts.list().list[0]!.quota?.groups[0]!.buckets[0]!.percent === 45);
    expect(probeStatus).toHaveBeenCalledTimes(2);
    expect(h.changed).toHaveBeenCalledTimes(2);
    expect(spawnProbe).not.toHaveBeenCalled();
    h.accounts.dispose();
  });

  it('无存活委派进程时：后台起探测进程拿到 plan/email/quota 并清理探测空会话；同账号并发去重；未登录/未安装不探测', async () => {
    let clock = 2_000_000;
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    let accDir = '';
    const spawnProbe = vi.fn(() => {
      const p = makeAutoProbeProc({
        sessionId: sid,
        tierName: 'Google AI Pro',
        onSessionNew: () => {
          fs.mkdirSync(path.join(accDir, 'conversations'), { recursive: true });
          fs.writeFileSync(path.join(accDir, 'conversations', `${sid}.db`), 'x');
          fs.writeFileSync(path.join(accDir, 'conversations', `${sid}.db-wal`), 'x');
          fs.mkdirSync(path.join(accDir, 'brain', sid), { recursive: true });
          fs.writeFileSync(path.join(accDir, 'brain', sid, 'meta.json'), '{}');
        },
      });
      return p as unknown as ChildProcess;
    });
    const probeStatus = vi.fn(async () => ({ email: 'probed@example.com', quota: sampleQuota(60, clock) }));
    const h = makeHarness({
      now: () => clock,
      livePids: () => [],
      spawnProbe,
      probeStatus,
    });
    // 无令牌邮箱的已登录账号 + 未登录账号
    accDir = addStored(h, 'acc00002', 1, { token: tokenJson(null) });
    addStored(h, 'off00001', 2, { token: null });

    // 连续多次并发 list 只启动 1 次探测，且不探测未登录账号
    h.accounts.list();
    h.accounts.list({ refresh: true });
    await until(() => h.accounts.list().list.find((a) => a.id === 'acc00002')?.quota !== null);
    await h.accounts.waitCleanups();

    expect(spawnProbe).toHaveBeenCalledTimes(1);
    const entry = h.accounts.list().list.find((a) => a.id === 'acc00002')!;
    expect(entry.plan).toBe('Google AI Pro');
    expect(entry.email).toBe('probed@example.com');
    expect(entry.quota?.groups[0]!.buckets[0]!.percent).toBe(60);
    expect(entry.loggedIn).toBe(true);
    expect(h.accounts.list().list.find((a) => a.id === 'off00001')!.loggedIn).toBe(false);
    // 探测空会话已清理
    expect(fs.existsSync(path.join(accDir, 'conversations', `${sid}.db`))).toBe(false);
    expect(fs.existsSync(path.join(accDir, 'conversations', `${sid}.db-wal`))).toBe(false);
    expect(fs.existsSync(path.join(accDir, 'brain', sid))).toBe(false);

    // 90 秒后：不带 refresh 不重新探测（走 30 分钟 TTL）；带 refresh=true 才重探
    clock += 95_000;
    h.accounts.list();
    await tick();
    expect(spawnProbe).toHaveBeenCalledTimes(1);

    h.accounts.list({ refresh: true });
    await until(() => spawnProbe.mock.calls.length === 2);
    await h.accounts.waitCleanups();

    // 未安装 agy 时不探测
    const hNoAgy = makeHarness({ agyPath: null, spawnProbe, probeStatus });
    addStored(hNoAgy, 'acc00003', 1);
    expect(hNoAgy.accounts.list()).toEqual({ installed: false, list: [], login: null });
    await tick();
    expect(spawnProbe).toHaveBeenCalledTimes(2);

    h.accounts.dispose();
    hNoAgy.accounts.dispose();
  });

  it('读取失败保留旧缓存不报错；移除账号清缓存；dispose 终止进行中的探测进程', async () => {
    let clock = 3_000_000;
    let shouldFail = false;
    const probeStatus = vi.fn(async () => {
      if (shouldFail) return null;
      return { email: null, quota: sampleQuota(35, clock) };
    });
    const h = makeHarness({
      now: () => clock,
      livePids: (id) => (id === 'acc00004' ? [8888] : []),
      probeStatus,
    });
    addStored(h, 'acc00004', 1);

    h.accounts.list();
    await until(() => h.accounts.list().list[0]!.quota?.groups[0]!.buckets[0]!.percent === 35);

    // 下次刷新失败：保留旧缓存，不报错，不触发 onChanged
    h.changed.mockClear();
    shouldFail = true;
    clock += 100_000;
    h.accounts.list({ refresh: true });
    await until(() => probeStatus.mock.calls.length === 2);
    await tick();
    expect(h.accounts.list().list[0]!.quota?.groups[0]!.buckets[0]!.percent).toBe(35);
    expect(h.changed).not.toHaveBeenCalled();

    // 移除账号清空缓存（重新加回同 id 时不再有旧额度）
    await h.accounts.remove('acc00004');
    addStored(h, 'acc00004', 2);
    expect(h.accounts.list().list[0]!.quota).toBeNull();
    h.accounts.dispose();

    // dispose 杀掉挂起的探测进程
    let hangingProc: FakeLoginProc | null = null;
    const h2 = makeHarness({
      livePids: () => [],
      spawnProbe: () => {
        hangingProc = makeAutoProbeProc({ hang: true });
        return hangingProc as unknown as ChildProcess;
      },
    });
    addStored(h2, 'acc00005', 1);
    h2.accounts.list();
    await until(() => hangingProc !== null);
    h2.accounts.dispose();
    expect(hangingProc!.killed).toBe(true);
  });

  it('refreshFromLiveProc：进程刚就绪端口未写出时短延迟重试成功，委派结束时无视 90s TTL 立即刷新', async () => {
    let clock = 4_000_000;
    let attempt = 0;
    const probeStatus = vi.fn(async () => {
      attempt++;
      if (attempt === 1) return null; // 模拟日志里还没写出 language server 端口
      return { email: null, quota: sampleQuota(attempt === 2 ? 15 : 55, clock) };
    });
    const h = makeHarness({
      now: () => clock,
      livePids: () => [9999],
      liveRetryDelaysMs: [10, 20],
      probeStatus,
    });
    addStored(h, 'acc00006', 1);

    await h.accounts.refreshFromLiveProc('acc00006', 9999, { retry: true });
    expect(probeStatus).toHaveBeenCalledTimes(2);
    expect(h.accounts.list().list[0]!.quota?.groups[0]!.buckets[0]!.percent).toBe(15);

    // 紧接着一轮委派结束（未满 90s），立即刷新到最新额度
    clock += 5_000;
    await h.accounts.refreshFromLiveProc('acc00006');
    expect(probeStatus).toHaveBeenCalledTimes(3);
    expect(h.accounts.list().list[0]!.quota?.groups[0]!.buckets[0]!.percent).toBe(55);
    h.accounts.dispose();
  });

  it('HTTP GET /api/agy-accounts?refresh=1 触发超时账号刷新', async () => {
    let clock = 5_000_000;
    let pct = 10;
    const spawnProbe = vi.fn(() => makeAutoProbeProc({ tierName: 'Pro' }) as unknown as ChildProcess);
    const probeStatus = vi.fn(async () => ({ email: null, quota: sampleQuota(pct, clock) }));
    const h = makeHarness({ now: () => clock, livePids: () => [], spawnProbe, probeStatus });
    addStored(h, 'acc00007', 1);
    const s = startHttp(h, 'tok-refresh');
    await s.ready;
    try {
      await s.req('GET', '/api/agy-accounts');
      await until(() => h.accounts.list().list[0]!.quota?.groups[0]!.buckets[0]!.percent === 10);
      await h.accounts.waitCleanups();

      clock += 95_000;
      pct = 77;
      await s.req('GET', '/api/agy-accounts?refresh=1');
      await until(() => h.accounts.list().list[0]!.quota?.groups[0]!.buckets[0]!.percent === 77);
      await h.accounts.waitCleanups();
      expect(spawnProbe).toHaveBeenCalledTimes(2);
    } finally {
      h.accounts.dispose();
      await s.close();
    }
  });
});
