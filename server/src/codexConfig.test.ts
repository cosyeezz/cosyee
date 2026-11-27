// codexAccounts 持久化 sanitize，以及 paths 辅助函数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseCodexHome, codexAccountsRoot } from './paths.js';
import { StateStore, parseSubagents, sanitizeRoute } from './workspaces.js';

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('codexAccounts 持久化', () => {
  it('旧 state.json 无 codexAccounts 正常加载；过滤非法项，只存白名单字段', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-codex-state-'));
    temps.push(tmp);
    const file = path.join(tmp, 'state.json');
    fs.writeFileSync(file, JSON.stringify({ workspaces: [], current: null }));
    expect(new StateStore(file).state.codexAccounts).toEqual({ list: [], active: null });

    const root = path.join(tmp, 'codex-accounts');
    const dir1 = path.join(root, 'aaaa1111');
    const dir2 = path.join(root, 'bbbb2222');
    fs.writeFileSync(
      file,
      JSON.stringify({
        codexAccounts: {
          active: 'bbbb2222',
          list: [
            { id: 'bad/id', label: 'x', dir: dir1, createdAt: 1 },
            { id: 'aaaa1111', label: 'A', dir: 'relative', createdAt: 1 },
            { id: 'aaaa1111', label: 'A', dir: dir1, createdAt: 10, identityHash: 'a'.repeat(64), token: 'secret' },
            { id: 'cccc3333', label: 'dup', dir: dir1, createdAt: 20 },
            { id: 'bbbb2222', label: 'B', dir: dir2, createdAt: 30, identityHash: 'nope' },
          ],
        },
      }),
    );
    const s = new StateStore(file).state.codexAccounts;
    expect(s.active).toBe('bbbb2222');
    expect(s.list).toEqual([
      { id: 'aaaa1111', label: 'A', dir: dir1, createdAt: 10, identityHash: 'a'.repeat(64) },
      { id: 'bbbb2222', label: 'B', dir: dir2, createdAt: 30 },
    ]);
    const bad = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, JSON.stringify({ codexAccounts: { active: 'zzzz', list: JSON.parse(bad).codexAccounts.list } }));
    expect(new StateStore(file).state.codexAccounts.active).toBeNull();
  });
});

describe('codex paths', () => {
  it('codexAccountsRoot / baseCodexHome 支持环境变量覆盖', () => {
    const keep = { a: process.env.COSYEE_CODEX_ACCOUNTS_DIR, h: process.env.CODEX_HOME, c: process.env.COSYEE_HOME };
    try {
      process.env.COSYEE_CODEX_ACCOUNTS_DIR = path.join(os.tmpdir(), 'x-codex-acc');
      process.env.CODEX_HOME = path.join(os.tmpdir(), 'x-codex-home');
      expect(codexAccountsRoot()).toBe(process.env.COSYEE_CODEX_ACCOUNTS_DIR);
      expect(baseCodexHome()).toBe(process.env.CODEX_HOME);
      delete process.env.COSYEE_CODEX_ACCOUNTS_DIR;
      delete process.env.CODEX_HOME;
      process.env.COSYEE_HOME = path.join(os.tmpdir(), 'x-cosyee');
      expect(codexAccountsRoot()).toBe(path.join(process.env.COSYEE_HOME, 'codex-accounts'));
      expect(baseCodexHome()).toBe(path.join(os.homedir(), '.codex'));
    } finally {
      for (const [k, v] of [['COSYEE_CODEX_ACCOUNTS_DIR', keep.a], ['CODEX_HOME', keep.h], ['COSYEE_HOME', keep.c]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('DelegateEffort 校验', () => {
  it('codex/agy 路线接受 none/minimal/ultra，claude 路线拒绝并落回 null，native 拒绝 ultra', () => {
    expect(sanitizeRoute({ backend: 'codex', accountId: 'default', model: 'gpt-5', effort: 'ultra' })).toEqual({
      backend: 'codex',
      accountId: 'default',
      model: 'gpt-5',
      effort: 'ultra',
    });
    expect(sanitizeRoute({ backend: 'codex', accountId: 'default', model: null, effort: 'none' })?.effort).toBe('none');
    expect(sanitizeRoute({ backend: 'codex', accountId: 'default', model: null, effort: 'minimal' })?.effort).toBe('minimal');
    expect(sanitizeRoute({ backend: 'agy', accountId: 'acc1', model: null, effort: 'ultra' })?.effort).toBe('ultra');
    expect(sanitizeRoute({ backend: 'claude', accountId: 'default', model: 'sonnet', effort: 'ultra' })).toEqual({
      backend: 'claude',
      accountId: 'default',
      model: 'sonnet',
      effort: null,
    });
    expect(sanitizeRoute({ backend: 'claude', accountId: 'default', model: 'sonnet', effort: 'none' })?.effort).toBeNull();
    expect(sanitizeRoute({ backend: 'claude', accountId: 'default', model: 'sonnet', effort: 'high' })?.effort).toBe('high');
    // native 拒绝 ultra
    expect(parseSubagents({ mode: 'native', native: { model: 'sonnet', effort: 'ultra' }, delegate: { default: null } })).toBeNull();
    // delegate 默认路线支持 codex + ultra
    const parsed = parseSubagents({
      mode: 'delegate',
      native: { model: 'sonnet', effort: 'medium' },
      delegate: { default: { backend: 'codex', accountId: 'default', model: 'gpt-5', effort: 'ultra' } },
    });
    expect(parsed?.delegate.default?.effort).toBe('ultra');
  });
});
