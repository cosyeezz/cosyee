// 实时事件：CLI stdout 的一行 JSON（原样转发）+ 后端合成的 cosyee_user。
// 所有函数都是纯函数：不认识的事件原样返回 s，不抛错。

import { parseDelegateNotification, type CliModelCost, type SessionMeta } from '@cosyee/shared';
import {
  addUserSkill,
  appendToolJson,
  applyAssistantMessage,
  applySkillBody,
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
  isDelegateRun,
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
import { arr, isObj, str, textOf } from './util';
import { delegateEnded, resolveRun } from './resume';
import { applyDelegateNotification } from './delegate';
import { recordCache, recordCacheDelta, recordCompact } from './cacheHit';

const strList = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

/** 事件所属的代理：顶层 parent_tool_use_id 为字符串即子代理，否则主代理 */
const scopeOf = (e: Record<string, unknown>): string => (typeof e.parent_tool_use_id === 'string' ? e.parent_tool_use_id : '');

/**
 * 新开一轮（cosyee_user）。上一轮若仍未结束，先收尾为 done。
 * opts.id：消息 uuid（记为 Turn.userId；同 id 的轮已存在时不重复建，例如历史已含 steering 的 queued_command）；
 * opts.steer：steering 插话——UI 上同样是新的一轮，之后 CLI 的 result 落在最后这一轮上。
 */
export function startTurn(s: ConvState, text: string, at: number, opts: { id?: string; steer?: boolean } = {}): ConvState {
  if (opts.id && s.turns.some((t) => t.userId === opts.id)) return s;
  let turns = s.turns;
  const last = turns[turns.length - 1];
  if (last && isActive(last)) {
    const c = cloneTurn(last);
    finishTurn(c, 'done', at);
    turns = [...turns.slice(0, -1), c];
  }
  const turn = makeTurn(turns.length, text, at, { userId: opts.id, steer: opts.steer });
  // 用户输入「/技能名 参数」：CLI 实时不回传正文，只记一条没有 body 的手动加载
  const cmd = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (cmd && s.meta.skills?.includes(cmd[1]!)) addUserSkill(turn, cmd[1]!, (cmd[2] ?? '').trim());
  return { turns: [...turns, turn], meta: s.meta, book: newBook(at) };
}

const CMD_NAME_RE = /<command-name>\s*\/?([^<\s]+)\s*<\/command-name>/;
const CMD_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/;

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
    case 'cosyee_agent_params': {
      // 服务端按设置补上的子代理模型 / 强度（委派刚开始，还没有输出）；嵌套子代理的调用找不到就忽略
      const d = openDraft(s, now);
      const run = d && findRun(d, str(e.tool_use_id));
      if (!d || !run) return s;
      if (str(e.model)) run.model = str(e.model);
      if (str(e.effort)) run.effort = str(e.effort);
      return commit(s, d);
    }
    case 'compact_boundary': {
      // 会话压缩：只记主线程（子代理自己的压缩不算）
      if (e.parent_tool_use_id) return s;
      const meta = recordCompact(s.meta, e, Math.max(0, s.turns.length - 1), now);
      return meta === s.meta ? s : { ...s, meta };
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
  if (type === 'message_delta') {
    // 最终 usage 补到缓存命中率的点上（只记主线程）
    if (scopeOf(e) !== '' || !s.turns.length) return s;
    const id = str(e.api_message_id) || s.book?.curMsg[''] || '';
    const meta = recordCacheDelta(s.meta, id, ev.usage, s.turns.length - 1);
    return meta === s.meta ? s : { ...s, meta };
  }
  if (type !== 'message_start' && type !== 'content_block_start' && type !== 'content_block_delta' && type !== 'content_block_stop') return s;
  const scope = scopeOf(e);
  // 委派停止 / 超时后，服务端还会补发没关的文本块的结束事件：只是收尾，不是续跑，不能让它回到运行中
  if (type === 'content_block_stop' && scope !== '' && delegateEnded(s, scope)) return s;
  const d = openDraft(s, now);
  if (!d) return s;
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

/** result.modelUsage → CLI 自己算的各模型累计花费（核对价格表用）；没有时返回 null */
export function cliCostOf(modelUsage: unknown): CliModelCost[] | null {
  if (!isObj(modelUsage)) return null;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  const out: CliModelCost[] = [];
  for (const [model, u] of Object.entries(modelUsage)) {
    if (!isObj(u) || typeof u.costUSD !== 'number') continue;
    const create = n(u.cacheCreationInputTokens);
    const h1 = n(u.cacheCreationEphemeral1hInputTokens);
    const m5 = 'cacheCreationEphemeral5mInputTokens' in u ? n(u.cacheCreationEphemeral5mInputTokens) : Math.max(0, create - h1);
    out.push({ model, input: n(u.inputTokens), output: n(u.outputTokens), read: n(u.cacheReadInputTokens), create5m: m5, create1h: h1, costUSD: n(u.costUSD) });
  }
  return out.length ? out : null;
}

function applyResult(s0: ConvState, e: Record<string, unknown>, now: number): ConvState {
  const cli = cliCostOf(e.modelUsage);
  const s = cli ? { ...s0, meta: { ...s0.meta, cliCost: cli } } : s0;
  const d = openDraft(s, now);
  if (!d) return s;
  d.book.inRound = false;
  if (isActive(d.turn)) {
    const terminal = str(e.terminal_reason);
    const failed = e.is_error === true || (str(e.subtype) !== '' && e.subtype !== 'success');
    // aborted_tools / aborted_streaming：被用户中断（send_now / rewind），即使 is_error 为 true 也不算出错
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
      return startTurn(s, str(e.text), typeof e.at === 'number' ? e.at : now, { id: str(e.id) || undefined, steer: e.mode === 'next' });
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
      const next = commit(s, d);
      // 缓存命中率：只记主线程（子代理的 usage 不算）
      return scope === '' ? { ...next, meta: recordCache(next.meta, isObj(e.message) ? e.message : null, next.turns.length - 1) } : next;
    }
    case 'user': {
      // 后台委派的完成通知（服务端注入给 CLI 的 user 消息，若被回放出来）：不开轮、不显示，只给委派子代理落定结果
      if (scopeOf(e) === '' && isObj(e.message)) {
        const nt = textOf(e.message.content);
        const note = nt.includes('cosyee-delegate-notification') ? parseDelegateNotification(nt) : null;
        if (note) return applyDelegateNotification(s, note, now);
      }
      // 技能正文：CLI 合成的 user 消息（isSynthetic），归给该代理最近一个等正文的 Skill 调用
      if (e.isSynthetic === true) {
        const text = textOf(isObj(e.message) ? e.message.content : undefined);
        if (!text.startsWith('Base directory for this skill:')) return s;
        const d = openDraft(s, now);
        if (!d) return s;
        applySkillBody(d, scopeOf(e), text);
        return commit(s, d);
      }
      // 用户 /技能名 的回放（<command-name>）：cosyee_user 到达时 init 可能还没带来 skills 列表，在这里补记
      if (e.isReplay === true && isObj(e.message) && typeof e.message.content === 'string') {
        const name = CMD_NAME_RE.exec(e.message.content)?.[1];
        const last = s.turns[s.turns.length - 1];
        if (!name || !last || !s.meta.skills?.includes(name) || last.userText.trim().split(/\s/)[0] !== `/${name}`) return s;
        if (last.skills?.some((k) => k.id === `user:${last.id}`)) return s;
        const d = openDraft(s, now);
        if (!d) return s;
        addUserSkill(d.turn, name, (CMD_ARGS_RE.exec(e.message.content)?.[1] ?? '').trim());
        return commit(s, d);
      }
      // 只处理 tool_result；其它 user 文本（中断提示、压缩摘要、子代理 prompt 等）忽略
      const content = isObj(e.message) ? e.message.content : undefined;
      if (!arr(content).some((b) => isObj(b) && b.type === 'tool_result')) return s;
      const d = openDraft(s, now);
      if (!d) return s;
      // 后台委派的过程事件可能在主轮结束后才到（运行还在更早的轮里）：不重开主轮
      const scope = scopeOf(e);
      if (!(scope !== '' && s.turns.some((t) => t.subagents.some((r) => r.toolUseId === scope && isDelegateRun(r))))) touch(d, scope);
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
