// 内置终端面板：宽屏停靠在中间对话区底部（可拖拽调高、双击或按钮最大化），窄屏铺满中间区。
// 支持多终端标签页：单标签时保持简洁工作空间路径标题 + 新建按钮；≥2 个标签时在标题栏左侧展示标签栏。
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { TERM_TAB_LIMIT, type TermTabInfo } from '@cosyee/shared';
import {
  useTerminalTabs,
  type TerminalController,
  type TerminalTabsController,
} from '../../core/terminal';
import { clampTerminalHeight } from '../../core/terminalPrefs';
import { Icon } from '../icons/Icon';
import { NARROW_QUERY, TOUCH_QUERY, useMediaQuery } from '../layout/useMediaQuery';
import { useDismiss } from '../sidebar/useDismiss';
import { TerminalPane, type TabUiState } from './TerminalPane';
import { TerminalTabs } from './TerminalTabs';
import { middleEllipsisPath, shortCwd, tabDisplayName, workspaceName } from './terminalUtil';
import './TerminalPanel.css';

export interface TerminalPanelProps {
  open: boolean;
  root: string | null;
  height: number;
  onHeightChange: (height: number) => void;
  onClose: () => void;
  /** 仅本机连接时传入：在系统终端中打开当前目录 */
  onOpenSystemTerminal?: (dir: string) => void;
  /** 可选覆盖（主要用于 dev 预览页与测试） */
  narrow?: boolean;
  touch?: boolean;
  /** 兼容旧单终端 controller 注入（自动适配为单标签） */
  controller?: TerminalController;
  /** 多终端标签控制器注入（dev 预览页与多标签测试用） */
  tabsController?: TerminalTabsController;
  initialHistoryOpen?: boolean;
  initialStdinMode?: boolean;
  initialRenamingId?: string | null;
  initialConfirmCloseId?: string | null;
  fixedNowMs?: number;
}

interface ConfirmCloseState {
  tabId: string;
  cmd: string;
}

const LEAVE_MS = 180;

function singleTabAdapter(ctrl: TerminalController, root: string | null): TerminalTabsController {
  const snap = ctrl.state.snapshot;
  const fallbackId = snap?.id || 'default';
  const tabs: TermTabInfo[] =
    snap?.tabs && snap.tabs.length > 0
      ? snap.tabs
      : snap
        ? [
            {
              id: fallbackId,
              cwd: snap.cwd,
              shell: snap.shell,
              status: snap.blocks.some((b) => b.state === 'running') ? 'running' : 'idle',
              runningCmd: [...snap.blocks].reverse().find((b) => b.state === 'running')?.cmd,
              createdAt: 0,
            },
          ]
        : root
          ? [{ id: fallbackId, cwd: root, shell: 'pwsh', status: 'idle', createdAt: 0 }]
          : [];
  return {
    tabs,
    activeId: fallbackId,
    notice: null,
    clearNotice: () => {},
    current: ctrl,
    selectTab: () => {},
    newTab: () => null,
    closeTab: () => ({ closedLast: true }),
    renameTab: () => {},
    moveTab: () => {},
  };
}

export function TerminalPanel({
  open,
  root,
  height,
  onHeightChange,
  onClose,
  onOpenSystemTerminal,
  narrow: narrowProp,
  touch: touchProp,
  controller: controllerProp,
  tabsController: tabsControllerProp,
  initialHistoryOpen = false,
  initialStdinMode = false,
  initialRenamingId = null,
  initialConfirmCloseId = null,
  fixedNowMs,
}: TerminalPanelProps) {
  const mediaNarrow = useMediaQuery(NARROW_QUERY);
  const mediaTouch = useMediaQuery(TOUCH_QUERY);
  const narrow = narrowProp ?? mediaNarrow;
  const touch = touchProp ?? (mediaTouch || narrow);

  // 始终播放展开 / 收起动画（不跟随 prefers-reduced-motion）
  const [mounted, setMounted] = useState(open);
  const [prevOpen, setPrevOpen] = useState(open);
  if (open !== prevOpen) {
    setPrevOpen(open);
    if (open) setMounted(true);
  }
  const leaving = mounted && !open;

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setMounted(false), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  // 无外部控制器时走真实多标签 WS hook
  const useInternal = !tabsControllerProp && !controllerProp;
  const internalTabsCtrl = useTerminalTabs(useInternal ? root : null, open && useInternal);

  const adaptedSingle = useMemo(
    () => (controllerProp && !tabsControllerProp ? singleTabAdapter(controllerProp, root) : null),
    [controllerProp, tabsControllerProp, root],
  );

  const tabsCtrl = tabsControllerProp ?? adaptedSingle ?? internalTabsCtrl;
  const { tabs, activeId, notice, clearNotice, current } = tabsCtrl;
  const { state, actions } = current;
  const snap = state.snapshot;

  const panelRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const shellMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const uiCacheRef = useRef<Map<string, TabUiState>>(new Map());
  const historyOpenRef = useRef<boolean>(initialHistoryOpen);

  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState<ConfirmCloseState | null>(() => {
    if (!initialConfirmCloseId) return null;
    const t = tabs.find((x) => x.id === initialConfirmCloseId);
    if (!t) return null;
    return { tabId: t.id, cmd: t.runningCmd || tabDisplayName(t, root ?? '') };
  });

  const closeShellMenu = useCallback(() => setShellMenuOpen(false), []);
  const closeMoreMenu = useCallback(() => setMoreMenuOpen(false), []);

  useDismiss(shellMenuOpen, shellMenuRef, closeShellMenu);
  useDismiss(moreMenuOpen, moreMenuRef, closeMoreMenu);

  // 如果待确认关闭的标签已经不在列表里，自动收起确认条
  useEffect(() => {
    if (!confirmClose) return;
    if (!tabs.some((t) => t.id === confirmClose.tabId)) {
      setConfirmClose(null);
    }
  }, [confirmClose, tabs]);

  const blocks = snap?.blocks ?? [];
  const currentCwd = snap?.cwd ?? root ?? '';
  const currentRoot = snap?.root ?? root ?? '';
  const shells = snap?.shells ?? [];
  const currentShellInfo = shells.find((s) => s.id === snap?.shell);

  const activeRunningCmd = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.state === 'running') return blocks[i]!.cmd;
    }
    return null;
  }, [blocks]);

  const doCloseTab = useCallback(
    (tabId: string) => {
      setConfirmClose(null);
      if (root) {
        uiCacheRef.current.delete(`${root}::${tabId}`);
      }
      const { closedLast } = tabsCtrl.closeTab(tabId);
      if (closedLast) {
        onClose();
      }
    },
    [tabsCtrl, root, onClose],
  );

  const requestCloseTab = useCallback(
    (tab: TermTabInfo) => {
      const runningCmd =
        tab.status === 'running'
          ? tab.runningCmd || tabDisplayName(tab, currentRoot)
          : tab.id === activeId && activeRunningCmd
            ? activeRunningCmd
            : null;
      if (runningCmd) {
        setConfirmClose({ tabId: tab.id, cmd: runningCmd });
        return;
      }
      doCloseTab(tab.id);
    },
    [activeId, activeRunningCmd, currentRoot, doCloseTab],
  );

  const handleNewTab = useCallback(() => {
    setConfirmClose(null);
    tabsCtrl.newTab();
  }, [tabsCtrl]);

  const cycleTab = useCallback(
    (delta: 1 | -1) => {
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      const nextIdx = idx < 0 ? 0 : (idx + delta + tabs.length) % tabs.length;
      const next = tabs[nextIdx];
      if (next) tabsCtrl.selectTab(next.id);
    },
    [tabs, activeId, tabsCtrl],
  );

  // 顶边拖拽调整高度
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (narrow || maximized) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const parentH = panelRef.current?.parentElement?.clientHeight ?? window.innerHeight;
    const maxH = Math.max(220, parentH - 110);
    let nextH = startH;
    setResizing(true);
    document.body.classList.add('cz-term-resizing');

    const move = (ev: PointerEvent) => {
      nextH = clampTerminalHeight(startH + (startY - ev.clientY), maxH);
      onHeightChange(nextH);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setResizing(false);
      document.body.classList.remove('cz-term-resizing');
      onHeightChange(nextH);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 面板内快捷键：新建 / 关闭当前标签 / 切换标签 / Esc
  const onPanelKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.nativeEvent.isComposing) return;

    // Ctrl+Shift+T：新建标签
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 't') {
      e.preventDefault();
      handleNewTab();
      return;
    }

    // Ctrl+Shift+W：关闭当前标签
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      const curTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
      if (curTab) {
        requestCloseTab(curTab);
      } else {
        onClose();
      }
      return;
    }

    // Ctrl+Tab / Ctrl+Shift+Tab / Ctrl+PageDown / Ctrl+PageUp：切换标签
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === 'Tab') {
        e.preventDefault();
        cycleTab(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'PageDown' && !e.shiftKey) {
        e.preventDefault();
        cycleTab(1);
        return;
      }
      if (e.key === 'PageUp' && !e.shiftKey) {
        e.preventDefault();
        cycleTab(-1);
        return;
      }
    }

    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (confirmClose) {
      e.preventDefault();
      setConfirmClose(null);
      return;
    }
    if (historyOpenRef.current || shellMenuOpen || moreMenuOpen) return;
    if (document.activeElement === inputRef.current) return;
    e.preventDefault();
    onClose();
  };

  const onHistoryOpenChange = useCallback((isOpen: boolean) => {
    historyOpenRef.current = isOpen;
  }, []);

  if (!mounted || !root) return null;

  const isRootCwd =
    currentCwd.replace(/[\\/]+$/, '').toLowerCase() === currentRoot.replace(/[\\/]+$/, '').toLowerCase();
  const wsTitle = workspaceName(currentRoot);
  const cwdDisplay = narrow
    ? isRootCwd
      ? ''
      : shortCwd(currentCwd, currentRoot).replace(
          new RegExp(`^${wsTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`),
          '',
        )
    : middleEllipsisPath(currentCwd, 48);

  const showTabBar = tabs.length >= 2;
  const atLimit = tabs.length >= TERM_TAB_LIMIT;
  const effectiveTabId = activeId ?? snap?.id ?? tabs[0]?.id ?? 'default';
  const paneKey = `${root}::${effectiveTabId}`;

  const panelCls = [
    'cz-term',
    narrow ? 'is-narrow' : maximized ? 'is-max' : 'is-docked',
    leaving ? 'is-leaving' : '',
    resizing ? 'is-resizing' : '',
    showTabBar ? 'has-tabs' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      ref={panelRef}
      className={panelCls}
      style={!narrow && !maximized ? { height } : undefined}
      aria-label="内置终端"
      onKeyDown={onPanelKeyDown}
    >
      {!narrow && !maximized && (
        <div
          className="cz-term__resize"
          title="拖拽调整高度，双击最大化"
          aria-hidden="true"
          onPointerDown={onResizeDown}
          onDoubleClick={() => setMaximized((m) => !m)}
        />
      )}

      {/* 标题栏 */}
      <header className="cz-term__bar">
        {showTabBar ? (
          <TerminalTabs
            tabs={tabs}
            activeId={effectiveTabId}
            root={currentRoot}
            touch={touch}
            onSelect={tabsCtrl.selectTab}
            onNew={handleNewTab}
            onRequestClose={requestCloseTab}
            onRename={tabsCtrl.renameTab}
            onMove={tabsCtrl.moveTab}
            initialRenamingId={initialRenamingId}
          />
        ) : (
          <div className="cz-term__brand-wrap">
            <div className="cz-term__brand" title={currentCwd}>
              <span className="cz-term__icon" aria-hidden="true">
                <Icon name="terminal" size={15} />
              </span>
              <span className="cz-term__ws">{wsTitle}</span>
              {cwdDisplay && (
                <>
                  <span className="cz-term__sep" aria-hidden="true">/</span>
                  <span className="cz-term__cwd">{cwdDisplay}</span>
                </>
              )}
            </div>
            <button
              type="button"
              className="cz-term-tabs__add"
              disabled={atLimit}
              title="新建终端 (Ctrl+Shift+T)"
              aria-label="新建终端"
              onClick={handleNewTab}
            >
              <Icon name="plus" size={14} />
            </button>
          </div>
        )}

        {/* 连接状态提示（温和可见） */}
        {state.connState === 'connecting' && (
          <span className="cz-term__conn is-warn" role="status">
            <span className="cz-term__conn-dot" aria-hidden="true" />
            <span>连接中…</span>
          </span>
        )}
        {state.connState === 'reconnecting' && (
          <span className="cz-term__conn is-warn" role="status">
            <span className="cz-term__conn-dot" aria-hidden="true" />
            <span>已断开，重连中…</span>
            <button type="button" className="cz-term__retry" onClick={actions.reconnect}>重试</button>
          </span>
        )}
        {state.connState === 'error' && (
          <span className="cz-term__conn is-err" role="status">
            <span>连接失败</span>
            <button type="button" className="cz-term__retry" onClick={actions.reconnect}>重试</button>
          </span>
        )}

        <div className="cz-term__tools">
          {/* Shell 切换下拉 */}
          {shells.length > 0 && (
            <div className="cz-term__menu-wrap" ref={shellMenuRef}>
              <button
                type="button"
                className={`cz-term__shell-btn${shellMenuOpen ? ' is-open' : ''}`}
                aria-haspopup="menu"
                aria-expanded={shellMenuOpen}
                title={`当前 Shell：${currentShellInfo?.label ?? snap?.shell ?? ''}`}
                onClick={() => setShellMenuOpen((o) => !o)}
              >
                <span className="cz-term__shell-label">{currentShellInfo?.label ?? snap?.shell}</span>
                <Icon name="chevron-down" size={12} />
              </button>
              {shellMenuOpen && (
                <div className="cz-term__menu cz-term-pop" role="menu" aria-label="切换 Shell">
                  {shells.map((s) => {
                    const active = s.id === snap?.shell;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        role="menuitemradio"
                        aria-checked={active}
                        className={`cz-term__menuitem${active ? ' is-active' : ''}`}
                        onClick={() => {
                          actions.setShell(s.id);
                          setShellMenuOpen(false);
                        }}
                      >
                        <span className="cz-term__menuitem-text">{s.label}</span>
                        <span className="cz-term__menuitem-id">{s.id}</span>
                        {active && <Icon name="check" size={13} className="cz-term__menuitem-ck" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <button
            type="button"
            className="cz-term__btn cz-term__btn-clear"
            title="清空记录 (Ctrl+L)"
            aria-label="清空记录"
            disabled={blocks.length === 0}
            onClick={actions.clear}
          >
            <Icon name="trash" size={14} />
          </button>

          {/* 更多操作菜单：重置目录 / 在系统终端中打开（仅本机） */}
          <div className="cz-term__menu-wrap" ref={moreMenuRef}>
            <button
              type="button"
              className={`cz-term__btn${moreMenuOpen ? ' is-open' : ''}`}
              title="更多终端操作"
              aria-label="更多终端操作"
              aria-haspopup="menu"
              aria-expanded={moreMenuOpen}
              onClick={() => setMoreMenuOpen((o) => !o)}
            >
              <Icon name="more" size={15} />
            </button>
            {moreMenuOpen && (
              <div className="cz-term__menu cz-term-pop" role="menu" aria-label="终端操作">
                <button
                  type="button"
                  role="menuitem"
                  className="cz-term__menuitem"
                  disabled={isRootCwd}
                  title={isRootCwd ? '当前已在工作空间根目录' : `重置目录到 ${currentRoot}`}
                  onClick={() => {
                    actions.resetCwd();
                    setMoreMenuOpen(false);
                  }}
                >
                  <Icon name="undo" size={14} />
                  <span className="cz-term__menuitem-text">重置目录到工作空间根</span>
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="cz-term__menuitem"
                  disabled={blocks.length === 0}
                  onClick={() => {
                    actions.clear();
                    setMoreMenuOpen(false);
                  }}
                >
                  <Icon name="trash" size={14} />
                  <span className="cz-term__menuitem-text">清空记录</span>
                </button>
                {onOpenSystemTerminal && (
                  <>
                    <div className="cz-term__menu-sep" />
                    <button
                      type="button"
                      role="menuitem"
                      className="cz-term__menuitem"
                      onClick={() => {
                        onOpenSystemTerminal(currentCwd || currentRoot);
                        setMoreMenuOpen(false);
                      }}
                    >
                      <Icon name="open-external" size={14} />
                      <span className="cz-term__menuitem-text">在系统终端中打开</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {!narrow && (
            <button
              type="button"
              className="cz-term__btn"
              title={maximized ? '还原高度' : '最大化'}
              aria-label={maximized ? '还原高度' : '最大化'}
              onClick={() => setMaximized((m) => !m)}
            >
              <Icon name={maximized ? 'window-restore' : 'maximize'} size={14} />
            </button>
          )}

          <button
            type="button"
            className="cz-term__btn"
            title="收起终端面板"
            aria-label="关闭终端"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>

      {/* 关闭运行中标签的面板内轻量确认条 */}
      {confirmClose && (
        <div className="cz-term__confirm-wrap">
          <div className="cz-term__confirm" role="alertdialog" aria-label="确认关闭运行中的终端">
            <span className="cz-term__confirm-msg" title={confirmClose.cmd}>
              <span className="cz-term-tab__dot is-running" aria-hidden="true" />
              <span className="cz-term__confirm-text">
                关闭此终端将停止正在运行的「<code className="cz-term__confirm-cmd">{confirmClose.cmd}</code>」
              </span>
            </span>
            <div className="cz-term__confirm-acts">
              <button
                type="button"
                className="cz-term__confirm-btn"
                onClick={() => setConfirmClose(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="cz-term__confirm-btn is-danger"
                onClick={() => doCloseTab(confirmClose.tabId)}
              >
                停止并关闭
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 工作空间级提示条（如达到 8 个终端上限） */}
      {notice && (
        <div className="cz-term__notice" role="status">
          <Icon name="info" size={13} />
          <span className="cz-term__notice-text">{notice}</span>
          <button
            type="button"
            className="cz-term__notice-close"
            aria-label="关闭提示"
            onClick={clearNotice}
          >
            <Icon name="close" size={11} />
          </button>
        </div>
      )}

      {/* 当前激活标签的内容区（按 paneKey 挂载，切走自动保存并切回恢复草稿与滚动位置） */}
      <TerminalPane
        key={paneKey}
        paneKey={paneKey}
        root={root}
        controller={current}
        open={open}
        mounted={mounted}
        narrow={narrow}
        touch={touch}
        uiCacheRef={uiCacheRef}
        inputRef={inputRef}
        initialHistoryOpen={initialHistoryOpen}
        initialStdinMode={initialStdinMode}
        fixedNowMs={fixedNowMs}
        onHistoryOpenChange={onHistoryOpenChange}
      />
    </section>
  );
}
