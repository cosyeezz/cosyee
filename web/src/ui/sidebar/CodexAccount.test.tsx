// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountList, AgyAccountList, CodexAccountEntry, CodexAccountList, CodexQuota } from '@cosyee/shared';
import { AccountMenu } from './AccountMenu';
import { CodexCardBody } from './AccountCard';
import { CodexQuotaView, codexWindowLabel, codexWindows } from './AccountQuota';
import { AddTargetSeg } from './AddTargetSeg';
import { codexPlan, codexRemoveBlock, codexSubtitle, codexTitle, planChip } from './accountParts';

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
  for (let i = 0; i < 6; i++) await act(async () => { await Promise.resolve(); });
};
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

const sampleQuota = (now: number): CodexQuota => ({
  fetchedAt: now,
  planType: 'pro',
  groups: [
    {
      limitId: 'codex',
      primary: { usedPercent: 42, windowMins: 300, resetsAt: now + 2 * 3_600_000 },
      secondary: { usedPercent: 91, windowMins: 10080, resetsAt: now + 3 * 86_400_000 },
    },
  ],
});

const codexEntry = (over: Partial<CodexAccountEntry> = {}): CodexAccountEntry => ({
  id: 'default',
  label: '',
  plan: 'plus',
  planType: 'plus',
  authMode: 'chatgpt',
  email: 'dev@openai.com',
  loggedIn: true,
  active: true,
  isDefault: true,
  running: 0,
  quota: null,
  ...over,
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Codex accountParts & AccountQuota', () => {
  it('标题、副标题、套餐标签与移除限制', () => {
    expect(codexTitle(codexEntry())).toBe('dev@openai.com');
    expect(codexTitle(codexEntry({ email: null, isDefault: true }))).toBe('本机 Codex');
    expect(codexTitle(codexEntry({ email: null, isDefault: false }))).toBe('Codex 账号');
    expect(codexTitle(codexEntry({ label: '主力', email: 'a@b.com' }))).toBe('主力');

    expect(codexSubtitle(codexEntry({ label: '主力', email: 'a@b.com', running: 2 }))).toBe('2 个执行中 · a@b.com');
    expect(codexSubtitle(codexEntry({ authMode: 'apiKey', email: null, label: 'API' }))).toBe('API Key');
    expect(codexSubtitle(codexEntry({ loggedIn: false, email: 'a@b.com' }))).toBe('需要登录');

    expect(planChip('plus')).toBe('Plus');
    expect(planChip('enterprise')).toBe('Enterprise');
    expect(planChip('api_key')).toBe('API Key');
    expect(codexPlan(codexEntry({ plan: null, planType: null, authMode: 'apiKey' }))).toBe('API Key');

    expect(codexRemoveBlock(codexEntry({ isDefault: true }))).toBe('默认账号不能移除');
    expect(codexRemoveBlock(codexEntry({ isDefault: false, running: 2 }))).toContain('2 个委派任务');
    expect(codexRemoveBlock(codexEntry({ isDefault: false, running: 0 }))).toBeNull();
  });

  it('codexWindowLabel 与 codexWindows 按 windowMins 格式化', () => {
    expect(codexWindowLabel(300, 'primary')).toBe('5 小时');
    expect(codexWindowLabel(10080, 'secondary')).toBe('每周');
    expect(codexWindowLabel(30, 'primary')).toBe('30 分钟');
    expect(codexWindowLabel(120, 'primary')).toBe('2 小时');
    expect(codexWindowLabel(2880, 'secondary')).toBe('2 天');

    const now = Date.now();
    const ws = codexWindows(sampleQuota(now));
    expect(ws.map((w) => [w.label, w.percent, w.severity])).toEqual([
      ['5 小时', 42, 'normal'],
      ['每周', 91, 'critical'],
    ]);

    mount(<CodexQuotaView quota={sampleQuota(now)} now={now} />);
    expect(host!.textContent).toContain('5 小时');
    expect(host!.textContent).toContain('42%');
    expect(host!.textContent).toContain('每周');
    expect(host!.textContent).toContain('91%');
  });

  it('CodexCardBody 显示 ChatGPT 额度与 API Key 计费说明', () => {
    const now = Date.now();
    mount(<CodexCardBody a={codexEntry({ label: '主力 Pro', planType: 'pro', quota: sampleQuota(now) })} now={now} />);
    expect(host!.textContent).toContain('主力 Pro');
    expect(host!.textContent).toContain('Pro');
    expect(host!.textContent).toContain('dev@openai.com');
    expect(host!.textContent).toContain('5 小时');

    act(() => root!.unmount());
    mount(<CodexCardBody a={codexEntry({ label: 'API', email: null, plan: null, planType: null, authMode: 'apiKey', active: false })} now={now} />);
    expect(host!.textContent).toContain('按量计费（API Key）');
  });

  it('AddTargetSeg 支持 codex 选项与禁用提示', () => {
    const onChange = vi.fn();
    mount(<AddTargetSeg target="claude" codexDisabled onChange={onChange} />);
    const codexRadio = host!.querySelector<HTMLButtonElement>('[data-target="codex"]')!;
    expect(codexRadio.disabled).toBe(true);
    expect(host!.textContent).toContain('没有安装 Codex CLI');
  });
});

describe('AccountMenu & AccountManager · Codex 分组', () => {
  let calls: { method: string; url: string; body: unknown }[];
  let routes: Record<string, (body: unknown) => { status?: number; body: unknown }>;

  beforeEach(() => {
    localStorage.clear();
    calls = [];
    const now = Date.now();
    const accounts: AccountList = {
      mode: 'parallel',
      list: [{ id: 'default', label: '', name: 'cosyeey', plan: 'Pro', loggedIn: true, active: true, isDefault: true }],
      login: null,
    };
    const agy: AgyAccountList = { installed: false, list: [], login: null };
    const codex: CodexAccountList = {
      installed: true,
      list: [
        codexEntry({ id: 'default', isDefault: true, active: true, quota: sampleQuota(now) }),
        codexEntry({ id: 'cx-2', label: '工作 Codex', email: 'work@openai.com', planType: 'team', isDefault: false, active: false }),
        codexEntry({ id: 'cx-off', label: '已登出', email: null, loggedIn: false, isDefault: false, active: false }),
      ],
      login: null,
      duplicates: 1,
    };
    routes = {
      'GET /api/accounts': () => ({ body: accounts }),
      'GET /api/agy-accounts': () => ({ body: agy }),
      'GET /api/codex-accounts': () => ({ body: codex }),
      'GET /api/usage?account=default': () => ({ body: null }),
      'POST /api/codex-accounts/switch': () => ({ body: { ok: true } }),
      'POST /api/codex-accounts/dedupe': () => ({ body: { removed: 1, skipped: 0 } }),
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const r = routes[`${method} ${url}`]?.(body) ?? { status: 404, body: { error: 'not found' } };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }));
  });

  it('弹层展示已登录 Codex 只读分组；管理面板支持切换、去重与打开登录弹窗', async () => {
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} remote />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();

    const menuCodex = document.querySelector<HTMLElement>('.cz-acct-menu [role="group"][aria-label="Codex"]')!;
    expect(menuCodex).toBeTruthy();
    expect(menuCodex.textContent).toContain('dev@openai.com');
    expect(menuCodex.textContent).toContain('工作 Codex');
    expect(menuCodex.textContent).not.toContain('已登出');

    click([...document.querySelectorAll('button')].find((b) => b.textContent?.includes('管理账号'))!);
    await flush();

    const sec = document.querySelector<HTMLElement>('section[aria-label="Codex"]')!;
    expect(sec).toBeTruthy();
    expect(sec.textContent).toContain('工作 Codex');
    expect(sec.textContent).toContain('已登出');

    // 切换工作 Codex
    const workCard = [...sec.querySelectorAll('.cz-acct-card')].find((c) => c.textContent?.includes('工作 Codex'))!;
    click([...workCard.querySelectorAll('button')].find((b) => b.textContent === '切换')!);
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/codex-accounts/switch' && (c.body as { id: string }).id === 'cx-2')).toBe(true);

    // 点「登录 Codex」打开 CodexAccountDialog，且 remote=true 默认设备码
    click([...sec.querySelectorAll('button')].find((b) => b.textContent?.includes('登录 Codex'))!);
    await flush();
    const dlg = document.querySelector<HTMLElement>('[role="dialog"][aria-label="添加 Codex 账号"]')!;
    expect(dlg).toBeTruthy();
    expect(dlg.querySelector('[data-method="deviceAuth"]')?.getAttribute('aria-checked')).toBe('true');
  });
});
