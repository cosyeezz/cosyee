// 工具列表：init.tools 里的内置工具 + Cosyee 自带的 mcp__cosyee__* 工具（其它 MCP 工具另有 MCP 一节管理），再并上已停用的名单。
// 已停用的工具在新启动的会话里不会出现在 init.tools，必须靠 disabledTools 保留在列表上，否则无法重新启用。
import type { ToolLoadClass, ToolLoadEntry, Turn } from '@cosyee/shared';
import { DELEGATE_TOOL, toolLabel } from '../../core/reducer/util';

/** 与服务端 TOOL_NAME_RE 一致：不合法的名字服务端会拒绝，所以也不列出 */
const TOOL_NAME_RE = /^(?:(?!mcp__)[A-Za-z][A-Za-z0-9_]{0,63}|mcp__cosyee__[A-Za-z][A-Za-z0-9_]{0,63})$/;

/** Cosyee 自带 MCP 服务器的名字：它的工具归到「工具」一节，MCP 一节不再列这个服务器 */
export const COSYEE_MCP_SERVER = 'cosyee';

/** 委派辅助工具（标准顺序，不含已废弃的 delegate_status） */
export const DELEGATE_AUX_ORDER: readonly string[] = [
  'mcp__cosyee__delegate_send',
  'mcp__cosyee__delegate_stop',
  'mcp__cosyee__delegate_result',
  'mcp__cosyee__delegate_agents',
];

const LEGACY_DELEGATE_STATUS = 'mcp__cosyee__delegate_status';

/** 委派辅助工具：跟随 mcp__cosyee__delegate 一起启停，不在工具面板单独列出开关 */
const DELEGATE_AUX_TOOLS = new Set([...DELEGATE_AUX_ORDER, LEGACY_DELEGATE_STATUS]);

export { DELEGATE_TOOL, toolLabel };

export interface DelegateAuxItem {
  name: string;
  load: ToolLoadClass;
  loaded: boolean;
  tokens: number | null;
}

/**
 * 收集当前会话里实际存在的委派辅助工具（顺序固定：send / stop / result / agents；
 * 旧版 delegate_status 仅在实际注册于 initTools / cosyee MCP 时才包含）。
 * 当 delegate 已停用、上述列表里暂无辅助工具时，若 toolLoad 里有记录也会保留这 4 个标准辅助工具以便说明“随 delegate 停用”。
 */
export function delegateAuxItems(params: {
  initTools?: readonly string[];
  cosyeeTools?: ReadonlyMap<string, { tokens: number | null }>;
  mcpTools?: readonly { name: string; server: string; tokens: number }[];
  toolTokens?: ReadonlyMap<string, { tokens: number; deferred?: true; loaded?: true }>;
  toolLoad?: Readonly<Record<string, ToolLoadEntry>>;
  delegateEnabled: boolean;
}): DelegateAuxItem[] {
  const { initTools, cosyeeTools, mcpTools, toolTokens, toolLoad, delegateEnabled } = params;
  const registered = new Set<string>();
  for (const n of initTools ?? []) if (DELEGATE_AUX_TOOLS.has(n)) registered.add(n);
  if (cosyeeTools) for (const n of cosyeeTools.keys()) if (DELEGATE_AUX_TOOLS.has(n)) registered.add(n);
  for (const t of mcpTools ?? []) if (t.server === COSYEE_MCP_SERVER && DELEGATE_AUX_TOOLS.has(t.name)) registered.add(t.name);
  if (toolTokens) for (const n of toolTokens.keys()) if (DELEGATE_AUX_TOOLS.has(n)) registered.add(n);

  const names: string[] = [];
  for (const n of DELEGATE_AUX_ORDER) {
    if (registered.has(n) || (!delegateEnabled && toolLoad && n in toolLoad)) names.push(n);
  }
  if (registered.has(LEGACY_DELEGATE_STATUS)) names.push(LEGACY_DELEGATE_STATUS);

  return names.map((name) => {
    const info = toolLoad?.[name];
    const tokEntry = toolTokens?.get(name);
    const load: ToolLoadClass = info?.load ?? (tokEntry?.deferred ? 'deferred' : name === 'mcp__cosyee__delegate_agents' ? 'deferred' : 'resident');
    const loaded = delegateEnabled && load === 'deferred' && (info?.loaded === true || tokEntry?.loaded === true);
    const mcpTok = mcpTools?.find((t) => t.name === name)?.tokens ?? null;
    const rawTok = tokEntry?.tokens ?? cosyeeTools?.get(name)?.tokens ?? mcpTok;
    return {
      name,
      load,
      loaded,
      tokens: delegateEnabled ? rawTok : null,
    };
  });
}

export interface ToolRow {
  name: string;
  enabled: boolean;
}

export interface ToolGroup {
  load: ToolLoadClass;
  rows: ToolRow[];
}

const GROUP_ORDER: readonly ToolLoadClass[] = ['resident', 'deferred', 'unknown'];

/** 按加载方式分组（常驻 → 懒加载 → 未确定），隐藏空组，组内保持原有顺序（含已停用工具） */
export function groupToolRows(
  rows: readonly ToolRow[],
  toolLoad: Readonly<Record<string, ToolLoadEntry>> | undefined,
): ToolGroup[] {
  const buckets: Record<ToolLoadClass, ToolRow[]> = { resident: [], deferred: [], unknown: [] };
  for (const r of rows) {
    const cls = toolLoad?.[r.name]?.load ?? 'unknown';
    buckets[cls].push(r);
  }
  return GROUP_ORDER.filter((load) => buckets[load].length > 0).map((load) => ({ load, rows: buckets[load] }));
}

export function toolRows(initTools: readonly string[] | undefined, disabled: readonly string[] | undefined): ToolRow[] {
  const off = new Set(disabled ?? []);
  const seen = new Set<string>();
  const rows: ToolRow[] = [];
  for (const name of [...(initTools ?? []), ...off]) {
    if (seen.has(name) || !TOOL_NAME_RE.test(name) || DELEGATE_AUX_TOOLS.has(name)) continue;
    seen.add(name);
    rows.push({ name, enabled: !off.has(name) });
  }
  return rows;
}

/** 某个工具在本会话里被调用的次数：main = 主线程，sub = 子智能体内 */
export interface ToolCalls {
  main: number;
  sub: number;
}

/** 子智能体工具在旧版 CLI 里叫 Task，新版叫 Agent；派发子任务在会话流里记成 subagents，不在 steps 里 */
const AGENT_NAMES = ['Agent', 'Task'];

/**
 * 统计会话流里每个工具的累计调用次数（含历史；含子智能体内部的调用）。
 * 子智能体的派发按 Agent 计，查 Task 时也用这个数（见 callsOf）。
 */
export function toolCallCounts(turns: readonly Turn[] | undefined): Map<string, ToolCalls> {
  const out = new Map<string, ToolCalls>();
  const add = (name: string, k: keyof ToolCalls): void => {
    const c = out.get(name) ?? { main: 0, sub: 0 };
    c[k]++;
    out.set(name, c);
  };
  for (const t of turns ?? []) {
    for (const s of t.steps) if (s.kind === 'tool') add(s.name, 'main');
    for (const run of t.subagents) {
      const isDelegate = run.delegate === true;
      add(isDelegate ? DELEGATE_TOOL : 'Agent', 'main');
      // 委派子代理内部跑的是委派后端自己的工具，不计入 Claude 工具的 sub 次数
      if (isDelegate) continue;
      for (const s of run.turn.steps) if (s.kind === 'tool') add(s.name, 'sub');
    }
  }
  return out;
}

export function callsOf(counts: ReadonlyMap<string, ToolCalls>, name: string): ToolCalls {
  const c = counts.get(name);
  if (c || !AGENT_NAMES.includes(name)) return c ?? { main: 0, sub: 0 };
  // Agent / Task 互为别名：会话流里统一记成 Agent
  for (const n of AGENT_NAMES) {
    const a = counts.get(n);
    if (a) return a;
  }
  return { main: 0, sub: 0 };
}

/**
 * 所有会话里某个工具的累计调用次数（服务端 ToolStats.counts）。
 * Agent / Task 是同一个工具在新旧 CLI 里的名字，历史记录里两种都有，合在一起算。
 */
export function totalCallsOf(counts: Readonly<Record<string, number>> | undefined, name: string): number {
  if (!counts) return 0;
  if (!AGENT_NAMES.includes(name)) return counts[name] ?? 0;
  return AGENT_NAMES.reduce((n, a) => n + (counts[a] ?? 0), 0);
}

/** 某个 skill 在本会话里的加载次数：model = 模型调用 Skill 工具，user = 用户输入 /名字，sub = 子智能体内 */
export interface SkillCalls {
  model: number;
  user: number;
  sub: number;
}

const NO_SKILL_CALLS: SkillCalls = { model: 0, user: 0, sub: 0 };

/** 统计会话流里每个 skill 的加载次数（含历史与子智能体；加载失败的不算） */
export function skillCallCounts(turns: readonly Turn[] | undefined): Map<string, SkillCalls> {
  const out = new Map<string, SkillCalls>();
  const add = (name: string, k: keyof SkillCalls): void => {
    if (!name) return;
    const c = out.get(name) ?? { ...NO_SKILL_CALLS };
    c[k]++;
    out.set(name, c);
  };
  for (const t of turns ?? []) {
    for (const s of t.skills ?? []) if (s.status !== 'error') add(s.name, s.source);
    for (const run of t.subagents) for (const s of run.turn.skills ?? []) if (s.status !== 'error') add(s.name, 'sub');
  }
  return out;
}

/** 去掉插件前缀：anthropic-skills:pdf -> pdf */
const baseOf = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

/**
 * 计数里属于这个 skill 的键：完整名本身；带插件前缀的 skill 还认不带前缀的写法（模型 / 用户常省略前缀）。
 * 不带前缀的 skill 只认完整名，免得把别的插件里同名的算进来。
 */
function skillKeys<T>(entries: Iterable<[string, T]>, name: string): T[] {
  const bare = name.includes(':') ? baseOf(name) : null;
  const out: T[] = [];
  for (const [k, v] of entries) if (k === name || (bare !== null && k === bare)) out.push(v);
  return out;
}

export function skillCallsOf(counts: ReadonlyMap<string, SkillCalls>, name: string): SkillCalls {
  const out = { ...NO_SKILL_CALLS };
  for (const c of skillKeys(counts, name)) {
    out.model += c.model;
    out.user += c.user;
    out.sub += c.sub;
  }
  return out;
}

/** 所有会话里某个 skill 的累计加载次数（服务端 ToolStats.skills）；服务端没有这项为 null */
export function totalSkillCallsOf(counts: Readonly<Record<string, number>> | undefined, name: string): number | null {
  if (!counts) return null;
  return skillKeys(Object.entries(counts), name).reduce((n, c) => n + c, 0);
}
