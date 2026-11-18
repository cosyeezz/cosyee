// 工作空间下拉：每行一个文件夹图标，当前行高亮；悬停出现 复制路径 / 打开文件夹 / 置于顶部 / 从列表移除。
// 「从列表移除」只改 Cosyee 自己的最近列表，不会动磁盘上的文件。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Workspace } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { ActionButton, ConfirmActionButton } from './ActionButtons';
import { samePath } from './sidebarUtil';
import { useDismiss } from './useDismiss';

export interface WorkspaceMenuProps {
  workspaces: Workspace[];
  currentWorkspace: string | null;
  onSelectWorkspace: (path: string) => void;
  onOpenFolder: () => void;
  onMoveToTop: (path: string) => void;
  onRemove: (path: string) => void;
  onReveal: (path: string) => void;
}

/** 复制到剪贴板；失败（比如没有权限）时静默返回 false */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function WorkspaceMenu({
  workspaces,
  currentWorkspace,
  onSelectWorkspace,
  onOpenFolder,
  onMoveToTop,
  onRemove,
  onReveal,
}: WorkspaceMenuProps) {
  const [open, setOpen] = useState(false);
  /** 刚复制过路径的那一行（图标短暂变成对勾） */
  const [copied, setCopied] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, wrapRef, close);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const current = workspaces.find((w) => samePath(w.path, currentWorkspace)) ?? null;

  const copy = (path: string) => {
    void copyText(path).then((ok) => {
      if (!ok) return;
      setCopied(path);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(null), 1200);
    });
  };

  return (
    <div className="cz-sidebar__ws" ref={wrapRef}>
      <button
        type="button"
        className={`cz-sidebar__ws-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title={current?.path}
      >
        <Icon name="folder" size={16} />
        <span className="cz-sidebar__ws-name">{current?.name ?? '选择工作空间'}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
      </button>

      {open && (
        <div className="cz-sidebar__menu" role="group" aria-label="工作空间">
          <div className="cz-sidebar__menu-list">
            {workspaces.map((w) => {
              const active = samePath(w.path, currentWorkspace);
              return (
                <div key={w.path} className={`cz-sidebar__menu-item${active ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="cz-sidebar__menu-main"
                    title={w.path}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => {
                      setOpen(false);
                      if (!active) onSelectWorkspace(w.path);
                    }}
                  >
                    <span className="cz-sidebar__menu-icon">
                      <Icon name="folder" size={16} />
                    </span>
                    <span className="cz-sidebar__menu-text">
                      <span className="cz-sidebar__menu-name">{w.name}</span>
                      <span className="cz-sidebar__menu-path">{w.path}</span>
                    </span>
                  </button>
                  <div className="cz-sidebar__actions">
                    <ActionButton
                      icon={copied === w.path ? 'check' : 'copy'}
                      label={copied === w.path ? '已复制' : '复制路径'}
                      onClick={() => copy(w.path)}
                    />
                    <ActionButton icon="folder-reveal" label="打开工作空间文件夹" onClick={() => onReveal(w.path)} />
                    <ActionButton icon="pin" label="置于顶部" onClick={() => onMoveToTop(w.path)} />
                    <ConfirmActionButton
                      icon="trash"
                      label="从列表中移除"
                      confirmText="从列表中移除此工作空间？"
                      note="只是不再显示在这里，不会删除磁盘上的任何文件"
                      confirmLabel="移除"
                      onConfirm={() => onRemove(w.path)}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div className="cz-sidebar__menu-sep" />
          <div className="cz-sidebar__menu-item">
            <button
              type="button"
              className="cz-sidebar__menu-main"
              onClick={() => {
                setOpen(false);
                onOpenFolder();
              }}
            >
              <span className="cz-sidebar__menu-icon">
                <Icon name="folder-open" size={16} />
              </span>
              <span className="cz-sidebar__menu-text">
                <span className="cz-sidebar__menu-name">打开文件夹…</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
