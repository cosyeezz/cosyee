// 会话行：主按钮（状态点 + 标题 + 时间）+ 悬停时出现的操作（置顶 / 取消置顶、删除）。
import type { SessionSummary } from '@cosyee/shared';
import { ActionButton, ConfirmActionButton } from './ActionButtons';
import { formatLastActive } from './formatTime';
import { displayTitle } from './sidebarUtil';

export interface SessionRowProps {
  session: SessionSummary;
  active: boolean;
  now: number;
  /** 置顶区里显示所属工作空间名（小字、弱化）；列表里不传 */
  workspaceLabel?: string;
  onSelect: (id: string) => void;
  onTogglePin: (s: SessionSummary) => void;
  onDelete: (s: SessionSummary) => void;
}

export function SessionRow({ session: s, active, now, workspaceLabel, onSelect, onTogglePin, onDelete }: SessionRowProps) {
  const pinned = s.pinned !== null;
  const running = s.dot === 'running';
  // 标题下方的小字：工作空间（置顶区）· 账号名（只有并行模式下后端才给 account）
  const sub = [workspaceLabel, s.account].filter(Boolean).join(' · ');
  return (
    <div
      role="listitem"
      className={`cz-sidebar__row${active ? ' is-active' : ''}${sub ? ' has-sub' : ''}`}
    >
      <button
        type="button"
        className="cz-sidebar__row-main"
        onClick={() => onSelect(s.id)}
        title={sub ? `${displayTitle(s.title)}\n${sub}` : displayTitle(s.title)}
        aria-current={active ? 'true' : undefined}
      >
        {/* 状态点位置始终保留，保证标题对齐 */}
        <span className="cz-sidebar__dot-slot">
          {s.dot && <span className={`cz-sidebar__dot cz-sidebar__dot--${s.dot}`} />}
        </span>
        <span className="cz-sidebar__row-body">
          <span className="cz-sidebar__row-title">{displayTitle(s.title)}</span>
          {sub && <span className="cz-sidebar__row-sub">{sub}</span>}
        </span>
        <span className="cz-sidebar__row-time">{formatLastActive(s.lastActiveAt, now)}</span>
      </button>
      <div className="cz-sidebar__actions">
        <ActionButton
          icon="pin"
          label={pinned ? '取消置顶' : '置顶'}
          on={pinned}
          onClick={() => onTogglePin(s)}
        />
        <ConfirmActionButton
          icon="trash"
          label="删除会话"
          confirmText="删除此会话？"
          note="可以在「已删除」里恢复"
          disabled={running}
          disabledTitle="会话正在执行，不能删除"
          onConfirm={() => onDelete(s)}
        />
      </div>
    </div>
  );
}
