// 会话标题区：标题（点击原地改名）/ 工作目录 / git 分支（两行悬停时右侧出现操作按钮：
// 工作目录是 复制 / 在文件管理器显示 / 在此处打开终端，分支只有复制）。
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

        {/* 分支与工作目录并排在标题下方一行（三行叠放太占高度）。分支短、放前面；工作目录放最后，
            它悬停才出现的几个操作按钮落在行尾，不会在两项之间留出一大段空白 */}
        <div className="cz-header__metas">
          {branch !== null && (
            <div className="cz-header__meta" title={branch}>
              <Icon name="branch" size={14} />
              <span className="cz-header__meta-text">{branch}</span>
              <CopyButton text={branch} label="复制分支名" className="cz-header__copy" />
            </div>
          )}
          <div className="cz-header__meta cz-pathact-host" title={cwd}>
            <Icon name="folder" size={14} />
            <span className="cz-header__meta-text">{cwd}</span>
            <PathActions path={cwd} copyClassName="cz-header__copy" copyLabel="复制工作目录" hideTerminal={!!onToggleTerminal} />
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
