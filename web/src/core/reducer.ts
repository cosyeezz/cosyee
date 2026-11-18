// 会话流视图模型 reducer：CLI 事件（实时）/ jsonl 条目（历史）→ Turn[]。
// 纯函数、不可变更新、无 React/DOM 依赖；不认识的事件一律忽略，不抛错。规则见 SPEC.md §4。
// 实现拆在 reducer/ 下：core（草稿与簿记）、live（实时事件）、history（历史条目）、util（摘要等小工具）。

import type { RunStatus, Turn } from '@cosyee/shared';
import { cloneTurn, finishTurn, isActive, type ConvState } from './reducer/core';
import { buildFromHistory, buildSubagentTurn } from './reducer/history';
import { applyLive } from './reducer/live';
import { isObj, str, toolSummary } from './reducer/util';
import { parseUserText } from './composer';

export type { ConvState } from './reducer/core';
export { toolSummary };

export function initState(): ConvState {
  return { turns: [], meta: {}, book: null };
}

/**
 * 应用一个实时事件（CLI stdout 的一行 JSON，或后端合成的 cosyee_user）。
 * now 用作没有时间戳的事件的结束时间，默认 Date.now()。
 */
export function applyEvent(s: ConvState, e: unknown, now: number = Date.now()): ConvState {
  return applyLive(s, e, now);
}

/**
 * 进程状态变化兜底：
 * - exited：当前轮未结束 → error，reason 取 error 文案；
 * - idle：当前轮未结束 → done（result 之后还在等后台子代理但进程已空闲时也在此收尾）。
 */
export function applyStatus(s: ConvState, status: RunStatus, error?: string, now: number = Date.now()): ConvState {
  const last = s.turns[s.turns.length - 1];
  if (!last || !isActive(last) || (status !== 'exited' && status !== 'idle')) return s;
  const t = cloneTurn(last);
  if (status === 'exited') finishTurn(t, 'error', now, error || '会话进程已退出');
  else finishTurn(t, 'done', now);
  return { turns: [...s.turns.slice(0, -1), t], meta: s.meta, book: s.book };
}

/** 主会话 jsonl 条目 → 状态。opts.running：进程仍在跑，最后一轮保持未结束 */
export function fromHistory(entries: unknown[], opts?: { running?: boolean }): ConvState {
  return buildFromHistory(entries, opts);
}

/**
 * 订阅时的 replay：丢掉历史里最后一条真实用户消息开始的那一轮（及之后），再依次应用 replay 事件。
 * replay 里含 cosyee_user 时，只有历史最后一轮的用户消息与之相同才丢（历史还没落盘时不会误删上一轮）。
 * 对同一份 replay 重复调用结果相同（断线重连安全）。
 */
export function applyReplay(s: ConvState, events: unknown[]): ConvState {
  if (events.length === 0) return s;
  let base = s;
  const last = s.turns[s.turns.length - 1];
  if (last) {
    const first = events.find((e) => isObj(e) && e.type === 'cosyee_user');
    const same = !isObj(first) || parseUserText(str(first.text)).userText === last.userText;
    if (same) base = { turns: s.turns.slice(0, -1), meta: s.meta, book: null };
  }
  let cur = base;
  for (const e of events) cur = applyLive(cur, e, Date.now());
  return cur;
}

/** 子代理 jsonl 条目 → 它自己的一轮（浮层打开历史会话里的子代理时用；实时子代理直接取 turn.subagents[i].turn） */
export function subagentTurnFromHistory(entries: unknown[], opts: { title: string; toolUseId: string }): Turn {
  return buildSubagentTurn(entries, opts);
}

/** 子代理 jsonl 里实际使用的模型（第一条带 model 的 assistant 消息）；没有返回 undefined */
export function subagentModelFromHistory(entries: unknown[]): string | undefined {
  for (const e of entries) {
    if (isObj(e) && e.type === 'assistant' && isObj(e.message) && str(e.message.model)) return str(e.message.model);
  }
  return undefined;
}
