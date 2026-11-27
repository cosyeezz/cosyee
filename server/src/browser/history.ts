// 地址栏的历史联想：读身份目录里 Chrome 自己的 History 数据库（Claude 打开过的页面也在里面）。
// Chrome 运行时独占这个库，只能复制一份再读；复制品按源文件的修改时间和大小缓存，内容没变就不再复制。
// 读出的条目只在内存里过滤，不写日志。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { BrowserHistoryItem } from '@cosyee/shared';

/** 每次最多载入多少条（按最近访问倒序），够联想用 */
const LOAD_MAX = 5000;
const RESULT_MAX = 8;
const QUERY_MAX = 200;
/** Chrome 的时间是 1601-01-01 起的微秒，超出 JS 安全整数，在 SQL 里先除成毫秒 */
const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000;

interface Row {
  url: string;
  title: string;
  visits: number;
  typed: number;
  lastMs: number;
}

interface SqliteDb {
  prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
  close(): void;
}
type SqliteModule = { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDb };

let sqlite: SqliteModule | null | undefined;
function loadSqlite(): SqliteModule | null {
  if (sqlite === undefined) {
    try {
      sqlite = createRequire(import.meta.url)('node:sqlite') as SqliteModule;
    } catch {
      sqlite = null;
    }
  }
  return sqlite;
}

const cache = new Map<string, { key: string; rows: Row[] }>();

/** 读出最近访问的条目；没有历史库（新身份）或读不了时返回空 */
function load(profileDir: string): Row[] {
  const file = path.join(profileDir, 'Default', 'History');
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = cache.get(profileDir);
  if (hit && hit.key === key) return hit.rows;
  const mod = loadSqlite();
  if (!mod) return [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-history-'));
  let rows: Row[] = [];
  try {
    const copy = path.join(tmp, 'History');
    fs.copyFileSync(file, copy);
    fs.chmodSync(copy, 0o600);
    const db = new mod.DatabaseSync(copy, { readOnly: true });
    try {
      rows = db
        .prepare('SELECT url, title, visit_count, typed_count, last_visit_time / 1000 AS last_ms FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT ?')
        .all(LOAD_MAX)
        .map((r) => ({
          url: String(r.url ?? ''),
          title: String(r.title ?? ''),
          visits: Number(r.visit_count) || 0,
          typed: Number(r.typed_count) || 0,
          lastMs: Number(r.last_ms) - CHROME_EPOCH_OFFSET_MS,
        }))
        .filter((r) => /^https?:\/\//i.test(r.url));
    } finally {
      db.close();
    }
  } catch {
    rows = [];
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  cache.set(profileDir, { key, rows });
  return rows;
}

/** 去掉协议和开头的 www.，用来比较输入 */
function bare(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
}

/**
 * 按输入找历史：每个空格分开的词都要出现在网址或标题里。
 * 排序：网址以输入开头的优先，其次按访问次数（手动输入过的加权）随时间衰减。
 */
export function searchHistory(profileDir: string, query: string, now = Date.now()): BrowserHistoryItem[] {
  const q = query.trim().toLowerCase().slice(0, QUERY_MAX);
  if (!q) return [];
  // 输入里带的协议和 www. 也去掉，和网址比较时口径一致
  const head = bare(q);
  const words = head.split(/\s+/);
  const scored: { row: Row; score: number }[] = [];
  for (const row of load(profileDir)) {
    const u = bare(row.url).toLowerCase();
    const hay = `${u} ${row.title.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    const days = Math.max(0, (now - row.lastMs) / 86_400_000);
    let score = (row.visits + row.typed * 4) / (1 + days / 7);
    if (u.startsWith(head)) score += 1000;
    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || b.row.lastMs - a.row.lastMs);
  return scored.slice(0, RESULT_MAX).map(({ row }) => ({ url: row.url, title: row.title }));
}
