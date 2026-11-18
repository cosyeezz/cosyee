// 模型菜单：触发按钮（模型名 · 强度）+ 弹出菜单。内容见 SPEC §5 与 shared/models.ts。
import { useRef, useState } from 'react';
import type { SessionConfig } from '@cosyee/shared';
import { EFFORTS, modelLabel } from '@cosyee/shared';
import { Menu } from './Menu';
import { buildModelMenu, modelHotkeys, modelSummary } from './modelMenuItems';
import './ModelMenu.css';

export interface ModelMenuProps {
  config: SessionConfig;
  onChange: (c: SessionConfig) => void;
  disabled?: boolean;
  /** false 时隐藏 Ultracode 开关；默认显示 */
  ultracodeAvailable?: boolean;
}

export function ModelMenu({ config, onChange, disabled, ultracodeAvailable }: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`cz-menu__trigger${open ? ' is-open' : ''}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`模型与思考强度：${modelSummary(config)}`}
        // mousedown 不抢编辑区的焦点
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cz-menu__trigger-model">{modelLabel(config.model) || config.model}</span>
        <span className="cz-menu__trigger-sub">{EFFORTS.find((e) => e.id === config.effort)?.label ?? config.effort}</span>
        {config.ultracode && <span className="cz-menu__trigger-sub">Ultracode</span>}
      </button>
      {open && (
        <Menu
          anchor={btnRef.current}
          items={buildModelMenu(config, onChange, ultracodeAvailable !== false)}
          onClose={close}
          placement="top"
          align="start"
          minWidth={240}
          hotkeys={modelHotkeys(config, onChange, close)}
        />
      )}
    </>
  );
}
