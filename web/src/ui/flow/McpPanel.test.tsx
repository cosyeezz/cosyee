// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Turn } from '@cosyee/shared';
import { SessionDock } from './SessionDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const steps: Turn['steps'] = [
  { kind: 'tool', id: '1', name: 'mcp__pw__nav', input: { url: 'http://x' }, summary: '', result: { content: [{ type: 'text', text: '导航成功' }], isError: false } },
  { kind: 'tool', id: '2', name: 'mcp__pw__nav', input: { url: 'http://y' }, summary: '', result: { content: 'boom', isError: true } },
  { kind: 'tool', id: '3', name: 'mcp__pw__click', input: { ref: 'e1' }, summary: '', result: { content: 'ok', isError: false } },
  { kind: 'tool', id: '4', name: 'mcp__docs__q', input: {}, summary: '' },
  { kind: 'tool', id: '5', name: 'Bash', input: {}, summary: '' },
];

const mkTurn = (s: Turn['steps']): Turn => ({
  id: 't1',
  userText: 'hi',
  attachments: [],
  status: 'running',
  statusText: '',
  steps: s,
  answer: '',
  subagents: [],
  startedAt: 1,
});

async function mount(s: Turn['steps']) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<SessionDock turns={[mkTurn(s)]} sessionKey="s1" />));
}
const toolBtns = () => [...host!.querySelectorAll<HTMLButtonElement>('.cz-flow__mcp-tool')];
const click = async (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('McpList（经 SessionDock 展示）', () => {
  it('没有 MCP 调用时不渲染', async () => {
    await mount([steps[4]]);
    expect(host!.innerHTML).toBe('');
  });

  it('头部计数、工具摘要、失败标红、运行中流光', async () => {
    await mount(steps);
    expect(host!.textContent).toContain('2 个 MCP 服务');
    expect(host!.querySelector('.cz-st-compacting')).not.toBeNull(); // docs 的调用还没结果
    expect(host!.querySelector('.cz-st-tool')?.textContent).toBe('docs');
    expect(toolBtns().map((b) => b.textContent)).toEqual(['nav ×2', 'click', 'q']);
    expect(toolBtns()[0].classList.contains('is-error')).toBe(true);
    expect(toolBtns()[1].classList.contains('is-error')).toBe(false);
  });

  it('点工具展开每次调用的入参与结果，「收起」关闭', async () => {
    await mount(steps);
    await click(toolBtns()[0]);
    const t = host!.textContent!;
    expect(t).toContain('第 1 次调用');
    expect(t).toContain('第 2 次调用');
    expect(t).toContain('"url": "http://x"');
    expect(t).toContain('导航成功');
    expect(t).toContain('boom');
    await click(host!.querySelector('.cz-flow__pdetail-close')!);
    expect(host!.textContent).not.toContain('导航成功');
  });

  it('切换到另一个工具时替换展开内容', async () => {
    await mount(steps);
    await click(toolBtns()[0]);
    await click(toolBtns()[1]);
    expect(host!.textContent).not.toContain('导航成功');
    expect(host!.textContent).toContain('"ref": "e1"');
  });
});
