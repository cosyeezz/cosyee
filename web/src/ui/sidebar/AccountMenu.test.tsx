// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountEntry, AccountList, AccountLogin, AccountMode, AgyAccountEntry, AgyAccountList, SessionSummary } from '@cosyee/shared';
import { AccountMenu, accountPage, agySubtitle, agyTitle, apiMapNote, entrySubtitle, entryTitle, planChip } from './AccountMenu';
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
  localStorage.clear();
  // 分组默认都折叠；大部分用例要看 Claude 行，先记成展开（默认值由「分组默认折叠」用例单独验证）
  localStorage.setItem('cz-acct-groups-v2', JSON.stringify({ claude: true, agy: false }));
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
  it('不出现「默认账号」：副标题只放备注名 / 需要登录，套餐做成名字后的小标签', () => {
    expect(entrySubtitle(entry({}))).toBe('');
    expect(entryTitle(entry({ name: null }))).toBe('Claude 账号');
    expect(entryTitle(entry({ name: null, loggedIn: false }))).toBe('未登录账号');
    const w = entry({ id: 'a1', label: '工作', name: null, plan: null, loggedIn: false, isDefault: false });
    expect(entryTitle(w)).toBe('工作');
    expect(entrySubtitle(w)).toBe('需要登录');
    expect(entrySubtitle(entry({ label: '个人' }))).toBe('个人');
    expect(planChip('Pro')).toBe('Pro');
    expect(planChip('Google AI Ultra')).toBe('Ultra');
    expect(planChip('')).toBeNull();
    expect(planChip(null)).toBeNull();
  });

  it('API 账号在额度位置说明按量计费与映射了几个模型（别名 + 自定义条目）', () => {
    const base = { baseUrl: '', authType: 'apiKey' as const, keyHint: '' };
    expect(apiMapNote(base)).toBe('按量计费 · 未配置模型映射');
    expect(apiMapNote({ ...base, models: { alias: { opus: { id: 'x' } }, extra: [{ id: 'y' }, { id: 'z' }], fallback: 'w' } }))
      .toBe('按量计费 · 已映射 3 个模型');
  });
});

describe('AccountMenu', () => {
  it('点击账户栏展示账号列表，当前账号打勾', async () => {
    routes = { 'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', label: '工作', name: 'Bob', active: false, isDefault: false })]) }) };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    const items = document.querySelectorAll('.cz-sidebar__menu-item');
    expect(items.length).toBe(2); // 两个账号（底部不再有「添加账号」，走分组标题的「＋」）
    expect(items[0].classList.contains('is-active')).toBe(true);
    expect(items[0].querySelector('.cz-sidebar__acct-check')).not.toBeNull();
    expect(items[1].textContent).toContain('Bob');
    expect(items[1].textContent).toContain('工作');
    expect(button('添加账号')).toBeUndefined();
    expect(document.querySelector('[aria-label="添加 Claude 账号"]')).not.toBeNull();
    // 每行都有移除按钮：默认 / 当前账号置灰并说明原因，其它账号可点
    const rm0 = items[0].querySelector<HTMLButtonElement>('[aria-label="移除账号"]')!;
    expect(rm0.disabled).toBe(true);
    expect(rm0.title).toBe('默认账号不能移除');
    expect(items[1].querySelector<HTMLButtonElement>('[aria-label="移除账号"]')!.disabled).toBe(false);
  });

  it('有隐藏的重复账号时显示提示，点「清理」调用 dedupe 并刷新列表，报告跳过的个数', async () => {
    let dup = 2;
    routes = {
      'GET /api/accounts': () => ({ body: { ...list([entry({})]), duplicates: dup } }),
      'POST /api/accounts/dedupe': () => {
        dup = 1;
        return { body: { removed: 1, skipped: 1 } };
      },
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(document.querySelector('.cz-acct-dup')?.textContent).toContain('有 2 个重复的账号已隐藏');
    click(button('清理')!);
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/accounts/dedupe')).toBe(true);
    const note = document.querySelector('.cz-acct-dup')!.textContent!;
    expect(note).toContain('有 1 个重复的账号已隐藏');
    expect(note).toContain('已清理 1 个；1 个正在使用');
    // 剩下的 1 个就是刚才跳过的那个：不再给「清理」按钮
    expect(button('清理')).toBeUndefined();
  });

  it('没有重复账号时不显示清理提示', async () => {
    routes = { 'GET /api/accounts': () => ({ body: list([entry({})]) }) };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(document.querySelector('.cz-acct-dup')).toBeNull();
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
    // 重置时间行：有 resetsAt 时渲染，为 null 时不渲染
    expect(items[0].querySelectorAll('.cz-acctq__reset').length).toBe(1);
    expect(items[0].querySelector('.cz-acctq__row')?.getAttribute('title')).toBeNull();
  });

  it('菜单开着时倒计时每分钟刷新一次，关闭后清理计时器', async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 10, 24, 10, 0).getTime();
    vi.setSystemTime(base);
    const resetsAt = base + 10 * 60_000;
    const clearSpy = vi.spyOn(window, 'clearInterval');
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/usage?account=default': () => ({ body: { at: base, limits: [
        { kind: 'session', percent: 40, severity: 'normal', resetsAt },
      ] } }),
    };
    try {
      mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
      click(document.querySelector('[aria-label="账户菜单"]')!);
      await flush();
      expect(document.querySelector('.cz-acctq__reset')?.textContent).toContain('10分钟后重置');

      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(document.querySelector('.cz-acctq__reset')?.textContent).toContain('9分钟后重置');

      const beforeClose = clearSpy.mock.calls.length;
      click(document.querySelector('[aria-label="账户菜单"]')!);
      await flush();
      expect(clearSpy.mock.calls.length).toBeGreaterThan(beforeClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('账号到期时间：显示推算订阅到期与登录有效期（正常 / 7天内警告 / 已失效 / API 与缺项不显示）', async () => {
    vi.useFakeTimers();
    const now = new Date(2026, 10, 24, 12, 0).getTime();
    vi.setSystemTime(now);
    const DAY = 24 * 3_600_000;
    routes = {
      'GET /api/accounts': () => ({ body: list([
        entry({ id: 'default', subscribedAt: new Date(2026, 10, 9).getTime(), loginExpiresAt: new Date(2026, 11, 16).getTime() }),
        entry({ id: 'a1', name: 'WarnUser', active: false, isDefault: false, subscribedAt: null, loginExpiresAt: now + 3 * DAY }),
        entry({ id: 'a2', name: 'ExpUser', active: false, isDefault: false, plan: null, subscribedAt: new Date(2026, 10, 9).getTime(), loginExpiresAt: now - 1000 }),
        entry({ id: 'a3', name: 'ApiAcc', plan: 'API', active: false, isDefault: false, subscribedAt: new Date(2026, 10, 9).getTime(), loginExpiresAt: now + 20 * DAY, api: { baseUrl: '', authType: 'apiKey', keyHint: '1234' } }),
      ]) }),
      'GET /api/usage?account=default': () => ({ body: { at: now, limits: [] } }),
      'GET /api/usage?account=a1': () => ({ body: { at: now, limits: [] } }),
      'GET /api/usage?account=a2': () => ({ body: { at: now, limits: [] } }),
    };
    try {
      mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
      click(document.querySelector('[aria-label="账户菜单"]')!);
      await flush();
      const items = document.querySelectorAll('.cz-sidebar__menu-item');
      // 1. 正常订阅 + 正常登录
      const d0 = items[0].querySelector('.cz-acct-row__dates')!;
      expect(d0.textContent).toBe('订阅约 12/09 到期 · 登录至 12/16');
      expect(d0.querySelector('.cz-acct-row__date')?.getAttribute('title')).toContain('按订阅开始日 2026/11/09 每月推算');
      // 2. 缺订阅时间 + 7 天内登录警告
      const d1 = items[1].querySelector('.cz-acct-row__dates')!;
      expect(d1.textContent).toBe('登录 3 天后失效');
      expect(d1.querySelector('.cz-acct-row__date.is-warn')).not.toBeNull();
      // 3. 无 plan 不显示订阅推算，只显示已失效（danger）
      const d2 = items[2].querySelector('.cz-acct-row__dates')!;
      expect(d2.textContent).toBe('登录已失效');
      expect(d2.querySelector('.cz-acct-row__date.is-danger')).not.toBeNull();
      // 4. API 账号不显示日期行
      expect(items[3].querySelector('.cz-acct-row__dates')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
    expect(entrySubtitle(apiEntry)).toBe('proxy.example.com');
    expect(calls.filter((c) => c.url.startsWith('/api/usage')).map((c) => c.url)).toEqual(['/api/usage?account=default']);
    // 当前账号不能删，但 API 账号（非当前）有修改和移除
    expect(document.querySelector('[aria-label="修改 API 账号与模型映射"]')).not.toBeNull();

    click(document.querySelector<HTMLElement>('[aria-label="添加 Claude 账号"]')!);
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
    click(document.querySelector('[aria-label="修改 API 账号与模型映射"]')!);
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

describe('Antigravity 多账号', () => {
  const agyEntry = (over: Partial<AgyAccountEntry>): AgyAccountEntry => ({
    id: 'default', label: '', plan: 'Google AI Pro', loggedIn: true, active: true, isDefault: true, running: 0, ...over,
  });
  const agyList = (l: AgyAccountEntry[], installed = true, login: AccountLogin | null = null): AgyAccountList => ({
    installed, list: l, login,
  });
  const type = (el: HTMLInputElement, v: string) => act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const press = (el: EventTarget, key: string) => act(() => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
  const groupBtn = (name: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.cz-acct-grp__head')].find((b) => b.textContent?.includes(name));

  it('agyTitle / agySubtitle：没备注名用邮箱当标题，默认账号兜底「本机登录」，任务数缩短为「N 个执行中」', () => {
    expect(agyTitle(agyEntry({}))).toBe('本机登录');
    expect(agySubtitle(agyEntry({}))).toBe('');
    expect(agyTitle(agyEntry({ email: 'a@example.com' }))).toBe('a@example.com');
    expect(agySubtitle(agyEntry({ email: 'a@example.com' }))).toBe('');
    expect(agyTitle(agyEntry({ id: 'n', label: '', email: null, isDefault: false }))).toBe('Antigravity 账号');
    expect(agySubtitle(agyEntry({ id: 'a1', label: '工作', email: 'w@example.com', plan: 'Ultra', running: 2, isDefault: false }))).toBe('2 个执行中 · w@example.com');
    expect(agySubtitle(agyEntry({ id: 'a2', label: '备用', plan: null, loggedIn: false, isDefault: false }))).toBe('需要登录');
    expect(agySubtitle(agyEntry({ id: 'a3', label: '个人', plan: null, loggedIn: null, isDefault: false }))).toBe('检测中…');
  });

  it('分组默认折叠、localStorage 记忆、agy 请求失败不影响 Claude', async () => {
    // 0. 没有记忆时两个分组都折叠（旧键 cz-acct-groups 里的展开状态不再生效）
    localStorage.clear();
    localStorage.setItem('cz-acct-groups', JSON.stringify({ claude: true, agy: true }));
    routes = { 'GET /api/accounts': () => ({ body: list([entry({})]) }), 'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([agyEntry({})]) }) };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(groupBtn('Claude')?.getAttribute('aria-expanded')).toBe('false');
    expect(groupBtn('Antigravity')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('.cz-acct-row').length).toBe(0);
    act(() => root?.unmount());
    localStorage.setItem('cz-acct-groups-v2', JSON.stringify({ claude: true, agy: false }));

    // 1. agy 请求 404 时不显示 Antigravity 组，Claude 照常工作
    routes = { 'GET /api/accounts': () => ({ body: list([entry({})]) }) };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(groupBtn('Claude')?.getAttribute('aria-expanded')).toBe('true');
    expect(groupBtn('Antigravity')).toBeUndefined();
    act(() => root?.unmount());

    // 2. agy 返回数据：默认折叠，不渲染 agy 行；展开后写入 localStorage 并在重挂载后记住
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([agyEntry({}), agyEntry({ id: 'w', label: '工作', active: false, isDefault: false })]) }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(groupBtn('Antigravity')?.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('.cz-acct-row--agy').length).toBe(0);
    click(groupBtn('Antigravity')!);
    await flush();
    expect(groupBtn('Antigravity')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.cz-acct-row--agy').length).toBe(2);
    expect(JSON.parse(localStorage.getItem('cz-acct-groups-v2')!)).toEqual({ claude: true, agy: true });

    // 重新挂载读取 localStorage
    act(() => root?.unmount());
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(groupBtn('Antigravity')?.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelectorAll('.cz-acct-row--agy').length).toBe(2);
  });

  it('agy 行：没备注名显示邮箱、套餐缩成小标签、显示各组 5h / 本周额度；没登录的不显示额度；打开菜单带 refresh', async () => {
    localStorage.setItem('cz-acct-groups-v2', JSON.stringify({ claude: true, agy: true }));
    const quota = {
      at: 1,
      groups: [
        { name: 'Gemini', buckets: [
          { window: '5h', percent: 12, severity: 'normal' as const, resetsAt: null },
          { window: 'weekly', percent: 85, severity: 'warning' as const, resetsAt: null },
        ] },
        { name: 'Claude · GPT', buckets: [{ window: '5h', percent: 100, severity: 'critical' as const, resetsAt: null }] },
      ],
    };
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([
        agyEntry({ email: 'me@example.com', quota }),
        agyEntry({ id: 'w', label: '工作', email: 'w@example.com', quota: null, plan: null, loggedIn: false, active: false, isDefault: false }),
      ]) }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(calls.some((c) => c.url === '/api/agy-accounts?refresh=1')).toBe(true);
    const rows = document.querySelectorAll('.cz-acct-row--agy');
    expect(rows[0].querySelector('.cz-sidebar__menu-name')?.textContent).toBe('me@example.com');
    const chip = rows[0].querySelector('.cz-acct-chip');
    expect(chip?.textContent).toBe('Pro');
    expect(chip?.getAttribute('title')).toBe('Google AI Pro');
    const bars = [...rows[0].querySelectorAll('[role="progressbar"]')];
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual(['Gemini 5 小时已用', 'Gemini 本周已用', 'Claude · GPT 5 小时已用']);
    expect(bars.map((b) => b.getAttribute('aria-valuenow'))).toEqual(['12', '85', '100']);
    expect(rows[0].querySelector('.cz-acctq__grp.is-critical')?.textContent).toContain('Claude · GPT');
    expect(rows[0].querySelector('.cz-acctq__win.is-warning')?.textContent).toContain('85%');
    // 有备注名时邮箱进副标题；没登录不显示额度
    expect(rows[1].querySelector('.cz-sidebar__menu-name')?.textContent).toBe('工作');
    expect(rows[1].querySelector('.cz-sidebar__menu-path')?.textContent).toBe('w@example.com · 需要登录');
    expect(rows[1].querySelector('.cz-acctq')).toBeNull();
  });

  it('未安装 Antigravity CLI：显示组与说明、不显示＋按钮，「添加到」里禁用 Antigravity', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([], false) }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(document.querySelector('[aria-label="添加 Antigravity 账号"]')).toBeNull();
    click(groupBtn('Antigravity')!);
    await flush();
    expect(document.body.textContent).toContain('没有安装 Antigravity CLI');

    click(document.querySelector<HTMLElement>('[aria-label="添加 Claude 账号"]')!);
    await flush();
    const agyRadio = [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="添加到"] [role="radio"]')]
      .find((b) => b.textContent === 'Antigravity')!;
    expect(agyRadio.disabled).toBe(true);
  });

  it('切换 agy 账号不刷新页面、不关菜单；loggedIn=null 非当前行也允许切换；默认/当前/running>0 不可移除', async () => {
    let agys = [
      agyEntry({}),
      agyEntry({ id: 'w', label: '工作', plan: 'Ultra', active: false, isDefault: false, running: 2 }),
      agyEntry({ id: 'p', label: '个人', plan: null, loggedIn: null, active: false, isDefault: false, running: 0 }),
    ];
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList(agys) }),
      'POST /api/agy-accounts/switch': (b) => {
        const id = (b as { id: string }).id;
        agys = agys.map((x) => ({ ...x, active: x.id === id }));
        return { body: { ok: true } };
      },
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    click(groupBtn('Antigravity')!);
    await flush();
    // 每行都有移除按钮：默认账号不能改名，移除置灰；非默认运行中可改名、移除置灰；id='p' 可改名可移除
    const agyRows = [...document.querySelectorAll<HTMLElement>('.cz-acct-row--agy')];
    const rmBtn = (r: HTMLElement) => r.querySelector<HTMLButtonElement>('[aria-label="移除账号"]')!;
    expect(agyRows[0].style.getPropertyValue('--acts')).toBe('1');
    expect(agyRows[0].querySelector('[aria-label="修改备注名"]')).toBeNull();
    expect(rmBtn(agyRows[0]).disabled).toBe(true);
    expect(rmBtn(agyRows[0]).title).toBe('默认账号不能移除');
    expect(agyRows[1].classList.contains('has-actions')).toBe(true);
    expect(agyRows[1].querySelector('[aria-label="修改备注名"]')).not.toBeNull();
    expect(rmBtn(agyRows[1]).disabled).toBe(true);
    expect(rmBtn(agyRows[1]).title).toBe('有 2 个委派任务正在执行，结束后才能移除');
    expect(agyRows[1].querySelector('.cz-sidebar__menu-path')?.getAttribute('title')).toBe('2 个执行中');
    expect(rmBtn(agyRows[2]).disabled).toBe(false);

    // 点击 loggedIn=null 的非当前行「个人」
    click(agyRows[2].querySelector('.cz-acct-row__main')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/agy-accounts/switch')?.body).toEqual({ id: 'p' });
    expect(reload).not.toHaveBeenCalled();
    expect(document.querySelector('.cz-sidebar__menu')).not.toBeNull();
    expect(document.querySelectorAll('.cz-acct-row--agy')[2].classList.contains('is-active')).toBe(true);
  });

  it('＋按钮预选对应组且不触发折叠；行内改名 Esc 不关菜单、Enter 保存', async () => {
    let agys = [agyEntry({}), agyEntry({ id: 'w', label: '工作', active: false, isDefault: false })];
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList(agys) }),
      'POST /api/agy-accounts/label': (b) => {
        const { id, label } = b as { id: string; label: string };
        agys = agys.map((x) => (x.id === id ? { ...x, label } : x));
        return { body: { ok: true } };
      },
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    // Antigravity 组此时折叠：点＋直接预选 Antigravity，且不展开该组
    click(document.querySelector('[aria-label="添加 Antigravity 账号"]')!);
    await flush();
    expect(groupBtn('Antigravity')?.getAttribute('aria-expanded')).toBe('false');
    const agyRadio = [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="添加到"] [role="radio"]')]
      .find((b) => b.textContent === 'Antigravity')!;
    expect(agyRadio.getAttribute('aria-checked')).toBe('true');
    click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '取消')!);
    await flush();

    // 展开后测试行内改名：Esc 取消但不关菜单，再进入改名 Enter 保存
    click(groupBtn('Antigravity')!);
    await flush();
    const editBtn = document.querySelectorAll('.cz-acct-row--agy')[1].querySelector('[aria-label="修改备注名"]')!;
    click(editBtn);
    await flush();
    const inp = document.querySelector<HTMLInputElement>('.cz-acct-row__edit-input')!;
    expect(inp.value).toBe('工作');
    press(document, 'Escape');
    await flush();
    expect(document.querySelector('.cz-acct-row__edit-input')).toBeNull();
    expect(document.querySelector('.cz-sidebar__menu')).not.toBeNull();

    click(document.querySelectorAll('.cz-acct-row--agy')[1].querySelector('[aria-label="修改备注名"]')!);
    await flush();
    const inp2 = document.querySelector<HTMLInputElement>('.cz-acct-row__edit-input')!;
    type(inp2, '团队');
    press(inp2, 'Enter');
    await flush();
    expect(calls.find((c) => c.url === '/api/agy-accounts/label')?.body).toEqual({ id: 'w', label: '团队' });
    expect(document.querySelectorAll('.cz-acct-row--agy')[1].textContent).toContain('团队');
  });

  it('添加到选择、授权码失败后重新获取登录链接重试、以及取消登录', async () => {
    vi.useFakeTimers();
    let seq = 0;
    let pollState: AccountLogin = { loginId: 'L0', status: 'waiting', url: 'https://accounts.google.com/mock', accountId: null, error: null };
    let submitCount = 0;
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([agyEntry({})]) }),
      'POST /api/agy-accounts/login': () => {
        seq += 1;
        pollState = { loginId: `L${seq}`, status: 'waiting', url: `https://accounts.google.com/mock?s=${seq}`, accountId: null, error: null };
        return { body: pollState };
      },
      'GET /api/agy-accounts/login/L1': () => ({ body: pollState }),
      'GET /api/agy-accounts/login/L2': () => ({ body: pollState }),
      'GET /api/agy-accounts/login/L3': () => ({ body: pollState }),
      'POST /api/agy-accounts/login/L1/code': () => {
        submitCount += 1;
        pollState = { ...pollState, status: 'failed', error: '授权码无效或已过期，请重新登录' };
        return { body: { ok: true } };
      },
      'POST /api/agy-accounts/login/L2/code': () => {
        submitCount += 1;
        pollState = { ...pollState, status: 'done', accountId: 'agy-new', error: null };
        return { body: { ok: true } };
      },
      'POST /api/agy-accounts/login/L3/cancel': () => ({ body: { ok: true } }),
      'POST /api/agy-accounts/switch': () => ({ body: { ok: true } }),
    };

    try {
      mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
      click(document.querySelector('[aria-label="账户菜单"]')!);
      await flush();
      click(document.querySelector<HTMLElement>('[aria-label="添加 Claude 账号"]')!);
      await flush();
      // 默认选中 Claude，切到 Antigravity
      const agyRadio = [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="添加到"] [role="radio"]')]
        .find((b) => b.textContent === 'Antigravity')!;
      click(agyRadio);
      await flush();

      const labelInput = document.querySelector<HTMLInputElement>('[role="dialog"] .cz-acct-dlg__input')!;
      type(labelInput, '副号');
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '登录')!);
      await flush();
      expect(calls.find((c) => c.url === '/api/agy-accounts/login')?.body).toEqual({ label: '副号' });
      expect(document.querySelector('[role="dialog"] a')?.getAttribute('href')).toBe('https://accounts.google.com/mock?s=1');

      // 第一次提交授权码 → failed
      type(document.querySelector<HTMLInputElement>('[role="dialog"] .cz-acct-dlg__input')!, 'bad-code');
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '提交')!);
      await flush();
      await act(async () => { vi.advanceTimersByTime(400); });
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('授权码无效或已过期');
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('旧的登录链接已失效');

      // 点「重新获取登录链接」：保留之前填的备注名「副号」
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '重新获取登录链接')!);
      await flush();
      const loginCalls = calls.filter((c) => c.url === '/api/agy-accounts/login');
      expect(loginCalls.map((c) => c.body)).toEqual([{ label: '副号' }, { label: '副号' }]);

      // 第二次提交授权码 → done → 点「用于新的委派任务」
      type(document.querySelector<HTMLInputElement>('[role="dialog"] .cz-acct-dlg__input')!, 'good-code');
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '提交')!);
      await flush();
      await act(async () => { vi.advanceTimersByTime(400); });
      await flush();
      expect(submitCount).toBe(2);
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('登录成功');
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '用于新的委派任务')!);
      await flush();
      expect(calls.find((c) => c.url === '/api/agy-accounts/switch')?.body).toEqual({ id: 'agy-new' });

      // 取消登录流程
      click(document.querySelector('[aria-label="添加 Antigravity 账号"]')!);
      await flush();
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '登录')!);
      await flush();
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '取消')!);
      await flush();
      expect(calls.some((c) => c.url === '/api/agy-accounts/login/L3/cancel')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('轮询瞬时错误后继续重试并恢复，不清掉提交授权码错误；只有 404 才停止并转失败态', async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([agyEntry({})]) }),
      'POST /api/agy-accounts/login': () => ({
        body: { loginId: 'L1', status: 'waiting', url: 'https://accounts.google.com/mock', accountId: null, error: null },
      }),
      'POST /api/agy-accounts/login/L1/code': () => ({ status: 400, body: { error: '授权码格式不对' } }),
      'GET /api/agy-accounts/login/L1': () => {
        pollCount += 1;
        if (pollCount === 1) return { status: 502, body: { error: '临时网络波动' } };
        if (pollCount === 2) return { body: { loginId: 'L1', status: 'waiting', url: 'https://accounts.google.com/mock', accountId: null, error: null } };
        return { status: 404, body: { error: '登录已结束' } };
      },
    };
    try {
      mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
      click(document.querySelector('[aria-label="账户菜单"]')!);
      await flush();
      click(document.querySelector('[aria-label="添加 Antigravity 账号"]')!);
      await flush();
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '登录')!);
      await flush();

      // 提交授权码报错，保留该错误
      type(document.querySelector<HTMLInputElement>('[role="dialog"] .cz-acct-dlg__input')!, 'bad');
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '提交')!);
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('授权码格式不对');

      // 第 1 次轮询 502：显示轮询错误，但继续轮询
      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(pollCount).toBe(1);
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('临时网络波动');
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('授权码格式不对');

      // 第 2 次轮询恢复 waiting：清掉轮询错误，但提交授权码错误仍在
      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(pollCount).toBe(2);
      expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('临时网络波动');
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('授权码格式不对');

      // 第 3 次轮询 404：停止轮询并进入失败态，提供「重新获取登录链接」
      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(pollCount).toBe(3);
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('登录已结束');
      expect([...document.querySelectorAll('[role="dialog"] button')].some((b) => b.textContent === '重新获取登录链接')).toBe(true);

      // 确认不再继续轮询
      await act(async () => { vi.advanceTimersByTime(3000); });
      await flush();
      expect(pollCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('接续重新登录（resume.accountId 非空）保留重新登录标题与 accountId；点未登录账号遇 409 显示错误且可关闭', async () => {
    vi.useFakeTimers();
    const ongoing: AccountLogin = {
      loginId: 'L-re', status: 'waiting', url: 'https://accounts.google.com/re', accountId: 'a2', error: null,
    };
    let loginState: AccountLogin = ongoing;
    const agys = [
      agyEntry({}),
      agyEntry({ id: 'a2', label: '备用账号', plan: null, loggedIn: false, active: false, isDefault: false }),
      agyEntry({ id: 'a3', label: '三号', plan: null, loggedIn: false, active: false, isDefault: false }),
    ];
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList(agys, true, loginState) }),
      'GET /api/agy-accounts/login/L-re': () => ({ body: { ...ongoing, status: 'failed', error: '授权已过期' } }),
      'POST /api/agy-accounts/login': (b) => {
        const body = b as { accountId?: string };
        if (body.accountId === 'a3') return { status: 409, body: { error: '已有另一个登录正在进行' } };
        return { body: { loginId: 'L-re2', status: 'waiting', url: 'https://accounts.google.com/re2', accountId: body.accountId ?? null, error: null } };
      },
    };
    try {
      mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
      click(document.querySelector('[aria-label="账户菜单"]')!);
      await flush();

      // 1. 通过 Antigravity 分组标题的「＋」接续 a2 的重新登录
      click(document.querySelector('[aria-label="添加 Antigravity 账号"]')!);
      await flush();
      expect(document.querySelector('[role="dialog"] .cz-acct-dlg__title')?.textContent).toBe('重新登录：备用账号');

      // 轮询变为 failed，点「重新获取登录链接」应带 accountId: 'a2'
      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '重新获取登录链接')!);
      await flush();
      expect(calls.filter((c) => c.url === '/api/agy-accounts/login').at(-1)?.body).toEqual({ accountId: 'a2' });
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '取消')!);
      await flush();

      // 2. 通过 Antigravity 组「＋」接续同样显示「重新登录：备用账号」
      click(document.querySelector('[aria-label="添加 Antigravity 账号"]')!);
      await flush();
      expect(document.querySelector('[role="dialog"] .cz-acct-dlg__title')?.textContent).toBe('重新登录：备用账号');
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '取消')!);
      await flush();

      // 3. 展开 Antigravity 组点未登录的「三号」→ 409 冲突错误可展示且能关闭（不误杀别的登录）
      click(groupBtn('Antigravity')!);
      await flush();
      const row3 = [...document.querySelectorAll('.cz-acct-row--agy')].find((r) => r.textContent?.includes('三号'))!;
      click(row3.querySelector('.cz-acct-row__main')!);
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('已有另一个登录正在进行');
      const cancelBefore = calls.filter((c) => c.url.endsWith('/cancel')).length;
      click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '取消')!);
      await flush();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(calls.filter((c) => c.url.endsWith('/cancel')).length).toBe(cancelBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});
