// 2FA 服务端测试：合并逻辑、SQLite 事务与乐观锁、分组/标签级联、导入解析、AES-256-GCM 加解密、GitHub 同步与冲突重试、密钥自动恢复、Agent 鉴权与取码、独立解密脚本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type RunningServer, startServer } from './server.js';
import {
  decryptSnapshot,
  encodeKey,
  encryptSnapshot,
  generateKey,
  generateTotp,
  mergeSnapshots,
  parseImportText,
  TwoFaDb,
  type TwoFaEntry,
  type TwoFaGroup,
  type TwoFaSnapshot,
  type TwoFaTag,
  type VaultEnvelopeV2,
} from './twofa/index.js';
import { ensureTwoFaPlugin } from './twofa/skill.js';

// Vitest 2 不识别 node:sqlite，用 createRequire 加载（同 twofa/db.ts）
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
// @ts-expect-error 纯 JS 独立脚本，无 .d.ts
import { decryptVault, formatOtpAuthUri, generateTotp as decryptGenerateTotp, resolveGroupPath } from '../../scripts/cosyee-2fa-decrypt.mjs';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 模拟一个内存 GitHub 仓库文件系统，供同步与 setup 测试使用 */
class FakeGitHub {
  login = 'alice';
  repos = new Map<string, { private: boolean; files: Map<string, { sha: string; content: Buffer }> }>();
  private shaSeq = 0;
  /** 下一次对指定 path 的 PUT 返回一次 409 SHA 冲突（模拟并发写入） */
  failNextPutWithConflict: { repo: string; path: string; injectRemote?: Buffer } | null = null;
  putCount = 0;

  nextSha(): string {
    return `sha-${++this.shaSeq}`;
  }

  addRepo(fullName: string, isPrivate = true): void {
    this.repos.set(fullName, { private: isPrivate, files: new Map() });
  }

  setFile(fullName: string, filePath: string, content: Buffer | string): string {
    const repo = this.repos.get(fullName);
    if (!repo) throw new Error(`repo not found: ${fullName}`);
    const sha = this.nextSha();
    repo.files.set(filePath, { sha, content: Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8') });
    return sha;
  }

  getFile(fullName: string, filePath: string): { sha: string; content: Buffer } | undefined {
    return this.repos.get(fullName)?.files.get(filePath);
  }

  fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET' && url.pathname === '/user') {
      return jsonResponse({ login: this.login });
    }

    if (method === 'POST' && url.pathname === '/user/repos') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { name: string; private?: boolean; auto_init?: boolean };
      const fullName = `${this.login}/${body.name}`;
      this.addRepo(fullName, body.private === true);
      // 模拟 GitHub auto_init: true 自动创建默认 README.md
      if (body.auto_init) {
        this.setFile(fullName, 'README.md', `# ${body.name}\n`);
      }
      return jsonResponse({ full_name: fullName, private: body.private === true, default_branch: 'main' }, 201);
    }

    const repoMatch = /^\/repos\/([^/]+\/[^/]+)$/.exec(url.pathname);
    if (method === 'GET' && repoMatch) {
      const fullName = repoMatch[1]!;
      const repo = this.repos.get(fullName);
      if (!repo) return jsonResponse({ message: 'Not Found' }, 404);
      return jsonResponse({ full_name: fullName, private: repo.private, default_branch: 'main' });
    }

    const contentMatch = /^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/.exec(url.pathname);
    if (contentMatch) {
      const fullName = contentMatch[1]!;
      const filePath = contentMatch[2]!.split('/').map(decodeURIComponent).join('/');
      const repo = this.repos.get(fullName);
      if (!repo) return jsonResponse({ message: 'Not Found' }, 404);

      if (method === 'GET') {
        const f = repo.files.get(filePath);
        if (!f) return jsonResponse({ message: 'Not Found' }, 404);
        return jsonResponse({
          type: 'file',
          sha: f.sha,
          encoding: 'base64',
          content: f.content.toString('base64'),
        });
      }

      if (method === 'PUT') {
        this.putCount++;
        const body = JSON.parse(String(init?.body ?? '{}')) as { content: string; sha?: string };
        if (this.failNextPutWithConflict && this.failNextPutWithConflict.repo === fullName && this.failNextPutWithConflict.path === filePath) {
          const inject = this.failNextPutWithConflict.injectRemote;
          this.failNextPutWithConflict = null;
          if (inject) this.setFile(fullName, filePath, inject);
          return jsonResponse({ message: 'sha does not match' }, 409);
        }
        const cur = repo.files.get(filePath);
        if (cur && body.sha !== cur.sha) {
          return jsonResponse({ message: 'sha does not match' }, 409);
        }
        const newSha = this.setFile(fullName, filePath, Buffer.from(body.content, 'base64'));
        return jsonResponse({ content: { sha: newSha } }, cur ? 200 : 201);
      }
    }

    return jsonResponse({ message: `Unexpected ${method} ${url.pathname}` }, 404);
  };
}

// ───────────── 1. 纯函数合并 ─────────────

describe('mergeSnapshots', () => {
  const baseEntry = (overrides: Partial<TwoFaSnapshot['entries'][number]> = {}) => ({
    id: 'e1',
    issuer: 'GitHub',
    account: 'alice',
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1' as const,
    digits: 6 as const,
    period: 30,
    groupId: null,
    pinned: false,
    tags: [],
    sort: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  });

  it('merges local add, remote add, both edited, tombstones both ways, and tie-breakers', () => {
    const local: TwoFaSnapshot = {
      schema: 2,
      entries: [
        baseEntry({ id: 'local-only', issuer: 'LocalOnly' }),
        baseEntry({ id: 'both-local-newer', issuer: 'LocalWins', updatedAt: '2026-02-02T00:00:00.000Z', version: 2 }),
        baseEntry({ id: 'both-remote-newer', issuer: 'OldLocal', updatedAt: '2026-02-01T00:00:00.000Z', version: 2 }),
        baseEntry({ id: 'local-deleted', updatedAt: '2026-03-01T00:00:00.000Z', deletedAt: '2026-03-01T00:00:00.000Z', version: 3 }),
        baseEntry({ id: 'remote-deleted', updatedAt: '2026-02-01T00:00:00.000Z', deletedAt: null, version: 2 }),
        baseEntry({ id: 'tie-ver', issuer: 'HigherVerLocal', updatedAt: '2026-04-01T00:00:00.000Z', version: 5 }),
        baseEntry({ id: 'tie-all', issuer: 'LocalTie', updatedAt: '2026-04-01T00:00:00.000Z', version: 2 }),
      ],
      groups: [],
      tags: [],
    };
    const remote: TwoFaSnapshot = {
      schema: 2,
      entries: [
        baseEntry({ id: 'remote-only', issuer: 'RemoteOnly' }),
        baseEntry({ id: 'both-local-newer', issuer: 'OldRemote', updatedAt: '2026-02-01T00:00:00.000Z', version: 2 }),
        baseEntry({ id: 'both-remote-newer', issuer: 'RemoteWins', updatedAt: '2026-02-03T00:00:00.000Z', version: 2 }),
        baseEntry({ id: 'local-deleted', updatedAt: '2026-02-01T00:00:00.000Z', deletedAt: null, version: 2 }),
        baseEntry({ id: 'remote-deleted', updatedAt: '2026-03-01T00:00:00.000Z', deletedAt: '2026-03-01T00:00:00.000Z', version: 3 }),
        baseEntry({ id: 'tie-ver', issuer: 'LowerVerRemote', updatedAt: '2026-04-01T00:00:00.000Z', version: 4 }),
        baseEntry({ id: 'tie-all', issuer: 'RemoteTieWins', updatedAt: '2026-04-01T00:00:00.000Z', version: 2 }),
      ],
      groups: [],
      tags: [],
    };

    const { merged, changedLocal, differsFromRemote } = mergeSnapshots(local, remote);
    expect(changedLocal).toBe(true);
    expect(differsFromRemote).toBe(true);

    const byId = new Map(merged.entries.map((e) => [e.id, e]));
    expect(byId.get('local-only')?.issuer).toBe('LocalOnly');
    expect(byId.get('remote-only')?.issuer).toBe('RemoteOnly');
    expect(byId.get('both-local-newer')?.issuer).toBe('LocalWins');
    expect(byId.get('both-remote-newer')?.issuer).toBe('RemoteWins');
    expect(byId.get('local-deleted')?.deletedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(byId.get('remote-deleted')?.deletedAt).toBe('2026-03-01T00:00:00.000Z');
    expect(byId.get('tie-ver')?.issuer).toBe('HigherVerLocal');
    expect(byId.get('tie-all')?.issuer).toBe('RemoteTieWins');
  });
});

// ───────────── 2. RFC 6238 TOTP & 导入解析 & 加解密 ─────────────

describe('TOTP, import parser, and AES-256-GCM crypto', () => {
  it('matches RFC 6238 Appendix B test vectors (SHA1, SHA256, SHA512, 8 digits)', () => {
    // SHA1 secret = "12345678901234567890" (20 bytes)
    const sha1Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(generateTotp({ secret: sha1Secret, algorithm: 'SHA1', digits: 8, period: 30 }, 59 * 1000).code).toBe('94287082');
    expect(generateTotp({ secret: sha1Secret, algorithm: 'SHA1', digits: 8, period: 30 }, 1111111109 * 1000).code).toBe('07081804');

    // SHA256 secret = "12345678901234567890123456789012" (32 bytes)
    const sha256Secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
    expect(generateTotp({ secret: sha256Secret, algorithm: 'SHA256', digits: 8, period: 30 }, 59 * 1000).code).toBe('46119246');

    // SHA512 secret = 64 bytes of repeating "1234567890"
    const sha512Secret =
      'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA';
    expect(generateTotp({ secret: sha512Secret, algorithm: 'SHA512', digits: 8, period: 30 }, 59 * 1000).code).toBe('90693936');
  });

  it('parses otpauth URIs and authenticator.cc JSON (including encrypted & unsupported)', () => {
    const uriText = [
      'otpauth://totp/GitHub:alice@example.com?secret=jbsw%20y3dp%20ehpk3pxp&issuer=GitHub&digits=6&period=30',
      'otpauth://hotp/Legacy:bob?secret=JBSWY3DPEHPK3PXP&counter=1',
      'not-a-valid-line',
    ].join('\n');
    const r1 = parseImportText(uriText);
    expect(r1.entries).toHaveLength(1);
    expect(r1.entries[0]).toMatchObject({ issuer: 'GitHub', account: 'alice@example.com', secret: 'JBSWY3DPEHPK3PXP' });
    expect(r1.unsupported).toBe(1);
    expect(r1.errors).toHaveLength(1);

    const authJson = JSON.stringify({
      hash1: { issuer: 'Cloudflare', account: 'ops@co.io', secret: 'JBSWY3DPEHPK3PXP', type: 'totp', digits: 6, period: 30 },
      hash2: { issuer: 'Steam', account: 'gamer', secret: 'JBSWY3DPEHPK3PXP', type: 'steam' },
    });
    const r2 = parseImportText(authJson);
    expect(r2.entries).toHaveLength(1);
    expect(r2.entries[0]?.issuer).toBe('Cloudflare');
    expect(r2.unsupported).toBe(1);
    expect(r2.errors).toHaveLength(0);

    const encJson = JSON.stringify({ hash1: { encrypted: true, hash: 'abc' } });
    const r3 = parseImportText(encJson);
    expect(r3.entries).toHaveLength(0);
    expect(r3.errors[0]).toMatch(/已加密/);
  });

  it('encrypts and decrypts snapshots with AES-256-GCM and rejects wrong key', () => {
    const key = generateKey();
    const otherKey = generateKey();
    const snap: TwoFaSnapshot = { schema: 2, entries: [], groups: [], tags: [] };
    const env = encryptSnapshot(snap, key);
    expect(env.format).toBe('cosyee-2fa-vault');
    expect(env.v).toBe(2);
    expect(decryptSnapshot(env, key)).toEqual(snap);
    expect(() => decryptSnapshot(env, otherKey)).toThrow(/解密失败/);
  });
});

// ───────────── 3. HTTP REST、乐观锁、分组/标签级联、同步引擎、Agent 路由与鉴权 ─────────────

describe('TwoFa HTTP routes, SQLite CRUD, sync engine, and agent auth', () => {
  let tmp: string;
  let prevHome: string | undefined;
  let prevHost: string | undefined;
  let srv: RunningServer;
  let base: string;
  let gh: FakeGitHub;
  const SECRET_GH_TOKEN = 'gho_MockTokenShouldNeverLeak987654321';

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-2fa-v2-'));
    prevHome = process.env.COSYEE_HOME;
    prevHost = process.env.COSYEE_HOST;
    process.env.COSYEE_HOME = path.join(tmp, 'home');
    delete process.env.COSYEE_HOST;
    gh = new FakeGitHub();
    srv = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(tmp, 'state.json'),
      twoFaFetch: gh.fetch,
      twoFaGetToken: async () => SECRET_GH_TOKEN,
    });
    base = `http://127.0.0.1:${srv.port}`;
  });

  afterEach(async () => {
    await srv.stop();
    if (prevHome === undefined) delete process.env.COSYEE_HOME;
    else process.env.COSYEE_HOME = prevHome;
    if (prevHost === undefined) delete process.env.COSYEE_HOST;
    else process.env.COSYEE_HOST = prevHost;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('supports entry/group/tag CRUD, optimistic locking 409, group cycle prevention, group delete all/lift, tag delete cascade, and import dedupe', async () => {
    // 1. 创建分组树：rootG -> childG -> grandG
    const rootG = ((await (await fetch(`${base}/api/2fa/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '工作' }),
    })).json()) as { group: TwoFaGroup }).group;

    const childG = ((await (await fetch(`${base}/api/2fa/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '云服务', parentId: rootG.id }),
    })).json()) as { group: TwoFaGroup }).group;

    const grandG = ((await (await fetch(`${base}/api/2fa/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'AWS', parentId: childG.id }),
    })).json()) as { group: TwoFaGroup }).group;

    // 防止循环移动：把 rootG 移到 grandG 下面 -> 400
    const cycleRes = await fetch(`${base}/api/2fa/groups/${rootG.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: rootG.version, parentId: grandG.id }),
    });
    expect(cycleRes.status).toBe(400);

    // 2. 创建标签 + 大小写不敏感重名校验 -> 409
    const tag1 = ((await (await fetch(`${base}/api/2fa/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Prod', color: 'red' }),
    })).json()) as { tag: TwoFaTag }).tag;

    const dupTag = await fetch(`${base}/api/2fa/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'prod', color: 'blue' }),
    });
    expect(dupTag.status).toBe(409);

    // 3. 创建条目并测试乐观锁 409
    const e1 = ((await (await fetch(`${base}/api/2fa/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        issuer: 'AWS Console',
        account: 'root@corp.io',
        secret: 'jbsw y3dp ehpk 3pxp===',
        groupId: childG.id,
        tags: [tag1.id],
      }),
    })).json()) as { entry: TwoFaEntry }).entry;
    expect(e1.secret).toBe('JBSWY3DPEHPK3PXP');
    expect(e1.version).toBe(1);

    // 正常更新 -> version = 2
    const e1v2 = ((await (await fetch(`${base}/api/2fa/entries/${e1.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, pinned: true }),
    })).json()) as { entry: TwoFaEntry }).entry;
    expect(e1v2.version).toBe(2);
    expect(e1v2.pinned).toBe(true);

    // 过期版本更新 -> 409 { error: 'conflict', current }
    const stalePatch = await fetch(`${base}/api/2fa/entries/${e1.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, issuer: 'Stale' }),
    });
    expect(stalePatch.status).toBe(409);
    expect(await stalePatch.json()).toEqual({ error: 'conflict', current: e1v2 });

    // 4. 删除标签级联清理条目中的 tag id 并递增条目 version
    const delTagRes = await fetch(`${base}/api/2fa/tags/${tag1.id}?version=${tag1.version}`, { method: 'DELETE' });
    expect(delTagRes.status).toBe(200);
    const dataAfterTagDel = (await (await fetch(`${base}/api/2fa/data`)).json()) as {
      entries: TwoFaEntry[];
      tags: TwoFaTag[];
    };
    expect(dataAfterTagDel.tags).toHaveLength(0);
    const updatedE1 = dataAfterTagDel.entries.find((e) => e.id === e1.id)!;
    expect(updatedE1.tags).toEqual([]);
    expect(updatedE1.version).toBe(3);

    // 5. 分组删除 mode=lift：删 childG，则 grandG 和 e1 都提升到 rootG 下
    const liftRes = await fetch(`${base}/api/2fa/groups/${childG.id}?mode=lift&version=${childG.version}`, { method: 'DELETE' });
    expect(liftRes.status).toBe(200);
    const afterLift = (await (await fetch(`${base}/api/2fa/data`)).json()) as {
      entries: TwoFaEntry[];
      groups: TwoFaGroup[];
    };
    expect(afterLift.groups.find((g) => g.id === childG.id)).toBeUndefined();
    expect(afterLift.groups.find((g) => g.id === grandG.id)?.parentId).toBe(rootG.id);
    expect(afterLift.entries.find((e) => e.id === e1.id)?.groupId).toBe(rootG.id);

    // 6. 分组删除 mode=all：删 rootG，则 rootG、grandG 与 e1 全部软删除
    const allRes = await fetch(`${base}/api/2fa/groups/${rootG.id}?mode=all&version=${rootG.version}`, { method: 'DELETE' });
    expect(allRes.status).toBe(200);
    const afterAll = (await (await fetch(`${base}/api/2fa/data`)).json()) as {
      entries: TwoFaEntry[];
      groups: TwoFaGroup[];
    };
    expect(afterAll.groups).toHaveLength(0);
    expect(afterAll.entries).toHaveLength(0);

    // 7. 批量导入去重
    const importText = [
      'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
      'otpauth://totp/GitHub:alice?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
      'otpauth://totp/GitLab:alice?secret=GEZDGNBVGY3TQOJQ&issuer=GitLab',
    ].join('\n');
    const imp1 = await (await fetch(`${base}/api/2fa/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: importText }),
    })).json();
    expect(imp1).toEqual({ added: 2, skipped: 1, unsupported: 0, errors: [] });

    // 再次导入相同内容 -> 全部跳过
    const imp2 = await (await fetch(`${base}/api/2fa/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: importText }),
    })).json();
    expect(imp2).toEqual({ added: 0, skipped: 3, unsupported: 0, errors: [] });
  });

  it('agent/setup creates private repos, uploads key/README/decrypt.mjs, handles SHA conflict retry and auto key recovery', async () => {
    // 先创建一条本地记录
    await fetch(`${base}/api/2fa/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer: 'GitHub', account: 'alice', secret: 'JBSWY3DPEHPK3PXP' }),
    });

    // 1. 首次 setup
    const setupRes = await fetch(`${base}/api/2fa/agent/setup`, {
      method: 'POST',
      headers: { 'x-cosyee-agent-token': srv.agentToken },
    });
    expect(setupRes.status).toBe(200);
    const setupText = await setupRes.text();
    expect(setupText).not.toContain(SECRET_GH_TOKEN);
    const setupBody = JSON.parse(setupText) as {
      created: { vault: boolean; key: boolean };
      sync: { configured: boolean; repo: string; keyRepo: string; ghLogin: string; lastSyncAt?: string };
      steps: string[];
    };
    expect(setupBody.created).toEqual({ vault: true, key: true });
    expect(setupBody.sync).toMatchObject({
      configured: true,
      repo: 'alice/cosyee-2fa-vault',
      keyRepo: 'alice/cosyee-2fa-key',
      ghLogin: 'alice',
    });
    expect(gh.getFile('alice/cosyee-2fa-key', 'key.txt')).toBeTruthy();
    const readmeText = gh.getFile('alice/cosyee-2fa-vault', 'README.md')?.content.toString('utf8') ?? '';
    // auto_init 生成的默认 README 应被我们的中文说明覆盖，且包含安全提示
    expect(readmeText).toContain('# Cosyee 2FA Vault');
    expect(readmeText).toContain('必须始终保持私有');
    expect(readmeText).toContain('恢复码');
    const decryptText = gh.getFile('alice/cosyee-2fa-vault', 'decrypt.mjs')?.content.toString('utf8') ?? '';
    expect(decryptText).toContain('export function decryptVault');
    const vaultFile = gh.getFile('alice/cosyee-2fa-vault', 'vault.json')!;
    expect(vaultFile).toBeTruthy();
    // 保管库仓库里只有密文，不含明文 secret
    expect(vaultFile.content.toString('utf8')).not.toContain('JBSWY3DPEHPK3PXP');

    // 1b. 若远端 decrypt.mjs 为旧版/占位内容，再次 setup 应带 sha 更新为最新完整脚本
    gh.setFile('alice/cosyee-2fa-vault', 'decrypt.mjs', '// old stub\n');
    const rerunSetup = await fetch(`${base}/api/2fa/agent/setup`, {
      method: 'POST',
      headers: { 'x-cosyee-agent-token': srv.agentToken },
    });
    expect(rerunSetup.status).toBe(200);
    const rerunBody = (await rerunSetup.json()) as { steps: string[] };
    expect(rerunBody.steps.some((s) => s.includes('已更新应急解密脚本'))).toBe(true);
    expect(gh.getFile('alice/cosyee-2fa-vault', 'decrypt.mjs')?.content.toString('utf8')).toContain('export function decryptVault');

    // 2. SHA 冲突重试：模拟另一台设备在 PUT 时抢先写入了一条远端记录
    const keyBuf = Buffer.from(gh.getFile('alice/cosyee-2fa-key', 'key.txt')!.content.toString('utf8').trim(), 'base64');
    const remoteSnap: TwoFaSnapshot = {
      schema: 2,
      entries: [
        {
          id: 'remote-e2',
          issuer: 'Cloudflare',
          account: 'bob',
          secret: 'GEZDGNBVGY3TQOJQ',
          algorithm: 'SHA1',
          digits: 6,
          period: 30,
          groupId: null,
          pinned: false,
          tags: [],
          sort: 0,
          createdAt: '2026-11-27T01:00:00.000Z',
          updatedAt: '2026-11-27T01:00:00.000Z',
          deletedAt: null,
          version: 1,
        },
      ],
      groups: [],
      tags: [],
    };
    const injectedVault = Buffer.from(JSON.stringify(encryptSnapshot(remoteSnap, keyBuf)), 'utf8');

    // 本地再加一条，触发需要推送，并让第一次 PUT 返回 409 同时注入远端新内容
    await fetch(`${base}/api/2fa/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ issuer: 'Linear', account: 'alice', secret: 'MFRGGZDFMZTWQ2LK' }),
    });
    gh.failNextPutWithConflict = { repo: 'alice/cosyee-2fa-vault', path: 'vault.json', injectRemote: injectedVault };

    const syncRes = await fetch(`${base}/api/2fa/sync`, { method: 'POST' });
    expect(syncRes.status).toBe(200);

    // 重试合并后，本地应该同时有 GitHub、Linear 和远端抢先写入的 Cloudflare
    const mergedData = (await (await fetch(`${base}/api/2fa/data`)).json()) as { entries: TwoFaEntry[] };
    const issuers = mergedData.entries.map((e) => e.issuer).sort();
    expect(issuers).toEqual(['Cloudflare', 'GitHub', 'Linear']);

    // 3. 本地密钥缺失时自动从 cosyee-2fa-key 恢复
    const localKeyFile = path.join(tmp, '2fa', 'key');
    expect(fs.existsSync(localKeyFile)).toBe(true);
    fs.rmSync(localKeyFile);
    expect(fs.existsSync(localKeyFile)).toBe(false);

    const recoverSync = await fetch(`${base}/api/2fa/sync`, { method: 'POST' });
    expect(recoverSync.status).toBe(200);
    expect(fs.existsSync(localKeyFile)).toBe(true);
  });

  it('rejects public repos during agent/setup', async () => {
    gh.addRepo('alice/cosyee-2fa-vault', false); // 公开仓库
    const res = await fetch(`${base}/api/2fa/agent/setup`, {
      method: 'POST',
      headers: { 'x-cosyee-agent-token': srv.agentToken },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/公开仓库/);
  });

  it('scopes agent token strictly to /api/2fa/agent/* and supports agent/code single, multiple, none & agent/list without secrets', async () => {
    const authSrv = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(tmp, 'state-auth.json'),
      authToken: 'desktop-main-token',
      twoFaFetch: gh.fetch,
      twoFaGetToken: async () => SECRET_GH_TOKEN,
    });
    try {
      const authBase = `http://127.0.0.1:${authSrv.port}`;
      const mainH = { 'x-cosyee-token': 'desktop-main-token', 'content-type': 'application/json' };
      const agentH = { 'x-cosyee-agent-token': authSrv.agentToken };

      // agent token 不能访问普通接口
      expect((await fetch(`${authBase}/api/2fa/data`, { headers: agentH })).status).toBe(403);
      expect((await fetch(`${authBase}/api/workspaces`, { headers: agentH })).status).toBe(403);
      // 错误的 agent token 不能访问 agent 接口
      expect((await fetch(`${authBase}/api/2fa/agent/list`, { headers: { 'x-cosyee-agent-token': 'wrong' } })).status).toBe(403);
      // 无令牌不能访问 agent 接口
      expect((await fetch(`${authBase}/api/2fa/agent/list`)).status).toBe(403);
      // 正确 agent token 与普通 authToken 均可访问 agent 接口
      expect((await fetch(`${authBase}/api/2fa/agent/list`, { headers: agentH })).status).toBe(200);
      expect((await fetch(`${authBase}/api/2fa/agent/list`, { headers: mainH })).status).toBe(200);

      // 插入 2 条 GitHub 记录与 1 条 Cloudflare 记录
      const g = ((await (await fetch(`${authBase}/api/2fa/groups`, {
        method: 'POST',
        headers: mainH,
        body: JSON.stringify({ name: '研发' }),
      })).json()) as { group: TwoFaGroup }).group;

      const e1 = ((await (await fetch(`${authBase}/api/2fa/entries`, {
        method: 'POST',
        headers: mainH,
        body: JSON.stringify({ issuer: 'GitHub', account: 'work@co.io', secret: 'JBSWY3DPEHPK3PXP', groupId: g.id }),
      })).json()) as { entry: TwoFaEntry }).entry;

      await fetch(`${authBase}/api/2fa/entries`, {
        method: 'POST',
        headers: mainH,
        body: JSON.stringify({ issuer: 'GitHub', account: 'personal@me.io', secret: 'GEZDGNBVGY3TQOJQ' }),
      });

      await fetch(`${authBase}/api/2fa/entries`, {
        method: 'POST',
        headers: mainH,
        body: JSON.stringify({ issuer: 'Cloudflare', account: 'admin', secret: 'MFRGGZDFMZTWQ2LK' }),
      });

      // agent/list 不含任何 secret
      const listRes = await fetch(`${authBase}/api/2fa/agent/list`, { headers: agentH });
      const listText = await listRes.text();
      expect(listText).not.toContain('JBSWY3DPEHPK3PXP');
      expect(listText).not.toContain('GEZDGNBVGY3TQOJQ');
      expect(JSON.parse(listText).entries).toHaveLength(3);

      // 多条匹配 -> 返回 matches，不含 code
      const multiRes = await fetch(`${authBase}/api/2fa/agent/code?q=github`, { headers: agentH });
      expect(multiRes.status).toBe(200);
      const multiBody = (await multiRes.json()) as { matches?: Array<{ id: string }>; code?: string };
      expect(multiBody.matches).toHaveLength(2);
      expect(multiBody.code).toBeUndefined();

      // 单条匹配 -> 返回 code + path，并增加本地 usage
      const singleRes = await fetch(`${authBase}/api/2fa/agent/code?q=work`, { headers: agentH });
      expect(singleRes.status).toBe(200);
      const singleBody = (await singleRes.json()) as { issuer: string; path: string; code: string; remaining: number; period: number };
      expect(singleBody.issuer).toBe('GitHub');
      expect(singleBody.path).toBe('研发');
      expect(singleBody.code).toMatch(/^\d{6}$/);
      expect(singleBody.period).toBe(30);

      // 按 id 精确取码
      const byIdRes = await fetch(`${authBase}/api/2fa/agent/code?id=${e1.id}`, { headers: agentH });
      expect(byIdRes.status).toBe(200);

      // 检查 usage 已累计 2 次
      const dataAfter = (await (await fetch(`${authBase}/api/2fa/data`, { headers: mainH })).json()) as {
        usage: Record<string, { count: number }>;
      };
      expect(dataAfter.usage[e1.id]?.count).toBe(2);

      // 无匹配 -> 404
      const noneRes = await fetch(`${authBase}/api/2fa/agent/code?q=nonexistent`, { headers: agentH });
      expect(noneRes.status).toBe(404);
    } finally {
      await authSrv.stop();
    }
  });
});

// ───────────── 4. 插件生成与独立解密脚本 v2 往返 ─────────────

describe('TwoFa plugin generation & standalone decrypt script (v2)', () => {
  it('generates cosyee-2fa wrapper, CLI, and SKILL.md', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-2fa-plugin-'));
    try {
      ensureTwoFaPlugin({ pluginDir: dir, platform: 'win32', nodePath: 'C:\\Program Files\\Cosyee\\Cosyee.exe', isElectron: true });
      const wrapper = fs.readFileSync(path.join(dir, 'bin', 'cosyee-2fa'), 'utf8');
      expect(wrapper).toContain('ELECTRON_RUN_AS_NODE=1');
      expect(wrapper).toContain('C:/Program Files/Cosyee/Cosyee.exe');
      expect(fs.existsSync(path.join(dir, 'bin', 'cosyee-2fa.mjs'))).toBe(true);
      const skill = fs.readFileSync(path.join(dir, 'skills', '2fa', 'SKILL.md'), 'utf8');
      expect(skill).toContain('name: 2fa');
      expect(skill).toContain('cosyee:browser');
      expect(skill).toContain('fill <ref> <code>');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decrypts v2 vault with base64 key or key file, resolves group path, and computes RFC 6238 TOTP', () => {
    const key = generateKey();
    const keyB64 = encodeKey(key);
    const snap: TwoFaSnapshot = {
      schema: 2,
      groups: [
        { id: 'g1', parentId: null, name: '公司', sort: 0, updatedAt: '2026-11-27T00:00:00.000Z', deletedAt: null, version: 1 },
        { id: 'g2', parentId: 'g1', name: '生产', sort: 0, updatedAt: '2026-11-27T00:00:00.000Z', deletedAt: null, version: 1 },
      ],
      tags: [],
      entries: [
        {
          id: 'e1',
          issuer: 'GitHub Inc',
          account: 'alice@example.com',
          secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
          algorithm: 'SHA1',
          digits: 8,
          period: 30,
          groupId: 'g2',
          pinned: false,
          tags: [],
          sort: 0,
          createdAt: '2026-11-27T00:00:00.000Z',
          updatedAt: '2026-11-27T00:00:00.000Z',
          deletedAt: null,
          version: 1,
        },
      ],
    };

    const env: VaultEnvelopeV2 = encryptSnapshot(snap, key);
    const decrypted = decryptVault(env, keyB64);
    expect(decrypted.entries).toHaveLength(1);
    expect(resolveGroupPath(decrypted.entries[0].groupId, decrypted.groups)).toBe('公司 / 生产');

    const totp = decryptGenerateTotp(decrypted.entries[0], 59 * 1000);
    expect(totp.code).toBe('94287082');
    expect(totp.remaining).toBe(1);

    const uri = formatOtpAuthUri(decrypted.entries[0]);
    expect(uri).toBe(
      'otpauth://totp/GitHub%20Inc:alice%40example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=GitHub%20Inc&algorithm=SHA1&digits=8&period=30',
    );

    // 通过密钥文件也能解密
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-2fa-key-'));
    try {
      const keyFile = path.join(tmpDir, 'key.txt');
      fs.writeFileSync(keyFile, keyB64 + '\n', 'utf8');
      expect(decryptVault(env, keyFile).entries[0].id).toBe('e1');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ───────────── 4. 手动排序、迁移导入、导入预览 ─────────────

/** 手工构造 Google Authenticator 迁移载荷（protobuf MigrationPayload） */
function pbVarint(n: number): Buffer {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}
function pbField(field: number, wire: number, payload: Buffer): Buffer {
  return Buffer.concat([pbVarint((field << 3) | wire), payload]);
}
function pbBytes(field: number, data: Buffer | string): Buffer {
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return pbField(field, 2, Buffer.concat([pbVarint(b.length), b]));
}
function pbInt(field: number, n: number): Buffer {
  return pbField(field, 0, pbVarint(n));
}
function otpParams(o: { secret: Buffer; name: string; issuer?: string; algorithm?: number; digits?: number; type?: number }): Buffer {
  return Buffer.concat([
    pbBytes(1, o.secret),
    pbBytes(2, o.name),
    ...(o.issuer ? [pbBytes(3, o.issuer)] : []),
    ...(o.algorithm !== undefined ? [pbInt(4, o.algorithm)] : []),
    ...(o.digits !== undefined ? [pbInt(5, o.digits)] : []),
    ...(o.type !== undefined ? [pbInt(6, o.type)] : []),
    pbInt(7, 0), // counter（应被跳过）
    pbField(15, 5, Buffer.alloc(4)), // 未知 32 位字段
  ]);
}
function migrationUri(params: Buffer[], encode: (b64: string) => string = (b) => encodeURIComponent(b)): string {
  const payload = Buffer.concat([
    ...params.map((p) => pbBytes(1, p)),
    pbInt(2, 1), // version
    pbInt(3, 1), // batch_size
    pbInt(4, 0), // batch_index
    pbInt(5, 12345), // batch_id
  ]);
  return `otpauth-migration://offline?data=${encode(payload.toString('base64'))}`;
}

const RFC_SECRET_BYTES = Buffer.from('12345678901234567890');
const RFC_SECRET_B32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('Google Authenticator migration import parsing', () => {
  it('decodes SHA256/8 digits, issuer:account names, skips HOTP/MD5, and handles base64 variants', () => {
    const uri = migrationUri([
      otpParams({ secret: RFC_SECRET_BYTES, name: 'GitHub:alice@example.com', issuer: 'GitHub', algorithm: 2, digits: 2, type: 2 }),
      otpParams({ secret: RFC_SECRET_BYTES, name: 'bob', algorithm: 1, digits: 1, type: 0 }),
      otpParams({ secret: RFC_SECRET_BYTES, name: 'hotp-acc', issuer: 'HotpCo', type: 1 }),
      otpParams({ secret: RFC_SECRET_BYTES, name: 'md5-acc', issuer: 'Md5Co', algorithm: 4, type: 2 }),
      otpParams({ secret: RFC_SECRET_BYTES, name: 'Label Issuer:carol', algorithm: 3, digits: 0 }),
    ]);
    const r = parseImportText(uri);
    expect(r.errors).toEqual([]);
    expect(r.unsupported).toBe(2);
    expect(r.entries).toEqual([
      { issuer: 'GitHub', account: 'alice@example.com', secret: RFC_SECRET_B32, algorithm: 'SHA256', digits: 8, period: 30 },
      { issuer: 'bob', account: 'bob', secret: RFC_SECRET_B32, algorithm: 'SHA1', digits: 6, period: 30 },
      { issuer: 'Label Issuer', account: 'carol', secret: RFC_SECRET_B32, algorithm: 'SHA512', digits: 6, period: 30 },
    ]);

    // '+' 被当成空格、无填充、base64url、URL 编码几种变体都要解出同样内容
    const single = [otpParams({ secret: Buffer.from([0xfb, 0xff, 0xfe, 0x01, 0x02]), name: 'X:y', issuer: 'X' })];
    const std = migrationUri(single, (b) => b);
    expect(/data=(.*)$/.exec(std)![1]).toMatch(/[+/]/); // 保证用例确实覆盖到 + 和 /
    const variants = [
      std,
      migrationUri(single, (b) => b.replace(/=+$/, '')),
      migrationUri(single, (b) => b.replace(/\+/g, ' ')),
      migrationUri(single, (b) => b.replace(/\+/g, '-').replace(/\//g, '_')),
      migrationUri(single, (b) => encodeURIComponent(b)),
    ];
    const expected = parseImportText(variants[0]!).entries;
    expect(expected).toHaveLength(1);
    for (const v of variants) expect(parseImportText(v).entries).toEqual(expected);
  });

  it('mixes migration lines with otpauth lines and multi-QR exports, and reports malformed data', () => {
    const a = migrationUri([otpParams({ secret: RFC_SECRET_BYTES, name: 'A:one', issuer: 'A' })]);
    const b = migrationUri([otpParams({ secret: RFC_SECRET_BYTES, name: 'B:two', issuer: 'B' })]);
    const text = [a, `otpauth://totp/C:three?secret=${RFC_SECRET_B32}&issuer=C`, b, 'otpauth-migration://offline?data=!!!', 'otpauth-migration://offline'].join('\n');
    const r = parseImportText(text);
    expect(r.entries.map((e) => e.issuer)).toEqual(['A', 'C', 'B']);
    expect(r.errors).toHaveLength(2);
    // 截断的载荷：不崩溃，给出错误
    const truncated = `otpauth-migration://offline?data=${encodeURIComponent(Buffer.from([0x0a, 0x7f, 0x01]).toString('base64'))}`;
    expect(parseImportText(truncated).errors).toHaveLength(1);
  });
});

describe('TwoFaDb entry sort, migration and merge', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-2fa-sort-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('migrates a legacy vault by createdAt order (tie-break id) and is idempotent', () => {
    const file = path.join(tmp, 'vault.db');
    const legacy = new DatabaseSync(file);
    legacy.exec(`CREATE TABLE entries (
      id TEXT PRIMARY KEY, issuer TEXT NOT NULL, account TEXT NOT NULL DEFAULT '', secret TEXT NOT NULL,
      algorithm TEXT NOT NULL DEFAULT 'SHA1', digits INTEGER NOT NULL DEFAULT 6, period INTEGER NOT NULL DEFAULT 30,
      group_id TEXT, pinned INTEGER NOT NULL DEFAULT 0, tags TEXT NOT NULL DEFAULT '[]', note TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1)`);
    const ins = legacy.prepare("INSERT INTO entries (id, issuer, secret, created_at, updated_at) VALUES (?, ?, 'JBSWY3DPEHPK3PXP', ?, ?)");
    ins.run('c', 'Third', '2026-03-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z');
    ins.run('b', 'Tie-b', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    ins.run('a', 'Tie-a', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z');
    ins.run('z', 'First', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    legacy.close();

    let db = new TwoFaDb(file);
    expect(db.listEntries().map((e) => [e.issuer, e.sort])).toEqual([['First', 0], ['Tie-a', 1024], ['Tie-b', 2048], ['Third', 3072]]);
    // 迁移后手动改顺序，再次打开不能被重算覆盖
    const first = db.listEntries()[0]!;
    db.updateEntry(first.id, { version: first.version, sort: 99999 });
    db.close();
    db = new TwoFaDb(file);
    expect(db.listEntries().map((e) => e.issuer)).toEqual(['Tie-a', 'Tie-b', 'Third', 'First']);
    expect(db.getEntry(first.id)?.sort).toBe(99999);
    db.close();
  });

  it('appends on create/import and validates PATCH sort with version locking', () => {
    const db = new TwoFaDb(path.join(tmp, 'vault.db'));
    const e1 = db.createEntry({ issuer: 'A', secret: 'JBSWY3DPEHPK3PXP' });
    const e2 = db.createEntry({ issuer: 'B', secret: 'JBSWY3DPEHPK3PXP' });
    expect([e1.sort, e2.sort]).toEqual([0, 1024]);

    const imp = db.importEntries(
      parseImportText(`otpauth://totp/X:1?secret=${RFC_SECRET_B32}&issuer=X\notpauth://totp/Y:2?secret=${RFC_SECRET_B32}&issuer=Y`).entries,
    );
    expect(imp.added).toBe(2);
    expect(db.listEntries().map((e) => [e.issuer, e.sort])).toEqual([['A', 0], ['B', 1024], ['X', 2048], ['Y', 3072]]);

    // 删除最后一条后新增不会复用它的 sort（tombstone 同样参与取最大值）
    const y = db.listEntries()[3]!;
    db.deleteEntry(y.id, y.version);
    expect(db.createEntry({ issuer: 'Z', secret: 'JBSWY3DPEHPK3PXP' }).sort).toBe(4096);

    const moved = db.updateEntry(e2.id, { version: e2.version, sort: 512.5 });
    expect(moved.sort).toBe(512.5);
    expect(moved.version).toBe(e2.version + 1);
    for (const bad of ['1', null, Number.NaN, Infinity, {}]) {
      expect(() => db.updateEntry(e1.id, { version: e1.version, sort: bad })).toThrow(/sort/);
    }
    expect(() => db.updateEntry(e2.id, { version: e2.version, sort: 1 })).toThrow('conflict');
    db.close();
  });

  it('carries sort through merges, defaulting missing sort from createdAt order', () => {
    const base = (id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
      id, issuer: id, account: '', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1' as const, digits: 6 as const, period: 30,
      groupId: null, pinned: false, tags: [], createdAt, updatedAt: createdAt, deletedAt: null, version: 1, ...extra,
    });
    const local = { schema: 2, entries: [base('a', '2026-01-01T00:00:00.000Z', { sort: 5 })], groups: [], tags: [] } as unknown as TwoFaSnapshot;
    // 旧版远端快照：没有 sort 字段
    const remote = {
      schema: 2,
      entries: [base('a', '2026-01-01T00:00:00.000Z'), base('c', '2026-03-01T00:00:00.000Z'), base('b', '2026-02-01T00:00:00.000Z')],
      groups: [],
      tags: [],
    } as unknown as TwoFaSnapshot;
    const { merged } = mergeSnapshots(local, remote);
    const sortOf = Object.fromEntries(merged.entries.map((e) => [e.id, e.sort]));
    // a 平局取远端（远端补出的默认值 0），b/c 按 createdAt 名次补齐
    expect(sortOf).toEqual({ a: 0, b: 1024, c: 2048 });

    // 带 sort 的较新版本胜出时，sort 随条目一起走
    const newer = base('a', '2026-01-01T00:00:00.000Z', { sort: 77, version: 2, updatedAt: '2026-05-01T00:00:00.000Z' });
    const m2 = mergeSnapshots({ ...local, entries: [newer] } as unknown as TwoFaSnapshot, remote).merged;
    expect(m2.entries.find((e) => e.id === 'a')?.sort).toBe(77);
  });

  it('round-trips sort through exportSnapshot/applySnapshot', () => {
    const a = new TwoFaDb(path.join(tmp, 'a.db'));
    const e = a.createEntry({ issuer: 'A', secret: 'JBSWY3DPEHPK3PXP' });
    a.updateEntry(e.id, { version: 1, sort: 42.25 });
    const snap = a.exportSnapshot();
    expect(snap.entries[0]!.sort).toBe(42.25);
    const b = new TwoFaDb(path.join(tmp, 'b.db'));
    b.applySnapshot(snap);
    expect(b.getEntry(e.id)?.sort).toBe(42.25);
    a.close();
    b.close();
  });
});

describe('TwoFa HTTP: sort PATCH, import preview and exclude', () => {
  let tmp: string;
  let prevHome: string | undefined;
  let srv: RunningServer;
  let base: string;
  const J = { 'content-type': 'application/json' };

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-2fa-http-'));
    prevHome = process.env.COSYEE_HOME;
    process.env.COSYEE_HOME = path.join(tmp, 'home');
    srv = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(tmp, 'state.json'),
      twoFaFetch: async () => jsonResponse({ message: 'offline' }, 500),
      twoFaGetToken: async () => 'tok',
    });
    base = `http://127.0.0.1:${srv.port}`;
  });
  afterEach(async () => {
    await srv.stop();
    if (prevHome === undefined) delete process.env.COSYEE_HOME;
    else process.env.COSYEE_HOME = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const post = (p: string, body: unknown) => fetch(`${base}${p}`, { method: 'POST', headers: J, body: JSON.stringify(body) });

  it('PATCH accepts sort (with groupId) and rejects non-finite sort with 400', async () => {
    const g = ((await (await post('/api/2fa/groups', { name: 'G' })).json()) as { group: TwoFaGroup }).group;
    const e = ((await (await post('/api/2fa/entries', { issuer: 'A', secret: 'JBSWY3DPEHPK3PXP' })).json()) as { entry: TwoFaEntry }).entry;
    expect(e.sort).toBe(0);

    const ok = await fetch(`${base}/api/2fa/entries/${e.id}`, { method: 'PATCH', headers: J, body: JSON.stringify({ version: 1, groupId: g.id, sort: -512.5 }) });
    expect(ok.status).toBe(200);
    const upd = ((await ok.json()) as { entry: TwoFaEntry }).entry;
    expect(upd.groupId).toBe(g.id);
    expect(upd.sort).toBe(-512.5);

    for (const bad of ['3', null, 'abc']) {
      const r = await fetch(`${base}/api/2fa/entries/${e.id}`, { method: 'PATCH', headers: J, body: JSON.stringify({ version: 2, sort: bad }) });
      expect(r.status).toBe(400);
    }
    const data = (await (await fetch(`${base}/api/2fa/data`)).json()) as { entries: TwoFaEntry[] };
    expect(data.entries[0]!.sort).toBe(-512.5);
  });

  it('previews duplicates with the same rule as import, never leaks secrets, and honors exclude', async () => {
    await post('/api/2fa/entries', { issuer: 'GitHub', account: 'alice', secret: RFC_SECRET_B32 });
    const mig = migrationUri([
      otpParams({ secret: RFC_SECRET_BYTES, name: 'GitHub:alice', issuer: 'GitHub', algorithm: 2, digits: 2 }),
      otpParams({ secret: RFC_SECRET_BYTES, name: 'Other:bob', issuer: 'Other' }),
      otpParams({ secret: RFC_SECRET_BYTES, name: 'hotp', issuer: 'H', type: 1 }),
    ]);
    const text = [mig, `otpauth://totp/Third:carol?secret=${RFC_SECRET_B32}&issuer=Third`, 'garbage'].join('\n');

    const pr = await post('/api/2fa/import/preview', { text });
    expect(pr.status).toBe(200);
    const raw = await pr.text();
    expect(raw).not.toContain(RFC_SECRET_B32);
    const preview = JSON.parse(raw) as { items: Array<Record<string, unknown>>; unsupported: number; errors: string[] };
    expect(preview.unsupported).toBe(1);
    expect(preview.errors).toHaveLength(1);
    expect(preview.items.map((i) => [i.index, i.issuer, i.account, i.algorithm, i.digits, i.period, i.duplicate])).toEqual([
      [0, 'GitHub', 'alice', 'SHA256', 8, 30, true],
      [1, 'Other', 'bob', 'SHA1', 6, 30, false],
      [2, 'Third', 'carol', 'SHA1', 6, 30, false],
    ]);
    expect(typeof preview.items[0]!.duplicateOf).toBe('string');
    expect(preview.items[1]).not.toHaveProperty('duplicateOf');

    // 预览不写库
    expect(((await (await fetch(`${base}/api/2fa/data`)).json()) as { entries: unknown[] }).entries).toHaveLength(1);

    // exclude 校验
    for (const bad of ['1', [-1], [1.5], ['0'], {}]) {
      expect((await post('/api/2fa/import', { text, exclude: bad })).status).toBe(400);
    }

    // 排除 index 1：重复项 0 被跳过（与预览一致），1 被排除，2 导入
    const imp = (await (await post('/api/2fa/import', { text, exclude: [1] })).json()) as { added: number; skipped: number; unsupported: number };
    expect(imp).toMatchObject({ added: 1, skipped: 1, unsupported: 1 });
    const data = (await (await fetch(`${base}/api/2fa/data`)).json()) as { entries: TwoFaEntry[] };
    expect(data.entries.map((e) => [e.issuer, e.sort])).toEqual([['GitHub', 0], ['Third', 1024]]);

    // 再次预览：Third 现在也是重复
    const again = (await (await post('/api/2fa/import/preview', { text })).json()) as { items: Array<{ issuer: string; duplicate: boolean }> };
    expect(again.items.map((i) => [i.issuer, i.duplicate])).toEqual([['GitHub', true], ['Other', false], ['Third', true]]);
  });
});
