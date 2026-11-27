// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Turn } from '@cosyee/shared';
import { AnswerActions } from './AnswerActions';
import { TurnView } from './TurnView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(node: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.restoreAllMocks();
});

const turn: Turn = {
  id: 't1', userText: '', attachments: [], status: 'done', statusText: '', steps: [],
  answer: '**答案**', subagents: [], startedAt: Date.now(),
};

describe('AnswerActions', () => {
  it('两个按钮：朗读、复制；复制写入 Markdown 原文并短暂显示对勾', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const h = mount(<AnswerActions turnId="t1" text="**答案**" />);
    const btns = [...h.querySelectorAll('button')];
    expect(btns.map((b) => b.getAttribute('aria-label'))).toEqual(['朗读', '复制']);
    expect(btns[1]!.querySelector('.icon-copy')).not.toBeNull();
    act(() => { btns[1]!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith('**答案**');
    expect(btns[1]!.querySelector('.icon-check')).not.toBeNull();
  });

  it('传 onFork 时显示分支按钮，弹出两项菜单并回调 stay', () => {
    const onFork = vi.fn();
    const h = mount(<AnswerActions turnId="t1" text="**答案**" onFork={onFork} />);
    const btns = [...h.querySelectorAll('button')];
    expect(btns.map((b) => b.getAttribute('aria-label'))).toEqual(['朗读', '复制', '从这条回复分支']);

    const forkBtn = btns[2]!;
    const rows = () => [...document.querySelectorAll('.cz-menu__row')];
    act(() => { forkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(forkBtn.classList.contains('is-open')).toBe(true);
    expect(rows().map((r) => [
      r.querySelector('.cz-menu__label')?.textContent,
      r.querySelector('.cz-menu__note')?.textContent,
    ])).toEqual([
      ['分支并切过去', '保留到这条回复，在新会话里接着聊'],
      ['分支，留在当前会话', '新会话只出现在侧栏'],
    ]);

    act(() => { rows()[0]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onFork).toHaveBeenCalledWith(false);
    expect(rows()).toHaveLength(0);
    expect(forkBtn.classList.contains('is-open')).toBe(false);

    act(() => { forkBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    act(() => { rows()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onFork).toHaveBeenLastCalledWith(true);
  });
});

describe('TurnView 的回答操作行', () => {
  it('已完成且有交付文字时显示，运行中不显示', () => {
    const done = mount(<TurnView turn={turn} />);
    expect(done.querySelector('.cz-flow__actions')).not.toBeNull();
    act(() => root!.render(<TurnView turn={{ ...turn, status: 'running', answer: '' }} />));
    expect(done.querySelector('.cz-flow__actions')).toBeNull();
  });
});
