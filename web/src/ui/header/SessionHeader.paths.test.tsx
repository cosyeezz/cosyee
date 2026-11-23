// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SessionHeader } from './SessionHeader';
import { FilesContext, type FilesApi } from '../files/FileContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CWD = 'F:\\Cosyee\\some dir\\workspace';

let root: Root | null = null;
let host: HTMLElement | null = null;
let writeText: ReturnType<typeof vi.fn>;

function mount(files: FilesApi | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <FilesContext.Provider value={files}>
        <SessionHeader title="标题" cwd={CWD} branch={null} onRename={() => {}} />
      </FilesContext.Provider>,
    ),
  );
  return host;
}

beforeEach(() => {
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('SessionHeader 工作目录的路径操作', () => {
  it('有 FilesContext：复制 / 在文件管理器中显示 / 在此处打开终端，各是带 aria-label 的 button', () => {
    const files: FilesApi = { cwd: CWD, open: vi.fn(), reveal: vi.fn(), terminal: vi.fn() };
    const el = mount(files);
    const row = el.querySelector('.cz-header__meta.cz-pathact-host')!;
    const buttons = Array.from(row.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(['复制工作目录', '在文件管理器中显示', '在此处打开终端']);
    for (const b of buttons) expect(b.tabIndex).toBe(0);

    act(() => buttons[1]!.click());
    expect(files.reveal).toHaveBeenCalledWith(CWD);
    act(() => buttons[2]!.click());
    expect(files.terminal).toHaveBeenCalledWith(CWD);
    expect(files.reveal).toHaveBeenCalledTimes(1);
    expect(files.terminal).toHaveBeenCalledTimes(1);
  });

  it('复制仍复制完整工作目录', async () => {
    const el = mount({ cwd: CWD, open: vi.fn(), reveal: vi.fn(), terminal: vi.fn() });
    await act(async () => {
      el.querySelector<HTMLButtonElement>('.cz-header__copy')!.click();
    });
    expect(writeText).toHaveBeenCalledWith(CWD);
  });

  it('没有 FilesContext：只有复制按钮，不出现「显示 / 终端」（点了没反应的按钮不渲染）', () => {
    const el = mount(null);
    expect(el.querySelectorAll('.cz-header__copy')).toHaveLength(1);
    expect(el.querySelector('[aria-label="在文件管理器中显示"]')).toBeNull();
    expect(el.querySelector('[aria-label="在此处打开终端"]')).toBeNull();
  });

  it('工作目录行带完整路径 tooltip', () => {
    const el = mount(null);
    expect(el.querySelector('.cz-header__meta.cz-pathact-host')!.getAttribute('title')).toBe(CWD);
  });
});
