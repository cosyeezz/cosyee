import { describe, expect, it } from 'vitest';
import type { CachePoint, CompactMark, SessionMeta, Turn } from '@cosyee/shared';
import { buildDividers, placeDividers } from './dividers';
import { isHiddenTurn } from './format';
import { groupSteered } from './mergeSteer';

function makeTurn(id: string, over: Partial<Turn> = {}): Turn {
  return {
    id,
    userText: `问题 ${id}`,
    attachments: [],
    status: 'done',
    statusText: '',
    steps: [],
    answer: '答复',
    subagents: [],
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    ...over,
  };
}

function pt(id: string, turn: number, model?: string): CachePoint {
  return { id, turn, input: 100, create: 0, read: 0, rate: 0, ...(model !== undefined ? { model } : {}) };
}

function cmp(id: string, over: Partial<CompactMark> = {}): CompactMark {
  return {
    id,
    turn: 1,
    trigger: 'manual',
    pre: 182_400,
    post: 24_100,
    durationMs: 12_000,
    after: null,
    at: 1_700_000_010_000,
    ...over,
  };
}

describe('buildDividers', () => {
  it('meta 为空或无记录时返回空数组', () => {
    const turns = [makeTurn('t0')];
    expect(buildDividers(turns, undefined)).toEqual([]);
    expect(buildDividers(turns, {})).toEqual([]);
  });

  it('模型切换：首个模型不算切换，跳过无 model 的点，按是否该轮首点决定 before / after', () => {
    const turns = [makeTurn('t0'), makeTurn('t1'), makeTurn('t2')];
    const meta: SessionMeta = {
      cache: [
        pt('m0', 0), // 无 model，跳过（但仍占第 0 轮首点）
        pt('m1', 0, 'claude-opus-4-6'), // 会话首个有 model 的点，不算切换
        pt('m2', 1), // 第 1 轮首点无 model
        pt('m3', 1, 'claude-sonnet-4-6'), // 第 1 轮中途切模型 → after turn 1
        pt('m4', 2, 'claude-sonnet-4-6'), // 同模型，不生成
        pt('m5', 2, 'claude-haiku-4-5-20251001'), // 第 2 轮中途再切 → after turn 2
        pt('m6', 3, 'claude-opus-4-6'), // 第 3 轮首点切回 → before turn 3
      ],
    };

    const res = buildDividers(turns, meta);
    expect(res).toHaveLength(3);
    expect(res[0]).toMatchObject({
      key: 'model:m3',
      kind: 'model',
      text: '已切换到 Sonnet 4.6',
      anchor: { turn: 1, pos: 'after' },
    });
    expect(res[0]!.title).toContain('claude-sonnet-4-6');
    expect(res[1]).toMatchObject({
      key: 'model:m5',
      kind: 'model',
      text: '已切换到 Haiku 4.5',
      anchor: { turn: 2, pos: 'after' },
    });
    expect(res[2]).toMatchObject({
      key: 'model:m6',
      kind: 'model',
      text: '已切换到 Opus 4.6',
      anchor: { turn: 3, pos: 'before' },
    });
  });

  it('压缩：按 after 所在轮决定 before / after，格式化手动/自动、post 为 null、durationMs 为 null 与 title', () => {
    const turns = [makeTurn('t0'), makeTurn('t1', { local: true, answer: '' }), makeTurn('t2')];
    const meta: SessionMeta = {
      cache: [pt('m0', 0, 'claude-sonnet-4-6'), pt('m1', 2, 'claude-sonnet-4-6')],
      compactions: [
        // 会话开头（after: null）→ before 0
        cmp('c0', { turn: 0, trigger: 'auto', pre: 182_400, post: 24_100, durationMs: 12_000, after: null }),
        // 隐藏轮手动 /compact（after 在上一轮 0 < 1）→ before 1
        cmp('c1', { turn: 1, trigger: 'manual', pre: 95_600, post: null, durationMs: null, after: 'm0' }),
        // 轮中途自动压缩（after 在本轮 2 === 2）→ after 2
        cmp('c2', { turn: 2, trigger: 'auto', pre: 150_000, post: 30_000, durationMs: 65_000, after: 'm1' }),
      ],
    };

    const res = buildDividers(turns, meta);
    expect(res).toHaveLength(3);

    expect(res[0]).toMatchObject({
      key: 'compact:c0',
      kind: 'compact',
      text: '已自动压缩上下文 · 182k → 24k · 12 秒',
      anchor: { turn: 0, pos: 'before' },
    });
    expect(res[0]!.title).toContain('182,400 → 24,100 tokens');

    expect(res[1]).toMatchObject({
      key: 'compact:c1',
      kind: 'compact',
      text: '已压缩上下文 · 96k',
      anchor: { turn: 1, pos: 'before' },
    });
    expect(res[1]!.title).toContain('95,600 tokens');
    expect(res[1]!.title).not.toContain('耗时');

    expect(res[2]).toMatchObject({
      key: 'compact:c2',
      kind: 'compact',
      text: '已自动压缩上下文 · 150k → 30k · 1 分 5 秒',
      anchor: { turn: 2, pos: 'after' },
    });
  });

  it('同位置连续多条事件按发生顺序排列', () => {
    const turns = [makeTurn('t0'), makeTurn('t1')];
    const meta: SessionMeta = {
      cache: [
        pt('m0', 0, 'claude-opus-4-6'),
        pt('m1', 0, 'claude-sonnet-4-6'), // 第 0 轮中途切模型
        pt('m2', 0, 'claude-haiku-4-5-20251001'), // 压缩后又切模型
      ],
      compactions: [
        cmp('c1', { turn: 0, trigger: 'auto', after: 'm1' }), // 发生在 m1 之后、m2 之前
      ],
    };

    const res = buildDividers(turns, meta);
    expect(res.map((d) => d.key)).toEqual(['model:m1', 'compact:c1', 'model:m2']);
  });
});

describe('placeDividers', () => {
  it('隐藏轮（如手动 /compact）自动跳过到下一个可见组之前；末尾隐藏轮落到 trailing', () => {
    const allTurns = [
      makeTurn('t0'),
      makeTurn('t1', { local: true, answer: '' }), // 中间的 /compact
      makeTurn('t2'),
      makeTurn('t3', { local: true, answer: '' }), // 末尾刚执行的 /compact
    ];
    const visible = allTurns.filter((t) => !isHiddenTurn(t));
    const groups = groupSteered(visible);

    const meta: SessionMeta = {
      cache: [pt('m0', 0, 'claude-opus-4-6'), pt('m1', 2, 'claude-sonnet-4-6')],
      compactions: [
        cmp('c1', { turn: 1, trigger: 'manual', after: 'm0' }),
        cmp('c2', { turn: 3, trigger: 'manual', after: 'm1' }),
      ],
    };

    const placed = placeDividers(allTurns, groups, buildDividers(allTurns, meta));
    expect(placed.beforeGroup[0]).toEqual([]);
    // 隐藏轮 1 的压缩与第 2 轮的模型切换都落在可见组 1（t2）之前，且压缩在前
    expect(placed.beforeGroup[1]!.map((d) => d.key)).toEqual(['compact:c1', 'model:m1']);
    expect(placed.afterGroup[0]).toEqual([]);
    expect(placed.afterGroup[1]).toEqual([]);
    // 末尾隐藏轮 3 的压缩落到 trailing
    expect(placed.trailing.map((d) => d.key)).toEqual(['compact:c2']);
  });

  it('插话合并组内部的锚点自然落到该组之前或之后', () => {
    // t0 未交付（answer 为空）+ t1 为插话 → 合并成第 0 组
    const allTurns = [
      makeTurn('t0', { answer: '' }),
      makeTurn('t1', { steer: true, answer: '合并答复' }),
      makeTurn('t2'),
    ];
    const groups = groupSteered(allTurns);
    expect(groups).toHaveLength(2);

    const meta: SessionMeta = {
      cache: [
        pt('m0', 0, 'claude-opus-4-6'),
        pt('m1', 1, 'claude-sonnet-4-6'), // 锚点 before 1（落在合并组内部）→ 放该组之前
      ],
      compactions: [
        cmp('c0', { turn: 0, trigger: 'auto', after: 'm0' }), // 锚点 after 0（落在合并组内部）→ 放该组之后
      ],
    };

    const placed = placeDividers(allTurns, groups, buildDividers(allTurns, meta));
    expect(placed.beforeGroup[0]!.map((d) => d.key)).toEqual(['model:m1']);
    expect(placed.afterGroup[0]!.map((d) => d.key)).toEqual(['compact:c0']);
    expect(placed.trailing).toEqual([]);
  });

  it('锚点下标越界（如回退边界）不抛错，自然落到末尾或忽略', () => {
    const allTurns = [makeTurn('t0')];
    const groups = groupSteered(allTurns);
    const meta: SessionMeta = {
      cache: [pt('m0', 0, 'claude-opus-4-6'), pt('m1', 99, 'claude-sonnet-4-6')],
      compactions: [
        cmp('c-neg', { turn: -1, after: null }),
        cmp('c-high', { turn: 50, after: 'm0' }),
      ],
    };

    const placed = placeDividers(allTurns, groups, buildDividers(allTurns, meta));
    // 负下标被忽略，超出末尾的 before 落到 trailing
    expect(placed.beforeGroup[0]).toEqual([]);
    expect(placed.trailing.map((d) => d.key)).toEqual(['compact:c-high', 'model:m1']);
  });
});
