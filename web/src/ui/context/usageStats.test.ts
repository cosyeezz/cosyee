import { describe, expect, it } from 'vitest';
import { BUILTIN_PRICES, type CachePoint, type UsageTrack } from '@cosyee/shared';
import { computeUsageStats, requestCostRows, resolveSubagentContextWindow } from './usageStats';

const pt = (over: Partial<CachePoint> & { id: string }): CachePoint => ({
  turn: 0,
  input: 0,
  create: 0,
  read: 0,
  rate: 0,
  output: 0,
  model: 'claude-sonnet-4-5-20250929',
  ...over,
});

describe('computeUsageStats', () => {
  it('无 breakdown 时按最后一次请求的读缓存 / 未缓存 / 写缓存三段计算占用与百分比', () => {
    const p1 = pt({ id: 'm1', input: 200, create: 1000, read: 0, rate: 0, output: 100 });
    const p2 = pt({ id: 'm2', input: 1000, create: 4000, read: 15_000, rate: 75, output: 500 });
    const track: UsageTrack = { points: [p1, p2], window: 200_000, billing: 'subscription' };
    const stats = computeUsageStats(track, { pricing: BUILTIN_PRICES, mode: 'subagent' });

    expect(stats.perRequest).toBe(true);
    expect(stats.occupancy.hasBreakdown).toBe(false);
    expect(stats.occupancy.used).toBe(20_000);
    expect(stats.occupancy.window).toBe(200_000);
    expect(stats.occupancy.percent).toBeCloseTo(10, 6);
    expect(stats.occupancy.segments.map((s) => [s.key, s.label, s.tokens])).toEqual([
      ['read', '读缓存', 15_000],
      ['input', '未缓存', 1000],
      ['create', '写缓存', 4000],
    ]);
    expect(stats.hitRate.now).toBe(75);
    expect(stats.hitRate.avg).toBeCloseTo((15_000 / 21_200) * 100, 6);
    // 子代理不显示下一次请求预估
    expect(stats.cost.next).toBeNull();
    expect(stats.cost.total).toBeGreaterThan(0);
  });

  it('窗口未知时 percent 为 null，仍返回已用与非零分段（如无写缓存的 Codex）', () => {
    const p = pt({ id: 'c1', input: 5000, create: 0, read: 15_000, rate: 75, output: 200, model: 'gpt-5.3-codex' });
    const track: UsageTrack = { points: [p], window: null, billing: 'subscription' };
    const stats = computeUsageStats(track, { pricing: BUILTIN_PRICES, mode: 'subagent' });

    expect(stats.occupancy.used).toBe(20_000);
    expect(stats.occupancy.window).toBeNull();
    expect(stats.occupancy.percent).toBeNull();
    expect(stats.occupancy.segments.map((s) => s.key)).toEqual(['read', 'input']);
  });

  it('requestCostRows 按每次请求生成单柱数据并透传 estimated 标记', () => {
    const points = [
      pt({ id: 'a1', input: 100_000, create: 0, read: 0, output: 1000, model: 'gemini-4-neon', estimated: true }),
      pt({ id: 'a2', input: 10_000, create: 0, read: 90_000, output: 500, model: 'gemini-4-neon' }),
    ];
    const { rows, estimated } = requestCostRows(points, BUILTIN_PRICES);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.requests).toBe(1);
    expect(rows[0]!.main.input).toBeCloseTo(0.3, 6);
    expect(rows[1]!.main.read).toBeCloseTo(0.0135, 6);
    expect(estimated).toEqual([true, false]);
  });
});

describe('resolveSubagentContextWindow', () => {
  it('按优先级：run.contextWindow → cliCost → contextWindowOf（含 [1m] 与模型映射 m1）', () => {
    expect(
      resolveSubagentContextWindow({
        run: { contextWindow: 512_000, model: 'claude-sonnet-4-5' },
        cliCost: [{ model: 'claude-sonnet-4-5', input: 0, output: 0, read: 0, create5m: 0, create1h: 0, costUSD: 0, contextWindow: 200_000 }],
      }),
    ).toBe(512_000);

    expect(
      resolveSubagentContextWindow({
        run: { model: 'claude-sonnet-4-5-20250929' },
        cliCost: [{ model: 'claude-sonnet-4-5', input: 0, output: 0, read: 0, create5m: 0, create1h: 0, costUSD: 0, contextWindow: 1_000_000 }],
      }),
    ).toBe(1_000_000);

    expect(resolveSubagentContextWindow({ run: { model: 'claude-sonnet-4-5[1m]' } })).toBe(1_000_000);
    expect(
      resolveSubagentContextWindow({
        run: { model: 'sonnet' },
        modelMap: { alias: { sonnet: { id: 'claude-sonnet-4-5', m1: true } } },
      }),
    ).toBe(1_000_000);
    expect(resolveSubagentContextWindow({ run: { model: 'gpt-5.3-codex' } })).toBe(400_000);
    expect(resolveSubagentContextWindow({ run: { model: 'unknown-custom-model' } })).toBeNull();
  });
});
