// 内置工具列表：init.tools 里去掉 MCP 工具（mcp__ 开头，另有 MCP 一节管理），再并上已停用的名单。
// 已停用的工具在新启动的会话里不会出现在 init.tools，必须靠 disabledTools 保留在列表上，否则无法重新启用。

/** 与服务端 TOOL_NAME_RE 一致：不合法的名字服务端会拒绝，所以也不列出 */
const TOOL_NAME_RE = /^(?!mcp__)[A-Za-z][A-Za-z0-9_]{0,63}$/;

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
