// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeletedSession, SessionSummary } from '@cosyee/shared';
import { ConfirmActionButton, CONFIRM_DELAY_MS } from './ActionButtons';
import { SearchRow } from './SearchRow';
import { Sidebar, type SidebarProps } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(el: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.useRealTimers();
});

const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const dblclick = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
const byLabel = (label: string) => document.querySelector(`[aria-label="${label}"]`) as HTMLElement | null;
const typeInto = (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('ConfirmActionButton', () => {
  const setup = (extra: { disabled?: boolean } = {}) => {
    const onConfirm = vi.fn();
    mount(<ConfirmActionButton icon="trash" label="删除" confirmText="删除此会话？" onConfirm={onConfirm} {...extra} />);
    return onConfirm;
  };

  it('单击：延迟 250ms 后弹出确认气泡，点「删除」才执行', () => {
    const onConfirm = setup();
    click(byLabel('删除')!);
    expect(document.querySelector('.cz-sidebar__confirm')).toBeNull();
    act(() => { vi.advanceTimersByTime(CONFIRM_DELAY_MS + 1); });
    expect(document.querySelector('.cz-sidebar__confirm')).not.toBeNull();
    expect(onConfirm).not.toHaveBeenCalled();
    click(document.querySelector('.cz-sidebar__confirm-btn--danger')!);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.cz-sidebar__confirm')).toBeNull();
  });

  it('双击：取消单击的延迟动作，直接执行，不弹气泡', () => {
    const onConfirm = setup();
    const btn = byLabel('删除')!;
    click(btn);
    click(btn);
    dblclick(btn);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.cz-sidebar__confirm')).toBeNull();
  });

  it('点「取消」不执行', () => {
    const onConfirm = setup();
    click(byLabel('删除')!);
    act(() => { vi.advanceTimersByTime(CONFIRM_DELAY_MS + 1); });
    const cancel = [...document.querySelectorAll('.cz-sidebar__confirm-btn')].find((b) => b.textContent === '取消')!;
    click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(document.querySelector('.cz-sidebar__confirm')).toBeNull();
  });

  it('disabled 时按钮不可点', () => {
    setup({ disabled: true });
    expect((byLabel('删除') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('SearchRow', () => {
  function Host() {
    const [v, setV] = useState('');
    return <SearchRow value={v} onChange={setV} />;
  }

  it('点击变成输入框；为空失焦时还原；Esc 清空并还原', () => {
    mount(<Host />);
    expect(document.querySelector('input')).toBeNull();
    click(byLabel('搜索')!);
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();
    // React 的 onBlur 监听 focusout
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(document.querySelector('input')).toBeNull();

    click(byLabel('搜索')!);
    const input2 = document.querySelector('input') as HTMLInputElement;
    typeInto(input2, 'abc');
    act(() => { input2.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(document.querySelector('input')).not.toBeNull(); // 有内容时失焦不还原
    act(() => { input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('input')).toBeNull();
  });
});

const s = (id: string, title: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id, cwd: 'F:\\Cosyee', title, lastActiveAt: Date.now(), dot: null, pinned: null, ...over,
});

function props(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    workspaces: [{ path: 'F:\\Cosyee', name: 'Cosyee' }, { path: 'D:\\axiom', name: 'axiom' }],
    currentWorkspace: 'F:\\Cosyee',
    sessions: [s('a', 'Alpha'), s('b', 'Beta')],
    pinned: [],
    deleted: [],
    currentSessionId: null,
    account: null,
    onNewSession: vi.fn(), onCollapse: vi.fn(), onSelectWorkspace: vi.fn(), onOpenFolder: vi.fn(),
    onMoveWorkspaceTop: vi.fn(), onRemoveWorkspace: vi.fn(), onRevealWorkspace: vi.fn(),
    onSelectSession: vi.fn(), onTogglePin: vi.fn(), onDeleteSession: vi.fn(),
    onRestoreSession: vi.fn(), onPurgeSession: vi.fn(),
    ...over,
  };
}

const listTitles = () =>
  [...document.querySelectorAll('.cz-sidebar__list .cz-sidebar__row-title')].map((e) => e.textContent);

describe('Sidebar', () => {
  it('没有置顶时不显示「置顶」区', () => {
    mount(<Sidebar {...props()} />);
    expect(document.querySelector('.cz-sidebar__pinned')).toBeNull();
  });

  it('置顶的会话不在工作空间列表里重复出现，并显示所属工作空间名', () => {
    const pinned = [s('b', 'Beta', { pinned: 'manual' }), s('z', 'Zed', { cwd: 'D:\\axiom', pinned: 'auto' })];
    mount(<Sidebar {...props({ pinned })} />);
    const section = document.querySelector('.cz-sidebar__pinned')!;
    expect(section).not.toBeNull();
    expect(section.querySelectorAll('[role="listitem"]').length).toBe(2);
    expect(section.textContent).toContain('axiom');
    expect(listTitles()).toEqual(['Alpha']);
  });

  it('搜索按标题过滤（不区分大小写），同时过滤置顶区', () => {
    const pinned = [s('z', 'Zed Pinned', { cwd: 'D:\\axiom', pinned: 'manual' })];
    mount(<Sidebar {...props({ pinned })} />);
    click(byLabel('搜索')!);
    typeInto(document.querySelector('input') as HTMLInputElement, 'ALPHA');
    expect(listTitles()).toEqual(['Alpha']);
    expect(document.querySelector('.cz-sidebar__pinned')).toBeNull();
  });

  it('运行中的会话：删除按钮禁用', () => {
    mount(<Sidebar {...props({ sessions: [s('a', 'Alpha', { dot: 'running' })] })} />);
    const del = document.querySelector('.cz-sidebar__list .cz-sidebar__act--danger') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
  });

  it('已删除区默认折叠，显示数量，点开后列出带工作空间名的行', () => {
    const deleted: DeletedSession[] = [{ id: 'd1', cwd: 'D:\\axiom', title: '旧会话', deletedAt: 1 }];
    mount(<Sidebar {...props({ deleted })} />);
    expect(document.querySelector('.cz-sidebar__deleted-head')!.textContent).toContain('已删除 (1)');
    expect(document.querySelector('.cz-sidebar__deleted-list')).toBeNull();
    click(document.querySelector('.cz-sidebar__deleted-head')!);
    const list = document.querySelector('.cz-sidebar__deleted-list')!;
    expect(list.textContent).toContain('旧会话');
    expect(list.textContent).toContain('axiom');
  });
});
