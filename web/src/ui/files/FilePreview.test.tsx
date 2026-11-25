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

  it('服务端拒绝（如工作目录之外 403）：显示错误和重试，不渲染内容且不显示打开按钮', async () => {
    files = { cwd: 'F:\\proj', open: vi.fn(), reveal: vi.fn(), terminal: vi.fn(), openLocal: vi.fn() };
    filePreview.mockRejectedValue(new Error('路径不在会话工作目录内'));
    const { el } = await mount();
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('路径不在会话工作目录内');
    expect(el.querySelector('.cz-fp__row')).toBeNull();
    expect(el.querySelector('.cz-fp__bar [aria-label="用默认应用打开"]')).toBeNull();
    expect(el.querySelectorAll('[role="alert"] button')).toHaveLength(1);
    filePreview.mockResolvedValue(codeData);
    await act(async () => {
      el.querySelector<HTMLButtonElement>('[role="alert"] button')!.click();
    });
    expect(el.querySelectorAll('.cz-fp__row')).toHaveLength(2);
    expect(el.querySelector('.cz-fp__bar [aria-label="用默认应用打开"]')).not.toBeNull();
    expect(el.querySelector('.cz-fp__bar [aria-label="下载到本设备"]')).toBeNull();
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

  it('不支持预览的文件：无本地操作时只显示服务端给的原因', async () => {
    files = { cwd: 'F:\\proj', open: vi.fn() };
    filePreview.mockResolvedValue({ name: 'x.zip', path: 'F:\\proj\\x.zip', size: 1, mtime: 0, kind: 'unsupported', reason: '压缩包不支持预览' });
    const { el } = await mount(vi.fn(), { path: 'x.zip' });
    expect(el.querySelector('.cz-fp__state')!.textContent).toBe('压缩包不支持预览');
  });

  it('不支持预览的文件：有 openLocal / reveal 时在原因下方显示操作按钮，点击传入完整路径且不关闭浮窗', async () => {
    const openLocal = vi.fn();
    const reveal = vi.fn();
    files = { cwd: 'F:\\proj', open: vi.fn(), reveal, openLocal };
    filePreview.mockResolvedValue({ name: 'app.apk', path: 'F:\\proj\\app.apk', size: 1024, mtime: 0, kind: 'unsupported', reason: '此格式暂不支持内嵌预览，请用本地应用打开。' });
    const { el, onClose } = await mount(vi.fn(), { path: 'app.apk' });
    expect(el.querySelector('.cz-fp__reason')!.textContent).toBe('此格式暂不支持内嵌预览，请用本地应用打开。');
    const btns = Array.from(el.querySelectorAll<HTMLButtonElement>('.cz-fp__actions button'));
    expect(btns.map((b) => b.textContent)).toEqual(['用默认应用打开', '在文件管理器中显示']);
    act(() => btns[0]!.click());
    expect(openLocal).toHaveBeenCalledWith('F:\\proj\\app.apk');
    act(() => btns[1]!.click());
    expect(reveal).toHaveBeenCalledWith('F:\\proj\\app.apk');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('工具条「打开」按钮：有 openLocal 时显示，目录文案切换，无 openLocal 时隐藏', async () => {
    const openLocal = vi.fn();
    files = { cwd: 'F:\\proj', open: vi.fn(), openLocal };
    filePreview.mockResolvedValue(codeData);
    const { el, onClose } = await mount();
    const openBtn = el.querySelector<HTMLButtonElement>('.cz-fp__bar [aria-label="用默认应用打开"]');
    expect(openBtn).not.toBeNull();
    expect(openBtn!.textContent).toBe('打开');
    act(() => openBtn!.click());
    expect(openLocal).toHaveBeenCalledWith('F:\\proj\\src\\a.ts');
    expect(onClose).not.toHaveBeenCalled();

    // 目录：title / aria-label 为「在文件管理器中打开」
    filePreview.mockResolvedValue({ name: 'src', path: 'F:\\proj\\src', size: 0, mtime: 0, kind: 'directory', entries: [] });
    await act(async () => {
      root!.render(
        <FilesContext.Provider value={files}>
          <FilePreview session="s1" cwd="F:\\proj" path="src" nonce={2} onClose={onClose} />
        </FilesContext.Provider>,
      );
    });
    const dirBtn = el.querySelector<HTMLButtonElement>('.cz-fp__bar [aria-label="在文件管理器中打开"]');
    expect(dirBtn).not.toBeNull();
    act(() => dirBtn!.click());
    expect(openLocal).toHaveBeenLastCalledWith('F:\\proj\\src');
  });

  it('远程连接（FilesApi 没有 reveal / terminal / openLocal）：只剩复制路径且工具条无打开按钮', async () => {
    files = { cwd: 'F:\\proj', open: vi.fn() };
    filePreview.mockResolvedValue(codeData);
    const { el } = await mount();
    expect(el.querySelector('.cz-fp__head [aria-label="复制路径"]')).not.toBeNull();
    expect(el.querySelector('.cz-fp__head [aria-label="在文件管理器中显示"]')).toBeNull();
    expect(el.querySelector('.cz-fp__head [aria-label="在此处打开终端"]')).toBeNull();
    expect(el.querySelector('.cz-fp__bar [aria-label="用默认应用打开"]')).toBeNull();
  });

  it('远程连接有 downloadUrl：工具条与不支持态显示下载链接，目录与错误态不显示', async () => {
    const downloadUrl = vi.fn((p: string) => `/api/files/download?path=${encodeURIComponent(p)}`);
    files = { cwd: 'F:\\proj', open: vi.fn(), downloadUrl };
    filePreview.mockResolvedValue(codeData);
    const { el, onClose } = await mount();
    const barLink = el.querySelector<HTMLAnchorElement>('.cz-fp__bar a.cz-fp__btn[aria-label="下载到本设备"]');
    expect(barLink).not.toBeNull();
    expect(barLink!.textContent).toBe('下载');
    expect(barLink!.getAttribute('href')).toBe(`/api/files/download?path=${encodeURIComponent('F:\\proj\\src\\a.ts')}`);
    expect(barLink!.getAttribute('download')).toBe('a.ts');
    expect(el.querySelector('.cz-fp__bar [aria-label="用默认应用打开"]')).toBeNull();

    // 不支持预览态：正文里也有「下载到本设备」链接
    filePreview.mockResolvedValue({ name: 'app.apk', path: 'F:\\proj\\app.apk', size: 1024, mtime: 0, kind: 'unsupported', reason: '请用本地应用打开。' });
    await act(async () => {
      root!.render(
        <FilesContext.Provider value={files}>
          <FilePreview session="s1" cwd="F:\\proj" path="app.apk" nonce={2} onClose={onClose} />
        </FilesContext.Provider>,
      );
    });
    const bodyLink = el.querySelector<HTMLAnchorElement>('.cz-fp__actions a.cz-fp__btn');
    expect(bodyLink).not.toBeNull();
    expect(bodyLink!.textContent).toBe('下载到本设备');
    expect(bodyLink!.getAttribute('href')).toBe(`/api/files/download?path=${encodeURIComponent('F:\\proj\\app.apk')}`);
    expect(bodyLink!.getAttribute('download')).toBe('app.apk');

    // 目录：不显示下载链接
    filePreview.mockResolvedValue({ name: 'src', path: 'F:\\proj\\src', size: 0, mtime: 0, kind: 'directory', entries: [] });
    await act(async () => {
      root!.render(
        <FilesContext.Provider value={files}>
          <FilePreview session="s1" cwd="F:\\proj" path="src" nonce={3} onClose={onClose} />
        </FilesContext.Provider>,
      );
    });
    expect(el.querySelector('.cz-fp__bar [aria-label="下载到本设备"]')).toBeNull();

    // 错误态：不显示下载链接
    filePreview.mockRejectedValue(new Error('禁止访问'));
    await act(async () => {
      root!.render(
        <FilesContext.Provider value={files}>
          <FilePreview session="s1" cwd="F:\\proj" path="secret.txt" nonce={4} onClose={onClose} />
        </FilesContext.Provider>,
      );
    });
    expect(el.querySelector('.cz-fp__bar [aria-label="下载到本设备"]')).toBeNull();
    expect(el.querySelector('[role="alert"] a')).toBeNull();
  });
});
