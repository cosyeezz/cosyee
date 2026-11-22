// 会话记录 jsonl 的纯函数：行解析、标题 / 活动时间提取、历史过滤。
// 规则来自 spike/FINDINGS2.md（B2）。这里不做 IO，方便单测。
import { StringDecoder } from 'node:string_decoder';

/** 把字节流切成行：处理半行、\r\n、多字节字符被切断。 */
export class LineSplitter {
  private buf = '';
  private decoder = new StringDecoder('utf8');

  /** 喂入一块数据，返回其中完整的行（不含换行符，已去掉行尾 \r，跳过空行）。 */
  push(chunk: Buffer | string): string[] {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    const out: string[] = [];
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length > 0) out.push(line);
    }
    return out;
  }

  /** 流结束时取出最后没有换行结尾的残留。 */
  flush(): string[] {
    const rest = (this.buf + this.decoder.end()).replace(/\r$/, '');
    this.buf = '';
    return rest.length > 0 ? [rest] : [];
  }
}

/** 把一段文本按行切开；dropFirst / dropLast 用于丢弃读取窗口边缘被截断的不完整行。 */
export function splitLines(text: string, opts: { dropFirst?: boolean; dropLast?: boolean } = {}): string[] {
  const lines = text.split('\n');
  if (opts.dropFirst) lines.shift();
  if (opts.dropLast) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)).filter((l) => l.length > 0);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = Record<string, any>;

export function parseLine(line: string): Json | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === 'object' ? (v as Json) : null;
  } catch {
    return null;
  }
}

// ───────────── 标题 / 元数据扫描 ─────────────

export interface Scan {
  cwd?: string;
  /** 第一条真实用户消息 */
  firstPrompt?: string;
  /** 兜底：只有 <command-name> 类消息时用 */
  commandPrompt?: string;
  hasMessages: boolean;
  customTitle?: string;
  agentName?: string;
  /** 用户设置的标题：custom-title / agent-name 中按文件顺序最后出现的一条（SDK 改名只写 custom-title，不能被旧 agent-name 盖住） */
  userTitle?: string;
  aiTitle?: string;
  /** 最后一条带时间戳的消息（user/assistant/system/attachment）时间，毫秒 */
  lastTs?: number;
  /** 主线程最后一条 assistant 消息的模型（message.model，原始 id；<synthetic> 不算） */
  model?: string;
}

export function newScan(): Scan {
  return { hasMessages: false };
}

const SKIP_PREFIXES = [
  '<bash-', '<local-command-', '<task-notification', '<system-reminder', '<tick', '<teammate-message',
  '<cross-session-message', '[Request interrupted',
];

export const TITLE_MAX = 200;

function truncate(s: string): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > TITLE_MAX ? chars.slice(0, TITLE_MAX).join('') + '…' : t;
}

/** 提取"用户真实输入"文本；不是真实输入返回 null。command 为 true 表示只是 <command-*> 类。 */
export function realUserText(e: Json): { text: string; command: boolean } | null {
  if (e.type !== 'user' || e.isMeta || e.isCompactSummary || e.isSidechain) return null;
  const c = e.message?.content;
  let text: string;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c)) {
    if (c.some((b: Json) => b && b.type === 'tool_result')) return null;
    text = c.filter((b: Json) => b && b.type === 'text' && typeof b.text === 'string').map((b: Json) => b.text).join('\n');
  } else return null;
  text = text.trim();
  if (!text) return null;
  if (SKIP_PREFIXES.some((p) => text.startsWith(p))) return null;
  if (text.startsWith('<command-')) {
    const name = /<command-name>\s*([^<]*?)\s*<\/command-name>/.exec(text)?.[1];
    const args = /<command-args>\s*([\s\S]*?)\s*<\/command-args>/.exec(text)?.[1];
    const t = [name, args].filter(Boolean).join(' ').trim();
    return t ? { text: t, command: true } : null;
  }
  return { text, command: false };
}

const TS_TYPES = new Set(['user', 'assistant', 'system', 'attachment']);

/** 扫描若干行，累积进 into。标题类取最后一条；cwd / firstPrompt 取第一条。 */
export function scanLines(lines: string[], into: Scan = newScan()): Scan {
  for (const line of lines) {
    const e = parseLine(line);
    if (!e) continue;
    const type = e.type;
    if (type === 'custom-title') {
      if (typeof e.customTitle === 'string' && e.customTitle.trim()) into.userTitle = into.customTitle = e.customTitle;
    } else if (type === 'agent-name') {
      if (typeof e.agentName === 'string' && e.agentName.trim()) into.userTitle = into.agentName = e.agentName;
    } else if (type === 'ai-title') {
      if (typeof e.aiTitle === 'string' && e.aiTitle.trim()) into.aiTitle = e.aiTitle;
    }
    if (!into.cwd && typeof e.cwd === 'string' && e.cwd) into.cwd = e.cwd;
    if ((type === 'user' || type === 'assistant') && !e.isSidechain) into.hasMessages = true;
    if (type === 'assistant' && !e.isSidechain && typeof e.message?.model === 'string' && e.message.model && !e.message.model.startsWith('<')) {
      into.model = e.message.model;
    }
    if (TS_TYPES.has(type) && typeof e.timestamp === 'string') {
      const t = Date.parse(e.timestamp);
      if (Number.isFinite(t) && (into.lastTs === undefined || t > into.lastTs)) into.lastTs = t;
    }
    if (type === 'user' && (!into.firstPrompt || !into.commandPrompt)) {
      const r = realUserText(e);
      if (r) {
        if (!r.command && !into.firstPrompt) into.firstPrompt = r.text;
        if (r.command && !into.commandPrompt) into.commandPrompt = r.text;
      }
    }
  }
  return into;
}

/** 合并头部与尾部两次扫描：标题类以尾部（更新）为准，首条消息 / cwd 以头部为准。 */
export function mergeScans(head: Scan, tail: Scan): Scan {
  return {
    cwd: head.cwd ?? tail.cwd,
    firstPrompt: head.firstPrompt ?? tail.firstPrompt,
    commandPrompt: head.commandPrompt ?? tail.commandPrompt,
    hasMessages: head.hasMessages || tail.hasMessages,
    customTitle: tail.customTitle ?? head.customTitle,
    agentName: tail.agentName ?? head.agentName,
    userTitle: tail.userTitle ?? head.userTitle,
    aiTitle: tail.aiTitle ?? head.aiTitle,
    lastTs: tail.lastTs ?? head.lastTs,
    model: tail.model ?? head.model,
  };
}

/** 标题优先级：用户设置（custom-title / agent-name 取最后一条）> ai-title（cc 自动生成，取最后一条）> 第一条真实用户消息 > 会话 id 前 8 位。 */
export function pickTitle(s: Scan, sessionId: string): string {
  const t = s.userTitle || s.customTitle || s.agentName || s.aiTitle || s.firstPrompt || s.commandPrompt;
  if (t) return truncate(t);
  return sessionId.slice(0, 8);
}

/** 上次活动时间：min(最后一条消息时间, mtime)；没有消息时间则取 mtime。 */
export function pickLastActive(lastTs: number | undefined, mtimeMs: number): number {
  return lastTs === undefined ? mtimeMs : Math.min(lastTs, mtimeMs);
}

// ───────────── 历史过滤 ─────────────

/** 保留的消息链类型；其余（attachment、api-request*、session-owner、queue-operation、prompt_snapshot 等）一律丢弃。 */
const KEEP_CHAIN = new Set(['user', 'assistant', 'system']);
const TITLE_TYPES = ['custom-title', 'agent-name', 'ai-title'];
/** 在保留条目里剔除的字段（注入给模型的渲染文本、附件、发给 API 的工具入参副本）。 */
const STRIP_FIELDS = ['rendered', 'renderedRole', 'attachment', 'wireToolInputs'];
/** 含这些子类型的 system 条目带环境信息，丢弃。 */
const DROP_SYSTEM_SUBTYPES = new Set(['session_context', 'prompt_snapshot']);
/**
 * toolUseResult 是工具结果的结构化副本，内容已在 message.content 的 tool_result 里；
 * 前端只用它识别子代理（agentId / 后台启动），所以只留这些摘要字段。
 */
const TOOL_RESULT_KEEP = [
  'status', 'agentId', 'agentType', 'isAsync', 'description', 'outputFile', 'totalDurationMs', 'totalTokens', 'totalToolUseCount',
];

/** message.usage 里前端用到的字段（缓存命中率图）；其余（server_tool_use、iterations、cache_creation 明细等）不下发 */
const USAGE_KEEP = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

function slimUsage(u: Json): Json {
  const out: Json = {};
  for (const k of USAGE_KEEP) if (k in u) out[k] = u[k];
  return out;
}

/** 前端只有 MCP 面板会显示工具结果里的图片，其它工具（Read 等）只显示「[图片]」，图片数据不必下发 */
const keepsImages = (toolName: string | undefined): boolean => !toolName || toolName.startsWith('mcp__');

function slimToolResult(r: unknown): Json | undefined {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  const src = r as Json;
  const slim: Json = {};
  for (const k of TOOL_RESULT_KEEP) if (k in src) slim[k] = src[k];
  return Object.keys(slim).length > 0 ? slim : undefined;
}

/** tool_result 里的图片块去掉 base64（保留 type: 'image'，前端据此显示「[图片]」）；没有改动时返回原数组 */
function dropImages(content: unknown[], toolName: (id: string) => string | undefined): unknown[] {
  let changed = false;
  const out = content.map((c) => {
    const b = c as Json;
    if (!b || b.type !== 'tool_result' || !Array.isArray(b.content) || keepsImages(toolName(String(b.tool_use_id)))) return c;
    if (!b.content.some((x: Json) => x?.type === 'image' && x.source)) return c;
    changed = true;
    return { ...b, content: b.content.map((x: Json) => (x?.type === 'image' && x.source ? { type: 'image', omitted: true } : x)) };
  });
  return changed ? out : content;
}

/**
 * 过滤一条原始条目；返回 null 表示丢弃。
 * toolName：tool_use id → 工具名（HistoryFilter 从前面的 assistant 条目里记下来），用于判断结果里的图片要不要保留。
 */
export function filterEntry(e: Json, toolName: (id: string) => string | undefined = () => undefined): Json | null {
  if (!KEEP_CHAIN.has(e.type)) return null;
  if (e.type === 'system' && DROP_SYSTEM_SUBTYPES.has(e.subtype)) return null;
  const out: Json = { ...e };
  for (const f of STRIP_FIELDS) delete out[f];
  if ('toolUseResult' in out) {
    const slim = slimToolResult(out.toolUseResult);
    if (slim) out.toolUseResult = slim;
    else delete out.toolUseResult;
  }
  if (out.type === 'assistant' && out.message?.usage && typeof out.message.usage === 'object') {
    out.message = { ...out.message, usage: slimUsage(out.message.usage) };
  }
  if (out.type === 'user' && Array.isArray(out.message?.content)) {
    const content = dropImages(out.message.content, toolName);
    if (content !== out.message.content) out.message = { ...out.message, content };
  }
  return out;
}

/** 累积器：逐行喂入，得到过滤后的条目（标题类只保留每种最后一条，放在末尾）。 */
export class HistoryFilter {
  private entries: Json[] = [];
  private titles = new Map<string, Json>();
  /** tool_use id → 工具名 */
  private tools = new Map<string, string>();
  private toolName = (id: string): string | undefined => this.tools.get(id);

  push(line: string): void {
    // 元数据行以 {"type":" 开头，可以不解析就判断类型，省掉大行的 JSON.parse
    const m = /^\{"type":"([A-Za-z0-9_-]+)"/.exec(line);
    if (m && !KEEP_CHAIN.has(m[1]!) && !TITLE_TYPES.includes(m[1]!)) return;
    const e = parseLine(line);
    if (!e) return;
    if (TITLE_TYPES.includes(e.type)) {
      const keep: Json = { type: e.type, sessionId: e.sessionId };
      if (e.type === 'custom-title') keep.customTitle = e.customTitle;
      else if (e.type === 'agent-name') keep.agentName = e.agentName;
      else keep.aiTitle = e.aiTitle;
      this.titles.set(e.type, keep);
      return;
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const c of e.message.content) if (c?.type === 'tool_use' && typeof c.id === 'string') this.tools.set(c.id, String(c.name));
    }
    const f = filterEntry(e, this.toolName);
    if (f) this.entries.push(f);
  }

  result(): Json[] {
    return [...this.entries, ...TITLE_TYPES.map((t) => this.titles.get(t)).filter((x): x is Json => !!x)];
  }
}

/** 过滤一批行（测试 / 小文件用）。 */
export function filterHistory(lines: string[]): Json[] {
  const f = new HistoryFilter();
  for (const l of lines) f.push(l);
  return f.result();
}
