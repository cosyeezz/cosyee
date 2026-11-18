// 历史：主会话 / 子代理 jsonl 的原始条目 → 视图模型。
// 与实时共用同一套块处理（core.ts），区别只在「轮」的边界：
//   实时：cosyee_user 开轮、result 收尾；历史：真实用户消息开轮，system/turn_duration 收尾（没有就在下一轮开始或文件结束时收尾）。
// 历史里每条条目只含一个 content block（同 message.id 分多行），与流式 index 一致，直接复用 applyAssistantMessage。

import type { SessionMeta, Turn } from '@cosyee/shared';
import {
  applyAssistantMessage,
  applyToolResults,
  finishTurn,
  isActive,
  makeTurn,
  newBook,
  touch,
  type ConvState,
  type Draft,
} from './core';
import { arr, isObj, str } from './util';

/** 不是用户说的话的 user 文本（标签开头） */
const NOISE_RE = /^\s*<(?:bash-[\w-]+|local-command-[\w-]+|task-notification|system-reminder|tick|teammate-message|cross-session-message|command-[\w-]+)[\s>]/;
const INTERRUPT_PREFIX = '[Request interrupted by user';
const CMD_NAME_RE = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const CMD_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

interface Ctx {
  turns: Turn[];
  cur: Draft | null;
  /** 最近一次收起的轮的草稿（取它的 book 供实时事件接着用） */
  last: Draft | null;
  meta: SessionMeta;
  /** 子代理模式：条目全是 isSidechain，且首条 user 是 prompt */
  sub: boolean;
}

/** user 条目的文字：字符串，或 text 块拼接；含 tool_result 的返回 null */
function userText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const b of arr(content)) {
    if (!isObj(b)) continue;
    if (b.type === 'tool_result') return null;
    if (b.type === 'text') parts.push(str(b.text));
  }
  return parts.join('\n');
}

/** 真实用户输入：返回要显示的文字；不是则返回 null。斜杠命令 `<command-name>` 还原成 `/name args` */
function realUserText(text: string): string | null {
  const cmd = CMD_NAME_RE.exec(text);
  if (cmd && cmd[1]) {
    const args = CMD_ARGS_RE.exec(text)?.[1]?.trim();
    return args ? `${cmd[1]} ${args}` : cmd[1];
  }
  if (!text.trim() || NOISE_RE.test(text)) return null;
  return text;
}

function entryTime(raw: Record<string, unknown>, fallback: number): number {
  const t = typeof raw.timestamp === 'string' ? Date.parse(raw.timestamp) : NaN;
  return Number.isFinite(t) ? t : fallback;
}

/** 收起当前轮（仍未结束的按 done 收尾，时间取最后一条条目） */
function closeCur(ctx: Ctx, running: boolean): void {
  const cur = ctx.cur;
  if (!cur) return;
  if (isActive(cur.turn) && !running) finishTurn(cur.turn, 'done', cur.book.lastTs);
  ctx.turns.push(cur.turn);
  ctx.last = cur;
  ctx.cur = null;
}

function openTurn(ctx: Ctx, text: string, at: number): void {
  closeCur(ctx, false);
  ctx.cur = { turn: makeTurn(ctx.turns.length, text, at), book: newBook(at), now: at };
}

function processEntries(entries: unknown[], sub: boolean, running: boolean): Ctx {
  const ctx: Ctx = { turns: [], cur: null, last: null, meta: {}, sub };
  let last = 0;
  for (const raw of entries) {
    if (!isObj(raw)) continue;
    const at = entryTime(raw, last);
    last = at;
    if (!sub && raw.isSidechain === true) continue; // 主会话文件里的子代理内容不展示（走 subagent 接口）
    if (ctx.cur) {
      ctx.cur.now = at;
      ctx.cur.book.lastTs = at;
    }
    if (!ctx.meta.sessionId && str(raw.sessionId)) ctx.meta.sessionId = str(raw.sessionId);
    if (!ctx.meta.cwd && str(raw.cwd)) ctx.meta.cwd = str(raw.cwd);

    switch (raw.type) {
      case 'user': {
        if (raw.isMeta === true || raw.isCompactSummary === true) break;
        const content = isObj(raw.message) ? raw.message.content : undefined;
        const text = userText(content);
        if (text === null) {
          if (sub && !ctx.cur) openTurn(ctx, '', at);
          if (ctx.cur) applyToolResults(ctx.cur, content, raw.toolUseResult);
          break;
        }
        if (text.startsWith(INTERRUPT_PREFIX)) {
          if (ctx.cur && isActive(ctx.cur.turn)) finishTurn(ctx.cur.turn, 'interrupted', at, '已中断');
          break;
        }
        if (sub) {
          if (!ctx.cur && text.trim()) openTurn(ctx, text, at);
          break;
        }
        const real = realUserText(text);
        if (real !== null) openTurn(ctx, real, at);
        break;
      }
      case 'assistant': {
        if (raw.isApiErrorMessage === true) break;
        if (!ctx.cur && sub) openTurn(ctx, '', at);
        if (!ctx.cur) break;
        touch(ctx.cur, '');
        applyAssistantMessage(ctx.cur, '', raw.message);
        break;
      }
      case 'system': {
        if (raw.subtype !== 'turn_duration' || !ctx.cur || !isActive(ctx.cur.turn)) break;
        const dur = typeof raw.durationMs === 'number' ? raw.durationMs : 0;
        const ended = typeof raw.timestamp === 'string' && Number.isFinite(Date.parse(raw.timestamp)) ? at : ctx.cur.turn.startedAt + dur;
        finishTurn(ctx.cur.turn, 'done', ended);
        break;
      }
      default:
        break; // attachment / queue-operation / ai-title / ... 全部忽略
    }
  }
  closeCur(ctx, running);
  return ctx;
}

/**
 * 主会话 jsonl 条目 → 状态。opts.running=true 表示进程仍在跑，最后一轮保持未结束（等待 replay / 实时事件接上）。
 * 返回的 book 属于最后一轮，实时事件可以直接接着应用。
 */
export function buildFromHistory(entries: unknown[], opts: { running?: boolean } = {}): ConvState {
  const ctx = processEntries(entries, false, opts.running === true);
  return { turns: ctx.turns, meta: ctx.meta, book: ctx.last?.book ?? null };
}

/** 子代理 jsonl 条目 → 一轮。首条 user（prompt）作为 userText；没有则用标题 */
export function buildSubagentTurn(entries: unknown[], opts: { title: string; toolUseId: string; running?: boolean }): Turn {
  const ctx = processEntries(entries, true, opts.running === true);
  const t = ctx.turns[0] ?? makeTurn(0, '', 0);
  return { ...t, id: `sub-${opts.toolUseId}`, userText: t.userText || opts.title };
}
