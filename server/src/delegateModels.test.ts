import { DEFAULT_SUBAGENTS } from '@cosyee/shared';
import { describe, expect, it } from 'vitest';
import { groupModels, parseAvailable, resolveModelId, splitModelId, toModelList } from './delegate/models.js';
import { migrateSubagents, parseSubagents, sanitizeSubagents } from './workspaces.js';

const available = parseAvailable({
  availableModels: [
    { modelId: 'gemini-4-neon-high', name: 'Gemini 4 Neon (High)' },
    { modelId: 'gemini-4-neon-low', name: 'Gemini 4 Neon (Low)' },
    { modelId: 'gemini-4-neon-medium', name: 'Gemini 4 Neon (Medium)' },
    { modelId: 'orch', name: 'Orchestrator (Beta)' },
    { modelId: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
    { modelId: '' },
    null,
  ],
});

describe('agy 模型 id', () => {
  it('拆分与归组', () => {
    expect(splitModelId('gemini-4-neon-xhigh')).toEqual({ model: 'gemini-4-neon', effort: 'xhigh' });
    expect(splitModelId('orch')).toEqual({ model: 'orch', effort: null });
    expect(groupModels(available)).toEqual([
      { value: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high'] },
      { value: 'orch', displayName: 'Orchestrator (Beta)', efforts: [] },
      { value: 'gpt-oss-120b', displayName: 'GPT-OSS 120B', efforts: ['medium'] },
    ]);
    expect(toModelList(available, 'gemini-4-neon-high', 1).current).toEqual({ model: 'gemini-4-neon', effort: 'high' });
    expect(parseAvailable(undefined)).toEqual([]);
  });

  const r = (o: Partial<Parameters<typeof resolveModelId>[1]>, list = available) =>
    resolveModelId(list, { strictEffort: false, current: 'gemini-4-neon-high', ...o });
  it('基础模型 + 强度；完整 id；只给强度', () => {
    expect(r({ model: 'gemini-4-neon', effort: 'low', strictEffort: true })).toEqual({ id: 'gemini-4-neon-low' });
    expect(r({ model: 'gemini-4-neon-medium' })).toEqual({ id: 'gemini-4-neon-medium' });
    expect(r({ effort: 'low', strictEffort: true })).toEqual({ id: 'gemini-4-neon-low' });
    expect(r({ model: 'gemini-4-neon', current: null })).toEqual({ id: 'gemini-4-neon-high' });
  });
  it('默认强度落到最近一档，让位给完整 id；点名的强度不支持就报错', () => {
    expect(r({ model: 'gemini-4-neon', effort: 'max' })).toEqual({ id: 'gemini-4-neon-high' });
    expect(r({ model: 'gpt-oss-120b', effort: 'high' })).toEqual({ id: 'gpt-oss-120b-medium' });
    expect(r({ model: 'orch', effort: 'high' })).toEqual({ id: 'orch' });
    expect(r({ model: 'gemini-4-neon-low', effort: 'high' })).toEqual({ id: 'gemini-4-neon-low' });
    expect(r({ model: 'gemini-4-neon-low', effort: 'high', strictEffort: true })).toEqual({ id: 'gemini-4-neon-high' });
    expect(r({ model: 'gemini-4-neon', effort: 'max', strictEffort: true })).toMatchObject({ error: expect.stringContaining('low, medium, high') });
    expect(r({ model: 'orch', effort: 'high', strictEffort: true })).toHaveProperty('error');
    expect(r({ model: 'nope' })).toMatchObject({ error: expect.stringContaining('gemini-4-neon, orch, gpt-oss-120b') });
  });
  it('没有列表时原样透传', () => {
    expect(r({ model: 'x' }, [])).toEqual({ id: 'x' });
    expect(r({ model: 'x', effort: 'low' }, [])).toEqual({ id: 'x-low' });
    expect(r({ effort: 'low', strictEffort: true, current: null }, [])).toHaveProperty('error');
  });
});

describe('子代理配置与迁移', () => {
  it('sanitize 落回默认；parse 有非法字段就拒绝', () => {
    expect(sanitizeSubagents(null)).toEqual(DEFAULT_SUBAGENTS);
    const ok = {
      kind: 'claude' as const,
      native: { model: 'opus' as const, effort: 'max' as const },
      claude: { model: 'sonnet' as const, effort: 'high' as const },
      agy: { model: 'gemini-4-neon', effort: 'low' as const },
    };
    expect(sanitizeSubagents(ok)).toEqual(ok);
    expect(parseSubagents(ok)).toEqual(ok);
    const withNulls = { ...ok, kind: 'agy' as const, claude: { model: null, effort: null }, agy: { model: null, effort: null } };
    expect(parseSubagents(withNulls)).toEqual(withNulls);
    for (const bad of [
      null,
      {},
      { ...ok, kind: 'other' },
      { ...ok, native: undefined },
      { ...ok, claude: undefined },
      { ...ok, agy: undefined },
      { ...ok, native: { model: 'gpt', effort: 'low' } },
      { ...ok, native: { model: 'opus', effort: 'x' } },
      { ...ok, claude: { model: 'gpt', effort: null } },
      { ...ok, claude: { model: null, effort: 'x' } },
      { ...ok, agy: { model: 'a b', effort: null } },
      { ...ok, agy: { model: null, effort: 'bad' } },
    ]) {
      expect(parseSubagents(bad)).toBeNull();
    }
  });

  it('migrateSubagents：老数据从 agentModels + nativeAgents 迁移，已有 subagents 优先', () => {
    // 空对象 -> 默认配置
    expect(migrateSubagents({})).toEqual(DEFAULT_SUBAGENTS);
    // nativeAgents: false -> kind: 'agy'，老 agentModels.claude -> native，agentModels.agy -> agy
    expect(
      migrateSubagents({
        nativeAgents: false,
        agentModels: {
          claude: { model: 'opus', effort: 'high' },
          agy: { model: 'gemini-4-neon', effort: 'low' },
        },
      }),
    ).toEqual({
      kind: 'agy',
      native: { model: 'opus', effort: 'high' },
      claude: { model: null, effort: null },
      agy: { model: 'gemini-4-neon', effort: 'low' },
    });
    // nativeAgents: true -> kind: 'native'
    expect(
      migrateSubagents({
        nativeAgents: true,
        agentModels: { claude: { model: 'haiku', effort: 'low' }, agy: { model: null, effort: null } },
      }),
    ).toEqual({
      kind: 'native',
      native: { model: 'haiku', effort: 'low' },
      claude: { model: null, effort: null },
      agy: { model: null, effort: null },
    });
    // 已有 subagents 时忽略旧字段
    expect(
      migrateSubagents({
        nativeAgents: false,
        agentModels: { claude: { model: 'opus', effort: 'max' }, agy: { model: 'old', effort: 'low' } },
        subagents: {
          kind: 'claude',
          native: { model: 'sonnet', effort: 'medium' },
          claude: { model: 'haiku', effort: 'low' },
          agy: { model: null, effort: null },
        },
      }),
    ).toEqual({
      kind: 'claude',
      native: { model: 'sonnet', effort: 'medium' },
      claude: { model: 'haiku', effort: 'low' },
      agy: { model: null, effort: null },
    });
  });
});
