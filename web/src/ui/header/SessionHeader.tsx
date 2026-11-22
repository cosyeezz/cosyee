// 会话标题区：标题（点击原地改名）/ 工作目录 / git 分支（两行悬停时右侧出现操作按钮：
// 工作目录是 复制 / 在文件管理器显示 / 在此处打开终端，分支只有复制）。
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
import { CopyButton, PathActions } from '../files/PathActions';
import './SessionHeader.css';

export interface SessionHeaderProps {
  /** 会话标题；null 或空串表示新会话（显示「新会话」） */
  title: string | null;
  cwd: string;
  /** 非 git 仓库为 null，此时整行隐藏 */
  branch: string | null;
  /** 提交新标题（已 trim、非空、与原标题不同才会触发） */
  onRename: (title: string) => void;
}

export function SessionHeader({ title, cwd, branch, onRename }: SessionHeaderProps) {
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

  return (
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
          <button
            type="button"
            className={`cz-header__title${title && title.trim() ? '' : ' is-placeholder'}`}
            onClick={startEdit}
            title="点击改名"
          >
            {display}
          </button>
        )}
      </div>

      <div className="cz-header__meta cz-pathact-host" title={cwd}>
        <Icon name="folder" size={14} />
        <span className="cz-header__meta-text">{cwd}</span>
        <PathActions path={cwd} copyClassName="cz-header__copy" copyLabel="复制工作目录" />
      </div>

      {branch !== null && (
        <div className="cz-header__meta" title={branch}>
          <Icon name="branch" size={14} />
          <span className="cz-header__meta-text">{branch}</span>
          <CopyButton text={branch} label="复制分支名" className="cz-header__copy" />
        </div>
      )}
    </div>
  );
}
