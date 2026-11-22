// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModeMenu } from './ModeMenu';
import { buildModeMenu } from './modeMenuItems';
import type { MenuItem } from './Menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

function mount(mode: 'auto' | 'plan', onChange = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ModeMenu mode={mode} onChange={onChange} />));
  return onChange;
}

describe('ModeMenu', () => {
  it('默认显示「自动」，计划模式带 is-plan', () => {
    mount('auto');
    expect(host!.querySelector('button')!.textContent).toContain('自动');
    expect(host!.querySelector('.is-plan')).toBeNull();
    act(() => root!.render(<ModeMenu mode="plan" onChange={() => {}} />));
    expect(host!.querySelector('button')!.textContent).toContain('计划');
    expect(host!.querySelector('.is-plan')).not.toBeNull();
  });
  it('点开菜单后选择「计划模式」调用 onChange(plan)', () => {
    const onChange = mount('auto');
    act(() => host!.querySelector('button')!.click());
    const item = Array.from(document.body.querySelectorAll('*')).find((e) => e.children.length === 0 && e.textContent === '计划模式') as HTMLElement | undefined;
    expect(item).toBeTruthy();
    act(() => item!.click());
    expect(onChange).toHaveBeenCalledWith('plan');
  });
});

describe('buildModeMenu', () => {
  it('勾选当前模式，选择触发回调', () => {
    const fn = vi.fn();
    const items = buildModeMenu('plan', fn) as MenuItem[];
    expect(items.map((i) => i.checked)).toEqual([false, true]);
    items[0].onSelect!();
    expect(fn).toHaveBeenCalledWith('auto');
  });
});
