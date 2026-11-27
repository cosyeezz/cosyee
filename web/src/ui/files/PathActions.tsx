// 本地路径的操作按钮（复制 / 在文件管理器显示 / 在此处打开终端）与带操作的路径行。
// 按钮默认隐藏，悬停所在行（cz-pathact-host）或键盘聚焦时出现；触屏常显且热区 ≥44px（见 files.css）。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { copyText } from '../../core/browser';
import { Icon, type IconName } from '../icons/Icon';
import { useFiles } from './FileContext';
import './files.css';

/** 复制成功后对勾保持多久（ms） */
const COPIED_MS = 1500;

/** 复制按钮：复制完整文本，成功后显示对勾约 1.5 秒；可键盘聚焦 */
export function CopyButton({
  text,
  label,
  className = 'cz-pathact',
  glyph,
  children,
}: {
  text: string;
  label: string;
  className?: string;
  /** 整块可点的「图标 + 文字」形态：平时显示这个图标，悬停 / 聚焦时换成复制图标，复制后是对勾 */
  glyph?: IconName;
  /** 跟在图标后面的文字（带 glyph 时使用） */
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = async () => {
    if (!(await copyText(text))) return; // 剪贴板不可用：静默，不显示对勾
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPIED_MS);
  };
  return (
    <button
      type="button"
      className={`${className}${copied ? ' is-copied' : ''}`}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : glyph ? `${text}
点击复制` : label}
      onClick={() => void onCopy()}
    >
      {glyph ? (
        <>
          <span className="cz-copyslot" aria-hidden="true">
            <Icon name={glyph} size={14} className="cz-copyslot__glyph" />
            <Icon name={copied ? 'check' : 'copy'} size={14} className="cz-copyslot__act" />
          </span>
          {children}
        </>
      ) : (
        <Icon name={copied ? 'check' : 'copy'} size={14} />
      )}
    </button>
  );
}

export interface PathActionsProps {
  /** 要操作的路径（绝对路径；目录也可以） */
  path: string;
  /** 复制按钮的类名（SessionHeader 沿用自己的 cz-header__copy） */
  copyClassName?: string;
  /** 复制按钮的无障碍名称 */
  copyLabel?: string;
  /** 隐藏默认的系统终端按钮（例如 SessionHeader 改为挂载应用内终端入口） */
  hideTerminal?: boolean;
  /** 不渲染复制按钮（调用方自己把路径做成了可点击复制的整块） */
  hideCopy?: boolean;
}

/** 复制 + 在文件管理器中显示 + 在此处打开终端。没有 FilesContext 或远程连接时只有复制。 */
export function PathActions({ path, copyClassName, copyLabel = '复制路径', hideTerminal = false, hideCopy = false }: PathActionsProps) {
  const files = useFiles();
  return (
    <>
      {!hideCopy && <CopyButton text={path} label={copyLabel} className={copyClassName} />}
      {files && (
        <>
          {files.reveal && (
            <button type="button" className="cz-pathact" aria-label="在文件管理器中显示" title="在文件管理器中显示" onClick={() => files.reveal?.(path)}>
              <Icon name="folder-reveal" size={14} />
            </button>
          )}
          {!hideTerminal && files.terminal && (
            <button type="button" className="cz-pathact" aria-label="在此处打开终端" title="在此处打开终端" onClick={() => files.terminal?.(path)}>
              <Icon name="terminal" size={14} />
            </button>
          )}
        </>
      )}
    </>
  );
}

/** 一行本地路径：完整路径做 tooltip，过长省略，右侧是操作按钮 */
export function LocalPath({ path, className }: { path: string; className?: string }) {
  return (
    <span className={`cz-localpath cz-pathact-host${className ? ' ' + className : ''}`}>
      <span className="cz-localpath__text" title={path}>
        {path}
      </span>
      <PathActions path={path} />
    </span>
  );
}
