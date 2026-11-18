// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SessionHeader } from './SessionHeader';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CWD = 'F:\\Cosyee\\some\\very\\long\\workspace\\directory';
const BRANCH = 'feature/copy-buttons';

let root: Root | null = null;
let host: HTMLElement | null = null;
let writeText: ReturnType<typeof vi.fn>;

function mount(branch: string | null = BRANCH) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<SessionHeader title="标题" cwd={CWD} branch={branch} onRename={() => {}} />));
  const copies = () => Array.from(host!.querySelectorAll<HTMLButtonElement>('.cz-header__copy'));
  return {
    copies,
    cwdBtn: () => copies()[0]!,
    branchBtn: () => copies()[1]!,
    click: async (b: HTMLButtonElement) => {
      await act(async () => {
        b.click();
      });
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.useRealTimers();
});

describe('SessionHeader 复制按钮', () => {
  it('工作目录行和分支行各有一个复制按钮，带 aria-label，是可聚焦的 button', () => {
    const v = mount();
    expect(v.copies()).toHaveLength(2);
    expect(v.cwdBtn().getAttribute('aria-label')).toBe('复制工作目录');
    expect(v.branchBtn().getAttribute('aria-label')).toBe('复制分支名');
    for (const b of v.copies()) {
      expect(b.tagName).toBe('BUTTON');
      expect(b.tabIndex).toBe(0);
      expect(b.querySelector('.icon-copy')).not.toBeNull();
    }
  });

  it('非 git 仓库（branch 为 null）：只有工作目录的复制按钮', () => {
    const v = mount(null);
    expect(v.copies()).toHaveLength(1);
    expect(v.cwdBtn().getAttribute('aria-label')).toBe('复制工作目录');
  });

  it('点击复制完整的工作目录，显示对勾约 1.5 秒后恢复', async () => {
    const v = mount();
    await v.click(v.cwdBtn());
    expect(writeText).toHaveBeenCalledWith(CWD);
    expect(v.cwdBtn().classList.contains('is-copied')).toBe(true);
    expect(v.cwdBtn().querySelector('.icon-check')).not.toBeNull();
    expect(v.cwdBtn().getAttribute('aria-label')).toBe('已复制');
    // 另一行不受影响
    expect(v.branchBtn().classList.contains('is-copied')).toBe(false);

    act(() => void vi.advanceTimersByTime(1400));
    expect(v.cwdBtn().classList.contains('is-copied')).toBe(true);
    act(() => void vi.advanceTimersByTime(200));
    expect(v.cwdBtn().classList.contains('is-copied')).toBe(false);
    expect(v.cwdBtn().querySelector('.icon-copy')).not.toBeNull();
    expect(v.cwdBtn().getAttribute('aria-label')).toBe('复制工作目录');
  });

  it('点击复制完整的分支名', async () => {
    const v = mount();
    await v.click(v.branchBtn());
    expect(writeText).toHaveBeenCalledWith(BRANCH);
    expect(v.branchBtn().classList.contains('is-copied')).toBe(true);
  });

  it('剪贴板不可用（写入失败）：静默，不显示对勾', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    const v = mount();
    await v.click(v.cwdBtn());
    expect(v.cwdBtn().classList.contains('is-copied')).toBe(false);
    expect(v.cwdBtn().querySelector('.icon-copy')).not.toBeNull();
  });
});
