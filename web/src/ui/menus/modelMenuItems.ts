// 模型菜单的数据构造（纯函数，便于单测）。数据来自 shared/models.ts。
import type { SessionConfig } from '@cosyee/shared';
import { EFFORTS, EFFORT_HINT, MORE_MODELS, PRIMARY_MODELS, modelLabel } from '@cosyee/shared';
import type { MenuEntry } from './Menu';

/** 触发按钮上的文字：「Sonnet 5.5 · 中等」，Ultracode 开启时再加「· Ultracode」 */
export function modelSummary(config: SessionConfig): string {
  const effort = EFFORTS.find((e) => e.id === config.effort)?.label ?? config.effort;
  const parts = [modelLabel(config.model) || config.model, effort];
  if (config.ultracode) parts.push('Ultracode');
  return parts.join(' · ');
}

/** 数字热键 → 模型 id（PRIMARY_MODELS 的 key 字段） */
export function modelHotkeys(config: SessionConfig, onChange: (c: SessionConfig) => void, onDone: () => void): Record<string, () => void> {
  const out: Record<string, () => void> = {};
  for (const m of PRIMARY_MODELS) {
    if (m.key) out[m.key] = () => { onChange({ ...config, model: m.id }); onDone(); };
  }
  return out;
}

/** showUltracode=false 时隐藏 Ultracode 开关（会话实际设置表明当前模型不可用） */
export function buildModelMenu(config: SessionConfig, onChange: (c: SessionConfig) => void, showUltracode = true): MenuEntry[] {
  const pick = (id: string) => () => onChange({ ...config, model: id });
  return [
    ...PRIMARY_MODELS.map((m): MenuEntry => ({
      key: `m:${m.id}`,
      label: m.label,
      shortcut: m.key,
      badge: m.isDefault ? '默认' : undefined,
      note: m.note,
      checked: config.model === m.id,
      onSelect: pick(m.id),
    })),
    { kind: 'sep', key: 'sep1' },
    {
      key: 'effort',
      label: '思考强度',
      submenu: [
        { kind: 'text', key: 'hint', text: EFFORT_HINT },
        ...EFFORTS.map((e): MenuEntry => ({
          key: `e:${e.id}`,
          label: e.label,
          badge: e.badge,
          info: e.info ? EFFORT_HINT : undefined,
          checked: config.effort === e.id,
          onSelect: () => onChange({ ...config, effort: e.id }),
        })),
        ...(showUltracode
          ? ([
              { kind: 'sep', key: 'sep-ultra' },
              {
                key: 'ultracode',
                label: 'Ultracode',
                toggle: !!config.ultracode,
                keepOpen: true,
                onSelect: () => onChange({ ...config, ultracode: !config.ultracode }),
              },
            ] as MenuEntry[])
          : []),
      ],
    },
    {
      key: 'more',
      label: '更多模型',
      submenu: MORE_MODELS.map((m): MenuEntry => ({
        key: `m:${m.id}`,
        label: m.label,
        note: m.note,
        checked: config.model === m.id,
        onSelect: pick(m.id),
      })),
    },
  ];
}
