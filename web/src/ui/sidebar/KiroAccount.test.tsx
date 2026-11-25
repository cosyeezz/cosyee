// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountEntry, AccountList, AccountLogin, KiroBalance, KiroStatus } from '@cosyee/shared';
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
  engine?: Partial<KiroStatus['engine']>;
  service?: Partial<KiroStatus['service']>;
  imports?: Partial<KiroStatus['imports']>;
  login?: AccountLogin | null;
}): KiroStatus => ({
  engine: {
    source: 'managed',
    current: { commit: 'a1b2c3d4e5f67890', date: 1700000000000, title: 'init' },
    latest: null,
    updateAvailable: false,
    checkedAt: null,
    missingTools: [],
    build: { state: 'idle', step: null, error: null },
    adminUi: false,
    adminUiError: null,
    ...(over?.engine ?? {}),
  },
  service: { enabled: true, accounts: 0, running: 0, failed: 0, busySessions: 0, outdated: 0, items: [], ...(over?.service ?? {}) },
  imports: { kiroIde: true, kiroCli: true, ...(over?.imports ?? {}) },
  login: over?.login ?? null,
});

const acctEntry = (over: Partial<AccountEntry>): AccountEntry => ({
  id: 'default', label: '', name: 'cosyeey', plan: 'Pro', loggedIn: true, active: true, isDefault: true, ...over,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('cz-acct-groups-v2', JSON.stringify({ claude: true, agy: false }));
  calls = [];
  routes = {};
  vi.spyOn(accountPage, 'reload').mockImplementation(() => {});
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

  it('无引擎：显示说明与安装按钮；缺工具时列出工具、rustup 链接并禁用按钮', async () => {
    routes = {
      'GET /api/kiro': () => ({
        body: kiroStatusOf({ engine: { source: 'none', current: null, missingTools: ['git', 'cargo'] } }),
      }),
    };
    mount(<KiroAccountDialog onClose={noop} onDone={noop} onSwitch={noop} />);
    await flush();

    const dlg = document.querySelector('[role="dialog"]')!;
    expect(dlg.textContent).toContain('hank9999/kiro.rs');
    expect(dlg.textContent).toContain('缺少编译工具：git、cargo');
    expect(dlg.querySelector('a')?.getAttribute('href')).toBe('https://rustup.rs');
    expect(dlgBtn('安装引擎')?.disabled).toBe(true);
  });

  it('无引擎：点击安装触发 build、403 原样显示错误；编译中轮询 step 直到失败可重试、成功后进入登录表单', async () => {
    vi.useFakeTimers();
    let step = 0;
    routes = {
      'GET /api/kiro': () => {
        if (step === 0) return { body: kiroStatusOf({ engine: { source: 'none', current: null } }) };
        if (step === 1) {
          step = 2;
          return { body: kiroStatusOf({ engine: { source: 'none', current: null, build: { state: 'running', step: 'cargo build --release', error: null } } }) };
        }
        if (step === 2) {
          return { body: kiroStatusOf({ engine: { source: 'none', current: null, build: { state: 'failed', step: null, error: 'rustc 版本过低' } } }) };
        }
        return { body: kiroStatusOf({ engine: { source: 'managed' } }) };
      },
      'POST /api/kiro/engine/build': () => {
        if (step === 0) {
          step = 1;
          return { status: 403, body: { error: '仅允许本机连接编译 kiro.rs' } };
        }
        if (step === 1) {
          return { body: kiroStatusOf({ engine: { source: 'none', current: null, build: { state: 'running', step: 'git clone', error: null } } }) };
        }
        step = 3;
        return { body: kiroStatusOf({ engine: { source: 'none', current: null, build: { state: 'running', step: '编译中', error: null } } }) };
      },
    };
    try {
      mount(<KiroAccountDialog onClose={noop} onDone={noop} onSwitch={noop} />);
      await flush();

      // 第一次 build 403 → 原样显示错误
      click(dlgBtn('安装引擎')!);
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('仅允许本机连接编译 kiro.rs');

      // 第二次 build → running → 轮询 step → failed
      click(dlgBtn('安装引擎')!);
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('git clone');
      expect(dlgBtn('安装中…')?.disabled).toBe(true);

      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('cargo build --release');

      await act(async () => { vi.advanceTimersByTime(1000); });
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('rustc 版本过低');
      expect(dlgBtn('重试安装')?.disabled).toBe(false);

      // 重试安装 → 完成后进入登录表单
      click(dlgBtn('重试安装')!);
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
  it('Kiro 行显示标签、proxy 错误、kiroBalance 额度（不请求 Claude usage）、重新登录按钮，以及引擎更新入口', async () => {
    vi.useFakeTimers();
    const base = new Date(2026, 10, 24, 10, 0).getTime();
    vi.setSystemTime(base);
    let kiroSt = kiroStatusOf({
      engine: {
        current: { commit: '1234567890abcdef', date: base - 86400_000, title: 'old' },
        latest: { commit: 'fedcba0987654321', date: base, title: 'new release' },
        updateAvailable: true,
      },
    });
    const kiroOk = acctEntry({
      id: 'k1', label: 'Kiro 主号', name: 'Kiro 主号', plan: null, loggedIn: true, active: false, isDefault: false,
      subscribedAt: base, loginExpiresAt: base + 86400_000,
      kiro: { method: 'builderId', proxy: 'ready', error: null },
    });
    const kiroFail = acctEntry({
      id: 'k2', label: 'Kiro 异常', name: 'Kiro 异常', plan: null, loggedIn: true, active: false, isDefault: false,
      kiro: { method: 'apiKey', proxy: 'failed', error: '端口占用' },
    });
    routes = {
      'GET /api/accounts': () => ({ body: { mode: 'switch', list: [acctEntry({}), kiroOk, kiroFail], login: null } satisfies AccountList }),
      'GET /api/usage?account=default': () => ({ body: { at: base, limits: [] } }),
      'GET /api/kiro/balance?account=k1': () => ({
        body: { subscription: 'Kiro Pro', used: 120, limit: 500, resetsAt: base + 2 * 3_600_000 } satisfies KiroBalance,
      }),
      'GET /api/kiro/balance?account=k2': () => ({ status: 500, body: { error: 'boom' } }),
      'GET /api/kiro': () => ({ body: kiroSt }),
      'POST /api/kiro/engine/check': () => ({ body: kiroSt }),
      'POST /api/kiro/engine/build': () => {
        kiroSt = kiroStatusOf({
          engine: {
            current: { commit: '1234567890abcdef', date: base - 86400_000, title: 'old' },
            build: { state: 'running', step: '正在拉取源码', error: null },
          },
        });
        return { body: kiroSt };
      },
    };
    try {
      mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
      click(document.querySelector('[aria-label="账户菜单"]')!);
      await flush();

      // 只对 Claude 订阅账号请求 /api/usage，不对 Kiro 账号请求
      expect(calls.filter((c) => c.url.startsWith('/api/usage')).map((c) => c.url)).toEqual(['/api/usage?account=default']);
      expect(calls.filter((c) => c.url.startsWith('/api/kiro/balance')).map((c) => c.url).sort()).toEqual([
        '/api/kiro/balance?account=k1',
        '/api/kiro/balance?account=k2',
      ]);

      const rows = document.querySelectorAll('.cz-acct-row');
      // Kiro 主号：显示 Kiro 标签、used / limit 与重置时间、无日期行、操作按钮是「重新登录」
      expect(rows[1].querySelector('.cz-acct-chip')?.textContent).toBe('Kiro');
      expect(rows[1].textContent).toContain('120 / 500');
      expect(rows[1].textContent).toContain('2小时后重置');
      expect(rows[1].querySelector('.cz-acct-row__dates')).toBeNull();
      expect(rows[1].querySelector('[aria-label="重新登录"]')).not.toBeNull();
      expect(rows[1].querySelector('[aria-label="修改 API 账号与模型映射"]')).toBeNull();

      // Kiro 异常：显示 proxy failed error 与额度读取失败
      expect(rows[2].textContent).toContain('代理异常：端口占用');
      expect(rows[2].textContent).toContain('额度读取失败');

      // 引擎行：显示短 sha、有更新、更新、检查更新
      const eng = document.querySelector('.cz-kiro-eng')!;
      expect(eng.textContent).toContain('kiro.rs 引擎 1234567');
      expect(eng.textContent).toContain('有更新');

      const checkBtn = [...eng.querySelectorAll('button')].find((b) => b.textContent === '检查更新')!;
      click(checkBtn);
      await flush();
      expect(calls.some((c) => c.url === '/api/kiro/engine/check')).toBe(true);

      const updateBtn = [...eng.querySelectorAll('button')].find((b) => b.textContent === '更新')!;
      click(updateBtn);
      await flush();
      expect(calls.some((c) => c.url === '/api/kiro/engine/build')).toBe(true);
      expect(eng.textContent).toContain('正在拉取源码');

      // 点 Kiro 行的「重新登录」打开 KiroAccountDialog
      click(rows[1].querySelector('[aria-label="重新登录"]')!);
      await flush();
      expect(document.querySelector('[role="dialog"]')?.textContent).toContain('重新登录 Kiro：Kiro 主号');
    } finally {
      vi.useRealTimers();
    }
  });

  it('service.enabled=false 时引擎行显示「已停止」、outdated>0 显示重启提示，且对话框提示先到客户端「本机服务」启动', async () => {
    const kiroAcc = acctEntry({
      id: 'k1', label: 'Kiro 主号', name: 'Kiro 主号', plan: null, loggedIn: true, active: false, isDefault: false,
      kiro: { method: 'builderId', proxy: 'stopped', error: null },
    });
    routes = {
      'GET /api/accounts': () => ({ body: { mode: 'switch', list: [acctEntry({}), kiroAcc], login: null } satisfies AccountList }),
      'GET /api/usage?account=default': () => ({ body: { at: 1, limits: [] } }),
      'GET /api/kiro/balance?account=k1': () => ({ status: 500, body: { error: 'stopped' } }),
      'GET /api/kiro': () => ({
        body: kiroStatusOf({ service: { enabled: false, outdated: 2 } }),
      }),
    };
    mount(<AccountMenu account={{ name: 'cosyeey', plan: 'Pro' }} />);
    click(document.querySelector('[aria-label="账户菜单"]')!);
    await flush();

    const eng = document.querySelector('.cz-kiro-eng')!;
    expect(eng.textContent).toContain('已停止');
    expect(eng.textContent).toContain('2 个代理重启后用新版');
    // web 不提供启动 / 停止 / 重启按钮
    expect([...eng.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['检查更新']);

    // 打开 Kiro 对话框：提示先到客户端的「本机服务」启动
    click(document.querySelectorAll('.cz-acct-row')[1].querySelector('[aria-label="重新登录"]')!);
    await flush();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('本机服务');
  });
});
