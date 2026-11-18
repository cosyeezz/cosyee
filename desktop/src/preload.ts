// 主窗口 preload（contextIsolation + sandbox）：只暴露平台信息和「打开设置窗口」。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cosyeeDesktop', {
  platform: process.platform,
  /** 打开「地址和端口」设置窗口（主进程会校验调用方是本站页面） */
  openSettings: (): void => {
    void ipcRenderer.invoke('desktop:open-settings');
  },
});
