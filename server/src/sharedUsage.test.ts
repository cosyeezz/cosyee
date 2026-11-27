// 共享用量统计（shared/src/usage.ts）与多厂商定价（shared/src/pricing.ts）的单元测试。
// shared 包本身没有 vitest，这里借 server 的测试运行器跑（同 localPath.test.ts）。
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_PRICES,
  COSYEE_USAGE_SUBTYPE,
  MAX_CACHE_POINTS,
  cachePointOf,
  contextWindowOf,
  cosyeeUsageEvent,
  findPrice,
  isCosyeeUsageEvent,
  mergeTools,
  modelKey,
  pushCachePoint,
  requestCost,
  uncachedCost,
  type CachePoint,
} from '@cosyee/shared';

describe('cachePointOf / mergeTools / pushCachePoint', () => {
  it('跨多行同一 message.id 合并 tools，且 output 取较大值', () => {
    const list: CachePoint[] = [];
    const p1 = cachePointOf(
      {
        id: 'msg_1',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'tool_use', id: 'tu_1' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700, output_tokens: 12 },
      },
      2,
    )!;
    expect(p1).toMatchObject({ id: 'msg_1', turn: 2, input: 100, create: 200, read: 700, rate: 70, output: 12, tools: ['tu_1'], model: 'claude-sonnet-4-5-20250929' });
    expect(pushCachePoint(list, p1)).toBe(true);

    // 同 id 第二行：带新 tool、更大 output，不带 model；turn 保留原值
    const p2 = cachePointOf(
      {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'tu_1' }, { type: 'tool_use', id: 'tu_2' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700, output_tokens: 85 },
      },
      9,
    )!;
    expect(pushCachePoint(list, p2)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'msg_1', turn: 2, output: 85, tools: ['tu_1', 'tu_2'], model: 'claude-sonnet-4-5-20250929' });

    // 同 id 第三行：output 更小、tools 无新增 → 不更新，返回 false
    const p3 = cachePointOf(
      {
        id: 'msg_1',
        content: [{ type: 'tool_use', id: 'tu_2' }],
        usage: { input_tokens: 100, cache_creation_input_tokens: 200, cache_read_input_tokens: 700, output_tokens: 30 },
      },
      9,
    )!;
    expect(pushCachePoint(list, p3)).toBe(false);
    expect(list[0]!.output).toBe(85);
    expect(list[0]!.tools).toEqual(['tu_1', 'tu_2']);
  });

  it('无效消息返回 null；mergeTools 保持引用稳定；超 MAX_CACHE_POINTS 裁剪', () => {
    expect(cachePointOf(null, 0)).toBeNull();
    expect(cachePointOf({ id: 'm1', usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, 0)).toBeNull();
    const a = ['t1'];
    expect(mergeTools(a, ['t1'])).toBe(a);
    expect(mergeTools(undefined, ['t1'])).toEqual(['t1']);

    const list: CachePoint[] = [];
    for (let i = 0; i < MAX_CACHE_POINTS + 5; i++) {
      pushCachePoint(list, { id: `p_${i}`, turn: 0, input: 1, create: 0, read: 0, rate: 0 });
    }
    expect(list).toHaveLength(MAX_CACHE_POINTS);
    expect(list[0]!.id).toBe('p_5');
  });
});

describe('cosyeeUsageEvent / isCosyeeUsageEvent', () => {
  const pt: CachePoint = { id: 'u1', turn: 0, input: 500, create: 0, read: 1500, rate: 75, output: 120, model: 'gpt-6.1-sol' };

  it('构造与判别合法事件（含 / 不含 window）', () => {
    const ev1 = cosyeeUsageEvent('toolu_abc', pt);
    expect(ev1).toEqual({ type: 'system', subtype: COSYEE_USAGE_SUBTYPE, parent_tool_use_id: 'toolu_abc', point: pt });
    expect('window' in ev1).toBe(false);
    expect(isCosyeeUsageEvent(ev1)).toBe(true);

    const ev2 = cosyeeUsageEvent('toolu_abc', pt, 1_050_000);
    expect(ev2.window).toBe(1_050_000);
    expect(isCosyeeUsageEvent(ev2)).toBe(true);

    // 非正或非有限 window 不写入
    expect('window' in cosyeeUsageEvent('toolu_abc', pt, 0)).toBe(false);
    expect('window' in cosyeeUsageEvent('toolu_abc', pt, Number.NaN)).toBe(false);
  });

  it('拒绝非法事件', () => {
    expect(isCosyeeUsageEvent(null)).toBe(false);
    expect(isCosyeeUsageEvent({ type: 'system', subtype: 'cosyee_agent_params', tool_use_id: 'x' })).toBe(false);
    expect(isCosyeeUsageEvent({ type: 'system', subtype: COSYEE_USAGE_SUBTYPE, parent_tool_use_id: '', point: pt })).toBe(false);
    expect(isCosyeeUsageEvent({ type: 'system', subtype: COSYEE_USAGE_SUBTYPE, parent_tool_use_id: 't', point: { id: 'x' } })).toBe(false);
    expect(isCosyeeUsageEvent({ type: 'system', subtype: COSYEE_USAGE_SUBTYPE, parent_tool_use_id: 't', point: pt, window: -1 })).toBe(false);
  });
});

describe('contextWindowOf', () => {
  it('按模型与 hint 推算上下文窗口', () => {
    expect(contextWindowOf(undefined, { m1: true })).toBe(1_000_000);
    expect(contextWindowOf('claude-sonnet-4-5[1m]')).toBe(1_000_000);
    expect(contextWindowOf('claude-opus-5-5', { m1: true })).toBe(1_000_000);
    expect(contextWindowOf('claude-sonnet-4-5-20250929')).toBe(200_000);
    expect(contextWindowOf('us.anthropic.claude-opus-4-6-20260101')).toBe(200_000);
    // claude -p 实测：5 系列 1M，4.x 200k；别名现在解析到 5.x
    expect(contextWindowOf('sonnet')).toBe(1_000_000);
    expect(contextWindowOf('claude-opus-5-5')).toBe(1_000_000);
    expect(contextWindowOf('claude-haiku-5-5')).toBe(1_000_000);
    expect(contextWindowOf('claude-opus-5')).toBe(1_000_000);
    expect(contextWindowOf('claude-fable-5-2')).toBe(1_000_000);
    expect(contextWindowOf('claude-haiku-4-5-20251001')).toBe(200_000);

    // OpenAI / Codex
    expect(contextWindowOf('gpt-6.1-sol')).toBe(1_050_000);
    expect(contextWindowOf('gpt-5.6-terra')).toBe(1_050_000);
    expect(contextWindowOf('gpt-5.4')).toBe(1_050_000);
    expect(contextWindowOf('gpt-5.4-mini')).toBe(400_000);
    expect(contextWindowOf('gpt-5.3-codex')).toBe(400_000);
    expect(contextWindowOf('gpt-5-codex')).toBe(400_000);
    expect(contextWindowOf('gpt-5')).toBe(400_000);
    expect(contextWindowOf('gpt-4.1')).toBe(1_047_576);
    expect(contextWindowOf('gpt-4o')).toBe(128_000);
    expect(contextWindowOf('o3')).toBe(200_000);

    // Google Gemini
    expect(contextWindowOf('gemini-4-neon-high')).toBe(1_000_000);
    expect(contextWindowOf('gemini-4-carbon')).toBe(1_000_000);
    expect(contextWindowOf('gemini-3.1-pro-preview')).toBe(1_048_576);
    expect(contextWindowOf('gemini-3-flash-preview')).toBe(1_048_576);
    expect(contextWindowOf('gemini-2.5-pro')).toBe(1_048_576);

    // 未知或占位模型返回 null
    expect(contextWindowOf(undefined)).toBeNull();
    expect(contextWindowOf('<synthetic>')).toBeNull();
    expect(contextWindowOf('orch')).toBeNull();
    expect(contextWindowOf('glm-4.6')).toBeNull();
  });
});

describe('多厂商 modelKey 与 requestCost / uncachedCost', () => {
  it.each([
    ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-5'],
    ['claude-opus-5-5[1m]', 'claude-opus-5-5'],
    ['gpt-6.1-sol', 'gpt-6.1-sol'],
    ['gpt-5.6-terra', 'gpt-5.6-terra'],
    ['openai/gpt-5.4-2026-03-05', 'gpt-5.4'],
    ['gpt-5.4-mini', 'gpt-5.4-mini'],
    ['gpt-5.3-codex-high', 'gpt-5.3-codex'],
    ['gpt-5-codex', 'gpt-5'],
    ['gpt-5.1-codex', 'gpt-5.1'],
    ['gpt-5-mini-2025-08-07', 'gpt-5-mini'],
    ['gemini-4-neon-high', 'gemini-4-neon'],
    ['gemini-4-carbon-low', 'gemini-4-carbon'],
    ['gemini-3.1-pro-preview', 'gemini-3.1-pro'],
    ['gemini-3-pro-high', 'gemini-3-pro'],
    ['gemini-3-flash-preview', 'gemini-3-flash'],
    ['gemini-3.7-flash', 'gemini-3.8-flash'],
    ['models/gemini-2.5-pro-preview-05-06', 'gemini-2.5-pro'],
    ['gemini-2.5-flash', 'gemini-2.5-flash'],
    ['<synthetic>', null],
    ['orch', null],
    ['glm-4.6', null],
  ])('modelKey(%s) → %s', (raw, want) => {
    expect(modelKey(raw)).toBe(want);
  });

  it('OpenAI 模型费用计算（gpt-6.1-sol / gpt-5.6-terra）', () => {
    expect(findPrice(BUILTIN_PRICES, 'gpt-6.1-sol')).toBeTruthy();
    const u1 = { model: 'gpt-6.1-sol', input: 100_000, create: 0, read: 900_000, output: 50_000 };
    const c1 = requestCost(BUILTIN_PRICES, u1)!;
    // input: 0.1M * $2 = $0.2; read: 0.9M * $0.1 = $0.09; output: 0.05M * $10 = $0.5
    expect(c1.input).toBeCloseTo(0.2, 9);
    expect(c1.write).toBe(0);
    expect(c1.read).toBeCloseTo(0.09, 9);
    expect(c1.output).toBeCloseTo(0.5, 9);
    // uncached: 1M * $2 + 0.05M * $10 = $2.5
    expect(uncachedCost(BUILTIN_PRICES, u1)).toBeCloseTo(2.5, 9);

    const u2 = { model: 'gpt-5.6-terra', input: 500_000, create: 0, read: 500_000, output: 100_000 };
    const c2 = requestCost(BUILTIN_PRICES, u2)!;
    // input: 0.5M * $2 = $1; read: 0.5M * $0.2 = $0.1; output: 0.1M * $12 = $1.2
    expect(c2.input).toBeCloseTo(1, 9);
    expect(c2.read).toBeCloseTo(0.1, 9);
    expect(c2.output).toBeCloseTo(1.2, 9);
  });

  it('Gemini 模型费用计算（含 agy 强度后缀与 >200k 长上下文分档）', () => {
    // Gemini 4 Neon（带 agy 强度后缀）
    const uNeon = { model: 'gemini-4-neon-high', input: 200_000, create: 0, read: 800_000, output: 100_000 };
    const cNeon = requestCost(BUILTIN_PRICES, uNeon)!;
    // input: 0.2M * $3 = $0.6; read: 0.8M * $0.15 = $0.12; output: 0.1M * $15 = $1.5
    expect(cNeon.input).toBeCloseTo(0.6, 9);
    expect(cNeon.write).toBe(0);
    expect(cNeon.read).toBeCloseTo(0.12, 9);
    expect(cNeon.output).toBeCloseTo(1.5, 9);

    // Gemini 3.1 Pro 标准档（<= 200k）
    const uStd = { model: 'gemini-3.1-pro-preview', input: 100_000, create: 0, read: 100_000, output: 10_000 };
    const cStd = requestCost(BUILTIN_PRICES, uStd)!;
    expect(cStd.input).toBeCloseTo(0.2, 9);
    expect(cStd.read).toBeCloseTo(0.02, 9);
    expect(cStd.output).toBeCloseTo(0.12, 9);

    // Gemini 3.1 Pro 长上下文档（> 200k）
    const uLong = { model: 'gemini-3.1-pro-preview', input: 100_000, create: 0, read: 200_000, output: 10_000 };
    const cLong = requestCost(BUILTIN_PRICES, uLong)!;
    expect(cLong.input).toBeCloseTo(0.4, 9);
    expect(cLong.read).toBeCloseTo(0.08, 9);
    expect(cLong.output).toBeCloseTo(0.18, 9);
    // uncached 长上下文：0.3M * $4 + 0.01M * $18 = $1.38
    expect(uncachedCost(BUILTIN_PRICES, uLong)).toBeCloseTo(1.38, 9);
  });
});
