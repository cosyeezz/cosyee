// 添加账号对话框顶部的「添加到」分组选择：Claude / Antigravity，复用 GooeyIndicator 做粘性融合胶囊。
// 切换组时组件会换挂载：传 fromTarget 让指示器首帧停在旧位置、下一帧滑向新位置，保持胶囊连贯。
import { useEffect, useState, type KeyboardEvent } from 'react';
import { GooeyIndicator } from '../motion/GooeyIndicator';
import { motionOK } from '../motion/reduced';

export type AddTarget = 'claude' | 'agy';

export interface AddTargetSegProps {
  target: AddTarget;
  onChange: (t: AddTarget) => void;
  /** 本机没装 Antigravity CLI：禁用 Antigravity 选项并给出说明 */
  agyDisabled?: boolean;
  /** 从另一组切过来时的旧值，用于触发胶囊滑动 */
  fromTarget?: AddTarget;
}

const TARGETS: { id: AddTarget; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'agy', label: 'Antigravity' },
];

export function AddTargetSeg({ target, onChange, agyDisabled, fromTarget }: AddTargetSegProps) {
  const [shown, setShown] = useState<AddTarget>(() => (fromTarget && fromTarget !== target && motionOK() ? fromTarget : target));

  useEffect(() => {
    if (shown === target) return;
    const raf = requestAnimationFrame(() => setShown(target));
    return () => cancelAnimationFrame(raf);
  }, [shown, target]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const btns = [...(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)') ?? [])];
    if (btns.length < 2) return;
    const idx = btns.indexOf(e.currentTarget);
    const dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = btns[(idx + dir + btns.length) % btns.length]!;
    const nextId = next.dataset.target as AddTarget | undefined;
    next.focus();
    if (nextId && nextId !== target) onChange(nextId);
  };

  return (
    <div className="cz-acct-dlg__target">
      <div className="cz-sidebar__seg" role="radiogroup" aria-label="添加到">
        <GooeyIndicator activeKey={shown} selector=".cz-sidebar__seg-btn.is-on" />
        {TARGETS.map((o) => {
          const disabled = o.id === 'agy' && !!agyDisabled;
          const on = target === o.id;
          return (
            <button
              key={o.id}
              type="button"
              role="radio"
              data-target={o.id}
              aria-checked={on}
              disabled={disabled}
              title={disabled ? '没有安装 Antigravity CLI' : undefined}
              className={`cz-sidebar__seg-btn${shown === o.id ? ' is-on' : ''}`}
              onClick={() => !disabled && target !== o.id && onChange(o.id)}
              onKeyDown={onKeyDown}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {agyDisabled && <div className="cz-acct-dlg__target-note">没有安装 Antigravity CLI，暂不能添加 Antigravity 账号</div>}
    </div>
  );
}
