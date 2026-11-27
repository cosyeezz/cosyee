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

function render(items: MenuEntry[], onClose = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Menu anchor={host} items={items} onClose={onClose} minWidth={240} />));
  return onClose;
}

function mount(onPick = vi.fn()) {
  render([
    { key: 'a', label: '甲' },
    { key: 'effort', label: '思考强度', submenu: [{ key: 'e:hi', label: '高', onSelect: onPick }] },
  ]);
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

  it('二级菜单比可用高度还高：限高并可滚动', () => {
    setWidth(1400);
    const spy = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('cz-menu--sub') ? 5000 : 0;
    });
    try {
      mount();
      act(() => row('思考强度').click());
      const sub = document.querySelector<HTMLElement>('.cz-menu--sub')!;
      expect(sub.classList.contains('cz-menu--scroll')).toBe(true);
      expect(sub.style.maxHeight).toBe(`${window.innerHeight - 16}px`);
    } finally {
      spy.mockRestore();
    }
  });

  it('键盘 ↓ 把当前行滚进可视区', () => {
    setWidth(1400);
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll; // jsdom 没实现
    try {
      mount();
      act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })); });
      expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe('Menu 行尾复制按钮', () => {
  it('点复制按钮写入剪贴板并显示对勾，不选中该项、不关菜单', async () => {
    setWidth(1400);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const onPick = vi.fn();
    const onClose = render([{ key: 'more', label: '自定义模型', submenu: [{ key: 'm:x', label: 'X', copy: 'model-x', onSelect: onPick }] }]);
    act(() => row('自定义模型').click());
    const btn = document.querySelector<HTMLButtonElement>('.cz-menu--sub .cz-menu__copy')!;
    expect(btn.getAttribute('aria-label')).toBe('复制 model-x');
    act(() => btn.click());
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith('model-x');
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(btn.getAttribute('aria-label')).toBe('已复制');
  });

  it('没有 copy 的行不渲染复制按钮', () => {
    render([{ key: 'a', label: '甲' }]);
    expect(document.querySelector('.cz-menu__copy')).toBeNull();
  });
});
