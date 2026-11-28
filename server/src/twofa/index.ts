// 2FA 服务端核心服务：本地 SQLite 存储、AES-256-GCM 加密、GitHub 私有仓库双向合并同步与 Agent 接口。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cosyeeHome } from '../paths.js';
import { HttpError } from '../workspaces.js';
import { decryptSnapshot, decodeKey, encodeKey, encryptSnapshot, generateKey } from './crypto.js';
import { TwoFaDb } from './db.js';
import { GitHubClient, ShaConflictError, sanitizeGitHubError } from './github.js';
import { mergeSnapshots } from './merge.js';
import { generateTotp, parseImportText } from './totp.js';
import {
  TwoFaConflictError,
  type TwoFaDataResponse,
  type TwoFaEntry,
  type TwoFaGroup,
  type TwoFaImportPreviewResult,
  type TwoFaSync,
  type TwoFaSyncStateRow,
  type TwoFaTag,
  type TwoFaUsage,
} from './types.js';

export { TwoFaConflictError } from './types.js';
export type {
  TwoFaAlgorithm,
  TwoFaDataResponse,
  TwoFaEntry,
  TwoFaGroup,
  TwoFaImportPreviewResult,
  TwoFaSnapshot,
  TwoFaSync,
  TwoFaTag,
  TwoFaTagColor,
  TwoFaUsage,
  VaultEnvelopeV2,
} from './types.js';
export { decryptSnapshot, decodeKey, encodeKey, encryptSnapshot, generateKey } from './crypto.js';
export { mergeSnapshots, snapshotsEqual } from './merge.js';
export { base32Decode, generateTotp, normalizeBase32Secret, parseImportText } from './totp.js';
export { GitHubClient, ShaConflictError, sanitizeGitHubError } from './github.js';
export { TwoFaDb } from './db.js';

/** 置顶在前，其余按手动排序值升序（listEntries 已按 sort 排序，Array.sort 稳定） */
function byPinnedThenSort(entries: TwoFaEntry[]): TwoFaEntry[] {
  return [...entries].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sort - b.sort);
}

/** 导入请求体大小上限（2 MB） */
export const TWOFA_IMPORT_BODY_LIMIT = 2 * 1024 * 1024;

const VAULT_REPO_NAME = 'cosyee-2fa-vault';
const KEY_REPO_NAME = 'cosyee-2fa-key';
const VAULT_FILE_PATH = 'vault.json';
const KEY_FILE_PATH = 'key.txt';
const README_FILE_PATH = 'README.md';
const DECRYPT_FILE_PATH = 'decrypt.mjs';

const DEFAULT_DEBOUNCE_MS = 2_000;
const DEFAULT_SYNC_INTERVAL_MS = 60 * 60 * 1000;
const MAX_SHA_RETRIES = 3;

const HERE = path.dirname(fileURLToPath(import.meta.url));

let atomicSeq = 0;

/** 原子写文件（临时文件 + rename，非 Windows 设 0600 权限） */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.promises.mkdir(dir, { recursive: true });
  if (process.platform !== 'win32') {
    await fs.promises.chmod(dir, 0o700).catch(() => {});
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.${++atomicSeq}.tmp`;
  await fs.promises.writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await fs.promises.chmod(tmp, 0o600).catch(() => {});
  }
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(tmp, file);
      return;
    } catch (e) {
      if (i >= 5) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
      await new Promise((r) => setTimeout(r, 30 * (i + 1)));
    }
  }
}

function resolveGroupPath(groupId: string | null, groups: readonly TwoFaGroup[]): string {
  if (!groupId) return '';
  const map = new Map<string, TwoFaGroup>();
  for (const g of groups) map.set(g.id, g);
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = groupId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const g = map.get(cur);
    if (!g) break;
    parts.unshift(g.name);
    cur = g.parentId;
  }
  return parts.join(' / ');
}

const README_MARKER = '# Cosyee 2FA Vault';

function vaultReadmeContent(): string {
  return `${README_MARKER}

本仓库由 [Cosyee](https://github.com/cosyeezz/cosyee) 自动维护，用于加密同步两步验证（2FA / TOTP）数据。

## 文件说明

- \`vault.json\`：使用 AES-256-GCM 加密的 2FA 快照密文（不包含明文密钥）。
- \`decrypt.mjs\`：零依赖独立恢复脚本（需要 Node.js 18+），即使没有 Cosyee 也能解密并生成验证码。

## 应急恢复步骤

1. 从你的私有仓库 \`cosyee-2fa-key\` 下载 \`key.txt\`（或从本机 \`~/.cosyee/2fa/key\` 读取）。
2. 在本仓库目录下运行：

\`\`\`bash
node decrypt.mjs vault.json /path/to/key.txt
\`\`\`

脚本会输出每条有效记录的分组路径、网站名/账号、\`otpauth://\` 链接以及当前验证码。

## 换机自动恢复

在新设备上运行 \`gh auth login\` 后，在 Cosyee 中执行 \`/cosyee:2fa\` 配置命令（\`cosyee-2fa setup\`）即可自动拉取密钥与全部记录。

## 安全提示

- 密钥仓库 \`cosyee-2fa-key\` 与本保管库仓库**必须始终保持私有（Private）**，切勿设为公开或授权给不可信的第三方应用。
- 保管库与密钥存放在同一个 GitHub 账号下，一旦该 GitHub 账号被攻破，两个仓库都会同时暴露。请为 GitHub 开启强密码和两步验证，并将 **GitHub 恢复码（Recovery Codes）离线保存在安全位置**，不要只存进本 2FA 保管库。
`;
}

function readDecryptScriptContent(): string | null {
  const candidates = [
    path.join(HERE, 'cosyee-2fa-decrypt.mjs'),
    path.resolve(HERE, '../../../scripts/cosyee-2fa-decrypt.mjs'),
    path.resolve(HERE, '../../scripts/cosyee-2fa-decrypt.mjs'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8');
    } catch {
      // 尝试下一个路径
    }
  }
  return null;
}

export interface TwoFaServiceOptions {
  /** 数据目录，默认 <COSYEE_HOME>/2fa */
  dir?: () => string;
  /** 出站 HTTP 请求（测试可替换，默认 globalThis.fetch） */
  fetch?: typeof globalThis.fetch;
  /** 获取 GitHub Token 的函数（测试可替换，默认 GH_TOKEN / gh auth token） */
  getToken?: () => Promise<string>;
  /** 当前时间源（测试可替换） */
  now?: () => Date;
  /** 数据或同步状态变化时回调（用于广播 WS 2fa.changed） */
  onChange?: () => void;
  /** 本地写入后的防抖同步延迟（毫秒），默认 2000 */
  debounceMs?: number;
  /** 定时同步间隔（毫秒），默认 60 分钟 */
  intervalMs?: number;
  /** 是否允许在本地全空时启动自动探测远端仓库恢复（默认非测试环境启用） */
  autoDiscover?: boolean;
}

export interface AgentCodeMatch {
  id: string;
  issuer: string;
  account: string;
  path: string;
}

export type AgentCodeResult =
  | { issuer: string; account: string; path: string; code: string; remaining: number; period: number }
  | { matches: AgentCodeMatch[] };

export interface AgentSetupResult {
  sync: TwoFaSync;
  created: { vault: boolean; key: boolean };
  steps: string[];
}

export class TwoFaService {
  private readonly db: TwoFaDb;
  private readonly gh: GitHubClient;
  private readonly nowFn: () => Date;
  private readonly debounceMs: number;
  private readonly intervalMs: number;
  private readonly autoDiscover: boolean;

  private syncChain: Promise<void> = Promise.resolve();
  private syncing = false;
  private debounceTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly opts: TwoFaServiceOptions = {}) {
    this.nowFn = opts.now ?? (() => new Date());
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.intervalMs = opts.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.autoDiscover = opts.autoDiscover ?? (!process.env.VITEST || Boolean(opts.getToken && opts.fetch));
    this.db = new TwoFaDb(path.join(this.dir(), '2fa.db'), this.nowFn);
    this.gh = new GitHubClient({ fetch: opts.fetch, getToken: opts.getToken });
  }

  private dir(): string {
    return this.opts.dir ? this.opts.dir() : path.join(cosyeeHome(), '2fa');
  }

  private keyPath(): string {
    return path.join(this.dir(), 'key');
  }

  private nowIso(): string {
    return this.nowFn().toISOString();
  }

  private notify(): void {
    if (this.disposed) return;
    try {
      this.opts.onChange?.();
    } catch {
      // 回调异常不影响主流程
    }
  }

  /** 启动时调用：如果已配置同步，触发一次同步；如果本地全空且允许自动探测，尝试从远端自动恢复；启动每小时定时同步 */
  start(): void {
    if (this.disposed) return;
    const st = this.db.getSyncState();
    if (st.repo && st.keyRepo) {
      void this.syncNow().catch(() => {});
    } else if (this.autoDiscover && !this.db.hasAnyData() && !this.hasLocalKey()) {
      void this.tryAutoRecoverFromRemote().catch(() => {});
    }

    if (!this.intervalTimer && this.intervalMs > 0) {
      this.intervalTimer = setInterval(() => {
        if (this.disposed) return;
        const cur = this.db.getSyncState();
        if (cur.repo && cur.keyRepo) {
          void this.syncNow().catch(() => {});
        }
      }, this.intervalMs);
      this.intervalTimer.unref();
    }
  }

  /** 停止定时器并关闭数据库 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    this.db.close();
  }

  // ───────────── 密钥文件管理 ─────────────

  private hasLocalKey(): boolean {
    try {
      const raw = fs.readFileSync(this.keyPath(), 'utf8');
      decodeKey(raw);
      return true;
    } catch {
      return false;
    }
  }

  private async readLocalKey(): Promise<Buffer | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(this.keyPath(), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
      throw e;
    }
    return decodeKey(raw);
  }

  private async writeLocalKey(key: Buffer): Promise<void> {
    await writeFileAtomic(this.keyPath(), encodeKey(key) + '\n');
  }

  /** 确保本机有密钥；如果缺失且已知密钥仓库，则从远端 key.txt 自动恢复 */
  private async ensureKey(state: TwoFaSyncStateRow): Promise<Buffer> {
    const local = await this.readLocalKey();
    if (local) return local;
    if (!state.keyRepo) {
      throw new Error('本地密钥文件缺失且未配置密钥仓库');
    }
    const remote = await this.gh.getContents(state.keyRepo, KEY_FILE_PATH);
    if (!remote) {
      throw new Error(`本地密钥缺失且远端仓库 ${state.keyRepo} 中没有 ${KEY_FILE_PATH}`);
    }
    const key = decodeKey(remote.content.toString('utf8'));
    await this.writeLocalKey(key);
    return key;
  }

  /** 本地目录被清空后重启：静默探测同名私有仓库并自动恢复密钥与数据 */
  private async tryAutoRecoverFromRemote(): Promise<void> {
    return this.serializeSync(async () => {
      if (this.disposed) return;
      const cur = this.db.getSyncState();
      if (cur.repo || this.db.hasAnyData() || this.hasLocalKey()) return;

      const user = await this.gh.getUser();
      const vaultRepo = `${user.login}/${VAULT_REPO_NAME}`;
      const keyRepo = `${user.login}/${KEY_REPO_NAME}`;
      const [vInfo, kInfo] = await Promise.all([this.gh.getRepo(vaultRepo), this.gh.getRepo(keyRepo)]);
      if (!vInfo?.private || !kInfo?.private) return;

      const remoteKey = await this.gh.getContents(keyRepo, KEY_FILE_PATH);
      if (!remoteKey) return;
      const key = decodeKey(remoteKey.content.toString('utf8'));
      const remoteVault = await this.gh.getContents(vaultRepo, VAULT_FILE_PATH);
      if (!remoteVault) return;

      await this.writeLocalKey(key);
      this.db.updateSyncState({ repo: vaultRepo, keyRepo, ghLogin: user.login, lastError: null });
      await this.syncLocked();
    });
  }

  // ───────────── 同步状态与调度 ─────────────

  private toSyncDto(state: TwoFaSyncStateRow): TwoFaSync {
    const configured = Boolean(state.repo && state.keyRepo);
    return {
      configured,
      ...(state.repo ? { repo: state.repo } : {}),
      ...(state.keyRepo ? { keyRepo: state.keyRepo } : {}),
      ...(state.ghLogin ? { ghLogin: state.ghLogin } : {}),
      syncing: this.syncing,
      ...(state.lastSyncAt ? { lastSyncAt: state.lastSyncAt } : {}),
      ...(state.lastError ? { lastError: state.lastError } : {}),
    };
  }

  getSyncStatus(): TwoFaSync {
    return this.toSyncDto(this.db.getSyncState());
  }

  private scheduleDebouncedSync(): void {
    if (this.disposed) return;
    const st = this.db.getSyncState();
    if (!st.repo || !st.keyRepo) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.disposed) return;
      void this.syncNow().catch(() => {});
    }, this.debounceMs);
    this.debounceTimer.unref();
  }

  private onLocalMutation(): void {
    this.notify();
    this.scheduleDebouncedSync();
  }

  private serializeSync<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.syncChain.then(fn, fn);
    this.syncChain = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** 立即执行一次双向合并同步（未配置同步时抛 400） */
  async syncNow(): Promise<TwoFaSync> {
    return this.serializeSync(async () => {
      const state = this.db.getSyncState();
      if (!state.repo || !state.keyRepo) {
        throw new HttpError(400, '尚未配置 GitHub 同步');
      }
      return this.syncLocked();
    });
  }

  /** 已持有 syncChain 锁时的核心同步逻辑 */
  private async syncLocked(): Promise<TwoFaSync> {
    const state = this.db.getSyncState();
    if (!state.repo || !state.keyRepo) {
      throw new HttpError(400, '尚未配置 GitHub 同步');
    }

    this.syncing = true;
    this.notify();

    let lastErr: unknown = null;
    try {
      const key = await this.ensureKey(state);
      let finalSha = state.remoteSha;
      let localChangedAny = false;

      for (let attempt = 0; attempt < MAX_SHA_RETRIES; attempt++) {
        const remoteFile = await this.gh.getContents(state.repo, VAULT_FILE_PATH);
        const localSnap = this.db.exportSnapshot();

        if (!remoteFile) {
          // 远端尚无 vault.json：直接加密推送本地快照
          const envelope = encryptSnapshot(localSnap, key);
          const body = Buffer.from(JSON.stringify(envelope, null, 2) + '\n', 'utf8');
          try {
            const put = await this.gh.putContents(
              state.repo,
              VAULT_FILE_PATH,
              body,
              `sync 2fa vault ${this.nowIso()}`,
            );
            finalSha = put.sha || finalSha;
            lastErr = null;
            break;
          } catch (e) {
            if (e instanceof ShaConflictError && attempt + 1 < MAX_SHA_RETRIES) {
              continue;
            }
            throw e;
          }
        }

        // 远端存在：解密 → 合并 → 必要时写回本地 → 必要时推送远端
        let parsedEnv: unknown;
        try {
          parsedEnv = JSON.parse(remoteFile.content.toString('utf8'));
        } catch {
          throw new Error('远端 vault.json 不是合法 JSON');
        }
        const remoteSnap = decryptSnapshot(parsedEnv, key);
        const { merged, changedLocal, differsFromRemote } = mergeSnapshots(localSnap, remoteSnap);

        if (changedLocal) {
          this.db.applySnapshot(merged);
          localChangedAny = true;
        }

        finalSha = remoteFile.sha;

        if (!differsFromRemote) {
          lastErr = null;
          break;
        }

        const envelope = encryptSnapshot(merged, key);
        const body = Buffer.from(JSON.stringify(envelope, null, 2) + '\n', 'utf8');
        try {
          const put = await this.gh.putContents(
            state.repo,
            VAULT_FILE_PATH,
            body,
            `sync 2fa vault ${this.nowIso()}`,
            remoteFile.sha,
          );
          finalSha = put.sha || finalSha;
          lastErr = null;
          break;
        } catch (e) {
          if (e instanceof ShaConflictError && attempt + 1 < MAX_SHA_RETRIES) {
            continue;
          }
          throw e;
        }
      }

      if (lastErr) throw lastErr;

      const updated = this.db.updateSyncState({
        remoteSha: finalSha,
        lastSyncAt: this.nowIso(),
        lastError: null,
      });
      this.syncing = false;
      this.notify();
      void localChangedAny;
      return this.toSyncDto(updated);
    } catch (e) {
      const msg = sanitizeGitHubError(e);
      if (!this.disposed) {
        this.db.updateSyncState({ lastError: msg });
      }
      this.syncing = false;
      this.notify();
      throw e instanceof HttpError ? e : new HttpError(502, msg);
    }
  }

  // ───────────── REST 数据操作 ─────────────

  getData(): TwoFaDataResponse {
    return {
      entries: this.db.listEntries(),
      groups: this.db.listGroups(),
      tags: this.db.listTags(),
      usage: this.db.getUsageMap(),
      sync: this.getSyncStatus(),
    };
  }

  createEntry(body: Record<string, unknown>): TwoFaEntry {
    const entry = this.db.createEntry(body);
    this.onLocalMutation();
    return entry;
  }

  updateEntry(id: string, body: Record<string, unknown>): TwoFaEntry {
    const entry = this.db.updateEntry(id, body);
    this.onLocalMutation();
    return entry;
  }

  deleteEntry(id: string, version: unknown): void {
    this.db.deleteEntry(id, version);
    this.onLocalMutation();
  }

  createGroup(body: Record<string, unknown>): TwoFaGroup {
    const group = this.db.createGroup(body);
    this.onLocalMutation();
    return group;
  }

  updateGroup(id: string, body: Record<string, unknown>): TwoFaGroup {
    const group = this.db.updateGroup(id, body);
    this.onLocalMutation();
    return group;
  }

  deleteGroup(id: string, mode: unknown, version: unknown): void {
    this.db.deleteGroup(id, mode, version);
    this.onLocalMutation();
  }

  createTag(body: Record<string, unknown>): TwoFaTag {
    const tag = this.db.createTag(body);
    this.onLocalMutation();
    return tag;
  }

  updateTag(id: string, body: Record<string, unknown>): TwoFaTag {
    const tag = this.db.updateTag(id, body);
    this.onLocalMutation();
    return tag;
  }

  deleteTag(id: string, version: unknown): void {
    this.db.deleteTag(id, version);
    this.onLocalMutation();
  }

  /** 记录一次使用（仅本机，不触发同步） */
  bumpUsage(entryId: string): TwoFaUsage {
    return this.db.bumpUsage(entryId);
  }

  /** 导入预览：只返回元信息与重复标记，绝不返回 secret */
  previewImport(body: Record<string, unknown>): TwoFaImportPreviewResult {
    if (typeof body.text !== 'string') throw new HttpError(400, '缺少导入文本 text');
    const parsed = parseImportText(body.text);
    const dups = this.db.previewImport(parsed.entries);
    return {
      items: parsed.entries.map((e, index) => ({
        index,
        issuer: e.issuer,
        account: e.account,
        algorithm: e.algorithm,
        digits: e.digits,
        period: e.period,
        duplicate: dups[index]!.duplicate,
        ...(dups[index]!.duplicateOf ? { duplicateOf: dups[index]!.duplicateOf } : {}),
      })),
      unsupported: parsed.unsupported,
      errors: parsed.errors,
    };
  }

  importText(body: Record<string, unknown>): { added: number; skipped: number; unsupported: number; errors: string[] } {
    if (typeof body.text !== 'string') throw new HttpError(400, '缺少导入文本 text');
    let exclude: Set<number> | undefined;
    if (body.exclude !== undefined && body.exclude !== null) {
      if (!Array.isArray(body.exclude) || !body.exclude.every((n) => typeof n === 'number' && Number.isInteger(n) && n >= 0)) {
        throw new HttpError(400, 'exclude 必须是非负整数数组');
      }
      exclude = new Set(body.exclude as number[]);
    }
    const parsed = parseImportText(body.text);
    const { added, skipped } = this.db.importEntries(parsed.entries, {
      groupId: body.groupId as string | null | undefined,
      tags: body.tags,
      exclude,
    });
    if (added > 0) this.onLocalMutation();
    return { added, skipped, unsupported: parsed.unsupported, errors: parsed.errors };
  }

  // ───────────── Agent 专用接口 ─────────────

  agentCode(params: { q?: string | null; id?: string | null }): AgentCodeResult {
    const id = params.id?.trim() || '';
    const q = params.q?.trim() || '';
    if (!id && !q) throw new HttpError(400, '请提供查询关键词 q 或条目 id');

    const groups = this.db.listGroups();

    if (id) {
      const entry = this.db.getEntry(id);
      if (!entry) throw new HttpError(404, '未找到对应的 2FA 条目');
      const { code, remaining, period } = generateTotp(entry, this.nowFn().getTime());
      this.db.bumpUsage(entry.id);
      return {
        issuer: entry.issuer,
        account: entry.account,
        path: resolveGroupPath(entry.groupId, groups),
        code,
        remaining,
        period,
      };
    }

    const entries = byPinnedThenSort(this.db.listEntries());
    const tags = this.db.listTags();
    const tagNameById = new Map<string, string>(tags.map((t) => [t.id, t.name]));
    const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);

    const matched: Array<{ entry: TwoFaEntry; path: string }> = [];
    for (const entry of entries) {
      const groupPath = resolveGroupPath(entry.groupId, groups);
      const tagNames = entry.tags.map((tid) => tagNameById.get(tid) ?? '').filter(Boolean);
      const haystack = [entry.issuer, entry.account, entry.note ?? '', groupPath, ...tagNames]
        .join(' ')
        .toLowerCase();
      if (tokens.every((tok) => haystack.includes(tok))) {
        matched.push({ entry, path: groupPath });
      }
    }

    if (matched.length === 0) {
      throw new HttpError(404, `未找到匹配「${q}」的 2FA 条目`);
    }

    if (matched.length === 1) {
      const { entry, path: groupPath } = matched[0]!;
      const { code, remaining, period } = generateTotp(entry, this.nowFn().getTime());
      this.db.bumpUsage(entry.id);
      return {
        issuer: entry.issuer,
        account: entry.account,
        path: groupPath,
        code,
        remaining,
        period,
      };
    }

    return {
      matches: matched.map(({ entry, path: groupPath }) => ({
        id: entry.id,
        issuer: entry.issuer,
        account: entry.account,
        path: groupPath,
      })),
    };
  }

  /** 只返回名称、路径、标签（绝不返回 secret） */
  agentList(): { entries: Array<{ id: string; issuer: string; account: string; path: string; tags: string[]; pinned: boolean }> } {
    const entries = byPinnedThenSort(this.db.listEntries());
    const groups = this.db.listGroups();
    const tags = this.db.listTags();
    const tagNameById = new Map<string, string>(tags.map((t) => [t.id, t.name]));

    return {
      entries: entries.map((e) => ({
        id: e.id,
        issuer: e.issuer,
        account: e.account,
        path: resolveGroupPath(e.groupId, groups),
        tags: e.tags.map((tid) => tagNameById.get(tid)).filter((n): n is string => Boolean(n)),
        pinned: e.pinned,
      })),
    };
  }

  /** 初始化 / 换机恢复 GitHub 私有仓库同步 */
  async agentSetup(): Promise<AgentSetupResult> {
    return this.serializeSync(async () => {
      const steps: string[] = [];
      const created = { vault: false, key: false };

      let login: string;
      try {
        const user = await this.gh.getUser();
        login = user.login;
        steps.push(`已确认 GitHub 登录账号：${login}`);
      } catch (e) {
        const msg = sanitizeGitHubError(e);
        this.db.updateSyncState({ lastError: msg });
        this.notify();
        throw new HttpError(400, msg);
      }

      const vaultRepo = `${login}/${VAULT_REPO_NAME}`;
      const keyRepo = `${login}/${KEY_REPO_NAME}`;

      // 1. 检查或创建私有仓库 cosyee-2fa-vault
      const existingVaultRepo = await this.gh.getRepo(vaultRepo);
      if (!existingVaultRepo) {
        await this.gh.createPrivateRepo(VAULT_REPO_NAME, 'Cosyee 2FA 加密保管库（请勿设为公开）');
        created.vault = true;
        steps.push(`已创建私有仓库：${vaultRepo}`);
      } else if (!existingVaultRepo.private) {
        const msg = `仓库 ${vaultRepo} 是公开仓库，为保护数据安全已中止。请先在 GitHub 上将其设为私有或删除后重试。`;
        this.db.updateSyncState({ lastError: msg });
        this.notify();
        throw new HttpError(400, msg);
      } else {
        steps.push(`复用已有私有仓库：${vaultRepo}`);
      }

      // 2. 检查或创建私有仓库 cosyee-2fa-key
      const existingKeyRepo = await this.gh.getRepo(keyRepo);
      if (!existingKeyRepo) {
        await this.gh.createPrivateRepo(KEY_REPO_NAME, 'Cosyee 2FA 加密密钥（请勿设为公开）');
        created.key = true;
        steps.push(`已创建私有仓库：${keyRepo}`);
      } else if (!existingKeyRepo.private) {
        const msg = `仓库 ${keyRepo} 是公开仓库，为保护密钥安全已中止。请先在 GitHub 上将其设为私有或删除后重试。`;
        this.db.updateSyncState({ lastError: msg });
        this.notify();
        throw new HttpError(400, msg);
      } else {
        steps.push(`复用已有私有仓库：${keyRepo}`);
      }

      // 3. 协调本地密钥与远端 key.txt
      const localKey = await this.readLocalKey();
      const remoteKeyFile = await this.gh.getContents(keyRepo, KEY_FILE_PATH);
      const remoteKey = remoteKeyFile ? decodeKey(remoteKeyFile.content.toString('utf8')) : null;

      if (localKey && remoteKey) {
        if (!localKey.equals(remoteKey)) {
          const msg = `本地密钥（${this.keyPath()}）与远端 ${keyRepo}/${KEY_FILE_PATH} 不一致，已中止以避免数据损坏。请确认要保留哪一份密钥。`;
          this.db.updateSyncState({ lastError: msg });
          this.notify();
          throw new HttpError(400, msg);
        }
        steps.push('本地密钥与远端密钥一致');
      } else if (!localKey && remoteKey) {
        await this.writeLocalKey(remoteKey);
        steps.push(`已从 ${keyRepo} 恢复加密密钥到本地`);
      } else if (localKey && !remoteKey) {
        await this.gh.putContents(
          keyRepo,
          KEY_FILE_PATH,
          Buffer.from(encodeKey(localKey) + '\n', 'utf8'),
          'upload cosyee 2fa encryption key',
        );
        steps.push(`已将本地加密密钥上传到 ${keyRepo}/${KEY_FILE_PATH}`);
      } else {
        const newKey = generateKey();
        await this.writeLocalKey(newKey);
        await this.gh.putContents(
          keyRepo,
          KEY_FILE_PATH,
          Buffer.from(encodeKey(newKey) + '\n', 'utf8'),
          'init cosyee 2fa encryption key',
        );
        steps.push(`已生成 256 位随机密钥并保存到本地与 ${keyRepo}/${KEY_FILE_PATH}`);
      }

      // 4. 在 vault 仓库补齐或更新 README.md 与应急恢复脚本 decrypt.mjs
      const readmeContent = vaultReadmeContent();
      const existingReadme = await this.gh.getContents(vaultRepo, README_FILE_PATH);
      if (!existingReadme) {
        await this.gh.putContents(
          vaultRepo,
          README_FILE_PATH,
          Buffer.from(readmeContent, 'utf8'),
          'add Cosyee 2FA vault README',
        );
        steps.push(`已上传说明文档 ${README_FILE_PATH}`);
      } else if (created.vault || !existingReadme.content.toString('utf8').includes(README_MARKER)) {
        await this.gh.putContents(
          vaultRepo,
          README_FILE_PATH,
          Buffer.from(readmeContent, 'utf8'),
          'update Cosyee 2FA vault README',
          existingReadme.sha,
        );
        steps.push(`已更新说明文档 ${README_FILE_PATH}`);
      }

      const decryptContent = readDecryptScriptContent();
      if (!decryptContent) {
        steps.push(`警告：未找到本地 cosyee-2fa-decrypt.mjs，已跳过上传 ${DECRYPT_FILE_PATH}`);
      } else {
        const existingDecrypt = await this.gh.getContents(vaultRepo, DECRYPT_FILE_PATH);
        if (!existingDecrypt) {
          await this.gh.putContents(
            vaultRepo,
            DECRYPT_FILE_PATH,
            Buffer.from(decryptContent, 'utf8'),
            'add standalone decrypt.mjs recovery script',
          );
          steps.push(`已上传应急解密脚本 ${DECRYPT_FILE_PATH}`);
        } else if (existingDecrypt.content.toString('utf8') !== decryptContent) {
          await this.gh.putContents(
            vaultRepo,
            DECRYPT_FILE_PATH,
            Buffer.from(decryptContent, 'utf8'),
            'update standalone decrypt.mjs recovery script',
            existingDecrypt.sha,
          );
          steps.push(`已更新应急解密脚本 ${DECRYPT_FILE_PATH}`);
        }
      }

      // 5. 写入 sync_state 并执行一次同步
      this.db.updateSyncState({
        repo: vaultRepo,
        keyRepo,
        ghLogin: login,
        lastError: null,
      });
      const sync = await this.syncLocked();
      steps.push('已完成首次加密同步');

      return { sync, created, steps };
    });
  }
}
