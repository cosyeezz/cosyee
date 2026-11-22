// 减少动效：应用内显式 data-motion="reduce"，或系统设置了 prefers-reduced-motion。
export function reducedMotion(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.dataset.motion === 'reduce') return true;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  return false;
}

/** 现在适不适合播入场动效：不减少动效，且运行在真实浏览器里（测试环境不播，断言直接看终值） */
export function motionOK(): boolean {
  return typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function' && !reducedMotion();
}

/** 当前环境能否跑 Web Animations（jsdom 里没有 element.animate） */
export function canAnimate(el: Element | null | undefined): el is HTMLElement {
  return !!el && typeof (el as HTMLElement).animate === 'function';
}
