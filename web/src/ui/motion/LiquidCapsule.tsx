// 液态玻璃选中胶囊：放在滚动容器的第一个子元素，自动找到容器里的 .is-active 行并垫在它下面。
// 切换选中项时不是平移过去，而是像一滴水：前沿先冲到目标（被拉长、略微变细），后沿随后跟上，两端各轻轻回弹一下。
// 只有「选中项变了」才流动；列表重排、折叠、宽度变化时直接贴到新位置。减少动效时不流动，只淡入淡出。
// 元素本身的宽高一次性设成目标尺寸，动画只改 transform（位移 + 缩放）：全程在合成线程上跑，
// 切换会话时主线程忙着渲染新对话，胶囊也不会卡顿。
import { useLayoutEffect, useRef } from 'react';
import { canAnimate, reducedMotion } from './reduced';

interface Box { x: number; y: number; w: number; h: number }

export interface LiquidCapsuleProps {
  /** 当前选中项的标识；变化时才播放流动动画 */
  activeKey: string | null;
  /** 在容器里查找选中行的选择器 */
  selector: string;
  /** 滑动方向：默认 y（竖向列表）；x 用于横向分段控件 */
  axis?: 'y' | 'x';
}

export function LiquidCapsule({ activeKey, selector, axis = 'y' }: LiquidCapsuleProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const last = useRef<{ key: string | null; box: Box | null }>({ key: null, box: null });
  const anim = useRef<Animation | null>(null);

  // 每次父组件渲染后都同步一次位置（行可能因为折叠、重排、增删而移动）
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) sync(el, activeKey, selector, axis, last.current, anim);
  });

  // 容器尺寸变化（侧栏宽度、滚动条出现）时也要重新贴位
  useLayoutEffect(() => {
    const el = ref.current;
    const host = el?.parentElement;
    if (!el || !host || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => sync(el, last.current.key, selector, axis, last.current, anim, true));
    ro.observe(host);
    return () => ro.disconnect();
  }, [selector, axis]);

  return <span ref={ref} className="cz-capsule" aria-hidden="true" />;
}

function measure(el: HTMLElement, selector: string): Box | null {
  const host = el.parentElement;
  const row = host?.querySelector<HTMLElement>(selector);
  if (!host || !row) return null;
  const hr = host.getBoundingClientRect();
  const rr = row.getBoundingClientRect();
  if (rr.width === 0 || rr.height === 0) return null;
  return { x: rr.left - hr.left + host.scrollLeft, y: rr.top - hr.top + host.scrollTop, w: rr.width, h: rr.height };
}

function place(el: HTMLElement, b: Box) {
  el.style.transform = `translate3d(${b.x}px, ${b.y}px, 0) scale(1, 1)`;
  el.style.width = `${b.w}px`;
  el.style.height = `${b.h}px`;
}

/** 动画进行中被打断时，从当前看到的形状接着流，而不是跳回起点（transform 带缩放，直接量屏幕上的框） */
function current(el: HTMLElement, fallback: Box): Box {
  const host = el.parentElement;
  if (!host) return fallback;
  const hr = host.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return fallback;
  return { x: r.left - hr.left + host.scrollLeft, y: r.top - hr.top + host.scrollTop, w: r.width, h: r.height };
}

const same = (a: Box | null, b: Box | null) =>
  !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;

function sync(
  el: HTMLElement,
  key: string | null,
  selector: string,
  axis: 'y' | 'x',
  state: { key: string | null; box: Box | null },
  anim: { current: Animation | null },
  force = false,
) {
  const target = measure(el, selector);
  const keyChanged = key !== state.key;
  if (!force && !keyChanged && same(target, state.box)) return;

  const from = state.box;
  state.key = key;
  state.box = target;

  if (!target) {
    anim.current?.cancel();
    anim.current = null;
    el.classList.remove('is-on');
    return;
  }

  const wasShown = el.classList.contains('is-on') && from !== null;
  const start = anim.current && anim.current.playState === 'running' && from ? current(el, from) : from;
  anim.current?.cancel();
  anim.current = null;
  place(el, target);
  el.classList.add('is-on');

  if (!keyChanged || force || !wasShown || !start || reducedMotion() || !canAnimate(el)) return;
  const frames = axis === 'x' ? liquidFramesX(start, target) : liquidFrames(start, target);
  anim.current = el.animate(frames, { duration: durationFor(start, target, axis), easing: 'linear' });
}

function durationFor(a: Box, b: Box, axis: 'y' | 'x' = 'y') {
  if (axis === 'x') {
    const dist = Math.abs(b.x - a.x);
    return Math.round(Math.min(440, Math.max(320, 300 + dist * 0.4)));
  }
  const dist = Math.abs(b.y - a.y);
  return Math.round(Math.min(620, Math.max(420, 400 + dist * 0.35)));
}

/**
 * 阻尼弹簧：0 → 1，ζ 越小回弹越明显。settle 是大致静止所需的时间（ms）。
 * 超出目标的量用 tanh 软限幅，远距离切换也只会多冲几个像素，不会甩出去一大截。
 */
function spring(t: number, settle: number, zeta: number) {
  if (t <= 0) return 0;
  const w = 4 / (zeta * settle);
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}

function edge(from: number, to: number, p: number, cap: number) {
  const dist = to - from;
  const over = (p - 1) * Math.abs(dist);
  const soft = cap > 0 ? cap * Math.tanh(over / cap) : 0;
  return to + Math.sign(dist) * (p >= 1 ? soft : over);
}

export function liquidFrames(a: Box, b: Box, steps = 32): Keyframe[] {
  const dur = durationFor(a, b);
  const lag = dur * 0.14;
  const down = b.y >= a.y;
  const dist = Math.abs(b.y - a.y);
  const cap = Math.min(3.5, 1 + dist * 0.02);
  const rest = (a.h + b.h) / 2;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dur;
    // 前沿：先走，几乎不回弹；后沿：晚一拍，落定时轻轻「啵」一下。阻尼偏大，整体是顺滑而不是弹跳
    const pLead = spring(t, dur * 0.7, 0.82);
    const pTrail = spring(t - lag, dur * 0.72, 0.68);
    const top0 = a.y, bot0 = a.y + a.h, top1 = b.y, bot1 = b.y + b.h;
    let top: number, bot: number;
    if (down) {
      bot = edge(bot0, bot1, pLead, cap);
      top = edge(top0, top1, pTrail, cap);
    } else {
      top = edge(top0, top1, pLead, cap);
      bot = edge(bot0, bot1, pTrail, cap);
    }
    if (i === steps) { top = top1; bot = bot1; }
    // 拉伸最多到目标高度的 1.6 倍：远距离切换也是一滴水，不是一根面条
    let h = Math.min(Math.max(bot - top, b.h * 0.8), b.h * 1.6);
    if (bot - top > h) top = down ? bot - h : top;
    if (i === steps) h = b.h;
    // 体积守恒：被拉长时两侧收窄一点，被压扁时稍微鼓出
    const k = h / rest;
    const inset = i === steps ? 0 : Math.max(-1.5, Math.min(4, (k - 1) * 2.2));
    const x = a.x + (b.x - a.x) * Math.min(1, pLead) + inset;
    const w = a.w + (b.w - a.w) * Math.min(1, pLead) - inset * 2;
    frames.push({
      offset: i / steps,
      transform: `translate3d(${x.toFixed(2)}px, ${top.toFixed(2)}px, 0) scale(${(w / b.w).toFixed(4)}, ${(h / b.h).toFixed(4)})`,
    });
  }
  return frames;
}

/** 横向液态流动：前沿先冲过去、后沿滞后 14% 跟上，沿 X 轴拉伸（上限 1.45 倍）并伴随轻微纵向收窄 */
export function liquidFramesX(a: Box, b: Box, steps = 32): Keyframe[] {
  const dur = durationFor(a, b, 'x');
  const lag = dur * 0.14;
  const right = b.x >= a.x;
  const dist = Math.abs(b.x - a.x);
  const cap = Math.min(3.5, 1 + dist * 0.02);
  const rest = (a.w + b.w) / 2;
  const frames: Keyframe[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * dur;
    const pLead = spring(t, dur * 0.68, 0.84);
    const pTrail = spring(t - lag, dur * 0.70, 0.68);
    const l0 = a.x, r0 = a.x + a.w, l1 = b.x, r1 = b.x + b.w;
    let left: number, rgt: number;
    if (right) {
      rgt = edge(r0, r1, pLead, cap);
      left = edge(l0, l1, pTrail, cap);
    } else {
      left = edge(l0, l1, pLead, cap);
      rgt = edge(r0, r1, pTrail, cap);
    }
    if (i === steps) { left = l1; rgt = r1; }
    let w = Math.min(Math.max(rgt - left, b.w * 0.84), b.w * 1.45);
    if (rgt - left > w) left = right ? rgt - w : left;
    if (i === steps) w = b.w;
    const k = w / rest;
    const inset = i === steps ? 0 : Math.max(-1, Math.min(2.8, (k - 1) * 1.8));
    const y = a.y + (b.y - a.y) * Math.min(1, pLead) + inset;
    const h = a.h + (b.h - a.h) * Math.min(1, pLead) - inset * 2;
    frames.push({
      offset: i / steps,
      transform: `translate3d(${left.toFixed(2)}px, ${y.toFixed(2)}px, 0) scale(${(w / b.w).toFixed(4)}, ${(h / b.h).toFixed(4)})`,
    });
  }
  return frames;
}
