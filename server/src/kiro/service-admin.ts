// Kiro 账号与内置 kiro.rs 服务的映射：每个 cosyee Kiro 账号 = 一个凭据 + 一个以账号 id 命名的分组 + 一个绑定该分组的客户端 Key。
// 这里只通过 Admin API 操作（经 KiroProxyManager.request），系统 Key（id=0）绝不下发给账号。
// 提供：添加账号、重新登录换凭据、移除账号、查余额、拉模型映射、旧版（每账号一个进程）到内置服务的迁移。
import fs from 'node:fs';
import path from 'node:path';
import type { KiroBalance, KiroLoginMethod } from '@cosyee/shared';
import { type KiroAccountMeta, isLegacyKiro, readApiConfig, writeApiConfig } from '../accounts/api-config.js';
import { HttpError } from '../workspaces.js';
import { fetchKiroModels, buildKiroModelMap } from './models.js';
import { type AdminResponse, type KiroProxyManager, adminErrorMessage } from './proxy.js';
import { type KiroCredentialEntry, buildKiroCredential, isValidRegion, sanitizeKiroError } from './sanitize.js';

/** 旧版每账号独立进程的数据目录名与迁移后的归档名 */
const LEGACY_DIR = 'kiro';
const MIGRATED_DIR = 'kiro.migrated';

export interface KiroAccountAdminOptions {
  /** 测试替换：拉模型用的 fetch（Admin API 的 fetch 在 KiroProxyManager 里） */
  fetch?: typeof globalThis.fetch;
  /** 日志（默认 console.warn）；消息已脱敏 */
  log?: (message: string) => void;
  /** 模型映射被后台刷新后通知（账号需要重置会话） */
  onModelsChanged?: (accountId: string) => void;
}

export interface AddAccountParams {
  accountId: string;
  dir: string;
  method: KiroLoginMethod;
  cred: KiroCredentialEntry;
  signal?: AbortSignal;
  /** 凭据「已存在」时复用分组里已有的那条（迁移重试用），而不是报错 */
  reuseExisting?: boolean;
  /** apiKey 方式添加后用余额接口验证（默认 true）；迁移时不验证，避免临时故障让原本可用的账号失败 */
  verifyApiKey?: boolean;
}

export interface ReloginParams {
  accountId: string;
  dir: string;
  method: KiroLoginMethod;
  cred: KiroCredentialEntry;
  signal?: AbortSignal;
}

/** 本次调用在服务里创建的东西（失败时只回滚这些） */
interface Created {
  group: string | null;
  credential: number | null;
  key: number | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** 旧版 credentials.json（hank9999 格式）里的一条 → 内置服务的凭据 */
function legacyToEntry(item: Record<string, unknown>): KiroCredentialEntry {
  const am = (str(item.authMethod) ?? '').toLowerCase();
  const region = (v: unknown): string | null => (isValidRegion(v) ? v.trim() : null);
  if (am === 'api_key') {
    const key = str(item.kiroApiKey);
    if (!key) throw new Error('旧凭据缺少 Kiro API Key');
    return buildKiroCredential({ authMethod: 'api_key', kiroApiKey: key, apiRegion: region(item.apiRegion) });
  }
  if (!str(item.refreshToken)) throw new Error('旧凭据缺少刷新令牌');
  const idc = am === 'idc' || am === 'builder-id' || am === 'iam';
  return buildKiroCredential({
    authMethod: idc ? 'idc' : 'social',
    refreshToken: str(item.refreshToken),
    accessToken: str(item.accessToken),
    expiresAt: str(item.expiresAt),
    profileArn: str(item.profileArn),
    clientId: idc ? str(item.clientId) : null,
    clientSecret: idc ? str(item.clientSecret) : null,
    authRegion: region(item.authRegion) ?? region(item.region),
    apiRegion: region(item.apiRegion),
  });
}

export class KiroAccountAdmin {
  constructor(
    private readonly proxy: KiroProxyManager,
    private readonly opts: KiroAccountAdminOptions = {},
  ) {}

  private log(msg: string): void {
    (this.opts.log ?? ((m: string) => console.warn(`[kiro] ${m}`)))(msg);
  }

  /** 创建分组；已存在（409）算成功。返回本次是否新建 */
  private async ensureGroup(accountId: string): Promise<boolean> {
    const r = await this.proxy.request('POST', '/groups', { name: accountId, description: `cosyee ${accountId}` });
    if (r.status === 409) return false;
    if (!r.ok) throw new Error(adminErrorMessage(r, `创建分组失败（HTTP ${r.status}）`));
    return true;
  }

  /** 在分组里添加凭据。重复时 duplicate=true（服务里已有同一份凭据） */
  private async postCredential(
    accountId: string,
    cred: KiroCredentialEntry,
  ): Promise<{ id: number } | { duplicate: true }> {
    const r = await this.proxy.request('POST', '/credentials', { ...cred, groups: [accountId] });
    if (!r.ok) {
      const msg = adminErrorMessage(r, `添加凭据失败（HTTP ${r.status}）`);
      if (/已存在/.test(msg)) return { duplicate: true };
      throw new Error(msg);
    }
    const id = asRecord(r.json).credentialId;
    if (!isId(id)) throw new Error('kiro.rs 服务返回的凭据 ID 无效');
    return { id };
  }

  /** 分组里已有的凭据 id（按 groups 包含账号 id 查） */
  private async findGroupCredential(accountId: string): Promise<number | null> {
    const r = await this.proxy.request('GET', '/credentials');
    if (!r.ok) return null;
    const list = asRecord(r.json).credentials;
    if (!Array.isArray(list)) return null;
    for (const c of list) {
      const o = asRecord(c);
      if (isId(o.id) && Array.isArray(o.groups) && o.groups.includes(accountId)) return o.id;
    }
    return null;
  }

  private async verifyBalance(id: number): Promise<AdminResponse> {
    return this.proxy.request('GET', `/credentials/${id}/balance`);
  }

  private async quiet(label: string, fn: () => Promise<AdminResponse>): Promise<void> {
    try {
      const r = await fn();
      if (!r.ok && r.status !== 404) this.log(`${label}失败（HTTP ${r.status}）`);
    } catch (e) {
      this.log(`${label}失败：${sanitizeKiroError(e)}`);
    }
  }

  /**
   * 添加账号：分组 → 凭据 → （apiKey 方式）余额验证 → 客户端 Key → 写 cosyee-api.json。
   * 任一步失败，按相反顺序回滚本次创建的 Key、凭据和分组。写入 cosyee-api.json 成功后不再检查取消。
   */
  async addAccount(p: AddAccountParams): Promise<KiroAccountMeta> {
    const created: Created = {
      group: null,
      credential: null,
      key: null,
    };
    try {
      p.signal?.throwIfAborted();
      if (await this.ensureGroup(p.accountId)) created.group = p.accountId;

      p.signal?.throwIfAborted();
      const added = await this.postCredential(p.accountId, p.cred);
      let credentialId: number;
      if ('duplicate' in added) {
        const existing = p.reuseExisting ? await this.findGroupCredential(p.accountId) : null;
        if (existing === null) throw new Error('该凭据已在 kiro.rs 服务中存在（可能属于另一个账号）');
        credentialId = existing;
      } else {
        credentialId = added.id;
        created.credential = credentialId;
      }

      p.signal?.throwIfAborted();
      const bal = await this.verifyBalance(credentialId);
      if (!bal.ok && p.method === 'apiKey' && p.verifyApiKey !== false) {
        throw new Error(adminErrorMessage(bal, `Kiro API Key 验证失败（HTTP ${bal.status}）`));
      }
      if (!bal.ok) this.log(`查询新凭据额度失败（HTTP ${bal.status}），已忽略`);

      p.signal?.throwIfAborted();
      const kr = await this.proxy.request('POST', '/client-keys', { name: `cosyee ${p.accountId}`, group: p.accountId });
      const kj = asRecord(kr.json);
      if (!kr.ok) throw new Error(adminErrorMessage(kr, `创建客户端 Key 失败（HTTP ${kr.status}）`));
      if (!isId(kj.id) || typeof kj.key !== 'string' || !kj.key) throw new Error('kiro.rs 服务返回的客户端 Key 无效');
      created.key = kj.id;

      const meta: KiroAccountMeta = { method: p.method, credentialId, keyId: kj.id };
      const prev = readApiConfig(p.dir);
      writeApiConfig(p.dir, {
        baseUrl: this.proxy.baseUrl(),
        apiKey: kj.key,
        authType: 'apiKey',
        kiro: meta,
        ...(prev?.models ? { models: prev.models } : {}),
      });
      return meta;
    } catch (e) {
      await this.rollback(created);
      throw e;
    }
  }

  /** 回滚：Key → 凭据 → 分组，只删本次创建的，尽力而为 */
  private async rollback(c: Created): Promise<void> {
    if (c.key !== null) await this.quiet('回滚客户端 Key', () => this.proxy.request('DELETE', `/client-keys/${c.key}`));
    if (c.credential !== null) await this.quiet('回滚凭据', () => this.proxy.request('DELETE', `/credentials/${c.credential}`));
    if (c.group !== null) {
      const name = encodeURIComponent(c.group);
      await this.quiet('回滚分组', () => this.proxy.request('DELETE', `/groups/${name}?force=true`));
    }
  }

  /**
   * 重新登录：在同一分组里加入新凭据，成功后删除旧凭据并更新 credentialId，客户端 Key 不变。
   * 新凭据失败时旧凭据原样保留；服务里已有同一份凭据（已存在）时视为成功、凭据不变。
   * 旧格式账号（还没迁移）重新登录等同于迁移：走添加流程再归档旧目录。
   */
  async relogin(p: ReloginParams): Promise<KiroAccountMeta> {
    const api = readApiConfig(p.dir);
    if (!api?.kiro) throw new HttpError(400, '不是 Kiro 账号');
    if (isLegacyKiro(api.kiro)) {
      const meta = await this.addAccount({ ...p, reuseExisting: true });
      this.archiveLegacy(p.dir);
      this.proxy.setAccountError(p.dir, null);
      return meta;
    }
    const old = api.kiro;
    p.signal?.throwIfAborted();
    await this.ensureGroup(p.accountId);

    p.signal?.throwIfAborted();
    const added = await this.postCredential(p.accountId, p.cred);
    if ('duplicate' in added) {
      if (old.method !== p.method) this.writeMeta(p.dir, { ...old, method: p.method });
      return { ...old, method: p.method };
    }

    if (p.method === 'apiKey') {
      let err: string | null = null;
      try {
        p.signal?.throwIfAborted();
        const bal = await this.verifyBalance(added.id);
        if (!bal.ok) err = adminErrorMessage(bal, `Kiro API Key 验证失败（HTTP ${bal.status}）`);
      } catch (e) {
        err = sanitizeKiroError(e);
      }
      if (err !== null) {
        await this.quiet('回滚凭据', () => this.proxy.request('DELETE', `/credentials/${added.id}`));
        throw new Error(err);
      }
    }

    const meta: KiroAccountMeta = { method: p.method, credentialId: added.id, keyId: old.keyId };
    this.writeMeta(p.dir, meta);
    if (old.credentialId !== added.id) {
      await this.quiet('删除旧凭据', () => this.proxy.request('DELETE', `/credentials/${old.credentialId}`));
    }
    return meta;
  }

  /** 只更新 cosyee-api.json 里的 kiro 元数据，其余字段保持不变 */
  private writeMeta(dir: string, meta: KiroAccountMeta): void {
    const api = readApiConfig(dir);
    if (api) writeApiConfig(dir, { ...api, kiro: meta });
  }

  /** 移除账号：删凭据、Key、分组（忽略 404）。旧格式账号在服务里什么都没有，直接跳过 */
  async removeAccount(accountId: string, dir: string): Promise<void> {
    const api = readApiConfig(dir);
    if (!api?.kiro || isLegacyKiro(api.kiro)) return;
    const meta = api.kiro;
    try {
      const ids = new Set<number>([meta.credentialId]);
      const listed = await this.proxy.request('GET', '/credentials');
      const list = listed.ok ? asRecord(listed.json).credentials : null;
      if (Array.isArray(list)) {
        for (const c of list) {
          const o = asRecord(c);
          if (isId(o.id) && Array.isArray(o.groups) && o.groups.includes(accountId)) ids.add(o.id);
        }
      }
      // 先删 Key 与凭据：删分组不会连带删除它们
      await this.quiet('删除客户端 Key', () => this.proxy.request('DELETE', `/client-keys/${meta.keyId}`));
      for (const id of ids) await this.quiet('删除凭据', () => this.proxy.request('DELETE', `/credentials/${id}`));
      await this.quiet('删除分组', () =>
        this.proxy.request('DELETE', `/groups/${encodeURIComponent(accountId)}?force=true`),
      );
    } catch (e) {
      this.log(`移除账号时无法清理 kiro.rs 服务里的数据：${sanitizeKiroError(e)}`);
    }
  }

  /** 查账号额度（按需启动服务） */
  async balance(dir: string): Promise<KiroBalance> {
    const api = readApiConfig(dir);
    if (!api?.kiro) throw new HttpError(400, '不是 Kiro 账号');
    if (isLegacyKiro(api.kiro)) throw new HttpError(409, '该账号正在迁移到内置 kiro.rs 服务，请稍后再试');
    const r = await this.proxy.request('GET', `/credentials/${api.kiro.credentialId}/balance`);
    if (r.status === 404) throw new HttpError(409, '服务里没有该账号对应的凭据，请重新登录');
    if (!r.ok) throw new HttpError(502, adminErrorMessage(r, `查询额度失败（HTTP ${r.status}）`));
    const j = asRecord(r.json);
    const next = typeof j.nextResetAt === 'number' && Number.isFinite(j.nextResetAt) && j.nextResetAt > 0
      ? Math.round(j.nextResetAt * 1000)
      : null;
    return {
      subscription: str(j.subscriptionTitle),
      used: typeof j.currentUsage === 'number' && Number.isFinite(j.currentUsage) ? j.currentUsage : 0,
      limit: typeof j.usageLimit === 'number' && Number.isFinite(j.usageLimit) ? j.usageLimit : 0,
      resetsAt: next,
    };
  }

  /**
   * 用账号自己的客户端 Key 拉模型列表并写回 cosyee-api.json.models。
   * 拉取失败保留旧映射；映射有变化时返回 true，并按 notify 通知账号重置。
   */
  async refreshModels(accountId: string, dir: string, notify = true): Promise<boolean> {
    const api = readApiConfig(dir);
    if (!api?.kiro || isLegacyKiro(api.kiro)) return false;
    try {
      await this.proxy.ready();
      const port = this.proxy.port();
      if (!port) return false;
      const map = buildKiroModelMap(await fetchKiroModels(port, api.apiKey, this.opts.fetch ?? this.proxy.fetchFn()));
      if (!map) return false;
      // 拉取期间 baseUrl 等字段可能变了，写之前重新读
      const cur = readApiConfig(dir);
      if (!cur?.kiro || JSON.stringify(cur.models ?? null) === JSON.stringify(map)) return false;
      writeApiConfig(dir, { ...cur, models: map });
      if (notify) this.opts.onModelsChanged?.(accountId);
      return true;
    } catch (e) {
      this.log(`刷新 Kiro 模型列表失败：${sanitizeKiroError(e)}`);
      return false;
    }
  }

  /** 把旧版 kiro/ 目录归档为 kiro.migrated/（已存在则加时间戳） */
  private archiveLegacy(dir: string): void {
    const from = path.join(dir, LEGACY_DIR);
    if (!fs.existsSync(from)) return;
    let to = path.join(dir, MIGRATED_DIR);
    if (fs.existsSync(to)) to = `${to}-${Date.now()}`;
    try {
      fs.renameSync(from, to);
    } catch (e) {
      this.log(`归档旧版 kiro 目录失败：${sanitizeKiroError(e)}`);
    }
  }

  /**
   * 迁移一个旧格式账号到内置服务。失败时不动账号文件，在 proxy 上记下「迁移失败：原因」，下次启动再试。
   * 返回 true 表示迁移成功。
   */
  async migrateAccount(accountId: string, dir: string): Promise<boolean> {
    const api = readApiConfig(dir);
    if (!api?.kiro || !isLegacyKiro(api.kiro)) return false;
    try {
      const file = path.join(dir, LEGACY_DIR, 'credentials.json');
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        throw new Error('无法读取旧版凭据文件');
      }
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      const item = asRecord(first);
      if (!Object.keys(item).length) throw new Error('旧版凭据文件里没有凭据');
      await this.addAccount({
        accountId,
        dir,
        method: api.kiro.method,
        cred: legacyToEntry(item),
        reuseExisting: true,
        verifyApiKey: false,
      });
      this.archiveLegacy(dir);
      this.proxy.setAccountError(dir, null);
      await this.refreshModels(accountId, dir);
      return true;
    } catch (e) {
      this.proxy.setAccountError(dir, `迁移失败：${sanitizeKiroError(e)}`);
      return false;
    }
  }

  /** 逐个迁移（互不影响）。返回成功数与失败数 */
  async migrateAll(accounts: Array<{ id: string; dir: string }>): Promise<{ migrated: number; failed: number }> {
    let migrated = 0;
    let failed = 0;
    for (const a of accounts) {
      const api = readApiConfig(a.dir);
      if (!api?.kiro || !isLegacyKiro(api.kiro)) continue;
      if (await this.migrateAccount(a.id, a.dir)) migrated++;
      else failed++;
    }
    return { migrated, failed };
  }
}
