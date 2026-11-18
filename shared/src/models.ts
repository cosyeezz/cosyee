import type { Effort } from './protocol.ts';

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
