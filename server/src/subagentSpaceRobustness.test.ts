// 账号与子代理独立配置空间健壮性测试：
// 1. 双向令牌同步（损坏/半写入/空文件/无 expiresAt/身份变更/跨账号防串号/已登出不复活/原子写）
// 2. 共享与隔离（硬链接回退、链接失效、同名真实目录冲突与同秒备份、主目录被删、会话历史隔离）
// 3. 账号选择与隔离（主/子同账号、切换主账号与并行模式、账号删除/主目录丢失、Claude 与 Agy 互不干扰）
// 4. 路径穿越与特殊 ID 安全性（.. / \ 盘符、符号链接指向 baseClaudeHome 防护）
// 5. macOS 钥匙串适配器 mock（security 参数、errSecItemNotFound 用户名回退、-i hex 写入、非 ASCII hex 读取、Windows 不触发）
// 6. 清理安全性（绝不误删主空间、符号链接目录不跟随删除）
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnSyncReturns } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgyAccounts } from './accounts/agy.js';
import { Accounts, DEFAULT_ID } from './accounts/index.js';
import { ensureLinks, SUBAGENT_SHARED_DIRS, SUBAGENT_SHARED_FILES } from './accounts/links.js';
import {
  createMacKeychainAdapter,
  isNewerCred,
  KEYCHAIN_ACCOUNT,
  macKeychainServiceName,
  prepareSubagentSpace,
  removeSubagentSpace,
  syncClaudeJsonToSubagent,
  syncSubagentToMain,
  wipedCredAccount,
  writeFileAtomic,
} from './accounts/subagent-space.js';
import { setActiveConfigDir, subagentAccountDir } from './paths.js';
import { StateStore } from './workspaces.js';

let tmp: string;
let base: string;
let root: string;
let subRoot: string;
let agyRoot: string;
let cosyeeDir: string;
const saved: Record<string, string | undefined> = {};

const ENV_KEYS = [
  'CLAUDE_CONFIG_DIR',
  'COSYEE_ACCOUNTS_DIR',
  'COSYEE_SUBAGENT_ACCOUNTS_DIR',
  'COSYEE_AGY_ACCOUNTS_DIR',
  'COSYEE_HOME',
];

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-subrobust-'));
  base = path.join(tmp, 'claude');
  root = path.join(tmp, 'accounts');
  subRoot = path.join(tmp, 'subagents');
  agyRoot = path.join(tmp, 'agy-accounts');
  cosyeeDir = path.join(tmp, 'cosyee');
  fs.mkdirSync(base, { recursive: true });
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = base;
  process.env.COSYEE_ACCOUNTS_DIR = root;
  process.env.COSYEE_SUBAGENT_ACCOUNTS_DIR = subRoot;
  process.env.COSYEE_AGY_ACCOUNTS_DIR = agyRoot;
  process.env.COSYEE_HOME = cosyeeDir;
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
  fs.writeFileSync(f, JSON.stringify(j, null, 2));
};
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));

function writeCreds(
  dir: string,
  opts: { accessToken?: string; refreshToken?: string; expiresAt?: number; mtimeMs?: number } = {},
) {
  const file = path.join(dir, '.credentials.json');
  writeJson(file, {
    claudeAiOauth: {
      ...(opts.accessToken !== undefined ? { accessToken: opts.accessToken } : { accessToken: 'acc-tok' }),
      ...(opts.refreshToken !== undefined ? { refreshToken: opts.refreshToken } : { refreshToken: 'ref-tok' }),
      ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
      subscriptionType: 'pro',
    },
  });
  if (opts.mtimeMs !== undefined) {
    const d = new Date(opts.mtimeMs);
    fs.utimesSync(file, d, d);
  }
}

function writeClaudeJson(
  dir: string,
  oauth: { accountUuid?: string; displayName?: string; emailAddress?: string } | null,
) {
  const file = path.join(dir, '.claude.json');
  writeJson(file, oauth ? { oauthAccount: oauth } : {});
}

class FakeProc extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: string | null = null;
  pid = 23456;
  exit(code: number) {
    this.exitCode = code;
    this.emit('close', code, null);
  }
  kill() {
    this.exit(1);
    return true;
  }
}

function makeAccounts(store?: StateStore) {
  const st = store ?? new StateStore(path.join(tmp, 'state.json'));
  const events: string[] = [];
  let proc: FakeProc | null = null;
  let env: NodeJS.ProcessEnv | null = null;
  const accounts = new Accounts({
    store: st,
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
    subagentSpace: { platform: 'linux' },
  });
  accounts.init();
  return { store: st, accounts, events, proc: () => proc!, env: () => env! };
}

function addClaudeAccount(a: ReturnType<typeof makeAccounts>, uuid: string, name: string, expiresAt = 2000) {
  const login = a.accounts.startLogin({ label: name });
  const dir = a.env().CLAUDE_CONFIG_DIR!;
  writeCreds(dir, { accessToken: `acc-${name}`, refreshToken: `ref-${name}`, expiresAt });
  writeClaudeJson(dir, { accountUuid: uuid, displayName: name, emailAddress: `${name}@x.test` });
  a.proc().exit(0);
  return { id: a.accounts.getLogin(login.loginId).accountId!, dir };
}

describe('1. 双向令牌同步健壮性', () => {
  it('损坏/半写入/空对象凭据绝不覆盖另一端的有效凭据（即使损坏文件 mtime 更新且无 expiresAt）', () => {
    // 准备一个没有 expiresAt 的有效凭据（走 mtime 分支）
    const oldTime = Date.now() - 60_000;
    writeCreds(base, { accessToken: 'valid-main', refreshToken: 'ref-main', mtimeMs: oldTime });
    writeClaudeJson(base, { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' });
    const subDir = prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });
    const subCredFile = path.join(subDir, '.credentials.json');
    fs.utimesSync(subCredFile, new Date(oldTime), new Date(oldTime));

    // 子空间文件被半写入损坏，且 mtime 更新
    fs.writeFileSync(subCredFile, '{"claudeAiOauth":{"accessToken":"trunc');
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(false);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.accessToken).toBe('valid-main');

    // 子空间变成空 JSON 对象 {}，同样不能覆盖主空间
    fs.writeFileSync(subCredFile, '{}');
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(false);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.accessToken).toBe('valid-main');

    // 反过来：子空间损坏时，主→子可以用主空间的有效凭据自动修复子空间
    prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });
    expect(readJson(subCredFile).claudeAiOauth.accessToken).toBe('valid-main');
  });

  it('主空间凭据损坏且无有效凭据时，prepareSubagentSpace 报错而不复制损坏内容', () => {
    fs.writeFileSync(path.join(base, '.credentials.json'), '{bad json');
    writeClaudeJson(base, { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' });
    expect(() => prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' })).toThrow(/未登录|缺少凭据/);
    expect(fs.existsSync(path.join(subagentAccountDir(DEFAULT_ID), '.credentials.json'))).toBe(false);
  });

  it('跨账号防串号：主空间已换为账号 B 时，旧子空间（账号 A）即使 expiresAt 更大也不得回写主空间', () => {
    writeCreds(base, { accessToken: 'tok-A', refreshToken: 'ref-A', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'uuid-A', displayName: 'A', emailAddress: 'a@x.test' });
    const subDir = prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });

    // 子空间（账号 A）刷新了更新的令牌（expiresAt 9000）
    writeCreds(subDir, { accessToken: 'tok-A-new', refreshToken: 'ref-A-new', expiresAt: 9000 });

    // 主空间切换登录成了账号 B（expiresAt 2000，比子空间旧）
    writeCreds(base, { accessToken: 'tok-B', refreshToken: 'ref-B', expiresAt: 2000 });
    writeClaudeJson(base, { accountUuid: 'uuid-B', displayName: 'B', emailAddress: 'b@x.test' });

    // 子→主回写必须拒绝，保护账号 B 的凭据不被账号 A 覆盖
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(false);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.accessToken).toBe('tok-B');

    // 下次主→子准备时，因身份变化强制用账号 B 覆盖子空间（即使 B 的 expiresAt < A）
    prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });
    expect(readJson(path.join(subDir, '.credentials.json')).claudeAiOauth.accessToken).toBe('tok-B');
    expect(readJson(path.join(subDir, '.claude.json')).oauthAccount.accountUuid).toBe('uuid-B');
  });

  it('缺失 accountUuid 时用 emailAddress 识别跨账号身份变化（双向均生效）', () => {
    writeCreds(base, { accessToken: 'tok-A', refreshToken: 'ref-A', expiresAt: 1000 });
    writeClaudeJson(base, { displayName: 'A', emailAddress: 'alice@x.test' });
    const subDir = prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });

    writeCreds(subDir, { accessToken: 'tok-A-new', refreshToken: 'ref-A-new', expiresAt: 9000 });
    writeCreds(base, { accessToken: 'tok-B', refreshToken: 'ref-B', expiresAt: 2000 });
    writeClaudeJson(base, { displayName: 'B', emailAddress: 'bob@x.test' });

    // 子→主拒绝跨账号回写
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(false);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.accessToken).toBe('tok-B');

    // 主→子检测到邮箱变化，强制覆盖
    prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });
    expect(readJson(path.join(subDir, '.credentials.json')).claudeAiOauth.accessToken).toBe('tok-B');
  });

  it('主空间已登出（删除凭据）时：子→主不复活旧凭据，主→子报错而不静默复用残留凭据', () => {
    writeCreds(base, { accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' });
    const subDir = prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });
    expect(fs.existsSync(path.join(subDir, '.credentials.json'))).toBe(true);

    // 主空间登出：删掉凭据文件
    fs.rmSync(path.join(base, '.credentials.json'), { force: true });

    // 子→主不得复活已登出的主空间凭据
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(false);
    expect(fs.existsSync(path.join(base, '.credentials.json'))).toBe(false);

    // 主→子应报错（不能静默沿用子空间残留凭据）
    expect(() => prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' })).toThrow(/未登录|缺少凭据/);
  });

  it('主空间凭据被 CLI 刷新失败清空（空令牌、保留账号字段）时：子→主回写恢复登录，主→子也能照常准备', () => {
    writeCreds(base, { accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' });
    const subDir = prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });

    // 子空间进程先刷新，轮换出新令牌；主空间拿旧 refresh token 刷新被拒，CLI 把主空间令牌清空
    writeJson(path.join(subDir, '.credentials.json'), {
      claudeAiOauth: { accessToken: 'tok-2', refreshToken: 'ref-2', expiresAt: 2000, accountUuid: 'u-1', subscriptionType: 'pro' },
    });
    const wiped = { claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, refreshTokenExpiresAt: 9e12, accountUuid: 'u-1', subscriptionType: 'pro' } };
    writeJson(path.join(base, '.credentials.json'), wiped);
    expect(wipedCredAccount(JSON.stringify(wiped))).toBe('u-1');

    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(true);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.accessToken).toBe('tok-2');

    // 主→子准备不再报「未登录」
    writeJson(path.join(base, '.credentials.json'), wiped);
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(true);
    expect(() => prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' })).not.toThrow();
  });

  it('清空凭据里记录的 accountUuid 与子空间凭据不一致时不回写；空壳（无任何账号痕迹）仍按登出处理', () => {
    writeCreds(base, { accessToken: 'tok-1', refreshToken: 'ref-1', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' });
    const subDir = prepareSubagentSpace(DEFAULT_ID, null, { platform: 'linux' });
    writeJson(path.join(subDir, '.credentials.json'), {
      claudeAiOauth: { accessToken: 'tok-2', refreshToken: 'ref-2', expiresAt: 2000, accountUuid: 'u-1' },
    });

    writeJson(path.join(base, '.credentials.json'), {
      claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, accountUuid: 'u-other' },
    });
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(false);
    expect(readJson(path.join(base, '.credentials.json')).claudeAiOauth.accountUuid).toBe('u-other');

    writeJson(path.join(base, '.credentials.json'), { claudeAiOauth: { accessToken: '', refreshToken: '' } });
    expect(wipedCredAccount(fs.readFileSync(path.join(base, '.credentials.json'), 'utf8'))).toBeUndefined();
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'linux' })).toBe(false);
  });

  it('macOS：钥匙串里主空间凭据被清空时同样回写恢复', () => {
    const store = new Map<string, string>();
    const kc = { read: (s: string) => store.get(s) ?? null, write: (s: string, d: string) => void store.set(s, d) };
    const mainSvc = macKeychainServiceName(null);
    store.set(mainSvc, JSON.stringify({ claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1000, accountUuid: 'u-1' } }));
    writeClaudeJson(base, { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' });
    const subDir = prepareSubagentSpace(DEFAULT_ID, null, { platform: 'darwin', keychain: kc, envConfigDir: '' });
    const subSvc = macKeychainServiceName(subDir);
    const fresh = JSON.stringify({ claudeAiOauth: { accessToken: 'a2', refreshToken: 'r2', expiresAt: 2000, accountUuid: 'u-1' } });
    store.set(subSvc, fresh);
    store.set(mainSvc, JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, accountUuid: 'u-1' } }));
    expect(syncSubagentToMain(DEFAULT_ID, null, { platform: 'darwin', keychain: kc, envConfigDir: '' })).toBe(true);
    expect(store.get(mainSvc)).toBe(fresh);
  });

  it('isNewerCred 边界：相同内容不写；expiresAt 相等时按 mtime；单边缺 expiresAt 时有值者胜', () => {
    expect(isNewerCred({ raw: 'x', expiresAt: 100, mtimeMs: 999 }, { raw: 'x', expiresAt: 100, mtimeMs: 1 })).toBe(false);
    expect(isNewerCred({ raw: 'a', expiresAt: 100, mtimeMs: 200 }, { raw: 'b', expiresAt: 100, mtimeMs: 100 })).toBe(true);
    expect(isNewerCred({ raw: 'a', expiresAt: 100, mtimeMs: 50 }, { raw: 'b', expiresAt: 100, mtimeMs: 100 })).toBe(false);
    expect(isNewerCred({ raw: 'a', expiresAt: 100, mtimeMs: 1 }, { raw: 'b', expiresAt: null, mtimeMs: 999 })).toBe(true);
    expect(isNewerCred({ raw: 'a', expiresAt: null, mtimeMs: 999 }, { raw: 'b', expiresAt: 100, mtimeMs: 1 })).toBe(false);
  });

  it('writeFileAtomic 原子覆写已存在文件且不遗留 .tmp 文件', () => {
    const target = path.join(tmp, 'atomic', 'cred.json');
    writeFileAtomic(target, '{"v":1}', 0o600);
    writeFileAtomic(target, '{"v":2}', 0o600);
    expect(readJson(target)).toEqual({ v: 2 });
    const leftTmp = fs.readdirSync(path.dirname(target)).filter((n) => n.endsWith('.tmp'));
    expect(leftTmp).toEqual([]);
  });
});

describe('2. 共享与隔离健壮性', () => {
  it('共享链接失效、目标被删、同名真实目录存在冲突、同一秒内多次备份均能正确恢复', () => {
    fs.mkdirSync(path.join(base, 'skills', 's1'), { recursive: true });
    fs.writeFileSync(path.join(base, 'skills', 's1', 'SKILL.md'), 'main-skill');
    fs.writeFileSync(path.join(base, 'settings.json'), '{"theme":"light"}');

    const subDir = path.join(subRoot, 'acc1');
    expect(ensureLinks(base, subDir, { dirs: SUBAGENT_SHARED_DIRS, files: SUBAGENT_SHARED_FILES })).toEqual([]);

    // 1) 主空间删掉 skills 目录后再次 ensureLinks：重建主目录且链接继续有效
    fs.rmSync(path.join(base, 'skills'), { recursive: true, force: true });
    expect(ensureLinks(base, subDir, { dirs: SUBAGENT_SHARED_DIRS, files: SUBAGENT_SHARED_FILES })).toEqual([]);
    expect(fs.existsSync(path.join(base, 'skills'))).toBe(true);
    expect(fs.lstatSync(path.join(subDir, 'skills')).isSymbolicLink()).toBe(true);

    // 2) 同名真实目录存在与主目录冲突的文件，且在同一秒内发生两次，不会因 orphan 撞名而失败
    for (let round = 1; round <= 2; round++) {
      fs.writeFileSync(path.join(base, 'skills', 'conflict.txt'), 'base-v');
      // 把链接替换成真实目录，里面放同名冲突文件
      const linkPath = path.join(subDir, 'skills');
      try { fs.unlinkSync(linkPath); } catch { fs.rmdirSync(linkPath); }
      fs.mkdirSync(linkPath, { recursive: true });
      fs.writeFileSync(path.join(linkPath, 'conflict.txt'), `sub-v-${round}`);
      expect(ensureLinks(base, subDir, { dirs: SUBAGENT_SHARED_DIRS, files: SUBAGENT_SHARED_FILES })).toEqual([]);
      expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(base, 'skills', 'conflict.txt'), 'utf8')).toBe('base-v');
    }
    const orphans = fs.readdirSync(subDir).filter((n) => n.startsWith('skills.cosyee-orphan-'));
    expect(orphans.length).toBe(2);

    // 3) 隔离验证：在子空间写入 projects 与 history.jsonl 不会影响主空间
    fs.mkdirSync(path.join(subDir, 'projects', 'sub-only'), { recursive: true });
    fs.writeFileSync(path.join(subDir, 'history.jsonl'), '{"sub":true}\n');
    expect(fs.existsSync(path.join(base, 'projects', 'sub-only'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'history.jsonl'))).toBe(false);
  });

  it('无符号链接权限时文件共享通过硬链接生效，双向读写一致', () => {
    fs.writeFileSync(path.join(base, 'settings.json'), '{"v":1}');
    const subDir = path.join(subRoot, 'hardlink1');
    const spy = vi.spyOn(fs, 'symlinkSync').mockImplementation((target, linkPath, type) => {
      if (type === 'file') {
        const err = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        throw err;
      }
      return (fs.symlinkSync as unknown as { getMockImplementation: () => unknown }) && fs.mkdirSync(String(linkPath), { recursive: true });
    });
    try {
      expect(ensureLinks(base, subDir, { dirs: [], files: ['settings.json'] })).toEqual([]);
      // 再次调用应识别硬链接（ino/dev 相同）并保持不报错
      expect(ensureLinks(base, subDir, { dirs: [], files: ['settings.json'] })).toEqual([]);
    } finally {
      spy.mockRestore();
    }
    fs.writeFileSync(path.join(base, 'settings.json'), '{"v":2}');
    expect(fs.readFileSync(path.join(subDir, 'settings.json'), 'utf8')).toBe('{"v":2}');
  });
});

describe('3. 账号选择、主目录丢失与 Claude / Antigravity 互不干扰', () => {
  it('非默认账号主目录被外部删除时，prepareSubagent 报错并记录 claudeError，而非静默用残留子空间', () => {
    writeCreds(base, { accessToken: 'def', refreshToken: 'def-r', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'u-def', displayName: 'Def', emailAddress: 'def@x.test' });
    const a = makeAccounts();
    const work = addClaudeAccount(a, 'u-work', 'Work', 2000);
    a.accounts.setSubagentClaude(work.id);

    // 首次准备成功
    const prep = a.accounts.prepareSubagent(work.id)!;
    expect(fs.existsSync(path.join(prep.dir, '.credentials.json'))).toBe(true);

    // 模拟用户把主账号目录删掉
    fs.rmSync(work.dir, { recursive: true, force: true });

    expect(() => a.accounts.prepareSubagent(work.id)).toThrow(/配置目录不存在/);
    expect(a.accounts.list().subagent?.claudeError).toMatch(/配置目录不存在/);
  });

  it('Claude 主账号、Claude 子代理账号、Antigravity 账号各自独立，互不干扰', async () => {
    writeCreds(base, { accessToken: 'def', refreshToken: 'def-r', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'u-def', displayName: 'Def', emailAddress: 'def@x.test' });
    const store = new StateStore(path.join(tmp, 'shared-state.json'));
    const a = makeAccounts(store);
    const work = addClaudeAccount(a, 'u-work', 'Work', 2000);

    // 构造一个 Agy 账号
    const agyDir = path.join(agyRoot, 'agy001');
    fs.mkdirSync(agyDir, { recursive: true });
    fs.writeFileSync(path.join(agyDir, 'antigravity-oauth-token'), 'tok');
    store.state.agyAccounts.list.push({ id: 'agy001', label: 'Agy工作', dir: agyDir, createdAt: 100 });
    const agy = new AgyAccounts({ store, resolveAgy: () => 'agy' });
    agy.init();

    // 分别设置：Claude 主账号 = default，Claude 子代理 = work，Agy = agy001
    a.accounts.setSubagentClaude(work.id);
    await agy.switchTo('agy001');
    expect(a.accounts.activeId()).toBe(DEFAULT_ID);
    expect(a.accounts.subagentClaudeId()).toBe(work.id);
    expect(agy.activeId()).toBe('agy001');

    // 切换 Claude 主账号到 work（与子代理同一账号），开启并行模式，再切回 default
    await a.accounts.switchTo(work.id, false);
    expect(a.accounts.prepareSubagent(work.id)?.id).toBe(work.id);
    await a.accounts.setMode('parallel', false);
    await a.accounts.switchTo(DEFAULT_ID, false);

    // Claude 子代理与 Agy 均不受影响
    expect(a.accounts.subagentClaudeId()).toBe(work.id);
    expect(agy.activeId()).toBe('agy001');

    // 移除 Agy 账号不影响 Claude 主/子账号
    await agy.remove('agy001');
    expect(agy.activeId()).toBeNull();
    expect(a.accounts.subagentClaudeId()).toBe(work.id);
  });
});

describe('4. 路径穿越与清理安全性', () => {
  it('非法 accountId（含 .. / \\ 空格 空串）被拒绝，绝不在 subagentAccountsRoot 外建目录或读写凭据', () => {
    writeCreds(base, { accessToken: 'def', refreshToken: 'def-r', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'u-def', displayName: 'Def', emailAddress: 'def@x.test' });
    const badIds = ['', '.', '..', '../escape', '..\\escape', 'a/b', 'a\\b', 'C:\\evil', 'acc id'];
    for (const bad of badIds) {
      expect(() => subagentAccountDir(bad)).toThrow();
      expect(() => prepareSubagentSpace(bad, null, { platform: 'linux' })).toThrow();
      expect(syncSubagentToMain(bad, null, { platform: 'linux' })).toBe(false);
      expect(() => removeSubagentSpace(bad, { platform: 'linux' })).not.toThrow();
    }
    expect(fs.existsSync(path.join(tmp, 'escape'))).toBe(false);
  });

  it('removeSubagentSpace 遇到指向基础目录 ~/.claude 的符号链接时只解除链接，绝不删基础目录内容（含其中的链接）', () => {
    fs.mkdirSync(path.join(base, 'projects', 'important'), { recursive: true });
    fs.writeFileSync(path.join(base, 'settings.json'), '{"precious":true}');
    const baseSubTarget = path.join(tmp, 'external-skill-target');
    fs.mkdirSync(baseSubTarget, { recursive: true });
    const baseInnerLink = path.join(base, 'custom-link');
    fs.symlinkSync(baseSubTarget, baseInnerLink, process.platform === 'win32' ? 'junction' : 'dir');
    fs.mkdirSync(subRoot, { recursive: true });

    // 恶意/异常构造：subRoot/evil01 是指向 base 的目录链接
    const evilLink = path.join(subRoot, 'evil01');
    fs.symlinkSync(base, evilLink, process.platform === 'win32' ? 'junction' : 'dir');

    removeSubagentSpace('evil01', { platform: 'linux' });
    expect(fs.existsSync(evilLink)).toBe(false);
    // 基础目录及其内部符号链接毫发无损
    expect(fs.existsSync(path.join(base, 'projects', 'important'))).toBe(true);
    expect(fs.readFileSync(path.join(base, 'settings.json'), 'utf8')).toBe('{"precious":true}');
    expect(fs.lstatSync(baseInnerLink).isSymbolicLink()).toBe(true);
  });

  it('并发启动两个子代理任务时不会把新令牌覆盖成旧令牌，也不遗留临时文件', async () => {
    writeCreds(base, { accessToken: 'tok-v1', refreshToken: 'ref-v1', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' });
    const a = makeAccounts();
    const first = a.accounts.prepareSubagent(DEFAULT_ID)!;

    // 模拟子空间已有更新的令牌（如运行中的子代理刚刷新）
    writeCreds(first.dir, { accessToken: 'tok-v2', refreshToken: 'ref-v2', expiresAt: 5000 });

    // 并发准备同一个账号的子代理空间
    const [p1, p2] = await Promise.all([
      Promise.resolve().then(() => a.accounts.prepareSubagent(DEFAULT_ID)!),
      Promise.resolve().then(() => a.accounts.prepareSubagent(DEFAULT_ID)!),
    ]);
    expect(p1.dir).toBe(p2.dir);
    // 子空间的新令牌（5000）未被主空间的旧令牌（1000）覆盖
    expect(readJson(path.join(p1.dir, '.credentials.json')).claudeAiOauth.accessToken).toBe('tok-v2');
    const tmpFiles = fs.readdirSync(p1.dir).filter((n) => n.endsWith('.tmp'));
    expect(tmpFiles).toEqual([]);
  });
});

describe('5. macOS 钥匙串适配器与平台隔离 mock', () => {
  function fakeSpawnRes(partial: Partial<SpawnSyncReturns<string>>): SpawnSyncReturns<string> {
    return {
      pid: 1,
      output: ['', partial.stdout ?? '', partial.stderr ?? ''],
      stdout: partial.stdout ?? '',
      stderr: partial.stderr ?? '',
      status: partial.status ?? 0,
      signal: null,
      error: partial.error,
    };
  }

  it('read：默认用 claude-code-user；44 时回退系统用户名；支持非 ASCII 凭据的 hex 解码；非 0 退出码抛错', () => {
    const calls: { cmd: string; args: readonly string[] }[] = [];
    const utf8Cred = JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', user: '张三' } });
    const hexCred = Buffer.from(utf8Cred, 'utf8').toString('hex');

    let step = 0;
    const mockSpawn = vi.fn((cmd: string, args: readonly string[]) => {
      calls.push({ cmd, args });
      step++;
      if (step === 1) return fakeSpawnRes({ status: 44 }); // claude-code-user 不存在
      if (step === 2) return fakeSpawnRes({ status: 0, stdout: `${hexCred}\n` }); // 回退系统用户命中且返回 hex
      return fakeSpawnRes({ status: 36, stderr: 'User interaction is not allowed.' });
    });

    const kc = createMacKeychainAdapter(mockSpawn as never);
    const val = kc.read('Claude Code-credentials');
    expect(val).toBe(utf8Cred);
    expect(calls[0]).toEqual({
      cmd: 'security',
      args: ['find-generic-password', '-a', KEYCHAIN_ACCOUNT, '-w', '-s', 'Claude Code-credentials'],
    });
    expect(calls[1]!.args[2]).toBe(os.userInfo().username);

    expect(() => kc.read('Claude Code-credentials')).toThrow(/退出码 36/);
  });

  it('write：经 stdin security -i 传 hex，不把令牌暴露在命令行参数中；remove 调 delete-generic-password', () => {
    const calls: { cmd: string; args: readonly string[]; input?: unknown }[] = [];
    const mockSpawn = vi.fn((cmd: string, args: readonly string[], opts?: { input?: unknown }) => {
      calls.push({ cmd, args, input: opts?.input });
      return fakeSpawnRes({ status: 0 });
    });

    const kc = createMacKeychainAdapter(mockSpawn as never);
    const secret = '{"claudeAiOauth":{"accessToken":"secret-tok"}}';
    kc.write('Claude Code-credentials-12345678', secret);
    expect(calls[0]!.cmd).toBe('security');
    expect(calls[0]!.args).toEqual(['-i']);
    const input = String(calls[0]!.input);
    expect(input).not.toContain('secret-tok');
    expect(input).toContain(Buffer.from(secret, 'utf8').toString('hex'));
    expect(input).toContain(`-a "${KEYCHAIN_ACCOUNT}" -s "Claude Code-credentials-12345678"`);

    kc.remove?.('Claude Code-credentials-12345678');
    expect(calls[1]).toEqual({
      cmd: 'security',
      args: ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', 'Claude Code-credentials-12345678'],
      input: undefined,
    });
  });

  it('win32 平台绝不触发 KeychainAdapter', () => {
    const kc = {
      read: vi.fn(() => { throw new Error('should not call keychain on win32'); }),
      write: vi.fn(() => { throw new Error('should not call keychain on win32'); }),
      remove: vi.fn(() => { throw new Error('should not call keychain on win32'); }),
    };
    writeCreds(base, { accessToken: 'w1', refreshToken: 'r1', expiresAt: 1000 });
    writeClaudeJson(base, { accountUuid: 'u-win', displayName: 'Win', emailAddress: 'w@x.test' });

    prepareSubagentSpace(DEFAULT_ID, null, { platform: 'win32', keychain: kc });
    syncSubagentToMain(DEFAULT_ID, null, { platform: 'win32', keychain: kc });
    removeSubagentSpace(DEFAULT_ID, { platform: 'win32', keychain: kc });

    expect(kc.read).not.toHaveBeenCalled();
    expect(kc.write).not.toHaveBeenCalled();
    expect(kc.remove).not.toHaveBeenCalled();
  });
});

describe('6. .claude.json 项目级 MCP 配置同步', () => {
  it('同步各项目的 MCP 字段（按原路径键），保留目标项目其他字段，不同步源非 MCP 字段', () => {
    const winSlash = 'F:/Cosyee';
    const winBackslash = 'C:\\Users\\Demo\\Proj';
    writeJson(path.join(base, '.claude.json'), {
      oauthAccount: { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' },
      mcpServers: { topSrv: { command: 'node', args: ['top.js'] } },
      projects: {
        [winSlash]: {
          mcpServers: { localSrv: { command: 'npx', args: ['local-mcp'] } },
          enabledMcpjsonServers: ['proj-a'],
          disabledMcpjsonServers: ['proj-b'],
          disabledMcpServers: ['blocked-srv'],
          enableAllProjectMcpServers: true,
          mcpContextUris: ['file:///spec.md'],
          hasTrustDialogAccepted: true,
          lastCost: 1.23,
        },
        [winBackslash]: {
          mcpServers: { winSrv: { command: 'python', args: ['s.py'] } },
        },
        '/no-mcp-proj': {
          lastCost: 9.9,
          hasTrustDialogAccepted: true,
          mcpServers: {},
          enabledMcpjsonServers: [],
        },
      },
    });

    const subDir = path.join(subRoot, 'proj-mcp-1');
    fs.mkdirSync(subDir, { recursive: true });
    // 目标项目里已有子代理自己的状态字段与旧的 MCP 配置
    writeJson(path.join(subDir, '.claude.json'), {
      numStartups: 7,
      projects: {
        [winSlash]: {
          hasTrustDialogAccepted: true,
          lastCost: 0.42,
          history: ['sub-turn-1'],
          mcpServers: { staleSrv: { command: 'old' } },
        },
        '/sub-only-proj': {
          hasTrustDialogAccepted: true,
          lastSessionId: 'sess-sub',
        },
      },
    });

    syncClaudeJsonToSubagent(null, subDir, false);
    const synced = readJson(path.join(subDir, '.claude.json'));

    expect(synced.numStartups).toBe(7);
    expect(synced.mcpServers).toEqual({ topSrv: { command: 'node', args: ['top.js'] } });
    expect(synced.projects[winSlash]).toEqual({
      hasTrustDialogAccepted: true,
      lastCost: 0.42,
      history: ['sub-turn-1'],
      mcpServers: { localSrv: { command: 'npx', args: ['local-mcp'] } },
      enabledMcpjsonServers: ['proj-a'],
      disabledMcpjsonServers: ['proj-b'],
      disabledMcpServers: ['blocked-srv'],
      enableAllProjectMcpServers: true,
      mcpContextUris: ['file:///spec.md'],
    });
    // Windows 反斜杠键原样保留
    expect(synced.projects[winBackslash]).toEqual({
      mcpServers: { winSrv: { command: 'python', args: ['s.py'] } },
    });
    // 只有非 MCP 字段或空 MCP 默认值的源项目不产生空壳条目
    expect(synced.projects['/no-mcp-proj']).toBeUndefined();
    // 子代理独有项目的运行态字段保留
    expect(synced.projects['/sub-only-proj']).toEqual({
      hasTrustDialogAccepted: true,
      lastSessionId: 'sess-sub',
    });
  });

  it('源删除项目级 MCP 字段或整个项目后，目标同步删除 MCP 字段并保留目标其他字段', () => {
    const projKeep = 'F:/KeepOthers';
    const projClean = 'F:/CleanAll';
    writeJson(path.join(base, '.claude.json'), {
      projects: {
        [projKeep]: {
          mcpServers: { s1: { command: 'node', args: ['1.js'] } },
          enabledMcpjsonServers: ['j1'],
          enableAllProjectMcpServers: true,
        },
        [projClean]: {
          mcpServers: { s2: { command: 'node', args: ['2.js'] } },
          disabledMcpServers: ['d1'],
        },
      },
    });

    const subDir = path.join(subRoot, 'proj-mcp-del');
    fs.mkdirSync(subDir, { recursive: true });
    writeJson(path.join(subDir, '.claude.json'), {
      projects: {
        [projKeep]: { hasTrustDialogAccepted: true, lastCost: 3.14 },
      },
    });

    syncClaudeJsonToSubagent(null, subDir, false);
    expect(readJson(path.join(subDir, '.claude.json')).projects[projKeep].mcpServers).toEqual({
      s1: { command: 'node', args: ['1.js'] },
    });
    expect(readJson(path.join(subDir, '.claude.json')).projects[projClean].mcpServers).toEqual({
      s2: { command: 'node', args: ['2.js'] },
    });

    // 源中：projKeep 删除 mcpServers 且 enableAllProjectMcpServers 改 false，projClean 整个项目被删除
    writeJson(path.join(base, '.claude.json'), {
      projects: {
        [projKeep]: {
          enabledMcpjsonServers: [],
          enableAllProjectMcpServers: false,
        },
      },
    });

    syncClaudeJsonToSubagent(null, subDir, false);
    const after = readJson(path.join(subDir, '.claude.json'));
    // projKeep 的 MCP 字段全部清除，但目标自有字段保留
    expect(after.projects[projKeep]).toEqual({ hasTrustDialogAccepted: true, lastCost: 3.14 });
    // projClean 目标无其他字段，条目被彻底清理
    expect(after.projects[projClean]).toBeUndefined();

    // 若把目标唯一剩余的非 MCP 字段也清空、且源已无任何 MCP，则顶层 projects 字段也被清理
    writeJson(path.join(subDir, '.claude.json'), {
      projects: { [projClean]: { mcpServers: { orphan: { command: 'x' } } } },
    });
    writeJson(path.join(base, '.claude.json'), {});
    syncClaudeJsonToSubagent(null, subDir, false);
    expect(readJson(path.join(subDir, '.claude.json')).projects).toBeUndefined();
  });

  it('非默认账号自身无 projects 时从基础目录兜底同步；自身有 projects 时以自身为准', () => {
    const mainDir = path.join(root, 'acc-extra');
    const subDir = path.join(subRoot, 'acc-extra');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(subDir, { recursive: true });

    writeJson(path.join(base, '.claude.json'), {
      projects: {
        'F:/Shared': { mcpServers: { baseSrv: { command: 'node', args: ['base.js'] } } },
      },
    });
    // 额外账号 .claude.json 尚未包含 projects（例如刚添加的 API 账号）
    writeJson(path.join(mainDir, '.claude.json'), {});

    syncClaudeJsonToSubagent(mainDir, subDir, true);
    expect(readJson(path.join(subDir, '.claude.json')).projects['F:/Shared']).toEqual({
      mcpServers: { baseSrv: { command: 'node', args: ['base.js'] } },
    });

    // 额外账号自身已有 projects（且删掉了 F:/Shared 的 MCP）时不再从基础目录复活
    writeJson(path.join(mainDir, '.claude.json'), { projects: {} });
    syncClaudeJsonToSubagent(mainDir, subDir, true);
    expect(readJson(path.join(subDir, '.claude.json')).projects).toBeUndefined();
  });

  it('源 .claude.json 缺失、JSON 损坏或 projects 结构异常时不抛错', () => {
    const subDir = path.join(subRoot, 'proj-mcp-corrupt');
    fs.mkdirSync(subDir, { recursive: true });

    // 1) 源文件缺失
    expect(() => syncClaudeJsonToSubagent(null, subDir, false)).not.toThrow();
    expect(readJson(path.join(subDir, '.claude.json')).hasCompletedOnboarding).toBe(true);

    // 2) 源文件 JSON 损坏
    fs.writeFileSync(path.join(base, '.claude.json'), '{"projects": {"F:/x": {bad json');
    expect(() => syncClaudeJsonToSubagent(null, subDir, false)).not.toThrow();

    // 3) projects 类型异常或单项为 null/原始值
    writeJson(path.join(base, '.claude.json'), {
      projects: {
        'F:/null-entry': null,
        'F:/str-entry': 'invalid',
        'F:/valid': { mcpServers: { ok: { command: 'echo' } } },
      },
    });
    expect(() => syncClaudeJsonToSubagent(null, subDir, false)).not.toThrow();
    expect(readJson(path.join(subDir, '.claude.json')).projects).toEqual({
      'F:/valid': { mcpServers: { ok: { command: 'echo' } } },
    });
  });

  it('源或兜底的基础目录 .claude.json 瞬时损坏时保留目标顶层与项目级 MCP 旧值，恢复后正常同步，源文件明确缺失时才删除', () => {
    const subDir = path.join(subRoot, 'proj-mcp-preserve');
    fs.mkdirSync(subDir, { recursive: true });

    // 先做一次正常同步，让目标拥有顶层与项目级 MCP
    writeJson(path.join(base, '.claude.json'), {
      oauthAccount: { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' },
      mcpServers: { top1: { command: 'node', args: ['top1.js'] } },
      projects: {
        'F:/App': {
          mcpServers: { p1: { command: 'node', args: ['p1.js'] } },
          enabledMcpjsonServers: ['j1'],
        },
      },
    });
    syncClaudeJsonToSubagent(null, subDir, false);

    // 1) 源 .claude.json 被半写入损坏：目标顶层 mcpServers 与项目级 MCP 必须原样保留
    fs.writeFileSync(path.join(base, '.claude.json'), '{"mcpServers": {"top1": ');
    expect(() => syncClaudeJsonToSubagent(null, subDir, false)).not.toThrow();
    const afterCorrupt = readJson(path.join(subDir, '.claude.json'));
    expect(afterCorrupt.mcpServers).toEqual({ top1: { command: 'node', args: ['top1.js'] } });
    expect(afterCorrupt.projects['F:/App']).toEqual({
      mcpServers: { p1: { command: 'node', args: ['p1.js'] } },
      enabledMcpjsonServers: ['j1'],
    });
    expect(afterCorrupt.oauthAccount).toEqual({ accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' });

    // 2) 源恢复为有效 JSON（更新顶层与项目 MCP）：正常同步新值
    writeJson(path.join(base, '.claude.json'), {
      oauthAccount: { accountUuid: 'u-1', displayName: 'One', emailAddress: 'one@x.test' },
      mcpServers: { top2: { command: 'node', args: ['top2.js'] } },
      projects: {
        'F:/App': {
          mcpServers: { p2: { command: 'node', args: ['p2.js'] } },
        },
      },
    });
    syncClaudeJsonToSubagent(null, subDir, false);
    const afterRecover = readJson(path.join(subDir, '.claude.json'));
    expect(afterRecover.mcpServers).toEqual({ top2: { command: 'node', args: ['top2.js'] } });
    expect(afterRecover.projects['F:/App']).toEqual({
      mcpServers: { p2: { command: 'node', args: ['p2.js'] } },
    });

    // 3) 非默认账号走基础目录兜底：基础目录损坏时同样保留目标 MCP 旧值，恢复后正常同步，基础目录文件明确删除时才清空
    const mainDir = path.join(root, 'acc-fallback-corrupt');
    const subExtra = path.join(subRoot, 'acc-fallback-corrupt');
    fs.mkdirSync(mainDir, { recursive: true });
    fs.mkdirSync(subExtra, { recursive: true });
    writeJson(path.join(mainDir, '.claude.json'), {});
    syncClaudeJsonToSubagent(mainDir, subExtra, true);
    expect(readJson(path.join(subExtra, '.claude.json')).mcpServers).toEqual({ top2: { command: 'node', args: ['top2.js'] } });
    expect(readJson(path.join(subExtra, '.claude.json')).projects['F:/App']).toEqual({
      mcpServers: { p2: { command: 'node', args: ['p2.js'] } },
    });

    // 基础目录 .claude.json 瞬时损坏 → 保留目标旧值
    fs.writeFileSync(path.join(base, '.claude.json'), '{bad json');
    expect(() => syncClaudeJsonToSubagent(mainDir, subExtra, true)).not.toThrow();
    expect(readJson(path.join(subExtra, '.claude.json')).mcpServers).toEqual({ top2: { command: 'node', args: ['top2.js'] } });
    expect(readJson(path.join(subExtra, '.claude.json')).projects['F:/App']).toEqual({
      mcpServers: { p2: { command: 'node', args: ['p2.js'] } },
    });

    // 基础目录 .claude.json 明确删除（ENOENT）→ 正常清空目标 MCP
    fs.rmSync(path.join(base, '.claude.json'), { force: true });
    syncClaudeJsonToSubagent(mainDir, subExtra, true);
    expect(readJson(path.join(subExtra, '.claude.json')).mcpServers).toBeUndefined();
    expect(readJson(path.join(subExtra, '.claude.json')).projects).toBeUndefined();
  });
});
