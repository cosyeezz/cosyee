// 权限模式菜单的数据构造（纯函数，便于单测）。
import type { PermissionMode } from '@cosyee/shared';
import type { MenuEntry } from './Menu';

export const MODE_LABEL: Record<PermissionMode, string> = { auto: '自动', plan: '计划' };

export const MODE_HINT: Record<PermissionMode, string> = {
  auto: '自动模式：直接执行，不需要审批',
  plan: '计划模式：先只读调研并给出计划，你批准后再执行',
};

export function buildModeMenu(mode: PermissionMode, onChange: (m: PermissionMode) => void): MenuEntry[] {
  return [
    { key: 'mode:auto', label: '自动模式', note: '直接执行，不需要审批', checked: mode === 'auto', onSelect: () => onChange('auto') },
    { key: 'mode:plan', label: '计划模式', note: '先调研并给出计划，你批准后再执行', checked: mode === 'plan', onSelect: () => onChange('plan') },
  ];
}
