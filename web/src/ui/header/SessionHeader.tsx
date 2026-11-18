// 会话标题区：标题（点击原地改名）/ 工作目录 / git 分支（两行悬停时右侧出现复制按钮）。
import { useEffect, useRef, useState } from 'react';
import { Icon } from '../icons/Icon';
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

/** 复制成功后对勾保持多久（ms） */
const COPIED_MS = 1500;

/** 悬停所在行时出现的复制按钮：复制完整文本，成功后显示对勾约 1.5 秒；可键盘聚焦 */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // 剪贴板不可用（权限 / 非安全上下文）：静默，不显示对勾
    }
    setCopied(true);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setCopied(false);
    }, COPIED_MS);
  };
  return (
    <button
      type="button"
      className={`cz-header__copy${copied ? ' is-copied' : ''}`}
      aria-label={copied ? '已复制' : label}
      title={copied ? '已复制' : label}
      onClick={() => void onCopy()}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
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

      <div className="cz-header__meta" title={cwd}>
        <Icon name="folder" size={14} />
        <span className="cz-header__meta-text">{cwd}</span>
        <CopyButton text={cwd} label="复制工作目录" />
      </div>

      {branch !== null && (
        <div className="cz-header__meta" title={branch}>
          <Icon name="branch" size={14} />
          <span className="cz-header__meta-text">{branch}</span>
          <CopyButton text={branch} label="复制分支名" />
        </div>
      )}
    </div>
  );
}
