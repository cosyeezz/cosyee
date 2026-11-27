/** Electron 桌面版 preload 注入的 API（浏览器里访问时不存在） */
interface CosyeeDesktop {
  platform: string;
  openSettings(): void;
  /** 用 Electron 原生 dialog.showOpenDialog 选文件/文件夹 */
  pick(mode: string, title: string, startDir: string): Promise<string[]>;
}

interface CosyeeNative {
  keepScreenOn?(on: boolean): void;
}

interface Window {
  cosyeeDesktop?: CosyeeDesktop;
  CosyeeNative?: CosyeeNative;
}
