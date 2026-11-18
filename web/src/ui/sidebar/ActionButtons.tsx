// 侧栏行内的操作按钮：普通图标按钮、带「确认气泡」的危险操作按钮。
// 所有行内按钮用同一个尺寸（方形 24px）和同一个图标大小，视觉等高。
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { Icon, type IconName } from '../icons/Icon';
import { useDismiss } from './useDismiss';

/** 行内图标统一大小 */
export const ACTION_ICON_SIZE = 14;
/** 单击确认的延迟：给双击留出判断时间 */
export const CONFIRM_DELAY_MS = 250;

export interface ActionButtonProps {
  icon: IconName;
  /** 同时作为 aria-label 与 title 提示 */
  label: string;
  onClick: () => void;
  /** 表示「已开启」的状态（比如已置顶） */
  on?: boolean;
}

export function ActionButton({ icon, label, onClick, on }: ActionButtonProps) {
  return (
    <button
      type="button"
      className={`cz-sidebar__act${on ? ' is-on' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={on === undefined ? undefined : on}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <Icon name={icon} size={ACTION_ICON_SIZE} />
    </button>
  );
}

export interface ConfirmActionButtonProps {
  icon: IconName;
  label: string;
  /** 气泡里的问句 */
  confirmText: string;
  /** 气泡里的补充说明（小字） */
  note?: string;
  /** 气泡里确认按钮的文字 */
  confirmLabel?: string;
  disabled?: boolean;
  /** 禁用时的提示 */
  disabledTitle?: string;
  /** 单击后点「确认」或直接双击时触发 */
  onConfirm: () => void;
}

interface PopPos {
  right: number;
  top?: number;
  bottom?: number;
}

/**
 * 危险操作按钮：单击弹出确认气泡（锚定在按钮上），双击跳过确认直接执行。
 * 单击的动作延迟约 250ms，双击到来时取消它；所有点击都 stopPropagation，避免触发整行的选中。
 * 气泡用 position: fixed，不会被列表的滚动容器裁掉。
 */
export function ConfirmActionButton({
  icon,
  label,
  confirmText,
  note,
  confirmLabel = '删除',
  disabled,
  disabledTitle,
  onConfirm,
}: ConfirmActionButtonProps) {
  const [pos, setPos] = useState<PopPos | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const open = pos !== null;

  const close = useCallback(() => setPos(null), []);
  useDismiss(open, wrapRef, close);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 列表滚动 / 窗口缩放后固定定位会错位：直接收起
  useEffect(() => {
    if (!open) return;
    const h = () => setPos(null);
    window.addEventListener('scroll', h, true);
    window.addEventListener('resize', h);
    return () => {
      window.removeEventListener('scroll', h, true);
      window.removeEventListener('resize', h);
    };
  }, [open]);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  const showPopover = () => {
    const el = btnRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const right = Math.max(8, window.innerWidth - r.right);
    // 下方放不下（气泡约 110px 高）就放到按钮上方
    if (r.bottom + 6 + 110 > window.innerHeight) setPos({ right, bottom: window.innerHeight - r.top + 6 });
    else setPos({ right, top: r.bottom + 6 });
  };

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    window.clearTimeout(timer.current);
    if (open) {
      close();
      return;
    }
    timer.current = window.setTimeout(showPopover, CONFIRM_DELAY_MS);
  };

  const onDoubleClick = (e: MouseEvent) => {
    e.stopPropagation();
    window.clearTimeout(timer.current);
    close();
    onConfirm();
  };

  return (
    <span className="cz-sidebar__confirm-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="cz-sidebar__act cz-sidebar__act--danger"
        title={disabled ? disabledTitle ?? label : label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <Icon name={icon} size={ACTION_ICON_SIZE} />
      </button>
      {open && (
        <div
          className="cz-sidebar__confirm"
          role="dialog"
          aria-label={confirmText}
          style={{ right: pos.right, top: pos.top, bottom: pos.bottom }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="cz-sidebar__confirm-text">{confirmText}</div>
          {note && <div className="cz-sidebar__confirm-note">{note}</div>}
          <div className="cz-sidebar__confirm-btns">
            <button type="button" ref={cancelRef} className="cz-sidebar__confirm-btn" onClick={close}>
              取消
            </button>
            <button
              type="button"
              className="cz-sidebar__confirm-btn cz-sidebar__confirm-btn--danger"
              onClick={() => {
                close();
                onConfirm();
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}
