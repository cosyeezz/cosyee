// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Turn } from '@cosyee/shared';
import { TurnView } from './TurnView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: Turn = {
  id: 't',
  userText: '',
  attachments: [],
  status: 'running',
  statusText: '模型的中间文字',
  steps: [],
  answer: '',
  subagents: [],
  startedAt: Date.now(),
};

const toolSteps: Turn['steps'] = [
  { kind: 'text', text: '第一段说明' },
  { kind: 'tool', id: 'a', name: 'Bash', input: { command: 'ls' }, summary: 'Bash: ls' },
  { kind: 'text', text: '第二段说明' },
  { kind: 'tool', id: 'b', name: 'Read', input: {}, summary: 'Read: a.ts' },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(turn: Turn) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<TurnView turn={turn} />));
  const status = () => host!.querySelector('.cz-flow__status') as HTMLElement;
  return {
    host: host!,
    status,
    answer: () => host!.querySelector('.cz-flow__answer')?.textContent ?? '',
    steps: () => host!.querySelector('.cz-flow__steps'),
    click: () => act(() => status().click()),
  };
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('TurnView', () => {
  it('进行中：固定「正在处理」+ 神经脉冲图标，不显示 statusText，无箭头', () => {
    const v = mount(base);
    expect(v.status().textContent).toContain('正在处理');
    expect(v.host.querySelector('.cz-st-tool')).not.toBeNull();
    expect(v.host.querySelector('.cz-ss-tool')).not.toBeNull();
    expect(v.host.textContent).not.toContain('模型的中间文字');
    expect(v.host.querySelector('.icon-chevron')).toBeNull();
  });

  it('无步骤时状态行不可点击', () => {
    const v = mount(base);
    expect(v.status().tagName).toBe('DIV');
    expect(v.status().hasAttribute('aria-expanded')).toBe(false);
  });

  it('下方只显示模型文字（最后一段），不显示工具行；点击整行展开后只显示 answer', () => {
    const v = mount({ ...base, steps: toolSteps });
    expect(v.status().tagName).toBe('BUTTON');
    expect(v.status().getAttribute('aria-expanded')).toBe('false');
    expect(v.answer()).toContain('第二段说明');
    expect(v.host.textContent).not.toContain('第一段说明');
    expect(v.host.textContent).not.toContain('Bash: ls');

    v.click();
    expect(v.status().getAttribute('aria-expanded')).toBe('true');
    expect(v.steps()).not.toBeNull();
    expect(v.steps()!.textContent).toContain('第一段说明');
    // 展开后最后一段文字已在展开区里，下方不再重复
    expect(v.host.querySelector('.cz-flow__answer')).toBeNull();

    v.click();
    expect(v.steps()).toBeNull();
  });

  it('结束后最终答复保留，状态行为「已完成」', () => {
    const v = mount({ ...base, status: 'done', steps: toolSteps, endedAt: base.startedAt + 3000, answer: '最终答复' });
    expect(v.status().textContent).toContain('已完成');
    expect(v.status().textContent).toContain('共 4 步');
    expect(v.answer()).toContain('最终答复');
    expect(v.host.querySelector('.is-streaming')).toBeNull();
    expect(v.host.querySelector('.cz-st-done')).not.toBeNull();
  });
});
