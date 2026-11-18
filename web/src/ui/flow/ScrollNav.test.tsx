// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ScrollNav } from './ScrollNav';
import { DOUBLE_CLICK_MS, FADE_OUT_MS, POINT_MARGIN } from './navPoints';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAX = 2000;
let root: Root | null = null;
let host: HTMLElement | null = null;

/** 可滚动的假容器：scrollTop 可写，scrollTo 记录调用，两个回合的答复在内容坐标 300 / 900 处 */
function setup(startTop = 500) {
  host = document.createElement('div');
  document.body.appendChild(host);
  const sc = document.createElement('div');
  let top = startTop;
  Object.defineProperty(sc, 'scrollTop', { get: () => top, set: (v: number) => void (top = v), configurable: true });
  Object.defineProperty(sc, 'scrollHeight', { value: MAX + 600, configurable: true });
  Object.defineProperty(sc, 'clientHeight', { value: 600, configurable: true });
  const rect = (t: number) => ({ top: t, bottom: t + 20, left: 0, right: 0, width: 0, height: 20, x: 0, y: t, toJSON: () => ({}) }) as DOMRect;
  sc.getBoundingClientRect = () => rect(0);
  for (const y of [300, 900]) {
    const turn = document.createElement('div');
    turn.className = 'cz-flow__turn is-done';
    const a = document.createElement('div');
    a.className = 'cz-flow__answer';
    a.getBoundingClientRect = () => rect(y - top);
    turn.appendChild(a);
    sc.appendChild(turn);
  }
  const scrollTo = vi.fn((o: ScrollToOptions) => {
    if (typeof o.top === 'number') top = o.top;
  });
  (sc as unknown as { scrollTo: unknown }).scrollTo = scrollTo;
  document.body.appendChild(sc);

  const onJumpBottom = vi.fn();
  root = createRoot(host);
  act(() => root!.render(<ScrollNav scrollRef={{ current: sc }} onJumpBottom={onJumpBottom} />));

  const btn = (dir: 'top' | 'bottom') => host!.querySelector(`.cz-flow__nav--${dir}`) as HTMLButtonElement;
  return {
    sc,
    scrollTo,
    onJumpBottom,
    up: () => btn('top'),
    down: () => btn('bottom'),
    scrollTo_: (v: number) =>
      act(() => {
        top = v;
        sc.dispatchEvent(new Event('scroll'));
      }),
    wait: (ms: number) => act(() => void vi.advanceTimersByTime(ms)),
    click: (b: HTMLButtonElement) => act(() => b.click()),
    visible: (b: HTMLButtonElement) => b.classList.contains('is-visible'),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.body.innerHTML = '';
  root = host = null;
  vi.useRealTimers();
});

describe('ScrollNav 显示 / 淡出', () => {
  it('平时隐藏；aria-label 说明单击与双击', () => {
    const v = setup();
    expect(v.visible(v.up())).toBe(false);
    expect(v.visible(v.down())).toBe(false);
    expect(v.up().getAttribute('aria-label')).toBe('上一个交付点（双击回到顶部）');
    expect(v.down().getAttribute('aria-label')).toBe('下一个交付点（双击回到底部）');
    expect(v.up().getAttribute('aria-hidden')).toBe('true');
  });

  it('向上滚显示顶部按钮，向下滚显示底部按钮', () => {
    const v = setup(500);
    v.scrollTo_(300);
    expect(v.visible(v.up())).toBe(true);
    expect(v.visible(v.down())).toBe(false);
    expect(v.up().hasAttribute('aria-hidden')).toBe(false);
    v.scrollTo_(700);
    expect(v.visible(v.up())).toBe(false);
    expect(v.visible(v.down())).toBe(true);
  });

  it('停止滚动约 1.5 秒后淡出；继续滚动会重新计时', () => {
    const v = setup(500);
    v.scrollTo_(300);
    v.wait(FADE_OUT_MS - 100);
    expect(v.visible(v.up())).toBe(true);
    v.scrollTo_(200);
    v.wait(FADE_OUT_MS - 100);
    expect(v.visible(v.up())).toBe(true);
    v.wait(100);
    expect(v.visible(v.up())).toBe(false);
  });

  it('悬停时不淡出，移开后才开始计时', () => {
    const v = setup(500);
    v.scrollTo_(300);
    act(() => void v.up().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
    v.wait(FADE_OUT_MS * 3);
    expect(v.visible(v.up())).toBe(true);
    act(() => void v.up().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })));
    v.wait(FADE_OUT_MS);
    expect(v.visible(v.up())).toBe(false);
  });

  it('滚到顶部 / 底部时不显示', () => {
    const v = setup(500);
    v.scrollTo_(0);
    expect(v.visible(v.up())).toBe(false);
    v.scrollTo_(MAX);
    expect(v.visible(v.down())).toBe(false);
  });
});

describe('ScrollNav 单击 / 双击', () => {
  it('单击「上」：等 250ms 后去上一个交付点（平滑滚动）', () => {
    const v = setup(1000);
    v.scrollTo_(950);
    v.click(v.up());
    expect(v.scrollTo).not.toHaveBeenCalled();
    v.wait(DOUBLE_CLICK_MS);
    expect(v.scrollTo).toHaveBeenCalledTimes(1);
    expect(v.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 900 - POINT_MARGIN }));
  });

  it('连续单击「上」：逐个往上，最后回到顶部', () => {
    const v = setup(1000);
    v.scrollTo_(950);
    v.click(v.up());
    v.wait(DOUBLE_CLICK_MS);
    v.click(v.up());
    v.wait(DOUBLE_CLICK_MS);
    expect(v.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 300 - POINT_MARGIN }));
    v.click(v.up());
    v.wait(DOUBLE_CLICK_MS);
    expect(v.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('双击「上」：直达顶部，不触发单击跳转', () => {
    const v = setup(1000);
    v.scrollTo_(950);
    v.click(v.up());
    v.wait(100);
    v.click(v.up());
    v.wait(1000);
    expect(v.scrollTo).toHaveBeenCalledTimes(1);
    expect(v.scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('单击「下」：去下一个交付点；没有更靠下的交付点时到底部并恢复贴底', () => {
    const v = setup(100);
    v.scrollTo_(150);
    v.click(v.down());
    v.wait(DOUBLE_CLICK_MS);
    expect(v.scrollTo).toHaveBeenLastCalledWith(expect.objectContaining({ top: 300 - POINT_MARGIN }));
    expect(v.onJumpBottom).not.toHaveBeenCalled();

    v.scrollTo_(1000);
    v.click(v.down());
    v.wait(DOUBLE_CLICK_MS);
    expect(v.onJumpBottom).toHaveBeenCalledTimes(1);
  });

  it('双击「下」：直达底部并恢复贴底', () => {
    const v = setup(100);
    v.scrollTo_(150);
    v.click(v.down());
    v.wait(100);
    v.click(v.down());
    v.wait(1000);
    expect(v.scrollTo).not.toHaveBeenCalled();
    expect(v.onJumpBottom).toHaveBeenCalledTimes(1);
  });
});
