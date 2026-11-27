// Codex app-server 委派后端逐次请求用量适配器。
//
// 口径：
// - 事件来源：thread/tokenUsage/updated 每次模型请求发一条，tokenUsage.last 是本次请求，modelContextWindow 是上下文窗口。
// - Codex 的 inputTokens 已包含 cachedInputTokens：
//   input = inputTokens - cachedInputTokens（未缓存输入），read = cachedInputTokens，create = 0，
//   output = outputTokens（已含 reasoningOutputTokens；本机 rollout 实测 input + output = total），
//   rate = read / (input + read) * 100。input + read <= 0 时跳过。
// - model 取当前 turn 的模型；窗口优先用 modelContextWindow，未收到前按 contextWindowOf(model) 推算。
// - tools 归属：上一个用量点之后到本次用量点之间发出的工具调用 id（ACP tool_call 的 toolCallId，由 jobs.ts 换算成前端 id）。
// - id 规则：`codex:${threadId}:${turnId || runKey}:${seq}`，同一次任务内跨 turn / delegate_send 续跑全局唯一。
import { type CachePoint, contextWindowOf } from '@cosyee/shared';
import { N, parseTokenUsage, parseTurn, threadIdOf, turnIdOf } from '../codexProtocol.js';
import type { UsageAdapter } from './index.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

let runSeq = 0;

export interface CodexUsageAdapterOptions {
  threadId: string;
  turnId?: string | null;
  model?: string | null;
}

export type CodexUsageInput =
  | { method: string; params: unknown }
  | { sessionUpdate: 'tool_call'; toolCallId: string };

export class CodexUsageAdapter implements UsageAdapter {
  private readonly threadId: string;
  private turnId: string | null;
  private readonly runKey: string;
  private model: string | null;
  private ctxWindow: number | null = null;
  private seq = 0;
  private readonly seenTools = new Set<string>();
  private pendingTools: string[] = [];

  constructor(opts: CodexUsageAdapterOptions) {
    this.threadId = opts.threadId;
    this.turnId = opts.turnId ?? null;
    this.runKey = `${Date.now().toString(36)}-${(++runSeq).toString(36)}`;
    this.model = opts.model && !opts.model.startsWith('<') ? opts.model : null;
  }

  /** turn/start 响应返回 turnId 后写入，供后续点生成稳定且唯一的 id */
  setTurnId(turnId: string): void {
    if (turnId && !this.turnId) this.turnId = turnId;
  }

  setModel(model: string | null | undefined): void {
    if (model && !model.startsWith('<')) this.model = model;
  }

  window(): number | null {
    return this.ctxWindow ?? contextWindowOf(this.model ?? undefined);
  }

  push(raw: unknown): CachePoint[] {
    if (!isObj(raw)) return [];

    // 1. ACP tool_call update（来自 CodexTurnTranslator，含多文件 fileChange 拆分后的 `${id}:${i}`）
    if (raw.sessionUpdate === 'tool_call') {
      const cid = typeof raw.toolCallId === 'string' ? raw.toolCallId : '';
      if (cid && !this.seenTools.has(cid)) {
        this.seenTools.add(cid);
        this.pendingTools.push(cid);
      }
      return [];
    }

    // 2. Codex JSON-RPC 服务端通知
    const method = typeof raw.method === 'string' ? raw.method : '';
    if (!method) return [];
    const params = raw.params;
    const tid = threadIdOf(params);
    if (tid && tid !== this.threadId) return [];
    const turn = turnIdOf(params);
    if (turn && this.turnId && turn !== this.turnId) return [];

    if (method === N.turnStarted && isObj(params)) {
      const t = parseTurn(params.turn);
      if (t && !this.turnId) this.turnId = t.id;
      return [];
    }

    if (method !== N.threadTokenUsage || !isObj(params)) return [];
    if (turn && !this.turnId) this.turnId = turn;

    const parsed = parseTokenUsage(params.tokenUsage);
    if (!parsed) return [];
    if (parsed.modelContextWindow !== null) this.ctxWindow = parsed.modelContextWindow;

    const last = parsed.last;
    const rawInput = Math.max(0, last.inputTokens);
    const read = Math.min(rawInput, Math.max(0, last.cachedInputTokens));
    const input = rawInput - read;
    const create = 0;
    const total = input + create + read;
    if (total <= 0) return [];

    const output = Math.max(0, last.outputTokens);
    const tools = this.pendingTools.length ? this.pendingTools.slice() : undefined;
    this.pendingTools = [];

    const id = `codex:${this.threadId}:${this.turnId ?? this.runKey}:${++this.seq}`;
    const point: CachePoint = {
      id,
      turn: 0,
      input,
      create,
      read,
      rate: (read / total) * 100,
      output,
      ...(tools ? { tools } : {}),
      ...(this.model ? { model: this.model } : {}),
    };
    return [point];
  }
}
