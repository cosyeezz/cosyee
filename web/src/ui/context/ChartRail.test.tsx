// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BUILTIN_PRICES, type CachePoint, type ContextUsage } from '@cosyee/shared';
import { ChartRail, type ChartRailProps } from './ChartRail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const usage = {
  percent: 55, usedTokens: 82_300, totalTokens: 150_000,
  categories: [
    { name: 'System prompt', tokens: 3_000 },
    { name: 'Messages', tokens: 79_300 },
    { name: 'Free space', tokens: 67_700 },
  ],
} as unknown as ContextUsage;

const pt = (i: number): CachePoint => ({ id: 'm' + i, turn: i, read: 1000 * i, create: 500, input: 10, rate: 50 });

function render(p: Partial<ChartRailProps>) {
  const props: ChartRailProps = { open: true, cache: [pt(0), pt(1)], turns: [], pricing: BUILTIN_PRICES, ...p };
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(<ChartRail {...props} />));
  return host;
}

describe('ChartRail', () => {
  it('显示上下文走势、缓存命中率、花费三张图', () => {
    const el = render({});
    const titles = [...el.querySelectorAll('.cz-crail__card > h3')].map((h) => h.textContent);
    expect(titles).toEqual(['上下文走势', '缓存命中率', '花费']);
    expect(el.querySelector('.cz-ctx__ctx-svg')).not.toBeNull();
    expect(el.querySelector('.cz-ctx__cache-svg')).not.toBeNull();
    expect(el.querySelector('[data-testid="crail-cost"]')).not.toBeNull();
  });

  it('订阅账号的花费标题写明是等价 API 价格', () => {
    const el = render({ billing: 'subscription' });
    expect(el.querySelectorAll('.cz-crail__card > h3')[2]!.textContent).toBe('花费（等价 API 价格）');
  });

  it('有占用数据时最上面是占用：百分比、已用 / 总量、分段条', () => {
    const el = render({ usage });
    const first = el.querySelector('.cz-crail__card')!;
    expect(first.getAttribute('aria-label')).toBe('上下文占用');
    expect(first.querySelector('.cz-crail__percent')!.textContent).toBe('55%');
    expect(first.querySelector('.cz-crail__used')!.textContent).toBe('82.3k / 150k');
    expect(first.querySelectorAll('.cz-ctx__seg')).toHaveLength(3);
  });

  it('只有占用、还没有请求数据时只显示占用', () => {
    const el = render({ usage, cache: [] });
    expect(el.querySelectorAll('.cz-crail__card')).toHaveLength(1);
  });

  it('上下文栏展开或什么数据都没有时不显示', () => {
    expect(render({ open: false, usage }).querySelector('.cz-crail')).toBeNull();
    expect(render({ open: true, cache: [] }).querySelector('.cz-crail')).toBeNull();
    expect(render({ open: true, cache: undefined }).querySelector('.cz-crail')).toBeNull();
  });
});
