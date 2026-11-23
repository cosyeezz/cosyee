// 模型菜单：触发按钮（模型名 · 强度）+ 弹出菜单。内容见 SPEC §5 与 shared/models.ts。
import { useRef, useState } from 'react';
import type { ApiModelMap, CliModel, SessionConfig } from '@cosyee/shared';
import { menuModelLabel } from '@cosyee/shared';
import { Menu } from './Menu';
import { type ModelMenuCtx, buildModelMenu, effortSummary, modelHotkeys, modelSummary } from './modelMenuItems';
import './ModelMenu.css';

export interface ModelMenuProps {
  config: SessionConfig;
  onChange: (c: SessionConfig) => void;
  disabled?: boolean;
  /** false 时隐藏 Ultracode 开关；默认显示 */
  ultracodeAvailable?: boolean;
  /** 配了模型映射的 API 账号：菜单改用映射项。null / 不传 = 用内置模型表 */
  modelMap?: ApiModelMap | null;
  /** CLI 报告的该账号实际可用模型；null / 不传 = 用内置模型表 */
  modelList?: readonly CliModel[] | null;
  /** 重新拉取模型列表（菜单末尾「刷新模型列表」）；resolve 后菜单恢复可点 */
  onRefreshModels?: () => Promise<unknown>;
}

export function ModelMenu({ config, onChange, disabled, ultracodeAvailable, modelMap, modelList, onRefreshModels }: ModelMenuProps) {
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);
  const ctx: ModelMenuCtx = {
    list: modelList,
    map: modelMap,
    refreshing,
    onRefresh: onRefreshModels
      ? () => {
          setRefreshing(true);
          onRefreshModels().catch(() => {}).finally(() => setRefreshing(false));
        }
      : undefined,
  };
  const effort = effortSummary(config, ctx);
  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`cz-menu__trigger${open ? ' is-open' : ''}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`模型与思考强度：${modelSummary(config, ctx)}`}
        // mousedown 不抢编辑区的焦点
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cz-menu__trigger-model">{menuModelLabel(config.model, modelList, modelMap) || config.model}</span>
        {effort && <span className="cz-menu__trigger-sub">{effort}</span>}
        {config.ultracode && <span className="cz-menu__trigger-sub">Ultracode</span>}
      </button>
      {open && (
        <Menu
          anchor={btnRef.current}
          items={buildModelMenu(config, onChange, ultracodeAvailable !== false, ctx)}
          onClose={close}
          placement="top"
          align="start"
          minWidth={240}
          hotkeys={modelHotkeys(config, onChange, close, ctx)}
        />
      )}
    </>
  );
}
