// MCP 工具调用的解析与分组：工具名格式 mcp__<服务器>__<工具>，服务器名可含 _ / -。
import type { ToolStep, Turn } from '@cosyee/shared';
import { isCosyeeTool } from '../../core/reducer/util';

export interface McpName {
  server: string;
  tool: string;
}

/**
 * 拆 mcp__<server>__<tool>。有已知服务器名时取最长的前缀匹配（服务器名本身可能含 `__`）；
 * 否则按 mcp__ 后的第一个 `__` 拆。不是 MCP 工具名返回 null。
 */
export function parseMcpName(name: string, known: readonly string[] = []): McpName | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  let best: string | null = null;
  for (const k of known) {
    // CLI 会把服务器名里的特殊字符规整成 _，两种写法都比一下
    for (const cand of new Set([k, k.replace(/[^a-zA-Z0-9_-]/g, '_')])) {
      if (rest.startsWith(`${cand}__`) && rest.length > cand.length + 2 && (!best || cand.length > best.length)) best = cand;
    }
  }
  if (best) return { server: best, tool: rest.slice(best.length + 2) };
  const i = rest.indexOf('__');
  if (i <= 0 || i + 2 >= rest.length) return null;
  return { server: rest.slice(0, i), tool: rest.slice(i + 2) };
}

export interface McpToolGroup {
  tool: string;
  calls: ToolStep[];
  running: boolean;
  failed: boolean;
}

export interface McpServerGroup {
  server: string;
  tools: McpToolGroup[];
  running: boolean;
  failed: boolean;
  callCount: number;
}

/** 本轮的 MCP 调用，按服务器、再按工具分组，均为首次调用的顺序 */
export function groupMcpCalls(steps: Turn['steps'], known: readonly string[] = []): McpServerGroup[] {
  const servers = new Map<string, McpServerGroup>();
  for (const s of steps) {
    if (s.kind !== 'tool' || isCosyeeTool(s.name)) continue;
    const p = parseMcpName(s.name, known);
    if (!p) continue;
    let g = servers.get(p.server);
    if (!g) {
      g = { server: p.server, tools: [], running: false, failed: false, callCount: 0 };
      servers.set(p.server, g);
    }
    let t = g.tools.find((x) => x.tool === p.tool);
    if (!t) {
      t = { tool: p.tool, calls: [], running: false, failed: false };
      g.tools.push(t);
    }
    t.calls.push(s);
    g.callCount++;
    if (!s.result) t.running = g.running = true;
    if (s.result?.isError) t.failed = g.failed = true;
  }
  return [...servers.values()];
}
