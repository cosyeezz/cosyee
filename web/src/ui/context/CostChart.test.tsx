// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BUILTIN_PRICES, type CachePoint } from '@cosyee/shared';
import { CostChart } from './CostChart';
import { requestCostRows } from './usageStats';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

function render(node: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

describe('CostChart (mode="request")', () => {
  it('每个请求一根柱，悬停提示显示「第 N 次请求」，不含主线程字样，estimated 点标明估算', () => {
    const points: CachePoint[] = [
      { id: 'r1', turn: 0, input: 100_000, create: 0, read: 0, rate: 0, output: 1000, model: 'gemini-4-neon', estimated: true },
      { id: 'r2', turn: 0, input: 10_000, create: 0, read: 90_000, rate: 90, output: 1000, model: 'gemini-4-neon' },
    ];
    const { rows, estimated } = requestCostRows(points, BUILTIN_PRICES);
    const el = render(<CostChart mode="request" turns={rows} estimated={estimated} />);

    const cols = el.querySelectorAll('.cz-ctx__cost-col');
    expect(cols).toHaveLength(2);

    const svg = el.querySelector('svg')!;
    // 用键盘 Home 选中第 1 次请求（estimated: true）
    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    });
    const tip1 = el.querySelector('[data-testid="cost-tip"]')!;
    expect(tip1.textContent).toContain('第 1 次请求');
    expect(tip1.textContent).not.toContain('主线程');
    expect(tip1.textContent).not.toContain('第 1 轮');
    expect(tip1.textContent).toContain('拆分按本轮合计估算');

    // ArrowRight 选中第 2 次请求（非估算）
    act(() => {
      svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    const tip2 = el.querySelector('[data-testid="cost-tip"]')!;
    expect(tip2.textContent).toContain('第 2 次请求');
    expect(tip2.textContent).not.toContain('拆分按本轮合计估算');
  });
});
