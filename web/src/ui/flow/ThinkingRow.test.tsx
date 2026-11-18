// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ThinkingStep } from '@cosyee/shared';
import { ThinkingRow } from './Steps';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(step: ThinkingStep) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ThinkingRow step={step} />));
  const q = (sel: string) => host!.querySelector(sel) as HTMLElement | null;
  return {
    rerender: (s: ThinkingStep) => act(() => root!.render(<ThinkingRow step={s} />)),
    btn: () => q('button'),
    body: () => q('.cz-flow__thinking-body'),
    preview: () => q('.cz-flow__thinking-preview'),
    label: () => q('.cz-flow__thinking-label')!.textContent,
    click: () => act(() => q('button')!.click()),
  };
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const TEXT = '先想第一步\n\n再想第二步';

describe('ThinkingRow', () => {
  it('进行中默认展开并实时显示内容；完成后自动折叠，折叠态显示第一行', () => {
    const v = mount({ kind: 'thinking', text: '先想', streaming: true });
    expect(v.btn()!.getAttribute('aria-expanded')).toBe('true');
    expect(v.body()!.textContent).toBe('先想');
    expect(v.label()).toBe('思考中…');
    v.rerender({ kind: 'thinking', text: TEXT, streaming: true });
    expect(v.body()!.textContent).toBe(TEXT);
    v.rerender({ kind: 'thinking', text: TEXT });
    expect(v.btn()!.getAttribute('aria-expanded')).toBe('false');
    expect(v.body()).toBeNull();
    expect(v.preview()!.textContent).toBe('先想第一步');
    expect(v.label()).toBe('已思考');
  });

  it('完成后点击展开看全文，再点收起', () => {
    const v = mount({ kind: 'thinking', text: TEXT });
    v.click();
    expect(v.body()!.textContent).toBe(TEXT);
    expect(v.preview()).toBeNull();
    v.click();
    expect(v.body()).toBeNull();
  });

  it('历史记录（非流式）默认折叠', () => {
    const v = mount({ kind: 'thinking', text: TEXT, tokens: 100 });
    expect(v.btn()!.getAttribute('aria-expanded')).toBe('false');
    expect(v.body()).toBeNull();
  });

  it('进行中手动收起后，后续增量不再强制展开', () => {
    const v = mount({ kind: 'thinking', text: '先想', streaming: true });
    v.click();
    expect(v.body()).toBeNull();
    v.rerender({ kind: 'thinking', text: '先想第一步', streaming: true });
    expect(v.body()).toBeNull();
    expect(v.preview()!.textContent).toBe('先想第一步');
    v.rerender({ kind: 'thinking', text: TEXT });
    expect(v.body()).toBeNull();
  });

  it('流式开始时还没文本：不可展开；文本到达后自动展开', () => {
    const v = mount({ kind: 'thinking', text: '', streaming: true });
    expect(v.btn()).toBeNull();
    expect(v.body()).toBeNull();
    v.rerender({ kind: 'thinking', text: '有了', streaming: true });
    expect(v.body()!.textContent).toBe('有了');
  });

  it('没有思考文本：只显示「已思考（N tokens）」，没有可展开区', () => {
    const v = mount({ kind: 'thinking', text: '', streaming: true, tokens: 50 });
    expect(v.label()).toBe('思考中（50 tokens）');
    v.rerender({ kind: 'thinking', text: '', tokens: 962 });
    expect(v.label()).toBe('已思考（962 tokens）');
    expect(v.btn()).toBeNull();
    expect(v.body()).toBeNull();
    expect(host!.querySelector('.icon-chevron')).toBeNull();
  });

  it('用新的 thinking 图标，进行中带 is-streaming（呼吸动效）', () => {
    const v = mount({ kind: 'thinking', text: 'x', streaming: true });
    expect(host!.querySelector('.icon-thinking')).not.toBeNull();
    expect(host!.querySelector('.icon-thought')).toBeNull();
    expect(host!.firstElementChild!.classList.contains('is-streaming')).toBe(true);
    v.rerender({ kind: 'thinking', text: 'x' });
    expect(host!.firstElementChild!.classList.contains('is-streaming')).toBe(false);
  });
});
