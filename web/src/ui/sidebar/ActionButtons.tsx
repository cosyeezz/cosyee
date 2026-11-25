// 侧栏行内的操作按钮：普通图标按钮、带「确认气泡」的危险操作按钮。
// 所有行内按钮用同一个尺寸（方形 24px）和同一个图标大小，视觉等高。
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '../icons/Icon';
import { leavingProps, usePresence } from '../motion/usePresence';
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
  /** 关掉「双击跳过确认」：批量 / 不可撤销的操作必须经过气泡确认 */
  requireConfirm?: boolean;
  /** 非危险操作（如批量恢复）：按钮悬停与确认键不用红色 */
  safe?: boolean;
  /** 文字按钮：显示这段文字代替图标（className 换掉默认的方形图标按钮样式） */
  text?: string;
  className?: string;
}

interface PopPos {
  right: number;
  top?: number;
  bottom?: number;
}

/**
 * 危险操作按钮：单击弹出确认气泡（锚定在按钮上），双击跳过确认直接执行（requireConfirm 时不允许跳过）。
 * 单击的动作延迟约 250ms，双击到来时取消它；所有点击都 stopPropagation，避免触发整行的选中。
 * 气泡 portal 到 body 再 position: fixed：不被列表的滚动容器裁掉，也不会因为外层菜单是玻璃（backdrop-filter 会成为 fixed 的参照）而错位。
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
  requireConfirm,
  safe,
  text,
  className,
}: ConfirmActionButtonProps) {
  const [pos, setPos] = useState<PopPos | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const open = pos !== null;
  // 关掉后气泡还要留着播完退场：记住最后一次的位置
  const lastPos = useRef<PopPos | null>(null);
  if (pos) lastPos.current = pos;
  const shown = pos ?? lastPos.current;
  const { mounted, leaving } = usePresence(open, popRef);

  const close = useCallback(() => setPos(null), []);
  // 键盘收起（Esc）时焦点还在气泡里：还给按钮
  const dismiss = useCallback(() => {
    if (popRef.current?.contains(document.activeElement)) btnRef.current?.focus({ preventScroll: true });
    setPos(null);
  }, []);
  useDismiss(open, [wrapRef, popRef], dismiss);

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
    if (open) cancelRef.current?.focus({ preventScroll: true });
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
    if (requireConfirm) return; // 两次 click 已经各自处理（打开 → 收起由第二次 click 决定），这里什么都不做
    window.clearTimeout(timer.current);
    close();
    onConfirm();
  };

  return (
    <span className={`cz-sidebar__confirm-wrap${mounted ? ' is-open' : ''}`} ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={className ?? `cz-sidebar__act${safe ? '' : ' cz-sidebar__act--danger'}`}
        title={disabled ? disabledTitle ?? label : label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        {text ?? <Icon name={icon} size={ACTION_ICON_SIZE} />}
      </button>
      {mounted && shown && createPortal(
        <div
          ref={popRef}
          className={`cz-sidebar__confirm cz-pop${leaving ? ' is-leaving' : ''}`}
          role="dialog"
          aria-label={confirmText}
          {...leavingProps(leaving)}
          // 从按钮那一角长出：气泡在按钮下方时从右上角往下，在上方时从右下角往上
          style={{
            right: shown.right,
            top: shown.top,
            bottom: shown.bottom,
            '--pop-origin': shown.top !== undefined ? 'top right' : 'bottom right',
            '--pop-dy': shown.top !== undefined ? '-4px' : '4px',
          } as CSSProperties}
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
              className={`cz-sidebar__confirm-btn ${safe ? 'cz-sidebar__confirm-btn--primary' : 'cz-sidebar__confirm-btn--danger'}`}
              onClick={() => {
                close();
                onConfirm();
              }}
            >
              {confirmLabel}
            </button>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
