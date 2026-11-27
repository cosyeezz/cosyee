// 由 server/scripts/gen-tool-weights.mjs 自动生成，请勿手改。
// CLI 版本：2.1.332 (Claude Code)
// 权重 = JSON.stringify({ name, description, input_schema }).length（与 CLI 内部按定义长度分摊一致）。
// 重新生成：node server/scripts/gen-tool-weights.mjs

export const TOOL_WEIGHTS_CLI_VERSION = "2.1.332 (Claude Code)";

export const STATIC_TOOL_WEIGHTS: Readonly<Record<string, number>> = {
  "Agent": 5244,
  "AskUserQuestion": 4498,
  "Bash": 4186,
  "CronCreate": 4889,
  "CronDelete": 427,
  "CronList": 277,
  "Edit": 964,
  "EnterPlanMode": 4298,
  "EnterWorktree": 4013,
  "ExitPlanMode": 2443,
  "ExitWorktree": 2903,
  "Glob": 731,
  "Grep": 3224,
  "ListAgents": 1963,
  "ListPlugins": 834,
  "ListSkills": 637,
  "Monitor": 7568,
  "NotebookEdit": 1623,
  "PowerShell": 9335,
  "Read": 1919,
  "ReadNotifications": 2114,
  "ReportFindings": 2418,
  "ScheduleWakeup": 4886,
  "SendFeedback": 5508,
  "SendMessage": 6179,
  "SendToProject": 6875,
  "SendToProjectContext": 762,
  "Skill": 1803,
  "TaskCreate": 2816,
  "TaskGet": 1018,
  "TaskList": 1189,
  "TaskStop": 789,
  "TaskUpdate": 3510,
  "TodoWrite": 929,
  "ToolSearch": 1425,
  "WebFetch": 1080,
  "WebSearch": 861,
  "Workflow": 5688,
  "Write": 639,
};

/** 静态表权重的中位数：未知工具缺省权重 */
export const MEDIAN_TOOL_WEIGHT = 2114;
