import { describe, expect, it } from 'vitest';
import type { CachePoint, Turn } from '@cosyee/shared';
import { growthOf } from './contextGrowth';

const pt = (i: number, total: number, turn: number, tools?: string[]): CachePoint => ({
  id: `m${i}`,
  turn,
  read: total,
  create: 0,
  input: 0,
  rate: 100,
  ...(tools ? { tools } : {}),
});

const emptyTurn = (id: string, userText = ''): Turn => ({
  id,
  userText,
  attachments: [],
  status: 'done',
  statusText: '',
  steps: [],
  answer: '',
  subagents: [],
  startedAt: 0,
});

describe('contextGrowth', () => {
  it('工具缺 summary 时用 toolLabel 兜底；委派子代理显示 delegate: 标题，原生子代理显示 Agent: 标题', () => {
    const turns: Turn[] = [
      {
        ...emptyTurn('t0', '做件事'),
        steps: [
          { kind: 'tool', id: 'c1', name: 'mcp__cosyee__delegate_agents', input: {}, summary: '', result: { content: 'a'.repeat(400), isError: false } },
          { kind: 'tool', id: 'g1', name: 'mcp__github__search', input: {}, summary: '', result: { content: 'b'.repeat(200), isError: false } },
        ],
        subagents: [
          { toolUseId: 'd1', title: '写单测', delegate: true, status: 'done', turn: { ...emptyTurn('sd', '去写单测'), answer: '写好了' } },
          { toolUseId: 'a1', title: '查代码', status: 'done', turn: { ...emptyTurn('sa', '去查代码'), answer: '查到了' } },
        ],
      },
    ];
    const g = growthOf([pt(0, 1000, 0, ['c1', 'g1', 'd1', 'a1']), pt(1, 2000, 0)], 1, turns);
    expect(g.delta).toBe(1000);
    const byId = Object.fromEntries(g.items.map((x) => [x.id, x.label]));
    expect(byId).toEqual({
      c1: 'delegate_agents',
      g1: 'mcp__github__search',
      d1: 'delegate: 写单测',
      a1: 'Agent: 查代码',
    });
  });
});
