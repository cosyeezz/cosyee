import { DEFAULT_SUBAGENTS, type SubagentConfig } from '@cosyee/shared';
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
    const ok: SubagentConfig = {
      mode: 'delegate',
      native: { model: 'opus', effort: 'max' },
      delegate: {
        default: { backend: 'claude', accountId: 'default', model: 'sonnet', effort: 'high' },
        agents: {
          Explore: { backend: 'agy', accountId: 'agy1', model: 'gemini-4-neon', effort: 'low' },
        },
      },
    };
    expect(sanitizeSubagents(ok)).toEqual(ok);
    expect(parseSubagents(ok)).toEqual(ok);
    const withNulls: SubagentConfig = {
      mode: 'delegate',
      native: { model: 'opus', effort: 'max' },
      delegate: { default: { backend: 'agy', accountId: 'agy1', model: null, effort: null } },
    };
    expect(parseSubagents(withNulls)).toEqual(withNulls);
    expect(parseSubagents({ ...ok, delegate: { default: null } })).toEqual({
      mode: 'delegate',
      native: { model: 'opus', effort: 'max' },
      delegate: { default: null },
    });
    for (const bad of [
      null,
      {},
      { ...ok, mode: 'other' },
      { ...ok, native: undefined },
      { ...ok, delegate: undefined },
      { ...ok, native: { model: 'gpt', effort: 'low' } },
      { ...ok, native: { model: 'opus', effort: 'x' } },
      { ...ok, delegate: { default: { backend: 'unknown', accountId: 'default', model: null, effort: null } } },
      { ...ok, delegate: { default: { backend: 'claude', accountId: 'bad id!', model: null, effort: null } } },
      { ...ok, delegate: { default: null, agents: [] } },
    ]) {
      expect(parseSubagents(bad)).toBeNull();
    }
  });

  it('migrateSubagents：老数据从 agentModels + nativeAgents 迁移，已有 subagents 优先', () => {
    // 空对象 -> 默认配置
    expect(migrateSubagents({})).toEqual(DEFAULT_SUBAGENTS);
    // nativeAgents: false 且有 agy 账号 -> mode: 'delegate'，老 agentModels.claude -> native，agentModels.agy -> delegate.default
    expect(
      migrateSubagents({
        nativeAgents: false,
        agyAccounts: { list: [{ id: 'agy1', label: 'A', dir: '/tmp/agy1', createdAt: 1 }], active: 'agy1' },
        agentModels: {
          claude: { model: 'opus', effort: 'high' },
          agy: { model: 'gemini-4-neon', effort: 'low' },
        },
      }),
    ).toEqual({
      mode: 'delegate',
      native: { model: 'opus', effort: 'high' },
      delegate: { default: { backend: 'agy', accountId: 'agy1', model: 'gemini-4-neon', effort: 'low' } },
    });
    // nativeAgents: false 但无 agy 账号 -> 退回 native
    expect(
      migrateSubagents({
        nativeAgents: false,
        agentModels: {
          claude: { model: 'opus', effort: 'high' },
          agy: { model: 'gemini-4-neon', effort: 'low' },
        },
      }),
    ).toEqual({
      mode: 'native',
      native: { model: 'opus', effort: 'high' },
      delegate: { default: null },
    });
    // nativeAgents: true -> mode: 'native'
    expect(
      migrateSubagents({
        nativeAgents: true,
        agentModels: { claude: { model: 'haiku', effort: 'low' }, agy: { model: null, effort: null } },
      }),
    ).toEqual({
      mode: 'native',
      native: { model: 'haiku', effort: 'low' },
      delegate: { default: null },
    });
    // 已有 subagents（旧 kind 结构）时忽略更老的 nativeAgents / agentModels，按 kind 迁移
    expect(
      migrateSubagents({
        nativeAgents: false,
        agentModels: { claude: { model: 'opus', effort: 'max' }, agy: { model: 'old', effort: 'low' } },
        accounts: { subagent: { claude: 'acc1' } },
        subagents: {
          kind: 'claude',
          native: { model: 'sonnet', effort: 'medium' },
          claude: { model: 'haiku', effort: 'low' },
          agy: { model: null, effort: null },
        },
      }),
    ).toEqual({
      mode: 'delegate',
      native: { model: 'sonnet', effort: 'medium' },
      delegate: { default: { backend: 'claude', accountId: 'acc1', model: 'haiku', effort: 'low' } },
    });
  });
});
