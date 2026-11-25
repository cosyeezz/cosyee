import { describe, expect, it } from 'vitest';
import type { Step, Turn } from '@cosyee/shared';
import { agentRows, callsOf, skillCallCounts, skillCallsOf, toolCallCounts, toolLabel, toolRows, totalCallsOf, totalSkillCallsOf } from './tools';

describe('toolRows', () => {
  it('Cosyee 自带的 mcp__cosyee__* 工具归到工具列表，其它 MCP 工具仍排除', () => {
    expect(toolRows(['Bash', 'mcp__cosyee__delegate', 'mcp__github__search'], ['mcp__cosyee__other', 'mcp__x__y'])).toEqual([
      { name: 'Bash', enabled: true },
      { name: 'mcp__cosyee__delegate', enabled: true },
      { name: 'mcp__cosyee__other', enabled: false },
    ]);
  });

  it('init 工具在前、仅停用的在后；去重；排除 mcp__ 与非法名字', () => {
    expect(
      toolRows(['Bash', 'mcp__a__b', 'Read', 'Bash', 'bad name'], ['Read', 'Notebook', 'mcp__x__y', 'Notebook', '']),
    ).toEqual([
      { name: 'Bash', enabled: true },
      { name: 'Read', enabled: false },
      { name: 'Notebook', enabled: false },
    ]);
  });
  it('入参缺省时返回空', () => {
    expect(toolRows(undefined, undefined)).toEqual([]);
  });
});

describe('toolCallCounts / callsOf', () => {
  const tool = (name: string) => ({ kind: 'tool' as const, id: name + Math.random(), name, input: {}, summary: name });
  const turn = (steps: Step[], subagents: Turn['subagents'] = []): Turn => ({
    id: 't', userText: '', attachments: [], status: 'done', statusText: '', steps, answer: '', subagents, startedAt: 0,
  });
  it('按名字累计主线程与子智能体内的调用；派发子任务记作 Agent', () => {
    const sub = turn([tool('Read'), tool('Grep')]);
    const turns = [
      turn([tool('Read'), { kind: 'text', text: 'x' }, tool('Bash')]),
      turn([tool('Read')], [{ toolUseId: 'a', title: 'd', status: 'done', turn: sub }]),
    ];
    const c = toolCallCounts(turns);
    expect(c.get('Read')).toEqual({ main: 2, sub: 1 });
    expect(c.get('Grep')).toEqual({ main: 0, sub: 1 });
    expect(c.get('Agent')).toEqual({ main: 1, sub: 0 });
    expect(callsOf(c, 'Task')).toEqual({ main: 1, sub: 0 });
    expect(callsOf(c, 'Write')).toEqual({ main: 0, sub: 0 });
  });
  it('委派子代理记作 mcp__cosyee__delegate，不算进 Agent，也不把其内部步骤计入 Claude 工具', () => {
    const sub = turn([tool('Read'), tool('Bash')]);
    const c = toolCallCounts([turn([], [{ toolUseId: 'd', title: 'd', delegate: true, subagentType: 'Explore', status: 'done', turn: sub }])]);
    expect(c.get('mcp__cosyee__delegate')).toEqual({ main: 1, sub: 0 });
    expect(c.get('Agent')).toBeUndefined();
    expect(c.get('Read')).toBeUndefined();
    expect(c.get('Bash')).toBeUndefined();
  });
  it('toolLabel 去掉 mcp__cosyee__ 前缀，其余原样', () => {
    expect(toolLabel('mcp__cosyee__delegate')).toBe('delegate');
    expect(toolLabel('mcp__github__search')).toBe('mcp__github__search');
    expect(toolLabel('Bash')).toBe('Bash');
  });
  it('没有会话流时为空', () => {
    expect(toolCallCounts(undefined).size).toBe(0);
  });
});

describe('totalCallsOf', () => {
  it('按名字取所有会话的累计次数；Agent 与 Task 合在一起；没有数据为 0', () => {
    const counts = { Bash: 5, Task: 3, Agent: 2 };
    expect(totalCallsOf(counts, 'Bash')).toBe(5);
    expect(totalCallsOf(counts, 'Read')).toBe(0);
    expect(totalCallsOf(counts, 'Agent')).toBe(5);
    expect(totalCallsOf(counts, 'Task')).toBe(5);
    expect(totalCallsOf(undefined, 'Bash')).toBe(0);
  });
});

describe('skillCallCounts / skillCallsOf / totalSkillCallsOf', () => {
  const turn = (skills: Turn['skills'], subagents: Turn['subagents'] = []): Turn => ({
    id: 't', userText: '', attachments: [], status: 'done', statusText: '', steps: [], answer: '', subagents, skills, startedAt: 0,
  });
  it('按来源累计主线程与子智能体的加载；失败的不算；带前缀的 skill 也认不带前缀的写法', () => {
    const sub = turn([{ id: 'c', name: 'pdf', source: 'model', status: 'loaded' }]);
    const turns = [
      turn([
        { id: 'a', name: 'anthropic-skills:pdf', source: 'model', status: 'loaded' },
        { id: 'b', name: 'anthropic-skills:pdf', source: 'model', status: 'error' },
        { id: 'user:t', name: 'anthropic-skills:pdf', source: 'user', status: 'loaded' },
      ]),
      turn(undefined, [{ toolUseId: 'x', title: 'd', status: 'done', turn: sub }]),
    ];
    const c = skillCallCounts(turns);
    expect(skillCallsOf(c, 'anthropic-skills:pdf')).toEqual({ model: 1, user: 1, sub: 1 });
    // 不带前缀的 skill 只认完整名
    expect(skillCallsOf(c, 'pdf')).toEqual({ model: 0, user: 0, sub: 1 });
    expect(skillCallsOf(c, 'docx')).toEqual({ model: 0, user: 0, sub: 0 });
  });
  it('累计次数：服务端没有数据为 null', () => {
    expect(totalSkillCallsOf({ 'p:pdf': 2, pdf: 3, other: 1 }, 'p:pdf')).toBe(5);
    expect(totalSkillCallsOf({ 'p:pdf': 2, pdf: 3 }, 'pdf')).toBe(3);
    expect(totalSkillCallsOf({}, 'pdf')).toBe(0);
    expect(totalSkillCallsOf(undefined, 'pdf')).toBeNull();
  });
});

describe('agentRows', () => {
  it('init 智能体在前，合并自定义智能体的 token，再并上已关闭的；去重', () => {
    expect(agentRows(['general-purpose', 'Explore', 'mine'], [{ name: 'mine', tokens: 120 }, { name: 'other', tokens: 30 }], ['Explore', 'gone'])).toEqual([
      { name: 'general-purpose', enabled: true, tokens: null },
      { name: 'Explore', enabled: false, tokens: null },
      { name: 'mine', enabled: true, tokens: 120 },
      { name: 'other', enabled: true, tokens: 30 },
      { name: 'gone', enabled: false, tokens: null },
    ]);
  });
});
