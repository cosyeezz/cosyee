// 跨轮子代理：SendMessage 恢复 / 后台子代理在新一轮继续输出。事件形状按 CLI 实测构造。
import { describe, expect, it } from 'vitest';
import { applyEvent, initState, type ConvState } from './reducer';

const user = (text: string) => ({ type: 'cosyee_user', text, at: 1 });
const toolUse = (id: string, name: string, input: unknown, msg: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: msg, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (id: string, text: string, meta?: unknown) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
  tool_use_result: meta,
});
const subText = (parent: string, text: string, msg: string) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { id: msg, role: 'assistant', content: [{ type: 'text', text }] },
});
const sys = (o: Record<string, unknown>) => ({ type: 'system', ...o });
const ok = { type: 'result', subtype: 'success', is_error: false, result: '' };

function run(events: unknown[]): ConvState {
  return events.reduce<ConvState>((s, e, i) => applyEvent(s, e, 10 + i), initState());
}

/** 第一轮：后台启动子代理 agX，随后失败 */
const launchAndFail = [
  user('做个改版'),
  toolUse('A1', 'Agent', { description: '改版', prompt: '去改', run_in_background: true }, 'm1'),
  toolResult('A1', 'Async agent launched successfully.\nagentId: agX (internal ID)', { status: 'async_launched', agentId: 'agX' }),
  sys({ subtype: 'task_started', task_id: 'agX', tool_use_id: 'A1', task_type: 'local_agent', description: '改版' }),
  sys({ subtype: 'task_updated', task_id: 'agX', patch: { status: 'failed' } }),
  ok,
];

describe('SendMessage 恢复子代理', () => {
  it('第一轮子代理失败，记录了 taskId', () => {
    const s = run(launchAndFail);
    expect(s.turns[0].status).toBe('done');
    expect(s.turns[0].subagents[0]).toMatchObject({ toolUseId: 'A1', taskId: 'agX', status: 'error' });
  });

  const resumed = [
    ...launchAndFail,
    user('继续'),
    toolUse('S1', 'SendMessage', { to: 'agX', message: '继续' }, 'm2'),
    toolResult('S1', '{"success":true,"message":"Resuming agent agX"}'),
    sys({ subtype: 'task_started', task_id: 'agX', tool_use_id: 'S1', task_type: 'local_agent', description: '改版' }),
    subText('A1', '接着干活', 'm3'),
    ok,
  ];

  it('恢复后出现在当前轮并处于运行中，输出可见；当前轮等它结束', () => {
    const s = run(resumed);
    const [t0, t1] = s.turns;
    expect(t0.subagents[0].status).toBe('error'); // 旧轮保持原样
    expect(t1.subagents).toHaveLength(1);
    expect(t1.subagents[0]).toMatchObject({ toolUseId: 'A1', title: '改版', status: 'running' });
    expect(JSON.stringify(t1.subagents[0].turn)).toContain('接着干活');
    expect(t1.status).toBe('running');
  });

  it('恢复后的通知（tool_use_id 为 SendMessage）能结束它，并收尾当前轮', () => {
    const s = run([...resumed, sys({ subtype: 'task_notification', task_id: 'agX', tool_use_id: 'S1', status: 'completed' })]);
    const t1 = s.turns[1];
    expect(t1.subagents[0].status).toBe('done');
    expect(t1.status).toBe('done');
  });

  it('没有 taskId 时按标题找回', () => {
    const noId = launchAndFail.map((e) =>
      (e as { type: string }).type === 'user' ? toolResult('A1', 'Async agent launched successfully.', { status: 'async_launched' }) : e,
    ).filter((e) => (e as { subtype?: string }).subtype !== 'task_started');
    const s = run([
      ...noId,
      sys({ subtype: 'task_notification', task_id: 'agX', tool_use_id: 'A1', status: 'failed' }),
      user('继续'),
      sys({ subtype: 'task_started', task_id: 'agX', tool_use_id: 'S1', task_type: 'local_agent', description: '改版' }),
    ]);
    expect(s.turns[1].subagents[0]).toMatchObject({ toolUseId: 'A1', status: 'running', taskId: 'agX' });
  });
});

describe('后台子代理跨轮继续输出', () => {
  it('新一轮里收到它的输出时，复制进当前轮', () => {
    const s = run([
      user('后台跑'),
      toolUse('A1', 'Agent', { description: '后台活', prompt: 'x', run_in_background: true }, 'm1'),
      toolResult('A1', 'Async agent launched successfully.\nagentId: agY', { status: 'async_launched' }),
      user('顺便问下'),
      subText('A1', '还在跑', 'm2'),
    ]);
    expect(s.turns[1].subagents[0]).toMatchObject({ toolUseId: 'A1', status: 'running' });
    expect(JSON.stringify(s.turns[1].subagents[0].turn)).toContain('还在跑');
  });

  it('不认识的 parent_tool_use_id 仍然忽略', () => {
    const s = run([user('hi'), subText('nope', 'x', 'm1')]);
    expect(s.turns[0].subagents).toHaveLength(0);
  });
});
