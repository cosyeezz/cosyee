import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodexAccounts, findCodexDeviceAuth } from './accounts/codex.js';
import { computeCodexIdentityHash, mergeCodexQuota, parseCodexRateLimits, readAuthJsonMeta } from './accounts/codex-status.js';
import { Manager } from './claude/manager.js';
import type { DelegateBackend } from './delegate/backend.js';
import { createHandler } from './http.js';
import { Pins } from './pins.js';
import { Previews } from './preview.js';
import { Sessions } from './sessions.js';
import { DotState } from './state.js';
import { Trash } from './trash.js';
import { StateStore, Workspaces } from './workspaces.js';

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

function writeChatgptAuth(dir: string, email: string, accountId: string, planType = 'plus'): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'auth.json'),
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: fakeJwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: planType } }),
        access_token: 'secret-access-token',
        refresh_token: 'secret-refresh-token',
      },
    }),
  );
}

function writeApiKeyAuth(dir: string, apiKey: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey }));
}

function makeFakeProc() {
  const ee = new EventEmitter() as any;
  ee.stdin = new PassThrough();
  ee.stdout = new PassThrough();
  ee.stderr = new PassThrough();
  ee.exitCode = null;
  ee.signalCode = null;
  ee.pid = 0;
  ee.killed = false;
  ee.kill = vi.fn(() => {
    ee.killed = true;
    if (ee.exitCode === null) {
      ee.exitCode = 1;
      ee.emit('close', 1);
    }
  });
  let stdinText = '';
  ee.stdin.on('data', (c: Buffer | string) => {
    stdinText += c.toString('utf8');
  });
  return {
    proc: ee as ChildProcess,
    emitOut: (s: string) => ee.stdout.write(s),
    emitErr: (s: string) => ee.stderr.write(s),
    close: (code: number) => {
      if (ee.exitCode !== null) return;
      ee.exitCode = code;
      ee.emit('close', code);
    },
    getStdin: () => stdinText,
  };
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-codex-acc-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('codex-status 解析', () => {
  it('parseCodexRateLimits 支持多组 rateLimitsByLimitId、秒→毫秒、windowDurationMins 透传；mergeCodexQuota 保留其它组', () => {
    const q = parseCodexRateLimits(
      {
        rateLimits: { limitId: 'codex', primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1760000000 }, planType: 'plus' },
        rateLimitsByLimitId: {
          codex: {
            limitId: 'codex',
            limitName: 'Codex',
            primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1760001000 },
            secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1760600000 },
            planType: 'pro',
          },
          spark: {
            limitId: 'spark',
            limitName: 'Spark',
            primary: { usedPercent: 5, windowDurationMins: 60, resetsAt: 1760002000 },
            secondary: null,
          },
        },
      },
      12345,
    );
    expect(q).toEqual({
      groups: [
        {
          limitId: 'codex',
          limitName: 'Codex',
          primary: { usedPercent: 25, windowMins: 300, resetsAt: 1760001000_000 },
          secondary: { usedPercent: 60, windowMins: 10080, resetsAt: 1760600000_000 },
        },
        {
          limitId: 'spark',
          limitName: 'Spark',
          primary: { usedPercent: 5, windowMins: 60, resetsAt: 1760002000_000 },
          secondary: null,
        },
      ],
      planType: 'pro',
      fetchedAt: 12345,
    });

    const merged = mergeCodexQuota(
      q,
      { rateLimits: { limitId: 'codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1760001000 } } },
      22222,
    );
    expect(merged?.planType).toBe('pro');
    expect(merged?.groups).toHaveLength(2);
    expect(merged?.groups[0]?.primary?.usedPercent).toBe(30);
    expect(merged?.groups[0]?.secondary?.usedPercent).toBe(60);
    expect(merged?.fetchedAt).toBe(22222);
  });

  it('readAuthJsonMeta 解析 JWT email/accountId/planType 与 API Key 哈希，绝不返回 token 原文', () => {
    const d1 = path.join(tmp, 'a1');
    writeChatgptAuth(d1, 'alice@example.com', 'ws-1', 'plus');
    const m1 = readAuthJsonMeta(d1);
    expect(m1).toEqual({
      authMode: 'chatgpt',
      email: 'alice@example.com',
      accountId: 'ws-1',
      planType: 'plus',
      apiKeyHash: null,
    });
    expect(JSON.stringify(m1)).not.toContain('secret-access-token');

    const d2 = path.join(tmp, 'a2');
    writeApiKeyAuth(d2, 'sk-proj-secret1234567890');
    const m2 = readAuthJsonMeta(d2);
    expect(m2?.authMode).toBe('apiKey');
    expect(m2?.apiKeyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(m2)).not.toContain('sk-proj-secret');

    // 同邮箱不同 workspace 算不同账号
    const h1 = computeCodexIdentityHash({ authMode: 'chatgpt', email: 'alice@example.com', accountId: 'ws-1' });
    const h2 = computeCodexIdentityHash({ authMode: 'chatgpt', email: 'alice@example.com', accountId: 'ws-2' });
    expect(h1).not.toBe(h2);
  });

  it('findCodexDeviceAuth 准确解析真实格式的链接与一次性验证码', () => {
    const sample = `
Welcome to Codex [v0.144.6]
1. Open this link in your browser and sign in to your account
   https://auth.openai.com/codex/device

2. Enter this one-time code (expires in 15 minutes)
   692H-MMNA1
`;
    expect(findCodexDeviceAuth(sample)).toEqual({
      url: 'https://auth.openai.com/codex/device',
      userCode: '692H-MMNA1',
    });
  });
});

describe('CodexAccounts 管理、缓存与三种登录', () => {
  function setup(opts: Partial<ConstructorParameters<typeof CodexAccounts>[0]> = {}) {
    const store = new StateStore(path.join(tmp, 'state.json'));
    const baseHome = path.join(tmp, 'default-codex');
    const root = path.join(tmp, 'codex-accounts');
    fs.mkdirSync(baseHome, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    let clock = 1_700_000_000_000;
    const acc = new CodexAccounts({
      store,
      resolveCodex: () => ({ execPath: 'C:\\codex.exe', rawPath: 'C:\\codex.exe', installKind: 'npm' }),
      baseHome: () => baseHome,
      accountsRoot: () => root,
      now: () => clock,
      baseEnv: { PATH: process.env.PATH ?? '', OPENAI_API_KEY: 'sk-host-leak', CODEX_API_KEY: 'sk-codex-leak' },
      ...opts,
    });
    return { acc, store, baseHome, root, advance: (ms: number) => (clock += ms) };
  }

  it('init() 校验活跃目录并清理超 1 小时的孤儿目录', async () => {
    const { acc, store, root } = setup();
    const orphanOld = path.join(root, 'abcd1234');
    const orphanNew = path.join(root, 'efab5678');
    fs.mkdirSync(orphanOld, { recursive: true });
    fs.mkdirSync(orphanNew, { recursive: true });
    const oldTime = new Date(1_700_000_000_000 - 2 * 60 * 60_000);
    fs.utimesSync(orphanOld, oldTime, oldTime);
    const newTime = new Date(1_700_000_000_000 - 10 * 60_000);
    fs.utimesSync(orphanNew, newTime, newTime);
    store.state.codexAccounts.active = 'missing1';
    acc.init();
    await new Promise((r) => setTimeout(r, 30));
    expect(store.state.codexAccounts.active).toBeNull();
    expect(fs.existsSync(orphanOld)).toBe(false);
    expect(fs.existsSync(orphanNew)).toBe(true);
  });

  it('deviceAuth 登录：不泄漏宿主 API Key、解析 url/userCode、完成落盘；设备码未开启给中文提示', async () => {
    let capturedEnv: NodeJS.ProcessEnv = {};
    let capturedArgs: string[] = [];
    let procRef = makeFakeProc();
    const { acc } = setup({
      spawnLogin: (_exe, args, env) => {
        capturedArgs = args;
        capturedEnv = env;
        procRef = makeFakeProc();
        return procRef.proc;
      },
    });
    const st = acc.startLogin({ method: 'deviceAuth', label: '工作号' });
    expect(st.method).toBe('deviceAuth');
    expect(capturedArgs).toEqual(['-c', 'cli_auth_credentials_store="file"', 'login', '--device-auth']);
    expect(capturedEnv.OPENAI_API_KEY).toBeUndefined();
    expect(capturedEnv.CODEX_API_KEY).toBeUndefined();
    expect(capturedEnv.CODEX_HOME).toBeTruthy();

    procRef.emitOut('1. Open:\n   https://auth.openai.com/codex/device\n2. Enter this one-time code\n   ABCD-12345\n');
    const mid = acc.getLogin(st.loginId);
    expect(mid.status).toBe('waiting');
    expect(mid.url).toBe('https://auth.openai.com/codex/device');
    expect(mid.userCode).toBe('ABCD-12345');

    writeChatgptAuth(capturedEnv.CODEX_HOME!, 'work@example.com', 'ws-work', 'team');
    procRef.close(0);
    await new Promise((r) => setTimeout(r, 20));
    const done = acc.getLogin(st.loginId);
    expect(done.status).toBe('done');
    expect(done.accountId).toBeTruthy();
    const list = acc.list();
    expect(list.list.some((a) => a.id === done.accountId && a.email === 'work@example.com' && a.label === '工作号')).toBe(true);

    // 设备码未开启错误提示
    const st2 = acc.startLogin({ method: 'deviceAuth' });
    procRef.emitErr('Error: device code login is not enabled for this workspace\n');
    procRef.close(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(acc.getLogin(st2.loginId).error).toContain('未开启设备码登录');
  });

  it('chatgpt 登录：通过 app-server 拿 authUrl，completed 落盘；取消发 account/login/cancel；1455 端口占用中文提示', async () => {
    let lastProc = makeFakeProc();
    let lastHome = '';
    const rpcMsgs: any[] = [];
    const { acc } = setup({
      spawnLogin: (_exe, _args, env) => {
        lastHome = env.CODEX_HOME!;
        lastProc = makeFakeProc();
        lastProc.proc.stdin!.on('data', (d: Buffer | string) => {
          for (const line of d.toString('utf8').split('\n').filter(Boolean)) {
            const m = JSON.parse(line);
            rpcMsgs.push(m);
            if (m.method === 'initialize') {
              lastProc.emitOut(JSON.stringify({ id: m.id, result: {} }) + '\n');
            } else if (m.method === 'account/login/start') {
              lastProc.emitOut(JSON.stringify({ id: m.id, result: { type: 'chatgpt', loginId: 'rpc-1', authUrl: 'https://auth.openai.com/oauth/authorize?x=1' } }) + '\n');
            } else if (m.method === 'account/login/cancel') {
              lastProc.emitOut(JSON.stringify({ id: m.id, result: { status: 'canceled' } }) + '\n');
            }
          }
        });
        return lastProc.proc;
      },
    });

    const st = acc.startLogin({ method: 'chatgpt', label: '浏览器号' });
    await new Promise((r) => setTimeout(r, 20));
    expect(acc.getLogin(st.loginId)).toMatchObject({ status: 'waiting', url: 'https://auth.openai.com/oauth/authorize?x=1' });

    // 取消登录：发 account/login/cancel
    acc.cancelLogin(st.loginId);
    await new Promise((r) => setTimeout(r, 20));
    expect(rpcMsgs.some((m) => m.method === 'account/login/cancel' && m.params?.loginId === 'rpc-1')).toBe(true);
    expect(acc.getLogin(st.loginId).status).toBe('failed');

    // 再次登录并完成
    const st2 = acc.startLogin({ method: 'chatgpt' });
    await new Promise((r) => setTimeout(r, 20));
    writeChatgptAuth(lastHome, 'oauth@example.com', 'ws-oauth', 'plus');
    lastProc.emitOut(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'rpc-1', success: true, error: null } }) + '\n');
    await new Promise((r) => setTimeout(r, 30));
    expect(acc.getLogin(st2.loginId).status).toBe('done');

    // 1455 端口占用
    const st3 = acc.startLogin({ method: 'chatgpt' });
    await new Promise((r) => setTimeout(r, 20));
    lastProc.emitOut(JSON.stringify({ method: 'account/login/completed', params: { loginId: 'rpc-1', success: false, error: 'bind 127.0.0.1:1455 EADDRINUSE' } }) + '\n');
    await new Promise((r) => setTimeout(r, 20));
    expect(acc.getLogin(st3.loginId).error).toContain('1455');
  });

  it('apiKey 登录：key 只进 stdin，不进命令行与状态；判重生效', async () => {
    let capturedArgs: string[] = [];
    let procRef = makeFakeProc();
    let lastHome = '';
    const { acc, store } = setup({
      spawnLogin: (_exe, args, env) => {
        capturedArgs = args;
        lastHome = env.CODEX_HOME!;
        procRef = makeFakeProc();
        return procRef.proc;
      },
    });
    const secret = 'sk-proj-myverysecretkey1234567890';
    const st = acc.startLogin({ method: 'apiKey', apiKey: secret, label: 'API 号' });
    expect(capturedArgs.join(' ')).not.toContain(secret);
    expect(procRef.getStdin()).toContain(secret);
    writeApiKeyAuth(lastHome, secret);
    procRef.close(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(acc.getLogin(st.loginId).status).toBe('done');
    expect(JSON.stringify(store.state.codexAccounts)).not.toContain(secret);

    // 相同 API Key 判重拒绝
    const st2 = acc.startLogin({ method: 'apiKey', apiKey: secret });
    writeApiKeyAuth(lastHome, secret);
    procRef.close(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(acc.getLogin(st2.loginId).status).toBe('failed');
    expect(acc.getLogin(st2.loginId).error).toContain('已经添加过');
  });

  it('重登原子替换 auth.json（保留 sessions 等文件），并在前后调用 resetAccount', async () => {
    let procRef = makeFakeProc();
    let lastHome = '';
    const resetAccount = vi.fn();
    const { acc, store, root } = setup({
      resetAccount,
      spawnLogin: (_exe, _args, env) => {
        lastHome = env.CODEX_HOME!;
        procRef = makeFakeProc();
        return procRef.proc;
      },
    });
    const existingDir = path.join(root, 'aaaa1111');
    writeChatgptAuth(existingDir, 'old@example.com', 'ws-1', 'plus');
    fs.writeFileSync(path.join(existingDir, 'sessions.txt'), 'keep-me');
    store.state.codexAccounts.list.push({ id: 'aaaa1111', label: '旧号', dir: existingDir, createdAt: 1 });

    const st = acc.startLogin({ method: 'deviceAuth', accountId: 'aaaa1111' });
    writeChatgptAuth(lastHome, 'old@example.com', 'ws-1', 'pro');
    procRef.close(0);
    await new Promise((r) => setTimeout(r, 30));
    expect(acc.getLogin(st.loginId).status).toBe('done');
    expect(resetAccount).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(existingDir, 'sessions.txt'), 'utf8')).toBe('keep-me');
    expect(readAuthJsonMeta(existingDir)?.planType).toBe('pro');
  });

  it('探测缓存 TTL（成功 30min、失败 60s、额度 90s）与 noteRateLimits', async () => {
    let accountCalls = 0;
    let limitCalls = 0;
    const { acc, baseHome, advance } = setup({
      readAccount: async () => {
        accountCalls++;
        return { account: { type: 'chatgpt', email: 'def@example.com', planType: 'plus' }, requiresOpenaiAuth: true };
      },
      readRateLimits: async () => {
        limitCalls++;
        return { rateLimits: { limitId: 'codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1760000000 }, planType: 'plus' } };
      },
    });
    writeChatgptAuth(baseHome, 'def@example.com', 'ws-def', 'plus');

    acc.list();
    await acc.waitForProbes();
    expect(accountCalls).toBe(1);
    expect(limitCalls).toBe(1);

    // 30 秒内再次 list：命中缓存
    advance(30_000);
    acc.list();
    await acc.waitForProbes();
    expect(accountCalls).toBe(1);
    expect(limitCalls).toBe(1);

    // 超过 90 秒：只刷额度，不重查 account/read
    advance(70_000);
    acc.list();
    await acc.waitForProbes();
    expect(accountCalls).toBe(1);
    expect(limitCalls).toBe(2);

    // 推送更新额度
    acc.noteRateLimits('default', { rateLimits: { limitId: 'codex', primary: { usedPercent: 55, windowDurationMins: 300, resetsAt: 1760000000 } } });
    expect(acc.list().list[0]?.quota?.groups[0]?.primary?.usedPercent).toBe(55);
  });

  it('remove 运行中拒绝 409；默认账号不能移除；dedupe 清理隐藏重复项', async () => {
    let busy = 1;
    const { acc, store, baseHome, root } = setup({
      running: (id) => (id === 'aaaa1111' ? busy : 0),
    });
    writeChatgptAuth(baseHome, 'dup@example.com', 'ws-dup', 'plus');
    const dir1 = path.join(root, 'aaaa1111');
    const dir2 = path.join(root, 'bbbb2222');
    writeChatgptAuth(dir1, 'dup@example.com', 'ws-dup', 'plus');
    writeChatgptAuth(dir2, 'other@example.com', 'ws-other', 'plus');
    store.state.codexAccounts.list.push(
      { id: 'aaaa1111', label: '重复', dir: dir1, createdAt: 1 },
      { id: 'bbbb2222', label: '独立', dir: dir2, createdAt: 2 },
    );

    await expect(acc.remove('default')).rejects.toMatchObject({ status: 400 });
    await expect(acc.remove('aaaa1111')).rejects.toMatchObject({ status: 409 });

    // aaaa1111 与 default 身份相同被去重隐藏，但正在执行中被 dedupe 跳过
    expect(acc.list().duplicates).toBe(1);
    expect(await acc.dedupe()).toEqual({ removed: 0, skipped: 1 });
    busy = 0;
    expect(await acc.dedupe()).toEqual({ removed: 1, skipped: 0 });
    expect(fs.existsSync(dir1)).toBe(false);
    expect(acc.list().duplicates).toBeUndefined();
  });
});

describe('HTTP 路由与 Manager codex 路线选择', () => {
  it('/api/codex-accounts* 与 /api/delegate/models?backend=codex 路由及 Manager fallbackReason', async () => {
    const store = new StateStore(path.join(tmp, 'state.json'));
    const workspaces = new Workspaces(store);
    const dots = new DotState(store);
    const sessions = new Sessions(dots);
    const pins = new Pins(store);
    const trash = new Trash(store, dots, pins);
    const baseHome = path.join(tmp, 'def');
    const root = path.join(tmp, 'accs');
    fs.mkdirSync(baseHome, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    writeChatgptAuth(baseHome, 'u@example.com', 'ws-1', 'plus');
    const codexAccounts = new CodexAccounts({
      store,
      resolveCodex: () => ({ execPath: 'C:\\codex.exe', rawPath: 'C:\\codex.exe', installKind: 'npm' }),
      baseHome: () => baseHome,
      accountsRoot: () => root,
    });

    let codexAvail = { ok: true } as { ok: boolean; reason?: string };
    const fakeCodexBackend: DelegateBackend = {
      id: 'codex',
      label: 'Codex',
      available: () => codexAvail.ok,
      availability: () => codexAvail,
      accountAvailability: () => codexAvail,
      models: async () => ({
        models: [{ value: 'gpt-5', displayName: 'GPT-5', efforts: ['none', 'low', 'medium', 'high', 'ultra'] }],
        current: { model: 'gpt-5', effort: 'medium' },
        at: 1,
      }),
      run: async () => ({ stopReason: 'end_turn', response: 'ok', sessionId: 's1', toolCalls: 0 }),
    };

    const manager = new Manager({
      dots,
      sessions,
      pins,
      delegateBackends: { codex: fakeCodexBackend },
      delegateAccounts: () => [{ backend: 'codex', id: 'default', label: '默认账号', group: 'codex' }],
      subagents: {
        get: () => store.state.subagents,
        set: (c) => {
          store.state.subagents = structuredClone(c);
          store.save();
        },
      },
    });

    let port = 0;
    const handler = createHandler({
      port: () => port,
      version: '0.0.0',
      webDist: null,
      workspaces,
      sessions,
      manager,
      account: { get: async () => null },
      codexAccounts,
      delegateModels: async (_cwd, _refresh, backend) => {
        if (backend === 'codex') return fakeCodexBackend.models({ cwd: _cwd });
        throw new Error('not configured');
      },
      usage: { get: async () => null },
      store,
      previews: new Previews(),
      pins,
      trash,
      pricing: { table: () => ({ source: 'builtin', fetchedAt: 0, models: [] }) },
    });

    const srv = http.createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    port = (srv.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const accList = (await (await fetch(`${base}/api/codex-accounts`)).json()) as any;
      expect(accList.installed).toBe(true);
      expect(accList.list[0].id).toBe('default');

      const models = (await (await fetch(`${base}/api/delegate/models?backend=codex`)).json()) as any;
      expect(models.models[0].efforts).toContain('ultra');

      // 设置 codex 委派路线（含 ultra）
      const postRes = await fetch(`${base}/api/subagents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'delegate',
          native: { model: 'sonnet', effort: 'medium' },
          delegate: { default: { backend: 'codex', accountId: 'default', model: 'gpt-5', effort: 'ultra' } },
        }),
      });
      expect(postRes.status).toBe(200);
      const postJson = (await postRes.json()) as any;
      expect(postJson.state.effective).toBe('delegate');
      expect(postJson.state.accounts).toEqual([{ backend: 'codex', id: 'default', label: '默认账号', group: 'codex' }]);

      // codex 不可用时回退 native 并报告 fallbackReason
      codexAvail = { ok: false, reason: 'Codex 账号未登录' };
      const st2 = (await (await fetch(`${base}/api/subagents`)).json()) as any;
      expect(st2.effective).toBe('native');
      expect(st2.fallbackReason).toBe('Codex 账号未登录');
    } finally {
      codexAccounts.dispose();
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});
