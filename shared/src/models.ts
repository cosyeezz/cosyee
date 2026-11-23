import { type ApiModelMap, type CliModel, type Effort, MODEL_ALIASES } from './protocol.ts';

export interface ModelOption {
  /** 传给 --model 的值 */
  id: string;
  label: string;
  /** 菜单快捷键 1–4 */
  key?: string;
  isDefault?: boolean;
  /** 例如「包含至 November 16」 */
  note?: string;
}

/** 模型菜单的常用 4 项 */
export const PRIMARY_MODELS: ModelOption[] = [
  { id: 'opus', label: 'Opus 5.5', key: '1' },
  { id: 'sonnet', label: 'Sonnet 5.5', key: '2', isDefault: true },
  { id: 'fable', label: 'Fable 5.2', key: '3', note: '包含至 November 16' },
  { id: 'haiku', label: 'Haiku 5.5', key: '4' },
];

/** 「更多模型」子菜单 */
export const MORE_MODELS: ModelOption[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', note: '包含至 November 16' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-fable-5', label: 'Fable 5', note: '包含至 November 16' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
];

export const EFFORTS: { id: Effort; label: string; badge?: string; info?: boolean }[] = [
  { id: 'low', label: '低' },
  { id: 'medium', label: '中等', badge: '推荐' },
  { id: 'high', label: '高' },
  { id: 'xhigh', label: '超高' },
  { id: 'max', label: '最高', info: true },
];

export const EFFORT_HINT = '投入程度越高，回复越详尽，但耗时越长，且会更快消耗您的使用限额。';

/**
 * 把会话记录里的完整模型 id（claude-sonnet-5-5-20260101 / claude-opus-4-8 …）归一成菜单里的 id：
 * 精确命中菜单项 → 原样；菜单项 id + 日期后缀 → 该菜单项；否则按系列关键字落到 opus / sonnet / fable / haiku；
 * 都不是（含 <synthetic>）返回 undefined。
 */
export function canonicalModel(raw: string | undefined | null): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const id = raw.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
  if (!id || id.startsWith('<')) return undefined;
  const all = [...PRIMARY_MODELS, ...MORE_MODELS];
  const exact = all.find((m) => m.id === id);
  if (exact) return exact.id;
  const dated = all.find((m) => id.startsWith(m.id + '-') && /^\d{8}$/.test(id.slice(m.id.length + 1)));
  if (dated) return dated.id;
  const fam = PRIMARY_MODELS.find((m) => id.includes(m.id));
  return fam?.id;
}

export function modelLabel(id: string | undefined): string {
  if (!id) return '';
  const all = [...PRIMARY_MODELS, ...MORE_MODELS];
  return all.find((m) => m.id === id)?.label ?? id;
}

/** 映射表里有没有任何一项能进菜单（四个别名 + 自定义条目）。false = 不介入菜单 */
export function hasModelMapping(map: ApiModelMap | undefined | null): boolean {
  if (!map) return false;
  if (MODEL_ALIASES.some((a) => map.alias?.[a]?.id)) return true;
  return !!map.extra?.some((e) => e.id);
}

/**
 * 配了映射的 API 账号的菜单项：只列配过的别名（显示名用映射里的 label，没填就用别名的标准名），
 * 快捷键沿用 PRIMARY_MODELS 的 1–4。传给 --model 的仍是别名本身，由 CLI 按环境变量换成实际模型。
 */
export function mappedPrimaryModels(map: ApiModelMap): ModelOption[] {
  const out: ModelOption[] = [];
  for (const base of PRIMARY_MODELS) {
    const t = map.alias?.[base.id as (typeof MODEL_ALIASES)[number]];
    if (!t?.id) continue;
    out.push({
      id: base.id,
      label: t.label?.trim() || base.label,
      key: base.key,
      isDefault: base.isDefault,
      note: t.m1 ? '1M 上下文' : undefined,
    });
  }
  return out;
}

/** 配了映射的 API 账号的「自定义模型」子菜单：extra 里的条目，id 直接当 --model 的值 */
export function mappedExtraModels(map: ApiModelMap): ModelOption[] {
  return (map.extra ?? [])
    .filter((e) => e.id)
    .map((e) => ({ id: e.id, label: e.label?.trim() || e.id, note: e.m1 ? '1M 上下文' : undefined }));
}

/** 菜单里某个 id 的显示名：先查映射表，再退回内置表 */
export function modelLabelFor(id: string | undefined, map: ApiModelMap | undefined | null): string {
  if (!id) return '';
  if (map) {
    const alias = MODEL_ALIASES.find((a) => a === id);
    const t = alias ? map.alias?.[alias] : map.extra?.find((e) => e.id === id);
    if (t?.label?.trim()) return t.label.trim();
    if (t && !alias) return t.id;
  }
  return modelLabel(id);
}

// ───────────── CLI 报告的模型列表（GET /api/models）驱动菜单 ─────────────

/** 常用项里别名的顺序；热键 1–4 按这个顺序分给列表里实际有的别名 */
export const ALIAS_ORDER = ['opus', 'sonnet', 'fable', 'haiku'] as const;

const ALL_EFFORTS: Effort[] = EFFORTS.map((e) => e.id);

/** 内置表里同 id 的备注（如 Fable 的「包含至 November 16」）；CLI 的 description 是英文营销文案，不用 */
function builtinNote(id: string): string | undefined {
  const c = canonicalModel(id);
  return c && [...PRIMARY_MODELS, ...MORE_MODELS].find((m) => m.id === c && (c === id || id.startsWith(c + '-')))?.note;
}

/**
 * CLI 条目的显示名。第三方 Base URL 下别名的 displayName 只有「Opus」，版本写在 description 开头
 * （「Opus 5.5 · Best for … · $4/$20 per Mtok」），这时取 description 的第一段。
 */
export function cliModelLabel(m: CliModel): string {
  const head = m.description?.split(' · ')[0]?.trim();
  if (head && head.length <= 40 && head !== m.displayName && head.toLowerCase().startsWith(m.displayName.toLowerCase() + ' ')) return head;
  return m.displayName;
}

const stripSuffix = (s: string) => s.trim().toLowerCase().replace(/\[[^\]]*\]$/, '');
const isDated = (long: string, short: string) => long.startsWith(short + '-') && /^\d{8}$/.test(long.slice(short.length + 1));

/**
 * 会话里的模型 id 对应列表里哪一项：value 精确 → 带 / 不带日期后缀 → resolvedModel → canonicalModel 归一。
 * 用于勾选与显示名（会话记录里是 claude-haiku-4-5-20251001，旧设置里可能是 claude-haiku-4-5）。
 */
export function findModel(id: string | undefined | null, list: readonly CliModel[] | null | undefined): CliModel | undefined {
  if (!id || !list?.length) return undefined;
  const exact = list.find((m) => m.value === id);
  if (exact) return exact;
  const k = stripSuffix(id);
  return (
    list.find((m) => { const v = m.value.toLowerCase(); return v === k || isDated(v, k) || isDated(k, v); }) ??
    list.find((m) => m.resolvedModel && stripSuffix(m.resolvedModel) === k) ??
    (() => { const c = canonicalModel(id); return c ? list.find((m) => m.value === c) : undefined; })()
  );
}

/** 某个模型支持的思考强度：null = 不支持强度；列表没拉到 / 不在列表里（自定义条目）= 全部 5 档 */
export function effortsFor(id: string | undefined | null, list: readonly CliModel[] | null | undefined): Effort[] | null {
  if (!list?.length) return ALL_EFFORTS;
  const m = findModel(id, list);
  if (!m) return ALL_EFFORTS;
  return m.efforts?.length ? m.efforts : null;
}

/** 强度不在支持范围内时落到最接近的档位：先往低找，找不到再往高；不支持强度时原样保留（切回来还能用） */
export function clampEffort(effort: Effort, levels: readonly Effort[] | null): Effort {
  if (!levels?.length || levels.includes(effort)) return effort;
  const i = ALL_EFFORTS.indexOf(effort);
  for (let j = i - 1; j >= 0; j--) if (levels.includes(ALL_EFFORTS[j]!)) return ALL_EFFORTS[j]!;
  for (let j = i + 1; j < ALL_EFFORTS.length; j++) if (levels.includes(ALL_EFFORTS[j]!)) return ALL_EFFORTS[j]!;
  return levels[0]!;
}

export interface MenuModels {
  /** 常用项（带热键） */
  primary: ModelOption[];
  /** 二级子菜单 */
  more: ModelOption[];
  moreLabel: string;
}

/**
 * 模型菜单的条目。
 * - list 为 null（没拉到）：退回内置表 / 映射表，与原来完全一致。
 * - 没配映射：常用项 = 列表里的别名，其余条目进「更多模型」。
 * - 配了映射（API 账号）：常用项只留映射过的别名（显示名：映射的 label → CLI displayName），
 *   「自定义模型」= 映射里的自定义条目；CLI 的其余条目不列（第三方网关不认 Claude 全名）。
 */
export function menuModels(list: readonly CliModel[] | null | undefined, map: ApiModelMap | null | undefined): MenuModels {
  const mapped = hasModelMapping(map);
  if (!list?.length) {
    return mapped
      ? { primary: mappedPrimaryModels(map!), more: mappedExtraModels(map!), moreLabel: '自定义模型' }
      : { primary: PRIMARY_MODELS, more: MORE_MODELS, moreLabel: '更多模型' };
  }
  const primary: ModelOption[] = [];
  const add = (o: Omit<ModelOption, 'key'>) => primary.push({ ...o, key: String(primary.length + 1) });
  if (mapped) {
    const byId = new Map(mappedPrimaryModels(map!).map((o) => [o.id, o]));
    for (const a of ALIAS_ORDER) {
      const o = byId.get(a);
      if (!o) continue;
      const m = list.find((x) => x.value === a);
      const label = map!.alias?.[a]?.label?.trim() || (m ? cliModelLabel(m) : o.label);
      add({ id: a, label, isDefault: o.isDefault, note: o.note });
    }
    return { primary, more: mappedExtraModels(map!), moreLabel: '自定义模型' };
  }
  const aliases = new Set<string>(ALIAS_ORDER);
  for (const a of ALIAS_ORDER) {
    const m = list.find((x) => x.value === a);
    if (m) add({ id: a, label: cliModelLabel(m), isDefault: a === 'sonnet' || undefined, note: builtinNote(a) });
  }
  const more = list
    .filter((m) => !aliases.has(m.value))
    .map((m): ModelOption => ({ id: m.value, label: cliModelLabel(m), note: builtinNote(m.value) }));
  return { primary, more, moreLabel: '更多模型' };
}

/** 菜单 / 触发按钮上某个 id 的显示名：映射里写的显示名 → 映射的自定义条目 → CLI 列表 → 内置表 */
export function menuModelLabel(id: string | undefined, list: readonly CliModel[] | null | undefined, map: ApiModelMap | null | undefined): string {
  if (!id) return '';
  if (map && hasModelMapping(map)) {
    const alias = MODEL_ALIASES.find((a) => a === id);
    const t = alias ? map.alias?.[alias] : map.extra?.find((e) => e.id === id);
    if (t?.label?.trim()) return t.label.trim();
    if (t && !alias) return t.id;
    if (t && !list?.length) return modelLabel(id);
  }
  const m = findModel(id, list);
  return m ? cliModelLabel(m) : modelLabel(id);
}
