import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchHistory } from './history.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void };
};

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 10, 27);
/** 毫秒转 Chrome 时间（1601 起的微秒） */
const chromeTime = (ms: number) => (ms + 11_644_473_600_000) * 1000;

let dir: string;

function writeHistory(rows: { url: string; title?: string; visits?: number; typed?: number; daysAgo?: number; hidden?: number }[]) {
  fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
  const file = path.join(dir, 'Default', 'History');
  fs.rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)');
  const ins = db.prepare('INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of rows) ins.run(r.url, r.title ?? '', r.visits ?? 1, r.typed ?? 0, chromeTime(NOW - (r.daysAgo ?? 0) * DAY_MS), r.hidden ?? 0);
  db.close();
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-history-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('searchHistory', () => {
  it('没有历史库或输入为空时返回空', () => {
    expect(searchHistory(dir, 'git', NOW)).toEqual([]);
    writeHistory([{ url: 'https://github.com/' }]);
    expect(searchHistory(dir, '   ', NOW)).toEqual([]);
  });

  it('按网址和标题匹配，所有词都要出现；跳过隐藏和非网页条目', () => {
    writeHistory([
      { url: 'https://github.com/cosyee/issues', title: 'Issues · cosyee' },
      { url: 'https://example.com/a', title: 'GitHub 镜像说明' },
      { url: 'https://news.example.com/', title: 'News' },
      { url: 'https://github.com/hidden', hidden: 1 },
      { url: 'chrome://settings/', title: 'github settings' },
    ]);
    expect(searchHistory(dir, 'github', NOW).map((i) => i.url).sort()).toEqual(['https://example.com/a', 'https://github.com/cosyee/issues']);
    expect(searchHistory(dir, 'github issues', NOW)).toEqual([{ url: 'https://github.com/cosyee/issues', title: 'Issues · cosyee' }]);
  });

  it('网址以输入开头的排前面（忽略协议和 www.），其次看访问次数和新近程度', () => {
    writeHistory([
      { url: 'https://example.com/?q=git', title: 'git', visits: 50 },
      { url: 'https://www.github.com/', title: 'GitHub', visits: 2 },
      { url: 'https://gitlab.com/old', visits: 30, daysAgo: 300 },
      { url: 'https://gitlab.com/new', visits: 5, typed: 1 },
    ]);
    expect(searchHistory(dir, 'git', NOW).map((i) => i.url)).toEqual([
      'https://gitlab.com/new',
      'https://www.github.com/',
      'https://gitlab.com/old',
      'https://example.com/?q=git',
    ]);
    expect(searchHistory(dir, 'https://www.github', NOW)[0]?.url).toBe('https://www.github.com/');
  });

  it('历史库变了重新读，最多返回 8 条', () => {
    writeHistory([{ url: 'https://a.com/' }]);
    expect(searchHistory(dir, 'b.com', NOW)).toEqual([]);
    writeHistory(Array.from({ length: 12 }, (_, i) => ({ url: `https://b.com/${i}` })));
    expect(searchHistory(dir, 'b.com', NOW)).toHaveLength(8);
  });

  it('历史库坏了返回空，不抛错', () => {
    fs.mkdirSync(path.join(dir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Default', 'History'), 'not a database');
    expect(searchHistory(dir, 'a', NOW)).toEqual([]);
  });
});
