// 实时事件：CLI stdout 的一行 JSON（原样转发）+ 后端合成的 cosyee_user。
// 所有函数都是纯函数：不认识的事件原样返回 s，不抛错。

import type { SessionMeta } from '@cosyee/shared';
import {
  appendToolJson,
  applyAssistantMessage,
  applyToolResults,
  cloneTurn,
  commit,
  endSub,
  endThinking,
  endTool,
  ensureText,
  ensureThinking,
  ensureTool,
  findRun,
  finishTurn,
  isActive,
  makeTurn,
  maybeFinishPending,
  newBook,
  openDraft,
  thinkingStep,
  touch,
  writeText,
  type ConvState,
  type Draft,
} from './core';
import { arr, isObj, str } from './util';
import { resolveRun } from './resume';

const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

/** 事件所属的代理：顶层 parent_tool_use_id 为字符串即子代理，否则主代理 */
const scopeOf = (e: Record<string, unknown>): string => (typeof e.parent_tool_use_id === 'string' ? e.parent_tool_use_id : '');

/** 新开一轮（cosyee_user）。上一轮若仍未结束，先收尾为 done */
export function startTurn(s: ConvState, text: string, at: number): ConvState {
  let turns = s.turns;
  const last = turns[turns.length - 1];
  if (last && isActive(last)) {
    const c = cloneTurn(last);
    finishTurn(c, 'done', at);
    turns = [...turns.slice(0, -1), c];
  }
  return { turns: [...turns, makeTurn(turns.length, text, at)], meta: s.meta, book: newBook(at) };
}

function mergeInit(meta: SessionMeta, e: Record<string, unknown>): SessionMeta {
  const next: SessionMeta = { ...meta };
  if (str(e.session_id)) next.sessionId = str(e.session_id);
  if (str(e.model)) next.model = str(e.model);
  if (str(e.cwd)) next.cwd = str(e.cwd);
  const tools = strList(e.tools);
  if (tools) next.tools = tools;
  const cmds = strList(e.slash_commands);
  if (cmds) next.slashCommands = cmds;
  const skills = strList(e.skills);
  if (skills) next.skills = skills;
  const agents = strList(e.agents);
  if (agents) next.agents = agents;
  if (Array.isArray(e.mcp_servers)) {
    next.mcpServers = e.mcp_servers
      .filter(isObj)
      .map((m) => ({ name: str(m.name), status: str(m.status) }))
      .filter((m) => m.name);
  }
  return next;
}

/** 后台任务状态 → 子代理状态；其它（pending/running 等）返回 null 表示不动 */
function taskEnd(status: unknown): 'done' | 'error' | null {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'killed' || status === 'stopped' || status === 'cancelled' || status === 'error') return 'error';
  return null;
}

function applySystem(s: ConvState, e: Record<string, unknown>, now: number): ConvState {
  switch (e.subtype) {
    case 'init': {
      // init 只更新元信息，不开新轮；若当前轮在等后台收尾，标记新一回合已开始
      const meta = mergeInit(s.meta, e);
      const book = s.book ? { ...s.book, inRound: true } : s.book;
      return { ...s, meta, book };
    }
    case 'thinking_tokens': {
      const d = openDraft(s, now);
      if (!d || typeof e.estimated_tokens !== 'number') return s;
      const key = d.book.thinkingKey[''];
      const ref = key === undefined ? undefined : d.book.blocks[key];
      const st = ref && thinkingStep(d, ref);
      if (!st) return s;
      st.tokens = e.estimated_tokens;
      return commit(s, d);
    }
    case 'background_tasks_changed': {
      const d = openDraft(s, now);
      if (!d) return s;
      d.book.bgTasks = arr(e.tasks).length;
      maybeFinishPending(d);
      return commit(s, d);
    }
    case 'task_started': {
      const d = openDraft(s, now);
      const taskId = str(e.task_id);
      const toolUseId = str(e.tool_use_id);
      if (!d || !taskId || !toolUseId) return s;
      const launched = findRun(d, toolUseId);
      if (launched) {
        // 首次启动：tool_use_id 就是 Agent 调用
        if (!launched.taskId) launched.taskId = taskId;
        d.book.taskMap[taskId] = toolUseId;
      } else {
        // SendMessage 恢复子代理：tool_use_id 是 SendMessage 的，按 task_id（兜底按标题）找回原来的子代理
        const run = e.task_type === 'local_agent' ? resolveRun(s, d, { taskId, title: str(e.description) }) : undefined;
        d.book.taskMap[taskId] = run ? run.toolUseId : toolUseId;
      }
      return commit(s, d);
    }
    case 'task_updated':
    case 'task_notification': {
      const d = openDraft(s, now);
      if (!d) return s;
      const taskId = str(e.task_id);
      // 恢复后的通知里 tool_use_id 是 SendMessage 的，task_updated 则只有 task_id：依次尝试
      const run =
        findRun(d, d.book.taskMap[taskId] ?? '') ??
        findRun(d, str(e.tool_use_id)) ??
        (taskId ? d.turn.subagents.find((r) => r.taskId === taskId) : undefined);
      if (taskId && !d.book.taskMap[taskId] && str(e.tool_use_id)) d.book.taskMap[taskId] = str(e.tool_use_id);
      const status = e.subtype === 'task_updated' ? (isObj(e.patch) ? e.patch.status : undefined) : e.status;
      const end = taskEnd(status);
      if (end && run) endSub(d, run.toolUseId, end);
      maybeFinishPending(d);
      return commit(s, d);
    }
    default:
      return s;
  }
}

function applyStream(s: ConvState, e: Record<string, unknown>, now: number): ConvState {
  const ev = e.event;
  if (!isObj(ev)) return s;
  const type = ev.type;
  if (type !== 'message_start' && type !== 'content_block_start' && type !== 'content_block_delta' && type !== 'content_block_stop') return s;
  const d = openDraft(s, now);
  if (!d) return s;
  const scope = scopeOf(e);
  if (scope !== '' && !resolveRun(s, d, { toolUseId: scope })) return s;

  if (type === 'message_start') {
    d.book.curMsg[scope] = (isObj(ev.message) ? str(ev.message.id) : '') || str(e.api_message_id);
    return commit(s, d);
  }
  const index = typeof ev.index === 'number' ? ev.index : -1;
  const key = `${scope}|${d.book.curMsg[scope] || str(e.api_message_id)}:${index}`;

  if (type === 'content_block_stop') {
    endTool(d, key);
    endThinking(d, key);
    return commit(s, d);
  }
  if (type === 'content_block_start') {
    const cb = isObj(ev.content_block) ? ev.content_block : null;
    if (!cb) return s;
    if (cb.type === 'text') {
      touch(d, scope);
      const ref = ensureText(d, scope, key);
      if (ref && str(cb.text)) writeText(d, key, ref, str(cb.text), 'append');
    } else if (cb.type === 'thinking') {
      touch(d, scope);
      ensureThinking(d, scope, key, true);
    } else if (cb.type === 'tool_use' && str(cb.id)) {
      touch(d, scope);
      ensureTool(d, scope, key, str(cb.id), str(cb.name), cb.input ?? {}, true);
    } else {
      return s;
    }
    return commit(s, d);
  }
  // content_block_delta
  const delta = isObj(ev.delta) ? ev.delta : null;
  if (!delta) return s;
  if (delta.type === 'text_delta') {
    touch(d, scope);
    const ref = ensureText(d, scope, key);
    if (ref) writeText(d, key, ref, str(delta.text), 'append');
  } else if (delta.type === 'input_json_delta') {
    const ref = d.book.blocks[key];
    if (!ref || ref.kind !== 'tool' || ref.toolId === undefined) return s;
    touch(d, scope);
    appendToolJson(d, key, ref.toolId, str(delta.partial_json));
  } else if (delta.type === 'thinking_delta') {
    touch(d, scope);
    const ref = ensureThinking(d, scope, key, true);
    const st = ref && thinkingStep(d, ref);
    if (st) {
      st.text += str(delta.thinking);
      if (typeof delta.estimated_tokens === 'number') st.tokens = delta.estimated_tokens;
    }
  } else {
    return s; // signature_delta 等
  }
  return commit(s, d);
}

function applyResult(s: ConvState, e: Record<string, unknown>, now: number): ConvState {
  const d = openDraft(s, now);
  if (!d) return s;
  d.book.inRound = false;
  if (isActive(d.turn)) {
    const terminal = str(e.terminal_reason);
    const failed = e.is_error === true || (str(e.subtype) !== '' && e.subtype !== 'success');
    if (/abort|interrupt/i.test(terminal)) {
      finishTurn(d.turn, 'interrupted', now, '已中断');
    } else if (failed) {
      finishTurn(d.turn, 'error', now, str(e.result) || str(arr(e.errors)[0]) || '出错了');
    } else {
      // 成功：还有后台子代理/任务在跑时先不结束，等它们完成（CLI 会自动续轮）
      d.book.pending = true;
      maybeFinishPending(d);
    }
  }
  return commit(s, d);
}

/** 应用一个实时事件。不认识的事件原样返回 */
export function applyLive(s: ConvState, e: unknown, now: number): ConvState {
  if (!isObj(e)) return s;
  switch (e.type) {
    case 'cosyee_user':
      return startTurn(s, str(e.text), typeof e.at === 'number' ? e.at : now);
    case 'system':
      return applySystem(s, e, now);
    case 'stream_event':
      return applyStream(s, e, now);
    case 'assistant': {
      const d = openDraft(s, now);
      if (!d) return s;
      const scope = scopeOf(e);
      if (scope !== '' && !resolveRun(s, d, { toolUseId: scope })) return s;
      touch(d, scope);
      applyAssistantMessage(d, scope, e.message);
      return commit(s, d);
    }
    case 'user': {
      // 只处理 tool_result；其它 user 文本（中断提示、压缩摘要、子代理 prompt 等）忽略
      const content = isObj(e.message) ? e.message.content : undefined;
      if (!arr(content).some((b) => isObj(b) && b.type === 'tool_result')) return s;
      const d = openDraft(s, now);
      if (!d) return s;
      touch(d, scopeOf(e));
      applyToolResults(d, content, e.tool_use_result);
      maybeFinishPending(d);
      return commit(s, d);
    }
    case 'result':
      return applyResult(s, e, now);
    default:
      return s;
  }
}

export type { Draft };
