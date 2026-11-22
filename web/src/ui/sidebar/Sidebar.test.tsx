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
    sessions: [s('a', 'Alpha'), s('b', 'Beta')],
    pinned: [],
    deleted: [],
    currentSessionId: null,
    account: null,
    onNewSession: vi.fn(), onCollapse: vi.fn(),
    onSelectSession: vi.fn(), onTogglePin: vi.fn(), onDeleteSession: vi.fn(),
    onRestoreSession: vi.fn(), onPurgeSession: vi.fn(),
    onDeleteSessions: vi.fn(), onRestoreSessions: vi.fn(), onPurgeSessions: vi.fn(),
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

  it('会话列表按工作空间分组：每个工作空间一组，组头显示名字', () => {
    const sessions = [s('a', 'Alpha'), s('z', 'Zed', { cwd: 'D:\\axiom' })];
    mount(<Sidebar {...props({ sessions })} />);
    const groups = [...document.querySelectorAll('.cz-sidebar__group')];
    expect(groups.map((g) => g.querySelector('.cz-sidebar__group-name')!.textContent)).toEqual(['Cosyee', 'axiom']);
    expect(groups.map((g) => [...g.querySelectorAll('.cz-sidebar__row-title')].map((e) => e.textContent))).toEqual([['Alpha'], ['Zed']]);
  });

  it('点组头折叠 / 展开该组；搜索时所有有匹配的组都展开，没有匹配的组隐藏', () => {
    const sessions = [s('a', 'Alpha'), s('z', 'Zed', { cwd: 'D:\\axiom' })];
    mount(<Sidebar {...props({ sessions })} />);
    click(document.querySelector('.cz-sidebar__group-head')!);
    expect(listTitles()).toEqual(['Zed']);
    click(document.querySelector('.cz-sidebar__group-head')!);
    expect(listTitles()).toEqual(['Alpha', 'Zed']);

    click(document.querySelector('.cz-sidebar__group-head')!); // 先折叠 Cosyee
    click(byLabel('搜索')!);
    typeInto(document.querySelector('input') as HTMLInputElement, 'alpha');
    expect(listTitles()).toEqual(['Alpha']);
    expect(document.querySelectorAll('.cz-sidebar__group').length).toBe(1);
  });

  it('侧栏里不再有工作空间选择器', () => {
    mount(<Sidebar {...props()} />);
    expect(document.querySelector('.cz-sidebar__ws')).toBeNull();
  });

  it('运行中的会话：删除按钮禁用', () => {
    mount(<Sidebar {...props({ sessions: [s('a', 'Alpha', { dot: 'running' })] })} />);
    const del = document.querySelector('.cz-sidebar__list [role="listitem"] .cz-sidebar__act--danger') as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    // 组里只有执行中的会话：组头的「删除全部」也禁用
    expect((byLabel('删除此工作空间的全部会话') as HTMLButtonElement).disabled).toBe(true);
  });

  it('组头「删除全部会话」：气泡确认后只删这一组显示的、不在执行中的会话；双击不能跳过确认', () => {
    const onDeleteSessions = vi.fn();
    const sessions = [
      s('a', 'Alpha'), s('b', 'Beta', { pinned: 'manual' }), s('r', 'Run', { dot: 'running' }),
      s('z', 'Zed', { cwd: 'D:\\axiom' }),
    ];
    mount(<Sidebar {...props({ sessions, pinned: [sessions[1]!], onDeleteSessions })} />);
    const btn = document.querySelector('.cz-sidebar__group [aria-label="删除此工作空间的全部会话"]')!;
    click(btn);
    click(btn);
    dblclick(btn);
    expect(onDeleteSessions).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(CONFIRM_DELAY_MS + 1); });
    const pop = document.querySelector('.cz-sidebar__confirm')!;
    expect(pop.textContent).toContain('删除「Cosyee」的全部 1 个会话？');
    expect(pop.textContent).toContain('1 个正在执行的会话会跳过');
    expect(pop.textContent).toContain('置顶的会话不受影响');
    click(pop.querySelector('.cz-sidebar__confirm-btn--danger')!);
    expect(onDeleteSessions).toHaveBeenCalledWith('F:\\Cosyee', ['a']);
  });

  it('搜索时组头的删除只针对匹配的会话', () => {
    const onDeleteSessions = vi.fn();
    mount(<Sidebar {...props({ sessions: [s('a', 'Alpha'), s('b', 'Beta')], onDeleteSessions })} />);
    click(byLabel('搜索')!);
    typeInto(document.querySelector('input') as HTMLInputElement, 'beta');
    click(byLabel('删除此工作空间中匹配的会话')!);
    act(() => { vi.advanceTimersByTime(CONFIRM_DELAY_MS + 1); });
    expect(document.querySelector('.cz-sidebar__confirm')!.textContent).toContain('中匹配的 1 个会话');
    click(document.querySelector('.cz-sidebar__confirm-btn--danger')!);
    expect(onDeleteSessions).toHaveBeenCalledWith('F:\\Cosyee', ['b']);
  });

  it('已删除标题行：全部恢复 / 全部永久删除；展开搜索后只作用于匹配的；没有已删除时不显示', () => {
    const onRestoreSessions = vi.fn();
    const onPurgeSessions = vi.fn();
    const deleted: DeletedSession[] = [
      { id: 'd1', cwd: 'D:\\axiom', title: '旧会话', deletedAt: 2 },
      { id: 'd2', cwd: 'F:\\Cosyee', title: '另一个', deletedAt: 1 },
    ];
    mount(<Sidebar {...props({ deleted, onRestoreSessions, onPurgeSessions })} />);
    click(byLabel('全部恢复')!);
    act(() => { vi.advanceTimersByTime(CONFIRM_DELAY_MS + 1); });
    expect(document.querySelector('.cz-sidebar__confirm-btn--danger')).toBeNull(); // 恢复不是危险操作
    click(document.querySelector('.cz-sidebar__confirm-btn--primary')!);
    expect(onRestoreSessions).toHaveBeenCalledWith(['d1', 'd2']);

    click(document.querySelector('.cz-sidebar__deleted-head')!);
    click(byLabel('搜索已删除的会话')!);
    typeInto(document.querySelector('.cz-sidebar__deleted input') as HTMLInputElement, '另一');
    click(byLabel('永久删除匹配的会话')!);
    act(() => { vi.advanceTimersByTime(CONFIRM_DELAY_MS + 1); });
    expect(document.querySelector('.cz-sidebar__confirm')!.textContent).toContain('永久删除匹配的 1 个会话？');
    click(document.querySelector('.cz-sidebar__confirm-btn--danger')!);
    expect(onPurgeSessions).toHaveBeenCalledWith(['d2']);

    // 收起时清空搜索词：再次作用于全部
    click(document.querySelector('.cz-sidebar__deleted-head')!);
    expect(byLabel('全部永久删除')).not.toBeNull();
  });

  it('没有已删除的会话时标题行不出现批量按钮', () => {
    mount(<Sidebar {...props()} />);
    expect(byLabel('全部恢复')).toBeNull();
    expect(byLabel('全部永久删除')).toBeNull();
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
