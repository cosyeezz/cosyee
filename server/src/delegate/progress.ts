// 把 agy ACP 的 session/update 翻译成 claude CLI 形状的子代理事件（parent_tool_use_id = delegate 调用的 tool_use id），
// 让前端沿用子代理那套展示：文字流式写进子代理的回答，agy 的工具调用显示为子代理的工具步骤。
// 只用于实时展示，不落盘；历史里 delegate 只有最终结果。
import type { Json } from '../transcript.js';

/** 单个工具输出推给前端的上限（agy 的工具输出可能很大，界面只需要看个大概） */
const OUTPUT_MAX = 16 * 1024;

const clip = (s: string): string => (s.length > OUTPUT_MAX ? `${s.slice(0, OUTPUT_MAX)}\n…（已截断）` : s);

function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function asInput(v: unknown): Json {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json;
  if (typeof v === 'string') {
    try {
      const p = JSON.parse(v);
      if (p && typeof p === 'object' && !Array.isArray(p)) return p;
    } catch { /* 不是 JSON */ }
    return v ? { input: v } : {};
  }
  return {};
}

/** 工具输出：rawOutput（字符串，或 { output: 字符串 }）优先，其次 content[] 里的文本 */
function toolOutput(u: Json): string {
  const raw = u.rawOutput;
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && typeof raw.output === 'string' && raw.output) return raw.output;
  if (Array.isArray(u.content)) {
    const parts: string[] = [];
    for (const c of u.content) {
      if (c?.type === 'content' && c.content?.type === 'text' && typeof c.content.text === 'string') parts.push(c.content.text);
      else if (c?.type === 'diff' && typeof c.path === 'string') parts.push(`diff: ${c.path}`);
    }
    if (parts.length) return parts.join('\n');
  }
  return raw === undefined ? '' : asText(raw);
}

const DONE = new Set(['completed', 'failed']);

export class AcpProgress {
  private readonly parent: string;
  /** 展示用的模型名；实际模型确定后会改写 */
  model: string;
  /** 当前开着的文字块（ACP 的文字片段没有消息 id，遇到工具调用就切成新的一段） */
  private textOpen: string | null = null;
  private seq = 0;
  /** 已发出 tool_use 的 toolCallId → 是否已发出 tool_result */
  private tools = new Map<string, boolean>();

  constructor(parentToolUseId: string, model = '') {
    this.parent = parentToolUseId;
    this.model = model;
  }

  /** 吃一个 ACP update，返回要推给前端的 0~n 个 CLI 形状事件 */
  push(u: Json): Json[] {
    if (!u || typeof u !== 'object') return [];
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        return this.text(u);
      case 'tool_call':
      case 'tool_call_update':
        return this.tool(u);
      default:
        return [];
    }
  }

  /** 收尾：还开着的文字块关掉，没收到结果的工具调用补一个「已中断」结果（prompt 返回、出错、被转向 / 停止时调用） */
  finish(): Json[] {
    const out = this.closeText();
    for (const [callId, done] of this.tools) {
      if (done) continue;
      this.tools.set(callId, true);
      out.push({
        type: 'user',
        parent_tool_use_id: this.parent,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `agy_${this.parent}_${callId}`, content: '已中断', is_error: true }],
        },
      });
    }
    return out;
  }

  private msgId(key: string): string {
    return `agy-${this.parent}-${key}`;
  }

  private stream(key: string, event: Json): Json {
    return { type: 'stream_event', parent_tool_use_id: this.parent, api_message_id: this.msgId(key), event };
  }

  private closeText(): Json[] {
    if (!this.textOpen) return [];
    const key = this.textOpen;
    this.textOpen = null;
    return [this.stream(key, { type: 'content_block_stop', index: 0 })];
  }

  private text(u: Json): Json[] {
    const c = u.content;
    const delta = c?.type === 'text' && typeof c.text === 'string' ? c.text : '';
    if (!delta) return [];
    const out: Json[] = [];
    if (!this.textOpen) {
      const key = `t${this.seq++}`;
      this.textOpen = key;
      out.push(this.stream(key, { type: 'message_start', message: { id: this.msgId(key), ...(this.model ? { model: this.model } : {}) } }));
      out.push(this.stream(key, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    }
    out.push(this.stream(this.textOpen, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }));
    return out;
  }

  private tool(u: Json): Json[] {
    const callId = typeof u.toolCallId === 'string' && u.toolCallId ? u.toolCallId : `n${this.seq++}`;
    const id = `agy_${this.parent}_${callId}`;
    const out: Json[] = [];
    if (!this.tools.has(callId)) {
      // 工具调用打断文字：先把前面的文字块关掉，之后的文字另起一段
      out.push(...this.closeText());
      this.tools.set(callId, false);
      const name = (typeof u.name === 'string' && u.name) || (typeof u.title === 'string' && u.title) || (typeof u.kind === 'string' && u.kind) || 'tool';
      out.push({
        type: 'assistant',
        parent_tool_use_id: this.parent,
        message: {
          id: this.msgId(callId),
          role: 'assistant',
          ...(this.model ? { model: this.model } : {}),
          content: [{ type: 'tool_use', id, name, input: asInput(u.rawInput ?? u.args) }],
        },
      });
    }
    if (DONE.has(u.status) && this.tools.get(callId) === false) {
      this.tools.set(callId, true);
      out.push({
        type: 'user',
        parent_tool_use_id: this.parent,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: id, content: clip(toolOutput(u)), is_error: u.status === 'failed' }],
        },
      });
    }
    return out;
  }
}
