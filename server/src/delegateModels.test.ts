import { DEFAULT_AGENT_MODELS } from '@cosyee/shared';
import { describe, expect, it } from 'vitest';
import { groupModels, parseAvailable, resolveModelId, splitModelId, toModelList } from './delegate/models.js';
import { parseAgentModels, sanitizeAgentModels } from './workspaces.js';

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

describe('子代理模型配置', () => {
  it('sanitize 落回默认；parse 有非法字段就拒绝', () => {
    expect(sanitizeAgentModels(null)).toEqual(DEFAULT_AGENT_MODELS);
    const ok = { claude: { model: 'opus', effort: 'max' }, agy: { model: 'gemini-4-neon', effort: 'low' } };
    expect(sanitizeAgentModels(ok)).toEqual(ok);
    expect(parseAgentModels(ok)).toEqual(ok);
    expect(parseAgentModels({ ...ok, agy: { model: null, effort: null } })).toEqual({ ...ok, agy: { model: null, effort: null } });
    for (const bad of [null, {}, { ...ok, agy: undefined }, { ...ok, claude: { model: 'gpt', effort: 'low' } }, { ...ok, claude: { model: 'opus', effort: 'x' } }, { ...ok, agy: { model: 'a b', effort: null } }]) {
      expect(parseAgentModels(bad)).toBeNull();
    }
  });
});
