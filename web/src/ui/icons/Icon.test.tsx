// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Icon, type IconProps } from './Icon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(props: IconProps) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Icon {...props} />));
  return {
    rerender: (p: IconProps) => act(() => root!.render(<Icon {...p} />)),
    svg: () => host!.querySelector('svg') as SVGElement,
  };
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('Icon（设计图标）', () => {
  it('同名同参数重渲染时不重写 innerHTML（一次性动画不重播）', () => {
    const { rerender, svg } = mount({ name: 'done', size: 20 });
    const first = svg();
    const id = first.innerHTML;
    rerender({ name: 'done', size: 20, className: 'x' }); // className 变了也只改 class，不碰内部
    expect(svg()).toBe(first);
    expect(svg().innerHTML).toBe(id);
  });

  it('换图标名才会重新生成', () => {
    const { rerender, svg } = mount({ name: 'streaming', size: 20 });
    const first = svg();
    rerender({ name: 'done', size: 20 });
    expect(svg()).not.toBe(first);
    expect(svg().getAttribute('class')).toContain('ci-done');
  });

  it('chevron 的 open 只切换 svg 上的 is-open，不替换元素（保留旋转过渡）', () => {
    const { rerender, svg } = mount({ name: 'chevron', size: 16, open: false });
    const first = svg();
    expect(first.classList.contains('is-open')).toBe(false);
    rerender({ name: 'chevron', size: 16, open: true });
    expect(svg()).toBe(first);
    expect(first.classList.contains('is-open')).toBe(true);
    rerender({ name: 'chevron', size: 16, open: false });
    expect(first.classList.contains('is-open')).toBe(false);
  });

  it('running 变化时重新生成，tool 图标带 is-running', () => {
    const { rerender, svg } = mount({ name: 'tool-bash', size: 16, running: true });
    expect(svg().classList.contains('is-running')).toBe(true);
    rerender({ name: 'tool-bash', size: 16, running: false });
    expect(svg().classList.contains('is-running')).toBe(false);
  });

  it('补画的线条图标不再是占位方框', () => {
    const { rerender, svg } = mount({ name: 'branch', size: 16 });
    for (const name of ['branch', 'info', 'file', 'image', 'compact'] as const) {
      rerender({ name, size: 16 });
      expect(svg().getAttribute('class')).toContain(`icon-${name}`);
      expect(svg().getAttribute('class')).not.toContain('icon-placeholder');
    }
  });

  it('未知名字仍显示占位方框', () => {
    const { svg } = mount({ name: 'no-such-icon' as never, size: 16 });
    expect(svg().getAttribute('class')).toContain('icon-placeholder');
  });
});
