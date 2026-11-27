// 分支按钮：点击弹出两种去向（分支并切过去 / 分支，留在当前会话）。
// 供用户消息气泡（从该消息之前分支）与助手回复操作行（从该回复之后分支）共用。
import { useCallback, useState, type MouseEventHandler } from 'react';
import { Icon } from '../icons/Icon';
import { Menu } from '../menus/Menu';

export interface ForkButtonProps {
  onFork: (stay: boolean) => void;
  className: string;
  iconSize: number;
  title: string;
  goNote: string;
  stayNote?: string;
  /** 只提供「分支并切过去」（如会话第一条消息：分支出的是空白新会话） */
  goOnly?: boolean;
  onMouseDown?: MouseEventHandler<HTMLButtonElement>;
}

export function ForkButton({
  onFork,
  className,
  iconSize,
  title,
  goNote,
  stayNote = '新会话只出现在侧栏',
  goOnly = false,
  onMouseDown,
}: ForkButtonProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <button
        type="button"
        className={`${className}${anchor ? ' is-open' : ''}`}
        title={title}
        aria-label={title}
        aria-expanded={anchor != null}
        onMouseDown={onMouseDown}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
      >
        <Icon name="branch" size={iconSize} />
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          align="start"
          minWidth={240}
          onClose={close}
          items={[
            { key: 'go', label: '分支并切过去', note: goNote, onSelect: () => onFork(false) },
            ...(goOnly ? [] : [{ key: 'stay', label: '分支，留在当前会话', note: stayNote, onSelect: () => onFork(true) }]),
          ]}
        />
      )}
    </>
  );
}
