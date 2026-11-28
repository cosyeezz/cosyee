import { BUILTIN_PRICES, costTotal, requestCost } from '@cosyee/shared';
import { describe, expect, it } from 'vitest';
import { FIVE_HOURS_MS, WEEK_MS, type LedgerRequest, type LedgerSnapshot } from './sink.js';
import {
  computeWindows,
  modelMatchesGroup,
  parseWindowId,
  subtractOneCalendarMonth,
} from './windows.js';

const BASE = Date.UTC(2026, 10, 27, 10, 0, 0); // 2026-11-27T10:00:00Z
const MIN = 60_000;

function snap(overrides: Partial<LedgerSnapshot> = {}): LedgerSnapshot {
  return {
    backend: 'claude',
    account: 'default',
    accountKind: 'subscription',
    kind: 'session',
    group: null,
    at: BASE + 10 * MIN,
    percent: 10,
    resetsAt: BASE + FIVE_HOURS_MS,
    windowMs: FIVE_HOURS_MS,
    source: 'event',
    ...overrides,
  };
}

function req(overrides: Partial<LedgerRequest> = {}): LedgerRequest {
  return {
    backend: 'claude',
    id: 'r1',
    at: BASE + 20 * MIN,
    account: 'default',
    accountKind: 'subscription',
    session: 's1',
    layer: 'main',
    agent: null,
    toolUseId: null,
    model: 'claude-opus-5-5',
    effort: 'medium',
    input: 100_000,
    create5m: 0,
    create1h: 0,
    read: 0,
    output: 10_000,
    reasoning: 0,
    fast: false,
    usGeo: false,
    estimated: false,
    ...overrides,
  };
}

describe('windows 纯函数计算', () => {
  it('resetsAt 抖动 ≤ 15 分钟聚为同一窗口，> 15 分钟拆分；resetsAt 为 null 忽略；相邻同值合并', () => {
    const end1 = BASE + FIVE_HOURS_MS;
    const end2 = end1 + FIVE_HOURS_MS;
    const snaps: LedgerSnapshot[] = [
      // null resetsAt 应被忽略
      snap({ at: BASE + 5 * MIN, percent: 5, resetsAt: null }),
      // 窗口 1：resetsAt 抖动 +3min / -2min，最新快照 resetsAt = end1 + 2min
      snap({ at: BASE + 10 * MIN, percent: 10, resetsAt: end1 }),
      snap({ at: BASE + 20 * MIN, percent: 10, resetsAt: end1 + 3 * MIN }),
      snap({ at: BASE + 40 * MIN, percent: 25, resetsAt: end1 - 2 * MIN }),
      snap({ at: BASE + 50 * MIN, percent: 25, resetsAt: end1 + 2 * MIN }),
      // 窗口 2：新的 5 小时窗口
      snap({ at: end1 + 30 * MIN, percent: 4, resetsAt: end2 }),
    ];

    const wins = computeWindows(snaps, [], { prices: BUILTIN_PRICES, now: end1 + 60 * MIN });
    expect(wins).toHaveLength(2);
    // 按 end 倒序：窗口 2 在前
    expect(wins[0]!.end).toBe(end2);
    expect(wins[0]!.current).toBe(true);
    expect(wins[1]!.end).toBe(end1 + 2 * MIN);
    expect(wins[1]!.start).toBe(end1 + 2 * MIN - FIVE_HOURS_MS);
    expect(wins[1]!.current).toBe(false);
    expect(wins[1]!.startPercent).toBe(10);
    expect(wins[1]!.endPercent).toBe(25);
    expect(wins[1]!.firstSnapshotAt).toBe(BASE + 10 * MIN);
    expect(wins[1]!.lastSnapshotAt).toBe(BASE + 50 * MIN);
    // 相邻同值合并：10, 10, 25, 25 → 10, 25
    expect(wins[1]!.snapshots).toEqual([
      { at: BASE + 10 * MIN, percent: 10, source: 'event' },
      { at: BASE + 40 * MIN, percent: 25, source: 'event' },
    ]);
  });

  it('scoped / agy 分组模型匹配规则', () => {
    expect(modelMatchesGroup('claude-opus-5-5', 'opus')).toBe(true);
    expect(modelMatchesGroup('claude-sonnet-4-6', 'opus')).toBe(false);
    expect(modelMatchesGroup('claude-sonnet-5-5', 'Claude · GPT')).toBe(true);
    expect(modelMatchesGroup('gpt-5.4', 'Claude · GPT')).toBe(true);
    expect(modelMatchesGroup('gemini-4-neon', 'Claude · GPT')).toBe(false);
    expect(modelMatchesGroup('gemini-4-neon-high', 'Gemini')).toBe(true);
    expect(modelMatchesGroup(null, 'Gemini')).toBe(false);
    expect(modelMatchesGroup(null, null)).toBe(true);

    const end = BASE + WEEK_MS;
    const snaps: LedgerSnapshot[] = [
      snap({ backend: 'agy', kind: 'weekly', group: 'Claude · GPT', at: BASE + 10 * MIN, percent: 10, resetsAt: end, windowMs: WEEK_MS }),
      snap({ backend: 'agy', kind: 'weekly', group: 'Claude · GPT', at: BASE + 30 * MIN, percent: 20, resetsAt: end, windowMs: WEEK_MS }),
    ];
    const reqs: LedgerRequest[] = [
      req({ backend: 'agy', id: '1', at: BASE + 15 * MIN, model: 'claude-opus-5-5', input: 100_000, output: 0 }),
      req({ backend: 'agy', id: '2', at: BASE + 20 * MIN, model: 'gpt-5.4', input: 100_000, output: 0 }),
      req({ backend: 'agy', id: '3', at: BASE + 25 * MIN, model: 'gemini-4-neon', input: 100_000, output: 0 }),
    ];
    const wins = computeWindows(snaps, reqs, { prices: BUILTIN_PRICES, now: BASE + 40 * MIN });
    expect(wins).toHaveLength(1);
    expect(wins[0]!.requests).toBe(2);
    expect(wins[0]!.rows.map((r) => r.model).sort()).toEqual(['claude-opus-5-5', 'gpt-5.4']);
  });

  it('usdPer100 推算：常规区间、首快照接近 0% 补全、以及增量 < 5 返回 null', () => {
    const end = BASE + FIVE_HOURS_MS;
    // claude-opus-5-5: input=$4/MTok, output=$20/MTok → 250k input = $1.00
    const oneDollarReq = (id: string, at: number) =>
      req({ id, at, model: 'claude-opus-5-5', input: 250_000, output: 0 });

    // 1) 常规口径：首快照 10%，末快照 30%（Δ=20%）；窗口起点到首快照前的 $1 不计入 basisCost，只计入总 costUsd
    const wins1 = computeWindows(
      [
        snap({ at: BASE + 20 * MIN, percent: 10, resetsAt: end }),
        snap({ at: BASE + 40 * MIN, percent: 30, resetsAt: end }),
      ],
      [
        oneDollarReq('before_first', BASE + 5 * MIN),
        oneDollarReq('inside', BASE + 30 * MIN),
        oneDollarReq('after_last', BASE + 50 * MIN),
      ],
      { prices: BUILTIN_PRICES, now: BASE + 60 * MIN },
    );
    expect(wins1[0]!.costUsd).toBeCloseTo(3, 6);
    expect(wins1[0]!.estimate.basisPercent).toBe(20);
    expect(wins1[0]!.estimate.basisCost).toBeCloseTo(1, 6);
    expect(wins1[0]!.estimate.usdPer100).toBeCloseTo(5, 6);
    expect(wins1[0]!.estimate.reliable).toBe(true);

    // 2) 首快照接近 0%（≤1%）且此前有请求：从 start 起算
    const wins2 = computeWindows(
      [
        snap({ at: BASE + 20 * MIN, percent: 0.5, resetsAt: end }),
        snap({ at: BASE + 40 * MIN, percent: 10, resetsAt: end }),
      ],
      [
        oneDollarReq('early', BASE + 5 * MIN),
        oneDollarReq('mid', BASE + 30 * MIN),
      ],
      { prices: BUILTIN_PRICES, now: BASE + 60 * MIN },
    );
    expect(wins2[0]!.estimate.basisPercent).toBe(10);
    expect(wins2[0]!.estimate.basisCost).toBeCloseTo(2, 6);
    expect(wins2[0]!.estimate.usdPer100).toBeCloseTo(20, 6);

    // 3) 增量 < 5 个百分点：usdPer100 = null
    const wins3 = computeWindows(
      [
        snap({ at: BASE + 10 * MIN, percent: 10, resetsAt: end }),
        snap({ at: BASE + 30 * MIN, percent: 14, resetsAt: end }),
      ],
      [oneDollarReq('r', BASE + 20 * MIN)],
      { prices: BUILTIN_PRICES, now: BASE + 40 * MIN },
    );
    expect(wins3[0]!.estimate.basisPercent).toBe(4);
    expect(wins3[0]!.estimate.usdPer100).toBeNull();
  });

  it('external 判定：上涨 ≥ 2 个百分点且前后 2 分钟无匹配请求 → external=true 且 reliable=false（仍给 usdPer100）', () => {
    const end = BASE + FIVE_HOURS_MS;
    const winsExternal = computeWindows(
      [
        snap({ at: BASE + 10 * MIN, percent: 10, resetsAt: end }),
        snap({ at: BASE + 20 * MIN, percent: 20, resetsAt: end }), // 无请求，跳涨 10%
        snap({ at: BASE + 40 * MIN, percent: 30, resetsAt: end }), // 有请求
      ],
      [req({ id: 'r1', at: BASE + 30 * MIN, input: 250_000, output: 0 })],
      { prices: BUILTIN_PRICES, now: BASE + 50 * MIN },
    );
    expect(winsExternal[0]!.external).toBe(true);
    expect(winsExternal[0]!.estimate.reliable).toBe(false);
    // 仍给 usdPer100 供参考
    expect(winsExternal[0]!.estimate.usdPer100).toBeCloseTo(5, 6);

    // 若请求落在容差范围内（前 2 分钟内），不算 external
    const winsTolerance = computeWindows(
      [
        snap({ at: BASE + 10 * MIN, percent: 10, resetsAt: end }),
        snap({ at: BASE + 20 * MIN, percent: 15, resetsAt: end }),
      ],
      [req({ id: 'r_tol', at: BASE + 8.5 * MIN, input: 250_000, output: 0 })],
      { prices: BUILTIN_PRICES, now: BASE + 30 * MIN },
    );
    expect(winsTolerance[0]!.external).toBe(false);
    expect(winsTolerance[0]!.estimate.reliable).toBe(true);
  });

  it('Kiro monthly 窗口：自然月反推起点、percent = used/limit*100、summary 带 used/limit', () => {
    // 2026-03-31 → 往前推一个月应钳位到 2026-02-28
    const mar31 = Date.UTC(2026, 2, 31, 0, 0, 0);
    expect(subtractOneCalendarMonth(mar31)).toBe(Date.UTC(2026, 1, 28, 0, 0, 0));

    const end = Date.UTC(2026, 11, 1, 0, 0, 0);
    const expectedStart = Date.UTC(2026, 10, 1, 0, 0, 0);
    const wins = computeWindows(
      [
        snap({
          backend: 'claude',
          account: 'kiro_1',
          accountKind: 'kiro',
          kind: 'monthly',
          at: expectedStart + 24 * 3600_000,
          percent: 0, // 应按 used/limit*100 算出 10
          resetsAt: end,
          windowMs: null,
          used: 50,
          limit: 500,
        }),
        snap({
          backend: 'claude',
          account: 'kiro_1',
          accountKind: 'kiro',
          kind: 'monthly',
          at: expectedStart + 48 * 3600_000,
          percent: 0, // 应按 used/limit*100 算出 25
          resetsAt: end,
          windowMs: null,
          used: 125,
          limit: 500,
        }),
      ],
      [
        req({
          backend: 'claude',
          account: 'kiro_1',
          accountKind: 'kiro',
          id: 'k1',
          at: expectedStart + 36 * 3600_000,
          input: 250_000,
          output: 0,
        }),
      ],
      { prices: BUILTIN_PRICES, now: expectedStart + 50 * 3600_000 },
    );
    expect(wins).toHaveLength(1);
    expect(wins[0]!.start).toBe(expectedStart);
    expect(wins[0]!.startPercent).toBe(10);
    expect(wins[0]!.endPercent).toBe(25);
    expect(wins[0]!.used).toBe(125);
    expect(wins[0]!.limit).toBe(500);
    expect(wins[0]!.estimate.basisPercent).toBe(15);
  });

  it('create5m/create1h 计费换算、未知模型 unpricedRequests、rows 按花费倒序聚合与 windowId 解析', () => {
    const end = BASE + FIVE_HOURS_MS;
    const r1 = req({
      id: 'c1',
      at: BASE + 15 * MIN,
      model: 'claude-opus-5-5',
      layer: 'main',
      input: 100_000,
      create5m: 200_000,
      create1h: 100_000,
      read: 500_000,
      output: 10_000,
    });
    const r2 = req({
      id: 'c2',
      at: BASE + 20 * MIN,
      model: 'unknown-third-party-model',
      layer: 'delegate',
      agent: 'helper',
      input: 50_000,
      output: 5_000,
      estimated: true,
    });

    const expectedCost = costTotal(
      requestCost(BUILTIN_PRICES, {
        model: 'claude-opus-5-5',
        input: 100_000,
        create: 300_000,
        create1h: 100_000,
        read: 500_000,
        output: 10_000,
      })!,
    );

    const wins = computeWindows(
      [snap({ at: BASE + 10 * MIN, percent: 10, resetsAt: end })],
      [r1, r2],
      { prices: BUILTIN_PRICES, now: BASE + 30 * MIN },
    );
    expect(wins[0]!.costUsd).toBeCloseTo(expectedCost, 6);
    expect(wins[0]!.unpricedRequests).toBe(1);
    expect(wins[0]!.rows).toHaveLength(2);
    expect(wins[0]!.rows[0]!.model).toBe('claude-opus-5-5');
    expect(wins[0]!.rows[1]!.model).toBe('unknown-third-party-model');
    expect(wins[0]!.rows[1]!.unpricedRequests).toBe(1);
    expect(wins[0]!.rows[1]!.estimated).toBe(true);

    expect(parseWindowId(wins[0]!.id)).toEqual({
      backend: 'claude',
      account: 'default',
      kind: 'session',
      group: null,
      end,
    });
    expect(parseWindowId('bad|id')).toBeNull();
  });
});
