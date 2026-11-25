import { describe, expect, it } from 'vitest';
import type { SkillLoad, SubagentRun, Turn } from '@cosyee/shared';
import { applyEvents, initState } from '../../core/reducer';
import { collectActivity } from './sessionActivity';

const mkTurn = (over: Partial<Turn> = {}): Turn => ({
  id: 't1',
  userText: 'hi',
  attachments: [],
  status: 'done',
  statusText: '',
  steps: [],
  answer: '',
  subagents: [],
  startedAt: 1,
  ...over,
});

const mkRun = (toolUseId: string, over: Partial<SubagentRun> = {}): SubagentRun => ({
  toolUseId,
  title: `任务 ${toolUseId}`,
  status: 'done',
  turn: mkTurn({ id: `sub-${toolUseId}` }),
  ...over,
});

const mkSkill = (id: string, name: string, over: Partial<SkillLoad> = {}): SkillLoad => ({
  id,
  name,
  source: 'model',
  status: 'loaded',
  ...over,
});

describe('collectActivity', () => {
  it('子代理按 toolUseId 去重：保留首次出现顺序，内容与 turnId 取最后一份', () => {
    const t1 = mkTurn({
      id: 't1',
      subagents: [
        mkRun('A1', { status: 'error', title: '旧标题' }),
        mkRun('A2', { status: 'done', title: '第二个' }),
      ],
    });
    const t2 = mkTurn({
      id: 't2',
      status: 'running',
      subagents: [
        mkRun('A1', { status: 'running', title: '恢复后' }),
        mkRun('A3', { status: 'running', title: '第三个' }),
      ],
    });
    const res = collectActivity([t1, t2], []);
    expect(res.runs.map((r) => [r.run.toolUseId, r.turnId, r.run.status, r.run.title])).toEqual([
      ['A1', 't2', 'running', '恢复后'],
      ['A2', 't1', 'done', '第二个'],
      ['A3', 't2', 'running', '第三个'],
    ]);
  });

  it('技能跨轮拼接；已结束轮里的 loading 按 loaded 处理，进行中轮保持 loading', () => {
    const t1 = mkTurn({
      id: 't1',
      status: 'interrupted',
      skills: [mkSkill('s1', 'verify', { status: 'loading' })],
    });
    const tErr = mkTurn({
      id: 'tErr',
      status: 'error',
      skills: [mkSkill('sErr', 'plan', { status: 'loading' })],
      steps: [{ kind: 'tool', id: 'mErr', name: 'mcp__err__ping', input: {}, summary: '' }],
    });
    const t2 = mkTurn({
      id: 't2',
      status: 'running',
      skills: [mkSkill('s2', 'debug', { status: 'loading' })],
    });
    const res = collectActivity([t1, tErr, t2], []);
    expect(res.skills.map((s) => [s.name, s.status])).toEqual([
      ['verify', 'loaded'],
      ['plan', 'loaded'],
      ['debug', 'loading'],
    ]);
    expect(res.mcp[0].running).toBe(false);
    expect(res.mcp[0].tools[0].running).toBe(false);
  });

  it('MCP 跨轮按服务器与工具合并：calls 拼接、callCount 累加、failed 取或；已结束轮不算 running', () => {
    const t1 = mkTurn({
      id: 't1',
      status: 'done',
      steps: [
        { kind: 'tool', id: 'm1', name: 'mcp__pw__nav', input: { u: 1 }, summary: '', result: { content: 'ok', isError: false } },
        // 已结束的轮里没等到结果的调用不算 running
        { kind: 'tool', id: 'm2', name: 'mcp__docs__search', input: { q: 'a' }, summary: '' },
      ],
    });
    const t2 = mkTurn({
      id: 't2',
      status: 'running',
      steps: [
        { kind: 'tool', id: 'm3', name: 'mcp__pw__nav', input: { u: 2 }, summary: '', result: { content: 'err', isError: true } },
        { kind: 'tool', id: 'm4', name: 'mcp__pw__click', input: {}, summary: '' },
      ],
    });
    const res = collectActivity([t1, t2], ['pw', 'docs']);
    expect(res.mcp).toHaveLength(2);
    const [pw, docs] = res.mcp;
    expect(pw.server).toBe('pw');
    expect(pw.callCount).toBe(3);
    expect(pw.failed).toBe(true);
    expect(pw.running).toBe(true);
    expect(pw.tools.map((t) => [t.tool, t.calls.length, t.failed, t.running])).toEqual([
      ['nav', 2, true, false],
      ['click', 1, false, true],
    ]);
    expect(docs.server).toBe('docs');
    expect(docs.callCount).toBe(1);
    expect(docs.running).toBe(false);
    expect(docs.tools[0].running).toBe(false);
  });

  it('mcpServers 变化时缓存失效，按新服务器列表重新拆名', () => {
    const t = mkTurn({
      id: 't1',
      status: 'done',
      steps: [{ kind: 'tool', id: 'm1', name: 'mcp__foo__bar__baz', input: {}, summary: '', result: { content: 'ok', isError: false } }],
    });
    const first = collectActivity([t], []);
    expect(first.mcp[0].server).toBe('foo');
    expect(first.mcp[0].tools[0].tool).toBe('bar__baz');

    const second = collectActivity([t], ['foo__bar']);
    expect(second.mcp[0].server).toBe('foo__bar');
    expect(second.mcp[0].tools[0].tool).toBe('baz');
  });

  it('经 reducer 回放：新用户消息与 compact_boundary 之后仍保留旧子代理', () => {
    const s = applyEvents(
      initState(),
      [
        { type: 'cosyee_user', text: '第一问', at: 1 },
        {
          type: 'assistant',
          parent_tool_use_id: null,
          message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'A1', name: 'Agent', input: { description: '旧调研', prompt: 'p' } }] },
        },
        {
          type: 'user',
          parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'A1', content: [{ type: 'text', text: '完成' }] }] },
        },
        { type: 'result', subtype: 'success', is_error: false, result: '' },
        { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 10000 } },
        { type: 'cosyee_user', text: '压缩后的新问题', at: 2 },
        { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '好的' }] } },
        { type: 'result', subtype: 'success', is_error: false, result: '' },
      ],
      100,
    );
    const act = collectActivity(s.turns, []);
    expect(act.runs).toHaveLength(1);
    expect(act.runs[0].run).toMatchObject({ toolUseId: 'A1', title: '旧调研', status: 'done' });
  });
});
