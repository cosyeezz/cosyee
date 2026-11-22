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
  act(() => root!.render(<ConversationView turns={[]} onOpenSubagent={() => {}} />));
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
});
