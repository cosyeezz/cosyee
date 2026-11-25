// @vitest-environment jsdom
// 叠在菜单上的确认气泡：挂到 body、不被当成菜单外面、Esc 一次只关一层。
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CONFIRM_DELAY_MS, ConfirmActionButton } from './ActionButtons';
import { useDismiss } from './useDismiss';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const onConfirm = vi.fn();

function Menu() {
  const [open, setOpen] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(open, ref, () => setOpen(false));
  return <div ref={ref}>{open && <div className="menu"><ConfirmActionButton icon="trash" label="移除" confirmText="移除？" onConfirm={onConfirm} /></div>}</div>;
}

const pop = () => document.querySelector('.cz-sidebar__confirm');
const menu = () => document.querySelector('.menu');
const openPop = () => {
  act(() => { document.querySelector('.cz-sidebar__act')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  act(() => { vi.advanceTimersByTime(CONFIRM_DELAY_MS + 10); });
};
const esc = () => act(() => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

beforeEach(() => {
  vi.useFakeTimers();
  onConfirm.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Menu />));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it('气泡挂在 body 下；Esc 先关气泡（焦点还给按钮）再关菜单', () => {
  openPop();
  expect(pop()!.parentElement).toBe(document.body);
  esc();
  expect(pop()).toBeNull();
  expect(menu()).not.toBeNull();
  expect(document.activeElement?.className).toContain('cz-sidebar__act');
  esc();
  expect(menu()).toBeNull();
});

it('在气泡里按下鼠标不会关掉菜单，确认能触发', () => {
  openPop();
  const b = document.querySelector('.cz-sidebar__confirm-btn--danger')!;
  act(() => { b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  expect(menu()).not.toBeNull();
  act(() => { b.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

it('点在两层外面：都关掉', () => {
  openPop();
  act(() => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
  expect(pop()).toBeNull();
  expect(menu()).toBeNull();
});
