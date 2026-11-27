// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TermSnapshot } from '@cosyee/shared';
import type { TerminalActions, TerminalController, TerminalState } from '../../core/terminal';
import { SessionHeader } from '../header/SessionHeader';
import { TerminalPanel } from './TerminalPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function makeCtrl(snap: TermSnapshot, overrides: Partial<TerminalActions> = {}): { ctrl: TerminalController; actions: TerminalActions } {
  const actions: TerminalActions = {
    run: vi.fn(() => 'id-new'),
    sendStdin: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
    setShell: vi.fn(),
    resetCwd: vi.fn(),
    removeHistory: vi.fn(),
    clearHistory: vi.fn(),
    reconnect: vi.fn(),
    ...overrides,
  };
  const state: TerminalState = {
    root: snap.root,
    connState: 'open',
    error: null,
    snapshot: snap,
  };
  return { ctrl: { state, actions }, actions };
}

const SAMPLE_SNAP: TermSnapshot = {
  root: 'F:\\Cosyee',
  cwd: 'F:\\Cosyee\\web',
  shell: 'pwsh',
  shells: [
    { id: 'pwsh', label: 'PowerShell 7' },
    { id: 'gitbash', label: 'Git Bash' },
  ],
  platform: 'win32',
  blocks: [
    {
      id: 'b-done',
      cmd: 'git status -sb',
      cwd: 'F:\\Cosyee\\web',
      shell: 'pwsh',
      startedAt: 1000,
      endedAt: 1240,
      exitCode: 0,
      state: 'done',
      output: '\x1b[32m## main\x1b[0m\n',
    },
    {
      id: 'b-run',
      cmd: 'npm run dev',
      cwd: 'F:\\Cosyee\\web',
      shell: 'pwsh',
      startedAt: 2000,
      state: 'running',
      output: 'Local: http://localhost:5173/\n',
      truncated: true,
    },
  ],
  history: ['git status -sb', 'npm test', 'npm run dev'],
};

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

function mountPanel(ctrl: TerminalController, extra: Partial<React.ComponentProps<typeof TerminalPanel>> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      <TerminalPanel
        open
        root={SAMPLE_SNAP.root}
        height={320}
        onHeightChange={() => {}}
        onClose={extra.onClose ?? (() => {})}
        controller={ctrl}
        fixedNowMs={5000}
        {...extra}
      />,
    );
  });
  return host;
}

describe('TerminalPanel', () => {
  it('渲染块列表、截断提示、URL 链接并支持输入执行与 stdin 模式', () => {
    const { ctrl, actions } = makeCtrl(SAMPLE_SNAP);
    const el = mountPanel(ctrl);

    expect(el.querySelectorAll('.cz-term-block')).toHaveLength(2);
    expect(el.textContent).toContain('输出过长，只保留最后部分');
    const link = el.querySelector<HTMLAnchorElement>('.cz-term__link');
    expect(link?.getAttribute('href')).toBe('http://localhost:5173/');

    const textarea = el.querySelector<HTMLTextAreaElement>('.cz-term__input')!;
    // 输入命令并 Enter 执行 run
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'ls -la');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(actions.run).toHaveBeenCalledWith('ls -la');

    // 切换到「发送到运行中进程」模式并发送 stdin
    const toggle = el.querySelector<HTMLButtonElement>('.cz-term__stdin-toggle')!;
    act(() => toggle.click());
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'yes');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(actions.sendStdin).toHaveBeenCalledWith('b-run', 'yes\n');
  });

  it('支持 ↑/↓ 历史翻页与草稿恢复、Ctrl+L 清屏、Ctrl+C 停止与 Ctrl+R 历史弹层', () => {
    const { ctrl, actions } = makeCtrl(SAMPLE_SNAP);
    const el = mountPanel(ctrl);
    const textarea = el.querySelector<HTMLTextAreaElement>('.cz-term__input')!;

    // 先写草稿
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, 'draft-cmd');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 按 ↑ 浏览历史
    act(() => {
      textarea.setSelectionRange(0, 0);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(textarea.value).toBe('npm run dev');

    // 再按 ↓ 恢复草稿
    act(() => {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(textarea.value).toBe('draft-cmd');

    // 清空输入框后按 Ctrl+C 停止运行中块
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    });
    expect(actions.stop).toHaveBeenCalledWith('b-run');

    // Ctrl+L 清屏
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    });
    expect(actions.clear).toHaveBeenCalledTimes(1);

    // Ctrl+R 打开历史列表
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
    });
    expect(el.querySelector('.cz-term-hist')).not.toBeNull();
  });

  it('SessionHeader 传入 onToggleTerminal 时始终显示应用内终端按钮并支持激活态', () => {
    const onToggle = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <SessionHeader
          title="测试会话"
          cwd="F:\\Cosyee"
          branch="main"
          onRename={() => {}}
          terminalOpen
          onToggleTerminal={onToggle}
        />,
      );
    });
    const btn = host.querySelector<HTMLButtonElement>('.cz-header__term')!;
    expect(btn).not.toBeNull();
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    act(() => btn.click());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
