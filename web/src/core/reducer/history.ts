// 历史：主会话 / 子代理 jsonl 的原始条目 → 视图模型。
// 与实时共用同一套块处理（core.ts），区别只在「轮」的边界：
//   实时：cosyee_user 开轮、result 收尾；历史：真实用户消息开轮，system/turn_duration 收尾（没有就在下一轮开始或文件结束时收尾）。
// 历史里每条条目只含一个 content block（同 message.id 分多行），与流式 index 一致，直接复用 applyAssistantMessage。

import { isCosyeeUsageEvent, parseDelegateNotification, type CachePoint, type SessionMeta, type Turn } from '@cosyee/shared';
import {
  addUserSkill,
  applyAssistantMessage,
  applySkillBody,
  applyToolResults,
  finishTurn,
  isActive,
  makeTurn,
  newBook,
  parseSkillBody,
  touch,
  type ConvState,
  type Draft,
} from './core';
import { arr, isObj, str, textOf } from './util';
import { parseDelegateStop, settleFromNotification } from './delegate';
import { cachePointOf, compactMarkOf, pushCachePoint, pushCompactMark } from './cacheHit';

/** 不是用户说的话的 user 文本（标签开头） */
const NOISE_RE = /^\s*<(?:bash-[\w-]+|local-command-[\w-]+|task-notification|system-reminder|tick|teammate-message|cross-session-message|cosyee-delegate-notification|command-[\w-]+)[\s>]/;
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
  /** 当前轮由斜杠命令开启时的命令名 / 参数；紧随其后的技能正文条目据此建 user 来源的技能加载 */
  cmd: { name: string; args: string } | null;
  /** 子代理模式下 cosyee_usage 报告的上下文窗口 */
  contextWindow?: number;
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

function openTurn(ctx: Ctx, text: string, at: number, extra?: { userId?: string; steer?: boolean }): void {
  closeCur(ctx, false);
  ctx.cur = { turn: makeTurn(ctx.turns.length, text, at, extra), book: newBook(at), now: at };
}

/** 这条条目是不是真实的用户输入（会开新轮的 user 文本） */
function isUserPrompt(raw: Record<string, unknown>): boolean {
  if (raw.type !== 'user' || raw.isMeta === true || raw.isCompactSummary === true) return false;
  const text = userText(isObj(raw.message) ? raw.message.content : undefined);
  if (text === null || text.startsWith(INTERRUPT_PREFIX)) return false;
  return realUserText(text) !== null;
}

/**
 * 按 uuid / parentUuid 过滤掉被 rewind 废弃的分支（CLI 的 rewind 不截断文件，而是从旧节点另起一支，旧支留在文件里）。
 * 做法：从文件里最后一个带 uuid 的条目沿 parentUuid 回溯到根，得到「当前链」；不在链上的条目里，
 * 只有「所在分支的起点是一条真实用户输入」的才丢弃（rewind 的新旧分支一定从用户输入分叉）。
 * 起点不是用户输入的链外条目（例如并行工具调用里的兄弟 tool_result）一律保留，避免误删。
 * 保守处理：没有 uuid 的条目原样保留；compact 边界（parentUuid 为空、logicalParentUuid 指向压缩前）沿 logicalParentUuid 接上；
 * 链断了（父节点不在文件里且无法接上）、出现环、没有 uuid 时整体不过滤，结果与过滤前完全一致。
 */
function activeBranch(entries: unknown[]): unknown[] {
  interface Node {
    parent: string | null;
    logical: string | null;
    prompt: boolean;
  }
  const nodes = new Map<string, Node>();
  let leaf: string | null = null;
  for (const raw of entries) {
    if (!isObj(raw) || raw.isSidechain === true) continue;
    const id = str(raw.uuid);
    if (!id) continue;
    nodes.set(id, { parent: str(raw.parentUuid) || null, logical: str(raw.logicalParentUuid) || null, prompt: isUserPrompt(raw) });
    leaf = id;
  }
  if (!leaf) return entries;

  /** 上一个节点：先 parentUuid，缺失时用 logicalParentUuid（compact 边界）。undefined = 链断；null = 到根 */
  const up = (n: Node): string | null | undefined => {
    if (n.parent && nodes.has(n.parent)) return n.parent;
    if (n.logical && nodes.has(n.logical)) return n.logical;
    return n.parent ? undefined : null;
  };

  const chain = new Set<string>();
  for (let cur: string | null = leaf; cur; ) {
    if (chain.has(cur)) return entries; // 环
    chain.add(cur);
    const next = up(nodes.get(cur)!);
    if (next === undefined) return entries; // 链断
    cur = next;
  }
  if (chain.size === nodes.size) return entries;

  const dead = new Map<string, boolean>();
  const isDead = (id: string): boolean => {
    const known = dead.get(id);
    if (known !== undefined) return known;
    const path: string[] = [];
    let cur: string | null = id;
    let verdict = false;
    while (cur) {
      const hit = dead.get(cur);
      if (hit !== undefined) {
        verdict = hit;
        break;
      }
      if (chain.has(cur)) {
        verdict = false;
        break;
      }
      path.push(cur);
      const node: Node = nodes.get(cur)!;
      const next = up(node);
      if (next === undefined || next === null || path.length > nodes.size) {
        verdict = node.prompt; // 分支起点（根或父节点缺失）：是用户输入才算废弃支
        break;
      }
      if (chain.has(next)) {
        verdict = node.prompt; // 从链上分叉出去的第一个节点
        break;
      }
      cur = next;
    }
    for (const p of path) dead.set(p, verdict);
    return verdict;
  };

  return entries.filter((raw) => {
    if (!isObj(raw) || raw.isSidechain === true) return true;
    const id = str(raw.uuid);
    return !id || !isDead(id);
  });
}

/** 工具结果里有 delegate_stop 的停止结果：把对应的委派子代理落定为已停止 */
function settleStopped(ctx: Ctx, content: unknown, at: number): void {
  for (const b of arr(content)) {
    if (!isObj(b) || b.type !== 'tool_result' || b.is_error === true) continue;
    const stop = parseDelegateStop(textOf(b.content));
    if (!stop) continue;
    const turns = ctx.cur ? [...ctx.turns, ctx.cur.turn] : ctx.turns;
    settleFromNotification(turns, { ...stop, status: 'stopped', conversationId: '', description: '' }, at);
  }
}

function processEntries(entries: unknown[], sub: boolean, running: boolean): Ctx {
  const ctx: Ctx = { turns: [], cur: null, last: null, meta: {}, sub, cmd: null };
  let last = 0;
  for (const raw of sub ? entries : activeBranch(entries)) {
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
        // 后台委派的完成通知：不是用户说的话，不开轮；只用它给对应的委派子代理落定结果
        if (!sub) {
          const nt = userText(isObj(raw.message) ? raw.message.content : undefined);
          const note = nt !== null && nt.includes('cosyee-delegate-notification') ? parseDelegateNotification(nt) : null;
          if (note) {
            settleFromNotification(ctx.cur ? [...ctx.turns, ctx.cur.turn] : ctx.turns, note, at);
            break;
          }
        }
        if (raw.isMeta === true) {
          // 其它 meta 一律忽略；只认技能正文：有 sourceToolUseID 的归 Skill 工具调用，没有的是用户 /技能名 的正文
          const mc = isObj(raw.message) ? raw.message.content : undefined;
          const mt = userText(mc);
          if (ctx.cur && mt !== null && parseSkillBody(mt)) {
            const src = str(raw.sourceToolUseID);
            if (src) applySkillBody(ctx.cur, '', mt, src);
            else if (ctx.cmd) {
              const k = addUserSkill(ctx.cur.turn, ctx.cmd.name, ctx.cmd.args);
              const parsed = parseSkillBody(mt)!;
              k.body = parsed.body;
              if (parsed.dir) k.dir = parsed.dir;
              ctx.cmd = null;
            }
          }
          break;
        }
        if (raw.isCompactSummary === true) break;
        const content = isObj(raw.message) ? raw.message.content : undefined;
        const text = userText(content);
        if (text === null) {
          if (sub && !ctx.cur) openTurn(ctx, '', at);
          if (ctx.cur) {
            applyToolResults(ctx.cur, content, raw.toolUseResult);
            if (!sub) settleStopped(ctx, content, at);
          }
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
        if (real !== null) {
          openTurn(ctx, real, at, { userId: str(raw.uuid) || undefined });
          const c = CMD_NAME_RE.exec(text);
          ctx.cmd = c?.[1] ? { name: c[1].replace(/^\//, ''), args: CMD_ARGS_RE.exec(text)?.[1]?.trim() ?? '' } : null;
        }
        break;
      }
      case 'attachment': {
        // steering 插话：CLI 在工具轮之间把它并入上下文，transcript 里没有 user 条目，只有 queued_command 附件。
        // 在 UI 上单独成一轮（steer），其后的模型输出归它；source_uuid 即我们发送时的 id
        const a = raw.attachment;
        if (sub || !isObj(a) || a.type !== 'queued_command' || a.commandMode !== 'prompt') break;
        const prompt = typeof a.prompt === 'string' ? a.prompt : userText(a.prompt);
        // 执行中送达的委派完成通知也是这种附件：只落定对应的委派子代理
        const note = prompt ? parseDelegateNotification(prompt) : null;
        if (note) {
          settleFromNotification(ctx.cur ? [...ctx.turns, ctx.cur.turn] : ctx.turns, note, at);
          break;
        }
        const real = prompt ? realUserText(prompt) : null;
        if (real !== null) openTurn(ctx, real, at, { userId: str(a.source_uuid) || undefined, steer: true });
        break;
      }
      case 'assistant': {
        if (raw.isApiErrorMessage === true) {
          // API 错误条目：把当前活跃轮落定为 error（保留错误原因，不把错误文本当作回答正文）
          if (!sub && ctx.cur && isActive(ctx.cur.turn)) {
            const content = isObj(raw.message) ? raw.message.content : undefined;
            const reason = textOf(content).trim() || '出错了';
            finishTurn(ctx.cur.turn, 'error', at, reason);
          }
          break;
        }
        if (!ctx.cur && sub) openTurn(ctx, '', at);
        if (!ctx.cur) break;
        touch(ctx.cur, '');
        applyAssistantMessage(ctx.cur, '', raw.message);
        const p = cachePointOf(raw.message, sub ? 0 : ctx.turns.length);
        if (p) pushCachePoint((ctx.meta.cache ??= []), p);
        break;
      }
      case 'system': {
        if (sub && isCosyeeUsageEvent(raw)) {
          const pt: CachePoint = raw.point.turn === 0 ? raw.point : { ...raw.point, turn: 0 };
          pushCachePoint((ctx.meta.cache ??= []), pt);
          if (raw.window !== undefined) ctx.contextWindow = raw.window;
          break;
        }
        if (raw.subtype === 'compact_boundary') {
          if (sub) break;
          const cache = ctx.meta.cache;
          const m = compactMarkOf(raw, ctx.cur ? ctx.turns.length : Math.max(0, ctx.turns.length - 1), cache?.length ? cache[cache.length - 1]!.id : null, at);
          if (m) pushCompactMark((ctx.meta.compactions ??= []), m);
          break;
        }
        if (raw.subtype !== 'turn_duration' || !ctx.cur || !isActive(ctx.cur.turn)) break;
        const dur = typeof raw.durationMs === 'number' ? raw.durationMs : 0;
        const ended = typeof raw.timestamp === 'string' && Number.isFinite(Date.parse(raw.timestamp)) ? at : ctx.cur.turn.startedAt + dur;
        finishTurn(ctx.cur.turn, 'done', ended);
        break;
      }
      default:
        break; // queue-operation / last-prompt / ai-title / 其他附件 ... 全部忽略
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

export interface SubagentHistory {
  turn: Turn;
  cache?: CachePoint[];
  contextWindow?: number;
}

/** 子代理 jsonl 条目 → 轮次 + 用量（含 assistant usage 与 cosyee_usage） */
export function buildSubagentHistory(entries: unknown[], opts: { title: string; toolUseId: string; running?: boolean }): SubagentHistory {
  const ctx = processEntries(entries, true, opts.running === true);
  const t = ctx.turns[0] ?? makeTurn(0, '', 0);
  const turn: Turn = { ...t, id: `sub-${opts.toolUseId}`, userText: t.userText || opts.title };
  return {
    turn,
    ...(ctx.meta.cache?.length ? { cache: ctx.meta.cache } : {}),
    ...(ctx.contextWindow !== undefined ? { contextWindow: ctx.contextWindow } : {}),
  };
}

/** 子代理 jsonl 条目 → 一轮。首条 user（prompt）作为 userText；没有则用标题 */
export function buildSubagentTurn(entries: unknown[], opts: { title: string; toolUseId: string; running?: boolean }): Turn {
  return buildSubagentHistory(entries, opts).turn;
}
