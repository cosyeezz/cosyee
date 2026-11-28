// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { TermSnapshot, TermTabInfo } from '@cosyee/shared';
import type {
  TerminalActions,
  TerminalController,
  TerminalState,
  TerminalTabsController,
} from '../../core/terminal';
import { SessionHeader } from '../header/SessionHeader';
import { TerminalPanel } from './TerminalPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function makeCtrl(
  snap: TermSnapshot,
  overrides: Partial<TerminalActions> = {},
): { ctrl: TerminalController; actions: TerminalActions } {
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

const SAMPLE_TAB_1: TermTabInfo = {
  id: 'tab-1',
  cwd: 'F:\\Cosyee\\web',
  shell: 'pwsh',
  status: 'running',
  runningCmd: 'npm run dev',
  createdAt: 1000,
};

const SAMPLE_TAB_2: TermTabInfo = {
  id: 'tab-2',
  name: '工具终端',
  cwd: 'F:\\Cosyee\\server',
  shell: 'gitbash',
  status: 'idle',
  createdAt: 2000,
};

const SAMPLE_SNAP: TermSnapshot = {
  id: 'tab-1',
  root: 'F:\\Cosyee',
  tabs: [SAMPLE_TAB_1],
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

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, val: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  setter.call(el, val);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

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
    act(() => setNativeValue(textarea, 'ls -la'));
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(actions.run).toHaveBeenCalledWith('ls -la');

    const toggle = el.querySelector<HTMLButtonElement>('.cz-term__stdin-toggle')!;
    act(() => toggle.click());
    act(() => setNativeValue(textarea, 'yes'));
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(actions.sendStdin).toHaveBeenCalledWith('b-run', 'yes\n');
  });

  it('支持 ↑/↓ 历史翻页与草稿恢复、Ctrl+L 清屏、Ctrl+C 停止与 Ctrl+R 历史弹层', () => {
    const { ctrl, actions } = makeCtrl(SAMPLE_SNAP);
    const el = mountPanel(ctrl);
    const textarea = el.querySelector<HTMLTextAreaElement>('.cz-term__input')!;

    act(() => setNativeValue(textarea, 'draft-cmd'));
    act(() => {
      textarea.setSelectionRange(0, 0);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    expect(textarea.value).toBe('npm run dev');

    act(() => {
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(textarea.value).toBe('draft-cmd');

    act(() => setNativeValue(textarea, ''));
    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }));
    });
    expect(actions.stop).toHaveBeenCalledWith('b-run');

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true }));
    });
    expect(actions.clear).toHaveBeenCalledTimes(1);

    act(() => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true, bubbles: true }));
    });
    expect(el.querySelector('.cz-term-hist')).not.toBeNull();
  });

  it('多标签切换保留各自草稿、双击改名、运行中关闭确认与快捷键', () => {
    const onNew = vi.fn(() => 'tab-3');
    const onRename = vi.fn();
    const onCloseSpy = vi.fn();
    const onPanelClose = vi.fn();

    const snap2: TermSnapshot = {
      ...SAMPLE_SNAP,
      id: 'tab-2',
      tabs: [SAMPLE_TAB_1, SAMPLE_TAB_2],
      cwd: 'F:\\Cosyee\\server',
      shell: 'gitbash',
      blocks: [],
    };
    const snap1: TermSnapshot = {
      ...SAMPLE_SNAP,
      tabs: [SAMPLE_TAB_1, SAMPLE_TAB_2],
    };

    function Harness() {
      const [tabs, setTabs] = useState<TermTabInfo[]>([SAMPLE_TAB_1, SAMPLE_TAB_2]);
      const [activeId, setActiveId] = useState<string>('tab-1');
      const curSnap = activeId === 'tab-1' ? snap1 : snap2;
      const { ctrl } = makeCtrl(curSnap);

      const tabsCtrl: TerminalTabsController = {
        tabs,
        activeId,
        notice: null,
        clearNotice: () => {},
        current: ctrl,
        selectTab: (id) => setActiveId(id),
        newTab: () => onNew(),
        closeTab: (id) => {
          onCloseSpy(id);
          const closedLast = tabs.length <= 1;
          setTabs((prev) => prev.filter((t) => t.id !== id));
          if (!closedLast && activeId === id) {
            const next = tabs.find((t) => t.id !== id);
            if (next) setActiveId(next.id);
          }
          return { closedLast };
        },
        renameTab: (id, name) => {
          onRename(id, name);
          setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, name: name.trim() || undefined } : t)));
        },
        moveTab: () => {},
      };

      return (
        <TerminalPanel
          open
          root="F:\\Cosyee"
          height={320}
          onHeightChange={() => {}}
          onClose={onPanelClose}
          tabsController={tabsCtrl}
          fixedNowMs={5000}
        />
      );
    }

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));

    // 1. 在标签 1 输入草稿，切到标签 2 输入另一份草稿，再切回标签 1 恢复原草稿
    expect(host.querySelectorAll('.cz-term-tab')).toHaveLength(2);
    const ta1 = host.querySelector<HTMLTextAreaElement>('.cz-term__input')!;
    act(() => setNativeValue(ta1, 'echo from-tab-1'));

    const tabEls = host.querySelectorAll<HTMLElement>('.cz-term-tab');
    act(() => tabEls[1]!.click());
    const ta2 = host.querySelector<HTMLTextAreaElement>('.cz-term__input')!;
    expect(ta2.value).toBe('');
    act(() => setNativeValue(ta2, 'echo from-tab-2'));

    // Ctrl+PageUp 切回标签 1
    const panel = host.querySelector<HTMLElement>('.cz-term')!;
    act(() => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp', ctrlKey: true, bubbles: true }));
    });
    const ta1Again = host.querySelector<HTMLTextAreaElement>('.cz-term__input')!;
    expect(ta1Again.value).toBe('echo from-tab-1');

    // Ctrl+Tab 切到标签 2，草稿仍保留
    act(() => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, bubbles: true }));
    });
    expect(host.querySelector<HTMLTextAreaElement>('.cz-term__input')!.value).toBe('echo from-tab-2');

    // 2. 双击标签 2 名称进入内联改名并 Enter 确认
    const tab2Name = host.querySelectorAll<HTMLElement>('.cz-term-tab__name')[1]!;
    act(() => {
      tab2Name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const renameInput = host.querySelector<HTMLInputElement>('.cz-term-tab__rename')!;
    expect(renameInput).not.toBeNull();
    act(() => setNativeValue(renameInput, '新名字'));
    act(() => {
      renameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onRename).toHaveBeenCalledWith('tab-2', '新名字');

    // 3. Ctrl+Shift+T 触发新建
    act(() => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true, bubbles: true }));
    });
    expect(onNew).toHaveBeenCalledTimes(1);

    // 4. 点运行中标签 1 的关闭按钮 → 出现面板内确认条，确认后关闭
    const closeBtn1 = host.querySelectorAll<HTMLButtonElement>('.cz-term-tab__close')[0]!;
    act(() => closeBtn1.click());
    expect(host.querySelector('.cz-term__confirm')).not.toBeNull();
    expect(host.querySelector('.cz-term__confirm')!.textContent).toContain('npm run dev');
    expect(onCloseSpy).not.toHaveBeenCalled();

    const confirmDanger = host.querySelector<HTMLButtonElement>('.cz-term__confirm-btn.is-danger')!;
    act(() => confirmDanger.click());
    expect(onCloseSpy).toHaveBeenCalledWith('tab-1');
    // 现在只剩 1 个标签：标题栏回到简洁工作空间样式（无多标签栏）
    expect(host.querySelectorAll('.cz-term-tab')).toHaveLength(0);

    // 5. Ctrl+Shift+W 关闭最后一个空闲标签 → 收起面板
    act(() => {
      panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'W', ctrlKey: true, shiftKey: true, bubbles: true }));
    });
    expect(onCloseSpy).toHaveBeenCalledWith('tab-2');
    expect(onPanelClose).toHaveBeenCalledTimes(1);
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
