// 展开区的工具图标选择（纯函数，无 React 依赖，便于单测）。
import type { IconName } from '../icons/Icon';

const BY_NAME: Record<string, IconName> = {
  Bash: 'tool-bash',
  PowerShell: 'tool-bash',
  Read: 'tool-read',
  NotebookRead: 'tool-read',
  Edit: 'tool-edit',
  Write: 'tool-edit',
  MultiEdit: 'tool-edit',
  NotebookEdit: 'tool-edit',
  Grep: 'tool-search',
  Glob: 'tool-search',
  ToolSearch: 'tool-search',
  WebFetch: 'tool-web',
  WebSearch: 'tool-web',
  // 子代理工具：新版叫 Agent，旧版叫 Task（注意它不是任务清单）
  Agent: 'tool-agent',
  Task: 'tool-agent',
  TodoWrite: 'tool-todo',
  // 任务清单类：TaskCreate / TaskUpdate / TaskList / TaskGet
  TaskCreate: 'tool-todo',
  TaskUpdate: 'tool-todo',
  TaskList: 'tool-todo',
  TaskGet: 'tool-todo',
};

/**
 * 工具名 → 图标名。出错（tool_result 带 is_error）时一律换成 tool-fail。
 * mcp__ 开头的是外部连接器的工具；其他 Task*（TaskOutput、TaskStop 等后台任务工具）不是清单，走兜底图标。
 */
export function toolIconName(name: string, isError = false): IconName {
  if (isError) return 'tool-fail';
  if (name.startsWith('mcp__')) return 'tool-mcp';
  return Object.prototype.hasOwnProperty.call(BY_NAME, name) ? BY_NAME[name] : 'tool-generic';
}
