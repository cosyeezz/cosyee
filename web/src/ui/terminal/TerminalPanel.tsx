// 内置终端面板：宽屏停靠在中间对话区底部（可拖拽调高、双击或按钮最大化），窄屏铺满中间区。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { TermBlock } from '@cosyee/shared';
import { useTerminal, type TerminalController } from '../../core/terminal';
import { clampTerminalHeight } from '../../core/terminalPrefs';
import { Icon } from '../icons/Icon';
import { NARROW_QUERY, TOUCH_QUERY, useMediaQuery } from '../layout/useMediaQuery';
import { useDismiss } from '../sidebar/useDismiss';
import { TerminalBlock } from './TerminalBlock';
import { TerminalHistory } from './TerminalHistory';
import { middleEllipsisPath, shortCwd, workspaceName } from './terminalUtil';
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
  controller?: TerminalController;
  initialHistoryOpen?: boolean;
  initialStdinMode?: boolean;
  fixedNowMs?: number;
}

const LEAVE_MS = 180;

function isAtFirstLine(el: HTMLTextAreaElement): boolean {
  const pos = el.selectionStart ?? 0;
  return el.value.lastIndexOf('\n', pos - 1) === -1;
}

function isAtLastLine(el: HTMLTextAreaElement): boolean {
  const pos = el.selectionEnd ?? el.value.length;
  return el.value.indexOf('\n', pos) === -1;
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
  initialHistoryOpen = false,
  initialStdinMode = false,
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

  // 无外部 controller 时走真实 WS hook
  const internalCtrl = useTerminal(controllerProp ? null : root, open && !controllerProp);
  const { state, actions } = controllerProp ?? internalCtrl;
  const snap = state.snapshot;

  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const shellMenuRef = useRef<HTMLDivElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const histWrapRef = useRef<HTMLDivElement>(null);

  const [maximized, setMaximized] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [shellMenuOpen, setShellMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(initialHistoryOpen);
  const [stdinMode, setStdinMode] = useState(initialStdinMode);
  const [value, setValue] = useState('');
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // 历史上下翻页游标与草稿
  const histCursorRef = useRef<number | null>(null);
  const draftRef = useRef<string>('');
  const atBottomRef = useRef<boolean>(true);

  const closeShellMenu = useCallback(() => setShellMenuOpen(false), []);
  const closeMoreMenu = useCallback(() => setMoreMenuOpen(false), []);
  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    if (!touch) requestAnimationFrame(() => inputRef.current?.focus());
  }, [touch]);

  useDismiss(shellMenuOpen, shellMenuRef, closeShellMenu);
  useDismiss(moreMenuOpen, moreMenuRef, closeMoreMenu);
  useDismiss(historyOpen, histWrapRef, closeHistory);

  const blocks = snap?.blocks ?? [];
  const history = snap?.history ?? [];
  const currentCwd = snap?.cwd ?? root ?? '';
  const currentRoot = snap?.root ?? root ?? '';
  const platform = snap?.platform ?? 'linux';
  const shells = snap?.shells ?? [];
  const currentShellInfo = shells.find((s) => s.id === snap?.shell);

  /** 最近一条正在运行的块（用于 stdin 与 Ctrl+C） */
  const runningBlock: TermBlock | null = useMemo(() => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.state === 'running') return blocks[i]!;
    }
    return null;
  }, [blocks]);

  // 没有运行中的命令时自动退出 stdin 模式
  useEffect(() => {
    if (!runningBlock && stdinMode) setStdinMode(false);
  }, [runningBlock, stdinMode]);

  // 面板打开时自动聚焦输入框（触屏上不自动弹软键盘）
  useEffect(() => {
    if (!open || touch) return;
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, root, touch]);

  // 切换工作空间时复位历史浏览状态
  useEffect(() => {
    histCursorRef.current = null;
    draftRef.current = '';
  }, [root]);

  // 输入框自适应高度（1 ~ 5 行）
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, Math.max(24, el.scrollHeight))}px`;
  }, [value, mounted]);

  // 输出区自动滚到底部
  const lastBlock = blocks[blocks.length - 1];
  const scrollSignal = `${blocks.length}:${lastBlock?.id ?? ''}:${lastBlock?.output.length ?? 0}:${lastBlock?.state ?? ''}`;
  useEffect(() => {
    if (!mounted) return;
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowScrollBottom(false);
    }
  }, [scrollSignal, mounted, root]);

  const onBodyScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist <= 28;
    atBottomRef.current = atBottom;
    setShowScrollBottom(!atBottom && blocks.length > 0);
  }, [blocks.length]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setShowScrollBottom(false);
    el.scrollTo?.({ top: el.scrollHeight, behavior: 'smooth' });
    if (!el.scrollTo) el.scrollTop = el.scrollHeight;
  }, []);

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

  // 历史上下浏览
  const stepHistory = useCallback((dir: -1 | 1) => {
    if (history.length === 0) return;
    if (dir === -1) {
      if (histCursorRef.current === null) {
        draftRef.current = value;
        histCursorRef.current = history.length - 1;
      } else if (histCursorRef.current > 0) {
        histCursorRef.current -= 1;
      }
      setValue(history[histCursorRef.current]!);
    } else {
      if (histCursorRef.current === null) return;
      if (histCursorRef.current < history.length - 1) {
        histCursorRef.current += 1;
        setValue(history[histCursorRef.current]!);
      } else {
        histCursorRef.current = null;
        setValue(draftRef.current);
      }
    }
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) el.setSelectionRange(el.value.length, el.value.length);
    });
  }, [history, value]);

  const submitInput = useCallback(() => {
    if (stdinMode && runningBlock) {
      actions.sendStdin(runningBlock.id, `${value}\n`);
      setValue('');
      atBottomRef.current = true;
      return;
    }
    const cmd = value.trim();
    if (!cmd) return;
    actions.run(value);
    setValue('');
    histCursorRef.current = null;
    draftRef.current = '';
    atBottomRef.current = true;
  }, [stdinMode, runningBlock, value, actions]);

  const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitInput();
      return;
    }

    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      setHistoryOpen((o) => !o);
      return;
    }

    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      actions.clear();
      return;
    }

    if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'c') {
      const selText = window.getSelection?.()?.toString() ?? '';
      if (selText) return; // 有选中文本时让浏览器正常复制
      if (!value && runningBlock) {
        e.preventDefault();
        actions.stop(runningBlock.id);
      }
      return;
    }

    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 's' && runningBlock) {
      e.preventDefault();
      setStdinMode((m) => !m);
      return;
    }

    if (e.key === 'ArrowUp' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (isAtFirstLine(e.currentTarget)) {
        e.preventDefault();
        stepHistory(-1);
      }
      return;
    }

    if (e.key === 'ArrowDown' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (histCursorRef.current !== null && isAtLastLine(e.currentTarget)) {
        e.preventDefault();
        stepHistory(1);
      }
      return;
    }

    if (e.key === 'Escape') {
      // 焦点在输入框内按 Esc：只关历史浮层，不关闭终端面板（防误触）
      if (historyOpen) {
        e.preventDefault();
        e.stopPropagation();
        setHistoryOpen(false);
      }
    }
  };

  // 面板内 Esc：焦点不在输入框、且没有子浮层打开时关闭面板
  const onPanelKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (historyOpen || shellMenuOpen || moreMenuOpen) return;
    if (document.activeElement === inputRef.current) return;
    e.preventDefault();
    onClose();
  };

  const onRerun = useCallback((cmd: string) => {
    actions.run(cmd);
    atBottomRef.current = true;
    if (!touch) inputRef.current?.focus();
  }, [actions, touch]);

  const onSelectHistory = useCallback((cmd: string) => {
    setValue(cmd);
    histCursorRef.current = null;
    setHistoryOpen(false);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(cmd.length, cmd.length);
      }
    });
  }, []);

  if (!mounted || !root) return null;

  const isRootCwd = currentCwd.replace(/[\\/]+$/, '').toLowerCase() === currentRoot.replace(/[\\/]+$/, '').toLowerCase();
  const wsTitle = workspaceName(currentRoot);
  const cwdDisplay = narrow
    ? (isRootCwd ? '' : shortCwd(currentCwd, currentRoot).replace(new RegExp(`^${wsTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`), ''))
    : middleEllipsisPath(currentCwd, 48);
  const promptDir = shortCwd(currentCwd, currentRoot);
  const promptGlyph = platform === 'win32' && (!snap || snap.shell === 'cmd' || snap.shell === 'powershell' || snap.shell === 'pwsh') ? '>' : '❯';

  const panelCls = [
    'cz-term',
    narrow ? 'is-narrow' : maximized ? 'is-max' : 'is-docked',
    leaving ? 'is-leaving' : '',
    resizing ? 'is-resizing' : '',
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
            className="cz-term__btn"
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
            title="关闭终端"
            aria-label="关闭终端"
            onClick={onClose}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </header>

      {/* 服务端错误提示条 */}
      {state.error && (
        <div className="cz-term__errbar" role="alert">
          <Icon name="error" size={13} />
          <span>{state.error}</span>
        </div>
      )}

      {/* 输出区 */}
      <div className="cz-term__body">
        <div className="cz-term__scroll" ref={scrollRef} onScroll={onBodyScroll}>
          {blocks.length === 0 ? (
            <div className="cz-term__empty">
              <div className="cz-term__empty-icon" aria-hidden="true">
                <Icon name="terminal" size={22} />
              </div>
              <div className="cz-term__empty-title">在 {wsTitle} 中执行命令</div>
              <div className="cz-term__empty-hint">
                <span><kbd>Enter</kbd> 执行</span>
                <span><kbd>Shift+Enter</kbd> 换行</span>
                <span><kbd>Ctrl+R</kbd> 历史</span>
                <span><kbd>Ctrl+L</kbd> 清屏</span>
              </div>
            </div>
          ) : (
            <div className="cz-term__blocks">
              {blocks.map((block) => (
                <TerminalBlock
                  key={block.id}
                  block={block}
                  root={currentRoot}
                  platform={platform}
                  fixedNowMs={fixedNowMs}
                  onRerun={onRerun}
                  onStop={actions.stop}
                />
              ))}
            </div>
          )}
        </div>

        {showScrollBottom && (
          <button
            type="button"
            className="cz-term__to-bottom"
            onClick={scrollToBottom}
            aria-label="回到底部"
          >
            <Icon name="arrow-down" size={13} />
            <span>回到底部</span>
          </button>
        )}
      </div>

      {/* 底部输入区域 */}
      <div className="cz-term__foot" ref={histWrapRef}>
        <TerminalHistory
          open={historyOpen}
          history={history}
          onSelect={onSelectHistory}
          onRemove={actions.removeHistory}
          onClear={actions.clearHistory}
          onClose={closeHistory}
        />

        {/* 运行中进程 stdin 模式切换条 */}
        {runningBlock && (
          <div className={`cz-term__stdinbar${stdinMode ? ' is-active' : ''}`}>
            <span className="cz-term__stdin-info" title={runningBlock.cmd}>
              <span className="cz-term-block__dot" aria-hidden="true" />
              <span className="cz-term__stdin-cmd">{runningBlock.cmd}</span>
            </span>
            <div className="cz-term__stdin-acts">
              <button
                type="button"
                className={`cz-term__stdin-toggle${stdinMode ? ' is-on' : ''}`}
                aria-pressed={stdinMode}
                title="切换将输入发送给正在运行的进程 (Alt+S)"
                onClick={() => {
                  setStdinMode((m) => !m);
                  if (!touch) inputRef.current?.focus();
                }}
              >
                <span className="cz-term__stdin-sw" aria-hidden="true" />
                <span>发送到运行中进程</span>
              </button>
              <button
                type="button"
                className="cz-term__stdin-stop"
                title="停止正在运行的命令 (Ctrl+C)"
                aria-label="停止正在运行的命令"
                onClick={() => actions.stop(runningBlock.id)}
              >
                <Icon name="stop" size={11} />
                <span>停止</span>
              </button>
            </div>
          </div>
        )}

        {/* 触屏快捷键条（热区 ≥44px） */}
        {touch && (
          <div className="cz-term__touchbar" role="toolbar" aria-label="终端快捷操作">
            <button
              type="button"
              className="cz-term__tkey"
              aria-label="上一条历史"
              disabled={history.length === 0}
              onClick={() => stepHistory(-1)}
            >
              <Icon name="arrow-up" size={15} />
            </button>
            <button
              type="button"
              className="cz-term__tkey"
              aria-label="下一条历史"
              disabled={histCursorRef.current === null}
              onClick={() => stepHistory(1)}
            >
              <Icon name="arrow-down" size={15} />
            </button>
            <button
              type="button"
              className="cz-term__tkey is-danger"
              aria-label="停止当前命令 (Ctrl+C)"
              disabled={!runningBlock}
              onClick={() => runningBlock && actions.stop(runningBlock.id)}
            >
              Ctrl+C
            </button>
            <button
              type="button"
              className="cz-term__tkey"
              aria-label="清屏"
              disabled={blocks.length === 0}
              onClick={actions.clear}
            >
              清屏
            </button>
            <button
              type="button"
              className={`cz-term__tkey${historyOpen ? ' is-on' : ''}`}
              aria-label="命令历史"
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
            >
              <Icon name="history" size={14} />
              <span>历史</span>
            </button>
          </div>
        )}

        {/* 命令输入框 */}
        <div className={`cz-term__inputbox${stdinMode && runningBlock ? ' is-stdin' : ''}`}>
          <span
            className="cz-term__prompt"
            title={stdinMode && runningBlock ? '当前输入将发送给正在运行的进程' : currentCwd}
          >
            {stdinMode && runningBlock ? (
              <span className="cz-term__prompt-stdin">stdin ▸</span>
            ) : narrow ? (
              <span className="cz-term__prompt-glyph is-accent" aria-hidden="true">{promptGlyph}</span>
            ) : (
              <>
                <span className="cz-term__prompt-dir">{promptDir}</span>
                <span className="cz-term__prompt-glyph" aria-hidden="true">{promptGlyph}</span>
              </>
            )}
          </span>

          <textarea
            ref={inputRef}
            className="cz-term__input"
            rows={1}
            value={value}
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            placeholder={
              stdinMode && runningBlock
                ? (narrow ? '发送到运行中进程…' : '输入内容并按 Enter 发送给正在运行的进程…')
                : (narrow ? '输入命令…' : '输入命令，Enter 执行，Shift+Enter 换行…')
            }
            aria-label={stdinMode && runningBlock ? '发送到运行中进程' : '终端命令输入'}
            onChange={(e) => {
              setValue(e.target.value);
              if (histCursorRef.current !== null) histCursorRef.current = null;
            }}
            onKeyDown={onInputKeyDown}
          />

          <div className="cz-term__input-acts">
            <button
              type="button"
              className={`cz-term__ibtn${historyOpen ? ' is-on' : ''}`}
              title="历史命令 (Ctrl+R)"
              aria-label="历史命令"
              aria-pressed={historyOpen}
              onClick={() => setHistoryOpen((o) => !o)}
            >
              <Icon name="history" size={14} />
            </button>
            <button
              type="button"
              className="cz-term__ibtn is-run"
              title={stdinMode && runningBlock ? '发送给进程 (Enter)' : '执行命令 (Enter)'}
              aria-label={stdinMode && runningBlock ? '发送给进程' : '执行命令'}
              disabled={!stdinMode && !value.trim()}
              onClick={submitInput}
            >
              <Icon name="send" size={14} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
