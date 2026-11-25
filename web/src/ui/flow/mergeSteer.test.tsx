// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SubagentRun, Turn } from '@cosyee/shared';
import { ConversationView } from './ConversationView';
import { latestOutputLine } from './format';
import { groupSteered } from './mergeSteer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const turn = (id: string, extra: Partial<Turn> = {}): Turn => ({
  id,
  userText: `消息 ${id}`,
  attachments: [],
  status: 'done',
  statusText: '',
  steps: [],
  answer: '',
  subagents: [],
  startedAt: 1000,
  endedAt: 2000,
  ...extra,
});
const text = (s: string): Turn['steps'][number] => ({ kind: 'text', text: s });
const tool = (id: string): Turn['steps'][number] => ({ kind: 'tool', id, name: 'Bash', input: { command: 'ls' }, summary: 'Bash: ls' });

// 两次都停在工具调用上就被插话接上，最后一轮还在跑
const a = turn('t0', { userId: 'u0', steps: [text('我先查它'), tool('x')], startedAt: 1000 });
const b = turn('t1', { userId: 'u1', steer: true, steps: [text('补充收到'), tool('y')], startedAt: 2000, endedAt: 3000 });
const c = turn('t2', { userId: 'u2', steer: true, status: 'understanding', startedAt: 3000, endedAt: undefined });

describe('groupSteered', () => {
  const ids = (ts: Turn[]) => groupSteered(ts).map((g) => g.parts.map((p) => p.id));

  it('未交付的轮与后面的插话合成一组：步骤相接，状态取最后一轮，计时从第一轮起', () => {
    const [g, ...rest] = groupSteered([a, b, c]);
    expect(rest).toHaveLength(0);
    expect(g!.parts).toEqual([a, b, c]);
    expect(g!.turn).toMatchObject({ id: 't0', status: 'understanding', startedAt: 1000 });
    expect(g!.turn.endedAt).toBeUndefined();
    expect(g!.turn.steps).toEqual([...a.steps, ...b.steps]);
  });

  it('上一轮已有最终答复、被中断、出错，或后一轮不是插话：不合并', () => {
    expect(ids([turn('t0', { answer: '答复' }), b])).toEqual([['t0'], ['t1']]);
    expect(ids([turn('t0', { status: 'interrupted' }), b])).toEqual([['t0'], ['t1']]);
    expect(ids([turn('t0', { status: 'error' }), b])).toEqual([['t0'], ['t1']]);
    expect(ids([a, turn('t1')])).toEqual([['t0'], ['t1']]);
  });

  it('插话轮交付之后，再来的插话另起一组', () => {
    expect(ids([a, { ...b, answer: '好了' }, c])).toEqual([['t0', 't1'], ['t2']]);
  });

  it('轮对象没变时组的引用不变；没有合并时 turn 就是原对象', () => {
    const d = turn('t3', { answer: '答复' });
    const x = groupSteered([a, b, d]);
    expect(x[1]!.turn).toBe(d);
    expect(groupSteered([a, b, d])[0]).toBe(x[0]);
    expect(groupSteered([a, { ...b }, d])[0]).not.toBe(x[0]);
    expect(groupSteered([{ ...a }, b, d])[0]).not.toBe(x[0]);
  });

  it('子代理的 afterStep 平移；同一个子代理只留最后一份', () => {
    const run = (title: string, afterStep: number): SubagentRun =>
      ({ toolUseId: 'S', title, status: 'done', afterStep, turn: turn('s') }) as SubagentRun;
    const g = groupSteered([{ ...a, subagents: [run('旧', 1)] }, { ...b, subagents: [run('新', 2)] }])[0]!;
    expect(g.turn.subagents.map((r) => [r.title, r.afterStep])).toEqual([['新', 4]]);
    expect(latestOutputLine(g.turn)).toBe('委派子代理：新');
  });
});

describe('ConversationView：插话合并', () => {
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const render = (turns: Turn[]): HTMLElement => {
    if (!host) {
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
    }
    act(() => root!.render(<ConversationView turns={turns} onFork={() => {}} />));
    return host;
  };
  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
  });

  it('三条气泡 + 一个状态行，没有「已完成」和过程文字；原来的轮 id 都能定位到', () => {
    const h = render([a, b, c]);
    expect(Array.from(h.querySelectorAll('.cz-umd')).map((e) => e.textContent?.trim())).toEqual(['消息 t0', '消息 t1', '消息 t2']);
    expect(h.querySelectorAll('.cz-flow__status')).toHaveLength(1);
    expect(h.textContent).not.toContain('已完成');
    expect(h.querySelector('.cz-flow__answer')).toBeNull();
    expect(h.querySelector('.cz-flow__item[data-turn-id~="t1"]')).not.toBeNull();
  });

  it('插话并进来时沿用原来的节点，展开状态不丢', () => {
    const h = render([{ ...a, status: 'running', endedAt: undefined }]);
    act(() => (h.querySelector('button.cz-flow__status') as HTMLElement).click());
    expect(h.querySelector('.cz-flow__steps')).not.toBeNull();
    render([a, c]);
    expect(h.querySelectorAll('.cz-flow__item')).toHaveLength(1);
    expect(h.querySelector('.cz-flow__steps')).not.toBeNull();
  });

  it('最后交付：只有一个「已完成」，步数与用时按整组算', () => {
    const h = render([a, b, { ...c, status: 'done', answer: '最终答复', endedAt: 61_000 }]);
    expect(h.querySelectorAll('.cz-st-done')).toHaveLength(1);
    expect(h.querySelector('.cz-flow__status')!.textContent).toMatch(/共 4 步 · 用时 1 分 0 秒$/);
    expect(h.querySelector('.cz-flow__answer')!.textContent).toContain('最终答复');
  });
});
