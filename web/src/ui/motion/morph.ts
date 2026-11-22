// 原位展开 / 原路收回：浮层打开时从触发它的那个元素（刚被点击、仍持有焦点）的位置和大小长出来，
// 关闭时缩回到那个元素上。内容在形变的前半段保持透明，所以缩放带来的文字变形看不到。
// 拿不到来源元素（不可见、被滚走、键盘之外的方式打开）或减少动效时，退回组件原有的 CSS 入场，关闭直接关。
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { canAnimate, reducedMotion } from './reduced';

const OPEN_MS = 440;
const CLOSE_MS = 320;
const EASE_OPEN = 'cubic-bezier(.16, 1, .3, 1)';
const EASE_CLOSE = 'cubic-bezier(.45, 0, .2, 1)';

export interface MorphOptions {
  /** 遮罩层：打开时底色淡入、关闭时淡出（它是面板的父元素，不能整体改透明度） */
  scrimRef?: RefObject<HTMLElement>;
  /** 收起完成后把焦点还给来源元素 */
  restoreFocus?: boolean;
  /** false = 不播入场（同一个弹窗换了内容重新挂载时，不要再从头长出来一遍） */
  enter?: boolean;
}

// 遮罩的「空」状态：底色透明、背景不模糊
const SCRIM_EMPTY: Keyframe = { backgroundColor: 'transparent', backdropFilter: 'blur(0px) saturate(1)' };

function fadeScrimOut(scrim: HTMLElement | null | undefined, panel: HTMLElement, ms: number) {
  if (scrim && scrim !== panel) scrim.animate([{}, SCRIM_EMPTY], { duration: ms, easing: 'ease-in', fill: 'forwards' });
}

// 最近一次按下的可点元素：有些触发器（带 onClick 的 span、链接样式的文字）点了不会拿到焦点，
// 所以除了 activeElement 再记一下指针按在了哪里，一小段时间内有效
let lastPress: { el: HTMLElement; at: number } | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      const t = e.target instanceof Element ? e.target : null;
      const el = t?.closest<HTMLElement>('button, a, [role="button"], [role="link"], [tabindex], [data-morph-origin]') ?? null;
      lastPress = el ? { el, at: performance.now() } : null;
    },
    { capture: true, passive: true },
  );
  // 键盘触发时以焦点为准
  document.addEventListener('keydown', () => { lastPress = null; }, { capture: true, passive: true });
}

function triggerElement(): Element | null {
  const active = document.activeElement;
  if (lastPress && performance.now() - lastPress.at < 1000 && lastPress.el.isConnected) {
    // 指针刚按过：以按下的元素为准（它可能没拿到焦点，焦点还停在别处）
    if (!active || active === document.body || !lastPress.el.contains(active)) return lastPress.el;
  }
  return active;
}

function usableOrigin(el: Element | null, panel: HTMLElement): HTMLElement | null {
  if (!(el instanceof HTMLElement) || el === document.body || panel.contains(el)) return null;
  if (!el.isConnected) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return null;
  return el;
}

function radiusOf(el: HTMLElement) {
  return parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
}

/** 从来源矩形到面板矩形的 FLIP 变换；圆角按缩放反向补偿，看上去始终是来源元素的圆角 */
function collapsedFrame(origin: DOMRect, panel: DOMRect, originRadius: number): Keyframe {
  const sx = Math.max(origin.width / panel.width, 0.001);
  const sy = Math.max(origin.height / panel.height, 0.001);
  const r = Math.max(originRadius, 8);
  return {
    transform: `translate(${origin.left - panel.left}px, ${origin.top - panel.top}px) scale(${sx}, ${sy})`,
    borderRadius: `${r / sx}px / ${r / sy}px`,
  };
}

export function useMorph(panelRef: RefObject<HTMLElement>, { scrimRef, restoreFocus = false, enter = true }: MorphOptions = {}) {
  const originRef = useRef<HTMLElement | null>(null);
  const closing = useRef(false);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const trigger = triggerElement();
    const origin = usableOrigin(trigger, panel);
    originRef.current = trigger instanceof HTMLElement && trigger !== document.body ? trigger : null;
    if (!enter) {
      // 不播入场：连组件自带的 CSS 兜底入场也关掉
      panel.style.animation = 'none';
      if (scrimRef?.current) scrimRef.current.style.animation = 'none';
      return;
    }
    if (!origin || reducedMotion() || !canAnimate(panel)) return;

    // 关掉组件自带的 CSS 入场，改由形变负责
    panel.style.animation = 'none';
    const p = panel.getBoundingClientRect();
    const o = origin.getBoundingClientRect();
    const endRadius = radiusOf(panel);
    panel.style.transformOrigin = '0 0';
    const a = panel.animate(
      [
        { ...collapsedFrame(o, p, radiusOf(origin)), boxShadow: 'none' },
        { transform: 'none', borderRadius: `${endRadius}px` },
      ],
      { duration: OPEN_MS, easing: EASE_OPEN },
    );
    a.onfinish = a.oncancel = () => { panel.style.transformOrigin = ''; };
    for (const child of Array.from(panel.children)) {
      (child as HTMLElement).animate?.([{ opacity: 0 }, { opacity: 0, offset: 0.3 }, { opacity: 1 }], {
        duration: OPEN_MS,
        easing: 'ease-out',
      });
    }
    const scrim = scrimRef?.current;
    if (scrim && scrim !== panel) {
      scrim.style.animation = 'none';
      scrim.animate([SCRIM_EMPTY, {}], { duration: OPEN_MS * 0.7, easing: 'ease-out' });
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 播放收回动画后再调用 done；没法动画时立即调用 */
  const requestClose = useCallback(
    (done: () => void) => {
      if (closing.current) return;
      const panel = panelRef.current;
      const originEl = originRef.current;
      const finish = () => {
        done();
        if (restoreFocus && originEl?.isConnected) originEl.focus({ preventScroll: true });
      };
      const origin = panel ? usableOrigin(originEl, panel) : null;
      if (!panel || reducedMotion() || !canAnimate(panel)) return finish();
      closing.current = true;

      if (!origin) {
        // 来源已经看不到了：原地淡出缩小一点
        for (const x of panel.getAnimations()) x.cancel();
        const a = panel.animate([{}, { opacity: 0, transform: 'scale(.98)' }], { duration: 160, easing: 'ease-in', fill: 'forwards' });
        fadeScrimOut(scrimRef?.current, panel, 160);
        a.onfinish = finish;
        return;
      }
      for (const a of panel.getAnimations()) a.cancel();
      const p = panel.getBoundingClientRect();
      const o = origin.getBoundingClientRect();
      panel.style.transformOrigin = '0 0';
      const a = panel.animate(
        [
          { transform: 'none', borderRadius: `${radiusOf(panel)}px` },
          { ...collapsedFrame(o, p, radiusOf(origin)), boxShadow: 'none', opacity: 0.4 },
        ],
        { duration: CLOSE_MS, easing: EASE_CLOSE, fill: 'forwards' },
      );
      for (const child of Array.from(panel.children)) {
        (child as HTMLElement).animate?.([{ opacity: 1 }, { opacity: 0, offset: 0.4 }, { opacity: 0 }], {
          duration: CLOSE_MS,
          fill: 'forwards',
        });
      }
      fadeScrimOut(scrimRef?.current, panel, CLOSE_MS);
      a.onfinish = finish;
    },
    [panelRef, scrimRef, restoreFocus],
  );

  return { requestClose };
}
