// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConversationView } from './ConversationView';
import { clampZoom, getFlowZoom, setFlowZoom, ZOOM_MAX, ZOOM_MIN } from './flowZoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  setFlowZoom(1);
});

function mount(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ConversationView turns={[]} />));
  return host.querySelector('.cz-flow__wrap') as HTMLElement;
}

function wheel(el: Element, deltaY: number, ctrlKey = true) {
  const e = new WheelEvent('wheel', { deltaY, ctrlKey, bubbles: true, cancelable: true });
  act(() => {
    el.dispatchEvent(e);
  });
  return e;
}

describe('flowZoom', () => {
  it('clampZoom 取整到 0.1 并限制在范围内', () => {
    expect(clampZoom(1.04)).toBe(1);
    expect(clampZoom(1.16)).toBe(1.2);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(0)).toBe(ZOOM_MIN);
  });

  it('setFlowZoom 持久化，恢复 1 时清除', () => {
    setFlowZoom(1.3);
    expect(localStorage.getItem('cz.flowZoom')).toBe('1.3');
    setFlowZoom(1);
    expect(localStorage.getItem('cz.flowZoom')).toBeNull();
  });

  it('Ctrl + 滚轮按档缩放并写入 --cz-flow-zoom，普通滚轮不处理', () => {
    const wrap = mount();

    const e = wheel(wrap, -100);
    expect(e.defaultPrevented).toBe(true);
    expect(getFlowZoom()).toBe(1.1);
    expect(wrap.style.getPropertyValue('--cz-flow-zoom')).toBe('1.1');
    const pill = wrap.querySelector('.cz-flow__zoom')!;
    expect(pill.textContent).toBe('110%');
    expect(pill.classList.contains('is-shown')).toBe(true);

    wheel(wrap, 100);
    wheel(wrap, 100);
    expect(getFlowZoom()).toBe(0.9);

    const plain = wheel(wrap, -100, false);
    expect(plain.defaultPrevented).toBe(false);
    expect(getFlowZoom()).toBe(0.9);

    act(() => (pill as HTMLButtonElement).click());
    expect(getFlowZoom()).toBe(1);
  });

  it('触控板小幅 delta 累计到一档才缩放', () => {
    const wrap = mount();
    wheel(wrap, -20);
    wheel(wrap, -20);
    expect(getFlowZoom()).toBe(1);
    wheel(wrap, -20);
    expect(getFlowZoom()).toBe(1.1);
  });

  it('双 ConversationView 并存时 Ctrl+0 只触发一次，且悬停优先于焦点', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <>
          <ConversationView turns={[]} />
          <ConversationView turns={[]} />
        </>,
      ),
    );
    const [w1, w2] = [...host.querySelectorAll<HTMLElement>('.cz-flow__wrap')];
    const p1 = w1.querySelector<HTMLElement>('.cz-flow__zoom')!;
    const p2 = w2.querySelector<HTMLElement>('.cz-flow__zoom')!;
    const s1 = w1.querySelector<HTMLElement>('.cz-flow__scroll')!;
    const s2 = w2.querySelector<HTMLElement>('.cz-flow__scroll')!;

    // 场景 1：w1 有焦点，但 w2 被悬停 → 只有 w2 响应 Ctrl+0
    act(() => setFlowZoom(1.3));
    s1.focus();
    const orig1 = w1.matches.bind(w1);
    const orig2 = w2.matches.bind(w2);
    w1.matches = (sel) => (sel === ':hover' ? false : orig1(sel));
    w2.matches = (sel) => (sel === ':hover' ? true : orig2(sel));

    const e1 = new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(e1); });
    expect(e1.defaultPrevented).toBe(true);
    expect(getFlowZoom()).toBe(1);
    expect(p1.classList.contains('is-shown')).toBe(false);
    expect(p2.classList.contains('is-shown')).toBe(true);

    // 场景 2：两个都没悬停，焦点在 w1 → 只有 w1 响应
    w2.matches = (sel) => (sel === ':hover' ? false : orig2(sel));
    act(() => setFlowZoom(1.2));
    s1.focus();
    const e2 = new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(e2); });
    expect(e2.defaultPrevented).toBe(true);
    expect(getFlowZoom()).toBe(1);
    expect(p1.classList.contains('is-shown')).toBe(true);

    // 场景 3：焦点切到 w2、已被 preventDefault 的事件不再触发
    act(() => setFlowZoom(1.4));
    s2.focus();
    const e3 = new KeyboardEvent('keydown', { key: '0', ctrlKey: true, bubbles: true, cancelable: true });
    e3.preventDefault();
    act(() => { window.dispatchEvent(e3); });
    expect(getFlowZoom()).toBe(1.4);
  });
});
