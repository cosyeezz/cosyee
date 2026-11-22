// 「已删除」区：默认折叠，在账户栏正上方。展开后有自己的搜索行和一个有最大高度的滚动列表。
// 软删除只是从列表隐藏；这里可以恢复，或「永久删除」（真正删除会话记录文件，不可撤销）。
// 标题行悬停出现两个批量操作：全部恢复 / 全部永久删除。作用于当前显示的那些——搜索时只是匹配的，
// 收起时清空搜索词，所以收起状态下就是全部。
import { useState } from 'react';
import type { DeletedSession, Workspace } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { ActionButton, ConfirmActionButton } from './ActionButtons';
import { SearchRow } from './SearchRow';
import { displayTitle, filterByTitle, workspaceName } from './sidebarUtil';

export interface DeletedSectionProps {
  deleted: DeletedSession[];
  workspaces: Workspace[];
  onRestore: (id: string) => void;
  onPurge: (id: string) => void;
  onRestoreMany: (ids: string[]) => void;
  onPurgeMany: (ids: string[]) => void;
}

export function DeletedSection({ deleted, workspaces, onRestore, onPurge, onRestoreMany, onPurgeMany }: DeletedSectionProps) {
  // 展开状态只在内存里，刷新后回到折叠
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const shown = filterByTitle(deleted, query);
  const ids = shown.map((d) => d.id);
  const filtered = query.trim() !== '';

  const toggle = () => {
    if (open) setQuery('');
    setOpen(!open);
  };

  return (
    <div className="cz-sidebar__deleted">
      <div className={`cz-sidebar__deleted-bar${ids.length > 0 ? ' has-actions' : ''}`}>
        <button type="button" className="cz-sidebar__deleted-head" onClick={toggle} aria-expanded={open}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          <span>已删除 ({deleted.length})</span>
        </button>
        {ids.length > 0 && (
          <div className="cz-sidebar__actions">
            <ConfirmActionButton
              icon="restore"
              label={filtered ? '恢复匹配的会话' : '全部恢复'}
              confirmText={filtered ? `恢复匹配的 ${ids.length} 个会话？` : `恢复全部 ${ids.length} 个会话？`}
              note="会回到各自工作空间的列表里"
              confirmLabel="全部恢复"
              safe
              requireConfirm
              onConfirm={() => onRestoreMany(ids)}
            />
            <ConfirmActionButton
              icon="trash"
              label={filtered ? '永久删除匹配的会话' : '全部永久删除'}
              confirmText={filtered ? `永久删除匹配的 ${ids.length} 个会话？` : `永久删除全部 ${ids.length} 个会话？`}
              note="会话记录将被彻底删除，无法撤销"
              confirmLabel="永久删除"
              requireConfirm
              onConfirm={() => onPurgeMany(ids)}
            />
          </div>
        )}
      </div>

      {open && (
        <div className="cz-sidebar__deleted-body">
          <SearchRow value={query} onChange={setQuery} ariaLabel="搜索已删除的会话" />
          <div className="cz-sidebar__deleted-list" role="list">
            {deleted.length === 0 ? (
              <div className="cz-sidebar__empty">没有已删除的会话</div>
            ) : shown.length === 0 ? (
              <div className="cz-sidebar__empty">没有匹配的会话</div>
            ) : (
              shown.map((d) => {
                const ws = workspaceName(d.cwd, workspaces);
                return (
                  <div key={d.id} role="listitem" className="cz-sidebar__row has-sub is-deleted">
                    <div className="cz-sidebar__row-main cz-sidebar__row-main--static" title={`${displayTitle(d.title)}\n${ws}`}>
                      <span className="cz-sidebar__row-body">
                        <span className="cz-sidebar__row-title">{displayTitle(d.title)}</span>
                        <span className="cz-sidebar__row-sub">{ws}</span>
                      </span>
                    </div>
                    <div className="cz-sidebar__actions">
                      <ActionButton icon="restore" label="恢复" onClick={() => onRestore(d.id)} />
                      <ConfirmActionButton
                        icon="trash"
                        label="永久删除"
                        confirmText="永久删除此会话？"
                        note="会话记录将被彻底删除，无法撤销"
                        confirmLabel="永久删除"
                        onConfirm={() => onPurge(d.id)}
                      />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
