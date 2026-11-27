// 屏幕常亮锁：通话模式与单次语音录音共用（引用计数）。
// 同时尝试 Web Wake Lock API 与 Android 原生桥 window.CosyeeNative.keepScreenOn，
// 页面从后台切回可见时自动重新申请 Wake Lock。

interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
}

interface NavigatorWithWakeLock {
  wakeLock?: {
    request(type: 'screen'): Promise<WakeLockSentinelLike>;
  };
}

let holders = 0;
let sentinel: WakeLockSentinelLike | null = null;
let requesting = false;
let listening = false;

function setNativeKeepScreenOn(on: boolean): void {
  try {
    if (typeof window !== 'undefined') window.CosyeeNative?.keepScreenOn?.(on);
  } catch {
    /* 原生桥不可用或抛错时忽略 */
  }
}

async function requestSentinel(): Promise<void> {
  if (holders <= 0 || requesting) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const wl = typeof navigator !== 'undefined' ? (navigator as unknown as NavigatorWithWakeLock).wakeLock : undefined;
  if (!wl?.request) return;
  requesting = true;
  try {
    const s = await wl.request('screen');
    if (holders <= 0) {
      void s.release().catch(() => {});
      return;
    }
    sentinel = s;
  } catch {
    /* 系统拒绝或不支持时忽略 */
  } finally {
    requesting = false;
  }
}

function releaseSentinel(): void {
  const s = sentinel;
  sentinel = null;
  if (s) void s.release().catch(() => {});
}

function onVisibilityChange(): void {
  if (holders <= 0) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    setNativeKeepScreenOn(true);
    if (!sentinel || sentinel.released) void requestSentinel();
  }
}

/** 申请保持屏幕常亮；返回幂等的释放函数 */
export function acquireWakeLock(): () => void {
  let released = false;
  holders++;
  if (holders === 1) {
    setNativeKeepScreenOn(true);
    void requestSentinel();
    if (!listening && typeof document !== 'undefined') {
      listening = true;
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) {
      if (listening && typeof document !== 'undefined') {
        listening = false;
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
      releaseSentinel();
      setNativeKeepScreenOn(false);
    }
  };
}
