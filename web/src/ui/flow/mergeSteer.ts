// 插话合并（只影响显示，不动 reducer 的轮：rewind、缓存 / 花费图仍按原来的轮计）。
// 插话会让上一轮在没有最终答复时就收尾，它的「已完成」和过程文字都不是交付。
// 这里把它和后面的插话轮拼成一组：用户气泡依次排列，下面只有一个状态行、一份答复。
import type { SubagentRun, Turn } from '@cosyee/shared';

export interface TurnGroup {
  /** 组内原来的轮，旧 → 新；没有插话时只有一个 */
  parts: Turn[];
  /** 合并后的轮（id 取第一轮，保证后续插话并进来时展开状态等不丢）；只有一个时就是它自己 */
  turn: Turn;
}

/** 这一轮没有交付：正常收尾，但最后停在工具调用上（answer 为空）。中断 / 出错不算，它们的状态要保留给用户看 */
const undelivered = (t: Turn): boolean => t.status === 'done' && t.answer.trim() === '';

function merge(parts: Turn[]): Turn {
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const steps: Turn['steps'] = [];
  // 后台恢复的子代理会在后面的轮里再出现一份：位置取首次，内容取最后
  const runs = new Map<string, SubagentRun>();
  const skills: NonNullable<Turn['skills']> = [];
  for (const p of parts) {
    const base = steps.length;
    for (const r of p.subagents) runs.set(r.toolUseId, base ? { ...r, afterStep: (r.afterStep ?? 0) + base } : r);
    for (const k of p.skills ?? []) skills.push(base ? { ...k, afterStep: (k.afterStep ?? 0) + base } : k);
    steps.push(...p.steps);
  }
  return { ...last, id: first.id, startedAt: first.startedAt, steps, subagents: [...runs.values()], skills };
}

// 按组里最后一轮缓存，轮对象没变就返回同一个组（TurnItem 按引用比较，流式时只重渲染变化的那组）
const cache = new WeakMap<Turn, TurnGroup>();

function groupOf(parts: Turn[]): TurnGroup {
  const last = parts[parts.length - 1]!;
  const hit = cache.get(last);
  if (hit && hit.parts.length === parts.length && hit.parts.every((p, i) => p === parts[i])) return hit;
  const g: TurnGroup = { parts, turn: parts.length === 1 ? last : merge(parts) };
  cache.set(last, g);
  return g;
}

/** 把「未交付的轮 + 紧跟其后的插话轮」合成一组；上一轮已有最终答复的插话照常独立成组 */
export function groupSteered(turns: readonly Turn[]): TurnGroup[] {
  const groups: Turn[][] = [];
  for (const t of turns) {
    const cur = groups[groups.length - 1];
    if (cur && t.steer && undelivered(cur[cur.length - 1]!)) cur.push(t);
    else groups.push([t]);
  }
  return groups.map(groupOf);
}
