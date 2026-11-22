// 上下文走势：某次请求比上一次多出来的内容来自哪里。
// 第 i 次请求的输入 = 第 i-1 次的输入 + 第 i-1 次的回复（含 tool_use 参数）+ 这些工具的返回结果 (+ 新一轮的用户消息)。
// 所以「打大上下文」的通常是上一次请求调用的工具；这里按 tool_use id 回到会话流里找到它们并粗估大小。
import type { CachePoint, Turn } from '@cosyee/shared';

/** 一次请求送给模型的输入总量（未缓存 + 写缓存 + 读缓存） */
export const inputOf = (p: CachePoint) => p.input + p.create + p.read;

export interface GrowthItem {
  id: string;
  /** 一行摘要，如 `Read: src/a.ts` */
  label: string;
  /** 粗估 token（调用参数 + 返回结果） */
  tokens: number;
}

export interface Growth {
  /** 较上一次请求的变化；第一次请求为 null */
  delta: number | null;
  /** 新一轮（或插话）的用户消息；同一轮内为空 */
  userText?: string;
  /** 上一次请求调用的工具，按估算大小从大到小 */
  items: GrowthItem[];
}

/** 粗估 token：ASCII 约 4 字符 1 token，其余（中文等）约 1 字符 1 token */
function textTokens(s: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) < 128) ascii++;
    else other++;
  }
  return Math.ceil(ascii / 4) + other;
}

/** 任意工具参数 / 结果的粗估 token；图片按固定值计，不数 base64 */
export function estimateTokens(v: unknown, depth = 0): number {
  if (typeof v === 'string') return textTokens(v);
  if (typeof v === 'number' || typeof v === 'boolean') return 1;
  if (!v || typeof v !== 'object' || depth > 8) return 0;
  if (Array.isArray(v)) return v.reduce<number>((s, x) => s + estimateTokens(x, depth + 1), 0);
  const o = v as Record<string, unknown>;
  if (o.type === 'image') return 1600;
  let n = 0;
  for (const [k, x] of Object.entries(o)) n += textTokens(k) + estimateTokens(x, depth + 1);
  return n;
}

function findTool(turns: Turn[], at: number, id: string): GrowthItem {
  const order = turns[at] ? [turns[at], ...turns.filter((_, i) => i !== at)] : turns;
  for (const t of order) {
    for (const s of t.steps) {
      if (s.kind === 'tool' && s.id === id) {
        return { id, label: s.summary || s.name, tokens: estimateTokens(s.input) + estimateTokens(s.result?.content) };
      }
    }
    const run = t.subagents.find((r) => r.toolUseId === id);
    if (run) {
      const out = run.turn.answer || [...run.turn.steps].reverse().find((s) => s.kind === 'text')?.text || '';
      return { id, label: `Agent: ${run.title}`, tokens: textTokens(run.turn.userText) + textTokens(out) };
    }
  }
  return { id, label: '（会话流里已找不到这次调用）', tokens: 0 };
}

/** 第 i 次请求的增长来源 */
export function growthOf(points: CachePoint[], i: number, turns: Turn[]): Growth {
  const cur = points[i];
  if (!cur) return { delta: null, items: [] };
  const prev = i > 0 ? points[i - 1] : undefined;
  if (!prev) return { delta: null, items: [] };
  const items = (prev.tools ?? []).map((id) => findTool(turns, prev.turn, id)).sort((a, b) => b.tokens - a.tokens);
  const g: Growth = { delta: inputOf(cur) - inputOf(prev), items };
  if (cur.turn !== prev.turn) g.userText = turns[cur.turn]?.userText ?? '';
  return g;
}
