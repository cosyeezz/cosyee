// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Menu, type MenuEntry } from './Menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
const width0 = window.innerWidth;
const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });

beforeEach(() => setWidth(width0));
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  setWidth(width0);
});

function mount(onPick = vi.fn()) {
  const items: MenuEntry[] = [
    { key: 'a', label: '甲' },
    { key: 'effort', label: '思考强度', submenu: [{ key: 'e:hi', label: '高', onSelect: onPick }] },
  ];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Menu anchor={host} items={items} onClose={() => {}} minWidth={240} />));
  return onPick;
}

const rows = () => Array.from(document.querySelectorAll('.cz-menu__row')).map((r) => r.textContent);
const row = (text: string) => Array.from(document.querySelectorAll<HTMLElement>('.cz-menu__row')).find((r) => r.textContent === text)!;

describe('Menu 二级菜单', () => {
  it('宽屏：子菜单挂在旁边，主列表保留', () => {
    setWidth(1400);
    mount();
    act(() => row('思考强度').click());
    expect(document.querySelector('.cz-menu--sub')).not.toBeNull();
    expect(rows()).toContain('甲');
  });

  it('窄屏：钻入式，在同一面板里换成返回行 + 子项，点返回回到主列表', () => {
    setWidth(375);
    const onPick = mount();
    expect(document.querySelector('.cz-menu--scroll')).not.toBeNull();
    // 触屏点按会先合成 mouseenter，不能抢先切换
    act(() => { row('思考强度').parentElement!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(rows()).toEqual(['甲', '思考强度']);
    act(() => row('思考强度').click());
    expect(document.querySelector('.cz-menu--sub')).toBeNull();
    expect(rows()).toEqual(['思考强度', '高']);
    act(() => row('思考强度').click());
    expect(rows()).toEqual(['甲', '思考强度']);
    act(() => row('思考强度').click());
    act(() => row('高').click());
    expect(onPick).toHaveBeenCalled();
  });
});
