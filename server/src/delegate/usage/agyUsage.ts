// Antigravity ACP（agy acp）委派后端逐次请求用量适配器。
//
// 口径（经实测日志 acp-trace.jsonl 验证）：
// - session/update 的 { sessionUpdate: 'usage_update', used, size }：
//   每次模型请求结束发一条，used = 该次请求的总 token（input + cachedRead + cachedWrite + output），size = 上下文窗口（如 1048576）。
//   每轮开头会有一条 used: 0，跳过（但仍记录 size 作为窗口）。
// - session/prompt 的 PromptResponse.usage：{ inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens }
//   是本轮所有请求合计（不含上一轮）；totalTokens = input + cachedRead + cachedWrite + output，output 已含 thought。
// - 拆分策略：
//   1. 每条 usage_update（used > 0）先产出一个估算点：input = used、create = 0、read = 0、output = 0、estimated: true；
//   2. PromptResponse 到达时把本轮合计按各点 used 占比用最大余数法整数化分摊（保证各项之和严格等于本轮合计），用同 id 重发；
//   3. 本轮只有 1 次请求时分摊结果即精确值，去掉 estimated 标记；
//   4. 若整轮未收到任何 usage_update 但 PromptResponse 带了 usage，则直接补发 1 个精确点。
// - tools 归属：实测日志显示 usage_update 在该次请求产出的 tool_call 之前到达（模型响应结束先报 usage_update，紧接着派发工具调用）；
//   因此 usage_update 之后、下一次 usage_update 之前到达的 tool_call 归属到最近一个点（同 id 重发更新 tools）；
//   若极少数情况下 tool_call 先于首次 usage_update 到达，则暂存到下一条 usage_update 补挂。
// - id 规则：`agy:${sessionId}:${turnId}:${seq}`，turnId 每次 promptOnce 唯一，跨 delegate_send 续跑与重启不冲突。
import { type CachePoint, contextWindowOf } from '@cosyee/shared';
import type { UsageAdapter } from './index.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const posNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

let turnSeq = 0;

/** 按权重用最大余数法把 total 整数化分摊到各项，保证每项 >= 0 且总和严格等于 Math.round(total) */
function allocate(total: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const t = Math.max(0, Math.round(total));
  if (t === 0) return new Array<number>(n).fill(0);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    const base = Math.floor(t / n);
    const rem = t - base * n;
    return weights.map((_, i) => base + (i < rem ? 1 : 0));
  }
  const exact = weights.map((w) => (t * w) / sum);
  const floors = exact.map((x) => Math.floor(x));
  const rem = t - floors.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => ({ i, frac: x - floors[i]! })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < rem; k++) floors[order[k]!.i]!++;
  return floors;
}

export interface AgyUsageAdapterOptions {
  sessionId: string;
  /** 本次 prompt 的唯一标识；测试可传入固定值 */
  turnId?: string;
  /** 当前会话模型（session/new 的 currentModelId 或 set_model 后的值） */
  model?: string | null;
}

export type AgyUsageInput =
  | { sessionUpdate: 'usage_update'; used?: number; size?: number }
  | { sessionUpdate: 'tool_call'; toolCallId?: string }
  | { type: 'prompt_response'; usage?: unknown };

interface TurnEntry {
  used: number;
  point: CachePoint;
}

export class AgyUsageAdapter implements UsageAdapter {
  private readonly sessionId: string;
  private readonly turnId: string;
  private model: string | null;
  private ctxWindow: number | null = null;
  private seq = 0;
  private readonly entries: TurnEntry[] = [];
  private readonly seenTools = new Set<string>();
  private pendingTools: string[] = [];
  private readonly reasoningById = new Map<string, number>();

  constructor(opts: AgyUsageAdapterOptions) {
    this.sessionId = opts.sessionId;
    this.turnId = opts.turnId ?? `${Date.now().toString(36)}-${(++turnSeq).toString(36)}`;
    this.model = opts.model && !opts.model.startsWith('<') ? opts.model : null;
  }

  setModel(model: string | null | undefined): void {
    if (model && !model.startsWith('<')) this.model = model;
  }

  window(): number | null {
    return this.ctxWindow ?? contextWindowOf(this.model ?? undefined);
  }

  /** 指定用量点对应的推理 token 数（已含在 output 中，账本展示用） */
  reasoningOf(id: string): number {
    return this.reasoningById.get(id) ?? 0;
  }

  push(raw: unknown): CachePoint[] {
    if (!isObj(raw)) return [];

    if (raw.sessionUpdate === 'usage_update') {
      const size = posNum(raw.size);
      if (size > 0) this.ctxWindow = size;
      const used = posNum(raw.used);
      if (used <= 0) return [];
      const tools = this.pendingTools.length ? this.pendingTools.slice() : undefined;
      this.pendingTools = [];
      const id = `agy:${this.sessionId}:${this.turnId}:${++this.seq}`;
      const point: CachePoint = {
        id,
        turn: 0,
        input: used,
        create: 0,
        read: 0,
        rate: 0,
        output: 0,
        estimated: true,
        ...(tools ? { tools } : {}),
        ...(this.model ? { model: this.model } : {}),
      };
      this.entries.push({ used, point });
      return [point];
    }

    if (raw.sessionUpdate === 'tool_call') {
      const cid = typeof raw.toolCallId === 'string' ? raw.toolCallId : '';
      if (!cid || this.seenTools.has(cid)) return [];
      this.seenTools.add(cid);
      const last = this.entries[this.entries.length - 1];
      if (!last) {
        // 还没收到 usage_update：暂存，等下一条 usage_update 挂上去
        this.pendingTools.push(cid);
        return [];
      }
      const nextTools = last.point.tools ? [...last.point.tools, cid] : [cid];
      const next: CachePoint = { ...last.point, tools: nextTools };
      last.point = next;
      return [next];
    }

    if (raw.type === 'prompt_response') {
      return this.onPromptResponse(raw.usage);
    }

    return [];
  }

  private onPromptResponse(usage: unknown): CachePoint[] {
    if (!isObj(usage)) return [];
    const totalInput = posNum(usage.inputTokens);
    const totalCreate = posNum(usage.cachedWriteTokens);
    const totalRead = posNum(usage.cachedReadTokens);
    const totalOutput = posNum(usage.outputTokens);
    const totalThought = posNum(usage.thoughtTokens);
    const totalContext = totalInput + totalCreate + totalRead;

    if (this.entries.length === 0) {
      if (totalContext <= 0) return [];
      const tools = this.pendingTools.length ? this.pendingTools.slice() : undefined;
      this.pendingTools = [];
      const id = `agy:${this.sessionId}:${this.turnId}:${++this.seq}`;
      if (totalThought > 0) this.reasoningById.set(id, totalThought);
      const pt: CachePoint = {
        id,
        turn: 0,
        input: totalInput,
        create: totalCreate,
        read: totalRead,
        rate: (totalRead / totalContext) * 100,
        output: totalOutput,
        ...(tools ? { tools } : {}),
        ...(this.model ? { model: this.model } : {}),
      };
      this.entries.push({ used: totalContext + totalOutput, point: pt });
      return [pt];
    }

    // 单次请求：精确值，去掉 estimated
    if (this.entries.length === 1) {
      if (totalContext <= 0) return [];
      const entry = this.entries[0]!;
      const prev = entry.point;
      if (totalThought > 0) this.reasoningById.set(prev.id, totalThought);
      const next: CachePoint = {
        id: prev.id,
        turn: 0,
        input: totalInput,
        create: totalCreate,
        read: totalRead,
        rate: (totalRead / totalContext) * 100,
        output: totalOutput,
        ...(prev.tools ? { tools: prev.tools } : {}),
        ...(prev.model ? { model: prev.model } : {}),
      };
      entry.point = next;
      return [next];
    }

    // 多次请求：按各点 used 占比整数化分摊本轮合计，保留 estimated: true
    const weights = this.entries.map((e) => e.used);
    const inputs = allocate(totalInput, weights);
    const creates = allocate(totalCreate, weights);
    const reads = allocate(totalRead, weights);
    const outputs = allocate(totalOutput, weights);
    const thoughts = allocate(totalThought, weights);

    const out: CachePoint[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i]!;
      const prev = entry.point;
      const inp = inputs[i]!;
      const cre = creates[i]!;
      const rd = reads[i]!;
      const outTok = outputs[i]!;
      const th = thoughts[i]!;
      if (th > 0) this.reasoningById.set(prev.id, th);
      const denom = inp + cre + rd;
      const next: CachePoint = {
        id: prev.id,
        turn: 0,
        input: inp,
        create: cre,
        read: rd,
        rate: denom > 0 ? (rd / denom) * 100 : 0,
        output: outTok,
        estimated: true,
        ...(prev.tools ? { tools: prev.tools } : {}),
        ...(prev.model ? { model: prev.model } : {}),
      };
      entry.point = next;
      out.push(next);
    }
    return out;
  }
}
