// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { FilePreview as FilePreviewData } from '@cosyee/shared';

const filePreview = vi.fn();
vi.mock('../../core/api', () => ({
  api: {
    filePreview: (...a: unknown[]) => filePreview(...a),
    fileRawUrl: () => '/api/files/raw?x',
  },
}));

import { FilePreview } from './FilePreview';
import { FilesContext, type FilesApi } from './FileContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const codeData: FilePreviewData = {
  name: 'a.ts',
  path: 'F:\\proj\\src\\a.ts',
  size: 2048,
  mtime: 0,
  kind: 'code',
  text: 'const a = 1;\nconst b = 2;\n',
  encoding: 'UTF-8',
  language: 'typescript',
};
const mdData: FilePreviewData = {
  name: 'r.md',
  path: 'F:\\proj\\r.md',
  size: 10,
  mtime: 0,
  kind: 'markdown',
  text: '# 标题\n\n[b](./b.md)\n',
  encoding: 'UTF-8',
  language: 'markdown',
};

let root: Root | null = null;
let host: HTMLElement | null = null;
let files: FilesApi;

async function mount(onClose = vi.fn(), over: Partial<{ path: string; line: number; nonce: number }> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const props = { session: 's1', cwd: 'F:\\proj', path: 'src/a.ts', nonce: 1, ...over };
  await act(async () => {
    root!.render(
      <FilesContext.Provider value={files}>
        <FilePreview {...props} onClose={onClose} />
      </FilesContext.Provider>,
    );
  });
  return { el: host, onClose, props };
}

beforeEach(() => {
  filePreview.mockReset();
  files = { cwd: 'F:\\proj', open: vi.fn(), reveal: vi.fn(), terminal: vi.fn() };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn().mockResolvedValue(undefined) }, configurable: true });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('FilePreview', () => {
  it('非模态浮窗：role=dialog、aria-modal=false；带文件名、路径操作、行号、底栏', async () => {
    filePreview.mockResolvedValue(codeData);
    const { el } = await mount();
    const panel = el.querySelector<HTMLElement>('.cz-fp')!;
    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(el.querySelector('.cz-fp__name')!.textContent).toBe('a.ts');
    // 路径行：复制 / 显示 / 终端
    expect(el.querySelector('.cz-fp__head [aria-label="复制路径"]')).not.toBeNull();
    expect(el.querySelector('.cz-fp__head [aria-label="在文件管理器中显示"]')).not.toBeNull();
    expect(el.querySelector('.cz-fp__head [aria-label="在此处打开终端"]')).not.toBeNull();
    // 行号：两行，内容保留
    const rows = el.querySelectorAll('.cz-fp__row');
    expect(rows).toHaveLength(2);
    expect(rows[1]!.querySelector('.cz-fp__ln')!.textContent).toBe('2');
    expect(rows[1]!.querySelector('.cz-fp__lc')!.textContent).toBe('const b = 2;');
    // 底栏：大小 · 行数 · 编码
    expect(el.querySelector('.cz-fp__foot')!.textContent).toBe('2.0 KB · 2 行 · UTF-8');
    expect(filePreview).toHaveBeenCalledWith({ session: 's1', cwd: 'F:\\proj', path: 'src/a.ts', line: undefined });
  });

  it('Esc 关闭并还焦点；点击窗口外关闭但不抢回焦点', async () => {
    filePreview.mockResolvedValue(codeData);
    const { onClose } = await mount();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onClose).toHaveBeenLastCalledWith(true);
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    act(() => void outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onClose).toHaveBeenLastCalledWith(false);
    outside.remove();
    // 窗口内按下不关闭
    onClose.mockClear();
    act(() => void host!.querySelector('.cz-fp__body')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('关闭按钮；最大化 / 还原切换 is-max', async () => {
    filePreview.mockResolvedValue(codeData);
    const { el, onClose } = await mount();
    const max = el.querySelector<HTMLButtonElement>('[aria-label="最大化"]')!;
    act(() => max.click());
    expect(el.querySelector('.cz-fp')!.classList.contains('is-max')).toBe(true);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="还原"]')!.click());
    expect(el.querySelector('.cz-fp')!.classList.contains('is-max')).toBe(false);
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('服务端拒绝（如工作目录之外 403）：显示错误和重试，不渲染内容', async () => {
    filePreview.mockRejectedValue(new Error('路径不在会话工作目录内'));
    const { el } = await mount();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('路径不在会话工作目录内');
    expect(el.querySelector('.cz-fp__row')).toBeNull();
    filePreview.mockResolvedValue(codeData);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    });
    expect(el.querySelectorAll('.cz-fp__row')).toHaveLength(2);
  });

  it('Markdown：默认阅读模式（复用 Markdown 组件，相对链接按该文件目录解析），可切到源码', async () => {
    filePreview.mockResolvedValue(mdData);
    const { el } = await mount(vi.fn(), { path: 'r.md' });
    expect(el.querySelector('.cz-fp__read h1')!.textContent).toBe('标题');
    expect(el.querySelector<HTMLElement>('.cz-fp__read .cz-filelink')!.title).toBe('F:\\proj\\b.md');
    const labels = Array.from(el.querySelectorAll('.cz-fp__mode')).map((b) => b.textContent);
    expect(labels).toEqual(['阅读', '源码', '对比']);
    act(() => void Array.from(el.querySelectorAll<HTMLButtonElement>('.cz-fp__mode')).find((b) => b.textContent === '源码')!.click());
    expect(el.querySelector('.cz-fp__read')).toBeNull();
    expect(el.querySelectorAll('.cz-fp__row').length).toBeGreaterThan(0);
  });

  it('带行号打开：目标行高亮', async () => {
    filePreview.mockResolvedValue({ ...codeData, line: 2 });
    const { el } = await mount(vi.fn(), { line: 2 });
    expect(el.querySelector('.cz-fp__row.is-target')!.getAttribute('data-line')).toBe('2');
  });

  it('不支持预览的文件：显示服务端给的原因', async () => {
    filePreview.mockResolvedValue({ name: 'x.zip', path: 'F:\\proj\\x.zip', size: 1, mtime: 0, kind: 'unsupported', reason: '压缩包不支持预览' });
    const { el } = await mount(vi.fn(), { path: 'x.zip' });
    expect(el.querySelector('.cz-fp__state')!.textContent).toBe('压缩包不支持预览');
  });

  it('远程连接（FilesApi 没有 reveal / terminal）：只剩复制路径', async () => {
    files = { cwd: 'F:\\proj', open: vi.fn() };
    filePreview.mockResolvedValue(codeData);
    const { el } = await mount();
    expect(el.querySelector('.cz-fp__head [aria-label="复制路径"]')).not.toBeNull();
    expect(el.querySelector('.cz-fp__head [aria-label="在文件管理器中显示"]')).toBeNull();
    expect(el.querySelector('.cz-fp__head [aria-label="在此处打开终端"]')).toBeNull();
  });
});
