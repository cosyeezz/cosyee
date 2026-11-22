// 粘性融合指示器：横向分段选择里的选中底块。切换时前端先拉向新位置，中间被拉出一道细细的液桥，
// 后端随后跟上、液桥收细并被吸回，最后在新位置收拢成圆角胶囊。约 0.6 秒。
// 液态效果靠 SVG 滤镜（模糊 + 透明度阈值）做在单独的一层上，按钮文字不在这层里，始终清晰。
// 放在 position: relative 的分段容器里，作为第一个子元素；减少动效 / 测试环境里直接跳到新位置。
import { useId, useLayoutEffect, useRef } from 'react';
import { motionOK } from './reduced';

interface Box { x: number; y: number; w: number; h: number }

const DURATION = 600;
const STEPS = 30;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function GooeyIndicator({ activeKey, selector }: { activeKey: string | null; selector: string }) {
  const rawId = useId();
  const filterId = `cz-goo-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const layerRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLElement>(null);
  const tailRef = useRef<HTMLElement>(null);
  const bridgeRef = useRef<HTMLElement>(null);
  const last = useRef<{ key: string | null; box: Box | null }>({ key: null, box: null });
  const anims = useRef<Animation[]>([]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const head = headRef.current;
    const tail = tailRef.current;
    const bridge = bridgeRef.current;
    if (!layer || !head || !tail || !bridge) return;
    const target = measure(layer, selector);
    const prev = last.current;
    const keyChanged = activeKey !== prev.key;
    const from = prev.box;
    last.current = { key: activeKey, box: target };
    if (!keyChanged && sameBox(from, target)) return;

    for (const a of anims.current) a.cancel();
    anims.current = [];
    layer.parentElement?.classList.toggle('has-goo', !!target);
    if (!target) {
      layer.classList.remove('is-on');
      return;
    }
    placeBlob(head, target);
    placeBlob(tail, target);
    bridge.style.width = '0px';
    const shown = layer.classList.contains('is-on');
    layer.classList.add('is-on');
    if (!keyChanged || !from || !shown || !motionOK()) return;

    const f = gooFrames(from, target);
    const opts: KeyframeAnimationOptions = { duration: DURATION, easing: 'linear' };
    anims.current = [head.animate(f.head, opts), tail.animate(f.tail, opts), bridge.animate(f.bridge, opts)];
  });

  return (
    <span ref={layerRef} className="cz-goo" aria-hidden="true">
      <svg className="cz-goo__defs" width="0" height="0" focusable="false">
        <filter id={filterId} x="-20%" y="-60%" width="140%" height="220%" colorInterpolationFilters="sRGB">
          <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="blur" />
          <feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" />
        </filter>
      </svg>
      <span className="cz-goo__ink" style={{ filter: `url(#${filterId})` }}>
        <i ref={tailRef} className="cz-goo__blob" />
        <i ref={bridgeRef} className="cz-goo__bridge" />
        <i ref={headRef} className="cz-goo__blob" />
      </span>
    </span>
  );
}

/** 用 offset* 量（相对容器的内边距框，和 inset: 0 的指示器层同一原点），不受祖先 transform 缩放影响 */
function measure(layer: HTMLElement, selector: string): Box | null {
  const host = layer.parentElement;
  const el = host?.querySelector<HTMLElement>(selector);
  if (!el || el.offsetParent !== host) return null;
  if (el.offsetWidth === 0 || el.offsetHeight === 0) return null;
  return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight };
}

const sameBox = (a: Box | null, b: Box | null) =>
  (!a && !b) || (!!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5);

function placeBlob(el: HTMLElement, b: Box) {
  el.style.transform = `translate(${b.x}px, ${b.y}px)`;
  el.style.width = `${b.w}px`;
  el.style.height = `${b.h}px`;
}

/** 三个元素的关键帧：前端（head）先走，后端（tail）晚一拍跟上，液桥连在两者中心之间，越拉越细 */
export function gooFrames(a: Box, b: Box) {
  const head: Keyframe[] = [];
  const tail: Keyframe[] = [];
  const bridge: Keyframe[] = [];
  const span = Math.max(1, Math.abs(b.x - a.x));
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    const ph = easeOutCubic(clamp01(t / 0.6));
    const pt = easeInOutCubic(clamp01((t - 0.14) / 0.74));
    const hx = a.x + (b.x - a.x) * ph;
    const tx = a.x + (b.x - a.x) * pt;
    const hw = a.w + (b.w - a.w) * ph;
    const tw = a.w + (b.w - a.w) * pt;
    const y = a.y + (b.y - a.y) * ph;
    const h = a.h + (b.h - a.h) * ph;
    // 前端冲出去时略扁、后端被拖着时略细，看上去像被拉长的一滴
    const sep = clamp01(Math.abs(hx - tx) / span);
    const headH = h * (1 - 0.1 * sep);
    const tailH = h * (1 - 0.3 * sep);
    head.push({ offset: t, transform: `translate(${hx.toFixed(2)}px, ${(y + (h - headH) / 2).toFixed(2)}px)`, width: `${hw.toFixed(2)}px`, height: `${headH.toFixed(2)}px` });
    tail.push({ offset: t, transform: `translate(${tx.toFixed(2)}px, ${(y + (h - tailH) / 2).toFixed(2)}px)`, width: `${tw.toFixed(2)}px`, height: `${tailH.toFixed(2)}px` });
    // 液桥：两块中心之间，拉得越开越细
    const c1 = tx + tw / 2;
    const c2 = hx + hw / 2;
    const left = Math.min(c1, c2);
    const bw = Math.abs(c2 - c1);
    const bh = bw < 1 ? 0 : h * (0.46 - 0.2 * sep);
    bridge.push({ offset: t, transform: `translate(${left.toFixed(2)}px, ${(y + (h - bh) / 2).toFixed(2)}px)`, width: `${bw.toFixed(2)}px`, height: `${bh.toFixed(2)}px` });
  }
  return { head, tail, bridge };
}
