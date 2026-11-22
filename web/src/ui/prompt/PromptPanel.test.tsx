// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PendingPrompt } from '@cosyee/shared';
import { PromptPanel } from './PromptPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(items: PendingPrompt[]) {
  const onReply = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<PromptPanel items={items} onReply={onReply} />));
  const btn = (text: string) => [...host!.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!;
  const click = (el: Element) => act(() => { (el as HTMLElement).click(); });
  const type = (el: HTMLInputElement | HTMLTextAreaElement, v: string) =>
    act(() => {
      const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  return { onReply, btn, click, type, host: host! };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const single: PendingPrompt = {
  kind: 'question', id: 'p1', at: 1,
  questions: [{ question: '选哪个？', options: [{ label: '甲', description: 'a' }, { label: '乙' }] }],
};

describe('PromptPanel 提问', () => {
  it('单问单选：点选项直接提交', () => {
    const m = mount([single]);
    m.click(m.btn('乙'));
    expect(m.onReply).toHaveBeenCalledWith('p1', { kind: 'answer', answers: { '选哪个？': '乙' } });
  });

  it('多选 + 其他：用 ", " 连接', () => {
    const m = mount([{ kind: 'question', id: 'p2', at: 1, questions: [{ question: '要啥？', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }] }]);
    const submit = m.btn('提交') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    m.click(m.btn('A'));
    m.click(m.btn('B'));
    m.type(m.host.querySelector('input')!, '自定义');
    expect(submit.disabled).toBe(false);
    m.click(submit);
    expect(m.onReply).toHaveBeenCalledWith('p2', { kind: 'answer', answers: { '要啥？': 'A, B, 自定义' } });
  });

  it('单选里输入其他会替换选项；多个问题需全部作答', () => {
    const m = mount([{ kind: 'question', id: 'p3', at: 1, questions: [
      { question: 'Q1', options: [{ label: 'x' }] }, { question: 'Q2', options: [{ label: 'y' }] }] }]);
    m.click(m.btn('x'));
    const submit = m.btn('提交') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    m.type(m.host.querySelectorAll('input')[1]!, '我的');
    m.click(submit);
    expect(m.onReply).toHaveBeenCalledWith('p3', { kind: 'answer', answers: { Q1: 'x', Q2: '我的' } });
  });

  it('数字键选择第一个问题的选项', () => {
    const m = mount([single]);
    act(() => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true })); });
    expect(m.onReply).toHaveBeenCalledWith('p1', { kind: 'answer', answers: { '选哪个？': '甲' } });
  });

  it('跳过 + 还有 n 个待处理', () => {
    const m = mount([single, { ...single, id: 'p9' }]);
    expect(m.host.textContent).toContain('还有 1 个待处理');
    m.click(m.btn('跳过'));
    expect(m.onReply).toHaveBeenCalledWith('p1', { kind: 'skip' });
  });
});

describe('PromptPanel 计划', () => {
  const plan: PendingPrompt = { kind: 'plan', id: 'pl', at: 1, plan: '# 计划\n\n- 步骤一', planFilePath: 'C:/x/plan.md' };

  it('批准并执行', () => {
    const m = mount([plan]);
    expect(m.host.textContent).toContain('计划已就绪，等你批准');
    expect(m.host.textContent).toContain('C:/x/plan.md');
    m.click(m.btn('批准并执行'));
    expect(m.onReply).toHaveBeenCalledWith('pl', { kind: 'approve' });
  });

  it('继续完善：填写意见后发送', () => {
    const m = mount([plan]);
    m.click(m.btn('继续完善'));
    const ta = m.host.querySelector('textarea')!;
    expect((m.btn('发送意见') as HTMLButtonElement).disabled).toBe(true);
    m.type(ta, '加上测试');
    m.click(m.btn('发送意见'));
    expect(m.onReply).toHaveBeenCalledWith('pl', { kind: 'revise', feedback: '加上测试' });
  });

  it('意见框 Enter 发送，Shift+Enter 不发送', () => {
    const m = mount([plan]);
    m.click(m.btn('继续完善'));
    const ta = m.host.querySelector('textarea')!;
    m.type(ta, '改');
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })); });
    expect(m.onReply).not.toHaveBeenCalled();
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(m.onReply).toHaveBeenCalledWith('pl', { kind: 'revise', feedback: '改' });
  });
});
