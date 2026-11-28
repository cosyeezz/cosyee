// 扫描屏幕二维码的能力探测与取帧：
//  - native：桌面客户端注入的 window.__cosyeeScreenQr，自带框选并直接返回识别结果；
//  - display：浏览器 getDisplayMedia 取一帧，由页面内的框选层识别；
//  - browserFrame：内置浏览器面板正在绘制的画布，拷贝其当前像素。

/** 桌面客户端注入的原生屏幕二维码扫描 */
export interface CosyeeScreenQr {
  available: boolean;
  scan(): Promise<
    | { status: 'ok'; texts: string[] }
    | { status: 'cancelled' }
    | { status: 'error'; message: string }
  >;
}

declare global {
  interface Window {
    __cosyeeScreenQr?: CosyeeScreenQr;
  }
}

export type ScanSourceKind = 'native' | 'display' | 'browserFrame';

export interface ScanSourceStatus {
  available: boolean;
  /** 不可用时给用户看的原因（中文） */
  reason?: string;
}

export type ScanAvailability = Record<ScanSourceKind, ScanSourceStatus>;

/** 内置浏览器画布的选择器（BrowserView.tsx 里的 canvas 带这个属性） */
export const BROWSER_CANVAS_SELECTOR = 'canvas[data-cosyee-browser-canvas]';

export const MSG_HTTP_BLOCKED = '当前通过 HTTP 访问，浏览器不允许截取屏幕。可使用桌面客户端或 HTTPS 地址';
export const MSG_BROWSER_CLOSED = '先打开内置浏览器面板';

function findBrowserCanvas(): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const el = document.querySelector<HTMLCanvasElement>(BROWSER_CANVAS_SELECTOR);
  return el && el.width > 0 && el.height > 0 ? el : null;
}

export function getScanAvailability(): ScanAvailability {
  const nativeBridge = typeof window !== 'undefined' ? window.__cosyeeScreenQr : undefined;
  const native: ScanSourceStatus = nativeBridge?.available
    ? { available: true }
    : { available: false, reason: nativeBridge ? '桌面客户端的屏幕扫描当前不可用' : '仅桌面客户端支持' };

  let display: ScanSourceStatus;
  if (typeof window === 'undefined' || !window.isSecureContext) {
    display = { available: false, reason: MSG_HTTP_BLOCKED };
  } else if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    display = { available: false, reason: '当前浏览器不支持截取屏幕（手机浏览器通常不支持）' };
  } else {
    display = { available: true };
  }

  const browserFrame: ScanSourceStatus = findBrowserCanvas()
    ? { available: true }
    : { available: false, reason: MSG_BROWSER_CLOSED };

  return { native, display, browserFrame };
}

/** 取帧结果：canvas 的像素尺寸即原始帧尺寸 */
export interface ScreenFrame {
  canvas: HTMLCanvasElement;
  source: 'display' | 'browserFrame';
}

export class ScreenCaptureError extends Error {
  constructor(
    message: string,
    /** cancelled = 用户在系统选择器里取消 */
    public readonly code: 'cancelled' | 'unsupported' | 'failed',
  ) {
    super(message);
    this.name = 'ScreenCaptureError';
  }
}

/** 调用桌面客户端的原生扫描 */
export async function scanNative(): ReturnType<CosyeeScreenQr['scan']> {
  const bridge = window.__cosyeeScreenQr;
  if (!bridge?.available) return { status: 'error', message: '桌面客户端的屏幕扫描不可用' };
  try {
    return await bridge.scan();
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : '屏幕扫描失败' };
  }
}

/** 用 getDisplayMedia 抓取一帧并立刻停止所有轨道（系统的「正在共享」提示随之消失） */
export async function grabDisplayFrame(): Promise<ScreenFrame> {
  const av = getScanAvailability().display;
  if (!av.available) throw new ScreenCaptureError(av.reason ?? '无法截取屏幕', 'unsupported');

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      throw new ScreenCaptureError('已取消选择屏幕', 'cancelled');
    }
    throw new ScreenCaptureError(e instanceof Error ? e.message : '截取屏幕失败', 'failed');
  }

  const stop = () => stream.getTracks().forEach((t) => t.stop());
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('等待屏幕画面超时')), 6000);
      video.onloadedmetadata = () => {
        window.clearTimeout(timer);
        resolve();
      };
      video.onerror = () => {
        window.clearTimeout(timer);
        reject(new Error('屏幕画面读取失败'));
      };
    });
    await video.play();
    // 共享刚开始时前几帧可能是黑的：等到真正出帧（或最多 450ms）
    await new Promise<void>((resolve) => {
      const cap = window.setTimeout(resolve, 450);
      const rvfc = (video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
      }).requestVideoFrameCallback;
      if (rvfc) {
        rvfc.call(video, () => {
          window.setTimeout(() => {
            window.clearTimeout(cap);
            resolve();
          }, 60);
        });
      }
    });
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) throw new Error('屏幕画面为空');
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('无法创建画布');
    ctx.drawImage(video, 0, 0, w, h);
    video.srcObject = null;
    return { canvas, source: 'display' };
  } catch (e) {
    throw e instanceof ScreenCaptureError ? e : new ScreenCaptureError(e instanceof Error ? e.message : '截取屏幕失败', 'failed');
  } finally {
    stop();
  }
}

/** 拷贝内置浏览器画布的当前像素；面板未打开 / 尺寸为 0 时返回 null */
export function grabBrowserFrame(): ScreenFrame | null {
  const src = findBrowserCanvas();
  if (!src) return null;
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(src, 0, 0);
  return { canvas, source: 'browserFrame' };
}
