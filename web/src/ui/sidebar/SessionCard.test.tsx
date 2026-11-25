// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DeletedSession, SessionDetail, SessionSummary } from '@cosyee/shared';
import { SessionHeader } from '../header/SessionHeader';
import { COLD_DELAY_MS, LEAVE_GRACE_MS, WARM_DELAY_MS } from './SessionCard';
import { Sidebar, type SidebarProps } from './Sidebar';
import {
  SessionDetailContext,
  clearSessionDetailCache,
  detailCacheKey,
  loadSessionDetail,
  type SessionDetailLoader,
} from './sessionDetail';
import { useDismiss } from './useDismiss';

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

// jsdom 没有原生 PointerEvent：用 MouseEvent 补 pointerType，React 18 的 onPointerEnter/Leave 监听 pointerover/pointerout
function pointerEvent(type: 'pointerover' | 'pointerout' | 'pointerdown', pointerType = 'mouse'): Event {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'pointerType', { value: pointerType });
  return ev;
}

const enter = (el: Element, pointerType = 'mouse') => act(() => { el.dispatchEvent(pointerEvent('pointerover', pointerType)); });
const leave = (el: Element, pointerType = 'mouse') => act(() => { el.dispatchEvent(pointerEvent('pointerout', pointerType)); });
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const pressEsc = () => act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
const flushPromises = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const card = () => document.querySelector<HTMLElement>('.cz-scard[role="tooltip"]');

const makeDetail = (over: Partial<SessionDetail> = {}): SessionDetail => ({
  createdAt: Date.now() - 4 * 3_600_000,
  lastMessageAt: Date.now() - 10 * 60_000,
  userMessages: 6,
  toolCalls: 15,
  firstPrompt: '第一条用户消息',
  lastPrompt: '最近一条用户消息',
  lastReply: '助手最近一条回复内容',
  model: 'claude-sonnet-5-5-20260101',
  branch: 'feat/card',
  contextTokens: 42_500,
  ...over,
});

const makeSession = (id: string, title: string, over: Partial<SessionSummary> = {}): SessionSummary => ({
  id,
  cwd: 'F:\\Cosyee',
  title,
  lastActiveAt: Date.now() - 5 * 60_000,
  dot: null,
  pinned: null,
  ...over,
});

function sidebarProps(over: Partial<SidebarProps> = {}): SidebarProps {
  return {
    workspaces: [{ path: 'F:\\Cosyee', name: 'Cosyee' }, { path: 'D:\\axiom', name: 'axiom' }],
    sessions: [
      makeSession('a', '会话 A', { config: { model: 'opus', effort: 'high' }, account: '工作' }),
      makeSession('b', '会话 B', { dot: 'unread', lastModel: 'claude-sonnet-5-5-20260101' }),
    ],
    pinned: [],
    deleted: [],
    currentSessionId: null,
    account: null,
    onNewSession: vi.fn(),
    onCollapse: vi.fn(),
    onSelectSession: vi.fn(),
    onTogglePin: vi.fn(),
    onDeleteSession: vi.fn(),
    onRestoreSession: vi.fn(),
    onPurgeSession: vi.fn(),
    onDeleteSessions: vi.fn(),
    onRestoreSessions: vi.fn(),
    onPurgeSessions: vi.fn(),
    ...over,
  };
}

const rowBtn = (title: string) =>
  [...document.querySelectorAll<HTMLElement>('.cz-sidebar__row-main')].find((el) =>
    el.querySelector('.cz-sidebar__row-title')?.textContent === title,
  )!;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  vi.useRealTimers();
});

describe('SessionCard 侧栏悬浮卡片', () => {
  it('原生 title 已从侧栏会话行、置顶行、已删除行和带 session 的头部标题移除', () => {
    const pinned = [makeSession('p1', '置顶会话', { cwd: 'D:\\axiom', pinned: 'manual' })];
    const deleted: DeletedSession[] = [{ id: 'd1', cwd: 'F:\\Cosyee', title: '已删会话', deletedAt: Date.now() - 60_000 }];
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps({ pinned, deleted })} />
        <SessionHeader title="当前会话" cwd="F:\\Cosyee" branch="main" session={makeSession('a', '当前会话')} onRename={vi.fn()} />
      </SessionDetailContext.Provider>,
    );
    // 展开已删除区
    click(document.querySelector('.cz-sidebar__deleted-head')!);
    for (const el of document.querySelectorAll('.cz-sidebar__row-main')) {
      expect(el.getAttribute('title')).toBeNull();
    }
    expect(document.querySelector('.cz-header__title')!.getAttribute('title')).toBeNull();
  });

  it('悬停延迟 400ms 打开卡片、关联 aria-describedby，详情到达后填入内容', async () => {
    let resolveDetail!: (d: SessionDetail) => void;
    const loader = vi.fn<SessionDetailLoader>(() => new Promise((r) => { resolveDetail = r; }));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const btn = rowBtn('会话 A');
    enter(btn);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS - 10); });
    expect(card()).toBeNull();
    expect(loader).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(20); });
    const c = card()!;
    expect(c).not.toBeNull();
    expect(btn.getAttribute('aria-describedby')).toBe(c.id);
    // 立即显示 summary 已有信息 + 加载骨架
    expect(c.textContent).toContain('会话 A');
    expect(c.textContent).toContain('Opus 5.5 · 思考 高');
    expect(c.textContent).toContain('工作');
    expect(c.querySelector('.cz-scard__skel')).not.toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);

    resolveDetail(makeDetail());
    await flushPromises();
    expect(c.textContent).toContain('最近一条用户消息');
    expect(c.textContent).toContain('助手最近一条回复内容');
    expect(c.textContent).toContain('feat/card');
    expect(c.textContent).toContain('42.5k');
    expect(c.textContent).toContain('6 条消息 · 15 次工具调用');
  });

  it('快速扫过列表（未满 400ms 离开）不发请求、不出卡片', () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const a = rowBtn('会话 A');
    const b = rowBtn('会话 B');
    enter(a);
    act(() => { vi.advanceTimersByTime(150); });
    leave(a);
    enter(b);
    act(() => { vi.advanceTimersByTime(150); });
    leave(b);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(card()).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('离开后过宽限期关闭；宽限期内移入卡片不关闭，离开卡片后再关闭', async () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const a = rowBtn('会话 A');
    enter(a);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    await flushPromises();
    expect(card()).not.toBeNull();

    // 离开行，80ms 内移入卡片：保持打开
    leave(a);
    act(() => { vi.advanceTimersByTime(80); });
    expect(card()).not.toBeNull();
    enter(card()!);
    act(() => { vi.advanceTimersByTime(500); });
    expect(card()).not.toBeNull();

    // 离开卡片：宽限期后关闭
    leave(card()!);
    act(() => { vi.advanceTimersByTime(LEAVE_GRACE_MS - 10); });
    expect(card()).not.toBeNull();
    act(() => { vi.advanceTimersByTime(20); });
    expect(card()).toBeNull();
    expect(a.getAttribute('aria-describedby')).toBeNull();
  });

  it('warm 切换：打开状态或关闭 300ms 内移到另一行只需 70ms 切换', async () => {
    const loader = vi.fn<SessionDetailLoader>((id) => Promise.resolve(makeDetail({ lastPrompt: `消息-${id}` })));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const a = rowBtn('会话 A');
    const b = rowBtn('会话 B');
    enter(a);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    await flushPromises();
    expect(card()!.textContent).toContain('会话 A');

    // 开着时切到 B：70ms 就切换
    leave(a);
    enter(b);
    act(() => { vi.advanceTimersByTime(WARM_DELAY_MS + 10); });
    await flushPromises();
    expect(card()!.textContent).toContain('会话 B');
    expect(card()!.textContent).toContain('消息-b');

    // 关闭后 300ms 内再移到 A：同样 70ms 就打开
    pressEsc();
    expect(card()).toBeNull();
    act(() => { vi.advanceTimersByTime(200); });
    enter(a);
    act(() => { vi.advanceTimersByTime(WARM_DELAY_MS + 10); });
    await flushPromises();
    expect(card()!.textContent).toContain('会话 A');
  });

  it('快速切换时旧请求后到达不会覆盖新行的数据', async () => {
    const resolvers = new Map<string, (d: SessionDetail) => void>();
    const loader = vi.fn<SessionDetailLoader>((id) => new Promise((r) => { resolvers.set(id, r); }));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const a = rowBtn('会话 A');
    const b = rowBtn('会话 B');
    enter(a);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    expect(resolvers.has('a')).toBe(true);

    // A 还没回来就切到 B
    leave(a);
    enter(b);
    act(() => { vi.advanceTimersByTime(WARM_DELAY_MS + 10); });
    expect(resolvers.has('b')).toBe(true);

    // B 先回来
    resolvers.get('b')!(makeDetail({ lastPrompt: '这是B的详情' }));
    await flushPromises();
    expect(card()!.textContent).toContain('这是B的详情');

    // A 后回来，绝不串到 B 上
    resolvers.get('a')!(makeDetail({ lastPrompt: '这是A的旧详情' }));
    await flushPromises();
    expect(card()!.textContent).toContain('这是B的详情');
    expect(card()!.textContent).not.toContain('这是A的旧详情');
  });

  it('详情读取失败：显示「详情读取失败」且不影响 summary，失败不缓存', async () => {
    let calls = 0;
    const loader = vi.fn<SessionDetailLoader>(() => {
      calls++;
      return calls === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(makeDetail({ lastPrompt: '重试成功' }));
    });
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const a = rowBtn('会话 A');
    enter(a);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    await flushPromises();
    expect(card()!.textContent).toContain('详情读取失败');
    expect(card()!.textContent).toContain('会话 A');

    // 关掉再重新悬停：会重新发起请求
    pressEsc();
    enter(a);
    act(() => { vi.advanceTimersByTime(WARM_DELAY_MS + 10); });
    await flushPromises();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(card()!.textContent).toContain('重试成功');
  });

  it('缓存命中不重发请求；执行中会话 5 秒后过期；同键并发合并', async () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    const k1 = detailCacheKey('x', 'F:\\p', 1000, null);
    const [r1, r2] = await Promise.all([
      loadSessionDetail(loader, 'x', 'F:\\p', k1, false),
      loadSessionDetail(loader, 'x', 'F:\\p', k1, false),
    ]);
    expect(r1).toBe(r2);
    expect(loader).toHaveBeenCalledTimes(1);

    // 再次读取命中缓存
    await loadSessionDetail(loader, 'x', 'F:\\p', k1, false);
    expect(loader).toHaveBeenCalledTimes(1);

    // 执行中会话超过 5 秒过期重新请求
    const kRun = detailCacheKey('r', 'F:\\p', 2000, 'running');
    await loadSessionDetail(loader, 'r', 'F:\\p', kRun, true);
    expect(loader).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(4000);
    await loadSessionDetail(loader, 'r', 'F:\\p', kRun, true);
    expect(loader).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    await loadSessionDetail(loader, 'r', 'F:\\p', kRun, true);
    expect(loader).toHaveBeenCalledTimes(3);

    clearSessionDetailCache(loader);
  });

  it('点击行、Esc、悬停行内操作按钮、列表滚动均关闭；卡片内部滚动不关闭', async () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const a = rowBtn('会话 A');

    // 1. 点击关闭
    enter(a);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    expect(card()).not.toBeNull();
    click(a);
    expect(card()).toBeNull();

    // 2. Esc（无焦点在卡片内也能关）
    enter(a);
    act(() => { vi.advanceTimersByTime(WARM_DELAY_MS + 10); });
    expect(card()).not.toBeNull();
    pressEsc();
    expect(card()).toBeNull();

    // 3. 移过行内操作按钮不关（去卡片的必经之路），按下才关
    enter(a);
    act(() => { vi.advanceTimersByTime(WARM_DELAY_MS + 10); });
    expect(card()).not.toBeNull();
    const actions = a.parentElement!.querySelector('.cz-sidebar__actions')!;
    leave(a);
    enter(actions);
    expect(card()).not.toBeNull();
    act(() => { actions.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); });
    expect(card()).toBeNull();

    // 4. 卡片内部滚动不关，列表滚动关闭
    enter(a);
    act(() => { vi.advanceTimersByTime(WARM_DELAY_MS + 10); });
    const scrollBox = card()!.querySelector('.cz-scard__scroll')!;
    act(() => { scrollBox.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(card()).not.toBeNull();
    const flow = document.body.appendChild(document.createElement('div'));
    act(() => { flow.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(card()).not.toBeNull(); // 会话流输出时自己滚，与卡片无关
    flow.remove();
    const list = document.querySelector('.cz-sidebar__list')!;
    act(() => { list.dispatchEvent(new Event('scroll', { bubbles: false })); });
    expect(card()).toBeNull();
  });

  it('经过另一行没等到切换就离开，卡片仍会按宽限关闭', () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const a = rowBtn('会话 A');
    const b = rowBtn('会话 B');
    enter(a);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    expect(card()).not.toBeNull();
    leave(a);
    enter(b);
    act(() => { vi.advanceTimersByTime(WARM_DELAY_MS - 20); });
    leave(b);
    act(() => { vi.advanceTimersByTime(LEAVE_GRACE_MS + 200); });
    expect(card()).toBeNull();
  });

  it('卡片开着时同一会话有更新：先留着旧详情，不退回骨架；刷新失败也不丢', async () => {
    const loader = vi.fn<SessionDetailLoader>()
      .mockResolvedValueOnce(makeDetail({ branch: 'feat/old' }))
      .mockRejectedValue(new Error('x'));
    const render = (p: SidebarProps) => (
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...p} />
      </SessionDetailContext.Provider>
    );
    const s = makeSession('a', '会话 A');
    mount(render(sidebarProps({ sessions: [s] })));
    enter(rowBtn('会话 A'));
    await act(async () => { await vi.advanceTimersByTimeAsync(COLD_DELAY_MS + 300); });
    expect(card()!.textContent).toContain('feat/old');

    act(() => root!.render(render(sidebarProps({
      sessions: [{ ...s, dot: 'running', lastActiveAt: s.lastActiveAt + 1000, config: { model: 'opus', effort: 'high' } }],
    }))));
    expect(loader).toHaveBeenCalledTimes(2);
    expect(card()!.textContent).toContain('feat/old');
    expect(card()!.textContent).toContain('执行中');
    expect(card()!.textContent).toContain('思考 高'); // 换模型 / 思考强度跟着更新
    expect(card()!.querySelector('.cz-scard__skel')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(card()!.textContent).toContain('feat/old');
    expect(card()!.textContent).not.toContain('详情读取失败');
  });

  it('删除确认气泡开着时悬停不再弹卡片', () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    const a = rowBtn('会话 A');
    click(a.parentElement!.querySelector('[aria-label="删除会话"]')!);
    act(() => { vi.advanceTimersByTime(300); });
    expect(document.querySelector('.cz-sidebar__confirm')).not.toBeNull();
    enter(a);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 100); });
    expect(card()).toBeNull();
  });

  it('Esc 与 useDismiss 分层协调：上层弹层打开时第一次 Esc 只关上层，不连关卡片', () => {
    const onTopDismiss = vi.fn();
    function TopLayer({ open }: { open: boolean }) {
      const ref = { current: null };
      useDismiss(open, ref, onTopDismiss);
      return null;
    }
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    const props = sidebarProps();
    const render = (topOpen: boolean) => (
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...props} />
        <TopLayer open={topOpen} />
      </SessionDetailContext.Provider>
    );
    mount(render(false));
    enter(rowBtn('会话 A'));
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    expect(card()).not.toBeNull();

    // 卡片打开后再叠一层 useDismiss
    act(() => root!.render(render(true)));
    pressEsc();
    expect(onTopDismiss).toHaveBeenCalledTimes(1);
    expect(card()).not.toBeNull();

    // 上层关掉后，第二次 Esc 才关卡片
    act(() => root!.render(render(false)));
    pressEsc();
    expect(card()).toBeNull();
  });

  it('触屏指针（pointerType !== mouse）不触发卡片', () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    enter(rowBtn('会话 A'), 'touch');
    act(() => { vi.advanceTimersByTime(1000); });
    expect(card()).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('已删除行：悬停显示「已删除」、工作空间、删除时间与详情', async () => {
    const deleted: DeletedSession[] = [
      { id: 'd1', cwd: 'D:\\axiom', title: '已删试验', deletedAt: Date.now() - 2 * 3_600_000 },
    ];
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail({ lastPrompt: null, firstPrompt: '第一条测试' })));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps({ deleted })} />
      </SessionDetailContext.Provider>,
    );
    click(document.querySelector('.cz-sidebar__deleted-head')!);
    const row = rowBtn('已删试验');
    enter(row);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    await flushPromises();
    const c = card()!;
    expect(c.textContent).toContain('已删除');
    expect(c.textContent).toContain('删除时间');
    expect(c.textContent).toContain('axiom');
    expect(c.textContent).toContain('最近消息');
    expect(c.textContent).toContain('第一条测试');
    // lastPrompt 为 null 时不显示「最初」
    expect(c.textContent).not.toContain('最初');
  });

  it('搜索过滤掉当前悬停行时关闭卡片', () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <Sidebar {...sidebarProps()} />
      </SessionDetailContext.Provider>,
    );
    enter(rowBtn('会话 A'));
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    expect(card()).not.toBeNull();

    // 打开搜索并输入不匹配会话 A 的词
    click(document.querySelector('[aria-label="搜索"]')!);
    const input = document.querySelector<HTMLInputElement>('.cz-sidebar__search-input')!;
    const setVal = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    act(() => {
      setVal.call(input, '会话 B');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(card()).toBeNull();
  });
});

describe('SessionCard 会话头部', () => {
  it('传入 session 时悬停出卡片并带「点击标题改名」提示；点击进入改名编辑立即关闭', async () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    const s = makeSession('h1', '头部会话', { pinned: 'manual' });
    mount(
      <SessionDetailContext.Provider value={loader}>
        <SessionHeader title={s.title} cwd={s.cwd} branch="main" session={s} onRename={vi.fn()} />
      </SessionDetailContext.Provider>,
    );
    const titleBtn = document.querySelector<HTMLButtonElement>('.cz-header__title')!;
    expect(titleBtn.getAttribute('title')).toBeNull();

    enter(titleBtn);
    act(() => { vi.advanceTimersByTime(COLD_DELAY_MS + 10); });
    await flushPromises();
    expect(card()!.textContent).toContain('头部会话');
    expect(card()!.textContent).toContain('已置顶');
    expect(card()!.textContent).toContain('点击标题改名');

    // 点击进入改名编辑 -> 卡片关闭
    click(titleBtn);
    expect(document.querySelector('.cz-header__input')).not.toBeNull();
    expect(card()).toBeNull();
  });

  it('没有 session（新会话）时保留原 title="点击改名"，悬停不出卡片', () => {
    const loader = vi.fn<SessionDetailLoader>(() => Promise.resolve(makeDetail()));
    mount(
      <SessionDetailContext.Provider value={loader}>
        <SessionHeader title={null} cwd="F:\\Cosyee" branch="main" session={null} onRename={vi.fn()} />
      </SessionDetailContext.Provider>,
    );
    const titleBtn = document.querySelector<HTMLButtonElement>('.cz-header__title')!;
    expect(titleBtn.getAttribute('title')).toBe('点击改名');
    enter(titleBtn);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(card()).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });
});
