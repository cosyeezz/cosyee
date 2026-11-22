// 界面主题：跟随系统 / 浅色 / 深色。选择存在 localStorage，<html data-theme> 只会是 light 或 dark。
// 页面首帧之前就要设好（main.tsx 在渲染前调用 installTheme），否则会先闪一下深色。
export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

const KEY = 'cz-theme';
const listeners = new Set<(p: ThemePref) => void>();

function read(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* 隐私模式等读不到就跟随系统 */ }
  return 'system';
}

const systemLight = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches;

export function resolveTheme(p: ThemePref): Theme {
  return p === 'system' ? (systemLight() ? 'light' : 'dark') : p;
}

let pref: ThemePref = 'system';

function apply() {
  const root = document.documentElement;
  const next = resolveTheme(pref);
  if (root.dataset.theme === next) return;
  // 切换那一刻所有颜色一起过渡，避免各层先后变色
  root.classList.add('cz-theme-fade');
  root.dataset.theme = next;
  window.setTimeout(() => root.classList.remove('cz-theme-fade'), 320);
}

export function getThemePref(): ThemePref {
  return pref;
}

export function setThemePref(p: ThemePref) {
  pref = p;
  try { localStorage.setItem(KEY, p); } catch { /* 存不下就只在本次生效 */ }
  apply();
  for (const l of listeners) l(p);
}

export function onThemePref(fn: (p: ThemePref) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 读出保存的选择并立即应用；跟随系统时监听系统深浅变化 */
export function installTheme() {
  pref = read();
  document.documentElement.dataset.theme = resolveTheme(pref);
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (pref === 'system') apply(); });
  }
}
