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
  it('不出现「默认账号」：备注名与套餐用 · 连接，没凭据的标「需要登录」', () => {
    expect(entrySubtitle(entry({}))).toBe('Pro');
    expect(entryTitle(entry({ name: null }))).toBe('Claude 账号');
    expect(entryTitle(entry({ name: null, loggedIn: false }))).toBe('未登录账号');
    const w = entry({ id: 'a1', label: '工作', name: null, plan: null, loggedIn: false, isDefault: false });
    expect(entryTitle(w)).toBe('工作');
    expect(entrySubtitle(w)).toBe('需要登录');
    expect(entrySubtitle(entry({ label: '个人' }))).toBe('个人 · Pro');
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

  it('菜单打开时并行读取每个已登录账号的额度，显示进度条与重置说明；失败只显示淡提示', async () => {
    const soon = Date.now() + (2 * 60 + 14) * 60_000;
    routes = {
      'GET /api/accounts': () => ({ body: list([
        entry({}),
        entry({ id: 'a1', label: '工作', name: 'Bob', active: false, isDefault: false }),
        entry({ id: 'a2', name: null, loggedIn: false, active: false, isDefault: false }),
      ]) }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [
        { kind: 'session', percent: 32, severity: 'normal', resetsAt: soon },
        { kind: 'weekly', percent: 91, severity: 'warning', resetsAt: null },
      ] } }),
      'GET /api/usage?account=a1': () => ({ status: 500, body: { error: 'x' } }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    // 额度请求还没返回前显示骨架
    expect(document.querySelectorAll('[data-testid="quota-skeleton"]').length).toBeLessThanOrEqual(2);
    await flush();
    const items = document.querySelectorAll('.cz-sidebar__menu-item');
    expect(items[0].textContent).toContain('会话 32% · 2小时14分后重置');
    expect(items[0].textContent).toContain('本周 91%');
    const bars = items[0].querySelectorAll('[role="progressbar"]');
    expect(bars.length).toBe(2);
    expect(bars[0].getAttribute('aria-valuenow')).toBe('32');
    expect(items[0].querySelector('.cz-acctq__row.is-warning')).not.toBeNull();
    expect(items[1].textContent).toContain('额度读取失败');
    // 没登录的账号不取额度
    expect(calls.filter((c) => c.url.startsWith('/api/usage')).map((c) => c.url).sort()).toEqual(['/api/usage?account=a1', '/api/usage?account=default']);
    expect(document.body.textContent).not.toContain('默认账号');
    // 额度读取失败不影响切换
    expect((items[1].querySelector('.cz-sidebar__menu-main') as HTMLButtonElement).disabled).toBe(false);
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

  const type = (el: HTMLInputElement, v: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const dlgBtn = (text: string) =>
    // 取最后一个：模型映射表里也有个「添加」（加自定义模型），底部提交按钮在它后面
    [...document.querySelectorAll('[role="dialog"] button')].reverse().find((b) => b.textContent === text) as HTMLButtonElement;
  const apiEntry = entry({
    id: 'a2', label: '代理', name: '代理', plan: 'API', active: false, isDefault: false,
    api: { baseUrl: 'https://proxy.example.com/v1', authType: 'authToken', keyHint: '3456' },
  });

  it('API 账号：副标题显示主机名，不取额度；添加时可切到 API Key 方式并提交 Base URL / 密钥', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), apiEntry]) }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [] } }),
      'POST /api/accounts/api': () => ({ body: { ok: true, id: 'a3' } }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(entrySubtitle(apiEntry)).toBe('API · proxy.example.com');
    expect(calls.filter((c) => c.url.startsWith('/api/usage')).map((c) => c.url)).toEqual(['/api/usage?account=default']);
    // 当前账号不能删，但 API 账号（非当前）有修改和移除
    expect(document.querySelector('[aria-label="修改 API 账号"]')).not.toBeNull();

    click(button('添加账号')!);
    await flush();
    click([...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'API Key')!);
    await flush();
    const dlg = document.querySelector('[role="dialog"]')!;
    // 主字段：备注名 / Base URL / API Key（模型映射表里的输入框都带 cz-mmap__input，排除掉）
    const inputs = dlg.querySelectorAll<HTMLInputElement>('.cz-acct-dlg__input:not(.cz-mmap__input)');
    expect(inputs.length).toBe(3);
    expect(dlgBtn('添加').disabled).toBe(true); // 没填密钥
    type(inputs[1], 'https://gw.example.com/');
    type(inputs[2], 'sk-test-123456789');
    click([...dlg.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Bearer')!);
    click(dlgBtn('添加'));
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/api')?.body).toEqual({
      label: '', baseUrl: 'https://gw.example.com/', apiKey: 'sk-test-123456789', authType: 'authToken', models: null,
    });
    expect(document.body.textContent).toContain('已添加');
    expect(button('切换到该账号')).toBeDefined();
  });

  it('修改 API 账号：预填 Base URL，密钥留空不提交', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), apiEntry]) }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [] } }),
      'POST /api/accounts/api': () => ({ body: { ok: true, id: 'a2' } }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    click(document.querySelector('[aria-label="修改 API 账号"]')!);
    await flush();
    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.textContent).toContain('修改 API 账号：代理');
    expect(dlg.querySelector('[role="radiogroup"][aria-label="添加方式"]')).toBeNull();
    const inputs = dlg.querySelectorAll<HTMLInputElement>('.cz-acct-dlg__input:not(.cz-mmap__input)');
    expect(inputs[1].value).toBe('https://proxy.example.com/v1');
    expect(inputs[2].placeholder).toContain('…3456');
    click(dlgBtn('保存'));
    await flush();
    // 该账号没配映射，映射表也没动过 → models: null（显式清空，服务端规范化后仍是「没有映射」）
    expect(calls.find((c) => c.url === '/api/accounts/api')?.body).toEqual({
      id: 'a2', label: '代理', baseUrl: 'https://proxy.example.com/v1', authType: 'authToken', models: null,
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
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
