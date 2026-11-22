// 本地文件预览的上下文：会话里的路径链接 / 工具行 / 头部路径通过它打开预览、在文件管理器显示、打开终端。
// 没有 Provider（例如 dev 页面、单元测试里单独渲染组件）时 useFiles() 返回 null，各处退化为不可点击的纯文本。
import { createContext, useContext } from 'react';

export interface FileOpenRequest {
  /** 路径：绝对路径 / 相对会话工作目录 / `~/`（已解码，原样的文件系统路径） */
  path: string;
  line?: number;
}

export interface FilesApi {
  /** 当前会话的工作目录：相对路径据此解析出完整路径（只用于展示，真正的授权在服务端） */
  cwd: string;
  /** 当前会话 id：附件标签的预览信息（大小 / 缩略图）按它向服务端请求 */
  session?: string;
  /** 打开预览浮窗；opener 是触发它的元素，关闭后焦点还给它 */
  open: (req: FileOpenRequest, opener?: HTMLElement | null) => void;
  /**
   * 在文件管理器中显示 / 在此处打开终端。远程连接时两者都没有：窗口会弹在服务端机器的桌面上，
   * 远程设备看不到，对应按钮直接隐藏。
   */
  reveal?: (path: string) => void;
  terminal?: (path: string) => void;
}

export const FilesContext = createContext<FilesApi | null>(null);

export const useFiles = (): FilesApi | null => useContext(FilesContext);
