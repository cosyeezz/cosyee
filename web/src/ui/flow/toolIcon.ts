// 展开区的工具图标选择（纯函数，无 React 依赖，便于单测）。
import { isCosyeeTool } from '../../core/reducer/util';
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
  // 子代理的后续操作：继续发消息、列出、停止、读输出
  SendMessage: 'tool-agent',
  ListAgents: 'tool-agent',
  TaskStop: 'tool-agent',
  TaskOutput: 'tool-agent',
  TodoWrite: 'tool-todo',
  // 任务清单类：TaskCreate / TaskUpdate / TaskList / TaskGet
  TaskCreate: 'tool-todo',
  TaskUpdate: 'tool-todo',
  TaskList: 'tool-todo',
  TaskGet: 'tool-todo',
  // 交互工具：提问用说明图标，计划用清单
  AskUserQuestion: 'info',
  ExitPlanMode: 'mode-plan',
};

/**
 * 工具名 → 图标名。出错（tool_result 带 is_error）时一律换成 tool-fail。
 * mcp__ 开头的是外部连接器的工具（Cosyee 自带工具除外）；TaskOutput / TaskStop 操作的是后台子代理 / 任务，归到子代理图标，不是清单。
 */
export function toolIconName(name: string, isError = false): IconName {
  if (isError) return 'tool-fail';
  // Cosyee 自带的委派工具：按子代理显示，不当外部连接器
  if (isCosyeeTool(name)) return 'tool-agent';
  if (name.startsWith('mcp__')) return 'tool-mcp';
  return Object.prototype.hasOwnProperty.call(BY_NAME, name) ? BY_NAME[name] : 'tool-generic';
}
