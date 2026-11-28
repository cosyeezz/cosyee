import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LedgerRequest, LedgerSnapshot } from './sink.js';
import { LedgerStore, RETENTION_MS } from './store.js';

function makeReq(overrides: Partial<LedgerRequest> = {}): LedgerRequest {
  return {
    backend: 'claude',
    id: 'msg_1',
    at: 1_700_000_000_000,
    account: 'default',
    accountKind: 'subscription',
    session: 'sess_1',
    layer: 'main',
    agent: null,
    toolUseId: null,
    model: 'claude-opus-5-5',
    effort: 'medium',
    input: 1000,
    create5m: 200,
    create1h: 0,
    read: 500,
    output: 300,
    reasoning: 0,
    fast: false,
    usGeo: false,
    estimated: false,
    ...overrides,
  };
}

function makeSnap(overrides: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    backend: 'claude',
    account: 'default',
    accountKind: 'subscription',
    kind: 'session',
    group: null,
    at: 1_700_000_000_000,
    percent: 10,
    resetsAt: 1_700_018_000_000,
    windowMs: 18_000_000,
    source: 'event',
    ...overrides,
  };
}

describe('LedgerStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('upsert：token 取 max，at 保留首次，非空字段覆盖，null 字段保留旧值', () => {
    const store = new LedgerStore({ path: ':memory:', now: () => 1_700_000_100_000 });
    try {
      store.record(
        makeReq({
          id: 'msg_1',
          at: 1_700_000_000_000,
          session: 'sess_1',
          model: 'claude-opus-5-5',
          effort: 'high',
          input: 1000,
          create5m: 500,
          create1h: 100,
          read: 200,
          output: 50,
          reasoning: 10,
          fast: false,
        }),
      );
      // 第二次写入同主键：at 更晚、部分 token 更大、部分更小、effort 为 null、agent 有新值
      store.record(
        makeReq({
          id: 'msg_1',
          at: 1_700_000_005_000,
          session: null,
          agent: 'Explore',
          model: 'claude-opus-5-5',
          effort: null,
          input: 800,
          create5m: 600,
          create1h: 50,
          read: 400,
          output: 250,
          reasoning: 5,
          fast: true,
        }),
      );
      // 不同 backend 同 id 不冲突
      store.record(makeReq({ backend: 'codex', id: 'msg_1', at: 1_700_000_001_000, model: 'gpt-5.4' }));

      const all = store.queryRequests();
      expect(all).toHaveLength(2);
      const claude = all.find((r) => r.backend === 'claude')!;
      expect(claude.at).toBe(1_700_000_000_000);
      expect(claude.session).toBe('sess_1');
      expect(claude.agent).toBe('Explore');
      expect(claude.effort).toBe('high');
      expect(claude.input).toBe(1000);
      expect(claude.create5m).toBe(600);
      expect(claude.create1h).toBe(100);
      expect(claude.read).toBe(400);
      expect(claude.output).toBe(250);
      expect(claude.reasoning).toBe(10);
      expect(claude.fast).toBe(true);
    } finally {
      store.close();
    }
  });

  it('批量 flush 与队列上限丢弃最旧条目', async () => {
    const store = new LedgerStore({
      path: ':memory:',
      now: () => 1_700_000_100_000,
      batchSize: 5,
      maxQueue: 3,
      flushIntervalMs: 60_000,
    });
    try {
      // 同步连写 5 条，maxQueue=3 应只留最后 3 条（id_3, id_4, id_5）
      for (let i = 1; i <= 5; i++) {
        store.record(makeReq({ id: `id_${i}`, at: 1_700_000_000_000 + i * 1000 }));
      }
      const rows = store.queryRequests();
      expect(rows.map((r) => r.id)).toEqual(['id_3', 'id_4', 'id_5']);

      // 达到 batchSize 触发异步 flush
      const store2 = new LedgerStore({
        path: ':memory:',
        now: () => 1_700_000_100_000,
        batchSize: 3,
        maxQueue: 100,
        flushIntervalMs: 60_000,
      });
      try {
        store2.snapshot(makeSnap({ at: 1_700_000_001_000, percent: 1 }));
        store2.snapshot(makeSnap({ at: 1_700_000_002_000, percent: 2 }));
        store2.snapshot(makeSnap({ at: 1_700_000_003_000, percent: 3 }));
        await new Promise((r) => setImmediate(r));
        expect(store2.querySnapshots()).toHaveLength(3);
      } finally {
        store2.close();
      }
    } finally {
      store.close();
    }
  });

  it('180 天保留策略：启动时自动清理过期数据', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-ledger-store-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'ledger.sqlite');
    const t0 = 1_700_000_000_000;

    // 先写入一条旧数据和一条新数据
    const s1 = new LedgerStore({ path: dbPath, now: () => t0 });
    s1.record(makeReq({ id: 'old', at: t0 - RETENTION_MS - 10_000 }));
    s1.record(makeReq({ id: 'fresh', at: t0 - 10_000 }));
    s1.snapshot(makeSnap({ at: t0 - RETENTION_MS - 10_000, percent: 5 }));
    s1.snapshot(makeSnap({ at: t0 - 10_000, percent: 20 }));
    s1.close();

    // 重新打开：启动时 prune 清掉过期记录
    const s2 = new LedgerStore({ path: dbPath, now: () => t0 });
    try {
      expect(s2.queryRequests().map((r) => r.id)).toEqual(['fresh']);
      expect(s2.querySnapshots().map((s) => s.percent)).toEqual([20]);
    } finally {
      s2.close();
    }
  });

  it('建库或写库失败时自动停用、只告警一次且绝不抛异常', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-ledger-fail-'));
    dirs.push(dir);

    // 传入一个已存在的目录路径作为 sqlite 文件，必然打开失败
    const bad = new LedgerStore({ path: dir });
    expect(bad.enabled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(() => bad.record(makeReq())).not.toThrow();
    expect(() => bad.snapshot(makeSnap())).not.toThrow();
    expect(bad.queryRequests()).toEqual([]);
    expect(bad.querySnapshots()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    bad.close();

    // 模拟运行时写入失败：损坏数据库底层表后 flush
    warn.mockClear();
    const s = new LedgerStore({ path: ':memory:', now: () => 1_700_000_000_000 });
    // 通过内部 db 删表触发写入异常
    (s as unknown as { db: { exec(sql: string): void } }).db.exec('DROP TABLE requests');
    s.record(makeReq({ id: 'boom' }));
    expect(() => s.flush()).not.toThrow();
    expect(s.enabled()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    // 后续写入静默忽略，不再告警
    expect(() => s.record(makeReq({ id: 'after' }))).not.toThrow();
    expect(() => s.flush()).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    s.close();
  });
});
