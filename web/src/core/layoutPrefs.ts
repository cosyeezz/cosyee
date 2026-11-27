// 宽屏布局习惯：左侧会话栏 / 右侧上下文栏是否收起。存在 localStorage，刷新、重开都保持；
// 桌面客户端切换服务器时，标题栏外壳脚本（client/src-tauri/src/titlebar.js）会把这个键原样带到新服务器。
export const LAYOUT_KEY = 'cz-layout';

export interface LayoutPrefs {
  left: boolean;
  right: boolean;
}

export function readLayout(): LayoutPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') as Partial<Record<keyof LayoutPrefs, unknown>>;
    return { left: v.left === true, right: v.right === true };
  } catch {
    return { left: false, right: false };
  }
}

export function saveLayout(p: LayoutPrefs) {
  try {
    if (!p.left && !p.right) localStorage.removeItem(LAYOUT_KEY);
    else localStorage.setItem(LAYOUT_KEY, JSON.stringify(p));
  } catch { /* 存不下就只在本次生效 */ }
}
