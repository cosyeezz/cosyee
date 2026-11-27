// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AccountLogin } from '@cosyee/shared';
import { CodexAccountDialog } from './CodexAccountDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

interface Call { method: string; url: string; body: unknown }
let calls: Call[];
let routes: Record<string, (body: unknown) => { status?: number; body: unknown }>;

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

const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

const dlg = () => document.querySelector<HTMLElement>('[role="dialog"]')!;
const radioBy = (method: string) => dlg().querySelector<HTMLButtonElement>(`[role="radio"][data-method="${method}"]`)!;
const btnBy = (text: string) => [...dlg().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text)!;

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
  routes = {};
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CodexAccountDialog', () => {
  it('本机访问默认选浏览器登录；远程访问默认选设备码登录，切到浏览器登录时显示本机回调提醒', () => {
    mount(<CodexAccountDialog remote={false} onClose={vi.fn()} onDone={vi.fn()} onSwitch={vi.fn()} />);
    expect(radioBy('chatgpt').getAttribute('aria-checked')).toBe('true');
    expect(radioBy('deviceAuth').getAttribute('aria-checked')).toBe('false');
    expect(dlg().textContent).not.toContain('需在运行 Cosyee 的电脑上打开');

    act(() => root!.unmount());
    mount(<CodexAccountDialog remote onClose={vi.fn()} onDone={vi.fn()} onSwitch={vi.fn()} />);
    expect(radioBy('deviceAuth').getAttribute('aria-checked')).toBe('true');
    expect(radioBy('chatgpt').getAttribute('aria-checked')).toBe('false');

    click(radioBy('chatgpt'));
    expect(radioBy('chatgpt').getAttribute('aria-checked')).toBe('true');
    expect(dlg().textContent).toContain('需在运行 Cosyee 的电脑上打开浏览器完成回调（127.0.0.1:1455）');
  });

  it('设备码登录：展示验证码与安全设置提示，轮询完成后触发 onDone 并提供切换按钮', async () => {
    const onDone = vi.fn();
    const onSwitch = vi.fn();
    let pollCount = 0;
    routes['POST /api/codex-accounts/login'] = () => ({
      body: {
        loginId: 'cx-1',
        method: 'deviceAuth',
        status: 'waiting',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'ABCD-5678',
        accountId: null,
        error: null,
      } satisfies AccountLogin,
    });
    routes['GET /api/codex-accounts/login/cx-1'] = () => {
      pollCount += 1;
      if (pollCount === 1) return { status: 500, body: { error: '瞬时网络抖动' } };
      return {
        body: {
          loginId: 'cx-1',
          method: 'deviceAuth',
          status: 'done',
          url: null,
          accountId: 'codex-2',
          error: null,
        } satisfies AccountLogin,
      };
    };

    mount(<CodexAccountDialog remote onClose={vi.fn()} onDone={onDone} onSwitch={onSwitch} />);
    const labelInput = dlg().querySelector<HTMLInputElement>('input[placeholder*="工作"]')!;
    type(labelInput, '团队号');
    click(btnBy('登录'));
    await flush();

    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/codex-accounts/login',
      body: { method: 'deviceAuth', label: '团队号' },
    });
    expect(dlg().querySelector('.cz-kiro-code__val')?.textContent).toBe('ABCD-5678');
    expect(dlg().textContent).toContain('若提示未开启设备码登录，请在 ChatGPT 设置 → 安全 中开启');
    expect(dlg().querySelector<HTMLAnchorElement>('a[href="https://auth.openai.com/codex/device"]')?.textContent).toBe('打开验证页');

    // 第 1 次轮询 500 → 显示瞬时提示并继续轮询
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(dlg().textContent).toContain('读取登录进度失败：瞬时网络抖动');

    // 第 2 次轮询 done → 清除瞬时提示并回调 onDone
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(onDone).toHaveBeenCalledWith('codex-2');
    expect(dlg().textContent).toContain('登录成功');
    expect(dlg().textContent).not.toContain('瞬时网络抖动');

    click(btnBy('用于新的委派任务'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(onSwitch).toHaveBeenCalledWith('codex-2');
  });

  it('API Key 登录：密码框输入，提交后立即清空 state，成功直接进入 done', async () => {
    const onDone = vi.fn();
    let resolveReq!: (v: { status?: number; body: unknown }) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      const r = await new Promise<{ status?: number; body: unknown }>((res) => { resolveReq = res; });
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
    }));

    mount(<CodexAccountDialog onClose={vi.fn()} onDone={onDone} onSwitch={vi.fn()} />);
    click(radioBy('apiKey'));
    const keyInput = dlg().querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(keyInput).toBeTruthy();
    expect(btnBy('添加').disabled).toBe(true);

    type(keyInput, 'sk-test-secret-123');
    expect(btnBy('添加').disabled).toBe(false);

    click(btnBy('添加'));
    // 提交瞬间即清空输入值，不等请求返回
    expect(keyInput.value).toBe('');
    expect(calls[0]).toEqual({
      method: 'POST',
      url: '/api/codex-accounts/login',
      body: { method: 'apiKey', label: '', apiKey: 'sk-test-secret-123' },
    });

    resolveReq({
      body: { loginId: 'cx-api', method: 'apiKey', status: 'done', url: null, accountId: 'codex-api-1', error: null },
    });
    await flush();
    expect(onDone).toHaveBeenCalledWith('codex-api-1');
    expect(dlg().textContent).toContain('登录成功');
  });

  it('进行中点取消调用 cancel 接口；轮询 404 进入失败态并可重试', async () => {
    const onClose = vi.fn();
    routes['POST /api/codex-accounts/login'] = () => ({
      body: { loginId: 'cx-2', method: 'chatgpt', status: 'waiting', url: 'https://auth.openai.com/oauth', accountId: null, error: null },
    });
    routes['POST /api/codex-accounts/login/cx-2/cancel'] = () => ({ body: { ok: true } });

    mount(<CodexAccountDialog onClose={onClose} onDone={vi.fn()} onSwitch={vi.fn()} />);
    click(btnBy('登录'));
    await flush();
    click(btnBy('取消'));
    await act(async () => { vi.advanceTimersByTime(500); });
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/codex-accounts/login/cx-2/cancel')).toBe(true);
    expect(onClose).toHaveBeenCalled();

    // 404 失败态 + 重试
    act(() => root!.unmount());
    routes['GET /api/codex-accounts/login/cx-2'] = () => ({ status: 404, body: { error: '登录已过期' } });
    mount(
      <CodexAccountDialog
        relogin={{ id: 'codex-1', title: '主力 Pro', active: true }}
        resume={{ loginId: 'cx-2', method: 'chatgpt', status: 'waiting', url: 'https://auth.openai.com/oauth', accountId: 'codex-1', error: null }}
        onClose={vi.fn()}
        onDone={vi.fn()}
        onSwitch={vi.fn()}
      />,
    );
    await act(async () => { vi.advanceTimersByTime(1000); });
    await flush();
    expect(dlg().textContent).toContain('登录失败：登录已过期');

    click(btnBy('重试'));
    await flush();
    expect(dlg().querySelector('[role="radiogroup"]')).toBeTruthy();
    // relogin 模式下不显示备注名输入框
    expect(dlg().querySelector('input[placeholder*="工作"]')).toBeNull();
  });
});
