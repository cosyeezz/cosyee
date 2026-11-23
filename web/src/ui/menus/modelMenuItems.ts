// 模型菜单的数据构造（纯函数，便于单测）。条目来自 shared/models.ts 的 menuModels：
// - list：CLI 报告的该账号实际可用模型（GET /api/models）；没拉到时退回内置表，行为与原来一致；
// - map：配了模型映射的 API 账号，常用项换成映射过的别名，「更多模型」换成映射里的自定义条目。
// 思考强度子菜单只列当前模型支持的档位，不支持强度的模型整项隐藏。
import type { ApiModelMap, CliModel, SessionConfig } from '@cosyee/shared';
import { EFFORTS, EFFORT_HINT, clampEffort, effortsFor, findModel, menuModelLabel, menuModels } from '@cosyee/shared';
import type { MenuEntry } from './Menu';

export interface ModelMenuCtx {
  /** CLI 报告的模型列表；null / 不传 = 用内置表 */
  list?: readonly CliModel[] | null;
  /** 配了模型映射的 API 账号的映射表 */
  map?: ApiModelMap | null;
  /** 传了就在菜单末尾显示「刷新模型列表」 */
  onRefresh?: () => void;
  refreshing?: boolean;
}

/** 触发按钮上的强度文字；当前模型不支持强度时为 null */
export function effortSummary(config: SessionConfig, ctx: ModelMenuCtx = {}): string | null {
  if (!effortsFor(config.model, ctx.list)) return null;
  return EFFORTS.find((e) => e.id === config.effort)?.label ?? config.effort;
}

/** 触发按钮上的文字：「Sonnet 5.5 · 中等」，Ultracode 开启时再加「· Ultracode」；不支持强度的模型不显示强度 */
export function modelSummary(config: SessionConfig, ctx: ModelMenuCtx = {}): string {
  const effort = effortSummary(config, ctx);
  const parts = [menuModelLabel(config.model, ctx.list, ctx.map) || config.model];
  if (effort) parts.push(effort);
  if (config.ultracode) parts.push('Ultracode');
  return parts.join(' · ');
}

/** 换模型：强度不在新模型支持范围内时落到最接近的档位 */
function withModel(config: SessionConfig, id: string, ctx: ModelMenuCtx): SessionConfig {
  return { ...config, model: id, effort: clampEffort(config.effort, effortsFor(id, ctx.list)) };
}

/** 数字热键 → 常用项（按顺序 1–4） */
export function modelHotkeys(
  config: SessionConfig,
  onChange: (c: SessionConfig) => void,
  onDone: () => void,
  ctx: ModelMenuCtx = {},
): Record<string, () => void> {
  const out: Record<string, () => void> = {};
  for (const m of menuModels(ctx.list, ctx.map).primary) {
    if (m.key) out[m.key] = () => { onChange(withModel(config, m.id, ctx)); onDone(); };
  }
  return out;
}

/** showUltracode=false 时隐藏 Ultracode 开关（会话实际设置表明当前模型不可用） */
export function buildModelMenu(
  config: SessionConfig,
  onChange: (c: SessionConfig) => void,
  showUltracode = true,
  ctx: ModelMenuCtx = {},
): MenuEntry[] {
  const { primary, more, moreLabel } = menuModels(ctx.list, ctx.map);
  const pick = (id: string) => () => onChange(withModel(config, id, ctx));
  // 会话里的 id 可能是全名 / 带日期后缀，归一到列表里的那一项再勾选
  const current = findModel(config.model, ctx.list)?.value ?? config.model;
  const levels = effortsFor(config.model, ctx.list);
  const item = (m: (typeof primary)[number], withKey: boolean): MenuEntry => ({
    key: `m:${m.id}`,
    label: m.label,
    shortcut: withKey ? m.key : undefined,
    badge: withKey && m.isDefault ? '默认' : undefined,
    note: m.note,
    checked: current === m.id,
    onSelect: pick(m.id),
  });
  const efforts = levels ? EFFORTS.filter((e) => levels.includes(e.id)) : [];
  const rest: MenuEntry[] = [
    // 不支持强度的模型（如 Haiku 4.5）整项隐藏
    ...(levels
      ? ([{
          key: 'effort',
          label: '思考强度',
          submenu: [
            { kind: 'text', key: 'hint', text: EFFORT_HINT },
            ...efforts.map((e): MenuEntry => ({
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
        }] as MenuEntry[])
      : []),
    // 配了映射时这是「自定义模型」（映射里自由添加的条目）；一条都没有就不显示
    ...(more.length
      ? ([{ key: 'more', label: moreLabel, submenu: more.map((m) => item(m, false)) }] as MenuEntry[])
      : []),
    ...(ctx.onRefresh
      ? ([
          ...(levels || more.length ? [{ kind: 'sep', key: 'sep-refresh' } as MenuEntry] : []),
          {
            key: 'refresh',
            label: ctx.refreshing ? '正在刷新模型列表…' : '刷新模型列表',
            disabled: ctx.refreshing,
            keepOpen: true,
            onSelect: ctx.onRefresh,
          },
        ] as MenuEntry[])
      : []),
  ];
  return [...primary.map((m) => item(m, true)), ...(rest.length ? [{ kind: 'sep', key: 'sep1' } as MenuEntry] : []), ...rest];
}
