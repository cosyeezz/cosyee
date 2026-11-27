// 内置终端面板偏好：开关状态与停靠高度，持久化到 localStorage（键名 cz-terminal）。
export const TERMINAL_PREFS_KEY = 'cz-terminal';

export const TERMINAL_MIN_HEIGHT = 180;
export const TERMINAL_DEFAULT_HEIGHT = 300;

export interface TerminalPrefs {
  open: boolean;
  height: number;
}

export function clampTerminalHeight(height: number, maxHeight?: number): number {
  const cap = typeof maxHeight === 'number' && Number.isFinite(maxHeight)
    ? Math.max(TERMINAL_MIN_HEIGHT, Math.floor(maxHeight))
    : 900;
  const h = Number.isFinite(height) ? Math.round(height) : TERMINAL_DEFAULT_HEIGHT;
  return Math.max(TERMINAL_MIN_HEIGHT, Math.min(cap, h));
}

export function readTerminalPrefs(): TerminalPrefs {
  try {
    const raw = localStorage.getItem(TERMINAL_PREFS_KEY);
    if (!raw) return { open: false, height: TERMINAL_DEFAULT_HEIGHT };
    const v = JSON.parse(raw) as Partial<Record<keyof TerminalPrefs, unknown>>;
    const height = typeof v.height === 'number' && Number.isFinite(v.height) && v.height >= TERMINAL_MIN_HEIGHT
      ? Math.round(v.height)
      : TERMINAL_DEFAULT_HEIGHT;
    return {
      open: v.open === true,
      height,
    };
  } catch {
    return { open: false, height: TERMINAL_DEFAULT_HEIGHT };
  }
}

export function saveTerminalPrefs(p: TerminalPrefs): void {
  try {
    localStorage.setItem(
      TERMINAL_PREFS_KEY,
      JSON.stringify({
        open: !!p.open,
        height: Math.max(TERMINAL_MIN_HEIGHT, Math.round(p.height)),
      }),
    );
  } catch {
    /* localStorage 不可用时忽略 */
  }
}
