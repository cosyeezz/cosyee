// 工具加载方式（常驻 / 懒加载 / 未确定）与按定义长度分摊 token：
// 1. 从本会话记录（~/.claude/projects/<encoded cwd>/<sessionId>.jsonl）增量解析
//    deferred_tools_delta / deferred_tools_record / ToolSearch 结果 / compact_boundary。
// 2. 兜底顺序：本会话实时记录 → state.json 缓存的上次懒加载名单 → CLI 2.1.332 静态表 → unknown。
// 3. 按定义长度权重（本会话记录中的定义 > 静态权重表 > 中位数）用最大余数法分摊 System tools 合计。
import fs from 'node:fs';
import path from 'node:path';
import type { ToolLoadEntry, ToolLoadSource } from '@cosyee/shared';
import { encodeCwdCandidates, isSafeId, projectsDir } from './paths.js';
import { MEDIAN_TOOL_WEIGHT, STATIC_TOOL_WEIGHTS } from './toolWeights.js';

/** CLI 2.1.332 静态默认懒加载表（含实验性条件懒加载工具） */
export const STATIC_DEFERRED_TOOLS: ReadonlySet<string> = new Set([
  // 默认懒加载（shouldDefer）
  'EnterPlanMode',
  'ExitPlanMode',
  'SendToProject',
  'SendToProjectContext',
  'McpTaskCheck',
  'Monitor',
  'TaskStop',
  'WebFetch',
  'WebSearch',
  'LSP',
  'SendMessage',
  'NotebookEdit',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
  'PushNotification',
  'EnterWorktree',
  'ExitWorktree',
  'DesignSync',
  'EndConversation',
  'FetchInboxMessage',
  'ListPlugins',
  'ListSkills',
  'SearchSkills',
  'ArtifactComments',
  'ArtifactData',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
  'ReadMcpResourceDirTool',
  'OfferChromeSetup',
  'SetGoal',
  // 条件懒加载（实验特性）
  'ReportFindings',
  'ShareOnboardingGuide',
  'ReadNotifications',
  'SendFeedback',
  'Workflow',
  // Cosyee 自带 MCP 懒加载工具
  'mcp__cosyee__delegate_agents',
]);

/** CLI 2.1.332 静态默认常驻表 */
export const STATIC_RESIDENT_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'PowerShell',
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'ToolSearch',
  'Agent',
  'Task',
  'Skill',
  'ListAgents',
  'AskUserQuestion',
  'ScheduleWakeup',
  'Artifact',
  'SendUserMessage',
  'SubagentHandback',
  // Cosyee 自带 MCP alwaysLoad 工具
  'mcp__cosyee__delegate',
  'mcp__cosyee__delegate_send',
  'mcp__cosyee__delegate_stop',
  'mcp__cosyee__delegate_result',
]);

export interface TranscriptToolState {
  /** 是否在记录里见过 deferred_tools_delta（为 false 表示本会话尚未产生实时懒加载信息） */
  seenDelta: boolean;
  /** 本会话当前的懒加载工具集合 */
  deferred: ReadonlySet<string>;
  /** 本会话已加载完整定义的懒加载工具集合（deferred 的子集） */
  loaded: ReadonlySet<string>;
  /** 本会话记录里见到的工具定义长度（JSON.stringify({name,description,input_schema}).length） */
  weights: ReadonlyMap<string, number>;
}

interface MutableTranscriptState {
  seenDelta: boolean;
  pendingCompactReset: boolean;
  deferred: Set<string>;
  loadedRaw: Set<string>;
  called: Set<string>;
  weights: Map<string, number>;
}

function createMutableState(): MutableTranscriptState {
  return {
    seenDelta: false,
    pendingCompactReset: false,
    deferred: new Set(),
    loadedRaw: new Set(),
    called: new Set(),
    weights: new Map(),
  };
}

function defWeight(def: unknown): number | null {
  if (!def || typeof def !== 'object') return null;
  const d = def as Record<string, unknown>;
  if (typeof d.name !== 'string') return null;
  return JSON.stringify({
    name: d.name,
    description: d.description ?? '',
    input_schema: d.input_schema ?? {},
  }).length;
}

/** 将一条已解析的 JSONL 记录应用到增量状态 */
export function applyTranscriptEntry(state: MutableTranscriptState, j: unknown): void {
  if (!j || typeof j !== 'object') return;
  const rec = j as Record<string, unknown>;

  if (rec.type === 'system' && rec.subtype === 'compact_boundary') {
    state.pendingCompactReset = true;
    return;
  }

  if (rec.type === 'attachment' && rec.attachment && typeof rec.attachment === 'object') {
    const att = rec.attachment as Record<string, unknown>;
    if (att.type === 'deferred_tools_delta') {
      if (state.pendingCompactReset) {
        state.deferred.clear();
        state.loadedRaw.clear();
        state.called.clear();
        state.pendingCompactReset = false;
      }
      state.seenDelta = true;
      if (Array.isArray(att.removedNames)) {
        for (const n of att.removedNames) {
          if (typeof n === 'string') {
            state.deferred.delete(n);
            state.loadedRaw.delete(n);
          }
        }
      }
      if (Array.isArray(att.addedNames)) {
        for (const n of att.addedNames) if (typeof n === 'string') state.deferred.add(n);
      }
      if (Array.isArray(att.readdedNames)) {
        for (const n of att.readdedNames) if (typeof n === 'string') state.deferred.add(n);
      }
      if (Array.isArray(att.surfacedNames)) {
        for (const n of att.surfacedNames) if (typeof n === 'string') state.loadedRaw.add(n);
      }
      if (Array.isArray(att.surfacedDefinitions)) {
        for (const item of att.surfacedDefinitions) {
          if (!item || typeof item !== 'object') continue;
          const s = item as Record<string, unknown>;
          const def = s.definition && typeof s.definition === 'object' ? (s.definition as Record<string, unknown>) : null;
          const name = typeof def?.name === 'string' ? def.name : typeof s.name === 'string' ? s.name : null;
          if (!name) continue;
          state.loadedRaw.add(name);
          if (def) {
            const w = defWeight({ name, description: def.description, input_schema: def.input_schema });
            if (w && w > 0) state.weights.set(name, w);
          }
        }
      }
      return;
    }

    if (att.type === 'deferred_tools_record' && Array.isArray(att.entries)) {
      for (const e of att.entries) {
        if (!e || typeof e !== 'object') continue;
        const entry = e as Record<string, unknown>;
        if (typeof entry.name !== 'string') continue;
        state.loadedRaw.add(entry.name);
        const w = defWeight(entry);
        if (w && w > 0) state.weights.set(entry.name, w);
      }
      return;
    }
  }

  // ToolSearch 结果：toolUseResult.matches 列出被加载的懒加载工具名
  if (rec.type === 'user' && rec.toolUseResult && typeof rec.toolUseResult === 'object') {
    const matches = (rec.toolUseResult as Record<string, unknown>).matches;
    if (Array.isArray(matches)) {
      for (const m of matches) if (typeof m === 'string') state.loadedRaw.add(m);
    }
    return;
  }

  // assistant 消息里直接调用过的工具：若该工具在 deferred 集合里，也说明它已加载
  if (rec.type === 'assistant' && rec.message && typeof rec.message === 'object') {
    const content = (rec.message as Record<string, unknown>).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use') {
          const name = (block as Record<string, unknown>).name;
          if (typeof name === 'string') state.called.add(name);
        }
      }
    }
  }
}

function finalizeState(state: MutableTranscriptState): TranscriptToolState {
  const loaded = new Set<string>();
  for (const n of state.loadedRaw) if (state.deferred.has(n)) loaded.add(n);
  for (const n of state.called) if (state.deferred.has(n)) loaded.add(n);
  return {
    seenDelta: state.seenDelta,
    deferred: new Set(state.deferred),
    loaded,
    weights: new Map(state.weights),
  };
}

/** 从一段 JSONL 文本解析出工具加载状态（供单测与一次性解析用） */
export function parseTranscriptToolLoad(jsonl: string): TranscriptToolState {
  const st = createMutableState();
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    // 快速跳过与工具加载无关的行，避免对大文件每行都 JSON.parse
    if (
      !line.includes('deferred_tools_') &&
      !line.includes('compact_boundary') &&
      !line.includes('"matches"') &&
      !line.includes('"tool_use"')
    ) {
      continue;
    }
    try {
      applyTranscriptEntry(st, JSON.parse(line));
    } catch {
      // 忽略坏行
    }
  }
  return finalizeState(st);
}

interface FileCacheEntry {
  mtimeMs: number;
  size: number;
  /** 已完整解析到的字节偏移（始终落在换行符之后） */
  offset: number;
  mutable: MutableTranscriptState;
  snapshot: TranscriptToolState;
}

const CACHE_MAX = 100;

/**
 * 按文件路径缓存的增量会话记录解析器：
 * - mtime + size 没变直接返回快照；
 * - 文件追加只读 [offset, size) 增量；
 * - 文件变小（截断/重写）从头解析。
 */
export class TranscriptToolLoadCache {
  private cache = new Map<string, FileCacheEntry>();

  /** 读取某个 jsonl 文件的工具加载状态；文件不存在返回 null */
  async readFile(file: string): Promise<TranscriptToolState | null> {
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(file);
    } catch {
      this.cache.delete(file);
      return null;
    }
    const prev = this.cache.get(file);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      return prev.snapshot;
    }

    const fromScratch = !prev || st.size < prev.offset;
    const startOffset = fromScratch ? 0 : prev.offset;
    const mutable = fromScratch ? createMutableState() : prev.mutable;
    const len = st.size - startOffset;

    let newOffset = startOffset;
    if (len > 0) {
      const fh = await fs.promises.open(file, 'r');
      try {
        const buf = Buffer.alloc(len);
        const { bytesRead } = await fh.read(buf, 0, len, startOffset);
        const slice = buf.subarray(0, bytesRead);
        // 只消费到最后一个换行符，防止读到正在写入的半行
        const lastNl = slice.lastIndexOf(0x0a);
        if (lastNl >= 0) {
          const text = slice.subarray(0, lastNl).toString('utf8');
          for (const line of text.split('\n')) {
            if (!line) continue;
            if (
              !line.includes('deferred_tools_') &&
              !line.includes('compact_boundary') &&
              !line.includes('"matches"') &&
              !line.includes('"tool_use"')
            ) {
              continue;
            }
            try {
              applyTranscriptEntry(mutable, JSON.parse(line));
            } catch {
              // 忽略坏行
            }
          }
          newOffset = startOffset + lastNl + 1;
        }
      } finally {
        await fh.close();
      }
    }

    const snapshot = finalizeState(mutable);
    this.cache.delete(file);
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, offset: newOffset, mutable, snapshot });
    if (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return snapshot;
  }

  /** 按 cwd + sessionId 定位会话记录并读取工具加载状态 */
  async readSession(cwd: string, sessionId: string): Promise<TranscriptToolState | null> {
    if (!isSafeId(sessionId)) return null;
    const root = projectsDir();
    for (const enc of encodeCwdCandidates(cwd)) {
      const file = path.join(root, enc, `${sessionId}.jsonl`);
      const res = await this.readFile(file);
      if (res) return res;
    }
    return null;
  }
}

export interface ClassifyToolsInput {
  /** 本会话启用的内置工具（含 mcp__cosyee__*，不含已停用） */
  enabled: readonly string[];
  /** 已停用的内置工具 */
  disabled: readonly string[];
  /** 本会话记录解析出的实时状态 */
  session?: TranscriptToolState | null;
  /** state.json 缓存的上次观测到的懒加载工具名单 */
  cachedDeferred?: readonly string[] | null;
  /** Cosyee 自带 MCP 工具在 get_context_usage.mcpTools 里的 isLoaded（true=常驻/已加载，false=懒加载未加载） */
  cosyeeMcpLoaded?: ReadonlyMap<string, boolean> | null;
}

export interface ClassifyToolsResult {
  toolLoad: Record<string, ToolLoadEntry>;
  source: ToolLoadSource;
}

/**
 * 为全部工具（启用 + 已停用）确定加载方式（resident / deferred / unknown）与是否已加载：
 * - 启用工具：本会话记录 > 缓存 > 静态表 > unknown
 * - 已停用工具（不在本会话工具列表中）：缓存 > 静态表 > unknown
 */
export function classifyTools(input: ClassifyToolsInput): ClassifyToolsResult {
  const { enabled, disabled, session, cachedDeferred, cosyeeMcpLoaded } = input;
  const hasLive = !!session?.seenDelta;
  const cachedSet = new Set(cachedDeferred ?? []);
  const hasCache = cachedSet.size > 0;
  const disabledSet = new Set(disabled);
  const all = new Set<string>([...enabled, ...disabled]);

  const fallback = (name: string): ToolLoadEntry => {
    if (cachedSet.has(name)) return { load: 'deferred', source: 'cache' };
    if (STATIC_DEFERRED_TOOLS.has(name)) return { load: 'deferred', source: 'static' };
    if (STATIC_RESIDENT_TOOLS.has(name)) return { load: 'resident', source: 'static' };
    return { load: 'unknown' };
  };

  const toolLoad: Record<string, ToolLoadEntry> = {};
  for (const name of all) {
    if (disabledSet.has(name)) {
      toolLoad[name] = fallback(name);
      continue;
    }

    // Cosyee 自带 MCP 工具：CLI 的 mcpTools[].isLoaded 提供实时信号
    if (cosyeeMcpLoaded?.has(name)) {
      const mcpLoaded = cosyeeMcpLoaded.get(name)!;
      if (hasLive && session!.deferred.has(name)) {
        const isLoaded = session!.loaded.has(name) || mcpLoaded;
        toolLoad[name] = { load: 'deferred', ...(isLoaded ? { loaded: true as const } : {}), source: 'session' };
      } else if (!mcpLoaded) {
        toolLoad[name] = { load: 'deferred', source: 'session' };
      } else if (!hasLive && STATIC_DEFERRED_TOOLS.has(name)) {
        toolLoad[name] = { load: 'deferred', loaded: true, source: 'session' };
      } else {
        toolLoad[name] = { load: 'resident', source: 'session' };
      }
      continue;
    }

    if (hasLive) {
      if (session!.deferred.has(name)) {
        toolLoad[name] = {
          load: 'deferred',
          ...(session!.loaded.has(name) ? { loaded: true as const } : {}),
          source: 'session',
        };
      } else {
        toolLoad[name] = { load: 'resident', source: 'session' };
      }
      continue;
    }

    toolLoad[name] = fallback(name);
  }

  const source: ToolLoadSource = hasLive ? 'session' : hasCache ? 'cache' : 'static';
  return { toolLoad, source };
}

/** 查单个工具的定义长度权重：本会话记录中的实时定义 > 静态权重表 > 中位数 */
export function weightOfTool(name: string, runtimeWeights?: ReadonlyMap<string, number> | null): number {
  const live = runtimeWeights?.get(name);
  if (typeof live === 'number' && live > 0) return live;
  const stat = STATIC_TOOL_WEIGHTS[name];
  if (typeof stat === 'number' && stat > 0) return stat;
  return MEDIAN_TOOL_WEIGHT;
}

/**
 * 最大余数法（Hamilton / largest-remainder）：将整数 total 按正权重分摊到各工具，
 * 保证所有整数部分之和严格等于 Math.max(0, Math.round(total))。
 */
export function allocateLargestRemainder(total: number, items: readonly { name: string; weight: number }[]): Map<string, number> {
  const out = new Map<string, number>();
  if (items.length === 0) return out;
  const budget = Math.max(0, Math.round(total));
  if (budget === 0) {
    for (const it of items) out.set(it.name, 0);
    return out;
  }

  const weights = items.map((it) => (Number.isFinite(it.weight) && it.weight > 0 ? it.weight : MEDIAN_TOOL_WEIGHT));
  const weightSum = weights.reduce((a, b) => a + b, 0);

  let floorSum = 0;
  const parts = items.map((it, i) => {
    const exact = (budget * weights[i]!) / weightSum;
    const fl = Math.floor(exact);
    floorSum += fl;
    return { name: it.name, weight: weights[i]!, fl, rem: exact - fl };
  });

  let leftover = budget - floorSum;
  if (leftover > 0) {
    const order = [...parts].sort((a, b) => b.rem - a.rem || b.weight - a.weight || a.name.localeCompare(b.name));
    for (let i = 0; i < leftover && i < order.length; i++) {
      order[i]!.fl += 1;
    }
  }

  for (const p of parts) out.set(p.name, p.fl);
  return out;
}
