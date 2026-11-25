// agy 的模型 id 是「基础模型-强度」拼起来的（gemini-4-neon-high），个别模型不分强度。
// 这里负责拆分、归组成界面用的列表，以及把「基础模型 + 强度」解析回 agy 认的完整 id。
import type { DelegateModel, DelegateModelList, Effort } from '@cosyee/shared';
import type { Json } from '../transcript.js';

export interface AvailableModel {
  id: string;
  name: string;
}

const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const SUFFIX_RE = /^(.+)-(low|medium|high|xhigh|max)$/;

export interface SplitModel {
  model: string;
  effort: Effort | null;
}

/** ACP session/new、session/load 结果里的 models.availableModels */
export function parseAvailable(models: Json | undefined): AvailableModel[] {
  const list: Json[] = Array.isArray(models?.availableModels) ? models.availableModels : [];
  return list
    .filter((m) => m && typeof m.modelId === 'string' && m.modelId)
    .map((m) => ({ id: m.modelId, name: typeof m.name === 'string' && m.name ? m.name : m.modelId }));
}

/** 完整 id → 基础模型 + 强度 */
export function splitModelId(id: string): SplitModel {
  const m = SUFFIX_RE.exec(id);
  return m ? { model: m[1]!, effort: m[2] as Effort } : { model: id, effort: null };
}

/** 按基础模型归组，保持 agy 给的顺序；强度按低到高排 */
export function groupModels(available: AvailableModel[]): DelegateModel[] {
  const map = new Map<string, DelegateModel>();
  for (const a of available) {
    const { model, effort } = splitModelId(a.id);
    let g = map.get(model);
    if (!g) {
      const base = effort ? a.name.replace(/\s*\([^()]*\)\s*$/, '') : a.name;
      g = { value: model, displayName: base || a.name, efforts: [] };
      map.set(model, g);
    }
    if (effort && !g.efforts.includes(effort)) g.efforts.push(effort);
  }
  for (const g of map.values()) g.efforts.sort((x, y) => EFFORT_ORDER.indexOf(x) - EFFORT_ORDER.indexOf(y));
  return [...map.values()];
}

export function toModelList(available: AvailableModel[], current: string | null, at: number): DelegateModelList {
  return { models: groupModels(available), current: current ? splitModelId(current) : null, at };
}

/** 离 want 最近的档位（一样近取低的） */
function nearest(efforts: Effort[], want: Effort): Effort {
  const dist = (e: Effort) => Math.abs(EFFORT_ORDER.indexOf(e) - EFFORT_ORDER.indexOf(want));
  return efforts.reduce((best, e) => (dist(e) < dist(best) ? e : best));
}

export interface ResolveOptions {
  /** 基础模型或完整 id；不传 = 沿用 current 的基础模型 */
  model?: string;
  effort?: Effort;
  /** 强度是调用时点名的：模型没有这一档就报错。否则（来自默认设置）落到最近的一档，且让位给完整 id 自带的强度 */
  strictEffort: boolean;
  /** 会话当前的完整 id */
  current: string | null;
}

/** 解析要切到的完整 id。列表还没拿到时无从校验，拼好后原样透传 */
export function resolveModelId(available: AvailableModel[], o: ResolveOptions): { id: string } | { error: string } {
  const cur = o.current ? splitModelId(o.current) : null;
  const asked = o.model ?? cur?.model;
  if (!asked) return { error: '不知道当前模型，请同时指定 model' };
  const given: SplitModel = o.model ? splitModelId(o.model) : { model: asked, effort: null };
  const want = o.effort && (o.strictEffort || !given.effort) ? o.effort : given.effort;
  if (!available.length) return { id: want ? `${given.model}-${want}` : asked };

  const groups = groupModels(available);
  const group = groups.find((g) => g.value === given.model);
  if (!group) return { error: `没有模型 ${asked}。可用：${groups.map((g) => g.value).join(', ')}` };
  const all = group.efforts.join(', ');
  if (!group.efforts.length) {
    if (want && (o.strictEffort || given.effort)) return { error: `模型 ${group.value} 不支持选择思考强度` };
    return { id: group.value };
  }
  if (want && group.efforts.includes(want)) return { id: `${group.value}-${want}` };
  if (want && (o.strictEffort || given.effort)) return { error: `模型 ${group.value} 没有思考强度 ${want}。可用：${all}` };
  return { id: `${group.value}-${nearest(group.efforts, want ?? cur?.effort ?? 'high')}` };
}
