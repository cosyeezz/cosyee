// 三栏外壳：左侧栏 / 中间（顶部标题 + 主区）/ 右侧上下文。纯布局，不含业务。
import type { ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import './AppShell.css';

export interface AppShellProps {
  sidebar: ReactNode;
  header: ReactNode;
  main: ReactNode;
  context: ReactNode;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** 右侧上下文栏收起（收起按钮在面板里，展开按钮在顶部右侧） */
  contextCollapsed?: boolean;
  onToggleContext?: () => void;
}

export function AppShell({
  sidebar, header, main, context, sidebarCollapsed, onToggleSidebar, contextCollapsed = false, onToggleContext,
}: AppShellProps) {
  const cls = `cz-shell${sidebarCollapsed ? ' cz-shell--collapsed' : ''}${contextCollapsed ? ' cz-shell--ctx-collapsed' : ''}`;
  return (
    <div className={cls}>
      {/* 收起时宽度变 0 并隐藏内容（visibility 使其不可聚焦），内层保持固定宽度避免重排 */}
      <aside className="cz-shell__sidebar" aria-hidden={sidebarCollapsed}>
        <div className="cz-shell__sidebar-inner">{sidebar}</div>
      </aside>

      <div className="cz-shell__center">
        <div className="cz-shell__top">
          {sidebarCollapsed && (
            <button
              type="button"
              className="cz-shell__expand"
              onClick={onToggleSidebar}
              title="展开侧栏"
              aria-label="展开侧栏"
            >
              <Icon name="sidebar-expand" size={18} />
            </button>
          )}
          <div className="cz-shell__header">{header}</div>
          {contextCollapsed && onToggleContext && (
            <button
              type="button"
              className="cz-shell__expand cz-shell__expand--right"
              onClick={onToggleContext}
              title="展开上下文栏"
              aria-label="展开上下文栏"
            >
              <Icon name="panel-expand" size={18} />
            </button>
          )}
        </div>
        <div className="cz-shell__main">{main}</div>
      </div>

      {/* 同左侧栏：收起时宽度变 0 并隐藏，内层固定宽度 */}
      <aside className="cz-shell__context" aria-hidden={contextCollapsed}>
        <div className="cz-shell__context-inner">{context}</div>
      </aside>
    </div>
  );
}
