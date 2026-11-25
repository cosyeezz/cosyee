// 会话级活动汇总：从全部 turns 派生子代理、技能、MCP 三类数据（纯函数，不改 reducer）。
import type { SkillLoad, SubagentRun, Turn } from '@cosyee/shared';
import { isTurnActive } from './format';
import { groupMcpCalls, type McpServerGroup } from './mcp';

export interface ActivityRun {
  turnId: string;
  run: SubagentRun;
}

export interface SessionActivity {
  runs: ActivityRun[];
  skills: SkillLoad[];
  mcp: McpServerGroup[];
  /** 各类是否正在进行：进行中的轮用到了它（同一轮内两次调用之间不算停），或有子代理还在跑 */
  live: { runs: boolean; skills: boolean; mcp: boolean };
}

// 旧轮对象引用不变，按 Turn 缓存每轮的 MCP 分组；mcpServers 变化时失效
const turnMcpCache = new WeakMap<Turn, { key: string; groups: McpServerGroup[] }>();

function getTurnMcp(turn: Turn, mcpServers: readonly string[], key: string): McpServerGroup[] {
  const hit = turnMcpCache.get(turn);
  if (hit && hit.key === key) return hit.groups;
  const groups = groupMcpCalls(turn.steps, mcpServers);
  turnMcpCache.set(turn, { key, groups });
  return groups;
}

/** 收集整个会话的子代理、技能与 MCP 调用 */
export function collectActivity(turns: readonly Turn[], mcpServers: readonly string[]): SessionActivity {
  const runs: ActivityRun[] = [];
  const runIndex = new Map<string, number>();
  const skills: SkillLoad[] = [];
  const mcp: McpServerGroup[] = [];
  const mcpByServer = new Map<string, McpServerGroup>();
  const mcpKey = mcpServers.join('\0');
  const live = { runs: false, skills: false, mcp: false };

  for (const turn of turns) {
    const active = isTurnActive(turn);
    if (active && turn.subagents.length > 0) live.runs = true;

    // 子代理按 toolUseId 去重：顺序取首次出现的位置，内容与 turnId 取最后一份（跨轮恢复的最新副本）
    for (const run of turn.subagents) {
      const idx = runIndex.get(run.toolUseId);
      if (idx === undefined) {
        runIndex.set(run.toolUseId, runs.length);
        runs.push({ turnId: turn.id, run });
      } else {
        runs[idx] = { turnId: turn.id, run };
      }
    }

    // 技能：各轮依次拼接；已结束的轮里仍是 loading 的按 loaded 处理
    if (turn.skills && turn.skills.length > 0) {
      if (active) live.skills = true;
      for (const s of turn.skills) {
        skills.push(!active && s.status === 'loading' ? { ...s, status: 'loaded' } : s);
      }
    }

    // MCP：逐轮分组后按服务器、工具合并；已结束的轮没等到结果的调用不算 running
    const turnGroups = getTurnMcp(turn, mcpServers, mcpKey);
    if (active && turnGroups.length > 0) live.mcp = true;
    for (const g of turnGroups) {
      let merged = mcpByServer.get(g.server);
      if (!merged) {
        merged = { server: g.server, tools: [], running: false, failed: false, callCount: 0 };
        mcpByServer.set(g.server, merged);
        mcp.push(merged);
      }
      merged.callCount += g.callCount;
      if (active && g.running) merged.running = true;
      if (g.failed) merged.failed = true;
      for (const t of g.tools) {
        const tRunning = active && t.running;
        let mt = merged.tools.find((x) => x.tool === t.tool);
        if (!mt) {
          mt = { tool: t.tool, calls: [...t.calls], running: tRunning, failed: t.failed };
          merged.tools.push(mt);
        } else {
          mt.calls.push(...t.calls);
          if (tRunning) mt.running = true;
          if (t.failed) mt.failed = true;
        }
      }
    }
  }

  // 后台委派不随主轮结束
  if (runs.some((r) => r.run.status === 'running')) live.runs = true;
  return { runs, skills, mcp, live };
}
