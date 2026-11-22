// 文件预览接口（/api/files/*）的数据结构，前后端共用。

export type FilePreviewKind = 'markdown' | 'code' | 'text' | 'image' | 'pdf' | 'directory' | 'unsupported';

export interface FileEntry {
  name: string;
  isDir: boolean;
}

export interface FilePreview {
  name: string;
  /** 绝对路径（服务端解析后的，不含行号 / 锚点） */
  path: string;
  size: number;
  /** 修改时间，毫秒时间戳 */
  mtime: number;
  kind: FilePreviewKind;
  /** markdown / code / text：已解码的文本 */
  text?: string;
  /** 文本编码，如 `UTF-8`、`GB18030 · 自动识别` */
  encoding?: string;
  /** highlight.js 语言名 */
  language?: string;
  /** 链接里带的行号（`a.ts:12` / `#L12`） */
  line?: number;
  /** 链接里带的锚点（`#section`） */
  fragment?: string;
  /** image：媒体类型，如 image/png */
  mimeType?: string;
  /** unsupported：不能预览的原因 */
  reason?: string;
  /** directory：子项（目录在前，最多 500 项） */
  entries?: FileEntry[];
  /** directory：子项超过上限被截断 */
  truncated?: boolean;
}

/**
 * 网页版选择窗口（远程连接时代替服务端桌面上的系统对话框）：GET /api/browse?path= 列出服务端的一个目录。
 * path 为空时从当前工作空间（没有则主目录）开始。
 */
export interface BrowseDir {
  /** 绝对路径 */
  path: string;
  /** 上一级；已在根上为 null */
  parent: string | null;
  /** 目录在前，按名称排序 */
  entries: FileEntry[];
  /** 子项超过上限被截断 */
  truncated?: boolean;
  /** 可切换的根：Windows 为现有盘符（`C:\`），其它系统为 `/` */
  roots: string[];
}
