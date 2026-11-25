// Antigravity（agy）多账号：环境变量/参数隔离、登录/重试/取消/超时/判重/重新登录、探测与缓存、移除与 junction 安全、sanitize 兼容与 HTTP 路由。
// 全部使用假 spawn 与临时目录，绝不运行真实 agy 登录或触碰真实 ~/.gemini / 系统凭据库。
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgyAccounts, extractIdentityHash, findAgyLoginUrl } from './accounts/agy.js';
import { agyAccountArgs, agyAccountEnv, agyLoginEnv, agyProbeArgs } from './accounts/agy-env.js';
import { type AgyStatus, findLsPort, parseQuota, quotaGroupName } from './accounts/agy-status.js';
import { DEFAULT_ID } from './accounts/index.js';
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

type ProbeBehavior =
  | { kind: 'ok'; plan?: string | null; sessionId?: string; onSessionNew?: (args: string[]) => void; onMessage?: (m: any) => void }
  | { kind: 'unauth'; viaStderr?: boolean }
  | { kind: 'error'; message?: string }
  | { kind: 'hang' }
  | { kind: 'manual'; onReady: (ctl: { ok(plan?: string | null): void; unauth(): void; error(msg?: string): void }) => void };

function makeFakeProbeProc(behavior: ProbeBehavior, spawnArgs: string[] = []): ChildProcess {
  const c = new EventEmitter() as any;
  c.stdout = new PassThrough();
  c.stderr = new PassThrough();
  c.exitCode = null;
  c.signalCode = null;
  c.pid = undefined;
  c.kill = () => {
    if (c.exitCode === null) {
      c.exitCode = 1;
      c.emit('close', 1);
    }
    return true;
  };
  let buf = '';
  c.stdin = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString('utf8');
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = JSON.parse(line);
        if (behavior.kind === 'ok') behavior.onMessage?.(m);
        if (behavior.kind === 'hang') continue;
        if (m.method === 'initialize') {
          c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
        } else if (m.method === 'session/new') {
          if (behavior.kind === 'manual') {
            const id = m.id;
            behavior.onReady({
              ok: (plan = null) => {
                const meta = plan ? { antigravity: { tier: { name: plan, id: 'tier-id' } } } : {};
                c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'p1', _meta: meta } }) + '\n');
              },
              unauth: () => {
                c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Authentication required' } }) + '\n');
              },
              error: (msg = 'network error') => {
                c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: msg } }) + '\n');
              },
            });
          } else if (behavior.kind === 'ok') {
            behavior.onSessionNew?.(spawnArgs);
            const meta = behavior.plan ? { antigravity: { tier: { name: behavior.plan, id: 'tier-id' } } } : {};
            const sid = behavior.sessionId ?? 'p1';
            c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { sessionId: sid, _meta: meta } }) + '\n');
          } else if (behavior.kind === 'unauth') {
            if (behavior.viaStderr) {
              c.stderr.write('Authentication required\n');
            } else {
              c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required' } }) + '\n');
            }
          } else {
            c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32001, message: behavior.message ?? 'network error' } }) + '\n');
          }
        } else if (m.method === 'session/close') {
          c.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: {} }) + '\n');
        }
      }
      cb();
    },
  });
  return c as ChildProcess;
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
  probe?: (args: string[], env: NodeJS.ProcessEnv) => ProbeBehavior;
  running?: Record<string, number>;
  stopAccount?: (id: string) => boolean;
  loginTimeoutMs?: number;
  probeTimeoutMs?: number;
  now?: () => number;
  platform?: NodeJS.Platform;
  probeStatus?: (logDir: string, pid: number | undefined) => Promise<AgyStatus | null>;
} = {}) {
  const store = new StateStore(path.join(tmp, 'state.json'));
  const changed = vi.fn();
  const resetAccount = vi.fn();
  const stopAccount = vi.fn(opts.stopAccount ?? (() => true));
  const loginSpawns: { proc: FakeLoginProc; args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const probeSpawns: { args: string[]; env: NodeJS.ProcessEnv; cwd: string }[] = [];
  const accounts = new AgyAccounts({
    store,
    running: (id) => opts.running?.[id] ?? 0,
    stopAccount,
    resetAccount,
    onChanged: changed,
    resolveAgy: () => (opts.agyPath === undefined ? '/fake/agy' : opts.agyPath),
    loginTimeoutMs: opts.loginTimeoutMs,
    probeTimeoutMs: opts.probeTimeoutMs,
    now: opts.now,
    platform: opts.platform,
    probeStatus: opts.probeStatus ?? (async () => null),
    spawnLogin: (_agyPath, args, env) => {
      const proc = new FakeLoginProc();
      loginSpawns.push({ proc, args, env });
      return proc as unknown as ChildProcess;
    },
    spawnProbe: (_agyPath, args, env, cwd) => {
      probeSpawns.push({ args, env, cwd });
      const b = opts.probe ? opts.probe(args, env) : { kind: 'ok' as const, plan: 'Google AI Pro' };
      return makeFakeProbeProc(b, args);
    },
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

/** 完成一次假登录（写令牌文件 + 输出成功邮箱 + 退出码 0），返回 accountId 与目录 */
async function completeLogin(
  h: ReturnType<typeof makeHarness>,
  opts: { label?: string; accountId?: string; email?: string; tokenContent?: string } = {},
) {
  const login = h.accounts.startLogin({ label: opts.label, accountId: opts.accountId });
  const spawned = h.loginSpawns[h.loginSpawns.length - 1]!;
  spawned.proc.stdout.write(
    'Open this link in a browser to log in with Google:\n\n  https://accounts.google.com/o/oauth2/auth?client_id=test&state=xyz\n\nThen paste the authorization code:\n',
  );
  await until(() => h.accounts.getLogin(login.loginId).status === 'waiting');
  h.accounts.submitCode(login.loginId, '4/test-auth-code-123456');
  const dir = dirFromArgs(spawned.args);
  if (dir) {
    fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), opts.tokenContent ?? 'secret-token');
    fs.writeFileSync(path.join(dir, 'acp-auth-state.json'), JSON.stringify({ ok: true }));
  }
  spawned.proc.stdout.write(`Successfully authenticated as ${opts.email ?? 'User@Example.COM'}.\n`);
  spawned.proc.exit(0);
  await until(() => {
    const s = h.accounts.getLogin(login.loginId).status;
    return s === 'done' || s === 'failed';
  });
  return { login: h.accounts.getLogin(login.loginId), dir, spawned };
}

describe('agy-env', () => {
  it('默认账号不加 FORCE_FILE 与参数；添加账号不改 USERPROFILE/HOME，只加 FORCE_FILE 与 --gemini-dir/--app-data-dir', () => {
    const base = { USERPROFILE: 'C:\\Users\\real', HOME: '/home/real', PATH: '/bin', CLAUDECODE: '1' };
    const defEnv = agyAccountEnv(null, base);
    expect(defEnv.USERPROFILE).toBe('C:\\Users\\real');
    expect(defEnv.HOME).toBe('/home/real');
    expect(defEnv.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined();
    expect(defEnv.SSH_CONNECTION).toBeUndefined();
    expect(defEnv.CLAUDECODE).toBeUndefined();
    expect(agyAccountArgs(null)).toEqual([]);

    const defLogin = agyLoginEnv(null, base);
    expect(defLogin.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined();
    expect(defLogin.SSH_CONNECTION).toBe('127.0.0.1 54321 127.0.0.1 22');

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

  it('findAgyLoginUrl 与 extractIdentityHash', () => {
    expect(findAgyLoginUrl('  https://accounts.google.com/o/oauth2/auth?client_id=1&scope=a\n')).toBe(
      'https://accounts.google.com/o/oauth2/auth?client_id=1&scope=a',
    );
    const h1 = extractIdentityHash('Successfully authenticated as Foo@Bar.COM.');
    const h2 = extractIdentityHash('Successfully authenticated as foo@bar.com');
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(h1).toBe(h2);
  });
});

describe('AgyAccounts 登录、判重、重新登录与探测', () => {
  it('登录成功：不自动起备注名（菜单显示邮箱）、结果与 state.json 不含邮箱/授权码/令牌、只存哈希', async () => {
    const h = makeHarness();
    const r1 = await completeLogin(h, { email: 'Alice@Example.com' });
    expect(r1.login.status).toBe('done');
    expect(r1.login.accountId).toBeTruthy();
    expect(r1.spawned.args).toEqual(['acp', '--login', '--gemini-dir', path.resolve(agyRoot), '--app-data-dir', r1.login.accountId]);
    expect(r1.spawned.env.SSH_CONNECTION).toBeTruthy();
    expect(r1.spawned.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1');

    const r2 = await completeLogin(h, { email: 'Bob@Example.com' });
    expect(r2.login.status).toBe('done');

    const list = h.accounts.list();
    expect(list.installed).toBe(true);
    expect(list.list.map((a) => a.label)).toEqual(['', '', '']);
    expect(list.list[1]!.loggedIn).toBe(true);
    expect(list.list[1]!.plan).toBe('Google AI Pro');

    await h.store.idle();
    const serialized = JSON.stringify(list) + fs.readFileSync(path.join(tmp, 'state.json'), 'utf8');
    expect(serialized).not.toContain('Alice');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('Example.com');
    expect(serialized).not.toContain('4/test-auth-code');
    expect(serialized).not.toContain('secret-token');
    expect(h.store.state.agyAccounts.list[0]!.identityHash).toMatch(/^[0-9a-f]{64}$/);
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
    expect(h.store.state.agyAccounts.list.find((x) => x.id === id)!.identityHash).toBe(
      extractIdentityHash('Successfully authenticated as c@example.com'),
    );
    await until(() => !fs.existsSync(ok.dir!));
    h.accounts.dispose();
  });

  it('默认账号登录保护：未检测或已登录一律 409；仅探测为未登录时允许登录（且不加 FORCE_FILE）', async () => {
    let behavior: ProbeBehavior = { kind: 'ok', plan: 'Google AI Ultra' };
    const h = makeHarness({ probe: () => behavior });

    // 未检测时 409
    expect(() => h.accounts.startLogin({ accountId: DEFAULT_ID })).toThrow(/检测/);
    await until(() => h.accounts.list().list[0]!.loggedIn === true);
    // 已登录时 409
    expect(() => h.accounts.startLogin({ accountId: DEFAULT_ID })).toThrow(/已登录/);

    // 换一个探测结果为未登录的实例
    const h2 = makeHarness({ probe: () => ({ kind: 'unauth' }) });
    h2.accounts.list();
    await until(() => h2.accounts.list().list[0]!.loggedIn === false);
    const login = h2.accounts.startLogin({ accountId: DEFAULT_ID });
    expect(login.status).toBe('starting');
    const spawned = h2.loginSpawns[0]!;
    expect(spawned.args).toEqual(['acp', '--login']);
    expect(spawned.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined();
    expect(spawned.env.SSH_CONNECTION).toBeTruthy();

    // 非 auth 错误不误判为未登录，默认账号保持 null 且不允许登录
    const h3 = makeHarness({ probe: () => ({ kind: 'error', message: 'region unsupported' }) });
    h3.accounts.list();
    await tick(40);
    expect(h3.accounts.list().list[0]!.loggedIn).toBeNull();
    expect(() => h3.accounts.startLogin({ accountId: DEFAULT_ID })).toThrow(HttpError);
    h.accounts.dispose();
    h2.accounts.dispose();
    h3.accounts.dispose();
  });

  it('探测缓存与非 auth 错误保护：添加账号遇网络错误保持 loggedIn=true 与旧 plan；同账号并发探测去重', async () => {
    let t = 100_000;
    let mode: ProbeBehavior = { kind: 'ok', plan: 'Google AI Pro' };
    const h = makeHarness({ now: () => t, probe: () => mode });
    const r = await completeLogin(h, { email: 'p@example.com' });
    const id = r.login.accountId!;
    const probesBefore = h.probeSpawns.length;

    // 30 分钟内走缓存，不再触发探测
    h.accounts.list();
    expect(h.probeSpawns.length).toBe(probesBefore + 1); // 仅 default 没缓存
    t += 29 * 60_000;
    h.accounts.list();
    expect(h.probeSpawns.length).toBe(probesBefore + 1);

    // 超过 30 分钟后遭遇网络错误：添加账号保持 loggedIn=true 和旧 plan
    mode = { kind: 'error' };
    t += 2 * 60_000;
    // 连续调用两次 list()：并发去重
    h.accounts.list();
    h.accounts.list();
    await tick(40);
    const entry = h.accounts.list().list.find((a) => a.id === id)!;
    expect(entry.loggedIn).toBe(true);
    expect(entry.plan).toBe('Google AI Pro');
    h.accounts.dispose();
  });

  it('init() 清理遗留的超过 1 小时的未登记目录，不碰 1 小时内、已登记目录与 symlink', async () => {
    let now = 10_000_000;
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

    const oldTime = new Date(now - 2 * 60 * 60_000);
    const freshTime = new Date(now - 10 * 60_000);
    fs.utimesSync(oldOrphan, oldTime, oldTime);
    fs.utimesSync(freshOrphan, freshTime, freshTime);

    h.accounts.init();
    await until(() => !fs.existsSync(oldOrphan));
    expect(fs.existsSync(freshOrphan)).toBe(true);
    expect(fs.existsSync(nonIdDir)).toBe(true);
    expect(fs.existsSync(path.join(outside, 'keep.txt'))).toBe(true);
    h.accounts.dispose();
  });

  it('移除保护（默认/当前/登录中/执行中 409）与 junction/symlink 安全删除', async () => {
    const running: Record<string, number> = {};
    const h = makeHarness({ running });
    const r = await completeLogin(h, { email: 'rem@example.com' });
    const id = r.login.accountId!;
    const accDir = r.dir!;

    // 默认账号 409
    await expect(h.accounts.remove(DEFAULT_ID)).rejects.toMatchObject({ status: 409 });

    // 当前账号 409
    await h.accounts.switchTo(id);
    await expect(h.accounts.remove(id)).rejects.toMatchObject({ status: 409 });
    await h.accounts.switchTo(DEFAULT_ID);

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

    await h.accounts.remove(id);
    expect(h.stopAccount).toHaveBeenCalledWith(id);
    expect(fs.existsSync(accDir)).toBe(false);
    expect(fs.readFileSync(path.join(external, 'secret.txt'), 'utf8')).toBe('do-not-delete');
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

describe('审查问题回归测试', () => {
  it('1. triggerProbe 遇非 auth 错误：沿用 prev.loggedIn（含 false），无 prev 时添加账号按令牌文件判断、默认账号为 null', async () => {
    let t = 100_000;
    let mode: ProbeBehavior = { kind: 'unauth' };
    const h = makeHarness({ now: () => t, probe: () => mode });

    // (a) 预先写入一个无令牌文件的已添加账号到 state（模拟重启后令牌文件缺失且尚无缓存）
    const noTokenDir = path.join(agyRoot, 'aaaa1111');
    fs.mkdirSync(noTokenDir, { recursive: true });
    h.store.state.agyAccounts.list.push({ id: 'aaaa1111', label: '无令牌', dir: noTokenDir, createdAt: 1 });

    mode = { kind: 'error', message: 'network down' };
    await h.accounts.triggerProbe('aaaa1111', noTokenDir);
    await h.accounts.triggerProbe(DEFAULT_ID, null);
    expect(h.accounts.list().list.find((a) => a.id === 'aaaa1111')!.loggedIn).toBe(false);
    expect(h.accounts.list().list.find((a) => a.id === DEFAULT_ID)!.loggedIn).toBeNull();

    // (b) 缓存明确为 false（unauth）后，再遇网络错误不得翻成 true（添加账号与默认账号均如此）
    mode = { kind: 'unauth' };
    t += 120_000;
    await h.accounts.triggerProbe(DEFAULT_ID, null);
    await h.accounts.triggerProbe('aaaa1111', noTokenDir);
    expect(h.accounts.list().list.find((a) => a.id === DEFAULT_ID)!.loggedIn).toBe(false);
    expect(h.accounts.list().list.find((a) => a.id === 'aaaa1111')!.loggedIn).toBe(false);

    // 给 noTokenDir 放上文件也没用，因为已有 prev.loggedIn=false，网络错误必须沿用 prev.loggedIn=false
    fs.writeFileSync(path.join(noTokenDir, 'antigravity-oauth-token'), 'tok');
    mode = { kind: 'error', message: 'timeout' };
    t += 31 * 60_000;
    await h.accounts.triggerProbe(DEFAULT_ID, null);
    await h.accounts.triggerProbe('aaaa1111', noTokenDir);
    expect(h.accounts.list().list.find((a) => a.id === DEFAULT_ID)!.loggedIn).toBe(false);
    expect(h.accounts.list().list.find((a) => a.id === 'aaaa1111')!.loggedIn).toBe(false);
    h.accounts.dispose();
  });

  it('2. 探测与登录竞态：早于登录启动的旧探测晚返回 unauth 时，按代数丢弃，不得覆盖新登录的缓存', async () => {
    let slowCtl: { ok(plan?: string | null): void; unauth(): void; error(msg?: string): void } | null = null;
    let probeCall = 0;
    const h = makeHarness({
      probe: () => {
        probeCall++;
        if (probeCall === 1) return { kind: 'ok', plan: 'Google AI Pro' }; // 首次添加登录探测
        if (probeCall === 2) return { kind: 'manual', onReady: (ctl) => { slowCtl = ctl; } }; // 慢探测（先启动）
        return { kind: 'ok', plan: 'Google AI Ultra' }; // 重新登录后的探测
      },
    });
    const r1 = await completeLogin(h, { email: 'race@example.com' });
    const id = r1.login.accountId!;
    const accDir = r1.dir!;

    // 启动慢探测（不等待其完成）
    const slowP = h.accounts.triggerProbe(id, accDir);
    await until(() => slowCtl !== null);

    // 慢探测尚未结束时，重新登录成功（更新为 loggedIn=true, plan='Google AI Ultra'）
    const r2 = await completeLogin(h, { accountId: id, email: 'race@example.com', tokenContent: 'fresh-tok' });
    expect(r2.login.status).toBe('done');
    expect(h.accounts.list().list.find((a) => a.id === id)).toMatchObject({ loggedIn: true, plan: 'Google AI Ultra' });

    // 旧探测此时才返回 unauth：必须被丢弃，不能把缓存覆盖成 false
    slowCtl!.unauth();
    await slowP;
    expect(h.accounts.list().list.find((a) => a.id === id)).toMatchObject({ loggedIn: true, plan: 'Google AI Ultra' });
    h.accounts.dispose();
  });

  it('3. 默认账号重新登录：即便与已添加账号同邮箱，跳过判重并按成功更新缓存', async () => {
    let probeDefault: ProbeBehavior = { kind: 'unauth' };
    const h = makeHarness({
      probe: (_args, env) => {
        if (!env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE) return probeDefault;
        return { kind: 'ok', plan: 'Google AI Pro' };
      },
    });
    // 先添加了一个邮箱为 same@example.com 的账号
    const added = await completeLogin(h, { email: 'same@example.com' });
    expect(added.login.status).toBe('done');

    // 默认账号先探测为未登录
    await h.accounts.triggerProbe(DEFAULT_ID, null);
    expect(h.accounts.list().list[0]!.loggedIn).toBe(false);

    // 默认账号登录，且登录了 same@example.com（此时系统凭据已写入）
    probeDefault = { kind: 'ok', plan: 'Google AI Pro' };
    const defLogin = await completeLogin(h, { accountId: DEFAULT_ID, email: 'same@example.com' });
    expect(defLogin.login.status).toBe('done');
    expect(defLogin.login.error).toBeNull();
    expect(h.accounts.list().list[0]).toMatchObject({ loggedIn: true, plan: 'Google AI Pro' });
    h.accounts.dispose();
  });

  it('4. 已有账号重新登录：replaceAuthFiles 成功后再次调用 resetAccount（前后共两次）', async () => {
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

  it('5. 错误文案不自带「登录失败：」前缀，无可用末行时给出简短中文原因', async () => {
    const h = makeHarness();

    // 有末行输出
    const l1 = h.accounts.startLogin({});
    const s1 = h.loginSpawns[0]!;
    s1.proc.stdout.write('some unexpected cli error\n');
    s1.proc.exit(1);
    await until(() => h.accounts.getLogin(l1.loginId).status === 'failed');
    const err1 = h.accounts.getLogin(l1.loginId).error!;
    expect(err1).toBe('some unexpected cli error');
    expect(err1).not.toMatch(/^登录失败/);

    // 无任何输出
    const l2 = h.accounts.startLogin({});
    const s2 = h.loginSpawns[1]!;
    s2.proc.exit(1);
    await until(() => h.accounts.getLogin(l2.loginId).status === 'failed');
    const err2 = h.accounts.getLogin(l2.loginId).error!;
    expect(err2).not.toMatch(/^登录失败/);
    expect(err2.length).toBeGreaterThan(0);
    h.accounts.dispose();
  });

  it('6. 退出码 0 之后的探测期间发生超时，探测返回 ok 也不得再登记账号或改为 done', async () => {
    let probeCtl: { ok(plan?: string | null): void; unauth(): void; error(msg?: string): void } | null = null;
    const h = makeHarness({
      loginTimeoutMs: 50,
      probe: () => ({ kind: 'manual', onReady: (ctl) => { probeCtl = ctl; } }),
    });
    const login = h.accounts.startLogin({});
    const spawned = h.loginSpawns[0]!;
    const dir = dirFromArgs(spawned.args)!;
    spawned.proc.stdout.write('https://accounts.google.com/o/oauth2/auth?x=1\n');
    await until(() => h.accounts.getLogin(login.loginId).status === 'waiting');
    h.accounts.submitCode(login.loginId, '4/code');
    fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), 'tok');
    spawned.proc.stdout.write('Successfully authenticated as timeout@example.com.\n');
    // 进程退出码 0，进入探测阶段（挂起等待 probeCtl）
    spawned.proc.exit(0);
    await until(() => probeCtl !== null);

    // 在探测期间登录超时触发 -> status 变为 failed('登录超时')
    await until(() => h.accounts.getLogin(login.loginId).status === 'failed');
    expect(h.accounts.getLogin(login.loginId).error).toBe('登录超时');

    // 随后探测才返回 ok：不得再登记账号，也不得改回 done，且临时目录应被清理
    probeCtl!.ok('Google AI Pro');
    await tick(30);
    expect(h.accounts.getLogin(login.loginId).status).toBe('failed');
    expect(h.accounts.getLogin(login.loginId).error).toBe('登录超时');
    expect(h.store.state.agyAccounts.list).toHaveLength(0);
    await until(() => !fs.existsSync(dir));
    h.accounts.dispose();
  });

  it('7a. Windows 默认账号探测使用一次性临时目录（不设 FORCE_FILE），退出后安全删除且不跟进链接', async () => {
    let seenScratch: string | null = null;
    const external = path.join(tmp, 'scratch-external');
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(external, 'keep.txt'), 'safe');

    const h = makeHarness({
      platform: 'win32',
      probe: (args, env) => {
        expect(env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined();
        const gi = args.indexOf('--gemini-dir');
        const ai = args.indexOf('--app-data-dir');
        expect(gi).toBeGreaterThan(-1);
        expect(args[ai + 1]).toBe('p');
        seenScratch = args[gi + 1]!;
        expect(path.basename(seenScratch)).toMatch(/^cosyee-agy-probe-/);
        expect(path.dirname(seenScratch)).toBe(path.resolve(os.tmpdir()));
        return {
          kind: 'ok',
          plan: 'Google AI Pro',
          sessionId: '11111111-1111-4111-8111-111111111111',
          onSessionNew: () => {
            const pDir = path.join(seenScratch!, 'p');
            fs.mkdirSync(path.join(pDir, 'conversations'), { recursive: true });
            fs.writeFileSync(path.join(pDir, 'conversations', '11111111-1111-4111-8111-111111111111.db'), 'db');
            // 放一个指向外部的 junction/symlink，确保清理不跟进
            fs.symlinkSync(external, path.join(pDir, 'ext-link'), process.platform === 'win32' ? 'junction' : 'dir');
          },
        };
      },
    });

    const res = await h.accounts.probeDir(null);
    expect(res).toEqual({ kind: 'ok', plan: 'Google AI Pro', sessionId: '11111111-1111-4111-8111-111111111111' });
    expect(seenScratch).toBeTruthy();
    await h.accounts.waitCleanups();
    expect(fs.existsSync(seenScratch!)).toBe(false);
    expect(fs.readFileSync(path.join(external, 'keep.txt'), 'utf8')).toBe('safe');
    expect(agyProbeArgs(null, 'X:/tmp/cosyee-agy-probe-abc')).toEqual(['--gemini-dir', path.resolve('X:/tmp/cosyee-agy-probe-abc'), '--app-data-dir', 'p']);
    h.accounts.dispose();
  });

  it('7b. 非 Windows 默认账号探测不建临时目录，并在结束前发送 session/close', async () => {
    const methods: string[] = [];
    const h = makeHarness({
      platform: 'linux',
      probe: (args) => {
        expect(args).toEqual(['acp']);
        return {
          kind: 'ok',
          plan: 'Google AI Pro',
          sessionId: '22222222-2222-4222-8222-222222222222',
          onMessage: (m) => { if (m.method) methods.push(m.method); },
        };
      },
    });
    const res = await h.accounts.probeDir(null);
    expect(res).toEqual({ kind: 'ok', plan: 'Google AI Pro', sessionId: '22222222-2222-4222-8222-222222222222' });
    await until(() => methods.includes('session/close'));
    expect(methods).toEqual(['initialize', 'session/new', 'session/close']);
    h.accounts.dispose();
  });

  it('7c. 添加账号探测退出后只删 <sid>.db* 与 brain/<sid>，保留其它会话与外部链接目标；非 UUID 不删', async () => {
    const sid = '33333333-3333-4333-8333-333333333333';
    const otherSid = '44444444-4444-4444-8444-444444444444';
    const accDir = path.join(agyRoot, 'aaaa1111');
    const convDir = path.join(accDir, 'conversations');
    const brainDir = path.join(accDir, 'brain');
    const external = path.join(tmp, 'brain-external');
    fs.mkdirSync(convDir, { recursive: true });
    fs.mkdirSync(path.join(brainDir, otherSid), { recursive: true });
    fs.mkdirSync(external, { recursive: true });
    fs.writeFileSync(path.join(convDir, `${otherSid}.db`), 'keep-other');
    fs.writeFileSync(path.join(brainDir, otherSid, 'keep.md'), 'keep-brain');
    fs.writeFileSync(path.join(external, 'precious.txt'), 'safe');

    const h = makeHarness({
      probe: () => ({
        kind: 'ok',
        plan: 'Google AI Pro',
        sessionId: sid,
        onSessionNew: () => {
          fs.writeFileSync(path.join(convDir, `${sid}.db`), 'probe-db');
          fs.writeFileSync(path.join(convDir, `${sid}.db-wal`), 'probe-wal');
          fs.writeFileSync(path.join(convDir, `${sid}.db-shm`), 'probe-shm');
          fs.mkdirSync(path.join(brainDir, sid), { recursive: true });
          fs.writeFileSync(path.join(brainDir, sid, 'temp.md'), 'probe-brain');
          fs.symlinkSync(external, path.join(brainDir, sid, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
        },
      }),
    });

    const res = await h.accounts.probeDir(accDir);
    expect(res.kind).toBe('ok');
    await h.accounts.waitCleanups();

    // 本次探测会话文件与目录已清理
    expect(fs.existsSync(path.join(convDir, `${sid}.db`))).toBe(false);
    expect(fs.existsSync(path.join(convDir, `${sid}.db-wal`))).toBe(false);
    expect(fs.existsSync(path.join(convDir, `${sid}.db-shm`))).toBe(false);
    expect(fs.existsSync(path.join(brainDir, sid))).toBe(false);
    // 其它会话与外部链接目标毫发无损
    expect(fs.readFileSync(path.join(convDir, `${otherSid}.db`), 'utf8')).toBe('keep-other');
    expect(fs.readFileSync(path.join(brainDir, otherSid, 'keep.md'), 'utf8')).toBe('keep-brain');
    expect(fs.readFileSync(path.join(external, 'precious.txt'), 'utf8')).toBe('safe');

    // 非 UUID 的 sessionId 不触发删除
    const badFile = path.join(convDir, 'not-a-uuid.db');
    fs.writeFileSync(badFile, 'stay');
    const h2 = makeHarness({
      probe: () => ({ kind: 'ok', plan: null, sessionId: 'not-a-uuid' }),
    });
    await h2.accounts.probeDir(accDir);
    await h2.accounts.waitCleanups();
    expect(fs.existsSync(badFile)).toBe(true);
    h.accounts.dispose();
    h2.accounts.dispose();
  });

  it('7d. dispose 时也能清理挂起探测创建的一次性临时目录', async () => {
    let seenScratch: string | null = null;
    const h = makeHarness({
      platform: 'win32',
      probe: (args) => {
        seenScratch = args[args.indexOf('--gemini-dir') + 1]!;
        return { kind: 'hang' };
      },
    });
    const p = h.accounts.probeDir(null);
    await until(() => seenScratch !== null && fs.existsSync(seenScratch));
    h.accounts.dispose();
    await p;
    await h.accounts.waitCleanups();
    expect(fs.existsSync(seenScratch!)).toBe(false);
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

describe('HTTP /api/agy-accounts 路由', () => {
  it('完整覆盖 GET/POST 路由与 authToken 鉴权，切换不触发 account.changed', async () => {
    const h = makeHarness();
    const token = 'test-secret-token';
    const workspaces = new Workspaces(h.store);
    let port = 0;
    const handler = createHandler({
      port: () => port,
      version: '0.0.0',
      webDist: null,
      workspaces,
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
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as AddressInfo).port;

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

    try {
      // 无令牌 403
      expect((await req('GET', '/api/agy-accounts', undefined, false)).status).toBe(403);

      // 列表
      const l0 = await req('GET', '/api/agy-accounts');
      expect(l0.status).toBe(200);
      expect(l0.json.installed).toBe(true);
      expect(l0.json.list).toHaveLength(1);

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
      fs.writeFileSync(path.join(accDir, 'antigravity-oauth-token'), 'tok');
      spawned.proc.stdout.write('Successfully authenticated as http@example.com.\n');
      spawned.proc.exit(0);
      await until(() => h.accounts.getLogin(loginId).status === 'done');
      const accId = h.accounts.getLogin(loginId).accountId!;

      // 改备注名
      expect((await req('POST', '/api/agy-accounts/label', { id: accId, label: '新备注' })).status).toBe(200);
      expect(h.accounts.list().list.find((a) => a.id === accId)!.label).toBe('新备注');

      // 切换账号
      expect((await req('POST', '/api/agy-accounts/switch', { id: accId })).status).toBe(200);
      expect(h.accounts.activeId()).toBe(accId);
      // 缺少 id 400
      expect((await req('POST', '/api/agy-accounts/switch', {})).status).toBe(400);

      // 当前账号不能移除 409
      expect((await req('POST', '/api/agy-accounts/remove', { id: accId })).status).toBe(409);

      // 切回默认后移除成功
      expect((await req('POST', '/api/agy-accounts/switch', { id: DEFAULT_ID })).status).toBe(200);
      expect((await req('POST', '/api/agy-accounts/remove', { id: accId })).status).toBe(200);

      // 取消登录路由
      const start2 = await req('POST', '/api/agy-accounts/login', {});
      const cancel = await req('POST', `/api/agy-accounts/login/${start2.json.loginId}/cancel`);
      expect(cancel.status).toBe(200);
      h.loginSpawns[1]!.proc.exit(1);
    } finally {
      h.accounts.dispose();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe('agy 邮箱与额度（language server）', () => {
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

  it('列表带邮箱与额度但 state.json 不存邮箱；refresh 只在额度超过 90 秒时重新探测', async () => {
    let t = 1_000_000;
    let calls = 0;
    const quota = { groups: [{ name: 'Gemini', buckets: [{ window: '5h', percent: 10, severity: 'normal' as const, resetsAt: null }] }], at: 0 };
    const h = makeHarness({
      now: () => t,
      probeStatus: async (logDir) => {
        calls++;
        // 默认账号与添加账号返回不同邮箱，避免被同账号去重合并
        const isAdded = logDir.startsWith(path.resolve(agyRoot));
        return { email: isAdded ? 'Carol@Example.com' : 'Default@Example.com', quota };
      },
    });
    const r = await completeLogin(h, { email: 'Carol@Example.com' });
    expect(r.login.status).toBe('done');
    await until(() => h.accounts.list().list.every((a) => a.loggedIn !== null));
    const entry = h.accounts.list().list.find((a) => a.id === r.login.accountId)!;
    expect(entry.label).toBe('');
    expect(entry.email).toBe('Carol@Example.com');
    expect(entry.quota?.groups[0]!.name).toBe('Gemini');
    await h.store.idle();
    expect(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8')).not.toContain('Example.com');

    const before = calls;
    h.accounts.list({ refresh: true });
    await new Promise((res) => setTimeout(res, 20));
    expect(calls).toBe(before);
    t += 91_000;
    h.accounts.list({ refresh: true });
    await until(() => calls > before);
    h.accounts.dispose();
  });

  it('默认账号探测到邮箱后记录哈希：拒绝再添加同邮箱账号，也拒绝其它账号重登成默认账号', async () => {
    const h = makeHarness({
      probeStatus: async (logDir) => {
        const isAdded = logDir.startsWith(path.resolve(agyRoot));
        return { email: isAdded ? null : 'Main@Example.com', quota: null };
      },
    });
    // 触发默认账号探测，拿到邮箱并记录 defaultIdentityHash
    await h.accounts.triggerProbe(DEFAULT_ID, null);
    expect(h.accounts.list().list[0]!.email).toBe('Main@Example.com');

    // 1) 尝试添加与默认账号同邮箱的新账号 -> 失败并清理临时目录
    const rDup = await completeLogin(h, { email: 'main@example.com' });
    expect(rDup.login.status).toBe('failed');
    expect(rDup.login.error).toBe('这个账号已经添加过了');
    expect(h.store.state.agyAccounts.list).toHaveLength(0);
    await until(() => !fs.existsSync(rDup.dir!));

    // 2) 添加一个不同邮箱的账号，再将其重新登录成默认账号的邮箱 -> 失败且不破坏原凭据
    const rOther = await completeLogin(h, { email: 'other@example.com', tokenContent: 'orig-tok' });
    expect(rOther.login.status).toBe('done');
    const otherId = rOther.login.accountId!;
    const rRelogin = await completeLogin(h, { accountId: otherId, email: 'MAIN@EXAMPLE.COM', tokenContent: 'new-tok' });
    expect(rRelogin.login.status).toBe('failed');
    expect(rRelogin.login.error).toBe('这个账号已经添加过了');
    expect(fs.readFileSync(path.join(rOther.dir!, 'antigravity-oauth-token'), 'utf8')).toBe('orig-tok');
    await until(() => !fs.existsSync(rRelogin.dir!));
    h.accounts.dispose();
  });

  it('登录输出缺失邮箱时用 probe.email 兜底计算哈希并拦截重复添加', async () => {
    const h = makeHarness({
      probeStatus: async () => ({ email: 'Fallback@Example.com', quota: null }),
    });
    // 第一次登录：stdout 不输出 Successfully authenticated as ...，依赖 probe.email 回填哈希
    const l1 = h.accounts.startLogin({});
    const s1 = h.loginSpawns[0]!;
    const d1 = dirFromArgs(s1.args)!;
    fs.writeFileSync(path.join(d1, 'antigravity-oauth-token'), 'tok-1');
    s1.proc.exit(0);
    await until(() => h.accounts.getLogin(l1.loginId).status === 'done');
    expect(h.store.state.agyAccounts.list[0]!.identityHash).toBe(
      extractIdentityHash('Successfully authenticated as fallback@example.com'),
    );

    // 第二次登录同样不输出邮箱，但 probe.email 返回相同邮箱 -> 判重失败
    const l2 = h.accounts.startLogin({});
    const s2 = h.loginSpawns[1]!;
    const d2 = dirFromArgs(s2.args)!;
    fs.writeFileSync(path.join(d2, 'antigravity-oauth-token'), 'tok-2');
    s2.proc.exit(0);
    await until(() => h.accounts.getLogin(l2.loginId).status === 'failed');
    expect(h.accounts.getLogin(l2.loginId).error).toBe('这个账号已经添加过了');
    expect(h.store.state.agyAccounts.list).toHaveLength(1);
    await until(() => !fs.existsSync(d2));
    h.accounts.dispose();
  });

  it('历史重复条目在 list() 去重显示（当前 > 默认 > 最早），探测回填缺失哈希，不静默删目录', async () => {
    const emailByDir = new Map<string, string>();
    const h = makeHarness({
      probeStatus: async (logDir) => {
        for (const [dir, email] of emailByDir) {
          if (logDir.startsWith(dir)) return { email, quota: null };
        }
        return { email: 'Def@Example.com', quota: null };
      },
    });
    const mkHist = (id: string, createdAt: number, identityHash?: string) => {
      const dir = path.join(agyRoot, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), 'tok');
      h.store.state.agyAccounts.list.push({ id, label: id, dir, createdAt, ...(identityHash ? { identityHash } : {}) });
      return dir;
    };
    const defHash = extractIdentityHash('Successfully authenticated as def@example.com')!;
    const dupHash = extractIdentityHash('Successfully authenticated as same@example.com')!;
    const dirDupDef = mkHist('dupdef01', 100, defHash);
    const dirEarly = mkHist('early001', 200, dupHash);
    const dirLateNoHash = mkHist('late0001', 300); // 历史旧数据：没有 identityHash
    emailByDir.set(dirDupDef, 'Def@Example.com');
    emailByDir.set(dirEarly, 'Same@Example.com');
    emailByDir.set(dirLateNoHash, 'Same@Example.com');

    // 探测默认账号与无哈希的历史账号
    await h.accounts.triggerProbe(DEFAULT_ID, null);
    await h.accounts.triggerProbe('late0001', dirLateNoHash);
    // 探测后自动回填缺失的 identityHash
    expect(h.store.state.agyAccounts.list.find((x) => x.id === 'late0001')!.identityHash).toBe(dupHash);

    // 默认账号是当前：隐藏 dupdef01 和 late0001，只保留 default 与最早的 early001
    expect(h.accounts.list().list.map((x) => x.id)).toEqual([DEFAULT_ID, 'early001']);
    // 磁盘目录与底层 state 不被静默删除
    expect(fs.existsSync(dirDupDef)).toBe(true);
    expect(fs.existsSync(dirLateNoHash)).toBe(true);
    expect(h.store.state.agyAccounts.list).toHaveLength(3);

    // 切到 late0001 后，当前活跃的 late0001 优先显示（隐藏 early001）
    await h.accounts.switchTo('late0001');
    expect(h.accounts.list().list.map((x) => x.id)).toEqual([DEFAULT_ID, 'late0001']);
    expect(h.accounts.list().list.find((x) => x.id === 'late0001')?.active).toBe(true);

    // 隐藏的重复条目仍可显式移除
    await h.accounts.remove('dupdef01');
    expect(fs.existsSync(dirDupDef)).toBe(false);
    expect(fs.existsSync(dirEarly)).toBe(true);
    h.accounts.dispose();
  });

  it('duplicates 计数与 dedupe()：删掉可删重复项、跳过默认/登录中/有执行中委派任务，绝不碰保留项', async () => {
    const running: Record<string, number> = {};
    const h = makeHarness({
      running,
      probeStatus: async (logDir) => {
        const isAdded = logDir.startsWith(path.resolve(agyRoot));
        return { email: isAdded ? null : 'Def@Example.com', quota: null };
      },
    });
    expect(h.accounts.list().duplicates).toBeUndefined();
    expect(await h.accounts.dedupe()).toEqual({ removed: 0, skipped: 0 });

    const defHash = extractIdentityHash('Successfully authenticated as def@example.com')!;
    const dupHash = extractIdentityHash('Successfully authenticated as same@example.com')!;
    const mkHist = (id: string, createdAt: number, identityHash: string) => {
      const dir = path.join(agyRoot, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'antigravity-oauth-token'), 'tok');
      h.store.state.agyAccounts.list.push({ id, label: id, dir, createdAt, identityHash });
      return dir;
    };

    const dirDupDef = mkHist('dupdef01', 100, defHash);
    const dirKeep = mkHist('keep0001', 200, dupHash);
    const dirRm = mkHist('rm000001', 300, dupHash);
    const dirBusy = mkHist('busy0001', 400, dupHash);
    const dirLogin = mkHist('login001', 500, dupHash);

    await h.accounts.triggerProbe(DEFAULT_ID, null);
    // 把 dupdef01 设为当前活跃账号 -> 默认账号 default 被隐藏，dedupe 时应计入 skipped
    await h.accounts.switchTo('dupdef01');
    running['busy0001'] = 1;
    const loginJob = h.accounts.startLogin({ accountId: 'login001' });

    const before = h.accounts.list();
    expect(before.list.map((x) => x.id)).toEqual(['dupdef01', 'keep0001']);
    expect(before.duplicates).toBe(4);
    // 等待 list() 触发的后台探测结束，避免干扰下面对 dedupe() 通知次数的断言
    await tick(30);

    h.changed.mockClear();
    const r1 = await h.accounts.dedupe();
    expect(r1).toEqual({ removed: 1, skipped: 3 });
    expect(h.changed).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(dirRm)).toBe(false);
    expect(fs.existsSync(dirDupDef)).toBe(true);
    expect(fs.existsSync(dirKeep)).toBe(true);
    expect(fs.existsSync(dirBusy)).toBe(true);
    expect(fs.existsSync(dirLogin)).toBe(true);
    expect(h.accounts.list().duplicates).toBe(3);

    // 解除执行中与登录中并切回默认账号 -> 剩余 3 个隐藏项全部可清
    running['busy0001'] = 0;
    h.accounts.cancelLogin(loginJob.loginId);
    h.loginSpawns[h.loginSpawns.length - 1]!.proc.exit(1);
    await h.accounts.switchTo(DEFAULT_ID);
    expect(h.accounts.list().duplicates).toBe(3);

    const r2 = await h.accounts.dedupe();
    expect(r2).toEqual({ removed: 3, skipped: 0 });
    expect(h.accounts.list().duplicates).toBeUndefined();
    expect(h.accounts.list().list.map((x) => x.id)).toEqual([DEFAULT_ID, 'keep0001']);
    expect(fs.existsSync(dirKeep)).toBe(true);
    h.accounts.dispose();
  });

  it('HTTP POST /api/agy-accounts/dedupe 返回 AccountDedupeResult 并更新 duplicates', async () => {
    const h = makeHarness();
    const dupHash = extractIdentityHash('Successfully authenticated as same@example.com')!;
    const dirKeep = path.join(agyRoot, 'keep0001');
    const dirDup = path.join(agyRoot, 'dup00001');
    fs.mkdirSync(dirKeep, { recursive: true });
    fs.mkdirSync(dirDup, { recursive: true });
    fs.writeFileSync(path.join(dirKeep, 'antigravity-oauth-token'), 'tok');
    fs.writeFileSync(path.join(dirDup, 'antigravity-oauth-token'), 'tok');
    h.store.state.agyAccounts.list.push(
      { id: 'keep0001', label: 'A', dir: dirKeep, createdAt: 100, identityHash: dupHash },
      { id: 'dup00001', label: 'B', dir: dirDup, createdAt: 200, identityHash: dupHash },
    );

    const token = 'test-token-agy-dedupe';
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
      const l0 = await req('GET', '/api/agy-accounts');
      expect(l0.status).toBe(200);
      expect(l0.json.duplicates).toBe(1);

      const d = await req('POST', '/api/agy-accounts/dedupe', {});
      expect(d.status).toBe(200);
      expect(d.json).toEqual({ removed: 1, skipped: 0 });

      const l1 = await req('GET', '/api/agy-accounts');
      expect(l1.status).toBe(200);
      expect(l1.json.duplicates).toBeUndefined();
      expect(fs.existsSync(dirKeep)).toBe(true);
      expect(fs.existsSync(dirDup)).toBe(false);
    } finally {
      h.accounts.dispose();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
