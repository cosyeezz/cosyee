// Claude CLI 委派后端（claude -p --output-format stream-json --include-partial-messages）逐次请求用量适配器。
//
// 口径：
// - 直接复用 shared/usage.ts 的 cachePointOf(message, 0)：
//   input = input_tokens（未缓存），create = cache_creation_input_tokens，read = cache_read_input_tokens，
//   output = output_tokens，rate = read / (input + create + read) * 100；保留 create1h / fast / usGeo / model。
// - 事件来源：
//   1. stream_event message_start：message.id / model / 初始 usage；
//   2. stream_event content_block_start（tool_use）：提前记下 tool_use.id；
//   3. stream_event message_delta：最终 usage.output_tokens 等；
//   4. assistant 帧：message.id / model / usage / content 中的 tool_use.id；
//   5. result 帧：modelUsage[model].contextWindow 作为权威上下文窗口（此前按 contextWindowOf(model) 推算）。
// - id 规则：直接使用 Anthropic API 的 message.id（跨轮与 --resume 全局唯一）；同 message.id 跨帧合并 tools、output 取较大值。
// - tools 归属：同 message.id 的 tool_use.id（与 ClaudeStreamTranslator 产出的 toolCallId 一致，由 jobs.ts 换算成 agy_<parent>_<id>）。
import { type CachePoint, cachePointOf, contextWindowOf, mergeTools } from '@cosyee/shared';
import type { UsageAdapter } from './index.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const tok = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function samePoint(a: CachePoint, b: CachePoint): boolean {
  return (
    a.input === b.input &&
    a.create === b.create &&
    a.read === b.read &&
    a.rate === b.rate &&
    a.tools === b.tools &&
    (a.output ?? 0) === (b.output ?? 0) &&
    a.model === b.model &&
    a.create1h === b.create1h &&
    a.fast === b.fast &&
    a.usGeo === b.usGeo &&
    a.estimated === b.estimated
  );
}

export class ClaudeUsageAdapter implements UsageAdapter {
  private readonly byId = new Map<string, CachePoint>();
  private currentMsgId = '';
  private currentModel = '';
  private authoritativeWindow: number | null = null;
  private lastPoint: CachePoint | null = null;

  window(): number | null {
    return this.authoritativeWindow ?? contextWindowOf(this.currentModel || undefined);
  }

  push(raw: unknown): CachePoint[] {
    if (!isObj(raw)) return [];
    const type = str(raw.type);

    if (type === 'system' && raw.subtype === 'init') {
      const m = str(raw.model);
      if (m && !m.startsWith('<')) this.currentModel = m;
      return [];
    }

    if (type === 'stream_event') {
      return this.onStreamEvent(raw);
    }

    if (type === 'assistant') {
      return this.onAssistant(raw.message);
    }

    if (type === 'result') {
      return this.onResult(raw);
    }

    return [];
  }

  private onStreamEvent(raw: Obj): CachePoint[] {
    const ev = raw.event;
    if (!isObj(ev)) return [];
    const evType = str(ev.type);

    if (evType === 'message_start') {
      const m = ev.message;
      if (!isObj(m)) return [];
      const id = str(m.id);
      if (id) this.currentMsgId = id;
      const model = str(m.model);
      if (model && !model.startsWith('<')) this.currentModel = model;
      const pt = cachePointOf(m, 0);
      return pt ? this.upsert(pt) : [];
    }

    if (evType === 'content_block_start') {
      const cb = ev.content_block;
      if (!isObj(cb) || cb.type !== 'tool_use') return [];
      const tid = str(cb.id);
      const mid = str(raw.api_message_id) || this.currentMsgId;
      if (!tid || !mid) return [];
      return this.attachTools(mid, [tid]);
    }

    if (evType === 'message_delta') {
      const u = ev.usage;
      const mid = str(raw.api_message_id) || this.currentMsgId;
      if (!isObj(u) || !mid) return [];
      const prev = this.byId.get(mid);
      if (!prev) return [];
      const outTok = tok(u.output_tokens);
      const nextOutput = Math.max(prev.output ?? 0, outTok);
      const nextInput = u.input_tokens !== undefined ? tok(u.input_tokens) : prev.input;
      const nextCreate = u.cache_creation_input_tokens !== undefined ? tok(u.cache_creation_input_tokens) : prev.create;
      const nextRead = u.cache_read_input_tokens !== undefined ? tok(u.cache_read_input_tokens) : prev.read;
      const total = nextInput + nextCreate + nextRead;
      if (total <= 0) return [];
      const next: CachePoint = {
        ...prev,
        input: nextInput,
        create: nextCreate,
        read: nextRead,
        rate: (nextRead / total) * 100,
        output: nextOutput,
      };
      if (samePoint(prev, next)) return [];
      this.byId.set(mid, next);
      this.lastPoint = next;
      return [next];
    }

    if (evType === 'message_stop') {
      this.currentMsgId = '';
      return [];
    }

    return [];
  }

  private onAssistant(message: unknown): CachePoint[] {
    if (!isObj(message)) return [];
    const model = str(message.model);
    if (model && !model.startsWith('<')) this.currentModel = model;
    const pt = cachePointOf(message, 0);
    if (pt) return this.upsert(pt);
    // 无 usage 但带 tool_use（分段帧）：把 tool_use id 补进已有同 id 的点
    const mid = str(message.id);
    if (!mid || !Array.isArray(message.content)) return [];
    const tools: string[] = [];
    for (const b of message.content) {
      if (isObj(b) && b.type === 'tool_use' && str(b.id)) tools.push(str(b.id));
    }
    return tools.length ? this.attachTools(mid, tools) : [];
  }

  private onResult(raw: Obj): CachePoint[] {
    const mu = raw.modelUsage;
    if (!isObj(mu)) return [];
    let win: number | null = null;
    if (this.currentModel && isObj(mu[this.currentModel])) {
      const w = tok((mu[this.currentModel] as Obj).contextWindow);
      if (w > 0) win = w;
    }
    if (win === null) {
      for (const entry of Object.values(mu)) {
        if (isObj(entry)) {
          const w = tok(entry.contextWindow);
          if (w > 0) {
            win = w;
            break;
          }
        }
      }
    }
    if (win === null) return [];
    const prevWin = this.window();
    this.authoritativeWindow = win;
    // 如果 result 给出了与此前推算不同的权威窗口，重发最近一个点把新窗口带给前端
    if (win !== prevWin && this.lastPoint) {
      return [this.lastPoint];
    }
    return [];
  }

  private attachTools(mid: string, tools: string[]): CachePoint[] {
    const prev = this.byId.get(mid);
    if (!prev) return [];
    const merged = mergeTools(prev.tools, tools);
    if (merged === prev.tools) return [];
    const next: CachePoint = { ...prev, ...(merged ? { tools: merged } : {}) };
    this.byId.set(mid, next);
    this.lastPoint = next;
    return [next];
  }

  private upsert(pt: CachePoint): CachePoint[] {
    const prev = this.byId.get(pt.id);
    if (!prev) {
      this.byId.set(pt.id, pt);
      this.lastPoint = pt;
      return [pt];
    }
    const tools = mergeTools(prev.tools, pt.tools);
    const output = Math.max(prev.output ?? 0, pt.output ?? 0);
    const model = pt.model ?? prev.model;
    const create1h = pt.create1h ?? prev.create1h;
    const fast = pt.fast ?? prev.fast;
    const usGeo = pt.usGeo ?? prev.usGeo;
    const next: CachePoint = {
      id: pt.id,
      turn: 0,
      input: pt.input,
      create: pt.create,
      read: pt.read,
      rate: pt.rate,
      output,
      ...(tools ? { tools } : {}),
      ...(model ? { model } : {}),
      ...(create1h !== undefined ? { create1h } : {}),
      ...(fast ? { fast } : {}),
      ...(usGeo ? { usGeo } : {}),
    };
    if (samePoint(prev, next)) return [];
    this.byId.set(pt.id, next);
    this.lastPoint = next;
    return [next];
  }
}
