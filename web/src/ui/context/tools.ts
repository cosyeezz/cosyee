// 工具列表：init.tools 里的内置工具 + Cosyee 自带的 mcp__cosyee__* 工具（其它 MCP 工具另有 MCP 一节管理），再并上已停用的名单。
// 已停用的工具在新启动的会话里不会出现在 init.tools，必须靠 disabledTools 保留在列表上，否则无法重新启用。
import type { Turn } from '@cosyee/shared';
import { DELEGATE_TOOL, toolLabel } from '../../core/reducer/util';

/** 与服务端 TOOL_NAME_RE 一致：不合法的名字服务端会拒绝，所以也不列出 */
const TOOL_NAME_RE = /^(?:(?!mcp__)[A-Za-z][A-Za-z0-9_]{0,63}|mcp__cosyee__[A-Za-z][A-Za-z0-9_]{0,63})$/;

/** Cosyee 自带 MCP 服务器的名字：它的工具归到「工具」一节，MCP 一节不再列这个服务器 */
export const COSYEE_MCP_SERVER = 'cosyee';

export { toolLabel };

export interface ToolRow {
  name: string;
  enabled: boolean;
}

export function toolRows(initTools: readonly string[] | undefined, disabled: readonly string[] | undefined): ToolRow[] {
  const off = new Set(disabled ?? []);
  const seen = new Set<string>();
  const rows: ToolRow[] = [];
  for (const name of [...(initTools ?? []), ...off]) {
    if (seen.has(name) || !TOOL_NAME_RE.test(name)) continue;
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

/** 智能体列表的一行：tokens 为 null 表示 CLI 没报告它的定义占用（内置智能体、或已关闭的） */
export interface AgentRow {
  name: string;
  enabled: boolean;
  tokens: number | null;
}

/**
 * 智能体列表：init.agents（含内置）与 get_context_usage 的自定义智能体（带 token）合并，再并上已关闭的名单——
 * 关闭后的智能体在新会话里不再出现，必须靠 disabledAgents 留在列表上，否则无法重新开启。
 */
export function agentRows(
  initAgents: readonly string[] | undefined,
  usageAgents: readonly { name: string; tokens: number }[],
  disabled: readonly string[] | undefined,
): AgentRow[] {
  const off = new Set(disabled ?? []);
  const tok = new Map(usageAgents.map((a) => [a.name, a.tokens]));
  const seen = new Set<string>();
  const rows: AgentRow[] = [];
  for (const name of [...(initAgents ?? []), ...tok.keys(), ...off]) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    rows.push({ name, enabled: !off.has(name), tokens: tok.get(name) ?? null });
  }
  return rows;
}
