// fixed 弹层可以放的区域（视口坐标）。
// 手机浏览器弹出键盘时 visualViewport 会比布局视口小；Android 壳则把系统栏 / 键盘的 inset
// 写成 html 的 padding（见 client/src-tauri/src/titlebar.js），window.innerHeight 并不跟着缩。两者都要扣掉。
export interface Bounds {
  top: number;
  left: number;
  right: number;
  bottom: number;
}

export function viewportBounds(): Bounds {
  let top = 0;
  let left = 0;
  let right = window.innerWidth;
  let bottom = window.innerHeight;
  const vv = window.visualViewport;
  if (vv) {
    top = Math.max(top, vv.offsetTop);
    left = Math.max(left, vv.offsetLeft);
    right = Math.min(right, vv.offsetLeft + vv.width);
    bottom = Math.min(bottom, vv.offsetTop + vv.height);
  }
  const cs = getComputedStyle(document.documentElement);
  const px = (v: string) => parseFloat(v) || 0;
  top += px(cs.paddingTop);
  left += px(cs.paddingLeft);
  right -= px(cs.paddingRight);
  bottom -= px(cs.paddingBottom);
  return { top, left, right, bottom };
}
