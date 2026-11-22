import { describe, expect, it } from 'vitest';
import { BUILTIN_PRICES, type CachePoint, type CompactMark, type SubagentCost, type Turn } from '@cosyee/shared';
import { formatUsd, sessionCost } from './cost';

const S45 = 'claude-sonnet-4-5-20250929';

const pt = (over: Partial<CachePoint> & { id: string; turn: number }): CachePoint => ({
  input: 0,
  create: 0,
  read: 0,
  rate: 0,
  output: 0,
  model: S45,
  ...over,
});

const turn = (id: string, subagents: { toolUseId: string; taskId?: string }[] = []): Turn =>
  ({
    id,
    userText: id,
    attachments: [],
    status: 'done',
    statusText: '',
    steps: [],
    answer: '',
    subagents: subagents.map((s) => ({ ...s, title: '', status: 'done', turn: {} as Turn })),
    startedAt: 0,
  }) as Turn;

const sub = (over: Partial<SubagentCost> & { agentId: string }): SubagentCost => ({
  toolUseId: null,
  requests: 1,
  cost: { input: 0, write: 0, read: 0, output: 0.1 },
  uncached: 0.1,
  unpriced: 0,
  models: [S45],
  ...over,
});

describe('sessionCost', () => {
  it('按价格表算主线程每次请求，分类合计与按轮归集', () => {
    const r = sessionCost({
      table: BUILTIN_PRICES,
      turns: [turn('t0'), turn('t1')],
      points: [
        pt({ id: 'a', turn: 0, input: 1000, read: 1_000_000, output: 1000 }),
        pt({ id: 'b', turn: 1, create: 10_000 }),
      ],
    });
    // a：0.003 + 0.3 + 0.015；b：10k × 3.75
    expect(r.turns).toHaveLength(2);
    expect(r.turns[0]!.requests).toBe(1);
    expect(r.parts.input).toBeCloseTo(0.003, 9);
    expect(r.parts.read).toBeCloseTo(0.3, 9);
    expect(r.parts.output).toBeCloseTo(0.015, 9);
    expect(r.parts.write).toBeCloseTo(0.0375, 9);
    expect(r.total).toBeCloseTo(0.3555, 9);
    expect(r.main).toBeCloseTo(r.total, 9);
    expect(r.sub).toBe(0);
    expect(r.requests).toBe(2);
    // 不用缓存：a (1000 + 1M) × 3 + 1000 × 15；b 10k × 3
    expect(r.uncached).toBeCloseTo(3.018 + 0.03, 9);
    expect(r.saved).toBeCloseTo(3.048 - 0.3555, 9);
  });

  it('1 小时缓存写入按 write1h 价算', () => {
    const r = sessionCost({ table: BUILTIN_PRICES, points: [pt({ id: 'a', turn: 0, create: 10_000, create1h: 4000 })] });
    expect(r.parts.write).toBeCloseTo((6000 * 3.75 + 4000 * 6) / 1e6, 9);
  });

  it('点里没有模型时用会话模型；都不认识就记为未定价', () => {
    const a = sessionCost({
      table: BUILTIN_PRICES,
      fallbackModel: 'claude-opus-4-5',
      points: [pt({ id: 'a', turn: 0, input: 1_000_000, model: undefined })],
    });
    expect(a.total).toBeCloseTo(5, 9);

    const b = sessionCost({
      table: BUILTIN_PRICES,
      points: [pt({ id: 'a', turn: 0, input: 1000, model: 'glm-4.6' }), pt({ id: 'b', turn: 0, input: 1000, model: undefined })],
    });
    expect(b.total).toBe(0);
    expect(b.requests).toBe(0);
    expect(b.unpriced).toBe(2);
    expect(b.unpricedModels).toEqual(['glm-4.6', '未知模型']);
    expect(b.next).toBeNull();
  });

  it('子代理按 toolUseId、再按 taskId 归到所属轮；找不到的进 other', () => {
    const r = sessionCost({
      table: BUILTIN_PRICES,
      turns: [turn('t0', [{ toolUseId: 'tu1' }]), turn('t1', [{ toolUseId: 'tu2', taskId: 'ag2' }])],
      points: [pt({ id: 'a', turn: 0, input: 1000 })],
      subs: [
        sub({ agentId: 'ag1', toolUseId: 'tu1' }),
        sub({ agentId: 'ag2' }),
        sub({ agentId: 'compact', cost: { input: 0, write: 0, read: 0, output: 0.05 } }),
      ],
    });
    expect(r.turns[0]!.subRuns).toBe(1);
    expect(r.turns[0]!.sub.output).toBeCloseTo(0.1, 9);
    expect(r.turns[1]!.subRuns).toBe(1);
    expect(r.turns[1]!.requests).toBe(0);
    expect(r.other.output).toBeCloseTo(0.05, 9);
    expect(r.sub).toBeCloseTo(0.25, 9);
    expect(r.total).toBeCloseTo(0.003 + 0.25, 9);
    expect(r.requests).toBe(4);
  });

  it('子代理的未定价请求计入 unpriced，全部未定价时不计花费', () => {
    const r = sessionCost({
      table: BUILTIN_PRICES,
      points: [],
      subs: [sub({ agentId: 'x', requests: 2, unpriced: 2, models: ['gpt-5'] })],
    });
    expect(r.unpriced).toBe(2);
    expect(r.unpricedModels).toEqual(['gpt-5']);
    expect(r.total).toBe(0);
    expect(r.requests).toBe(0);
  });

  it('没有请求的轮也占一格', () => {
    const r = sessionCost({ table: BUILTIN_PRICES, turns: [turn('t0'), turn('t1'), turn('t2')], points: [pt({ id: 'a', turn: 1, input: 1 })] });
    expect(r.turns.map((t) => t.requests)).toEqual([0, 1, 0]);
  });
});

describe('下一次请求预估', () => {
  it('= 最后一次的输入 + 输出；热缓存按读价、冷缓存按写价，消息历史按读价', () => {
    const r = sessionCost({
      table: BUILTIN_PRICES,
      historyTokens: 60_000,
      points: [pt({ id: 'a', turn: 0, input: 100, create: 900, read: 99_000, output: 1000 })],
    });
    expect(r.next!.prompt).toBe(101_000);
    expect(r.next!.warm).toBeCloseTo((101_000 * 0.3) / 1e6, 9);
    expect(r.next!.cold).toBeCloseTo((101_000 * 3.75) / 1e6, 9);
    expect(r.next!.history).toBeCloseTo((60_000 * 0.3) / 1e6, 9);
  });

  it('最后一次请求写的是 1 小时缓存时，冷缓存按 write1h 算；不知道消息历史时为 null', () => {
    const r = sessionCost({ table: BUILTIN_PRICES, points: [pt({ id: 'a', turn: 0, create: 1000, create1h: 1000 })] });
    expect(r.next!.cold).toBeCloseTo((1000 * 6) / 1e6, 9);
    expect(r.next!.history).toBeNull();
  });

  it('最后一次请求之后压缩过：按压缩后的大小', () => {
    const mark: CompactMark = { id: 'c', turn: 0, trigger: 'auto', pre: 150_000, post: 20_000, durationMs: 1, after: 'a', at: 0 };
    const r = sessionCost({ table: BUILTIN_PRICES, compactions: [mark], points: [pt({ id: 'a', turn: 0, read: 150_000 })] });
    expect(r.next!.prompt).toBe(20_000);
  });

  it('长上下文价按整次输入判断', () => {
    const r = sessionCost({ table: BUILTIN_PRICES, points: [pt({ id: 'a', turn: 0, read: 200_000, model: 'claude-haiku-5-5' })] });
    expect(r.next!.warm).toBeCloseTo((200_000 * 0.05) / 1e6, 9);
  });

  it('没有请求时为 null', () => {
    expect(sessionCost({ table: BUILTIN_PRICES, points: undefined }).next).toBeNull();
  });
});

describe('formatUsd', () => {
  it.each([
    [0, '$0'],
    [-1, '$0'],
    [Number.NaN, '$0'],
    [0.0004, '<$0.001'],
    [0.0042, '$0.004'],
    [0.318, '$0.32'],
    [12.344, '$12.34'],
    [1234.5, '$1,235'],
  ])('%s → %s', (v, s) => {
    expect(formatUsd(v)).toBe(s);
  });
});
