// 左侧栏：新建会话 + 收起 / 搜索 / 置顶 / 按工作空间分组的会话列表 / 已删除 / 账户栏。
// 工作空间的选择在新会话的输入框左下角（WorkspaceMenu），不在侧栏里。
// 批量操作放在各自区块的标题行上（悬停出现）：工作空间组头 = 删除这一组的全部会话；已删除标题 = 全部恢复 / 全部永久删除。
// 受控组件，数据与回调全部来自 props；搜索词是纯界面状态，留在组件内。
import { startTransition, useEffect, useState } from 'react';
import type { Account, DeletedSession, SessionSummary, Workspace } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { AccountMenu } from './AccountMenu';
import { ConfirmActionButton } from './ActionButtons';
import { DeletedSection } from './DeletedSection';
import { SearchRow } from './SearchRow';
import { SessionCardProvider, useSessionCard } from './SessionCard';
import { SessionRow } from './SessionRow';
import { excludePinned, filterByTitle, groupByWorkspace, samePath, workspaceName } from './sidebarUtil';
import { LiquidCapsule } from '../motion/LiquidCapsule';
import './Sidebar.css';

/** 选中的会话行：液态玻璃胶囊垫在它下面 */
const ACTIVE_ROW = '.cz-sidebar__row.is-active';

export interface SidebarProps {
  workspaces: Workspace[];
  /** 所有工作空间的会话（每个工作空间内已按 lastActiveAt 倒序；已置顶的会由组件自己去掉，按 cwd 分组显示） */
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
  onSelectSession: (id: string) => void;
  /** 置顶 / 取消置顶（按 s.pinned 判断当前状态） */
  onTogglePin: (s: SessionSummary) => void;
  onDeleteSession: (s: SessionSummary) => void;
  onRestoreSession: (id: string) => void;
  onPurgeSession: (id: string) => void;
  /** 工作空间组头的「删除全部会话」：cwd + 组里当前显示、且不在执行中的会话 id */
  onDeleteSessions: (cwd: string, ids: string[]) => void;
  /** 已删除区头部的批量操作：当前显示的（搜索时只是匹配的）那些 id */
  onRestoreSessions: (ids: string[]) => void;
  onPurgeSessions: (ids: string[]) => void;
}

export function Sidebar({
  workspaces,
  sessions,
  pinned,
  deleted,
  currentSessionId,
  account,
  accountVersion = 0,
  onNewSession,
  onCollapse,
  onSelectSession,
  onTogglePin,
  onDeleteSession,
  onRestoreSession,
  onPurgeSession,
  onDeleteSessions,
  onRestoreSessions,
  onPurgeSessions,
}: SidebarProps) {
  const [query, setQuery] = useState('');
  /** 被折叠的工作空间分组（路径）；默认全部展开。搜索时一律展开，免得匹配的会话被藏起来 */
  const [folded, setFolded] = useState<string[]>([]);
  const now = Date.now();

  // 点击会话时先在侧栏里把高亮挪过去（只重渲染侧栏，胶囊立刻开始流动），
  // 再用 transition 让主区去换对话：重的那次提交不会挡住点击反馈。
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [seenId, setSeenId] = useState(currentSessionId);
  if (seenId !== currentSessionId) {
    setSeenId(currentSessionId);
    setPendingId(null);
  }
  useEffect(() => {
    if (pendingId === null) return;
    const t = setTimeout(() => setPendingId(null), 1500);
    return () => clearTimeout(t);
  }, [pendingId]);
  const activeId = pendingId ?? currentSessionId;
  const selectSession = (id: string) => {
    if (id === currentSessionId) {
      onSelectSession(id);
      return;
    }
    setPendingId(id);
    startTransition(() => onSelectSession(id));
  };

  const pinnedShown = filterByTitle(pinned, query);
  const searching = query.trim() !== '';
  // 先去掉置顶、按标题过滤，再按工作空间分组；搜索时没有匹配的分组整组隐藏
  const groups = groupByWorkspace(filterByTitle(excludePinned(sessions, pinned), query), workspaces).filter(
    (g) => !searching || g.sessions.length > 0,
  );
  const listEmpty = groups.every((g) => g.sessions.length === 0);
  const toggleGroup = (path: string) =>
    setFolded((f) => (f.some((p) => samePath(p, path)) ? f.filter((p) => !samePath(p, path)) : [...f, path]));

  const rowProps = { now, onSelect: selectSession, onTogglePin, onDelete: onDeleteSession };

  return (
    <SessionCardProvider workspaces={workspaces} placement="side">
      <div className="cz-sidebar">
        {/* 顶部：新建会话 + 收起，同一行 */}
        <div className="cz-sidebar__top">
          <button type="button" className="cz-sidebar__nav cz-sidebar__nav--new" onClick={onNewSession}>
            <Icon name="new-chat" size={16} className="cz-sidebar__new-icon" />
            <span>新建会话</span>
          </button>
          <CollapseButton onCollapse={onCollapse} />
        </div>

      <SearchRow value={query} onChange={setQuery} />

      {/* 置顶：全局，不随工作空间变化；没有置顶（或搜索无匹配）时整块隐藏 */}
      {pinnedShown.length > 0 && (
        <section className="cz-sidebar__pinned" aria-label="置顶">
          <div className="cz-sidebar__section-title">置顶</div>
          <div role="list" className="cz-sidebar__pinned-list">
            <LiquidCapsule activeKey={activeId} selector={ACTIVE_ROW} />
            {pinnedShown.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                active={s.id === activeId}
                workspaceLabel={workspaceName(s.cwd, workspaces)}
                {...rowProps}
              />
            ))}
          </div>
        </section>
      )}

      {/* 会话列表：按工作空间分组 */}
      <div className="cz-sidebar__list">
        <LiquidCapsule activeKey={activeId} selector={ACTIVE_ROW} />
        {listEmpty ? (
          <div className="cz-sidebar__empty">
            {searching ? (pinnedShown.length > 0 ? '其他会话里没有匹配的' : '没有匹配的会话') : '暂无会话'}
          </div>
        ) : (
          groups.map((g) => {
            const open = searching || !folded.some((p) => samePath(p, g.path));
            return (
              <section key={g.path} className="cz-sidebar__group" aria-label={g.name}>
                <div className={`cz-sidebar__group-bar${g.sessions.length > 0 ? ' has-actions' : ''}`}>
                  <button
                    type="button"
                    className="cz-sidebar__group-head"
                    onClick={() => toggleGroup(g.path)}
                    aria-expanded={open}
                    title={g.path}
                  >
                    <Icon name="folder" size={15} />
                    <span className="cz-sidebar__group-name">{g.name}</span>
                    <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
                  </button>
                  {g.sessions.length > 0 && (
                    <div className="cz-sidebar__actions">
                      <GroupDeleteButton
                        name={g.name}
                        sessions={g.sessions}
                        searching={searching}
                        pinnedHere={pinned.filter((p) => samePath(p.cwd, g.path)).length}
                        onConfirm={(ids) => onDeleteSessions(g.path, ids)}
                      />
                    </div>
                  )}
                </div>
                {open && g.sessions.length > 0 && (
                  <div className="cz-sidebar__group-body" role="list">
                    {g.sessions.map((x) => (
                      <SessionRow key={x.id} session={x} active={x.id === activeId} {...rowProps} />
                    ))}
                  </div>
                )}
              </section>
            );
          })
        )}
      </div>

      {/* 已删除（折叠时只占一行，在账户栏正上方） */}
      <DeletedSection
        deleted={deleted}
        workspaces={workspaces}
        onRestore={onRestoreSession}
        onPurge={onPurgeSession}
        onRestoreMany={onRestoreSessions}
        onPurgeMany={onPurgeSessions}
      />

      {/* 底部账户栏 */}
      <div className="cz-sidebar__account">
        <AccountMenu account={account} version={accountVersion} />
      </div>
      </div>
    </SessionCardProvider>
  );
}

function CollapseButton({ onCollapse }: { onCollapse: () => void }) {
  const card = useSessionCard();
  return (
    <button
      type="button"
      className="cz-sidebar__icon-btn"
      onClick={() => {
        card?.closeNow();
        onCollapse();
      }}
      title="收起侧栏"
      aria-label="收起侧栏"
    >
      <Icon name="sidebar-collapse" size={18} />
    </button>
  );
}

/**
 * 工作空间组头上的「删除全部会话」：只删这一组里当前显示的会话（已去掉置顶；搜索时只是匹配的那些），
 * 移到「已删除」可以恢复；执行中的会话跳过。批量操作必须经过气泡确认，不能双击跳过。
 */
function GroupDeleteButton({ name, sessions, searching, pinnedHere, onConfirm }: {
  name: string;
  sessions: SessionSummary[];
  searching: boolean;
  /** 这个工作空间被置顶的会话数（不在组里显示，也不会被删） */
  pinnedHere: number;
  onConfirm: (ids: string[]) => void;
}) {
  const ids = sessions.filter((x) => x.dot !== 'running').map((x) => x.id);
  const running = sessions.length - ids.length;
  const notes = ['会移到「已删除」，可以恢复'];
  if (running > 0) notes.push(`${running} 个正在执行的会话会跳过`);
  if (pinnedHere > 0 && !searching) notes.push('置顶的会话不受影响');
  return (
    <ConfirmActionButton
      icon="trash"
      label={searching ? '删除此工作空间中匹配的会话' : '删除此工作空间的全部会话'}
      confirmText={searching ? `删除「${name}」中匹配的 ${ids.length} 个会话？` : `删除「${name}」的全部 ${ids.length} 个会话？`}
      note={notes.join('；')}
      confirmLabel="全部删除"
      disabled={ids.length === 0}
      disabledTitle="会话都在执行中，不能删除"
      requireConfirm
      onConfirm={() => onConfirm(ids)}
    />
  );
}
