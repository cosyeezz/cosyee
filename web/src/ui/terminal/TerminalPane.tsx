// 单个终端标签的内容区：输出块列表、滚到底部悬浮按钮、历史命令弹层、stdin 模式条、触屏快捷栏与命令输入框。
// 每个标签的 UI 状态（输入框草稿、stdinMode、历史游标、滚动位置、历史浮层）通过 uiCache 按标签独立持久化。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
} from 'react';
import type { TermBlock } from '@cosyee/shared';
import type { TerminalController } from '../../core/terminal';
import { Icon } from '../icons/Icon';
import { useDismiss } from '../sidebar/useDismiss';
import { TerminalBlock } from './TerminalBlock';
import { TerminalHistory } from './TerminalHistory';
import { shortCwd, workspaceName } from './terminalUtil';

export interface TabUiState {
  value: string;
  stdinMode: boolean;
  historyOpen: boolean;
  histCursor: number | null;
  draft: string;
  scrollTop: number;
  atBottom: boolean;
}

export function defaultTabUiState(
  initialHistoryOpen = false,
  initialStdinMode = false,
): TabUiState {
  return {
    value: '',
    stdinMode: initialStdinMode,
    historyOpen: initialHistoryOpen,
    histCursor: null,
    draft: '',
    scrollTop: 0,
    atBottom: true,
  };
}

export interface TerminalPaneProps {
  paneKey: string;
  root: string;
  controller: TerminalController;
  open: boolean;
  mounted: boolean;
  narrow: boolean;
  touch: boolean;
  uiCacheRef: MutableRefObject<Map<string, TabUiState>>;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  initialHistoryOpen?: boolean;
  initialStdinMode?: boolean;
  fixedNowMs?: number;
  onHistoryOpenChange?: (open: boolean) => void;
}

function isAtFirstLine(el: HTMLTextAreaElement): boolean {
  const pos = el.selectionStart ?? 0;
  return el.value.lastIndexOf('\n', pos - 1) === -1;
}

function isAtLastLine(el: HTMLTextAreaElement): boolean {
  const pos = el.selectionEnd ?? el.value.length;
  return el.value.indexOf('\n', pos) === -1;
}

export function TerminalPane({
  paneKey,
  root,
  controller,
  open,
  mounted,
  narrow,
  touch,
  uiCacheRef,
  inputRef,
  initialHistoryOpen = false,
  initialStdinMode = false,
  fixedNowMs,
  onHistoryOpenChange,
}: TerminalPaneProps) {
  const { state, actions } = controller;
  const snap = state.snapshot;

  const saved = uiCacheRef.current.get(paneKey);
  const init = saved ?? defaultTabUiState(initialHistoryOpen, initialStdinMode);

  const scrollRef = useRef<HTMLDivElement>(null);
  const histWrapRef = useRef<HTMLDivElement>(null);

  const [historyOpen, setHistoryOpen] = useState(init.historyOpen);
  const [stdinMode, setStdinMode] = useState(init.stdinMode);
  const [value, setValue] = useState(init.value);
  const [showScrollBottom, setShowScrollBottom] = useState(!init.atBottom);

  const histCursorRef = useRef<number | null>(init.histCursor);
  const draftRef = useRef<string>(init.draft);
  const atBottomRef = useRef<boolean>(init.atBottom);
  const scrollTopRef = useRef<number>(init.scrollTop);
  const restoredScrollRef = useRef<boolean>(false);

  // 持续同步当前标签的 UI 状态到缓存（切走再切回可完整恢复）
  const persistUi = useCallback(() => {
    uiCacheRef.current.set(paneKey, {
      value,
      stdinMode,
      historyOpen,
      histCursor: histCursorRef.current,
      draft: draftRef.current,
      scrollTop: scrollTopRef.current,
      atBottom: atBottomRef.current,
    });
  }, [uiCacheRef, paneKey, value, stdinMode, historyOpen]);

  useEffect(() => {
    persistUi();
  }, [persistUi]);

  useEffect(() => {
    onHistoryOpenChange?.(historyOpen);
  }, [historyOpen, onHistoryOpenChange]);

  const closeHistory = useCallback(() => {
    setHistoryOpen(false);
    if (!touch) requestAnimationFrame(() => inputRef.current?.focus());
  }, [touch, inputRef]);

  useDismiss(historyOpen, histWrapRef, closeHistory);

  const blocks = snap?.blocks ?? [];
  const history = snap?.history ?? [];
  const currentCwd = snap?.cwd ?? root;
  const currentRoot = snap?.root ?? root;
  const platform = snap?.platform ?? 'linux';

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

  // 面板打开或切换标签时自动聚焦输入框（触屏上不自动弹软键盘；正在内联改名时不抢焦点）
  useEffect(() => {
    if (!open || touch) return;
    const raf = requestAnimationFrame(() => {
      if (document.querySelector('.cz-term-tab__rename')) return;
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [open, paneKey, touch, inputRef]);

  // 输入框自适应高度（1 ~ 5 行）
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(120, Math.max(24, el.scrollHeight))}px`;
  }, [value, mounted, inputRef]);

  // 挂载时恢复上次保存的滚动位置
  useLayoutEffect(() => {
    if (!mounted || restoredScrollRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    restoredScrollRef.current = true;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowScrollBottom(false);
    } else {
      el.scrollTop = scrollTopRef.current;
      setShowScrollBottom(blocks.length > 0);
    }
  }, [mounted, blocks.length]);

  // 新输出到达时若在底部则自动跟随滚底
  const lastBlock = blocks[blocks.length - 1];
  const scrollSignal = `${blocks.length}:${lastBlock?.id ?? ''}:${lastBlock?.output.length ?? 0}:${lastBlock?.state ?? ''}`;
  useEffect(() => {
    if (!mounted) return;
    const el = scrollRef.current;
    if (!el) return;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      scrollTopRef.current = el.scrollTop;
      setShowScrollBottom(false);
    }
  }, [scrollSignal, mounted]);

  const onBodyScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    scrollTopRef.current = el.scrollTop;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = dist <= 28;
    atBottomRef.current = atBottom;
    setShowScrollBottom(!atBottom && blocks.length > 0);
    const cur = uiCacheRef.current.get(paneKey);
    if (cur) {
      cur.scrollTop = el.scrollTop;
      cur.atBottom = atBottom;
    }
  }, [blocks.length, uiCacheRef, paneKey]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setShowScrollBottom(false);
    el.scrollTo?.({ top: el.scrollHeight, behavior: 'smooth' });
    if (!el.scrollTo) el.scrollTop = el.scrollHeight;
    scrollTopRef.current = el.scrollHeight;
  }, []);

  // 历史上下浏览
  const stepHistory = useCallback(
    (dir: -1 | 1) => {
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
    },
    [history, value, inputRef],
  );

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

    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      setHistoryOpen((o) => !o);
      return;
    }

    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      actions.clear();
      return;
    }

    if (e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c') {
      const selText = window.getSelection?.()?.toString() ?? '';
      if (selText) return;
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
      if (historyOpen) {
        e.preventDefault();
        e.stopPropagation();
        setHistoryOpen(false);
      }
    }
  };

  const onRerun = useCallback(
    (cmd: string) => {
      actions.run(cmd);
      atBottomRef.current = true;
      if (!touch) inputRef.current?.focus();
    },
    [actions, touch, inputRef],
  );

  const onSelectHistory = useCallback(
    (cmd: string) => {
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
    },
    [inputRef],
  );

  const wsTitle = workspaceName(currentRoot);
  const promptDir = shortCwd(currentCwd, currentRoot);
  const promptGlyph =
    platform === 'win32' && (!snap || snap.shell === 'cmd' || snap.shell === 'powershell' || snap.shell === 'pwsh')
      ? '>'
      : '❯';

  return (
    <>
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
    </>
  );
}
