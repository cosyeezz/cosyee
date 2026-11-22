// 会话里的本地文件链接：文件图标 + 文字，悬停显示完整路径，点击打开预览浮窗。
// 没有 FilesContext 时是不可点击的纯文本（不渲染按钮，避免点了没反应）。
import type { ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import { useFiles } from './FileContext';
import './files.css';

export interface FilePathLinkProps {
  /** 解析后的完整路径（tooltip 与打开用） */
  path: string;
  line?: number;
  children: ReactNode;
}

export function FilePathLink({ path, line, children }: FilePathLinkProps) {
  const files = useFiles();
  const title = line ? `${path}:${line}` : path;
  if (!files) {
    return (
      <span className="cz-filelink is-static" title={title}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="cz-filelink"
      title={title}
      data-file-path={path}
      onClick={(e) => files.open({ path, ...(line ? { line } : {}) }, e.currentTarget)}
    >
      <Icon name="file" size={14} className="cz-filelink__icon" />
      <span className="cz-filelink__text">{children}</span>
    </button>
  );
}
