// Codex 线程通知 → ACP session/update 形状（progress.ts / jobs.ts 沿用）。纯状态机，不碰进程与 IO。
// 一次 turn 一个 CodexTurnTranslator：喂入该线程的通知，吐出 0~n 个 update，并累计最终回答 / 工具计数 / 用量。
import { DELEGATE_EFFORTS, type DelegateEffort, type DelegateModel, type DelegateModelList } from '@cosyee/shared';
import type { Json } from '../transcript.js';
import { CODEX_NOT_LOGGED_IN } from './codex.js';
import { N, type ModelListPage, type TokenUsageBreakdown, type TurnStatus, parseTokenUsage, parseTurn, threadIdOf, turnIdOf } from './codexProtocol.js';

/** 单个工具输出带给前端的上限（取尾部，命令输出的有用信息通常在最后） */
const OUTPUT_MAX = 32 * 1024;

const clipTail = (s: string): string => (s.length > OUTPUT_MAX ? `…（已截断，只保留末尾）\n${s.slice(-OUTPUT_MAX)}` : s);

const isDelegateEffort = (e: unknown): e is DelegateEffort => typeof e === 'string' && (DELEGATE_EFFORTS as readonly string[]).includes(e);

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);

export const ZERO_USAGE: TokenUsageBreakdown = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

export interface TurnTranslatorOptions {
  threadId: string;
  /** 文件改动路径的基准（codex 报的路径一般已是绝对路径，这里只做兜底） */
  cwd?: string;
  /**
   * 本线程之前累计的用量；传了就用「当前累计 - 基线」当本次用量。
   * 不传（基线未知，如续接后没有任何回放）时，以第一条用量通知的 last 反推基线。
   */
  usageBaseline?: TokenUsageBreakdown | null;
}

export interface TurnResult {
  stopReason: 'end_turn' | 'cancelled' | 'error';
  response: string;
  usage?: Json;
  toolCalls: number;
  /** 失败时的用户可读消息 */
  error?: string;
}

type Change = { path: string; kind: 'add' | 'delete' | 'update'; movePath: string | null; diff: string };

/** 统一 diff → 旧 / 新文本（忽略头部与 @@ 行；上下文行两边都留） */
export function diffToOldNew(diff: string): { oldText: string; newText: string } {
  const o: string[] = [];
  const n: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('\\ No newline')) continue;
    if (line.startsWith('+')) n.push(line.slice(1));
    else if (line.startsWith('-')) o.push(line.slice(1));
    else if (line.startsWith(' ')) {
      o.push(line.slice(1));
      n.push(line.slice(1));
    }
  }
  return { oldText: o.join('\n'), newText: n.join('\n') };
}

/** 新增文件的 diff 字段：多数情况就是全文；若是 "+行" 形式则去掉前缀 */
function addedContent(diff: string): string {
  const lines = diff.split('\n').filter((l) => l.length > 0 && !l.startsWith('+++') && !l.startsWith('@@'));
  if (lines.length > 0 && lines.every((l) => l.startsWith('+'))) return diff.split('\n').filter((l) => !l.startsWith('+++') && !l.startsWith('@@')).map((l) => (l.startsWith('+') ? l.slice(1) : l)).join('\n');
  return diff;
}

function parseChanges(v: unknown): Change[] {
  const out: Change[] = [];
  for (const c of Array.isArray(v) ? v : []) {
    if (!isObj(c) || typeof c.path !== 'string' || !c.path) continue;
    const k = isObj(c.kind) ? c.kind : {};
    const kind = k.type === 'add' ? 'add' : k.type === 'delete' ? 'delete' : 'update';
    out.push({ path: c.path, kind, movePath: typeof k.move_path === 'string' ? k.move_path : null, diff: typeof c.diff === 'string' ? c.diff : '' });
  }
  return out;
}

const SHELL_EXE = /^(?:pwsh|powershell|bash|sh|zsh|cmd)(?:\.exe)?$/i;

/**
 * Codex 的 commandExecution.command 是整条 shell 调用（如 `"C:\\…\\pwsh.exe" -Command "…"`、`/bin/bash -lc '…'`），
 * 引号内按 shlex 规则转义。界面只显示真正执行的命令：去掉外层 shell 与它的参数，还原转义；认不出时原样返回。
 */
export function unwrapShellCommand(command: string): string {
  const m = /^\s*(?:"([^"]+)"|(\S+))\s+((?:-{1,2}[A-Za-z][\w-]*\s+)*?)(?:-Command|-c|-lc|\/c)\s+([\s\S]+?)\s*$/i.exec(command);
  if (!m) return command;
  const exe = (m[1] ?? m[2] ?? '').split(/[\\/]/).pop() ?? '';
  if (!SHELL_EXE.test(exe)) return command;
  const body = m[4]!;
  if (body.length >= 2 && body.startsWith("'") && body.endsWith("'")) return body.slice(1, -1).replace(/'\\''/g, "'");
  if (body.length >= 2 && body.startsWith('"') && body.endsWith('"')) return body.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  return body;
}

function fileToolShape(changes: Change[]): { name: string; kind: string; input: Json } {
  if (changes.length === 1) {
    const c = changes[0]!;
    if (c.kind === 'add') return { name: 'Write', kind: 'edit', input: { file_path: c.path, content: addedContent(c.diff) } };
    if (c.kind === 'delete') return { name: 'Delete', kind: 'delete', input: { file_path: c.path } };
    const { oldText, newText } = diffToOldNew(c.diff);
    return { name: 'Edit', kind: 'edit', input: { file_path: c.path, old_string: oldText, new_string: newText, ...(c.movePath ? { move_path: c.movePath } : {}) } };
  }
  const allDelete = changes.length > 0 && changes.every((c) => c.kind === 'delete');
  return {
    name: 'apply_patch',
    kind: allDelete ? 'delete' : 'edit',
    input: { changes: changes.map((c) => ({ path: c.path, kind: c.kind, ...(c.movePath ? { move_path: c.movePath } : {}), diff: c.diff })) },
  };
}

function mcpOutput(item: Json): string {
  if (isObj(item.error)) return String(item.error.message ?? '工具调用失败');
  const r = item.result;
  if (!isObj(r)) return '';
  const parts: string[] = [];
  for (const c of Array.isArray(r.content) ? r.content : []) {
    if (isObj(c) && typeof c.text === 'string') parts.push(c.text);
    else if (isObj(c) && c.type === 'image') parts.push('[图片]');
    else if (c !== undefined) parts.push(JSON.stringify(c));
  }
  if (parts.length) return parts.join('\n');
  return r.structuredContent !== undefined && r.structuredContent !== null ? JSON.stringify(r.structuredContent, null, 2) : '';
}

/** 命令 / 补丁 / MCP 状态是否算失败 */
const FAILED_STATUS = new Set(['failed', 'declined']);

export class CodexTurnTranslator {
  readonly threadId: string;
  private readonly cwd: string | undefined;
  /** 当前 turn id；未知时接受所有该线程事件（单线程同时只有一个 turn） */
  turnId: string | null = null;
  allText = '';
  afterToolText = '';
  /** 已开始、未结束的工具调用 id（空闲看门狗据此暂停） */
  readonly activeTools = new Set<string>();
  private readonly finished = new Set<string>();
  private readonly started = new Set<string>();
  /** agentMessage / reasoning 已流式输出过的文字：itemId → 已发文本 */
  private readonly streamed = new Map<string, string>();
  private readonly msgItems = new Set<string>();
  private readonly cmdOutput = new Map<string, string>();
  private baseline: TokenUsageBreakdown | null;
  private curTotal: TokenUsageBreakdown | null = null;
  status: TurnStatus | null = null;
  private turnError: string | null = null;
  private lastError: string | null = null;
  private lastErrorInfo: unknown = null;

  constructor(o: TurnTranslatorOptions) {
    this.threadId = o.threadId;
    this.cwd = o.cwd;
    this.baseline = o.usageBaseline ?? null;
  }

  get done(): boolean {
    return this.status !== null && this.status !== 'inProgress';
  }

  /** 去重后的、已经结束（completed / failed）的工具调用个数 */
  get toolCalls(): number {
    return this.finished.size;
  }

  /** 本线程当前累计用量（供调用方保存为下一次的基线） */
  get totalUsage(): TokenUsageBreakdown | null {
    return this.curTotal;
  }

  /** 吃一条服务端通知，返回要推给上层的 ACP updates；不属于本线程 / 本 turn 的通知忽略 */
  push(method: string, params: unknown): Json[] {
    const tid = threadIdOf(params);
    if (tid && tid !== this.threadId) return [];
    const turn = turnIdOf(params);
    if (turn && this.turnId && turn !== this.turnId) return [];
    const p: Json = isObj(params) ? params : {};
    switch (method) {
      case N.turnStarted: {
        const t = parseTurn(p.turn);
        if (t && !this.turnId) this.turnId = t.id;
        return [];
      }
      case N.turnCompleted:
        return this.onTurnCompleted(p);
      case N.error:
        return this.onError(p);
      case N.threadTokenUsage:
        this.onUsage(p.tokenUsage);
        return [];
      case N.agentMessageDelta:
        return this.onAgentDelta(String(p.itemId ?? ''), typeof p.delta === 'string' ? p.delta : '');
      case N.reasoningSummaryDelta:
      case N.reasoningTextDelta:
        return this.onReasoningDelta(String(p.itemId ?? ''), typeof p.delta === 'string' ? p.delta : '');
      case N.commandOutputDelta: {
        const id = String(p.itemId ?? '');
        if (id && typeof p.delta === 'string') this.cmdOutput.set(id, clipTail((this.cmdOutput.get(id) ?? '') + p.delta));
        return [];
      }
      case N.turnPlanUpdated:
        return this.onPlan(p);
      case N.itemStarted:
        return this.onItem(p.item, false);
      case N.itemCompleted:
        return this.onItem(p.item, true);
      default:
        return [];
    }
  }

  result(): TurnResult {
    const response = this.afterToolText.trim() ? this.afterToolText : this.allText;
    const usage = this.usage();
    const base = { response, toolCalls: this.toolCalls, ...(usage ? { usage } : {}) };
    if (this.status === 'interrupted') return { stopReason: 'cancelled', ...base };
    if (this.status === 'failed') return { stopReason: 'error', ...base, error: this.failureMessage() };
    return { stopReason: 'end_turn', ...base };
  }

  /** 失败原因（用户可读） */
  failureMessage(): string {
    return describeTurnError(this.turnError ?? this.lastError ?? '', this.lastErrorInfo);
  }

  // ── 内部 ──

  private emit(out: Json[], u: Json): void {
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') this.afterToolText = '';
    out.push(u);
  }

  private chunk(kind: 'agent_message_chunk' | 'agent_thought_chunk', text: string): Json {
    return { sessionUpdate: kind, content: { type: 'text', text } };
  }

  private newMessageSeparator(itemId: string, out: Json[]): void {
    if (this.msgItems.has(itemId)) return;
    this.msgItems.add(itemId);
    if (this.allText && !this.allText.endsWith('\n')) {
      this.allText += '\n\n';
      if (this.afterToolText) this.afterToolText += '\n\n';
      out.push(this.chunk('agent_message_chunk', '\n\n'));
    }
  }

  private onAgentDelta(itemId: string, delta: string): Json[] {
    if (!delta) return [];
    const out: Json[] = [];
    this.newMessageSeparator(itemId, out);
    this.streamed.set(itemId, (this.streamed.get(itemId) ?? '') + delta);
    this.allText += delta;
    this.afterToolText += delta;
    out.push(this.chunk('agent_message_chunk', delta));
    return out;
  }

  private onReasoningDelta(itemId: string, delta: string): Json[] {
    if (!delta) return [];
    this.streamed.set(`r:${itemId}`, (this.streamed.get(`r:${itemId}`) ?? '') + delta);
    return [this.chunk('agent_thought_chunk', delta)];
  }

  private onPlan(p: Json): Json[] {
    const entries: Json[] = [];
    for (const s of Array.isArray(p.plan) ? p.plan : []) {
      if (!isObj(s) || typeof s.step !== 'string') continue;
      const st = s.status === 'inProgress' ? 'in_progress' : s.status === 'completed' ? 'completed' : 'pending';
      entries.push({ content: s.step, priority: 'medium', status: st });
    }
    return entries.length ? [{ sessionUpdate: 'plan', entries }] : [];
  }

  private onError(p: Json): Json[] {
    if (p.willRetry === true) return [];
    const e = isObj(p.error) ? p.error : {};
    this.lastError = typeof e.message === 'string' ? e.message : this.lastError;
    this.lastErrorInfo = e.codexErrorInfo ?? null;
    return [];
  }

  private onTurnCompleted(p: Json): Json[] {
    const t = parseTurn(p.turn);
    if (!t) return [];
    if (!this.turnId) this.turnId = t.id;
    this.status = t.status === 'inProgress' ? 'completed' : t.status;
    if (t.error) {
      this.turnError = t.error.message;
      this.lastErrorInfo = t.error.codexErrorInfo ?? this.lastErrorInfo;
    }
    // 收尾：还没结束的工具补上终态，避免界面一直转圈
    const out: Json[] = [];
    for (const id of [...this.activeTools]) {
      this.activeTools.delete(id);
      this.emit(out, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', rawOutput: this.status === 'interrupted' ? '已中断' : '未完成' });
    }
    return out;
  }

  private onUsage(v: unknown): void {
    const u = parseTokenUsage(v);
    if (!u) return;
    if (!this.baseline) {
      // 基线未知：用第一条通知「累计 - 本次调用」反推
      this.baseline = {
        totalTokens: Math.max(0, u.total.totalTokens - u.last.totalTokens),
        inputTokens: Math.max(0, u.total.inputTokens - u.last.inputTokens),
        cachedInputTokens: Math.max(0, u.total.cachedInputTokens - u.last.cachedInputTokens),
        outputTokens: Math.max(0, u.total.outputTokens - u.last.outputTokens),
        reasoningOutputTokens: Math.max(0, u.total.reasoningOutputTokens - u.last.reasoningOutputTokens),
      };
    }
    this.curTotal = u.total;
  }

  private usage(): Json | undefined {
    if (!this.curTotal || !this.baseline) return undefined;
    const d = (a: number, b: number) => Math.max(0, a - b);
    const t = this.curTotal;
    const b = this.baseline;
    return {
      totalTokens: d(t.totalTokens, b.totalTokens),
      inputTokens: d(t.inputTokens, b.inputTokens),
      outputTokens: d(t.outputTokens, b.outputTokens),
      cachedInputTokens: d(t.cachedInputTokens, b.cachedInputTokens),
      reasoningOutputTokens: d(t.reasoningOutputTokens, b.reasoningOutputTokens),
    };
  }

  private startTool(out: Json[], id: string, u: Json): void {
    if (this.started.has(id)) return;
    this.started.add(id);
    this.activeTools.add(id);
    this.emit(out, { sessionUpdate: 'tool_call', toolCallId: id, status: 'in_progress', ...u });
  }

  private endTool(out: Json[], id: string, failed: boolean, u: Json): void {
    this.activeTools.delete(id);
    this.finished.add(id);
    this.emit(out, { sessionUpdate: 'tool_call_update', toolCallId: id, status: failed ? 'failed' : 'completed', ...u });
  }

  private onItem(item: unknown, completed: boolean): Json[] {
    if (!isObj(item)) return [];
    const id = typeof item.id === 'string' ? item.id : '';
    const type = typeof item.type === 'string' ? item.type : '';
    const out: Json[] = [];
    switch (type) {
      case 'agentMessage': {
        if (!completed) return [];
        const text = typeof item.text === 'string' ? item.text : '';
        const had = this.streamed.get(id) ?? '';
        let rest = '';
        if (!had) rest = text;
        else if (text.length > had.length && text.startsWith(had)) rest = text.slice(had.length);
        if (rest) return this.onAgentDeltaRest(id, rest);
        return [];
      }
      case 'reasoning': {
        if (!completed) return [];
        if (this.streamed.has(`r:${id}`)) return [];
        const parts = [...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : [])].filter((s): s is string => typeof s === 'string' && s.length > 0);
        return parts.length ? [this.chunk('agent_thought_chunk', parts.join('\n\n'))] : [];
      }
      case 'commandExecution': {
        if (!id) return [];
        const command = typeof item.command === 'string' ? unwrapShellCommand(item.command) : '';
        const cwd = typeof item.cwd === 'string' ? item.cwd : undefined;
        this.startTool(out, id, { name: 'Bash', title: command, kind: 'execute', rawInput: { command, ...(cwd ? { cwd } : {}) } });
        if (!completed) return out;
        const code = typeof item.exitCode === 'number' ? item.exitCode : null;
        const declined = item.status === 'declined';
        const failed = FAILED_STATUS.has(String(item.status)) || (code !== null && code !== 0);
        let output = typeof item.aggregatedOutput === 'string' && item.aggregatedOutput ? item.aggregatedOutput : (this.cmdOutput.get(id) ?? '');
        output = clipTail(output);
        if (declined) output = output ? `${output}\n[已拒绝执行]` : '[已拒绝执行]';
        else if (failed && code !== null) output = output ? `${output}\n[exit code ${code}]` : `[exit code ${code}]`;
        this.endTool(out, id, failed, { rawOutput: output });
        return out;
      }
      case 'fileChange': {
        if (!id) return [];
        const changes = parseChanges(item.changes);
        const failed = completed && FAILED_STATUS.has(String(item.status));
        // 一个补丁改多个文件：拆成每个文件一个 Edit / Write / Delete 步骤（界面能逐个看路径和改动，files_changed 也按文件汇总）
        const parts = changes.length > 1 ? changes.map((c, i) => ({ tid: `${id}:${i}`, cs: [c] })) : [{ tid: id, cs: changes }];
        for (const { tid, cs } of parts) {
          const shape = fileToolShape(cs);
          const locations = cs.map((c) => ({ path: c.path }));
          this.startTool(out, tid, { name: shape.name, title: cs.length === 1 ? cs[0]!.path : `${cs.length} 个文件`, kind: shape.kind, rawInput: shape.input, locations });
          if (!completed) continue;
          const summary = failed ? (item.status === 'declined' ? '[已拒绝修改]' : '修改失败') : cs.map((c) => `${c.kind === 'add' ? '新增' : c.kind === 'delete' ? '删除' : '修改'} ${c.path}`).join('\n');
          this.endTool(out, tid, failed, { kind: shape.kind, locations, rawOutput: summary });
        }
        // 开始时只报了一个文件、完成时变成多个：原来那个步骤也要收尾，否则一直算「工具运行中」
        if (completed && parts[0]!.tid !== id && this.activeTools.has(id)) this.endTool(out, id, failed, { rawOutput: '' });
        return out;
      }
      case 'mcpToolCall': {
        if (!id) return [];
        const server = typeof item.server === 'string' ? item.server : 'mcp';
        const tool = typeof item.tool === 'string' ? item.tool : 'tool';
        const name = `mcp__${server}__${tool}`;
        this.startTool(out, id, { name, title: name, kind: 'other', rawInput: isObj(item.arguments) ? item.arguments : { arguments: item.arguments ?? null } });
        if (!completed) return out;
        const failed = FAILED_STATUS.has(String(item.status)) || isObj(item.error);
        this.endTool(out, id, failed, { rawOutput: clipTail(mcpOutput(item)) });
        return out;
      }
      case 'webSearch': {
        if (!id) return [];
        const a = isObj(item.action) ? item.action : {};
        const query = typeof item.query === 'string' && item.query ? item.query : typeof a.query === 'string' ? a.query : '';
        let name = 'WebSearch';
        let input: Json = { query };
        if (a.type === 'openPage') {
          name = 'WebFetch';
          input = { url: a.url ?? '' };
        } else if (a.type === 'findInPage') {
          name = 'WebFetch';
          input = { url: a.url ?? '', prompt: a.pattern ?? '' };
        }
        if (!completed) {
          this.startTool(out, id, { name, title: query || name, kind: 'search', rawInput: input });
          return out;
        }
        // 开始时 query 可能是空的：完成时补一个带完整入参的 tool_call（前端按 id 合并，已开始则只发更新）
        this.startTool(out, id, { name, title: query || name, kind: 'search', rawInput: input });
        this.endTool(out, id, false, { rawOutput: '' });
        return out;
      }
      case 'imageView': {
        if (!id) return [];
        const p = typeof item.path === 'string' ? item.path : '';
        this.startTool(out, id, { name: 'Read', title: p, kind: 'read', rawInput: { file_path: p } });
        if (completed) this.endTool(out, id, false, { rawOutput: '[图片]' });
        return out;
      }
      case 'dynamicToolCall': {
        if (!id) return [];
        const name = [item.namespace, item.tool].filter((s): s is string => typeof s === 'string' && !!s).join('__') || 'tool';
        this.startTool(out, id, { name, title: name, kind: 'other', rawInput: isObj(item.arguments) ? item.arguments : {} });
        if (completed) this.endTool(out, id, item.success === false || FAILED_STATUS.has(String(item.status)), { rawOutput: clipTail(JSON.stringify(item.contentItems ?? '')) });
        return out;
      }
      // 不展示的条目
      case 'userMessage':
      case 'hookPrompt':
      case 'plan':
      case 'contextCompaction':
      case 'enteredReviewMode':
      case 'exitedReviewMode':
      case 'sleep':
        return [];
      default: {
        // 未知条目（协议新增）：有 id 就当作一个通用工具步骤，没有就忽略
        if (!id || !type) return [];
        this.startTool(out, id, { name: type, title: type, kind: 'other', rawInput: {} });
        if (completed) this.endTool(out, id, FAILED_STATUS.has(String(item.status)), { rawOutput: '' });
        return out;
      }
    }
  }

  private onAgentDeltaRest(itemId: string, rest: string): Json[] {
    return this.onAgentDelta(itemId, rest);
  }
}

/** 把 turn 错误翻成给用户 / 模型看的中文 */
export function describeTurnError(message: string, info: unknown): string {
  const key = typeof info === 'string' ? info : isObj(info) ? Object.keys(info)[0] : '';
  switch (key) {
    case 'unauthorized':
      return CODEX_NOT_LOGGED_IN;
    case 'usageLimitExceeded':
      return `Codex 额度已用完${message ? `：${message}` : ''}`;
    case 'contextWindowExceeded':
      return `对话上下文超出模型窗口，请新开会话再试${message ? `（${message}）` : ''}`;
    case 'serverOverloaded':
      return `Codex 服务繁忙，请稍后重试${message ? `（${message}）` : ''}`;
    default:
      return message || 'Codex 执行失败';
  }
}

/**
 * model/list 的分页结果 → 界面用的模型列表。
 * 隐藏的模型不列；保留所有 DELEGATE_EFFORTS（含 none / minimal / ultra）；
 * current = isDefault 的模型 + 它的默认强度（没有 isDefault 取第一个可见模型）。
 */
export function parseCodexModels(pages: ModelListPage[], now: number = Date.now()): DelegateModelList {
  const models: DelegateModel[] = [];
  let cur: { model: string; effort: DelegateEffort | null } | null = null;
  let first: { model: string; effort: DelegateEffort | null } | null = null;
  const seen = new Set<string>();
  for (const page of pages) {
    for (const m of page.data) {
      if (m.hidden || seen.has(m.model)) continue;
      seen.add(m.model);
      const efforts = DELEGATE_EFFORTS.filter((e) => m.supportedReasoningEfforts.includes(e));
      models.push({ value: m.model, displayName: m.displayName, efforts });
      const entry = { model: m.model, effort: isDelegateEffort(m.defaultReasoningEffort) ? m.defaultReasoningEffort : null };
      first ??= entry;
      if (m.isDefault && !cur) cur = entry;
    }
  }
  return { models, current: cur ?? first, at: now };
}
