// 会话标题区：标题（点击原地改名），下面一行是 git 分支与工作目录（点击复制；工作目录后面是
// 内置终端开关，悬停时行尾出现「在文件管理器显示」）。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionSummary } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { CopyButton, PathActions } from '../files/PathActions';
import { SessionCardProvider, useSessionCardTarget, type SessionCardTarget } from '../sidebar/SessionCard';
import './SessionHeader.css';

export interface SessionHeaderProps {
  /** 会话标题；null 或空串表示新会话（显示「新会话」） */
  title: string | null;
  cwd: string;
  /** 非 git 仓库为 null，此时整行隐藏 */
  branch: string | null;
  /** 当前会话摘要；新会话不传或为 null，此时不出悬浮卡片、保留原 title */
  session?: SessionSummary | null;
  /** 提交新标题（已 trim、非空、与原标题不同才会触发） */
  onRename: (title: string) => void;
  /** 内置终端面板是否打开（传入 onToggleTerminal 时在工作目录旁显示应用内终端按钮） */
  terminalOpen?: boolean;
  onToggleTerminal?: () => void;
}

export function SessionHeader({ title, cwd, branch, session, onRename, terminalOpen = false, onToggleTerminal }: SessionHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  /** 已提交或已取消：随后因卸载/失焦触发的 blur 不应再次提交 */
  const cancelledRef = useRef(false);

  const display = title && title.trim() ? title : '新会话';

  // 会话切换时放弃未提交的编辑
  useEffect(() => {
    setEditing(false);
  }, [title, cwd]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const startEdit = () => {
    cancelledRef.current = false;
    setDraft(title ?? '');
    setEditing(true);
  };

  const commit = () => {
    if (cancelledRef.current) return;
    cancelledRef.current = true;
    const next = draft.trim();
    setEditing(false);
    // 空字符串不提交；没改动也不提交
    if (next && next !== (title ?? '')) onRename(next);
  };

  const cancel = () => {
    cancelledRef.current = true;
    setEditing(false);
  };

  const target = useMemo<SessionCardTarget | null>(() => {
    if (!session || editing) return null;
    return {
      kind: 'session',
      id: session.id,
      cwd: session.cwd,
      title: title ?? session.title,
      lastActiveAt: session.lastActiveAt,
      dot: session.dot,
      pinned: session.pinned,
      account: session.account,
      config: session.config,
      lastModel: session.lastModel,
      hint: '点击标题改名',
    };
  }, [session, editing, title]);

  return (
    <SessionCardProvider placement="below">
      <div className="cz-header">
        <div className="cz-header__title-row">
          {editing ? (
            <input
              ref={inputRef}
              className="cz-header__input"
              value={draft}
              maxLength={200}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                // 输入法选词时的 Enter 不算提交
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancel();
                }
              }}
              aria-label="会话标题"
            />
          ) : (
            <HeaderTitleButton
              display={display}
              placeholder={!(title && title.trim())}
              target={target}
              hasSession={!!session}
              onClick={startEdit}
            />
          )}
        </div>

        {/* 分支与工作目录并排在标题下方一行（三行叠放太占高度）。每项是一整块可点的「图标 + 文字」：
            点击复制，悬停时图标换成复制图标；不再在两项之间垫一个看不见的复制按钮，所以没有空白。
            工作目录放最后，常驻的终端开关紧跟其后，悬停才出现的「在文件管理器显示」落在行尾 */}
        <div className="cz-header__metas">
          {branch !== null && (
            <div className="cz-header__meta">
              <CopyButton text={branch} label="复制分支名" className="cz-header__copy" glyph="branch">
                <span className="cz-header__meta-text">{branch}</span>
              </CopyButton>
            </div>
          )}
          <div className="cz-header__meta cz-pathact-host">
            <CopyButton text={cwd} label="复制工作目录" className="cz-header__copy" glyph="folder">
              <span className="cz-header__meta-text">{cwd}</span>
            </CopyButton>
            {onToggleTerminal && (
              <button
                type="button"
                className={`cz-header__term${terminalOpen ? ' is-active' : ''}`}
                aria-label={terminalOpen ? '关闭内置终端' : '打开内置终端'}
                aria-pressed={terminalOpen}
                title={terminalOpen ? '关闭内置终端' : '打开内置终端'}
                onClick={onToggleTerminal}
              >
                <Icon name="terminal" size={14} />
              </button>
            )}
            <PathActions path={cwd} hideCopy hideTerminal={!!onToggleTerminal} />
          </div>
        </div>
      </div>
    </SessionCardProvider>
  );
}

function HeaderTitleButton({
  display,
  placeholder,
  target,
  hasSession,
  onClick,
}: {
  display: string;
  placeholder: boolean;
  target: SessionCardTarget | null;
  hasSession: boolean;
  onClick: () => void;
}) {
  const cardProps = useSessionCardTarget(target);
  return (
    <button
      type="button"
      className={`cz-header__title${placeholder ? ' is-placeholder' : ''}`}
      {...(hasSession ? cardProps : {})}
      onClick={() => {
        cardProps.onClick?.();
        onClick();
      }}
      title={hasSession ? undefined : '点击改名'}
    >
      {display}
    </button>
  );
}
