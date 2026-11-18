// 左侧栏：新建会话 + 收起 / 搜索 / 置顶 / 工作空间切换与会话列表 / 已删除 / 账户栏。
// 受控组件，数据与回调全部来自 props；搜索词是纯界面状态，留在组件内。
import { useState } from 'react';
import type { Account, DeletedSession, SessionSummary, Workspace } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { AccountMenu } from './AccountMenu';
import { DeletedSection } from './DeletedSection';
import { SearchRow } from './SearchRow';
import { SessionRow } from './SessionRow';
import { excludePinned, filterByTitle, workspaceName } from './sidebarUtil';
import { WorkspaceMenu } from './WorkspaceMenu';
import './Sidebar.css';

export interface SidebarProps {
  workspaces: Workspace[];
  /** 当前工作空间的路径；null 表示尚未选择 */
  currentWorkspace: string | null;
  /** 当前工作空间的会话（已按 lastActiveAt 倒序；已置顶的会由组件自己去掉） */
  sessions: SessionSummary[];
  /** 置顶的会话（全局，可来自任何工作空间；手动在前、自动在后） */
  pinned: SessionSummary[];
  /** 已删除的会话（全局） */
  deleted: DeletedSession[];
  currentSessionId: string | null;
  account: Account | null;
  /** 账号信息有变化但没有整页刷新时递增（并行模式下切换新会话用的账号等）：账号菜单重新读取 */
  accountVersion?: number;
  onNewSession: () => void;
  onCollapse: () => void;
  onSelectWorkspace: (path: string) => void;
  onOpenFolder: () => void;
  onMoveWorkspaceTop: (path: string) => void;
  /** 仅从 Cosyee 的最近列表移除，不动磁盘 */
  onRemoveWorkspace: (path: string) => void;
  /** 在系统文件管理器里打开 */
  onRevealWorkspace: (path: string) => void;
  onSelectSession: (id: string) => void;
  /** 置顶 / 取消置顶（按 s.pinned 判断当前状态） */
  onTogglePin: (s: SessionSummary) => void;
  onDeleteSession: (s: SessionSummary) => void;
  onRestoreSession: (id: string) => void;
  onPurgeSession: (id: string) => void;
}

export function Sidebar({
  workspaces,
  currentWorkspace,
  sessions,
  pinned,
  deleted,
  currentSessionId,
  account,
  accountVersion = 0,
  onNewSession,
  onCollapse,
  onSelectWorkspace,
  onOpenFolder,
  onMoveWorkspaceTop,
  onRemoveWorkspace,
  onRevealWorkspace,
  onSelectSession,
  onTogglePin,
  onDeleteSession,
  onRestoreSession,
  onPurgeSession,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  const now = Date.now();

  const pinnedShown = filterByTitle(pinned, query);
  const listShown = filterByTitle(excludePinned(sessions, pinned), query);
  const searching = query.trim() !== '';

  const rowProps = { now, onSelect: onSelectSession, onTogglePin, onDelete: onDeleteSession };

  return (
    <div className="cz-sidebar">
      {/* 顶部：新建会话 + 收起，同一行 */}
      <div className="cz-sidebar__top">
        <button type="button" className="cz-sidebar__nav cz-sidebar__nav--new" onClick={onNewSession}>
          <Icon name="new-chat" size={16} className="cz-sidebar__new-icon" />
          <span>新建会话</span>
        </button>
        <button
          type="button"
          className="cz-sidebar__icon-btn"
          onClick={onCollapse}
          title="收起侧栏"
          aria-label="收起侧栏"
        >
          <Icon name="sidebar-collapse" size={18} />
        </button>
      </div>

      <SearchRow value={query} onChange={setQuery} />

      {/* 置顶：全局，不随工作空间变化；没有置顶（或搜索无匹配）时整块隐藏 */}
      {pinnedShown.length > 0 && (
        <section className="cz-sidebar__pinned" aria-label="置顶">
          <div className="cz-sidebar__section-title">置顶</div>
          <div role="list" className="cz-sidebar__pinned-list">
            {pinnedShown.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === currentSessionId}
                workspaceLabel={workspaceName(s.cwd, workspaces)}
                {...rowProps}
              />
            ))}
          </div>
        </section>
      )}

      {/* 工作空间切换 */}
      <WorkspaceMenu
        workspaces={workspaces}
        currentWorkspace={currentWorkspace}
        onSelectWorkspace={onSelectWorkspace}
        onOpenFolder={onOpenFolder}
        onMoveToTop={onMoveWorkspaceTop}
        onRemove={onRemoveWorkspace}
        onReveal={onRevealWorkspace}
      />

      {/* 会话列表 */}
      <div className="cz-sidebar__list" role="list">
        {listShown.length === 0 ? (
          <div className="cz-sidebar__empty">
            {searching ? (pinnedShown.length > 0 ? '当前工作空间没有匹配的会话' : '没有匹配的会话') : '暂无会话'}
          </div>
        ) : (
          listShown.map((s) => <SessionRow key={s.id} session={s} active={s.id === currentSessionId} {...rowProps} />)
        )}
      </div>

      {/* 已删除（折叠时只占一行，在账户栏正上方） */}
      <DeletedSection deleted={deleted} workspaces={workspaces} onRestore={onRestoreSession} onPurge={onPurgeSession} />

      {/* 底部账户栏 */}
      <div className="cz-sidebar__account">
        <AccountMenu account={account} version={accountVersion} />
        <button
          type="button"
          className="cz-sidebar__icon-btn"
          title="设置"
          aria-label="设置"
          // 桌面版（Electron preload 暴露 cosyeeDesktop）里打开「地址和端口」设置窗口；网页版没有这个对象，按钮保持原样（无动作）
          onClick={() => (window as unknown as { cosyeeDesktop?: { openSettings?: () => void } }).cosyeeDesktop?.openSettings?.()}
        >
          <Icon name="settings" size={18} />
        </button>
      </div>
    </div>
  );
}
