// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountEntry, AccountList, AccountLogin, ComponentList, ComponentStatus, KiroBalance, KiroStatus } from '@cosyee/shared';
import { AccountMenu, accountPage } from './AccountMenu';
import { AddKindSeg, type AddKind } from './ApiAccountDialog';
import { KiroAccountDialog } from './KiroAccountDialog';

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
const press = (el: EventTarget, key: string) => act(() => {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
});
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const dlgBtn = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === text);
const radioByText = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((b) => b.textContent?.includes(text));

interface Call { method: string; url: string; body: unknown }
let calls: Call[];
let routes: Record<string, (body: unknown) => { status?: number; body: unknown }>;

const kiroStatusOf = (over?: {
  service?: Partial<KiroStatus['service']>;
  imports?: Partial<KiroStatus['imports']>;
  login?: AccountLogin | null;
}): KiroStatus => ({
  service: { enabled: true, accounts: 0, running: 0, failed: 0, busySessions: 0, outdated: 0, usable: 0, ...(over?.service ?? {}) },
  imports: { kiroIde: true, kiroCli: true, ...(over?.imports ?? {}) },
  login: over?.login ?? null,
});

/** /api/components 里的 kiro.rs 一项；默认已安装、服务在跑 */
const kiroComp = (over?: Partial<ComponentStatus>): ComponentStatus => ({
  id: 'kiro', name: 'kiro.rs', installed: true, custom: false, version: '0.9.8', latest: '0.9.8', updateAvailable: false,
  checkedAt: null, checkError: null, autoUpdate: true, busy: 0, pending: false, updatedBy: 'server', installable: true, job: null,
  service: { state: 'ready', error: null, enabled: true, outdated: false, port: 21395, accounts: { total: 0, usable: 0 } },
  ...over,
});
const compsOf = (c: ComponentStatus): { body: ComponentList } => ({ body: { list: [c] } });
const notInstalled = (job: ComponentStatus['job'] = null) => kiroComp({ installed: false, version: null, job, service: undefined });

const acctEntry = (over: Partial<AccountEntry>): AccountEntry => ({
  id: 'default', label: '', name: 'cosyeey', plan: 'Pro', loggedIn: true, active: true, isDefault: true, ...over,
});

beforeEach(() => {
  localStorage.clear();
  calls = [];
  routes = {};
  vi.spyOn(accountPage, 'reload').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, url, body });
    const fallback = url === '/api/components' ? compsOf(kiroComp()) : { status: 404, body: { error: 'not found' } };
    const r = routes[`${method} ${url}`]?.(body) ?? fallback;
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

describe('AddKindSeg 键盘循环', () => {
  function Harness() {
    const [kind, setKind] = useState<AddKind>('login');
    return <AddKindSeg kind={kind} onChange={setKind} />;
  }

  it('三选一支持方向键正向与反向循环', () => {
    mount(<Harness />);
    const radios = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    expect(radios().map((r) => r.textContent)).toEqual(['Claude 账号登录', 'API Key', 'Kiro']);
    expect(radios()[0].getAttribute('aria-checked')).toBe('true');

    press(radios()[0], 'ArrowRight');
    expect(radios()[1].getAttribute('aria-checked')).toBe('true');

    press(radios()[1], 'ArrowDown');
    expect(radios()[2].getAttribute('aria-checked')).toBe('true');

    press(radios()[2], 'ArrowRight');
    expect(radios()[0].getAttribute('aria-checked')).toBe('true');

    press(radios()[0], 'ArrowLeft');
    expect(radios()[2].getAttribute('aria-checked')).toBe('true');

    press(radios()[2], 'ArrowUp');
    expect(radios()[1].getAttribute('aria-checked')).toBe('true');
  });
});

describe('KiroAccountDialog', () => {
  const noop = () => {};

  it('无引擎：显示下载说明与「下载 kiro.rs」按钮，不再提示编译工具', async () => {
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatusOf() }),
      'GET /api/components': () => compsOf(notInstalled()),
    };
    mount(<KiroAccountDialog onClose={noop} onDone={noop} onSwitch={noop} />);
    await flush();

    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.textContent).toContain('ZyphrZero/kiro.rs');
    expect(dlg.textContent).not.toContain('cargo');
    expect(dlg.textContent).not.toContain('缺少编译工具');
    expect(dlg.querySelector('a')).toBeNull();
    expect(dlgBtn('下载 kiro.rs')?.disabled).toBe(false);
  });

  it('无引擎：点击下载触发组件安装、403 原样显示错误；安装中轮询直到失败可重试、成功后进入登录表单', async () => {
    vi.useFakeTimers();
    let step = 0;
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatusOf() }),
      'GET /api/components': () => {
        if (step === 0) return compsOf(notInstalled());
        if (step === 1) {
          step = 2;
          return compsOf(notInstalled({ kind: 'install', state: 'running', error: null }));
        }
        if (step === 2) return compsOf(notInstalled({ kind: 'install', state: 'failed', error: 'SHA256 校验失败' }));
        return compsOf(kiroComp());
      },
      'POST /api/components/kiro/update': () => {
        if (step === 0) {
          step = 1;
          return { status: 403, body: { error: '该操作仅允许本机连接' } };
        }
        if (step !== 1) step = 3;
        return { body: notInstalled({ kind: 'install', state: 'running', error: null }) };
      },
    };
    try {
      mount(<KiroAccountDialog onClose={noop} onDone={noop} onSwitch={noop} />);
      await flush();

      // 第一次 build 403 → 原样显示错误
      click(dlgBtn('下载 kiro.rs')!);
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('该操作仅允许本机连接');

      // 第二次 → running → 轮询 → failed
      click(dlgBtn('下载 kiro.rs')!);
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('正在下载 kiro.rs');
      expect(dlgBtn('正在下载…')?.disabled).toBe(true);

      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(dlgBtn('正在下载…')?.disabled).toBe(true);

      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('SHA256 校验失败');
      expect(dlgBtn('重试下载')?.disabled).toBe(false);

      // 重试下载 → 完成后进入登录表单
      click(dlgBtn('重试下载')!);
      await flush();
      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(document.querySelector('[role="radiogroup"][aria-label="登录方式"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('各登录方式提交体：Builder ID / IAM Identity Center / 导入警告与禁用 / Kiro API Key', async () => {
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatusOf({ imports: { kiroIde: true, kiroCli: false } }) }),
      'POST /api/kiro/login': (b) => {
        const m = (b as { method: string }).method;
        if (m === 'apiKey') return { body: { loginId: 'L-key', status: 'done', url: null, accountId: 'kiro-1', error: null } };
        return { body: { loginId: 'L-1', status: 'waiting', userCode: 'WXYZ-9999', url: 'https://view.awsapps.com/start/#/device', accountId: null, error: null } };
      },
      'POST /api/kiro/login/L-1/cancel': () => ({ body: { ok: true } }),
    };
    const onDone = vi.fn();
    const onSwitch = vi.fn();
    mount(<KiroAccountDialog onClose={noop} onDone={onDone} onSwitch={onSwitch} />);
    await flush();

    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.textContent).toContain('Google / GitHub');
    expect(dlg.textContent).toContain('kiro-cli login');

    // kiroCli 未找到时禁用并提示
    const cliRadio = radioByText('从 Kiro CLI 导入')!;
    expect(cliRadio.disabled).toBe(true);
    expect(cliRadio.textContent).toContain('未找到本机登录');

    // 选 Kiro IDE 导入：显示共享登录警告
    const ideRadio = radioByText('从 Kiro IDE 导入')!;
    expect(ideRadio.disabled).toBe(false);
    click(ideRadio);
    expect(dlg.textContent).toContain('导入后两边共用同一个登录，刷新令牌可能使 Kiro IDE / CLI 需要重新登录');

    // 选 IAM Identity Center：Start URL 为空禁用，Region 默认 us-east-1
    click(radioByText('IAM Identity Center')!);
    expect(dlgBtn('登录')?.disabled).toBe(true);
    const idcInputs = dlg.querySelectorAll<HTMLInputElement>('.cz-acct-dlg__input');
    // 0: 备注名, 1: Start URL, 2: Region
    expect(idcInputs[2].value).toBe('us-east-1');
    type(idcInputs[0], '企业号');
    type(idcInputs[1], 'https://d-12345.awsapps.com/start');
    type(idcInputs[2], 'eu-central-1');
    click(dlgBtn('登录')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/kiro/login')?.body).toEqual({
      method: 'idc',
      label: '企业号',
      startUrl: 'https://d-12345.awsapps.com/start',
      region: 'eu-central-1',
    });
    // 设备码与登录页链接显示，取消调用 cancel
    expect(dlg.textContent).toContain('WXYZ-9999');
    expect(dlg.querySelector('a')?.getAttribute('href')).toBe('https://view.awsapps.com/start/#/device');
    click(dlgBtn('取消')!);
    await flush();
    expect(calls.some((c) => c.url === '/api/kiro/login/L-1/cancel')).toBe(true);

    // 重新挂载测 API Key：password 输入框、提交后 done、完成与切换
    act(() => root?.unmount());
    calls = [];
    mount(<KiroAccountDialog onClose={noop} onDone={onDone} onSwitch={onSwitch} />);
    await flush();
    click(radioByText('Kiro API Key')!);
    const keyInput = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="password"]')!;
    expect(keyInput).not.toBeNull();
    expect(keyInput.value).toBe('');
    expect(dlgBtn('添加')?.disabled).toBe(true);
    type(keyInput, 'ksk_test_secret_123');
    click(dlgBtn('添加')!);
    await flush();
    expect(calls.find((c) => c.url === '/api/kiro/login')?.body).toEqual({
      method: 'apiKey',
      label: '',
      apiKey: 'ksk_test_secret_123',
    });
    expect(onDone).toHaveBeenCalledWith('kiro-1');
    click(dlgBtn('切换到该账号')!);
    expect(onSwitch).toHaveBeenCalledWith('kiro-1');
  });

  it('设备码轮询到失败可重试；relogin 传 accountId；从 KiroStatus.login 自动恢复', async () => {
    vi.useFakeTimers();
    let pollState: AccountLogin = {
      loginId: 'L-dev',
      status: 'waiting',
      userCode: 'ABCD-1234',
      url: 'https://view.awsapps.com/start/#/device',
      accountId: null,
      error: null,
    };
    routes = {
      'GET /api/kiro': () => ({ body: kiroStatusOf({ login: pollState }) }),
      'GET /api/kiro/login/L-dev': () => ({ body: pollState }),
      'POST /api/kiro/login': () => ({
        body: { loginId: 'L-re', status: 'done', url: null, accountId: 'k1', error: null },
      }),
    };
    try {
      mount(<KiroAccountDialog relogin={{ id: 'k1', title: 'Kiro 个人', active: false }} onClose={noop} onDone={noop} onSwitch={noop} />);
      await flush();
      // 自动恢复 KiroStatus.login
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('ABCD-1234');

      pollState = { ...pollState, status: 'failed', error: '用户拒绝授权' };
      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('用户拒绝授权');

      // 点重试回到表单，提交带 accountId（不带 label）
      click(dlgBtn('重试')!);
      await flush();
      click(dlgBtn('登录')!);
      await flush();
      expect(calls.find((c) => c.url === '/api/kiro/login')?.body).toEqual({
        method: 'builderId',
        accountId: 'k1',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AccountMenu Kiro 集成', () => {
  const openManager = async () => {
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();
  };
  const pickOf = (name: string) => [...document.querySelectorAll<HTMLElement>('.cz-acct-pick')]
    .find((b) => b.querySelector('.cz-acct-pick__name b')?.textContent === name);
  const manager = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="管理账号"]');
  const cardOf = (name: string) => [...(manager()?.querySelectorAll<HTMLElement>('.cz-acct-card') ?? [])]
    .find((c) => c.querySelector('.cz-acct-card__name b')?.textContent === name);
  const btnIn = (el: Element | null | undefined, text: string) =>
    [...(el?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((b) => b.textContent === text);
  /** 叠在管理面板上的登录对话框 */
  const topDlg = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .filter((d) => d.getAttribute('aria-label') !== '管理账号' && !d.classList.contains('cz-sidebar__confirm'))
    .at(-1) ?? null;

  it('弹层 Kiro 行只显示月度额度；管理面板卡片显示额度、凭据状态、重新登录，面板里一行 kiro.rs 状态', async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 10, 24, 10, 0).getTime();
    vi.setSystemTime(base);
    const kiroOk = acctEntry({
      id: 'k1', label: 'Kiro 主号', name: 'Kiro 主号', plan: null, loggedIn: true, active: false, isDefault: false,
      subscribedAt: base, loginExpiresAt: base + 86400_000,
      kiro: { method: 'builderId', proxy: 'ready', error: null, credential: 'ok' },
    });
    const kiroFail = acctEntry({
      id: 'k2', label: 'Kiro 异常', name: 'Kiro 异常', plan: null, loggedIn: true, active: false, isDefault: false,
      kiro: { method: 'apiKey', proxy: 'ready', error: null, credential: 'quota', credentialReason: 'QuotaExceeded' },
    });
    routes = {
      'GET /api/accounts': () => ({ body: { mode: 'switch', list: [acctEntry({}), kiroOk, kiroFail], login: null } satisfies AccountList }),
      'GET /api/usage?account=default': () => ({ body: { at: base, limits: [] } }),
      'GET /api/kiro/balance?account=k1': () => ({
        body: { subscription: 'Kiro Pro', used: 120, limit: 500, resetsAt: base + 2 * 3_600_000 } satisfies KiroBalance,
      }),
      'GET /api/kiro/balance?account=k2': () => ({ status: 500, body: { error: 'boom' } }),
      'GET /api/kiro': () => ({ body: kiroStatusOf() }),
      'GET /api/components': () => compsOf(kiroComp({
        version: '0.9.9',
        service: { state: 'ready', error: null, enabled: true, outdated: false, port: 21395, accounts: { total: 2, usable: 1 } },
      })),
    };
    try {
      await openManager();

      // 只对 Claude 订阅账号请求 /api/usage，不对 Kiro 账号请求
      expect(calls.filter((c) => c.url.startsWith('/api/usage')).map((c) => c.url)).toEqual(['/api/usage?account=default']);
      expect(calls.filter((c) => c.url.startsWith('/api/kiro/balance')).map((c) => c.url).sort()).toEqual([
        '/api/kiro/balance?account=k1',
        '/api/kiro/balance?account=k2',
      ]);

      // 弹层：Kiro 行没有套餐标签，一条「本月」进度条，用量放在进度条的读屏说明
      const pick = pickOf('Kiro 主号')!;
      expect(pick.querySelector('.cz-acct-chip')).toBeNull();
      expect(pick.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext')).toContain('120 / 500');
      expect(document.querySelector('.cz-kiro-eng')).toBeNull();

      click(btnIn(document.querySelector('.cz-acct-menu'), '管理账号')!);
      await flush();
      // Kiro 主号：used / limit 与重置时间、没有订阅日期、操作是「重新登录」而不是「编辑」
      const ok = cardOf('Kiro 主号')!;
      expect(ok.textContent).toContain('120 / 500');
      expect(ok.textContent).toContain('2小时后重置');
      expect(ok.textContent).not.toContain('订阅约');
      expect(btnIn(ok, '重新登录')).toBeDefined();
      expect(btnIn(ok, '编辑')).toBeUndefined();

      // Kiro 异常：额度用完的红色标签与额度读取失败
      const bad = cardOf('Kiro 异常')!;
      expect(bad.querySelector('.cz-acct-chip.is-danger')?.textContent).toBe('额度用完');
      expect(ok.querySelector('.cz-acct-chip.is-danger')).toBeNull();
      expect(bad.textContent).toContain('额度读取失败');

      // kiro.rs 一行：版本、运行中、可用账号数（不足时标黄），没有检查更新 / 更新按钮
      const eng = manager()!.querySelector('.cz-kiro-eng')!;
      expect(eng.textContent).toContain('kiro.rs');
      expect(eng.textContent).toContain('运行中 · 1/2 账号可用');
      expect(eng.querySelector('.cz-kiro-eng__step.is-warn')).not.toBeNull();
      expect(eng.querySelectorAll('button').length).toBe(0);

      // 卡片上的「重新登录」打开 KiroAccountDialog，叠在面板上
      click(btnIn(cardOf('Kiro 主号'), '重新登录')!);
      await flush();
      expect(topDlg()?.textContent).toContain('重新登录 Kiro：Kiro 主号');
      expect(manager()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('管理面板：手动停止时 kiro.rs 一行显示「已手动停止」，没装时只有「安装」；对话框提示到客户端「组件」启动', async () => {
    const kiroAcc = acctEntry({
      id: 'k1', label: 'Kiro 主号', name: 'Kiro 主号', plan: null, loggedIn: true, active: false, isDefault: false,
      kiro: { method: 'builderId', proxy: 'stopped', error: null, credential: 'unknown' },
    });
    const comp = kiroComp({
      service: { state: 'stopped', error: null, enabled: false, outdated: true, port: null, accounts: { total: 1, usable: 0 } },
    });
    routes = {
      'GET /api/accounts': () => ({ body: { mode: 'switch', list: [acctEntry({}), kiroAcc], login: null } satisfies AccountList }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [] } }),
      'GET /api/kiro/balance?account=k1': () => ({ status: 500, body: { error: 'stopped' } }),
      'GET /api/kiro': () => ({ body: kiroStatusOf({ service: { enabled: false, outdated: 1 } }) }),
      'GET /api/components': () => compsOf(comp),
    };
    await openManager();
    click(btnIn(document.querySelector('.cz-acct-menu'), '管理账号')!);
    await flush();

    const eng = manager()!.querySelector('.cz-kiro-eng')!;
    expect(eng.textContent).toContain('已手动停止');
    expect(eng.textContent).toContain('重启后用新版');
    expect(eng.querySelectorAll('button').length).toBe(0);

    // 打开 Kiro 对话框：提示到客户端的「组件」启动
    click(btnIn(cardOf('Kiro 主号'), '重新登录')!);
    await flush();
    expect(topDlg()?.textContent).toContain('「组件」');
  });

  it('管理面板：kiro.rs 没装时只显示「安装」，点了走组件安装接口', async () => {
    const kiroAcc = acctEntry({
      id: 'k1', label: 'Kiro 主号', name: 'Kiro 主号', plan: null, loggedIn: true, active: false, isDefault: false,
      kiro: { method: 'builderId', proxy: 'stopped', error: null, credential: 'unknown' },
    });
    routes = {
      'GET /api/accounts': () => ({ body: { mode: 'switch', list: [acctEntry({}), kiroAcc], login: null } satisfies AccountList }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [] } }),
      'GET /api/kiro/balance?account=k1': () => ({ status: 500, body: { error: 'stopped' } }),
      'GET /api/components': () => compsOf(notInstalled()),
      'POST /api/components/kiro/update': () => ({ body: notInstalled({ kind: 'install', state: 'running', error: null }) }),
    };
    await openManager();
    click(btnIn(document.querySelector('.cz-acct-menu'), '管理账号')!);
    await flush();
    const eng = manager()!.querySelector('.cz-kiro-eng')!;
    expect(eng.textContent).toContain('未安装');
    click(btnIn(eng, '安装')!);
    await flush();
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/components/kiro/update')).toBe(true);
    expect(eng.textContent).toContain('正在安装');
  });
});
