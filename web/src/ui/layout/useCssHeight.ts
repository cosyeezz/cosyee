// 浮层（顶栏、输入框）盖在滚动内容上面时，内容需要知道要让出多少：
// 量出 src 的高度，写成 host 上的 CSS 变量。首帧同步量一次（没有跳动），之后随尺寸变化更新。
import { useLayoutEffect, type RefObject } from 'react';

export function useCssHeight(host: RefObject<HTMLElement | null>, src: RefObject<HTMLElement | null>, name: string, deps: unknown[] = []) {
  useLayoutEffect(() => {
    const h = host.current;
    const s = src.current;
    if (!h || !s) return;
    const set = () => h.style.setProperty(name, `${s.offsetHeight}px`);
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(s);
    return () => ro.disconnect();
  }, [host, src, name, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
}
