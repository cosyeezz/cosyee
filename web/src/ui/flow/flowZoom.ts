// 会话流字号缩放：在会话流上 Ctrl + 滚轮放大 / 缩小，Ctrl + 0 恢复。
// 只放大阅读内容（助手正文、用户气泡、代码块），列宽、间距和工具行等界面元素保持不变（见 flow.css「字号缩放」）。
// 缩放值全局共享（主会话流与子代理浮层一致）并持久化到 localStorage。
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';

export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 1.6;
export const ZOOM_STEP = 0.1;
const KEY = 'cz.flowZoom';
/** 触控板捏合 / 高精度滚轮的 deltaY 很小，累计到这个量才算一档 */
const WHEEL_UNIT = 50;
/** 缩放提示停留时长 */
const HINT_MS = 1200;

export function clampZoom(z: number): number {
  const r = Math.round(z * 10) / 10;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, r));
}

function load(): number {
  try {
    const v = Number(localStorage.getItem(KEY));
    return Number.isFinite(v) && v > 0 ? clampZoom(v) : 1;
  } catch {
    return 1;
  }
}

let zoom = load();
const subs = new Set<() => void>();
/** 当前挂载中的所有会话流外层，用来在多实例并存时判定悬停优先 */
const wraps = new Set<HTMLElement>();

export function getFlowZoom(): number {
  return zoom;
}

export function setFlowZoom(z: number): void {
  const next = clampZoom(z);
  if (next === zoom) return;
  zoom = next;
  try {
    if (next === 1) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, String(next));
  } catch {
    /* 隐私模式等写不进去：只在本次运行内生效 */
  }
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

export function useFlowZoom(): number {
  return useSyncExternalStore(subscribe, getFlowZoom, getFlowZoom);
}

/** 缩放前记下的锚点：光标下的元素及光标在它里面的相对高度，缩放后据此把那段文字留在光标下 */
interface Anchor {
  el: Element;
  y: number;
  ratio: number;
  atBottom: boolean;
}

/**
 * 在 wrap 上接管 Ctrl + 滚轮与 Ctrl + 0。返回当前缩放值与是否显示缩放提示（只在本实例里操作过才显示）。
 * @param wrapRef 会话流外层（监听滚轮、判断悬停）
 * @param scrollRef 滚动容器（缩放后校正 scrollTop）
 * @param contentRef 内容列（锚点只取其中的元素）
 */
export function useFlowZoomControls(
  wrapRef: RefObject<HTMLElement>,
  scrollRef: RefObject<HTMLElement>,
  contentRef: RefObject<HTMLElement>,
): { zoom: number; hint: boolean } {
  const z = useFlowZoom();
  const [hint, setHint] = useState(false);
  const anchor = useRef<Anchor | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let acc = 0;
    let lastAt = 0;

    const showHint = () => {
      setHint(true);
      clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(false), HINT_MS);
    };
    const capture = (x: number, y: number) => {
      const sc = scrollRef.current;
      const ct = contentRef.current;
      if (!sc || !ct) return;
      const hit = document.elementFromPoint?.(x, y);
      const el = hit && ct.contains(hit) ? hit : ct;
      const r = el.getBoundingClientRect();
      anchor.current = {
        el,
        y,
        ratio: r.height > 0 ? Math.min(1, Math.max(0, (y - r.top) / r.height)) : 0,
        atBottom: sc.scrollHeight - sc.scrollTop - sc.clientHeight < 40,
      };
    };
    const apply = (next: number, x: number, y: number) => {
      if (clampZoom(next) === getFlowZoom()) {
        showHint(); // 已到上 / 下限：仍提示当前值
        return;
      }
      capture(x, y);
      setFlowZoom(next);
      showHint();
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); // 阻止整页缩放
      const now = performance.now();
      if (now - lastAt > 300) acc = 0;
      lastAt = now;
      const dy = e.deltaMode === 1 ? e.deltaY * 40 : e.deltaY;
      let steps = 0;
      if (Math.abs(dy) >= WHEEL_UNIT) {
        steps = dy < 0 ? 1 : -1; // 普通滚轮：一格一档
        acc = 0;
      } else {
        acc += dy;
        if (Math.abs(acc) >= WHEEL_UNIT) {
          steps = acc < 0 ? 1 : -1;
          acc = 0;
        }
      }
      if (steps) apply(getFlowZoom() + steps * ZOOM_STEP, e.clientX, e.clientY);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.key !== '0') return;
      // 悬停优先：页面上有任一会话流被悬停时，只由被悬停的那个响应；否则由焦点所在的响应
      const anyHovered = [...wraps].some((w) => w.matches(':hover'));
      const matched = anyHovered ? wrap.matches(':hover') : wrap.contains(document.activeElement);
      if (!matched) return;
      e.preventDefault();
      const r = (scrollRef.current ?? wrap).getBoundingClientRect();
      apply(1, r.left + r.width / 2, r.top + r.height / 2);
    };

    wraps.add(wrap);
    wrap.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      wraps.delete(wrap);
      wrap.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      clearTimeout(hintTimer.current);
    };
  }, [wrapRef, scrollRef, contentRef]);

  // 新字号已提交、尚未绘制：把锚点那段文字挪回光标下（贴底时保持贴底）
  useLayoutEffect(() => {
    const a = anchor.current;
    anchor.current = null;
    const sc = scrollRef.current;
    if (!a || !sc) return;
    if (a.atBottom) {
      sc.scrollTop = sc.scrollHeight;
      return;
    }
    if (!a.el.isConnected) return;
    const r = a.el.getBoundingClientRect();
    sc.scrollTop += r.top + a.ratio * r.height - a.y;
  }, [z, scrollRef]);

  return { zoom: z, hint };
}
