// 设置窗口专用 preload：只暴露设置相关的几个 IPC 调用。主窗口（加载后端页面）的 preload 不含这些。
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('cosyeeSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (host: string, port: number) => ipcRenderer.invoke('settings:save', host, port),
  regenToken: () => ipcRenderer.invoke('settings:regen'),
  close: () => ipcRenderer.invoke('settings:close'),
});
