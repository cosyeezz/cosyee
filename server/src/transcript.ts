// 会话记录 jsonl 的纯函数：行解析、标题 / 活动时间提取、历史过滤。
// 规则来自 spike/FINDINGS2.md（B2）。这里不做 IO，方便单测。
import { StringDecoder } from 'node:string_decoder';
import type { SessionDetail } from '@cosyee/shared';
import { stripSkillBlock } from './skillMention.js';

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
  '<cross-session-message', '<cosyee-delegate-notification', '[Request interrupted',
];

export const TITLE_MAX = 200;
export const DETAIL_TEXT_MAX = 240;

function truncate(s: string, max = TITLE_MAX): string {
  const t = s.replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  return chars.length > max ? chars.slice(0, max).join('') + '…' : t;
}

/** 清洗用户原始文本：排除空文本与系统注入前缀，将 <command-*> 还原为 /name args。 */
function cleanUserText(raw: string): { text: string; command: boolean } | null {
  const text = stripSkillBlock(raw).trim();
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
  return cleanUserText(text);
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

/** 保留的消息链类型；其余（attachment 里执行中送达的消息除外、api-request*、session-owner、queue-operation、prompt_snapshot 等）一律丢弃。 */
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

/**
 * message.usage 里前端用到的字段（缓存命中率图、会话花费）；其余（server_tool_use、iterations 等）不下发。
 * cache_creation（5 分钟 / 1 小时写入明细，对象）、speed、inference_geo 原样保留，算花费要用。
 */
const USAGE_KEEP = [
  'input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
  'cache_creation', 'speed', 'inference_geo',
];

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

/** 用户消息的文字块去掉附加的 skill 正文；没有改动时返回原数组 */
function stripTextBlocks(content: unknown[]): unknown[] {
  let changed = false;
  const out = content.map((c) => {
    const b = c as Json;
    if (b?.type !== 'text' || typeof b.text !== 'string') return c;
    const text = stripSkillBlock(b.text);
    if (text === b.text) return c;
    changed = true;
    return { ...b, text };
  });
  return changed ? out : content;
}

/**
 * 附件只留一种：执行中送达的消息（用户插话、委派完成通知）。CLI 把它们存成 queued_command 附件，没有 user 条目，
 * 丢掉的话插话会从历史里消失、后台委派也落定不了。只留文字与前端要用的字段；
 * 保留 uuid / parentUuid：它后面的条目接在它上面，前端按链判断 rewind 废弃的分支。
 */
function queuedPrompt(e: Json): Json | null {
  const a = e.attachment;
  if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt') return null;
  const text =
    typeof a.prompt === 'string'
      ? a.prompt
      : Array.isArray(a.prompt)
        ? a.prompt.filter((b: Json) => b?.type === 'text').map((b: Json) => String(b.text)).join('\n')
        : '';
  if (!text.trim()) return null;
  return {
    type: 'attachment',
    uuid: e.uuid,
    parentUuid: e.parentUuid,
    sessionId: e.sessionId,
    timestamp: e.timestamp,
    ...(e.isSidechain ? { isSidechain: true } : {}),
    attachment: { type: 'queued_command', commandMode: 'prompt', prompt: stripSkillBlock(text), ...(typeof a.source_uuid === 'string' ? { source_uuid: a.source_uuid } : {}) },
  };
}

/**
 * 过滤一条原始条目；返回 null 表示丢弃。
 * toolName：tool_use id → 工具名（HistoryFilter 从前面的 assistant 条目里记下来），用于判断结果里的图片要不要保留。
 */
export function filterEntry(e: Json, toolName: (id: string) => string | undefined = () => undefined): Json | null {
  if (e.type === 'attachment') return queuedPrompt(e);
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
  if (out.type === 'user' && out.message?.content) {
    const raw = out.message.content;
    const content = typeof raw === 'string' ? stripSkillBlock(raw) : Array.isArray(raw) ? stripTextBlocks(dropImages(raw, toolName)) : raw;
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
    if (m && !KEEP_CHAIN.has(m[1]!) && !TITLE_TYPES.includes(m[1]!) && !(m[1] === 'attachment' && line.includes('"queued_command"'))) return;
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

// ───────────── 会话悬浮详情统计 ─────────────

interface DetailNode {
  uuid: string | null;
  parent: string | null;
  logical: string | null;
  /** 是否是真实用户输入（含执行中插话），用于 rewind 分支起点判定 */
  prompt: boolean;
  /** user/assistant/system 的时间戳（毫秒） */
  ts: number | null;
  /** 单行截断后的用户消息文本 */
  userPrompt: string | null;
  /** 单行截断后的最后一段非空 assistant 文本（非 synthetic / 非 API 错误） */
  replyText: string | null;
  /** 本条 assistant 发起的 tool_use id 列表 */
  toolIds?: string[];
  /** 没有 id 的 tool_use 个数（兜底） */
  anonTools?: number;
  /** 非 < 开头的 assistant 模型 id */
  model: string | null;
  /** 本条记录的 gitBranch：undefined=未带/空，null=detached HEAD，string=分支名 */
  branch?: string | null;
  /** 本条非 synthetic assistant 的上下文 token（input + cache_creation + cache_read） */
  contextTokens?: number;
  /** 是否是 system/compact_boundary（清空之前的 contextTokens） */
  compactBoundary?: boolean;
}

const posNum = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** 提取执行中用户插话（queued_command 附件、commandMode prompt，排除系统通知）。 */
function queuedUserText(e: Json): string | null {
  const a = e.attachment;
  if (!a || a.type !== 'queued_command' || a.commandMode !== 'prompt') return null;
  const raw =
    typeof a.prompt === 'string'
      ? a.prompt
      : Array.isArray(a.prompt)
        ? a.prompt.filter((b: Json) => b && b.type === 'text' && typeof b.text === 'string').map((b: Json) => b.text).join('\n')
        : '';
  return cleanUserText(raw)?.text ?? null;
}

/**
 * 轻量级会话详情累积器：逐行喂入 jsonl，每个节点只留回溯与统计所需的最小字段，不保留整行 JSON。
 * result() 按与前端 history.ts 相同的规则剔除 rewind 废弃分支后汇总成 SessionDetail。
 */
export class DetailScan {
  private entries: DetailNode[] = [];

  push(line: string): void {
    // 元数据行以 {"type":" 开头，直接跳过省掉大行的 JSON.parse；保留链回溯可能用到的 attachment
    const m = /^\{"type":"([A-Za-z0-9_-]+)"/.exec(line);
    if (m && !KEEP_CHAIN.has(m[1]!) && !(m[1] === 'attachment' && (line.includes('"queued_command"') || line.includes('"uuid"')))) return;
    const e = parseLine(line);
    if (!e || e.isSidechain === true) return;

    const type = e.type;
    const isChainType = KEEP_CHAIN.has(type);
    const isAtt = type === 'attachment';
    if (!isChainType && !isAtt) return;

    const uuid = typeof e.uuid === 'string' && e.uuid ? e.uuid : null;
    const parent = typeof e.parentUuid === 'string' && e.parentUuid ? e.parentUuid : null;
    const logical = typeof e.logicalParentUuid === 'string' && e.logicalParentUuid ? e.logicalParentUuid : null;

    let userPrompt: string | null = null;
    let replyText: string | null = null;
    let toolIds: string[] | undefined;
    let anonTools = 0;
    let model: string | null = null;
    let contextTokens: number | undefined;
    let compactBoundary = false;

    if (type === 'user') {
      const r = realUserText(e);
      if (r) userPrompt = truncate(r.text, DETAIL_TEXT_MAX);
    } else if (isAtt) {
      const q = queuedUserText(e);
      if (q) userPrompt = truncate(q, DETAIL_TEXT_MAX);
      // 普通非插话 attachment 若不带 uuid（不参与链回溯），也不带有效信息，可直接忽略
      else if (!uuid) return;
    } else if (type === 'assistant') {
      const msg = e.message;
      const rawModel = typeof msg?.model === 'string' ? msg.model : '';
      const isSynthetic = rawModel.startsWith('<');
      if (rawModel && !isSynthetic) model = rawModel;
      if (Array.isArray(msg?.content)) {
        for (const b of msg.content) {
          if (!b || typeof b !== 'object') continue;
          if (b.type === 'tool_use') {
            if (typeof b.id === 'string' && b.id) (toolIds ??= []).push(b.id);
            else anonTools++;
          } else if (b.type === 'text' && typeof b.text === 'string' && !isSynthetic && e.isApiErrorMessage !== true) {
            if (b.text.trim()) replyText = truncate(b.text, DETAIL_TEXT_MAX);
          }
        }
      }
      if (!isSynthetic && msg?.usage && typeof msg.usage === 'object') {
        const u = msg.usage as Json;
        const total = posNum(u.input_tokens) + posNum(u.cache_creation_input_tokens) + posNum(u.cache_read_input_tokens);
        if (total > 0) contextTokens = total;
      }
    } else if (type === 'system' && e.subtype === 'compact_boundary') {
      compactBoundary = true;
    }

    let ts: number | null = null;
    if (isChainType && typeof e.timestamp === 'string') {
      const parsed = Date.parse(e.timestamp);
      if (Number.isFinite(parsed)) ts = parsed;
    }

    const node: DetailNode = {
      uuid,
      parent,
      logical,
      prompt: userPrompt !== null,
      ts,
      userPrompt,
      replyText,
      model,
    };
    if (toolIds) node.toolIds = toolIds;
    if (anonTools > 0) node.anonTools = anonTools;
    if (typeof e.gitBranch === 'string' && e.gitBranch) {
      node.branch = e.gitBranch === 'HEAD' ? null : e.gitBranch;
    }
    if (contextTokens !== undefined) node.contextTokens = contextTokens;
    if (compactBoundary) node.compactBoundary = true;

    this.entries.push(node);
  }

  /** 按 uuid / parentUuid 过滤掉被 rewind 废弃的分支（口径与 web/src/core/reducer/history.ts activeBranch 一致）。 */
  private activeEntries(): DetailNode[] {
    const nodes = new Map<string, DetailNode>();
    let leaf: string | null = null;
    for (const n of this.entries) {
      if (!n.uuid) continue;
      nodes.set(n.uuid, n);
      leaf = n.uuid;
    }
    if (!leaf) return this.entries;

    const up = (n: DetailNode): string | null | undefined => {
      if (n.parent && nodes.has(n.parent)) return n.parent;
      if (n.logical && nodes.has(n.logical)) return n.logical;
      return n.parent ? undefined : null;
    };

    const chain = new Set<string>();
    for (let cur: string | null = leaf; cur; ) {
      if (chain.has(cur)) return this.entries; // 环：保守保留全部
      chain.add(cur);
      const next = up(nodes.get(cur)!);
      if (next === undefined) return this.entries; // 链断：保守保留全部
      cur = next;
    }
    if (chain.size === nodes.size) return this.entries;

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
        const node = nodes.get(cur)!;
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

    return this.entries.filter((n) => !n.uuid || !isDead(n.uuid));
  }

  result(): SessionDetail {
    let createdAt: number | null = null;
    let lastMessageAt: number | null = null;
    let userMessages = 0;
    let firstPrompt: string | null = null;
    let lastPrompt: string | null = null;
    let lastReply: string | null = null;
    let model: string | null = null;
    let branch: string | null = null;
    let contextTokens: number | null = null;
    const seenTools = new Set<string>();
    let anonTools = 0;

    for (const n of this.activeEntries()) {
      if (n.ts !== null) {
        if (createdAt === null || n.ts < createdAt) createdAt = n.ts;
        if (lastMessageAt === null || n.ts > lastMessageAt) lastMessageAt = n.ts;
      }
      if (n.userPrompt !== null) {
        userMessages++;
        if (firstPrompt === null) firstPrompt = n.userPrompt;
        else lastPrompt = n.userPrompt;
      }
      if (n.toolIds) {
        for (const id of n.toolIds) seenTools.add(id);
      }
      if (n.anonTools) anonTools += n.anonTools;
      if (n.replyText !== null) lastReply = n.replyText;
      if (n.model !== null) model = n.model;
      if (n.branch !== undefined) branch = n.branch;
      if (n.compactBoundary) contextTokens = null;
      else if (n.contextTokens !== undefined) contextTokens = n.contextTokens;
    }

    return {
      createdAt,
      lastMessageAt,
      userMessages,
      toolCalls: seenTools.size + anonTools,
      firstPrompt,
      lastPrompt,
      lastReply,
      model,
      branch,
      contextTokens,
    };
  }
}

/** 统计一批行的会话详情（测试 / 小文件用）。 */
export function scanDetail(lines: string[]): SessionDetail {
  const s = new DetailScan();
  for (const l of lines) s.push(l);
  return s.result();
}
