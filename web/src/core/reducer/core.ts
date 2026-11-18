// reducer 的核心：当前轮的「草稿」与簿记（Book）。
// 约定：对外的 applyXxx 都是不可变更新——先 openDraft 克隆最后一轮，在草稿上随意改，再 commit 生成新状态。
// 簿记只服务当前这一轮，开新轮时整体重置，所以克隆的开销不随会话长度增长。

import type { SessionMeta, Step, SubagentRun, ThinkingStep, ToolStep, Turn, TurnStatus } from '@cosyee/shared';
import { arr, isAgentName, isObj, peekJsonString, statusLine, str, textOf, toolSummary, tryParse } from './util';
import { parseUserText } from '../composer';

/** 一个内容块（流式 index 对应的块）当前落在哪里 */
export interface BlockRef {
  /** 主代理为 ''，子代理为其 Agent 工具调用的 tool_use id */
  scope: string;
  kind: 'text' | 'thinking' | 'tool';
  /** answer：正在作为最终答复；step：已在 steps 里（idx；-1 表示空内容被丢弃） */
  where: 'answer' | 'step';
  idx: number;
  toolId?: string;
}

export interface Book {
  /** `${scope}|${messageId}:${index}` → 块位置 */
  blocks: Record<string, BlockRef>;
  /** `${scope}|${messageId}` → 已见到的完整 block 数（完整消息没有 index，按到达顺序对应流式 index） */
  seen: Record<string, number>;
  /** tool_use id → 位置；agent=true 表示这是主代理的子代理启动，对应 turn.subagents 而不是 steps */
  tools: Record<string, { scope: string; idx: number; agent?: true }>;
  /** 流式工具输入的 JSON 片段缓冲，key 同 blocks */
  bufs: Record<string, string>;
  /** scope → 当前占据 turn.answer 的块 key */
  answerKey: Record<string, string>;
  /** scope → 当前 message_start 的消息 id */
  curMsg: Record<string, string>;
  /** scope → 最近一个仍在流式的思考块 key（thinking_tokens 事件回填 tokens 用） */
  thinkingKey: Record<string, string>;
  /** 后台任务 task_id → Agent 的 tool_use id */
  taskMap: Record<string, string>;
  /** 后台启动（async_launched）的子代理 tool_use id */
  asyncSubs: Record<string, true>;
  /** 最近一次 background_tasks_changed 快照里的任务数 */
  bgTasks: number;
  /** 主代理本轮 CLI 内部「一回合」是否进行中（result 置 false，有主代理内容置 true） */
  inRound: boolean;
  /** 已收到成功的 result，但还有后台子代理/任务没结束，等它们结束再收尾 */
  pending: boolean;
  /** 匿名消息 id 计数 */
  seq: number;
  /** 历史回放用：最近一条条目的时间 */
  lastTs: number;
}

export interface ConvState {
  turns: Turn[];
  meta: SessionMeta;
  /** 当前轮的簿记；没有任何轮时为 null */
  book: Book | null;
}

export interface Draft {
  turn: Turn;
  book: Book;
  now: number;
}

export function newBook(now = 0): Book {
  return {
    blocks: {},
    seen: {},
    tools: {},
    bufs: {},
    answerKey: {},
    curMsg: {},
    thinkingKey: {},
    taskMap: {},
    asyncSubs: {},
    bgTasks: 0,
    inRound: true,
    pending: false,
    seq: 0,
    lastTs: now,
  };
}

function cloneBook(b: Book): Book {
  return {
    ...b,
    blocks: { ...b.blocks },
    seen: { ...b.seen },
    tools: { ...b.tools },
    bufs: { ...b.bufs },
    answerKey: { ...b.answerKey },
    curMsg: { ...b.curMsg },
    thinkingKey: { ...b.thinkingKey },
    taskMap: { ...b.taskMap },
    asyncSubs: { ...b.asyncSubs },
  };
}

/** 克隆一轮（含 steps 里的对象与子代理的轮）；input / result 等深层内容只替换不修改，可共享 */
export function cloneTurn(t: Turn): Turn {
  return {
    ...t,
    steps: t.steps.map((s) => ({ ...s })) as Step[],
    subagents: t.subagents.map((r) => ({ ...r, turn: cloneTurn(r.turn) })),
  };
}

export const isActive = (t: Turn): boolean => t.status === 'understanding' || t.status === 'running';

// ───────────── 草稿的开合 ─────────────

/** 克隆最后一轮得到草稿；没有任何轮时返回 null */
export function openDraft(s: ConvState, now: number): Draft | null {
  const last = s.turns[s.turns.length - 1];
  if (!last) return null;
  return { turn: cloneTurn(last), book: s.book ? cloneBook(s.book) : newBook(now), now };
}

export function commit(s: ConvState, d: Draft): ConvState {
  const turns = s.turns.slice();
  turns[turns.length - 1] = d.turn;
  return { turns, meta: s.meta, book: d.book };
}

// ───────────── 轮的创建与收尾 ─────────────

export function makeTurn(index: number, text: string, at: number, extra?: { userId?: string; steer?: boolean }): Turn {
  const { userText, attachments } = parseUserText(text);
  return {
    id: `t${index}`,
    ...(extra?.userId ? { userId: extra.userId } : {}),
    ...(extra?.steer ? { steer: true } : {}),
    userText,
    attachments,
    status: 'understanding',
    statusText: '正在理解问题',
    steps: [],
    answer: '',
    subagents: [],
    startedAt: at,
  };
}

/** 结束一轮（含其中仍在运行的子代理）；原地修改，调用方保证传入的是草稿 */
export function finishTurn(t: Turn, status: Exclude<TurnStatus, 'understanding' | 'running'>, now: number, reason?: string): void {
  t.status = status;
  t.endedAt = now;
  if (reason !== undefined) t.reason = reason;
  else delete t.reason;
  for (const s of t.steps) {
    if ((s.kind === 'tool' || s.kind === 'thinking') && s.streaming) delete s.streaming;
  }
  for (const r of t.subagents) {
    if (r.status === 'running') {
      r.status = status === 'done' ? 'done' : 'error';
      finishTurn(r.turn, r.status, now, r.status === 'error' ? (reason ?? '已中断') : undefined);
    }
  }
}

/** 已经 done 的轮又收到实质事件（CLI 自动续轮，例如后台子代理完成后继续）：重新打开 */
export function reopen(d: Draft): void {
  if (d.turn.status === 'done') {
    d.turn.status = 'running';
    delete d.turn.endedAt;
    delete d.turn.reason;
    d.book.pending = false;
  }
}

/** 主代理有内容时调用：重开已结束的轮并标记回合进行中。子代理的内容不影响 inRound */
export function touch(d: Draft, scope: string): void {
  reopen(d);
  if (scope === '') d.book.inRound = true;
}

/** 有 result 之后、后台任务全部结束且没有新回合时，收尾 */
export function maybeFinishPending(d: Draft): void {
  const b = d.book;
  if (!b.pending || b.inRound || b.bgTasks > 0) return;
  if (d.turn.subagents.some((r) => r.status === 'running')) return;
  if (!isActive(d.turn)) return;
  finishTurn(d.turn, 'done', d.now);
  b.pending = false;
}

// ───────────── 定位 ─────────────

export function getTurn(d: Draft, scope: string): Turn | undefined {
  if (scope === '') return d.turn;
  return d.turn.subagents.find((r) => r.toolUseId === scope)?.turn;
}

export function findRun(d: Draft, toolUseId: string): SubagentRun | undefined {
  return d.turn.subagents.find((r) => r.toolUseId === toolUseId);
}

function markRunning(t: Turn): void {
  if (t.status === 'understanding') t.status = 'running';
}

// ───────────── 文字 ─────────────

/** 把正在占据 answer 的文字收进 steps（之后又出现了工具/思考/新一段文字） */
export function flushAnswer(d: Draft, scope: string): void {
  const key = d.book.answerKey[scope];
  if (key === undefined) return;
  delete d.book.answerKey[scope];
  const t = getTurn(d, scope);
  if (!t) return;
  const ref = d.book.blocks[key];
  const base: BlockRef = ref ?? { scope, kind: 'text', where: 'answer', idx: -1 };
  if (t.answer.trim() === '') {
    t.answer = '';
    d.book.blocks[key] = { ...base, where: 'step', idx: -1 };
    return;
  }
  const idx = t.steps.length;
  t.steps.push({ kind: 'text', text: t.answer });
  t.answer = '';
  d.book.blocks[key] = { ...base, where: 'step', idx };
}

export function ensureText(d: Draft, scope: string, key: string): BlockRef | null {
  const t = getTurn(d, scope);
  if (!t) return null;
  const ex = d.book.blocks[key];
  if (ex && ex.kind === 'text') return ex;
  flushAnswer(d, scope);
  const ref: BlockRef = { scope, kind: 'text', where: 'answer', idx: -1 };
  d.book.blocks[key] = ref;
  d.book.answerKey[scope] = key;
  t.answer = '';
  return ref;
}

/** 写入文字块内容：set 覆盖（完整消息），append 追加（text_delta）。同时更新状态行文字 */
export function writeText(d: Draft, key: string, ref: BlockRef, text: string, mode: 'set' | 'append'): void {
  const t = getTurn(d, ref.scope);
  if (!t) return;
  let full: string;
  if (ref.where === 'answer') {
    if (d.book.answerKey[ref.scope] !== key) return;
    t.answer = mode === 'set' ? text : t.answer + text;
    full = t.answer;
  } else {
    const st = t.steps[ref.idx];
    if (!st || st.kind !== 'text') return;
    st.text = mode === 'set' ? text : st.text + text;
    full = st.text;
  }
  const line = statusLine(full);
  if (line) {
    t.statusText = line;
    markRunning(t);
  }
}

// ───────────── 思考 ─────────────

export function ensureThinking(d: Draft, scope: string, key: string, streaming: boolean): BlockRef | null {
  const t = getTurn(d, scope);
  if (!t) return null;
  const ex = d.book.blocks[key];
  if (ex && ex.kind === 'thinking') return ex;
  flushAnswer(d, scope);
  const step: ThinkingStep = { kind: 'thinking', text: '' };
  if (streaming) step.streaming = true;
  const idx = t.steps.length;
  t.steps.push(step);
  const ref: BlockRef = { scope, kind: 'thinking', where: 'step', idx };
  d.book.blocks[key] = ref;
  if (streaming) d.book.thinkingKey[scope] = key;
  markRunning(t);
  return ref;
}

export function thinkingStep(d: Draft, ref: BlockRef): ThinkingStep | undefined {
  const st = getTurn(d, ref.scope)?.steps[ref.idx];
  return st && st.kind === 'thinking' ? st : undefined;
}

export function endThinking(d: Draft, key: string): void {
  const ref = d.book.blocks[key];
  if (!ref || ref.kind !== 'thinking') return;
  const st = thinkingStep(d, ref);
  if (st) delete st.streaming;
  if (d.book.thinkingKey[ref.scope] === key) delete d.book.thinkingKey[ref.scope];
}

// ───────────── 工具与子代理 ─────────────

/** Agent 调用参数里的 model / effort（实际模型以子代理输出的 message.model 为准，不覆盖） */
function applyRunParams(run: SubagentRun, o: Record<string, unknown>): void {
  if (str(o.model) && !run.model) run.model = str(o.model);
  if (str(o.effort)) run.effort = str(o.effort);
}

function addSubagent(d: Draft, id: string, input: unknown): void {
  if (findRun(d, id)) return;
  const o = isObj(input) ? input : {};
  const run: SubagentRun = {
    toolUseId: id,
    title: str(o.description),
    status: 'running',
    turn: {
      id: `sub-${id}`,
      userText: str(o.prompt),
      attachments: [],
      status: 'understanding',
      statusText: '正在理解问题',
      steps: [],
      answer: '',
      subagents: [],
      startedAt: d.now,
    },
  };
  const st = str(o.subagent_type);
  if (st) run.subagentType = st;
  applyRunParams(run, o);
  d.turn.subagents.push(run);
}

export function ensureTool(d: Draft, scope: string, key: string, id: string, name: string, input: unknown, streaming: boolean): void {
  const t = getTurn(d, scope);
  if (!t) return;
  const ex = d.book.tools[id];
  if (ex) {
    d.book.blocks[key] = { scope: ex.scope, kind: 'tool', where: 'step', idx: ex.idx, toolId: id };
    return;
  }
  flushAnswer(d, scope);
  markRunning(t);
  if (scope === '' && isAgentName(name)) {
    addSubagent(d, id, input);
    d.book.tools[id] = { scope, idx: -1, agent: true };
    d.book.blocks[key] = { scope, kind: 'tool', where: 'step', idx: -1, toolId: id };
    return;
  }
  const idx = t.steps.length;
  const step: ToolStep = { kind: 'tool', id, name, input, summary: toolSummary(name, input) };
  if (streaming) step.streaming = true;
  t.steps.push(step);
  d.book.tools[id] = { scope, idx };
  d.book.blocks[key] = { scope, kind: 'tool', where: 'step', idx, toolId: id };
}

/** 工具输入有了新值（完整对象，或流式期间尚不能解析的原始字符串） */
export function setToolInput(d: Draft, id: string, input: unknown): void {
  const ref = d.book.tools[id];
  if (!ref) return;
  if (ref.agent) {
    const run = findRun(d, id);
    const o = isObj(input) ? input : null;
    if (!run || !o) return;
    if (str(o.description)) run.title = str(o.description);
    if (str(o.subagent_type)) run.subagentType = str(o.subagent_type);
    if (str(o.prompt)) run.turn.userText = str(o.prompt);
    applyRunParams(run, o);
    return;
  }
  const st = getTurn(d, ref.scope)?.steps[ref.idx];
  if (st && st.kind === 'tool') {
    st.input = input;
    st.summary = toolSummary(st.name, input);
  }
}

/** 流式输入的 JSON 片段累积：能解析就用对象；Agent 的 description 尽早用正则抠出来 */
export function appendToolJson(d: Draft, key: string, id: string, partial: string): void {
  const buf = (d.book.bufs[key] ?? '') + partial;
  d.book.bufs[key] = buf;
  const ref = d.book.tools[id];
  if (!ref) return;
  const parsed = tryParse(buf);
  if (isObj(parsed)) {
    setToolInput(d, id, parsed);
    return;
  }
  if (ref.agent) {
    const run = findRun(d, id);
    if (run && !run.title) {
      const desc = peekJsonString(buf, 'description');
      if (desc) run.title = desc;
    }
    return;
  }
  setToolInput(d, id, buf);
}

export function endTool(d: Draft, key: string): void {
  const ref = d.book.blocks[key];
  if (!ref || ref.kind !== 'tool' || ref.toolId === undefined) return;
  const buf = d.book.bufs[key];
  if (buf !== undefined) {
    const parsed = tryParse(buf);
    if (isObj(parsed)) setToolInput(d, ref.toolId, parsed);
    delete d.book.bufs[key];
  }
  const tref = d.book.tools[ref.toolId];
  if (!tref) return;
  if (tref.agent) {
    const run = findRun(d, ref.toolId);
    if (run && !run.title) run.title = run.subagentType ?? 'Agent';
  } else {
    const st = getTurn(d, tref.scope)?.steps[tref.idx];
    if (st && st.kind === 'tool') delete st.streaming;
  }
}

/** 子代理结束（只作用于仍在 running 的） */
export function endSub(d: Draft, toolUseId: string, status: 'done' | 'error'): void {
  const run = findRun(d, toolUseId);
  if (!run || run.status !== 'running') return;
  run.status = status;
  finishTurn(run.turn, status, d.now, status === 'error' ? '出错了' : undefined);
}

const isAsyncLaunch = (content: unknown, meta: unknown): boolean =>
  (isObj(meta) && (meta.status === 'async_launched' || meta.isAsync === true)) ||
  textOf(content).includes('Async agent launched');

/** tool_result 回填。meta 为外层的 tool_use_result（实时）或 toolUseResult（历史），只用来识别后台启动 */
export function applyToolResult(d: Draft, id: string, content: unknown, isError: boolean, meta: unknown): void {
  const ref = d.book.tools[id];
  if (!ref) return;
  if (ref.agent) {
    const run = findRun(d, id);
    const agentId = /agentId:\s*([\w-]+)/.exec(textOf(content))?.[1] ?? (isObj(meta) ? str(meta.agentId) : '');
    if (run && agentId && !run.taskId) run.taskId = agentId;
    if (!isError && isAsyncLaunch(content, meta)) {
      d.book.asyncSubs[id] = true; // 后台子代理：保持 running，等 task_notification
      return;
    }
    endSub(d, id, isError ? 'error' : 'done');
    return;
  }
  const st = getTurn(d, ref.scope)?.steps[ref.idx];
  if (st && st.kind === 'tool') {
    st.result = { content, isError };
    delete st.streaming;
  }
}

// ───────────── 完整 assistant 消息（实时与历史共用） ─────────────

/** 一条完整 assistant 消息：每个 block 按到达顺序对应流式 index，与已有的流式块合并而不是重复 */
export function applyAssistantMessage(d: Draft, scope: string, message: unknown): void {
  if (!isObj(message)) return;
  const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : arr(message.content);
  if (scope !== '' && str(message.model)) {
    const run = findRun(d, scope);
    if (run) run.model = str(message.model);
  }
  const mk = `${scope}|${str(message.id) || `anon-${d.book.seq++}`}`;
  for (const b of content) {
    if (!isObj(b)) continue;
    const n = d.book.seen[mk] ?? 0;
    d.book.seen[mk] = n + 1;
    const key = `${mk}:${n}`;
    if (b.type === 'text') {
      const text = str(b.text);
      if (!text && !d.book.blocks[key]) continue;
      const ref = ensureText(d, scope, key);
      if (ref) writeText(d, key, ref, text, 'set');
    } else if (b.type === 'thinking') {
      const ref = ensureThinking(d, scope, key, false);
      const text = str(b.thinking);
      const st = ref && thinkingStep(d, ref);
      if (st && text) st.text = text;
    } else if (b.type === 'tool_use') {
      const id = str(b.id);
      if (!id) continue;
      ensureTool(d, scope, key, id, str(b.name), b.input ?? {}, false);
      if (isObj(b.input)) setToolInput(d, id, b.input);
    }
  }
}

/** user 消息里的 tool_result 块（实时与历史共用）；返回是否含 tool_result */
export function applyToolResults(d: Draft, content: unknown, meta: unknown): boolean {
  let any = false;
  for (const b of arr(content)) {
    if (!isObj(b) || b.type !== 'tool_result') continue;
    const id = str(b.tool_use_id);
    if (!id) continue;
    applyToolResult(d, id, b.content, b.is_error === true, meta);
    any = true;
  }
  return any;
}
