// 权限模式菜单：自动 / 计划。样式与 ModelMenu 的触发按钮一致。
import { useRef, useState } from 'react';
import type { PermissionMode } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { Menu } from './Menu';
import { MODE_HINT, MODE_LABEL, buildModeMenu } from './modeMenuItems';
import './ModeMenu.css';

export interface ModeMenuProps {
  mode: PermissionMode;
  onChange: (m: PermissionMode) => void;
  disabled?: boolean;
}

export function ModeMenu({ mode, onChange, disabled }: ModeMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`cz-menu__trigger cz-mode__trigger${open ? ' is-open' : ''}${mode === 'plan' ? ' is-plan' : ''}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={MODE_HINT[mode]}
        // mousedown 不抢编辑区的焦点
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={mode === 'plan' ? 'mode-plan' : 'mode-auto'} size={13} />
        <span>{MODE_LABEL[mode]}</span>
      </button>
      {open && (
        <Menu
          anchor={btnRef.current}
          items={buildModeMenu(mode, onChange)}
          onClose={() => setOpen(false)}
          placement="top"
          align="start"
          minWidth={240}
        />
      )}
    </>
  );
}
