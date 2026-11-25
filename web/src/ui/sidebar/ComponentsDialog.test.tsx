// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComponentId, ComponentList, ComponentStatus } from '@cosyee/shared';
import { ComponentsDialog, componentStatusLabel } from './ComponentsDialog';

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
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
};
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

const card = (id: ComponentId) => document.querySelector<HTMLElement>(`[data-component="${id}"]`)!;
const btn = (id: ComponentId, text: string) =>
  [...card(id).querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === text);
const sw = (id: ComponentId) => card(id).querySelector<HTMLButtonElement>('[role="switch"]')!;

interface Call { method: string; url: string }
let calls: Call[];
let routes: Record<string, () => { status?: number; body: unknown }>;
let remote = false;

const NOW = Date.UTC(2026, 10, 25, 12, 0, 0);
const status = (id: ComponentId, over: Partial<ComponentStatus> = {}): ComponentStatus => ({
  id,
  name: { claude: 'Claude CLI', kiro: 'kiro.rs', agy: 'Antigravity CLI', server: 'Cosyee 服务端' }[id],
  installed: true,
  custom: false,
  version: '1.0.0',
  latest: '1.0.0',
  updateAvailable: false,
  checkedAt: NOW - 3 * 3_600_000,
  checkError: null,
  autoUpdate: true,
  busy: 0,
  pending: false,
  updatedBy: id === 'server' ? 'client' : 'server',
  job: null,
  ...over,
});

const listOf = (...items: ComponentStatus[]): ComponentList => ({ list: items });
const fourItems = (): ComponentList => listOf(
  status('claude', { version: '2.1.330', latest: '2.1.340', updateAvailable: true, pending: true, busy: 1 }),
  status('kiro', { latest: '1.1.0', updateAvailable: true }),
  status('agy', { installed: false, version: null, latest: null, checkedAt: null }),
  status('server', { custom: true }),
);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  calls = [];
  remote = false;
  routes = { 'GET /api/components': () => ({ body: fourItems() }) };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    const r = url === '/api/bootstrap'
      ? { body: { remote } }
      : routes[`${method} ${url}`]?.() ?? { status: 404, body: { error: 'not found' } };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function open() {
  mount(<ComponentsDialog onClose={() => {}} />);
  await flush();
}
const posts = () => calls.filter((c) => c.method === 'POST').map((c) => `${c.method} ${c.url}`);

describe('ComponentsDialog', () => {
  it('渲染四个组件的版本、检查时间和状态', async () => {
    await open();
    expect(document.querySelectorAll('[data-component]').length).toBe(4);
    expect(card('claude').textContent).toContain('Claude CLI');
    expect(card('claude').textContent).toContain('2.1.330');
    expect(card('claude').textContent).toContain('2.1.340');
    expect(card('claude').textContent).toContain('3 小时前');
    expect(card('claude').textContent).toContain('有新版本，等任务结束后自动更新');
    expect(card('kiro').querySelector('[data-role="status"]')!.textContent).toBe('有新版本');
    expect(card('agy').querySelector('[data-role="status"]')!.textContent).toBe('未安装');
    expect(card('agy').textContent).toContain('还没检查过');
    expect(card('server').textContent).toContain('自定义路径，不自动更新');
    expect(document.body.textContent).not.toContain('仅本机可操作');
  });

  it('状态文案：已是最新、检查失败、更新中、更新失败', () => {
    expect(componentStatusLabel(status('kiro')).text).toBe('已是最新');
    expect(componentStatusLabel(status('kiro', { latest: null, checkError: 'network' })).text).toBe('检查失败');
    expect(componentStatusLabel(status('kiro', { job: { kind: 'update', state: 'running', error: null } })).text).toBe('正在更新…');
    expect(componentStatusLabel(status('kiro', { job: { kind: 'update', state: 'failed', error: 'boom' } })).text).toBe('更新失败');
  });

  it('显示检查失败与更新失败的原因', async () => {
    routes['GET /api/components'] = () => ({
      body: listOf(
        status('claude', { latest: null, checkError: '连不上 npm' }),
        status('kiro', { job: { kind: 'update', state: 'failed', error: '磁盘已满' } }),
      ),
    });
    await open();
    expect(card('claude').textContent).toContain('检查失败：连不上 npm');
    expect(card('kiro').textContent).toContain('更新失败：磁盘已满');
  });

  it('点「检查更新」调用对应的 check 接口并刷新该项', async () => {
    routes['POST /api/components/kiro/check'] = () => ({ body: status('kiro', { latest: '1.2.0', updateAvailable: true }) });
    await open();
    await click(btn('kiro', '检查更新')!);
    await flush();
    expect(posts()).toEqual(['POST /api/components/kiro/check']);
    expect(card('kiro').textContent).toContain('1.2.0');
  });

  it('点「立即更新」调用 update 接口；没有新版本时按钮置灰', async () => {
    routes['POST /api/components/kiro/update'] = () => ({
      body: status('kiro', { updateAvailable: true, job: { kind: 'update', state: 'running', error: null } }),
    });
    await open();
    expect(btn('agy', '立即更新')!.disabled).toBe(true);
    await click(btn('kiro', '立即更新')!);
    await flush();
    expect(posts()).toEqual(['POST /api/components/kiro/update']);
    expect(card('kiro').querySelector('[data-role="status"]')!.textContent).toBe('正在更新…');
    expect(btn('kiro', '立即更新')!.disabled).toBe(true);
  });

  it('更新进行中轮询状态并显示日志', async () => {
    const running = status('kiro', { updateAvailable: true, job: { kind: 'update', state: 'running', error: null } });
    routes['GET /api/components'] = () => ({ body: listOf(running) });
    routes['GET /api/components/kiro/log?from=0'] = () => ({ body: { lines: ['下载 kiro.rs', '校验 SHA256'], next: 2 } });
    mount(<ComponentsDialog onClose={() => {}} />);
    await flush();
    await act(async () => { await new Promise((r) => setTimeout(r, 1150)); });
    await flush();
    expect(card('kiro').querySelector('.cz-comp__log')!.textContent).toBe('下载 kiro.rs\n校验 SHA256');
  });

  it('自动更新开关调用 auto 接口，关闭 / 打开传 enabled=0 / 1', async () => {
    routes['POST /api/components/claude/auto?enabled=0'] = () => ({ body: status('claude', { autoUpdate: false }) });
    routes['POST /api/components/claude/auto?enabled=1'] = () => ({ body: status('claude', { autoUpdate: true }) });
    await open();
    expect(sw('claude').getAttribute('aria-checked')).toBe('true');
    await click(sw('claude'));
    await flush();
    expect(sw('claude').getAttribute('aria-checked')).toBe('false');
    await click(sw('claude'));
    await flush();
    expect(sw('claude').getAttribute('aria-checked')).toBe('true');
    expect(posts()).toEqual([
      'POST /api/components/claude/auto?enabled=0',
      'POST /api/components/claude/auto?enabled=1',
    ]);
  });

  it('服务端返回错误时显示在该组件下', async () => {
    routes['POST /api/components/kiro/update'] = () => ({ status: 409, body: { error: '组件正忙' } });
    await open();
    await click(btn('kiro', '立即更新')!);
    await flush();
    expect(card('kiro').querySelector('[role="alert"]')!.textContent).toBe('组件正忙');
  });

  it('非本机连接：写操作全部置灰并提示「仅本机可操作」', async () => {
    remote = true;
    await open();
    expect(document.body.textContent).toContain('仅本机可操作');
    for (const id of ['claude', 'kiro', 'agy', 'server'] as const) {
      expect(btn(id, '检查更新')!.disabled).toBe(true);
      expect(sw(id).disabled).toBe(true);
    }
    expect(btn('kiro', '立即更新')!.disabled).toBe(true);
    await click(btn('kiro', '检查更新')!);
    expect(posts()).toEqual([]);
  });

  it('server 项显示「由桌面客户端更新」，没有立即更新按钮', async () => {
    routes['GET /api/components'] = () => ({
      body: listOf(status('server', { version: '0.9.0', latest: '0.9.1', updateAvailable: true })),
    });
    await open();
    expect(card('server').textContent).toContain('由桌面客户端更新');
    expect(btn('server', '立即更新')).toBeUndefined();
    expect(btn('server', '检查更新')).toBeDefined();
  });
});
