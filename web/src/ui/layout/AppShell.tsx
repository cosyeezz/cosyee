// 三栏外壳：左侧栏 / 中间（顶部标题 + 主区）/ 右侧上下文。纯布局，不含业务。
// 窄屏（narrow）时两侧栏不占位置，改为盖在会话上的浮层抽屉，点遮罩关闭。
import { useRef, type ReactNode } from 'react';
import { Icon } from '../icons/Icon';
import { useCssHeight } from './useCssHeight';
import './AppShell.css';

export interface AppShellProps {
  sidebar: ReactNode;
  header: ReactNode;
  main: ReactNode;
  context: ReactNode;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  /** 侧栏收起时顶部左侧的新建会话按钮（在展开按钮左边）；不传就不显示 */
  onNewSession?: () => void;
  /** 右侧上下文栏收起（收起按钮在面板里，展开按钮在顶部右侧） */
  contextCollapsed?: boolean;
  onToggleContext?: () => void;
  /** 窄屏：两侧栏改为浮层抽屉（collapsed=false 表示抽屉打开） */
  narrow?: boolean;
  /** 窄屏下点遮罩：关掉打开的抽屉 */
  onDismiss?: () => void;
}

export function AppShell({
  sidebar, header, main, context, sidebarCollapsed, onToggleSidebar, onNewSession, contextCollapsed = false, onToggleContext,
  narrow = false, onDismiss,
}: AppShellProps) {
  const centerRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  // 顶栏浮在主区上面（磨砂玻璃），主区按 --top-h 让出位置
  useCssHeight(centerRef, topRef, '--top-h');
  // 整个可见高度（Android 壳里键盘弹起会跟着缩）：写在根上，抽屉和输入框里的弹层都按它限高，不钻出屏幕
  const shellRef = useRef<HTMLDivElement>(null);
  useCssHeight(shellRef, centerRef, '--center-h');
  const drawerOpen = narrow && (!sidebarCollapsed || !contextCollapsed);
  const cls = `cz-shell${narrow ? ' cz-shell--narrow' : ''}${sidebarCollapsed ? ' cz-shell--collapsed' : ''}${contextCollapsed ? ' cz-shell--ctx-collapsed' : ''}`;
  return (
    <div className={cls} ref={shellRef}>
      {/* 收起时宽度变 0 并隐藏内容（visibility 使其不可聚焦），内层保持固定宽度避免重排 */}
      <aside className="cz-shell__sidebar" aria-hidden={sidebarCollapsed}>
        <div className="cz-shell__sidebar-inner">{sidebar}</div>
      </aside>

      <div className="cz-shell__center" ref={centerRef}>
        <div className="cz-shell__top" ref={topRef}>
          {sidebarCollapsed && (
            <div className="cz-shell__lead">
              {onNewSession && (
                <button
                  type="button"
                  className="cz-shell__expand"
                  onClick={onNewSession}
                  title="新建会话"
                  aria-label="新建会话"
                >
                  <Icon name="new-chat" size={18} />
                </button>
              )}
              <button
                type="button"
                className="cz-shell__expand"
                onClick={onToggleSidebar}
                title="展开侧栏"
                aria-label="展开侧栏"
              >
                <Icon name="sidebar-expand" size={18} />
              </button>
            </div>
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

      {narrow && (
        <div className={`cz-shell__scrim${drawerOpen ? ' is-on' : ''}`} onClick={onDismiss} aria-hidden="true" />
      )}

      {/* 同左侧栏：收起时宽度变 0 并隐藏，内层固定宽度 */}
      <aside className="cz-shell__context" aria-hidden={contextCollapsed}>
        <div className="cz-shell__context-inner">{context}</div>
      </aside>
    </div>
  );
}

