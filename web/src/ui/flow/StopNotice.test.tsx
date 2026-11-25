// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { StopInfo } from '@cosyee/shared';
import { StopNotice, type StopNoticeProps } from './StopNotice';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

async function mount(props: StopNoticeProps) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<StopNotice {...props} />));
}

const click = async (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const buttons = () => [...host!.querySelectorAll<HTMLButtonElement>('button')];

describe('StopNotice', () => {
  it('waiting（rate_limit）：显示时间与两个按钮，点击触发对应回调', async () => {
    const now = new Date(2026, 10, 24, 14, 0).getTime();
    const retryAt = new Date(2026, 10, 24, 21, 5).getTime();
    const onRetryNow = vi.fn();
    const onRetryCancel = vi.fn();
    const stop: StopInfo = {
      kind: 'rate_limit',
      reason: "You've hit your 5-hour limit · resets 9pm",
      retryAt,
      attempts: 0,
      state: 'waiting',
      at: now,
    };

    await mount({ stop, onRetryNow, onRetryCancel, now });
    expect(host!.textContent).toContain('已达额度上限 · 21:05 自动重试');
    expect(host!.querySelector('.cz-flow__stop-text')?.getAttribute('title')).toBe(stop.reason);

    const btns = buttons();
    expect(btns.map((b) => b.textContent)).toEqual(['立即重试', '取消']);
    await click(btns[0]);
    await click(btns[1]);
    expect(onRetryNow).toHaveBeenCalledTimes(1);
    expect(onRetryCancel).toHaveBeenCalledTimes(1);
  });

  it('waiting（跨天 + transient）：显示 M月D日 HH:mm 与重试次数', async () => {
    const now = new Date(2026, 10, 24, 23, 50).getTime();
    const retryAt = new Date(2026, 10, 25, 0, 15).getTime();
    const stop: StopInfo = {
      kind: 'transient',
      reason: 'API Error: 529 overloaded',
      retryAt,
      attempts: 1,
      state: 'waiting',
      at: now,
    };

    await mount({ stop, onRetryNow: vi.fn(), onRetryCancel: vi.fn(), now });
    expect(host!.textContent).toContain('请求异常中断 · 11月25日 00:15 自动重试（第 2 次）');
  });

  it('stopped：显示原因（title 为全文）与「重试」按钮', async () => {
    const onRetryNow = vi.fn();
    const stop: StopInfo = {
      kind: 'fatal',
      reason: 'Prompt is too long\n请压缩上下文后重试',
      attempts: 0,
      state: 'stopped',
      at: Date.now(),
    };

    await mount({ stop, onRetryNow, onRetryCancel: vi.fn() });
    const textEl = host!.querySelector('.cz-flow__stop-text')!;
    expect(textEl.textContent).toBe('Prompt is too long 请压缩上下文后重试');
    expect(textEl.getAttribute('title')).toBe(stop.reason);
    const btns = buttons();
    expect(btns.map((b) => b.textContent)).toEqual(['重试']);
    await click(btns[0]);
    expect(onRetryNow).toHaveBeenCalledTimes(1);
  });

  it('gave_up：显示多次自动重试失败 + 原因 + 重试按钮', async () => {
    const stop: StopInfo = {
      kind: 'transient',
      reason: '503 Service Unavailable',
      attempts: 3,
      state: 'gave_up',
      at: Date.now(),
    };

    await mount({ stop, onRetryNow: vi.fn() });
    expect(host!.textContent).toContain('多次自动重试失败 · 503 Service Unavailable');
    expect(buttons().map((b) => b.textContent)).toEqual(['重试']);
  });

  it('retrying：不渲染', async () => {
    const stop: StopInfo = {
      kind: 'rate_limit',
      reason: 'limit',
      attempts: 1,
      state: 'retrying',
      at: Date.now(),
    };

    await mount({ stop, onRetryNow: vi.fn(), onRetryCancel: vi.fn() });
    expect(host!.innerHTML).toBe('');
  });

  it('stopped（interrupted）：显示重启中断文案与「重试」按钮，点击触发 onRetryNow', async () => {
    const onRetryNow = vi.fn();
    const stop: StopInfo = {
      kind: 'interrupted',
      reason: '服务重启，这一轮没有执行完',
      attempts: 0,
      state: 'stopped',
      at: Date.now(),
    };

    await mount({ stop, onRetryNow, onRetryCancel: vi.fn() });
    expect(host!.querySelector('.cz-flow__stop.is-stopped.is-interrupted')).not.toBeNull();
    expect(host!.querySelector('.cz-flow__stop-text')?.textContent).toBe('服务重启，这一轮没有执行完');
    const btns = buttons();
    expect(btns.map((b) => b.textContent)).toEqual(['重试']);
    await click(btns[0]);
    expect(onRetryNow).toHaveBeenCalledTimes(1);
  });

  it('stopped（interrupted 无 reason）：兜底显示默认重启中断文案', async () => {
    const stop: StopInfo = {
      kind: 'interrupted',
      reason: '   ',
      attempts: 0,
      state: 'stopped',
      at: Date.now(),
    };

    await mount({ stop, onRetryNow: vi.fn() });
    expect(host!.querySelector('.cz-flow__stop-text')?.textContent).toBe('服务重启，这一轮没有执行完');
  });

  it('waiting（interrupted）：沿用 transient 的异常中断自动重试文案', async () => {
    const now = new Date(2026, 10, 24, 14, 0).getTime();
    const retryAt = new Date(2026, 10, 24, 14, 5).getTime();
    const stop: StopInfo = {
      kind: 'interrupted',
      reason: '服务重启',
      retryAt,
      attempts: 0,
      state: 'waiting',
      at: now,
    };

    await mount({ stop, onRetryNow: vi.fn(), onRetryCancel: vi.fn(), now });
    expect(host!.textContent).toContain('请求异常中断 · 14:05 自动重试（第 1 次）');
  });
});
