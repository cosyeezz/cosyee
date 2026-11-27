// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionMeta, StopInfo, Turn } from '@cosyee/shared';
import { ConversationView, type ConversationViewProps } from './ConversationView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

function makeTurn(id: string, overrides: Partial<Turn> = {}): Turn {
  const start = Date.now();
  return {
    id,
    userText: `问题 ${id}`,
    attachments: [],
    status: 'done',
    statusText: '',
    steps: [],
    answer: '',
    subagents: [],
    startedAt: start,
    endedAt: start + 1000,
    ...overrides,
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

async function mount(props: ConversationViewProps) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<ConversationView {...props} />));
}

const interruptedStop: StopInfo = {
  kind: 'interrupted',
  state: 'stopped',
  attempts: 0,
  reason: '服务重启，这一轮没有执行完',
  at: Date.now(),
};

describe('ConversationView：StopNotice 与重启中断展示', () => {
  it('最后一轮 done + interrupted stop：显示提示条与重试按钮，且该轮按「已中断」展示（不改原对象）', async () => {
    const prevTurn = makeTurn('t1', { status: 'done', answer: '上一轮回答' });
    const lastTurn = makeTurn('t2', { status: 'done', answer: '' });
    const onRetryNow = vi.fn();

    await mount({ turns: [prevTurn, lastTurn], stop: interruptedStop, onRetryNow });

    const items = host!.querySelectorAll<HTMLElement>('.cz-flow__item');
    expect(items.length).toBe(2);

    // 上一轮保持已完成，无停止提示条
    expect(items[0].querySelector('.cz-flow__turn.is-done')).not.toBeNull();
    expect(items[0].querySelector('.cz-flow__stop')).toBeNull();

    // 最后一轮展示为已中断（含「服务重启中断」），且不篡改 reducer 的 turn 对象
    expect(items[1].querySelector('.cz-flow__turn.is-interrupted')).not.toBeNull();
    expect(items[1].querySelector('.cz-flow__status-main')?.textContent).toBe('已中断');
    expect(items[1].querySelector('.cz-st-meta')?.textContent).toContain('服务重启中断');
    expect(lastTurn.status).toBe('done');
    expect(lastTurn.reason).toBeUndefined();

    // 显示停止提示条与重试按钮
    const stopEl = items[1].querySelector('.cz-flow__stop');
    expect(stopEl).not.toBeNull();
    expect(stopEl?.textContent).toContain('服务重启，这一轮没有执行完');
    const retryBtn = stopEl!.querySelector<HTMLButtonElement>('button');
    expect(retryBtn?.textContent).toBe('重试');
    await act(async () => void retryBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onRetryNow).toHaveBeenCalledTimes(1);
  });

  it('最后一轮为 interrupted / error + interrupted stop：同样显示提示条', async () => {
    for (const status of ['interrupted', 'error'] as const) {
      const turn = makeTurn(`t-${status}`, { status, reason: '原原因' });
      await mount({ turns: [turn], stop: interruptedStop, onRetryNow: vi.fn() });
      expect(host!.querySelector('.cz-flow__stop')).not.toBeNull();
      expect(host!.querySelector(`.cz-flow__turn.is-${status}`)).not.toBeNull();
      act(() => root?.unmount());
      host?.remove();
      root = host = null;
    }
  });

  it('最后一轮仍在执行（understanding / running）+ interrupted stop：不显示提示条', async () => {
    for (const status of ['understanding', 'running'] as const) {
      const turn = makeTurn(`t-${status}`, { status, endedAt: undefined });
      await mount({ turns: [turn], stop: interruptedStop, onRetryNow: vi.fn() });
      expect(host!.querySelector('.cz-flow__stop')).toBeNull();
      expect(host!.querySelector(`.cz-flow__turn.is-${status}`)).not.toBeNull();
      act(() => root?.unmount());
      host?.remove();
      root = host = null;
    }
  });

  it('最后一轮 done + 非 interrupted stop：不显示提示条', async () => {
    const turn = makeTurn('t-fatal', { status: 'done' });
    const fatalStop: StopInfo = {
      kind: 'fatal',
      state: 'stopped',
      attempts: 0,
      reason: 'Prompt is too long',
      at: Date.now(),
    };
    await mount({ turns: [turn], stop: fatalStop, onRetryNow: vi.fn() });
    expect(host!.querySelector('.cz-flow__stop')).toBeNull();
    expect(host!.querySelector('.cz-flow__turn.is-done')).not.toBeNull();
  });
});

describe('ConversationView：模型切换与上下文压缩分隔提示', () => {
  it('未传 meta 时不渲染任何分隔提示', async () => {
    await mount({ turns: [makeTurn('t0'), makeTurn('t1')] });
    expect(host!.querySelectorAll('[role="separator"]')).toHaveLength(0);
  });

  it('在正确位置渲染模型切换、手动 /compact（隐藏轮）与末尾压缩（位于 footer 之前）', async () => {
    const turns = [
      makeTurn('t0', { answer: '第一轮答复' }),
      makeTurn('t1', { local: true, userText: '/compact', answer: '' }), // 隐藏轮
      makeTurn('t2', { answer: '第二轮答复' }),
      makeTurn('t3', { local: true, userText: '/compact', answer: '' }), // 末尾隐藏轮
    ];
    const meta: SessionMeta = {
      cache: [
        { id: 'm0', turn: 0, input: 100, create: 0, read: 0, rate: 0, model: 'claude-opus-4-6' },
        { id: 'm1', turn: 2, input: 100, create: 0, read: 0, rate: 0, model: 'claude-sonnet-4-6' },
      ],
      compactions: [
        {
          id: 'c1',
          turn: 1,
          trigger: 'manual',
          pre: 120_400,
          post: 18_200,
          durationMs: 9_000,
          after: 'm0',
          at: Date.now() - 60_000,
        },
        {
          id: 'c2',
          turn: 3,
          trigger: 'manual',
          pre: 80_000,
          post: null,
          durationMs: null,
          after: 'm1',
          at: Date.now(),
        },
      ],
    };

    await mount({
      turns,
      meta,
      footer: <div className="test-footer">footer</div>,
    });

    const col = host!.querySelector('.cz-flow__column')!;
    const seq = Array.from(col.children).map((el) => {
      if (el.classList.contains('cz-flow__item')) return `turn:${el.getAttribute('data-turn-id')}`;
      if (el.getAttribute('role') === 'separator') return `sep:${el.textContent}`;
      if (el.classList.contains('test-footer')) return 'footer';
      return el.className;
    });

    expect(seq).toEqual([
      'turn:t0',
      'sep:已压缩上下文 · 120k → 18k · 9 秒',
      'sep:已切换到 Sonnet 4.6',
      'turn:t2',
      'sep:已压缩上下文 · 80k',
      'footer',
    ]);
  });

  it('轮中途自动压缩渲染在该轮之后', async () => {
    const turns = [makeTurn('t0', { answer: '第一轮' }), makeTurn('t1', { answer: '第二轮' })];
    const meta: SessionMeta = {
      cache: [
        { id: 'm0', turn: 0, input: 100, create: 0, read: 0, rate: 0, model: 'claude-sonnet-4-6' },
        { id: 'm1', turn: 0, input: 100, create: 0, read: 0, rate: 0, model: 'claude-sonnet-4-6' },
      ],
      compactions: [
        {
          id: 'c-auto',
          turn: 0,
          trigger: 'auto',
          pre: 182_000,
          post: 24_000,
          durationMs: 12_000,
          after: 'm0',
          at: Date.now(),
        },
      ],
    };

    await mount({ turns, meta });

    const col = host!.querySelector('.cz-flow__column')!;
    const seq = Array.from(col.children).map((el) =>
      el.classList.contains('cz-flow__item')
        ? `turn:${el.getAttribute('data-turn-id')}`
        : `sep:${el.textContent}`,
    );

    expect(seq).toEqual([
      'turn:t0',
      'sep:已自动压缩上下文 · 182k → 24k · 12 秒',
      'turn:t1',
    ]);
  });
});
