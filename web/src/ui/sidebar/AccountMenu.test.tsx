// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountEntry, AccountList, AccountLogin, AccountMode, AgyAccountEntry, AgyAccountList, KiroStatus, SessionSummary } from '@cosyee/shared';
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

const openMenu = async () => {
  mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
  click(document.querySelector('[aria-label="账户菜单"]')!);
  await flush();
};
/** 账号弹层 */
const menu = () => document.querySelector<HTMLElement>('.cz-acct-menu');
const picks = () => [...document.querySelectorAll<HTMLButtonElement>('button.cz-acct-pick')];
const pickOf = (name: string) => picks().find((b) => b.querySelector('.cz-acct-pick__name b')?.textContent === name);
const agyRows = () => [...(menu()?.querySelectorAll<HTMLElement>('.cz-acct-pick--readonly') ?? [])];
const agyRowOf = (name: string) => agyRows().find((r) => r.querySelector('.cz-acct-pick__name b')?.textContent === name);
/** 管理账号面板 */
const manager = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="管理账号"]');
const openManager = async () => {
  await openMenu();
  click(button('管理账号')!);
  await flush();
};
const section = (title: string) => manager()?.querySelector<HTMLElement>(`section[aria-label="${title}"]`) ?? null;
const cards = (title: string) => [...(section(title)?.querySelectorAll<HTMLElement>('.cz-acct-card') ?? [])];
const cardOf = (title: string, name: string) =>
  cards(title).find((c) => c.querySelector('.cz-acct-card__name b')?.textContent === name);
const btnIn = (el: Element | null | undefined, text: string) =>
  [...(el?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === text);
/** 最上层的添加 / 登录对话框（不算管理面板和移除确认气泡） */
const dlg = () =>
  [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .filter((d) => d.getAttribute('aria-label') !== '管理账号' && !d.classList.contains('cz-sidebar__confirm'))
    .at(-1) ?? null;
const dlgBtn = (text: string) =>
  // 取最后一个：模型映射表里也有个「添加」（加自定义模型），底部提交按钮在它后面
  [...(dlg()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].reverse().find((b) => b.textContent === text)!;
const dblclick = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); });
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const press = (el: EventTarget, key: string) => act(() => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
});
const apiEntry = entry({
  id: 'a2', label: '代理', name: '代理', plan: 'API', active: false, isDefault: false,
  api: { baseUrl: 'https://proxy.example.com/v1', authType: 'authToken', keyHint: '3456' },
});
/** 各类账号都有：当前 / 可切换 / 没登录 / 登录已失效 / API / Kiro */
const mixedList = () => list([
  entry({}),
  entry({ id: 'a1', label: '工作', name: 'Bob', active: false, isDefault: false }),
  entry({ id: 'a3', label: '没登录', name: null, plan: null, loggedIn: false, active: false, isDefault: false }),
  entry({ id: 'a4', name: 'Expired', active: false, isDefault: false, loginExpiresAt: Date.now() - 1000 }),
  apiEntry,
  entry({ id: 'k1', name: 'Kiro 主号', plan: 'Kiro', active: false, isDefault: false, kiro: { method: 'builderId', proxy: 'ready', error: null, credential: 'ok' } }),
]);


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


describe('AccountMenu 弹层', () => {
  it('只列出可用的账号，按类型分组，当前账号打勾；没有说明文字和添加 / 移除入口，底部是「管理账号」', async () => {
    routes = { 'GET /api/accounts': () => ({ body: mixedList() }) };
    await openMenu();
    const groups = [...menu()!.querySelectorAll('.cz-acct-pick-sec')].map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Claude 订阅', 'API', 'Kiro']);
    const rows = picks();
    expect(rows.map((r) => r.querySelector('.cz-acct-pick__name b')?.textContent)).toEqual(['cosyeey', 'Bob', '代理', 'Kiro 主号']);
    expect(rows[0].classList.contains('is-active')).toBe(true);
    expect(rows[0].getAttribute('aria-current')).toBe('true');
    expect(rows[0].querySelector('.cz-sidebar__acct-check')).not.toBeNull();
    expect(rows[1].querySelector('.cz-sidebar__acct-check')).toBeNull();
    // Kiro 账号不再重复显示「Kiro」套餐标签；API 账号没有额度，只占一行
    expect(rows[3].querySelector('.cz-acct-chip')).toBeNull();
    expect(rows[2].querySelector('.cz-acctq-brief')).toBeNull();
    // 账号行没有头像，图标在组名前
    expect(menu()!.querySelector('.cz-sidebar__avatar')).toBeNull();
    expect([...menu()!.querySelectorAll('.cz-acct-pick-grp [data-brand]')].map((e) => e.getAttribute('data-brand'))).toEqual(['claude', 'api', 'kiro']);
    const text = menu()!.textContent!;
    expect(text).not.toContain('需要登录');
    expect(text).not.toContain('工作'); // 备注名等副标题不进弹层
    expect(text).not.toContain('默认账号');
    expect(menu()!.querySelector('[aria-label^="添加"]')).toBeNull();
    expect(menu()!.querySelector('[aria-label^="移除"]')).toBeNull();
    expect(menu()!.querySelector('.cz-acct-dup')).toBeNull();
    expect(button('管理账号')).toBeDefined();
  });

  it('读取额度：弹层每个账号只显示最先重置的那个窗口「5h ━━ 32% 2小时14分后」；失败或没登录不显示', async () => {
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
    const row0 = pickOf('cosyeey')!;
    const brief = row0.querySelector('.cz-acctq-brief')!;
    expect(brief.textContent).toBe('5h32%2小时14分后');
    expect(brief.classList.contains('is-normal')).toBe(true);
    expect(brief.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toBe('5h 32% · 2小时14分后重置');
    const bars = row0.querySelectorAll('[role="progressbar"]');
    expect(bars.length).toBe(1);
    expect(bars[0].getAttribute('aria-valuenow')).toBe('32');
    // 读取失败不显示额度，也不影响切换
    expect(pickOf('Bob')!.querySelector('.cz-acctq-brief')).toBeNull();
    expect(pickOf('Bob')!.disabled).toBe(false);
    // 没登录的账号不取额度，也不在弹层里
    expect(calls.filter((c) => c.url.startsWith('/api/usage')).map((c) => c.url).sort()).toEqual(['/api/usage?account=a1', '/api/usage?account=default']);
    expect(picks().length).toBe(2);
  });

  it('弹层开着时额度提示每分钟刷新一次，关闭后清理计时器', async () => {
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
      await openMenu();
      expect(document.querySelector('.cz-acctq-brief [role="progressbar"]')?.getAttribute('aria-valuetext')).toContain('10分钟后重置');

      await act(async () => { vi.advanceTimersByTime(60_000); });
      expect(document.querySelector('.cz-acctq-brief [role="progressbar"]')?.getAttribute('aria-valuetext')).toContain('9分钟后重置');

      const beforeClose = clearSpy.mock.calls.length;
      click(document.querySelector('[aria-label="账户菜单"]')!);
      await flush();
      expect(clearSpy.mock.calls.length).toBeGreaterThan(beforeClose);
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
    await openMenu();
    click(pickOf('Bob')!);
    await flush();
    expect(menu()!.textContent).toContain('有 2 个会话正在执行，切换到「Bob」会停止它们。');
    expect(reload).not.toHaveBeenCalled();
    click(button('强制切换')!);
    await flush();
    const sw = calls.filter((c) => c.url === '/api/accounts/switch');
    expect(sw.map((c) => c.body)).toEqual([{ id: 'a1', force: false }, { id: 'a1', force: true }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('点当前账号只关闭弹层，不发切换请求', async () => {
    routes = { 'GET /api/accounts': () => ({ body: list([entry({})]) }) };
    await openMenu();
    click(pickOf('cosyeey')!);
    await flush();
    expect(menu()).toBeNull();
    expect(calls.some((c) => c.url === '/api/accounts/switch')).toBe(false);
  });
});

describe('管理账号面板', () => {
  it('从弹层底部打开：按组列出全部账号（包括没登录 / 已失效），卡片带状态标记与对应操作；Esc 关闭', async () => {
    routes = { 'GET /api/accounts': () => ({ body: mixedList() }) };
    await openManager();
    expect(manager()).not.toBeNull();
    expect(menu()).toBeNull();
    // agy 请求失败：不显示 Antigravity 组，其它组照常
    expect([...manager()!.querySelectorAll('section')].map((s) => s.getAttribute('aria-label'))).toEqual(['Claude 订阅', 'API', 'Kiro']);
    expect(cards('Claude 订阅').length).toBe(4);
    expect(section('Claude 订阅')!.querySelector('.cz-acct-mgr__count')?.textContent).toBe('4');
    // 每组有自己的添加按钮
    expect(btnIn(section('Claude 订阅'), '用 claude.ai 登录')).toBeDefined();
    expect(btnIn(section('API'), '添加 API Key')).toBeDefined();
    expect(btnIn(section('Kiro'), '登录 Kiro')).toBeDefined();

    const cur = cardOf('Claude 订阅', 'cosyeey')!;
    expect(cur.classList.contains('is-active')).toBe(true);
    expect(cur.querySelector('.cz-acct-card__badge')?.textContent).toBe('当前');
    expect(btnIn(cur, '切换')).toBeUndefined();
    expect(btnIn(cur, '改名')).toBeUndefined(); // 默认账号不能改名
    const rm = cur.querySelector<HTMLButtonElement>('[aria-label="移除账号「cosyeey」"]')!;
    expect(rm.disabled).toBe(true);
    expect(rm.title).toBe('默认账号不能移除');

    const bob = cardOf('Claude 订阅', 'Bob')!;
    expect(bob.querySelector('.cz-acct-card__sub')?.textContent).toBe('工作');
    expect(btnIn(bob, '切换')).toBeDefined();
    expect(btnIn(bob, '改名')).toBeDefined();
    expect(bob.querySelector<HTMLButtonElement>('[aria-label="移除账号「Bob」"]')!.disabled).toBe(false);

    const off = cardOf('Claude 订阅', '没登录')!;
    expect(off.classList.contains('is-off')).toBe(true);
    expect(off.querySelector('.cz-acct-card__badge.is-danger')?.textContent).toBe('需要登录');
    expect(btnIn(off, '重新登录')).toBeDefined();
    expect(btnIn(off, '切换')).toBeUndefined();
    const exp = cardOf('Claude 订阅', 'Expired')!;
    expect(exp.querySelector('.cz-acct-card__badge')?.textContent).toBe('登录已失效');
    expect(btnIn(exp, '重新登录')).toBeDefined();

    press(document, 'Escape');
    await flush();
    expect(manager()).toBeNull();
  });

  it('卡片显示全部额度，一条一行带重置时间；读取失败显示淡提示', async () => {
    const soon = Date.now() + (2 * 60 + 14) * 60_000;
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', name: 'Bob', active: false, isDefault: false })]) }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [
        { kind: 'session', percent: 32, severity: 'normal', resetsAt: soon },
        { kind: 'weekly', percent: 91, severity: 'warning', resetsAt: null },
      ] } }),
      'GET /api/usage?account=a1': () => ({ status: 500, body: { error: 'x' } }),
    };
    await openManager();
    const lines = [...cardOf('Claude 订阅', 'cosyeey')!.querySelectorAll('.cz-acctq__line')];
    expect(lines.map((l) => l.querySelector('.cz-acctq__name')?.textContent)).toEqual(['5h', '本周']);
    expect(lines[0].textContent).toContain('32%');
    expect(lines[0].querySelector('.cz-acctq__reset')?.textContent).toContain('2小时14分后重置');
    expect(lines[1].classList.contains('is-warning')).toBe(true);
    expect(lines[1].textContent).toContain('91%');
    expect(cardOf('Claude 订阅', 'Bob')!.textContent).toContain('额度读取失败');
    // 打开面板不会重复读额度
    expect(calls.filter((c) => c.url === '/api/usage?account=default').length).toBe(1);
  });

  it('账号到期时间：显示推算订阅到期与登录有效期（正常 / 7天内警告）；已失效改成标记；API 只显示计费说明', async () => {
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
    };
    try {
      await openManager();
      const meta = (sec: string, name: string) =>
        [...(cardOf(sec, name)?.querySelectorAll('.cz-acct-card__meta > span') ?? [])].map((s) => s.textContent);
      expect(meta('Claude 订阅', 'cosyeey')).toEqual(['订阅约 12/09 到期', '登录至 12/16']);
      expect(cardOf('Claude 订阅', 'cosyeey')!.querySelector('.cz-acct-card__meta > span')?.getAttribute('title')).toContain('按订阅开始日 2026/11/09 每月推算');
      expect(meta('Claude 订阅', 'WarnUser')).toEqual(['登录 3 天后失效']);
      expect(cardOf('Claude 订阅', 'WarnUser')!.querySelector('.cz-acct-card__meta .is-warn')).not.toBeNull();
      const exp = cardOf('Claude 订阅', 'ExpUser')!;
      expect(exp.querySelector('.cz-acct-card__meta')).toBeNull();
      expect(exp.querySelector('.cz-acct-card__badge')?.textContent).toBe('登录已失效');
      expect(meta('API', 'ApiAcc')).toEqual(['按量计费 · 未配置模型映射']);
      // 已失效的账号不取额度，也不在弹层里
      expect(calls.some((c) => c.url === '/api/usage?account=a2')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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
    await openManager();
    const note = () => section('Claude 订阅')!.querySelector('.cz-acct-dup');
    expect(note()?.textContent).toContain('有 2 个重复的账号已隐藏');
    click(btnIn(note(), '清理')!);
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/accounts/dedupe')).toBe(true);
    expect(note()!.textContent).toContain('有 1 个重复的账号已隐藏');
    expect(note()!.textContent).toContain('已清理 1 个；1 个正在使用');
    // 剩下的 1 个就是刚才跳过的那个：不再给「清理」按钮
    expect(btnIn(note(), '清理')).toBeUndefined();
  });

  it('没有重复账号时不显示清理提示', async () => {
    routes = { 'GET /api/accounts': () => ({ body: list([entry({})]) }) };
    await openManager();
    expect(document.querySelector('.cz-acct-dup')).toBeNull();
  });

  it('卡片上切换遇到执行中的会话：提示放在面板里，强制切换后刷新页面', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', name: 'Bob', active: false, isDefault: false })]) }),
      'POST /api/accounts/switch': (b) => ((b as { force?: boolean }).force
        ? { body: { ok: true } }
        : { status: 409, body: { error: '有会话正在执行', running: 1 } }),
    };
    await openManager();
    click(btnIn(cardOf('Claude 订阅', 'Bob'), '切换')!);
    await flush();
    expect(manager()!.querySelector('.cz-sidebar__acct-confirm')?.textContent).toContain('有 1 个会话正在执行');
    click(btnIn(manager(), '强制切换')!);
    await flush();
    expect(calls.filter((c) => c.url === '/api/accounts/switch').map((c) => c.body)).toEqual([{ id: 'a1', force: false }, { id: 'a1', force: true }]);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('没登录的账号点「重新登录」：带 accountId 发起登录，对话框叠在面板上', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', label: '工作', name: null, loggedIn: false, active: false, isDefault: false })]) }),
      'POST /api/accounts/login': () => ({ body: { loginId: 'L1', status: 'waiting', url: 'https://claude.ai/oauth/authorize?x=1', accountId: null, error: null } }),
    };
    await openManager();
    click(btnIn(cardOf('Claude 订阅', '工作'), '重新登录')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/login')?.body).toEqual({ accountId: 'a1' });
    expect(calls.some((c) => c.url === '/api/accounts/switch')).toBe(false);
    expect(dlg()!.textContent).toContain('重新登录：工作');
    expect(dlg()!.querySelector('a')?.getAttribute('href')).toBe('https://claude.ai/oauth/authorize?x=1');
    // 面板还在下面
    expect(manager()).not.toBeNull();
  });

  it('API 组：卡片副标题是主机名、不取额度；「添加 API Key」直接打开 API 表单并提交 Base URL / 密钥', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), apiEntry]) }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [] } }),
      'POST /api/accounts/api': () => ({ body: { ok: true, id: 'a3' } }),
    };
    await openManager();
    expect(entrySubtitle(apiEntry)).toBe('proxy.example.com');
    const card = cardOf('API', '代理')!;
    expect(card.querySelector('.cz-acct-card__sub')?.textContent).toBe('proxy.example.com');
    expect(btnIn(card, '编辑')).toBeDefined();
    expect(btnIn(card, '改名')).toBeUndefined(); // API 账号在编辑里改名
    expect(calls.filter((c) => c.url.startsWith('/api/usage')).map((c) => c.url)).toEqual(['/api/usage?account=default']);

    click(btnIn(section('API'), '添加 API Key')!);
    await flush();
    const d = dlg()!;
    // 入口已经定了类型：没有「添加方式」切换
    expect(d.querySelector('[role="radiogroup"][aria-label="添加方式"]')).toBeNull();
    // 主字段：备注名 / Base URL / API Key（模型映射表里的输入框都带 cz-mmap__input，排除掉）
    const inputs = d.querySelectorAll<HTMLInputElement>('.cz-acct-dlg__input:not(.cz-mmap__input)');
    expect(inputs.length).toBe(3);
    expect(dlgBtn('添加').disabled).toBe(true); // 没填密钥
    type(inputs[1], 'https://gw.example.com/');
    type(inputs[2], 'sk-test-123456789');
    click([...d.querySelectorAll('[role="radio"]')].find((b) => b.textContent === 'Bearer')!);
    click(dlgBtn('添加'));
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/api')?.body).toEqual({
      label: '', baseUrl: 'https://gw.example.com/', apiKey: 'sk-test-123456789', authType: 'authToken', models: null,
    });
    expect(dlg()!.textContent).toContain('已添加');
    expect(dlgBtn('切换到该账号')).toBeDefined();
  });

  it('修改 API 账号：预填 Base URL，密钥留空不提交；保存后回到面板', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), apiEntry]) }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [] } }),
      'POST /api/accounts/api': () => ({ body: { ok: true, id: 'a2' } }),
    };
    await openManager();
    click(btnIn(cardOf('API', '代理'), '编辑')!);
    await flush();
    const d = dlg()!;
    expect(d.textContent).toContain('修改 API 账号：代理');
    expect(d.querySelector('[role="radiogroup"][aria-label="添加方式"]')).toBeNull();
    const inputs = d.querySelectorAll<HTMLInputElement>('.cz-acct-dlg__input:not(.cz-mmap__input)');
    expect(inputs[1].value).toBe('https://proxy.example.com/v1');
    expect(inputs[2].placeholder).toContain('…3456');
    click(dlgBtn('保存'));
    await flush();
    // 该账号没配映射，映射表也没动过 → models: null（显式清空，服务端规范化后仍是「没有映射」）
    expect(calls.find((c) => c.url === '/api/accounts/api')?.body).toEqual({
      id: 'a2', label: '代理', baseUrl: 'https://proxy.example.com/v1', authType: 'authToken', models: null,
    });
    expect(dlg()).toBeNull();
    expect(manager()).not.toBeNull();
  });

  it('改名：Esc 只取消改名不关面板，Enter 保存；移除走确认（双击直接移除）', async () => {
    let accts = [entry({}), entry({ id: 'a1', label: '工作', name: 'Bob', active: false, isDefault: false })];
    routes = {
      'GET /api/accounts': () => ({ body: list(accts) }),
      'POST /api/accounts/label': (b) => {
        const { id, label } = b as { id: string; label: string };
        accts = accts.map((x) => (x.id === id ? { ...x, label } : x));
        return { body: { ok: true } };
      },
      'POST /api/accounts/remove': (b) => {
        accts = accts.filter((x) => x.id !== (b as { id: string }).id);
        return { body: { ok: true } };
      },
    };
    await openManager();
    click(btnIn(cardOf('Claude 订阅', 'Bob'), '改名')!);
    await flush();
    const inp = manager()!.querySelector<HTMLInputElement>('[aria-label="修改备注名"]')!;
    expect(inp.value).toBe('工作');
    press(inp, 'Escape');
    await flush();
    expect(manager()!.querySelector('[aria-label="修改备注名"]')).toBeNull();
    expect(manager()).not.toBeNull();

    click(btnIn(cardOf('Claude 订阅', 'Bob'), '改名')!);
    await flush();
    const inp2 = manager()!.querySelector<HTMLInputElement>('[aria-label="修改备注名"]')!;
    type(inp2, '团队');
    press(inp2, 'Enter');
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/label')?.body).toEqual({ id: 'a1', label: '团队' });
    expect(cardOf('Claude 订阅', 'Bob')!.querySelector('.cz-acct-card__sub')?.textContent).toBe('团队');

    dblclick(cardOf('Claude 订阅', 'Bob')!.querySelector('[aria-label="移除账号「Bob」"]')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/remove')?.body).toEqual({ id: 'a1' });
    expect(cardOf('Claude 订阅', 'Bob')).toBeUndefined();
  });
});

describe('并行模式', () => {
  it('弹层里选另一个账号：只换新会话用的账号，不刷新页面，关闭弹层', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', name: 'Bob', active: false, isDefault: false })], 'parallel') }),
      'POST /api/accounts/switch': () => ({ body: { ok: true } }),
    };
    await openMenu();
    expect(menu()!.textContent).not.toContain('选择新会话使用的账号');
    click(pickOf('Bob')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/switch')?.body).toEqual({ id: 'a1', force: false });
    expect(reload).not.toHaveBeenCalled();
    expect(menu()).toBeNull();
  });

  it('管理面板里切换：不刷新页面，面板保持打开', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({}), entry({ id: 'a1', name: 'Bob', active: false, isDefault: false })], 'parallel') }),
      'POST /api/accounts/switch': () => ({ body: { ok: true } }),
    };
    await openManager();
    click(btnIn(cardOf('Claude 订阅', 'Bob'), '切换')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/switch')?.body).toEqual({ id: 'a1', force: false });
    expect(reload).not.toHaveBeenCalled();
    expect(manager()).not.toBeNull();
  });

  const seg = (label: string) =>
    [...document.querySelectorAll('[role="radio"]')].find((b) => b.textContent === label) as HTMLButtonElement;

  it('模式切换在弹层顶部、第一个账号上方，说明放在悬停提示里；默认切换模式，选并行模式不刷新页面', async () => {
    let mode: AccountMode = 'switch';
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})], mode) }),
      'POST /api/accounts/mode': (b) => { mode = (b as { mode: AccountMode }).mode; return { body: { ok: true } }; },
    };
    await openMenu();
    expect(document.querySelector('[role="switch"]')).toBeNull();
    const group = menu()!.querySelector('[role="radiogroup"]')!;
    expect(group.compareDocumentPosition(menu()!.querySelector('.cz-acct-pick')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(seg('切换模式').getAttribute('aria-checked')).toBe('true');
    expect(seg('并行模式').getAttribute('aria-checked')).toBe('false');
    expect(seg('并行模式').title).not.toBe('');
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
  // 不传 id 时是「主号」：没备注名、标题显示邮箱 main@example.com；传了 id 的默认不带邮箱
  const agyEntry = (over: Partial<AgyAccountEntry>): AgyAccountEntry => ({
    id: 'g1', label: '', plan: 'Google AI Pro', loggedIn: true, active: true, isDefault: false, running: 0, ...over,
    email: over.email !== undefined ? over.email : over.id ? null : 'main@example.com',
  });
  const agyList = (l: AgyAccountEntry[], installed = true, login: AccountLogin | null = null): AgyAccountList => ({
    installed, list: l, login,
  });
  const dlgInput = () => dlg()!.querySelector<HTMLInputElement>('.cz-acct-dlg__input')!;

  it('agyTitle / agySubtitle：没备注名用邮箱当标题，都没有时兜底「Antigravity 账号」，任务数缩短为「N 个执行中」', () => {
    expect(agyTitle(agyEntry({}))).toBe('main@example.com');
    expect(agySubtitle(agyEntry({}))).toBe('');
    expect(agyTitle(agyEntry({ email: 'a@example.com' }))).toBe('a@example.com');
    expect(agySubtitle(agyEntry({ email: 'a@example.com' }))).toBe('');
    expect(agyTitle(agyEntry({ id: 'n', label: '', email: null }))).toBe('Antigravity 账号');
    expect(agySubtitle(agyEntry({ id: 'a1', label: '工作', email: 'w@example.com', plan: 'Ultra', running: 2 }))).toBe('2 个执行中 · w@example.com');
    expect(agySubtitle(agyEntry({ id: 'a2', label: '备用', plan: null, loggedIn: false }))).toBe('需要登录');
  });

  it('弹层只列出已登录的 Antigravity 账号（没登录的不出现）；agy 请求失败不影响 Claude', async () => {
    routes = { 'GET /api/accounts': () => ({ body: list([entry({})]) }) };
    await openMenu();
    expect(menu()!.querySelector('[aria-label="Antigravity"]')).toBeNull();
    expect(picks().length).toBe(1);
    act(() => root?.unmount());

    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([
        agyEntry({}),
        agyEntry({ id: 'w', label: '工作', active: false }),
        agyEntry({ id: 'x', label: '备用', plan: null, loggedIn: false, active: false }),
      ]) }),
    };
    await openMenu();
    const sec = menu()!.querySelector('[role="group"][aria-label="Antigravity"]')!;
    expect(sec).not.toBeNull();
    expect(sec.querySelector('.cz-acct-pick-grp')?.textContent).toContain('仅展示');
    expect([...sec.querySelectorAll('.cz-acct-pick__name b')].map((b) => b.textContent)).toEqual(['main@example.com', '工作']);
    expect(sec.querySelectorAll('button').length).toBe(0);
    expect(sec.textContent).not.toContain('委派任务');
  });

  it('没有 Antigravity 账号：弹层不显示 Antigravity 分组；管理面板下面留空但保留登录入口', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([]) }),
    };
    await openMenu();
    expect(menu()!.querySelector('[aria-label="Antigravity"]')).toBeNull();
    expect(menu()!.querySelector('.cz-sidebar__menu-list .cz-sidebar__menu-sep')).toBeNull();

    click(button('管理账号')!);
    await flush();
    const mgr = section('Antigravity')!;
    expect(cards('Antigravity').length).toBe(0);
    expect(mgr.querySelector('.cz-acct-mgr__empty')).toBeNull();
    expect(mgr.querySelector('.cz-acct-mgr__count')?.textContent).toBe('0');
    expect(btnIn(mgr, '登录 Antigravity')).toBeDefined();
  });

  it('agy 额度：弹层取最先重置的窗口，管理面板按模型组列出全部窗口；没登录的不显示额度', async () => {
    const t = Date.now();
    const quota = {
      at: 1,
      groups: [
        { name: 'Gemini', buckets: [
          { window: '5h', percent: 12, severity: 'normal' as const, resetsAt: t + 3 * 3_600_000 },
          { window: 'weekly', percent: 85, severity: 'warning' as const, resetsAt: t + 3 * 86_400_000 },
        ] },
        { name: 'Claude · GPT', buckets: [{ window: '5h', percent: 100, severity: 'critical' as const, resetsAt: t + 3_600_000 }] },
      ],
    };
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([
        agyEntry({ email: 'me@example.com', quota }),
        agyEntry({ id: 'w', label: '工作', email: 'w@example.com', quota: null, plan: null, loggedIn: false, active: false }),
      ]) }),
    };
    await openMenu();
    expect(calls.some((c) => c.url === '/api/agy-accounts?refresh=1')).toBe(true);
    const row = agyRowOf('me@example.com')!;
    const chip = row.querySelector('.cz-acct-chip');
    expect(chip?.textContent).toBe('Pro');
    const brief = row.querySelector('.cz-acctq-brief')!;
    expect(brief.classList.contains('is-critical')).toBe(true);
    expect(brief.textContent).toMatch(/^5h100%(1小时后|60分钟后|59分钟后)$/);
    expect(brief.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toMatch(/^Claude · GPT 5h 100% · /);
    expect(row.querySelector('[role="progressbar"]')?.getAttribute('aria-label')).toBe('Claude · GPT 5h已用');

    click(button('管理账号')!);
    await flush();
    const card = cardOf('Antigravity', 'me@example.com')!;
    const bars = [...card.querySelectorAll('[role="progressbar"]')];
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual(['Gemini 5h已用', 'Gemini 本周已用', 'Claude · GPT 5h已用']);
    expect(bars.map((b) => b.getAttribute('aria-valuenow'))).toEqual(['12', '85', '100']);
    expect([...card.querySelectorAll('.cz-acctq__grp-name')].map((g) => g.textContent)).toEqual(['Gemini', 'Claude · GPT']);
    expect(card.querySelector('.cz-acctq__line.is-warning')?.textContent).toContain('85%');
    expect(card.querySelector('.cz-acctq__updated')?.textContent).toContain('更新');
    // 有备注名时邮箱进副标题；没登录不显示额度，给「重新登录」
    const off = cardOf('Antigravity', '工作')!;
    expect(off.querySelector('.cz-acct-card__sub')?.textContent).toBe('w@example.com');
    expect(off.querySelector('.cz-acct-card__badge')?.textContent).toBe('需要登录');
    expect(off.querySelector('.cz-acctq-lines')).toBeNull();
    expect(btnIn(off, '重新登录')).toBeDefined();
  });

  it('未安装 Antigravity CLI：弹层不显示 Antigravity 分组；管理面板里说明没安装，不给添加按钮', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList([], false) }),
    };
    await openManager();
    expect(section('Antigravity')!.textContent).toContain('没有安装 Antigravity CLI');
    expect(btnIn(section('Antigravity'), '登录 Antigravity')).toBeUndefined();
    expect(cards('Antigravity').length).toBe(0);
    press(document, 'Escape');
    await flush();
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(menu()!.querySelector('[aria-label="Antigravity"]')).toBeNull();
  });

  it('弹层里的 Antigravity 分组只展示：点击不调用任何切换接口、不关闭弹层、不标选中', async () => {
    const agys = [agyEntry({}), agyEntry({ id: 'w', label: '工作', plan: 'Ultra', active: false, isDefault: false })];
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList(agys) }),
    };
    await openMenu();
    const row = agyRowOf('工作')!;
    expect(row.tagName).toBe('DIV');
    expect(row.classList.contains('is-active')).toBe(false);
    expect(agyRowOf('main@example.com')!.classList.contains('is-active')).toBe(false);
    click(row);
    await flush();
    expect(calls.some((c) => c.url.includes('switch'))).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it('管理面板 agy 卡片：当前账号也能改名 / 移除；执行中不能移除；切换后面板不关', async () => {
    let agys = [
      agyEntry({}),
      agyEntry({ id: 'w', label: '工作', plan: 'Ultra', active: false, running: 2 }),
      agyEntry({ id: 'p', label: '个人', plan: null, active: false, running: 0 }),
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
    await openManager();
    const rm = (name: string) => cardOf('Antigravity', name)!.querySelector<HTMLButtonElement>(`[aria-label="移除账号「${name}」"]`)!;
    const cur = cardOf('Antigravity', 'main@example.com')!;
    expect(cur.classList.contains('is-active')).toBe(true);
    expect(btnIn(cur, '改名')).toBeDefined();
    expect(rm('main@example.com').disabled).toBe(false);

    const busy = cardOf('Antigravity', '工作')!;
    expect(busy.querySelector('.cz-acct-card__sub')?.textContent).toBe('2 个委派执行中');
    expect(btnIn(busy, '改名')).toBeDefined();
    expect(rm('工作').disabled).toBe(true);
    expect(rm('工作').title).toBe('有 2 个委派任务正在执行，结束后才能移除');

    const pending = cardOf('Antigravity', '个人')!;
    expect(pending.querySelector('.cz-acct-card__sub')?.textContent ?? '').toBe('');
    expect(pending.classList.contains('is-off')).toBe(false);
    expect(rm('个人').disabled).toBe(false);
    click(btnIn(pending, '切换')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/agy-accounts/switch')?.body).toEqual({ id: 'p' });
    expect(reload).not.toHaveBeenCalled();
    expect(manager()).not.toBeNull();
    expect(cardOf('Antigravity', '个人')!.classList.contains('is-active')).toBe(true);
  });

  it('agy 改名：Esc 只取消改名不关面板，Enter 保存', async () => {
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
    await openManager();
    click(btnIn(cardOf('Antigravity', '工作'), '改名')!);
    await flush();
    const inp = manager()!.querySelector<HTMLInputElement>('[aria-label="修改备注名"]')!;
    expect(inp.value).toBe('工作');
    press(inp, 'Escape');
    await flush();
    expect(manager()!.querySelector('[aria-label="修改备注名"]')).toBeNull();
    expect(manager()).not.toBeNull();

    click(btnIn(cardOf('Antigravity', '工作'), '改名')!);
    await flush();
    const inp2 = manager()!.querySelector<HTMLInputElement>('[aria-label="修改备注名"]')!;
    type(inp2, '团队');
    press(inp2, 'Enter');
    await flush();
    expect(calls.find((c) => c.url === '/api/agy-accounts/label')?.body).toEqual({ id: 'w', label: '团队' });
    expect(cardOf('Antigravity', '团队')).toBeDefined();
  });

  it('「登录 Antigravity」：授权码失败后重新获取登录链接重试、成功后用于新的委派任务；以及取消登录', async () => {
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
      await openManager();
      click(btnIn(section('Antigravity'), '登录 Antigravity')!);
      await flush();
      // 入口已经定了类型：没有「添加到」切换
      expect(dlg()!.querySelector('[role="radiogroup"][aria-label="添加到"]')).toBeNull();
      type(dlgInput(), '副号');
      click(dlgBtn('登录'));
      await flush();
      expect(calls.find((c) => c.url === '/api/agy-accounts/login')?.body).toEqual({ label: '副号' });
      expect(dlg()!.querySelector('a')?.getAttribute('href')).toBe('https://accounts.google.com/mock?s=1');

      // 第一次提交授权码 → failed
      type(dlgInput(), 'bad-code');
      click(dlgBtn('提交'));
      await flush();
      await act(async () => { vi.advanceTimersByTime(400); });
      await flush();
      expect(dlg()!.textContent).toContain('授权码无效或已过期');
      expect(dlg()!.textContent).toContain('旧的登录链接已失效');

      // 「重新获取登录链接」保留之前填的备注名
      click(dlgBtn('重新获取登录链接'));
      await flush();
      expect(calls.filter((c) => c.url === '/api/agy-accounts/login').map((c) => c.body)).toEqual([{ label: '副号' }, { label: '副号' }]);

      // 第二次提交 → done → 用于新的委派任务
      type(dlgInput(), 'good-code');
      click(dlgBtn('提交'));
      await flush();
      await act(async () => { vi.advanceTimersByTime(400); });
      await flush();
      expect(submitCount).toBe(2);
      expect(dlg()!.textContent).toContain('登录成功');
      click(dlgBtn('用于新的委派任务'));
      await flush();
      expect(calls.find((c) => c.url === '/api/agy-accounts/switch')?.body).toEqual({ id: 'agy-new' });

      // 取消登录流程
      click(btnIn(section('Antigravity'), '登录 Antigravity')!);
      await flush();
      click(dlgBtn('登录'));
      await flush();
      click(dlgBtn('取消'));
      await flush();
      expect(calls.some((c) => c.url === '/api/agy-accounts/login/L3/cancel')).toBe(true);
      expect(manager()).not.toBeNull();
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
      await openManager();
      click(btnIn(section('Antigravity'), '登录 Antigravity')!);
      await flush();
      click(dlgBtn('登录'));
      await flush();

      type(dlgInput(), 'bad');
      click(dlgBtn('提交'));
      await flush();
      expect(dlg()!.textContent).toContain('授权码格式不对');

      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(pollCount).toBe(1);
      expect(dlg()!.textContent).toContain('临时网络波动');
      expect(dlg()!.textContent).toContain('授权码格式不对');

      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(pollCount).toBe(2);
      expect(dlg()!.textContent).not.toContain('临时网络波动');
      expect(dlg()!.textContent).toContain('授权码格式不对');

      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(pollCount).toBe(3);
      expect(dlg()!.textContent).toContain('登录已结束');
      expect(dlgBtn('重新获取登录链接')).toBeDefined();

      await act(async () => { vi.advanceTimersByTime(3000); });
      await flush();
      expect(pollCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('接续进行中的重新登录：保留标题与 accountId；卡片上重新登录遇 409 显示错误，关闭时不取消别的登录', async () => {
    vi.useFakeTimers();
    const ongoing: AccountLogin = {
      loginId: 'L-re', status: 'waiting', url: 'https://accounts.google.com/re', accountId: 'a2', error: null,
    };
    const agys = [
      agyEntry({}),
      agyEntry({ id: 'a2', label: '备用账号', plan: null, loggedIn: false, active: false }),
      agyEntry({ id: 'a3', label: '三号', plan: null, loggedIn: false, active: false }),
    ];
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: agyList(agys, true, ongoing) }),
      'GET /api/agy-accounts/login/L-re': () => ({ body: { ...ongoing, status: 'failed', error: '授权已过期' } }),
      'POST /api/agy-accounts/login': (b) => {
        const body = b as { accountId?: string };
        if (body.accountId === 'a3') return { status: 409, body: { error: '已有另一个登录正在进行' } };
        return { body: { loginId: 'L-re2', status: 'waiting', url: 'https://accounts.google.com/re2', accountId: body.accountId ?? null, error: null } };
      },
    };
    try {
      await openManager();
      // 有进行中的登录：「登录 Antigravity」接续它
      click(btnIn(section('Antigravity'), '登录 Antigravity')!);
      await flush();
      expect(dlg()!.querySelector('.cz-acct-dlg__title')?.textContent).toBe('重新登录：备用账号');
      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      click(dlgBtn('重新获取登录链接'));
      await flush();
      expect(calls.filter((c) => c.url === '/api/agy-accounts/login').at(-1)?.body).toEqual({ accountId: 'a2' });
      click(dlgBtn('取消'));
      await flush();

      click(btnIn(cardOf('Antigravity', '三号'), '重新登录')!);
      await flush();
      expect(dlg()!.textContent).toContain('已有另一个登录正在进行');
      const cancelBefore = calls.filter((c) => c.url.endsWith('/cancel')).length;
      click(dlgBtn('取消'));
      await flush();
      expect(dlg()).toBeNull();
      expect(manager()).not.toBeNull();
      expect(calls.filter((c) => c.url.endsWith('/cancel')).length).toBe(cancelBefore);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('深链 ?add=kiro', () => {
  const kiroStatus = (login: AccountLogin | null = null): KiroStatus => ({
    service: { enabled: true, accounts: 0, running: 0, failed: 0, busySessions: 0, outdated: 0, usable: 0 },
    imports: { kiroIde: true, kiroCli: true },
    login,
  });

  const savedUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  const savedState: unknown = window.history.state;

  afterEach(() => {
    window.history.replaceState(savedState, '', savedUrl);
  });

  it('带 ?add=kiro 时弹出 Kiro 对话框、不打开菜单，且只删除 add 参数并保留其它参数、hash 和 history.state', async () => {
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatus() }),
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
    };
    window.history.replaceState({ keep: 1 }, '', '/?foo=1&add=kiro&bar=2#sec');
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    await flush();

    const dlgs = document.querySelectorAll('[role="dialog"]');
    expect(dlgs.length).toBe(1);
    expect(dlgs[0].textContent).toContain('AWS Builder ID');
    expect(document.querySelector('.cz-sidebar__menu')).toBeNull();
    expect(window.location.search).toBe('?foo=1&bar=2');
    expect(window.location.hash).toBe('#sec');
    expect(window.history.state).toEqual({ keep: 1 });
  });

  it('StrictMode 下带 ?add=kiro 只弹出一个对话框且参数被清', async () => {
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatus() }),
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
    };
    window.history.replaceState(null, '', '/?add=kiro');
    mount(
      <StrictMode>
        <AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />
      </StrictMode>,
    );
    await flush();

    const dlgs = document.querySelectorAll('[role="dialog"]');
    expect(dlgs.length).toBe(1);
    expect(dlgs[0].textContent).toContain('AWS Builder ID');
    expect(window.location.search).toBe('');
  });

  it('无参数或 add 为其它值时不弹对话框，也不修改 URL', async () => {
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatus() }),
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
    };
    window.history.replaceState(null, '', '/');
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.location.search).toBe('');

    act(() => root?.unmount());
    window.history.replaceState({ stay: true }, '', '/?add=claude&foo=1#h');
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(window.location.search).toBe('?add=claude&foo=1');
    expect(window.location.hash).toBe('#h');
    expect(window.history.state).toEqual({ stay: true });
  });

  it('关闭对话框后重新渲染或重新挂载不再弹出', async () => {
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatus() }),
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
    };
    window.history.replaceState(null, '', '/?add=kiro');
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} version={0} />);
    await flush();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === '取消')!);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // 重新渲染不再弹
    act(() => root!.render(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} version={1} />));
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    // 卸载后再挂载也不再弹
    act(() => root?.unmount());
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} version={2} />);
    await flush();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('服务端已有进行中的 Kiro 登录时，带 ?add=kiro 弹出后自动续接该登录', async () => {
    vi.useFakeTimers();
    const ongoing: AccountLogin = {
      loginId: 'L-kiro-1',
      status: 'waiting',
      userCode: 'ABCD-1234',
      url: 'https://view.awsapps.com/start/#/device',
      accountId: null,
      error: null,
    };
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatus(ongoing) }),
      'GET /api/kiro/login/L-kiro-1': () => ({ body: ongoing }),
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
    };
    try {
      window.history.replaceState(null, '', '/?add=kiro');
      mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
      await flush();

      const dlg = document.querySelector('[role="dialog"]')!;
      expect(dlg).not.toBeNull();
      expect(dlg.textContent).toContain('ABCD-1234');
      expect(dlg.querySelector('a')?.getAttribute('href')).toBe('https://view.awsapps.com/start/#/device');
      expect(dlg.querySelector('[role="radiogroup"][aria-label="登录方式"]')).toBeNull();
      expect(window.location.search).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('账号悬浮详情卡', () => {
  const pointer = (el: Element, type: 'pointerover' | 'pointerout', pointerType = 'mouse') => act(() => {
    const ev = new MouseEvent(type, { bubbles: true });
    Object.defineProperty(ev, 'pointerType', { value: pointerType });
    el.dispatchEvent(ev);
  });
  const card = () => document.querySelector<HTMLElement>('.cz-acard');
  const wait = (ms: number) => act(async () => { vi.advanceTimersByTime(ms); });

  beforeEach(async () => {
    vi.useFakeTimers();
    const now = Date.now();
    routes = {
      'GET /api/accounts': () => ({ body: list([
        entry({ loginExpiresAt: now + 3 * 86_400_000 }),
        entry({ id: 'p', label: 'RS', name: null, plan: null, active: false, isDefault: false, api: {
          baseUrl: 'https://relay.example.com/v1', authType: 'authToken', keyHint: 'abcd',
          models: { alias: { opus: { id: 'glm-4.6', label: 'GLM 4.6' } } },
        } }),
      ]) }),
      'GET /api/usage?account=default': () => ({ body: { at: now, limits: [
        { kind: 'session', percent: 32, severity: 'normal', resetsAt: now + 3_600_000 },
        { kind: 'weekly', percent: 61, severity: 'normal', resetsAt: now + 86_400_000 },
      ] } }),
    };
    await openMenu();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('停留后显示全部额度和登录信息；换到另一个账号内容跟着换；移开后关闭', async () => {
    pointer(pickOf('cosyeey')!, 'pointerover');
    await wait(300);
    expect(card()).toBeNull();
    await wait(150);
    expect(card()!.textContent).toContain('本周');
    expect(card()!.textContent).toContain('3 天后失效');
    expect(pickOf('cosyeey')!.getAttribute('aria-describedby')).toBe(card()!.id);

    pointer(pickOf('cosyeey')!, 'pointerout');
    pointer(pickOf('RS')!, 'pointerover');
    await wait(100);
    const text = card()!.textContent!;
    expect(text).toContain('https://relay.example.com/v1');
    expect(text).toContain('•••• abcd');
    expect(text).toContain('opus → GLM 4.6（glm-4.6）');

    pointer(pickOf('RS')!, 'pointerout');
    // 宽限期内移进卡片不关
    await wait(100);
    pointer(card()!, 'pointerover');
    await wait(400);
    expect(card()).not.toBeNull();
    pointer(card()!, 'pointerout');
    await wait(400);
    expect(card()).toBeNull();
  });

  it('触屏不弹；Esc 先关卡片、弹层还在；弹层关闭时一起关', async () => {
    pointer(pickOf('cosyeey')!, 'pointerover', 'touch');
    await wait(600);
    expect(card()).toBeNull();
    pointer(pickOf('cosyeey')!, 'pointerover');
    await wait(450);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(card()).toBeNull();
    expect(menu()).not.toBeNull();
    pointer(pickOf('cosyeey')!, 'pointerover');
    await wait(450);
    expect(card()).not.toBeNull();
    click(document.querySelector('[aria-label="账户菜单"]')!);
    expect(card()).toBeNull();
  });
});

describe('账号弹层分组与边界', () => {
  const agyItem = (over: Partial<AgyAccountEntry>): AgyAccountEntry => ({
    id: 'g1', label: '', email: 'agy@example.com', plan: 'Google AI Pro', loggedIn: true, active: true, isDefault: false, running: 0, ...over,
  });

  it('无分页，按「Claude 订阅 / API / Kiro → 分隔线 → Antigravity」顺序展示；点 Claude 账号切换主账号', async () => {
    routes = {
      'GET /api/accounts': () => ({ body: mixedList() }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: { installed: true, list: [agyItem({})], login: null } satisfies AgyAccountList }),
      'POST /api/accounts/switch': () => ({ body: { ok: true } }),
    };
    await openMenu();
    expect(menu()!.querySelector('[role="tablist"]')).toBeNull();
    expect(calls.some((c) => c.url === '/api/subagents')).toBe(false);

    const listEl = menu()!.querySelector('.cz-sidebar__menu-list')!;
    const groups = [...listEl.querySelectorAll('.cz-acct-pick-sec')];
    expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Claude 订阅', 'API', 'Kiro', 'Antigravity']);
    // Antigravity 分组前有分隔线
    const agySec = groups[3];
    expect(agySec.previousElementSibling?.classList.contains('cz-sidebar__menu-sep')).toBe(true);
    expect(agySec.querySelector('.cz-acct-pick-grp')?.textContent).toContain('仅展示');

    // 点击 Claude 账号切换主账号
    click(pickOf('Bob')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/switch')?.body).toEqual({ id: 'a1', force: false });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('Antigravity 行支持悬停详情卡，点击不触发任何切换', async () => {
    vi.useFakeTimers();
    const pointer = (el: Element, type: 'pointerover' | 'pointerout') => act(() => {
      const ev = new MouseEvent(type, { bubbles: true });
      Object.defineProperty(ev, 'pointerType', { value: 'mouse' });
      el.dispatchEvent(ev);
    });
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})]) }),
      'GET /api/agy-accounts?refresh=1': () => ({ body: { installed: true, list: [agyItem({ id: 'g1', label: '工作', email: 'w@example.com' })], login: null } satisfies AgyAccountList }),
    };
    try {
      await openMenu();
      const row = agyRowOf('工作')!;
      pointer(row, 'pointerover');
      await act(async () => { vi.advanceTimersByTime(450); });
      const hoverCard = document.querySelector<HTMLElement>('.cz-acard');
      expect(hoverCard).not.toBeNull();
      expect(hoverCard!.textContent).toContain('w@example.com');

      click(row);
      await flush();
      expect(calls.some((c) => c.url.includes('switch'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('模式切换支持键盘方向键和 roving tabindex', async () => {
    let mode: AccountMode = 'switch';
    routes = {
      'GET /api/accounts': () => ({ body: list([entry({})], mode) }),
      'POST /api/accounts/mode': (b) => { mode = (b as { mode: AccountMode }).mode; return { body: { ok: true } }; },
    };
    await openMenu();
    const modeGroup = menu()!.querySelector<HTMLElement>('[role="radiogroup"][aria-label="账号模式"]')!;
    const modeBtns = [...modeGroup.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(modeBtns[0].tabIndex).toBe(0);
    expect(modeBtns[1].tabIndex).toBe(-1);
    press(modeGroup, 'ArrowRight');
    await flush();
    expect(calls.find((c) => c.url === '/api/accounts/mode')?.body).toEqual({ mode: 'parallel', force: false });
  });

  it('请求失败后 version 递增重读成功会清除旧错误', async () => {
    let attempt = 0;
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (url === '/api/accounts') {
        attempt += 1;
        if (attempt === 1) return Promise.resolve(new Response(JSON.stringify({ error: '临时网络故障' }), { status: 500 }));
        return Promise.resolve(new Response(JSON.stringify(list([entry({})])), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'not found' }), { status: 404 }));
    }));

    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} version={0} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
    expect(menu()!.textContent).toContain('临时网络故障');

    act(() => root!.render(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} version={1} />));
    await flush();
    expect(menu()!.textContent).not.toContain('临时网络故障');
  });

  it('无可用主账号时显示空态提示与「添加账号」入口，点击打开管理账号面板', async () => {
    routes = { 'GET /api/accounts': () => ({ body: list([]) }) };
    await openMenu();
    const empty = menu()!.querySelector('.cz-acct-pick-empty--action')!;
    expect(empty.textContent).toContain('没有可用的账号');
    const addBtn = empty.querySelector<HTMLButtonElement>('.cz-acct-empty-btn')!;
    expect(addBtn.textContent).toBe('添加账号');
    click(addBtn);
    await flush();
    expect(menu()).toBeNull();
    expect(manager()).not.toBeNull();
  });
});
