// 2FA 本地 SQLite 存储（node:sqlite DatabaseSync）：所有写操作在 BEGIN IMMEDIATE 事务里执行，行级 version 乐观锁与软删除。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncInstance } from 'node:sqlite';
import { HttpError } from '../workspaces.js';

// 用 createRequire 加载 node:sqlite：兼容 Node 24、Vitest 2（Vite 5 未把 node:sqlite 列入内置表）以及 esbuild 打包
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import {
  normalizeAlgorithm,
  normalizeBase32Secret,
  normalizeDigits,
  normalizePeriod,
  type ParsedImportEntry,
} from './totp.js';
import {
  TWOFA_TAG_COLORS,
  TwoFaConflictError,
  type SnapshotEntry,
  type SnapshotGroup,
  type SnapshotTag,
  type TwoFaAlgorithm,
  type TwoFaEntry,
  type TwoFaGroup,
  type TwoFaSnapshot,
  type TwoFaSyncStateRow,
  type TwoFaTag,
  type TwoFaTagColor,
  type TwoFaUsage,
} from './types.js';

interface EntryRow {
  id: string;
  issuer: string;
  account: string;
  secret: string;
  algorithm: string;
  digits: number;
  period: number;
  group_id: string | null;
  pinned: number;
  tags: string;
  note: string | null;
  sort: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface GroupRow {
  id: string;
  parent_id: string | null;
  name: string;
  sort: number;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface TagRow {
  id: string;
  name: string;
  color: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

interface UsageRow {
  entry_id: string;
  count: number;
  last_used_at: string | null;
}

interface SyncRow {
  repo: string | null;
  key_repo: string | null;
  gh_login: string | null;
  remote_sha: string | null;
  last_sync_at: string | null;
  last_error: string | null;
}

function parseTagsJson(raw: string): string[] {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToEntry(r: EntryRow): TwoFaEntry {
  return {
    id: r.id,
    issuer: r.issuer,
    account: r.account,
    secret: r.secret,
    algorithm: (r.algorithm === 'SHA256' || r.algorithm === 'SHA512' ? r.algorithm : 'SHA1') as TwoFaAlgorithm,
    digits: r.digits === 8 ? 8 : 6,
    period: r.period > 0 ? r.period : 30,
    groupId: r.group_id,
    pinned: r.pinned === 1,
    tags: parseTagsJson(r.tags),
    ...(r.note ? { note: r.note } : {}),
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

function rowToSnapshotEntry(r: EntryRow): SnapshotEntry {
  return { ...rowToEntry(r), deletedAt: r.deleted_at };
}

function rowToGroup(r: GroupRow): TwoFaGroup {
  return {
    id: r.id,
    parentId: r.parent_id,
    name: r.name,
    sort: r.sort,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

function rowToSnapshotGroup(r: GroupRow): SnapshotGroup {
  return { ...rowToGroup(r), deletedAt: r.deleted_at };
}

function rowToTag(r: TagRow): TwoFaTag {
  const color = (TWOFA_TAG_COLORS as readonly string[]).includes(r.color)
    ? (r.color as TwoFaTagColor)
    : 'slate';
  return {
    id: r.id,
    name: r.name,
    color,
    updatedAt: r.updated_at,
    version: r.version,
  };
}

function rowToSnapshotTag(r: TagRow): SnapshotTag {
  return { ...rowToTag(r), deletedAt: r.deleted_at };
}

function parseVersion(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, '缺少或非法的 version');
  return n;
}

function parseTagColor(raw: unknown): TwoFaTagColor {
  if (raw === undefined || raw === null || raw === '') return 'slate';
  if (typeof raw === 'string' && (TWOFA_TAG_COLORS as readonly string[]).includes(raw)) {
    return raw as TwoFaTagColor;
  }
  throw new HttpError(400, `不支持的标签颜色：${String(raw)}`);
}

function parseRequiredString(raw: unknown, label: string, maxLen: number): string {
  if (typeof raw !== 'string') throw new HttpError(400, `缺少 ${label}`);
  const s = raw.trim();
  if (!s) throw new HttpError(400, `${label} 不能为空`);
  if (s.length > maxLen) throw new HttpError(400, `${label} 不能超过 ${maxLen} 个字符`);
  return s;
}

function parseOptionalString(raw: unknown, label: string, maxLen: number): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') throw new HttpError(400, `${label} 必须是字符串`);
  const s = raw.trim();
  if (s.length > maxLen) throw new HttpError(400, `${label} 不能超过 ${maxLen} 个字符`);
  return s;
}

/** 条目手动排序的默认步长 */
const ENTRY_SORT_STEP = 1024;

/** 导入去重键：同 secret + issuer + account 视为重复（正式导入与预览共用） */
function dedupKey(e: { secret: string; issuer: string; account: string }): string {
  return `${e.secret}\0${e.issuer}\0${e.account}`;
}

export class TwoFaDb {
  private readonly db: DatabaseSyncInstance;
  private closed = false;

  constructor(
    dbPath: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(dir, 0o700);
      } catch {
        // 忽略权限设置失败
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.initSchema();
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        issuer TEXT NOT NULL,
        account TEXT NOT NULL DEFAULT '',
        secret TEXT NOT NULL,
        algorithm TEXT NOT NULL DEFAULT 'SHA1',
        digits INTEGER NOT NULL DEFAULT 6,
        period INTEGER NOT NULL DEFAULT 30,
        group_id TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        note TEXT,
        sort REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        name TEXT NOT NULL,
        sort INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT 'slate',
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS usage (
        entry_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        repo TEXT,
        key_repo TEXT,
        gh_login TEXT,
        remote_sha TEXT,
        last_sync_at TEXT,
        last_error TEXT
      );

      INSERT OR IGNORE INTO sync_state (id) VALUES (1);
    `);
    this.migrateEntrySort();
  }

  /** 旧库迁移：entries 没有 sort 列时补列，并按 createdAt 升序（同时刻按 id）赋值 index*1024；已有列则什么都不做（幂等） */
  private migrateEntrySort(): void {
    const cols = this.db.prepare('PRAGMA table_info(entries)').all() as unknown as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'sort')) return;
    this.tx(() => {
      this.db.exec('ALTER TABLE entries ADD COLUMN sort REAL NOT NULL DEFAULT 0');
      const rows = this.db.prepare('SELECT id FROM entries ORDER BY created_at ASC, id ASC').all() as unknown as Array<{ id: string }>;
      const upd = this.db.prepare('UPDATE entries SET sort = ? WHERE id = ?');
      rows.forEach((r, i) => upd.run(i * ENTRY_SORT_STEP, r.id));
    });
  }

  /** 所有条目（含已删除 tombstone）中最大的 sort 再加一个步长；空库返回 0 */
  private nextEntrySort(): number {
    const row = this.db.prepare('SELECT MAX(sort) AS m FROM entries').get() as unknown as { m: number | null };
    return row.m === null || row.m === undefined ? 0 : row.m + ENTRY_SORT_STEP;
  }

  /** 在 BEGIN IMMEDIATE 事务内执行写操作 */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = fn();
      this.db.exec('COMMIT');
      return res;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 忽略回滚失败
      }
      throw e;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // ───────────── 读取 ─────────────

  listEntries(): TwoFaEntry[] {
    const rows = this.db.prepare('SELECT * FROM entries WHERE deleted_at IS NULL ORDER BY sort ASC, created_at ASC, id ASC').all() as unknown as EntryRow[];
    return rows.map(rowToEntry);
  }

  getEntry(id: string): TwoFaEntry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as EntryRow | undefined;
    return row ? rowToEntry(row) : null;
  }

  listGroups(): TwoFaGroup[] {
    const rows = this.db.prepare('SELECT * FROM groups WHERE deleted_at IS NULL ORDER BY sort ASC, name ASC').all() as unknown as GroupRow[];
    return rows.map(rowToGroup);
  }

  listTags(): TwoFaTag[] {
    const rows = this.db.prepare('SELECT * FROM tags WHERE deleted_at IS NULL ORDER BY name ASC').all() as unknown as TagRow[];
    return rows.map(rowToTag);
  }

  getUsageMap(): Record<string, TwoFaUsage> {
    const rows = this.db.prepare('SELECT entry_id, count, last_used_at FROM usage').all() as unknown as UsageRow[];
    const out: Record<string, TwoFaUsage> = {};
    for (const r of rows) {
      out[r.entry_id] = { count: r.count, lastUsedAt: r.last_used_at };
    }
    return out;
  }

  getSyncState(): TwoFaSyncStateRow {
    const row = this.db
      .prepare('SELECT repo, key_repo, gh_login, remote_sha, last_sync_at, last_error FROM sync_state WHERE id = 1')
      .get() as unknown as SyncRow | undefined;
    return {
      repo: row?.repo ?? null,
      keyRepo: row?.key_repo ?? null,
      ghLogin: row?.gh_login ?? null,
      remoteSha: row?.remote_sha ?? null,
      lastSyncAt: row?.last_sync_at ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  updateSyncState(patch: Partial<TwoFaSyncStateRow>): TwoFaSyncStateRow {
    return this.tx(() => {
      const cur = this.getSyncState();
      const next: TwoFaSyncStateRow = {
        repo: patch.repo !== undefined ? patch.repo : cur.repo,
        keyRepo: patch.keyRepo !== undefined ? patch.keyRepo : cur.keyRepo,
        ghLogin: patch.ghLogin !== undefined ? patch.ghLogin : cur.ghLogin,
        remoteSha: patch.remoteSha !== undefined ? patch.remoteSha : cur.remoteSha,
        lastSyncAt: patch.lastSyncAt !== undefined ? patch.lastSyncAt : cur.lastSyncAt,
        lastError: patch.lastError !== undefined ? patch.lastError : cur.lastError,
      };
      this.db
        .prepare(
          'UPDATE sync_state SET repo = ?, key_repo = ?, gh_login = ?, remote_sha = ?, last_sync_at = ?, last_error = ? WHERE id = 1',
        )
        .run(next.repo, next.keyRepo, next.ghLogin, next.remoteSha, next.lastSyncAt, next.lastError);
      return next;
    });
  }

  hasAnyData(): boolean {
    const e = this.db.prepare('SELECT 1 FROM entries LIMIT 1').get();
    if (e) return true;
    const g = this.db.prepare('SELECT 1 FROM groups LIMIT 1').get();
    if (g) return true;
    const t = this.db.prepare('SELECT 1 FROM tags LIMIT 1').get();
    return Boolean(t);
  }

  // ───────────── 校验辅助（事务内调用） ─────────────

  private assertGroupExists(groupId: string): void {
    const row = this.db.prepare('SELECT id FROM groups WHERE id = ? AND deleted_at IS NULL').get(groupId);
    if (!row) throw new HttpError(400, '指定的分组不存在');
  }

  private validateTagsInput(raw: unknown): string[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new HttpError(400, 'tags 必须是数组');
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
      if (typeof item !== 'string' || !item.trim()) throw new HttpError(400, '标签 id 不合法');
      if (seen.has(item)) continue;
      seen.add(item);
      const exists = this.db.prepare('SELECT id FROM tags WHERE id = ? AND deleted_at IS NULL').get(item);
      if (!exists) throw new HttpError(400, `标签不存在：${item}`);
      unique.push(item);
    }
    return unique;
  }

  // ───────────── 条目 CRUD ─────────────

  createEntry(input: Record<string, unknown>): TwoFaEntry {
    const issuer = parseRequiredString(input.issuer, 'issuer', 200);
    const account = parseOptionalString(input.account, 'account', 200);
    const secret = normalizeBase32Secret(input.secret);
    const algorithm = normalizeAlgorithm(input.algorithm);
    const digits = normalizeDigits(input.digits);
    const period = normalizePeriod(input.period);
    const pinned = input.pinned === true;
    const noteStr = parseOptionalString(input.note, 'note', 1000);
    const note = noteStr ? noteStr : null;

    let groupId: string | null = null;
    if (input.groupId !== undefined && input.groupId !== null && input.groupId !== '') {
      if (typeof input.groupId !== 'string') throw new HttpError(400, 'groupId 不合法');
      groupId = input.groupId;
    }

    return this.tx(() => {
      if (groupId !== null) this.assertGroupExists(groupId);
      const tags = this.validateTagsInput(input.tags);
      const id = crypto.randomUUID();
      const now = this.nowIso();
      const sort = this.nextEntrySort();
      this.db
        .prepare(
          `INSERT INTO entries (id, issuer, account, secret, algorithm, digits, period, group_id, pinned, tags, note, sort, created_at, updated_at, deleted_at, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
        )
        .run(id, issuer, account, secret, algorithm, digits, period, groupId, pinned ? 1 : 0, JSON.stringify(tags), note, sort, now, now);

      const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as unknown as EntryRow;
      return rowToEntry(row);
    });
  }

  updateEntry(id: string, input: Record<string, unknown>): TwoFaEntry {
    const version = parseVersion(input.version);
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as EntryRow | undefined;
      if (!existing) throw new HttpError(404, '条目不存在');
      if (existing.version !== version) throw new TwoFaConflictError(rowToEntry(existing));

      const issuer = input.issuer !== undefined ? parseRequiredString(input.issuer, 'issuer', 200) : existing.issuer;
      const account = input.account !== undefined ? parseOptionalString(input.account, 'account', 200) : existing.account;
      const secret = input.secret !== undefined ? normalizeBase32Secret(input.secret) : existing.secret;
      const algorithm = input.algorithm !== undefined ? normalizeAlgorithm(input.algorithm) : existing.algorithm;
      const digits = input.digits !== undefined ? normalizeDigits(input.digits) : existing.digits;
      const period = input.period !== undefined ? normalizePeriod(input.period) : existing.period;
      const pinned = input.pinned !== undefined ? (input.pinned === true ? 1 : 0) : existing.pinned;

      let groupId = existing.group_id;
      if (input.groupId !== undefined) {
        if (input.groupId === null || input.groupId === '') {
          groupId = null;
        } else if (typeof input.groupId === 'string') {
          this.assertGroupExists(input.groupId);
          groupId = input.groupId;
        } else {
          throw new HttpError(400, 'groupId 不合法');
        }
      }

      const tagsJson = input.tags !== undefined ? JSON.stringify(this.validateTagsInput(input.tags)) : existing.tags;

      let note = existing.note;
      if (input.note !== undefined) {
        const s = parseOptionalString(input.note, 'note', 1000);
        note = s ? s : null;
      }

      let sort = existing.sort;
      if (input.sort !== undefined) {
        if (typeof input.sort !== 'number' || !Number.isFinite(input.sort)) throw new HttpError(400, 'sort 必须是有限数字');
        sort = input.sort;
      }

      const now = this.nowIso();
      const nextVersion = existing.version + 1;
      this.db
        .prepare(
          `UPDATE entries
           SET issuer = ?, account = ?, secret = ?, algorithm = ?, digits = ?, period = ?,
               group_id = ?, pinned = ?, tags = ?, note = ?, sort = ?, updated_at = ?, version = ?
           WHERE id = ?`,
        )
        .run(issuer, account, secret, algorithm, digits, period, groupId, pinned, tagsJson, note, sort, now, nextVersion, id);

      const updated = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as unknown as EntryRow;
      return rowToEntry(updated);
    });
  }

  deleteEntry(id: string, rawVersion: unknown): void {
    const version = parseVersion(rawVersion);
    this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM entries WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as EntryRow | undefined;
      if (!existing) throw new HttpError(404, '条目不存在');
      if (existing.version !== version) throw new TwoFaConflictError(rowToEntry(existing));

      const now = this.nowIso();
      this.db
        .prepare('UPDATE entries SET deleted_at = ?, updated_at = ?, version = ? WHERE id = ?')
        .run(now, now, existing.version + 1, id);
    });
  }

  // ───────────── 分组 CRUD ─────────────

  createGroup(input: Record<string, unknown>): TwoFaGroup {
    const name = parseRequiredString(input.name, 'name', 100);
    let parentId: string | null = null;
    if (input.parentId !== undefined && input.parentId !== null && input.parentId !== '') {
      if (typeof input.parentId !== 'string') throw new HttpError(400, 'parentId 不合法');
      parentId = input.parentId;
    }

    return this.tx(() => {
      if (parentId !== null) this.assertGroupExists(parentId);
      let sort: number;
      if (input.sort !== undefined && input.sort !== null) {
        if (typeof input.sort !== 'number' || !Number.isSafeInteger(input.sort)) throw new HttpError(400, 'sort 必须是整数');
        sort = input.sort;
      } else {
        const row = (parentId === null
          ? this.db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM groups WHERE parent_id IS NULL AND deleted_at IS NULL').get()
          : this.db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM groups WHERE parent_id = ? AND deleted_at IS NULL').get(parentId)) as { m: number };
        sort = row.m + 1;
      }

      const id = crypto.randomUUID();
      const now = this.nowIso();
      this.db
        .prepare('INSERT INTO groups (id, parent_id, name, sort, updated_at, deleted_at, version) VALUES (?, ?, ?, ?, ?, NULL, 1)')
        .run(id, parentId, name, sort, now);

      const created = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as unknown as GroupRow;
      return rowToGroup(created);
    });
  }

  updateGroup(id: string, input: Record<string, unknown>): TwoFaGroup {
    const version = parseVersion(input.version);
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as GroupRow | undefined;
      if (!existing) throw new HttpError(404, '分组不存在');
      if (existing.version !== version) throw new TwoFaConflictError(rowToGroup(existing));

      const name = input.name !== undefined ? parseRequiredString(input.name, 'name', 100) : existing.name;
      let sort = existing.sort;
      if (input.sort !== undefined) {
        if (typeof input.sort !== 'number' || !Number.isSafeInteger(input.sort)) throw new HttpError(400, 'sort 必须是整数');
        sort = input.sort;
      }

      let parentId = existing.parent_id;
      if (input.parentId !== undefined) {
        if (input.parentId === null || input.parentId === '') {
          parentId = null;
        } else if (typeof input.parentId === 'string') {
          if (input.parentId === id) throw new HttpError(400, '不能将分组移动到自身下面');
          this.assertGroupExists(input.parentId);
          // 向上追溯祖先链，防止形成循环引用
          let cursor: string | null = input.parentId;
          const visited = new Set<string>();
          while (cursor) {
            if (cursor === id) throw new HttpError(400, '不能将分组移动到其子分组下面');
            if (visited.has(cursor)) break;
            visited.add(cursor);
            const p = this.db.prepare('SELECT parent_id FROM groups WHERE id = ? AND deleted_at IS NULL').get(cursor) as { parent_id: string | null } | undefined;
            cursor = p?.parent_id ?? null;
          }
          parentId = input.parentId;
        } else {
          throw new HttpError(400, 'parentId 不合法');
        }
      }

      const now = this.nowIso();
      this.db
        .prepare('UPDATE groups SET parent_id = ?, name = ?, sort = ?, updated_at = ?, version = ? WHERE id = ?')
        .run(parentId, name, sort, now, existing.version + 1, id);

      const updated = this.db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as unknown as GroupRow;
      return rowToGroup(updated);
    });
  }

  deleteGroup(id: string, mode: unknown, rawVersion: unknown): void {
    if (mode !== 'all' && mode !== 'lift') throw new HttpError(400, 'mode 必须是 all 或 lift');
    const version = parseVersion(rawVersion);

    this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM groups WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as GroupRow | undefined;
      if (!existing) throw new HttpError(404, '分组不存在');
      if (existing.version !== version) throw new TwoFaConflictError(rowToGroup(existing));

      const now = this.nowIso();

      if (mode === 'lift') {
        // 只软删除当前分组，把直接子分组与直接条目提升到上级分组
        this.db
          .prepare('UPDATE groups SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ?')
          .run(now, now, id);
        this.db
          .prepare('UPDATE groups SET parent_id = ?, updated_at = ?, version = version + 1 WHERE parent_id = ? AND deleted_at IS NULL')
          .run(existing.parent_id, now, id);
        this.db
          .prepare('UPDATE entries SET group_id = ?, updated_at = ?, version = version + 1 WHERE group_id = ? AND deleted_at IS NULL')
          .run(existing.parent_id, now, id);
        return;
      }

      // mode === 'all'：收集当前分组与所有后代分组，连同里面的条目一并软删除
      const allLiveGroups = this.db.prepare('SELECT id, parent_id FROM groups WHERE deleted_at IS NULL').all() as unknown as Array<{ id: string; parent_id: string | null }>;
      const childrenByParent = new Map<string, string[]>();
      for (const g of allLiveGroups) {
        if (g.parent_id) {
          const arr = childrenByParent.get(g.parent_id);
          if (arr) arr.push(g.id);
          else childrenByParent.set(g.parent_id, [g.id]);
        }
      }
      const targetIds = new Set<string>([id]);
      const queue = [id];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const childId of childrenByParent.get(cur) ?? []) {
          if (!targetIds.has(childId)) {
            targetIds.add(childId);
            queue.push(childId);
          }
        }
      }

      const delGroupStmt = this.db.prepare('UPDATE groups SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL');
      const delEntryStmt = this.db.prepare('UPDATE entries SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE group_id = ? AND deleted_at IS NULL');
      for (const gid of targetIds) {
        delGroupStmt.run(now, now, gid);
        delEntryStmt.run(now, now, gid);
      }
    });
  }

  // ───────────── 标签 CRUD ─────────────

  createTag(input: Record<string, unknown>): TwoFaTag {
    const name = parseRequiredString(input.name, 'name', 50);
    const color = parseTagColor(input.color);

    return this.tx(() => {
      const dup = this.db.prepare('SELECT id FROM tags WHERE LOWER(name) = LOWER(?) AND deleted_at IS NULL').get(name);
      if (dup) throw new HttpError(409, '同名标签已存在');

      const id = crypto.randomUUID();
      const now = this.nowIso();
      this.db
        .prepare('INSERT INTO tags (id, name, color, updated_at, deleted_at, version) VALUES (?, ?, ?, ?, NULL, 1)')
        .run(id, name, color, now);

      const created = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as unknown as TagRow;
      return rowToTag(created);
    });
  }

  updateTag(id: string, input: Record<string, unknown>): TwoFaTag {
    const version = parseVersion(input.version);
    return this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM tags WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as TagRow | undefined;
      if (!existing) throw new HttpError(404, '标签不存在');
      if (existing.version !== version) throw new TwoFaConflictError(rowToTag(existing));

      const name = input.name !== undefined ? parseRequiredString(input.name, 'name', 50) : existing.name;
      const color = input.color !== undefined ? parseTagColor(input.color) : existing.color;

      if (name.toLowerCase() !== existing.name.toLowerCase()) {
        const dup = this.db
          .prepare('SELECT id FROM tags WHERE id != ? AND LOWER(name) = LOWER(?) AND deleted_at IS NULL')
          .get(id, name);
        if (dup) throw new HttpError(409, '同名标签已存在');
      }

      const now = this.nowIso();
      this.db
        .prepare('UPDATE tags SET name = ?, color = ?, updated_at = ?, version = ? WHERE id = ?')
        .run(name, color, now, existing.version + 1, id);

      const updated = this.db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as unknown as TagRow;
      return rowToTag(updated);
    });
  }

  deleteTag(id: string, rawVersion: unknown): void {
    const version = parseVersion(rawVersion);
    this.tx(() => {
      const existing = this.db.prepare('SELECT * FROM tags WHERE id = ? AND deleted_at IS NULL').get(id) as unknown as TagRow | undefined;
      if (!existing) throw new HttpError(404, '标签不存在');
      if (existing.version !== version) throw new TwoFaConflictError(rowToTag(existing));

      const now = this.nowIso();
      this.db
        .prepare('UPDATE tags SET deleted_at = ?, updated_at = ?, version = ? WHERE id = ?')
        .run(now, now, existing.version + 1, id);

      // 级联从所有未删除条目的 tags 数组中移除该标签 id，并递增条目 version / updatedAt
      const entries = this.db.prepare('SELECT id, tags, version FROM entries WHERE deleted_at IS NULL').all() as unknown as Array<{ id: string; tags: string; version: number }>;
      const updStmt = this.db.prepare('UPDATE entries SET tags = ?, updated_at = ?, version = ? WHERE id = ?');
      for (const e of entries) {
        const list = parseTagsJson(e.tags);
        if (!list.includes(id)) continue;
        const filtered = list.filter((t) => t !== id);
        updStmt.run(JSON.stringify(filtered), now, e.version + 1, e.id);
      }
    });
  }

  // ───────────── 使用统计（仅本机，不同步） ─────────────

  bumpUsage(entryId: string): TwoFaUsage {
    return this.tx(() => {
      const exists = this.db.prepare('SELECT id FROM entries WHERE id = ? AND deleted_at IS NULL').get(entryId);
      if (!exists) throw new HttpError(404, '条目不存在');
      const now = this.nowIso();
      this.db
        .prepare(
          `INSERT INTO usage (entry_id, count, last_used_at) VALUES (?, 1, ?)
           ON CONFLICT(entry_id) DO UPDATE SET count = count + 1, last_used_at = excluded.last_used_at`,
        )
        .run(entryId, now);
      const row = this.db.prepare('SELECT count, last_used_at FROM usage WHERE entry_id = ?').get(entryId) as unknown as { count: number; last_used_at: string | null };
      return { count: row.count, lastUsedAt: row.last_used_at };
    });
  }

  // ───────────── 批量导入 ─────────────

  /** 导入预览：按与正式导入完全相同的去重规则标出重复项（含同一批内的重复），不含 secret */
  previewImport(parsedEntries: readonly ParsedImportEntry[]): Array<{ duplicate: boolean; duplicateOf?: string }> {
    const existing = this.db
      .prepare('SELECT id, secret, issuer, account FROM entries WHERE deleted_at IS NULL ORDER BY sort ASC, created_at ASC, id ASC')
      .all() as unknown as Array<{ id: string; secret: string; issuer: string; account: string }>;
    const seen = new Map<string, string | null>();
    for (const r of existing) {
      const k = dedupKey(r);
      if (!seen.has(k)) seen.set(k, r.id);
    }
    return parsedEntries.map((item) => {
      const k = dedupKey(item);
      if (seen.has(k)) {
        const of = seen.get(k);
        return of ? { duplicate: true, duplicateOf: of } : { duplicate: true };
      }
      seen.set(k, null); // 同一批内后出现的相同项算重复，但没有已有条目 id
      return { duplicate: false };
    });
  }

  importEntries(
    parsedEntries: readonly ParsedImportEntry[],
    opts: { groupId?: string | null; tags?: unknown; exclude?: ReadonlySet<number> } = {},
  ): { added: number; skipped: number } {
    return this.tx(() => {
      let groupId: string | null = null;
      if (opts.groupId !== undefined && opts.groupId !== null && opts.groupId !== '') {
        if (typeof opts.groupId !== 'string') throw new HttpError(400, 'groupId 不合法');
        this.assertGroupExists(opts.groupId);
        groupId = opts.groupId;
      }
      const tags = this.validateTagsInput(opts.tags);
      const tagsJson = JSON.stringify(tags);

      const existingRows = this.db
        .prepare('SELECT secret, issuer, account FROM entries WHERE deleted_at IS NULL')
        .all() as unknown as Array<{ secret: string; issuer: string; account: string }>;
      const seen = new Set<string>(existingRows.map(dedupKey));

      let added = 0;
      let skipped = 0;
      const now = this.nowIso();
      let sort = this.nextEntrySort();
      const insertStmt = this.db.prepare(
        `INSERT INTO entries (id, issuer, account, secret, algorithm, digits, period, group_id, pinned, tags, note, sort, created_at, updated_at, deleted_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, ?, ?, NULL, 1)`,
      );

      parsedEntries.forEach((item, index) => {
        // 预览里被取消勾选的条目：直接忽略，不占用去重名额，也不计入 skipped
        if (opts.exclude?.has(index)) return;
        const key = dedupKey(item);
        if (seen.has(key)) {
          skipped++;
          return;
        }
        seen.add(key);
        insertStmt.run(
          crypto.randomUUID(),
          item.issuer,
          item.account,
          item.secret,
          item.algorithm,
          item.digits,
          item.period,
          groupId,
          tagsJson,
          sort,
          now,
          now,
        );
        sort += ENTRY_SORT_STEP;
        added++;
      });

      return { added, skipped };
    });
  }

  // ───────────── 快照导出与写回（同步引擎用） ─────────────

  exportSnapshot(): TwoFaSnapshot {
    const entries = (this.db.prepare('SELECT * FROM entries ORDER BY id ASC').all() as unknown as EntryRow[]).map(rowToSnapshotEntry);
    const groups = (this.db.prepare('SELECT * FROM groups ORDER BY id ASC').all() as unknown as GroupRow[]).map(rowToSnapshotGroup);
    const tags = (this.db.prepare('SELECT * FROM tags ORDER BY id ASC').all() as unknown as TagRow[]).map(rowToSnapshotTag);
    return { schema: 2, entries, groups, tags };
  }

  applySnapshot(snapshot: TwoFaSnapshot): void {
    this.tx(() => {
      const upsertEntry = this.db.prepare(`
        INSERT INTO entries (id, issuer, account, secret, algorithm, digits, period, group_id, pinned, tags, note, sort, created_at, updated_at, deleted_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          issuer = excluded.issuer,
          account = excluded.account,
          secret = excluded.secret,
          algorithm = excluded.algorithm,
          digits = excluded.digits,
          period = excluded.period,
          group_id = excluded.group_id,
          pinned = excluded.pinned,
          tags = excluded.tags,
          note = excluded.note,
          sort = excluded.sort,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          version = excluded.version
      `);
      for (const e of snapshot.entries) {
        upsertEntry.run(
          e.id,
          e.issuer,
          e.account,
          e.secret,
          e.algorithm,
          e.digits,
          e.period,
          e.groupId,
          e.pinned ? 1 : 0,
          JSON.stringify(e.tags),
          e.note ?? null,
          Number.isFinite(e.sort) ? e.sort : 0,
          e.createdAt,
          e.updatedAt,
          e.deletedAt ?? null,
          e.version,
        );
      }

      const upsertGroup = this.db.prepare(`
        INSERT INTO groups (id, parent_id, name, sort, updated_at, deleted_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          parent_id = excluded.parent_id,
          name = excluded.name,
          sort = excluded.sort,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          version = excluded.version
      `);
      for (const g of snapshot.groups) {
        upsertGroup.run(g.id, g.parentId, g.name, g.sort, g.updatedAt, g.deletedAt ?? null, g.version);
      }

      const upsertTag = this.db.prepare(`
        INSERT INTO tags (id, name, color, updated_at, deleted_at, version)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          color = excluded.color,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          version = excluded.version
      `);
      for (const t of snapshot.tags) {
        upsertTag.run(t.id, t.name, t.color, t.updatedAt, t.deletedAt ?? null, t.version);
      }
    });
  }
}
