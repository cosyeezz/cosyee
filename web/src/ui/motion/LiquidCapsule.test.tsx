// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LiquidCapsule } from './LiquidCapsule';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;

function setRect(el: HTMLElement, r: { left: number; top: number; width: number; height: number }) {
  el.getBoundingClientRect = () => ({
    left: r.left,
    top: r.top,
    right: r.left + r.width,
    bottom: r.top + r.height,
    width: r.width,
    height: r.height,
    x: r.left,
    y: r.top,
    toJSON: () => ({}),
  });
}

function setOffset(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: width });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: height });
}

beforeEach(() => {
  document.documentElement.removeAttribute('data-motion');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-motion');
  vi.restoreAllMocks();
});

function Seg({ active }: { active: 'a' | 'b' }) {
  return (
    <div className="seg">
      <LiquidCapsule activeKey={active} selector=".opt.is-active" axis="x" />
      <button type="button" className={`opt opt-a${active === 'a' ? ' is-active' : ''}`}>A</button>
      <button type="button" className={`opt opt-b${active === 'b' ? ' is-active' : ''}`}>B</button>
    </div>
  );
}

describe('LiquidCapsule', () => {
  it('祖先有 transform: scale 缩放（如 .cz-pop 入场）时，按未缩放局部坐标定位和设宽高', () => {
    // 先渲染一次以拿到 DOM，设置模拟的 0.95 缩放 rect，再重新渲染触发测量
    act(() => root!.render(<Seg active="b" />));
    const seg = host.querySelector<HTMLElement>('.seg')!;
    const optB = host.querySelector<HTMLElement>('.opt-b')!;
    const cap = host.querySelector<HTMLElement>('.cz-capsule')!;

    // 容器布局尺寸 200x30，在 scale(0.95) 下视觉尺寸 190x28.5
    // optB 局部坐标 x=100, y=2, w=98, h=26，在 scale(0.95) 下视觉偏移 95, 1.9, 宽高 93.1, 24.7
    setOffset(seg, 200, 30);
    setRect(seg, { left: 10, top: 20, width: 190, height: 28.5 });
    setRect(optB, { left: 10 + 95, top: 20 + 1.9, width: 93.1, height: 24.7 });

    // 触发同步（切换 key 或重新渲染）
    act(() => root!.render(<Seg active="a" />));
    setRect(host.querySelector<HTMLElement>('.opt-a')!, { left: 10 + 1.9, top: 20 + 1.9, width: 93.1, height: 24.7 });
    act(() => root!.render(<Seg active="b" />));

    expect(cap.classList.contains('is-on')).toBe(true);
    expect(parseFloat(cap.style.width)).toBeCloseTo(98, 1);
    expect(parseFloat(cap.style.height)).toBeCloseTo(26, 1);
    const m = /translate3d\(([^p]+)px,\s*([^p]+)px,\s*0\)/.exec(cap.style.transform);
    expect(m).not.toBeNull();
    expect(parseFloat(m![1])).toBeCloseTo(100, 1);
    expect(parseFloat(m![2])).toBeCloseTo(2, 1);
  });

  it('字体加载完成后（document.fonts.ready）重新同步胶囊位置', async () => {
    let resolveFonts!: () => void;
    const ready = new Promise<void>((r) => { resolveFonts = r; });
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });

    act(() => root!.render(<Seg active="a" />));
    const seg = host.querySelector<HTMLElement>('.seg')!;
    const optA = host.querySelector<HTMLElement>('.opt-a')!;
    const cap = host.querySelector<HTMLElement>('.cz-capsule')!;

    setOffset(seg, 200, 30);
    setRect(seg, { left: 0, top: 0, width: 200, height: 30 });
    setRect(optA, { left: 2, top: 2, width: 80, height: 26 });
    act(() => root!.render(<Seg active="a" />));
    expect(parseFloat(cap.style.width)).toBeCloseTo(80, 1);

    // 字体加载后按钮变宽为 96
    setRect(optA, { left: 2, top: 2, width: 96, height: 26 });
    await act(async () => {
      resolveFonts();
      await Promise.resolve();
    });
    expect(parseFloat(cap.style.width)).toBeCloseTo(96, 1);
  });

  it('窗口缩放（window resize）时重新贴位', () => {
    act(() => root!.render(<Seg active="a" />));
    const seg = host.querySelector<HTMLElement>('.seg')!;
    const optA = host.querySelector<HTMLElement>('.opt-a')!;
    const cap = host.querySelector<HTMLElement>('.cz-capsule')!;

    setOffset(seg, 200, 30);
    setRect(seg, { left: 0, top: 0, width: 200, height: 30 });
    setRect(optA, { left: 2, top: 2, width: 96, height: 26 });
    act(() => root!.render(<Seg active="a" />));
    expect(parseFloat(cap.style.width)).toBeCloseTo(96, 1);

    setOffset(seg, 300, 30);
    setRect(seg, { left: 0, top: 0, width: 300, height: 30 });
    setRect(optA, { left: 2, top: 2, width: 146, height: 26 });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(parseFloat(cap.style.width)).toBeCloseTo(146, 1);
  });

  it('卸载时取消正在进行的动画；reducedMotion 时不播放动画', () => {
    const cancel = vi.fn();
    const animate = vi.fn(() => ({ playState: 'running', cancel } as unknown as Animation));

    act(() => root!.render(<Seg active="a" />));
    const seg = host.querySelector<HTMLElement>('.seg')!;
    const optA = host.querySelector<HTMLElement>('.opt-a')!;
    const optB = host.querySelector<HTMLElement>('.opt-b')!;
    const cap = host.querySelector<HTMLElement>('.cz-capsule')!;
    cap.animate = animate;

    setOffset(seg, 200, 30);
    setRect(seg, { left: 0, top: 0, width: 200, height: 30 });
    setRect(optA, { left: 2, top: 2, width: 96, height: 26 });
    setRect(optB, { left: 102, top: 2, width: 96, height: 26 });
    act(() => root!.render(<Seg active="a" />));

    // 正常动效：切换触发 animate
    act(() => root!.render(<Seg active="b" />));
    expect(animate).toHaveBeenCalledTimes(1);

    // 卸载取消动画
    act(() => root!.unmount());
    expect(cancel).toHaveBeenCalledTimes(1);

    // reducedMotion：不调用 animate
    document.documentElement.dataset.motion = 'reduce';
    root = createRoot(host);
    act(() => root!.render(<Seg active="a" />));
    const seg2 = host.querySelector<HTMLElement>('.seg')!;
    const cap2 = host.querySelector<HTMLElement>('.cz-capsule')!;
    const animate2 = vi.fn(() => ({ playState: 'running', cancel: vi.fn() } as unknown as Animation));
    cap2.animate = animate2;
    setOffset(seg2, 200, 30);
    setRect(seg2, { left: 0, top: 0, width: 200, height: 30 });
    setRect(host.querySelector<HTMLElement>('.opt-a')!, { left: 2, top: 2, width: 96, height: 26 });
    setRect(host.querySelector<HTMLElement>('.opt-b')!, { left: 102, top: 2, width: 96, height: 26 });
    act(() => root!.render(<Seg active="a" />));
    act(() => root!.render(<Seg active="b" />));
    expect(animate2).not.toHaveBeenCalled();
    expect(cap2.style.transform).toContain('translate3d(102px, 2px, 0)');
  });
});
