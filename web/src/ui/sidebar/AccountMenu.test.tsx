// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountEntry, AccountList, AccountMode, SessionSummary } from '@cosyee/shared';
import { AccountMenu, accountPage, entrySubtitle, entryTitle } from './AccountMenu';
import { SessionRow } from './SessionRow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(el: React.ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

const entry = (over: Partial<AccountEntry>): AccountEntry => ({
  id: 'default', label: '', name: 'cosyeey', plan: 'Pro', loggedIn: true, active: true, isDefault: true, ...over,
});

interface Call { method: string; url: string; body: unknown }
let calls: Call[];
let routes: Record<string, (body: unknown) => { status?: number; body: unknown }>;
let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
  calls = [];
  reload = vi.fn();
  vi.spyOn(accountPage, 'reload').mockImplementation(reload);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const r = routes[`${method} ${url}`]?.(body) ?? { status: 404, body: { error: 'not found' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const list = (l: AccountEntry[], mode: AccountMode = 'switch'): AccountList => ({ mode, list: l, login: null });

describe('entryTitle / entrySubtitle', () => {
  it('默认账号显示「默认账号」，备注名与套餐用 · 连接，没凭据的标「需要登录」', () => {
    expect(entrySubtitle(entry({}))).toBe('默认账号 · Pro');
    const w = entry({ id: 'a1', label: '工作', name: null, plan: null, loggedIn: false, isDefault: false });
    expect(entryTitle(w)).toBe('工作');
    expect(entrySubtitle(w)).toBe('需要登录');
  });
});

describe('AccountMenu', () => {
  it('点击账户栏展示账号列表，当前账号打勾', async () => {
    routes = { 'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', label: '工作', name: 'Bob', active: false, isDefault: false })]) }) };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    const items = document.querySelectorAll('.cz-sidebar__menu-item');
    expect(items.length).toBe(3); // 两个账号 + 添加账号
    expect(items[0].classList.contains('is-active')).toBe(true);
    expect(items[0].querySelector('.cz-sidebar__acct-check')).not.toBeNull();
    expect(items[1].textContent).toContain('Bob');
    expect(items[1].textContent).toContain('工作');
    expect(button('添加账号')).toBeDefined();
  });

  it('有执行中的会话时提示，强制切换带 force 并刷新页面', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', name: 'Bob', active: false, isDefault: false })]) }),
      'POST /api/accounts/switch': (b) => ((b as { force?: boolean }).force
        ? { body: { ok: true } }
        : { status: 409, body: { error: '有会话正在执行', running: 2 } }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    click(button('Bob')!);
    await flush();
    expect(document.body.textContent).toContain('有 2 个会话正在执行');
    expect(reload).not.toHaveBeenCalled();
    click(button('强制切换')!);
    await flush();
    const sw = calls.filter((c) => c.url === '/api/accounts/switch');
    expect(sw.map((c) => c.body)).toEqual([{ id: 'a1', force: false }, { id: 'a1', force: true }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('没有登录凭据的账号点击后重新登录', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', label: '工作', name: null, loggedIn: false, active: false, isDefault: false })]) }),
      'POST /api/accounts/login': () => ({ body: { loginId: 'L1', status: 'waiting', url: 'https://claude.ai/oauth/authorize?x=1', accountId: null, error: null } }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    click(button('工作')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/login')?.body).toEqual({ accountId: 'a1' });
    expect(calls.some((c) => c.url === '/api/accounts/switch')).toBe(false);
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.textContent).toContain('重新登录：工作');
    expect(dlg.querySelector('a')?.getAttribute('href')).toBe('https://claude.ai/oauth/authorize?x=1');
  });
});

describe('并行模式', () => {
  it('账号菜单里选另一个账号：只换新会话用的账号，不刷新页面', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', name: 'Bob', active: false, isDefault: false })], 'parallel') }),
      'POST /api/accounts/switch': () => ({ body: { ok: true } }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(document.body.textContent).toContain('选择新会话使用的账号');
    click(button('Bob')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/switch')?.body).toEqual({ id: 'a1', force: false });
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector('.cz-sidebar__menu')).toBeNull();
  });

  const openMenu = async () => {
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
  };
  const seg = (label: string) =>
    [...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent === label) as HTMLButtonElement;

  it('模式切换在菜单里第一个账号上方，分段选择；默认切换模式，选并行模式不刷新页面', async () => {
    let mode: AccountMode = 'switch';
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})], mode) }),
      'POST /api/accounts/mode': (b) => { mode = (b as { mode: AccountMode }).mode; return { body: { ok: true } }; },
    };
    await openMenu();
    expect(document.querySelector('[role="switch"]')).toBeNull();
    const menu = document.querySelector('.cz-sidebar__menu')!;
    const group = menu.querySelector('[role="radiogroup"]')!;
    expect(group.compareDocumentPosition(menu.querySelector('.cz-sidebar__menu-item')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(seg('切换模式').getAttribute('aria-checked')).toBe('true');
    expect(seg('并行模式').getAttribute('aria-checked')).toBe('false');
    click(seg('切换模式'));
    await flush();
    expect(calls.some((c) => c.url === '/api/accounts/mode')).toBe(false);
    click(seg('并行模式'));
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/mode')?.body).toEqual({ mode: 'parallel', force: false });
    expect(seg('并行模式').getAttribute('aria-checked')).toBe('true');
    expect(reload).not.toHaveBeenCalled();
  });

  it('关闭并行模式时其它账号有执行中的会话：提示，强制切换带 force 并刷新页面', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})], 'parallel') }),
      'POST /api/accounts/mode': (b) => ((b as { force?: boolean }).force
        ? { body: { ok: true } }
        : { status: 409, body: { error: '其它账号有 1 个会话正在执行', running: 1 } }),
    };
    await openMenu();
    click(seg('切换模式'));
    await flush();
    expect(document.body.textContent).toContain('其它账号有 1 个会话正在执行');
    expect(reload).not.toHaveBeenCalled();
    click(button('强制切换')!);
    await flush();
    const ms = calls.filter((c) => c.url === '/api/accounts/mode');
    expect(ms.map((c) => c.body)).toEqual([{ mode: 'switch', force: false }, { mode: 'switch', force: true }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('会话行：有账号名时显示在标题下方（置顶区与工作空间名用 · 连接）', () => {
    const s = {
      id: 's1', cwd: 'F:/p', title: '修 bug', lastActiveAt: Date.now(), pinned: null, dot: null, account: '工作',
    } as unknown as SessionSummary;
    const noop = () => {};
    mount(<SessionRow session={s} active={false} now={Date.now()} workspaceLabel="p" onSelect={noop} onTogglePin={noop} onDelete={noop} />);
    const row = document.querySelector('.cz-sidebar__row')!;
    expect(row.classList.contains('has-sub')).toBe(true);
    expect(row.querySelector('.cz-sidebar__row-sub')?.textContent).toBe('p · 工作');
  });
});
