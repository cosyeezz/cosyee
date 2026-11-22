// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BrowseDir } from '@cosyee/shared';

vi.mock('../../core/api', () => ({ api: { browse: () => Promise.reject(new Error('不应调用')) } }));

import { PickerDialog, type PickerMode } from './PickerDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DIRS: Record<string, BrowseDir> = {
  '/w': {
    path: '/w',
    parent: '/',
    roots: ['/'],
    entries: [{ name: 'src', isDir: true }, { name: 'a.md', isDir: false }, { name: 'b.ts', isDir: false }],
  },
  '/w/src': { path: '/w/src', parent: '/w', roots: ['/'], entries: [{ name: 'c.ts', isDir: false }] },
};
const fakeBrowse = vi.fn(async (p?: string) => {
  const d = DIRS[p ?? '/w'];
  if (!d) throw new Error('文件夹不存在');
  return d;
});

let host: HTMLDivElement;
let root: Root;
let done: ReturnType<typeof vi.fn>;

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const q = <T extends Element>(sel: string) => document.body.querySelector<T>(sel);
const byLabel = <T extends Element>(label: string) => q<T>(`[aria-label="${label}"]`)!;
const button = (text: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const click = (el: Element) => act(async () => { (el as HTMLElement).click(); });
const names = () => [...document.body.querySelectorAll('.cz-pick__name')].map((n) => n.textContent);

async function open(mode: PickerMode) {
  await act(async () => {
    root.render(<PickerDialog mode={mode} title="选择" onDone={done} browse={fakeBrowse} />);
  });
  await flush();
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  done = vi.fn();
  fakeBrowse.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('PickerDialog', () => {
  it('文件模式：勾选文件、进入文件夹后继续勾选，「添加」返回全部绝对路径', async () => {
    await open('mixed');
    expect(fakeBrowse).toHaveBeenCalledWith(undefined);
    expect(names()).toEqual(['src', 'a.md', 'b.ts']);
    expect(button('添加').disabled).toBe(true);

    await click(byLabel('选择 a.md'));
    await click(button('src')); // 点文件夹 = 进入
    await flush();
    expect(names()).toEqual(['c.ts']);
    expect(byLabel<HTMLInputElement>('路径').value).toBe('/w/src');
    await click(button('c.ts')); // 点文件 = 勾选
    expect(q('.cz-pick__count')!.textContent).toBe('已选 2 项');

    await click(button('添加'));
    expect(done).toHaveBeenCalledWith(['/w/a.md', '/w/src/c.ts']);
  });

  it('文件夹模式：只列文件夹，「打开此文件夹」返回当前目录；上一级可返回', async () => {
    await open('folder');
    expect(names()).toEqual(['src']);
    await click(button('src'));
    await flush();
    await click(byLabel('上一级'));
    await flush();
    expect(byLabel<HTMLInputElement>('路径').value).toBe('/w');
    await click(button('打开此文件夹'));
    expect(done).toHaveBeenCalledWith(['/w']);
  });

  it('路径框回车跳转；出错时显示错误', async () => {
    await open('mixed');
    const input = byLabel<HTMLInputElement>('路径');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, '/nope');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await flush();
    expect(fakeBrowse).toHaveBeenLastCalledWith('/nope');
    expect(q('[role="alert"]')!.textContent).toBe('文件夹不存在');
  });

  it('Esc / 取消 / 关闭 都返回 []', async () => {
    await open('mixed');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    await click(button('取消'));
    await click(byLabel('关闭'));
    expect(done.mock.calls).toEqual([[[]], [[]], [[]]]);
  });
});
