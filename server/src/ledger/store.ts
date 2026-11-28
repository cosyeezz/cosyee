// 订阅用量账本：SQLite 持久化存储（node:sqlite）。
// 设计原则：
// - 绝对不能影响正常请求：所有写入先入内存队列，定期（默认 2s）或满 200 条异步批量事务落盘；
// - 队列上限（默认 5000）溢出丢弃最旧条目，防止极端情况下内存膨胀；
// - 任何异常（建库失败、写库失败、查询失败）只在内部吞掉，自动停用账本并只打一次警告日志；
// - 保留 180 天数据，启动时和每天定时清理一次。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';
import type { LedgerAccountKind, LedgerBackend, LedgerLayer, LedgerWindowKind } from '@cosyee/shared';
import { cosyeeHome } from '../paths.js';
import type { LedgerRequest, LedgerSink, LedgerSnapshot } from './sink.js';

const require = createRequire(import.meta.url);
function loadSqlite(): { DatabaseSync: typeof DatabaseSync } {
  return require('node:sqlite') as { DatabaseSync: typeof DatabaseSync };
}

export const RETENTION_DAYS = 180;
export const RETENTION_MS = RETENTION_DAYS * 24 * 3600_000;
const DAY_MS = 24 * 3600_000;
const DEFAULT_FLUSH_INTERVAL_MS = 2000;
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_QUEUE = 5000;
/** 进程退出时尽力 flush 的时间预算（毫秒），避免拖慢退出 */
const EXIT_FLUSH_BUDGET_MS = 100;

type QueueItem =
  | { type: 'request'; data: LedgerRequest }
  | { type: 'snapshot'; data: LedgerSnapshot };

export interface LedgerStoreOptions {
  /** SQLite 文件路径，默认 ~/.cosyee/usage-ledger.sqlite；测试可传 ':memory:' */
  path?: string;
  now?: () => number;
  flushIntervalMs?: number;
  batchSize?: number;
  maxQueue?: number;
}

export interface SnapshotQuery {
  backend?: LedgerBackend;
  account?: string;
  kind?: LedgerWindowKind;
  /** 传 undefined 表示不过滤；传 null 表示只查 grp IS NULL；传字符串表示只查 grp = ? */
  group?: string | null;
  sinceAt?: number;
  untilAt?: number;
}

export interface RequestQuery {
  backend?: LedgerBackend;
  account?: string;
  sinceAt?: number;
  untilAt?: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS requests (
  backend TEXT NOT NULL,
  id TEXT NOT NULL,
  at INTEGER NOT NULL,
  account TEXT NOT NULL,
  account_kind TEXT NOT NULL,
  session TEXT,
  layer TEXT NOT NULL,
  agent TEXT,
  tool_use_id TEXT,
  model TEXT,
  effort TEXT,
  input INTEGER NOT NULL DEFAULT 0,
  create5m INTEGER NOT NULL DEFAULT 0,
  create1h INTEGER NOT NULL DEFAULT 0,
  read INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  reasoning INTEGER NOT NULL DEFAULT 0,
  fast INTEGER NOT NULL DEFAULT 0,
  us_geo INTEGER NOT NULL DEFAULT 0,
  estimated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (backend, id)
);
CREATE INDEX IF NOT EXISTS idx_requests_lookup ON requests (backend, account, at);
CREATE INDEX IF NOT EXISTS idx_requests_at ON requests (at);

CREATE TABLE IF NOT EXISTS snapshots (
  backend TEXT NOT NULL,
  account TEXT NOT NULL,
  account_kind TEXT NOT NULL,
  kind TEXT NOT NULL,
  grp TEXT,
  at INTEGER NOT NULL,
  percent REAL NOT NULL,
  resets_at INTEGER,
  window_ms INTEGER,
  source TEXT NOT NULL,
  used REAL,
  "limit" REAL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_lookup ON snapshots (backend, account, kind, grp, at);
CREATE INDEX IF NOT EXISTS idx_snapshots_at ON snapshots (at);
`;

const UPSERT_REQUEST_SQL = `
INSERT INTO requests (
  backend, id, at, account, account_kind, session, layer, agent, tool_use_id,
  model, effort, input, create5m, create1h, read, output, reasoning, fast, us_geo, estimated
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(backend, id) DO UPDATE SET
  account = COALESCE(NULLIF(excluded.account, ''), requests.account),
  account_kind = COALESCE(NULLIF(excluded.account_kind, ''), requests.account_kind),
  session = COALESCE(excluded.session, requests.session),
  layer = COALESCE(NULLIF(excluded.layer, ''), requests.layer),
  agent = COALESCE(excluded.agent, requests.agent),
  tool_use_id = COALESCE(excluded.tool_use_id, requests.tool_use_id),
  model = COALESCE(excluded.model, requests.model),
  effort = COALESCE(excluded.effort, requests.effort),
  input = MAX(requests.input, excluded.input),
  create5m = MAX(requests.create5m, excluded.create5m),
  create1h = MAX(requests.create1h, excluded.create1h),
  read = MAX(requests.read, excluded.read),
  output = MAX(requests.output, excluded.output),
  reasoning = MAX(requests.reasoning, excluded.reasoning),
  fast = excluded.fast,
  us_geo = excluded.us_geo,
  estimated = excluded.estimated
`;

const INSERT_SNAPSHOT_SQL = `
INSERT INTO snapshots (
  backend, account, account_kind, kind, grp, at, percent, resets_at, window_ms, source, used, "limit"
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

export function defaultLedgerPath(): string {
  return path.join(cosyeeHome(), 'usage-ledger.sqlite');
}

function nonNegInt(n: number): number {
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

export class LedgerStore implements LedgerSink {
  private readonly now: () => number;
  private readonly batchSize: number;
  private readonly maxQueue: number;
  private db: DatabaseSync | null = null;
  private upsertReqStmt: StatementSync | null = null;
  private insertSnapStmt: StatementSync | null = null;
  private queue: QueueItem[] = [];
  private _enabled = false;
  private warned = false;
  private closed = false;
  private flushTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private immediateScheduled = false;
  private readonly onProcessExit: () => void;

  constructor(opts: LedgerStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);
    this.maxQueue = Math.max(1, opts.maxQueue ?? DEFAULT_MAX_QUEUE);
    const flushIntervalMs = Math.max(10, opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    const dbPath = opts.path ?? defaultLedgerPath();

    this.onProcessExit = () => {
      this.flush(EXIT_FLUSH_BUDGET_MS);
    };

    try {
      if (dbPath !== ':memory:') {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      }
      const { DatabaseSync: SqliteDatabaseSync } = loadSqlite();
      const db = new SqliteDatabaseSync(dbPath);
      if (dbPath !== ':memory:') {
        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;');
      }
      db.exec(SCHEMA_SQL);
      this.db = db;
      this.upsertReqStmt = db.prepare(UPSERT_REQUEST_SQL);
      this.insertSnapStmt = db.prepare(INSERT_SNAPSHOT_SQL);
      this._enabled = true;

      this.prune();

      this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
      this.flushTimer.unref();

      this.pruneTimer = setInterval(() => this.prune(), DAY_MS);
      this.pruneTimer.unref();

      process.once('exit', this.onProcessExit);
    } catch (e) {
      this.disable('初始化数据库失败', e);
    }
  }

  enabled(): boolean {
    return this._enabled && !this.closed;
  }

  record(r: LedgerRequest): void {
    if (!this.enabled()) return;
    this.enqueue({ type: 'request', data: { ...r } });
  }

  snapshot(s: LedgerSnapshot): void {
    if (!this.enabled()) return;
    this.enqueue({ type: 'snapshot', data: { ...s } });
  }

  private enqueue(item: QueueItem): void {
    if (this.queue.length >= this.maxQueue) {
      // 队列溢出时丢弃最旧条目，保最新数据且不阻塞主请求
      const drop = this.queue.length - this.maxQueue + 1;
      this.queue.splice(0, drop);
    }
    this.queue.push(item);
    if (this.queue.length >= this.batchSize && !this.immediateScheduled) {
      this.immediateScheduled = true;
      setImmediate(() => {
        this.immediateScheduled = false;
        this.flush();
      });
    }
  }

  /** 将内存队列批量事务落盘；可选 budgetMs 限制退出时的耗时 */
  flush(budgetMs?: number): void {
    if (!this.enabled() || this.queue.length === 0) return;
    const db = this.db;
    const upsertReq = this.upsertReqStmt;
    const insertSnap = this.insertSnapStmt;
    if (!db || !upsertReq || !insertSnap) return;

    const deadline = budgetMs !== undefined ? Date.now() + budgetMs : Infinity;
    while (this.queue.length > 0 && this.enabled()) {
      const batch = this.queue.splice(0, this.batchSize);
      let inTx = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        inTx = true;
        for (const item of batch) {
          if (item.type === 'request') {
            const r = item.data;
            upsertReq.run(
              r.backend,
              r.id,
              Math.trunc(r.at),
              r.account,
              r.accountKind,
              r.session ?? null,
              r.layer,
              r.agent ?? null,
              r.toolUseId ?? null,
              r.model ?? null,
              r.effort ?? null,
              nonNegInt(r.input),
              nonNegInt(r.create5m),
              nonNegInt(r.create1h),
              nonNegInt(r.read),
              nonNegInt(r.output),
              nonNegInt(r.reasoning),
              r.fast ? 1 : 0,
              r.usGeo ? 1 : 0,
              r.estimated ? 1 : 0,
            );
          } else {
            const s = item.data;
            insertSnap.run(
              s.backend,
              s.account,
              s.accountKind,
              s.kind,
              s.group ?? null,
              Math.trunc(s.at),
              Number.isFinite(s.percent) ? s.percent : 0,
              s.resetsAt !== null && Number.isFinite(s.resetsAt) ? Math.trunc(s.resetsAt) : null,
              s.windowMs !== null && Number.isFinite(s.windowMs) ? Math.trunc(s.windowMs) : null,
              s.source,
              s.used !== undefined && s.used !== null && Number.isFinite(s.used) ? s.used : null,
              s.limit !== undefined && s.limit !== null && Number.isFinite(s.limit) ? s.limit : null,
            );
          }
        }
        db.exec('COMMIT');
        inTx = false;
      } catch (e) {
        if (inTx) {
          try {
            db.exec('ROLLBACK');
          } catch { /* 忽略回滚失败 */ }
        }
        this.disable('批量写入失败', e);
        return;
      }
      if (Date.now() >= deadline) break;
    }
  }

  /** 清理超过 180 天的历史记录 */
  prune(): void {
    if (!this.enabled() || !this.db) return;
    const cutoff = Math.trunc(this.now() - RETENTION_MS);
    try {
      this.db.prepare('DELETE FROM requests WHERE at < ?').run(cutoff);
      this.db.prepare('DELETE FROM snapshots WHERE at < ?').run(cutoff);
    } catch (e) {
      this.disable('清理过期数据失败', e);
    }
  }

  querySnapshots(q: SnapshotQuery = {}): LedgerSnapshot[] {
    if (!this.enabled()) return [];
    this.flush();
    if (!this.enabled() || !this.db) return [];

    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.backend !== undefined) {
      where.push('backend = ?');
      params.push(q.backend);
    }
    if (q.account !== undefined) {
      where.push('account = ?');
      params.push(q.account);
    }
    if (q.kind !== undefined) {
      where.push('kind = ?');
      params.push(q.kind);
    }
    if (q.group !== undefined) {
      if (q.group === null) {
        where.push('grp IS NULL');
      } else {
        where.push('grp = ?');
        params.push(q.group);
      }
    }
    if (q.sinceAt !== undefined) {
      where.push('at >= ?');
      params.push(Math.trunc(q.sinceAt));
    }
    if (q.untilAt !== undefined) {
      where.push('at <= ?');
      params.push(Math.trunc(q.untilAt));
    }

    const sql =
      `SELECT backend, account, account_kind, kind, grp, at, percent, resets_at, window_ms, source, used, "limit" FROM snapshots` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY at ASC`;

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        backend: row.backend as LedgerBackend,
        account: String(row.account),
        accountKind: row.account_kind as LedgerAccountKind,
        kind: row.kind as LedgerWindowKind,
        group: row.grp === null || row.grp === undefined ? null : String(row.grp),
        at: Number(row.at),
        percent: Number(row.percent),
        resetsAt: row.resets_at === null || row.resets_at === undefined ? null : Number(row.resets_at),
        windowMs: row.window_ms === null || row.window_ms === undefined ? null : Number(row.window_ms),
        source: row.source === 'event' ? 'event' : 'probe',
        used: row.used === null || row.used === undefined ? null : Number(row.used),
        limit: row.limit === null || row.limit === undefined ? null : Number(row.limit),
      }));
    } catch (e) {
      this.disable('查询快照失败', e);
      return [];
    }
  }

  queryRequests(q: RequestQuery = {}): LedgerRequest[] {
    if (!this.enabled()) return [];
    this.flush();
    if (!this.enabled() || !this.db) return [];

    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (q.backend !== undefined) {
      where.push('backend = ?');
      params.push(q.backend);
    }
    if (q.account !== undefined) {
      where.push('account = ?');
      params.push(q.account);
    }
    if (q.sinceAt !== undefined) {
      where.push('at >= ?');
      params.push(Math.trunc(q.sinceAt));
    }
    if (q.untilAt !== undefined) {
      where.push('at <= ?');
      params.push(Math.trunc(q.untilAt));
    }

    const sql =
      `SELECT backend, id, at, account, account_kind, session, layer, agent, tool_use_id, model, effort, ` +
      `input, create5m, create1h, read, output, reasoning, fast, us_geo, estimated FROM requests` +
      (where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY at ASC`;

    try {
      const rows = this.db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        backend: row.backend as LedgerBackend,
        id: String(row.id),
        at: Number(row.at),
        account: String(row.account),
        accountKind: row.account_kind as LedgerAccountKind,
        session: row.session === null || row.session === undefined ? null : String(row.session),
        layer: row.layer as LedgerLayer,
        agent: row.agent === null || row.agent === undefined ? null : String(row.agent),
        toolUseId: row.tool_use_id === null || row.tool_use_id === undefined ? null : String(row.tool_use_id),
        model: row.model === null || row.model === undefined ? null : String(row.model),
        effort: row.effort === null || row.effort === undefined ? null : String(row.effort),
        input: Number(row.input),
        create5m: Number(row.create5m),
        create1h: Number(row.create1h),
        read: Number(row.read),
        output: Number(row.output),
        reasoning: Number(row.reasoning),
        fast: Number(row.fast) !== 0,
        usGeo: Number(row.us_geo) !== 0,
        estimated: Number(row.estimated) !== 0,
      }));
    } catch (e) {
      this.disable('查询请求失败', e);
      return [];
    }
  }

  close(): void {
    if (this.closed) return;
    this.flush();
    this.closed = true;
    this._enabled = false;
    this.cleanupResources();
  }

  private disable(reason: string, err: unknown): void {
    this._enabled = false;
    this.queue = [];
    this.cleanupResources();
    if (!this.warned) {
      this.warned = true;
      console.warn(`[ledger] ${reason}，已自动停用账本（不影响正常请求）:`, err);
    }
  }

  private cleanupResources(): void {
    process.off('exit', this.onProcessExit);
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    this.upsertReqStmt = null;
    this.insertSnapStmt = null;
    if (this.db) {
      try {
        this.db.close();
      } catch { /* 忽略关闭失败 */ }
      this.db = null;
    }
  }
}
