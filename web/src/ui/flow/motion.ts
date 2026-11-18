// 程序化滚动的行为：减少动效时瞬时跳转，否则平滑滚动。
// 应用的样式动效只认 data-motion="reduce"（见 status.css）；平滑滚动是浏览器行为，这里也尊重系统的 prefers-reduced-motion。
export function scrollBehavior(): ScrollBehavior {
  if (typeof document === 'undefined') return 'auto';
  if (document.documentElement.dataset.motion === 'reduce') return 'auto';
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return 'auto';
  }
  return 'smooth';
}
