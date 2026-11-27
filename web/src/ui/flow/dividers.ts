// 会话流里的分隔提示：模型切换与上下文压缩。纯函数，便于单测。
import type { CachePoint, CompactMark, SessionMeta, Turn } from '@cosyee/shared';
import { formatDuration, formatStamp, prettyModel } from './format';
import type { TurnGroup } from './mergeSteer';

export interface DividerAnchor {
  /** 事件所在轮在全部 turns（含隐藏轮）里的下标 */
  turn: number;
  /** 插在该轮之前还是之后 */
  pos: 'before' | 'after';
}

export interface FlowDividerItem {
  /** 稳定的 React key */
  key: string;
  kind: 'model' | 'compact';
  /** 居中显示的简短文案 */
  text: string;
  /** 悬停详情 */
  title?: string;
  anchor: DividerAnchor;
}

export interface PlacedDividers {
  /** 每个可见组（按 groups 下标）前面要渲染的分隔提示 */
  beforeGroup: FlowDividerItem[][];
  /** 每个可见组（按 groups 下标）后面要渲染的分隔提示 */
  afterGroup: FlowDividerItem[][];
  /** 落在所有可见组之后（footer 之前）的分隔提示 */
  trailing: FlowDividerItem[];
}

const formatK = (tokens: number): string => `${Math.round(Math.max(0, tokens) / 1000)}k`;
const formatExact = (tokens: number): string => Math.max(0, Math.round(tokens)).toLocaleString('en-US');

function formatCompact(mark: CompactMark): { text: string; title: string } {
  const head = mark.trigger === 'auto' ? '已自动压缩上下文' : '已压缩上下文';
  const kRange = mark.post != null ? `${formatK(mark.pre)} → ${formatK(mark.post)}` : formatK(mark.pre);
  const hasDur = mark.durationMs != null && Number.isFinite(mark.durationMs);
  const durText = hasDur ? formatDuration(mark.durationMs!) : '';

  const textParts = [head, kRange];
  if (durText) textParts.push(durText);

  const exactRange = mark.post != null ? `${formatExact(mark.pre)} → ${formatExact(mark.post)} tokens` : `${formatExact(mark.pre)} tokens`;
  const titleParts = [`${head}：${exactRange}`];
  if (durText) titleParts.push(`耗时 ${durText}`);
  if (mark.at > 0 && Number.isFinite(mark.at)) titleParts.push(formatStamp(mark.at));

  return { text: textParts.join(' · '), title: titleParts.join(' · ') };
}

interface SortableDivider {
  item: FlowDividerItem;
  /** 在 cache 时间线上的位置：cache[i] 为 i，其后的压缩为 i + 0.5（无 after 则 -0.5） */
  cachePos: number;
  /** 同位置的原始出现顺序 */
  seq: number;
}

/**
 * 从全部 turns（含隐藏轮）与 SessionMeta 提取模型切换和上下文压缩分隔提示，
 * 按发生顺序排列。
 */
export function buildDividers(_allTurns: readonly Turn[], meta: SessionMeta | undefined): FlowDividerItem[] {
  if (!meta) return [];
  const cache = meta.cache ?? [];
  const compactions = meta.compactions ?? [];
  if (cache.length === 0 && compactions.length === 0) return [];

  const cacheIndex = new Map<string, { idx: number; pt: CachePoint }>();
  for (let i = 0; i < cache.length; i++) {
    const pt = cache[i]!;
    cacheIndex.set(pt.id, { idx: i, pt });
  }

  const out: SortableDivider[] = [];

  // 1. 模型切换：按顺序遍历 cache，跳过没有 model 的点；首个模型不算切换
  const seenTurns = new Set<number>();
  let prevModel: string | null = null;
  for (let i = 0; i < cache.length; i++) {
    const pt = cache[i]!;
    const isFirstInTurn = !seenTurns.has(pt.turn);
    seenTurns.add(pt.turn);
    if (!pt.model) continue;
    if (prevModel === null) {
      prevModel = pt.model;
      continue;
    }
    if (pt.model !== prevModel) {
      const nextLabel = prettyModel(pt.model);
      const prevLabel = prettyModel(prevModel);
      out.push({
        item: {
          key: `model:${pt.id}`,
          kind: 'model',
          text: `已切换到 ${nextLabel}`,
          title: `${prevLabel} → ${nextLabel}（${pt.model}）`,
          anchor: { turn: pt.turn, pos: isFirstInTurn ? 'before' : 'after' },
        },
        cachePos: i,
        seq: i,
      });
      prevModel = pt.model;
    }
  }

  // 2. 上下文压缩：after 为 null 或在上一轮之前 → 放在 mark.turn 之前；轮中途压缩 → 放在 mark.turn 之后
  for (let i = 0; i < compactions.length; i++) {
    const mark = compactions[i]!;
    const afterHit = mark.after != null ? cacheIndex.get(mark.after) : undefined;
    const pos: 'before' | 'after' = !afterHit || afterHit.pt.turn < mark.turn ? 'before' : 'after';
    const { text, title } = formatCompact(mark);
    out.push({
      item: {
        key: `compact:${mark.id}`,
        kind: 'compact',
        text,
        title,
        anchor: { turn: mark.turn, pos },
      },
      cachePos: afterHit ? afterHit.idx + 0.5 : -0.5,
      seq: i,
    });
  }

  // 同一位置按发生顺序排列：先比锚点轮次与前后，再比 cache 时间线，最后比原数组下标
  out.sort((a, b) => {
    if (a.item.anchor.turn !== b.item.anchor.turn) return a.item.anchor.turn - b.item.anchor.turn;
    const pa = a.item.anchor.pos === 'before' ? 0 : 1;
    const pb = b.item.anchor.pos === 'before' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (a.cachePos !== b.cachePos) return a.cachePos - b.cachePos;
    return a.seq - b.seq;
  });

  return out.map((x) => x.item);
}

/**
 * 把分隔提示映射到可见组（groups）：
 * -「第 N 轮之前」：插到第一个包含原始下标 ≥ N 的可见轮的组之前；若后面没有可见轮，落到 trailing（footer 之前）
 * -「第 N 轮之后」：插到包含原始下标 ≤ N 的最后一个可见轮的组之后；若 N < 0 则忽略
 */
export function placeDividers(
  allTurns: readonly Turn[],
  groups: readonly TurnGroup[],
  dividers: readonly FlowDividerItem[],
): PlacedDividers {
  const beforeGroup: FlowDividerItem[][] = groups.map(() => []);
  const afterGroup: FlowDividerItem[][] = groups.map(() => []);
  const trailing: FlowDividerItem[] = [];

  if (dividers.length === 0) return { beforeGroup, afterGroup, trailing };

  const idxByRef = new Map<Turn, number>();
  const idxById = new Map<string, number>();
  for (let i = 0; i < allTurns.length; i++) {
    const t = allTurns[i]!;
    idxByRef.set(t, i);
    idxById.set(t.id, i);
  }

  // 每组所覆盖的原始下标范围（parts 按时间递增）
  const ranges = groups.map((g) => {
    let min = Infinity;
    let max = -Infinity;
    for (const p of g.parts) {
      const idx = idxByRef.get(p) ?? idxById.get(p.id);
      if (idx === undefined) continue;
      if (idx < min) min = idx;
      if (idx > max) max = idx;
    }
    return { min, max };
  });

  for (const d of dividers) {
    const n = d.anchor.turn;
    if (!Number.isFinite(n) || n < 0) continue;

    if (d.anchor.pos === 'before') {
      const target = ranges.findIndex((r) => r.max >= n);
      if (target >= 0) beforeGroup[target]!.push(d);
      else trailing.push(d);
    } else {
      let target = -1;
      for (let gi = ranges.length - 1; gi >= 0; gi--) {
        if (ranges[gi]!.min <= n) {
          target = gi;
          break;
        }
      }
      if (target >= 0) afterGroup[target]!.push(d);
      else if (groups.length > 0) beforeGroup[0]!.push(d);
      else trailing.push(d);
    }
  }

  return { beforeGroup, afterGroup, trailing };
}
