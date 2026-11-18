// 内置工具的中文用途与停用提示（按 CLI 报告的工具名查）。未收录的工具悬浮时显示「暂无中文说明」。
// core = 模型干活的基本手段，停用后多数任务做不了；悬浮提示里会特别提醒。

export interface ToolInfo {
  /** 一句话用途（中文） */
  purpose: string;
  /** 停用前需要知道的事（中文），可选 */
  note?: string;
  /** 核心工具：不建议停用 */
  core?: true;
}

export const TOOL_CATALOG: Record<string, ToolInfo> = {
  // —— 读写文件 ——
  Read: { purpose: '读取文件内容（含图片、PDF、Jupyter 笔记本）。', core: true },
  Write: { purpose: '新建文件，或整体覆盖已有文件。', core: true },
  Edit: { purpose: '对文件做精确的字符串替换（局部修改）。', core: true },
  MultiEdit: { purpose: '在同一个文件里一次做多处替换。' },
  NotebookEdit: { purpose: '编辑 Jupyter 笔记本（.ipynb）的单元格。', note: '不用 Jupyter 可以停用。' },
  NotebookRead: { purpose: '读取 Jupyter 笔记本的单元格与输出。' },
  LS: { purpose: '列出目录内容。' },

  // —— 搜索 ——
  Glob: { purpose: '按通配符模式查找文件路径（如 **/*.ts）。', core: true },
  Grep: { purpose: '基于 ripgrep 的内容搜索（支持正则）。', core: true },
  ToolSearch: { purpose: '按需加载「延迟工具」的完整定义；部分工具平时只列名字，要靠它才能调用。', note: '停用后延迟加载的工具都无法使用。' },
  LSP: { purpose: '通过语言服务器查定义、引用、诊断等代码信息。' },

  // —— 终端 ——
  Bash: { purpose: '执行 shell 命令（Windows 上是 Git Bash）。', core: true },
  PowerShell: { purpose: '执行 PowerShell 命令（Windows）。' },
  BashOutput: { purpose: '读取后台运行命令的输出。' },
  KillShell: { purpose: '结束后台运行的命令。' },
  Monitor: { purpose: '等待某个条件成立（轮询命令输出 / 文件等），不用手动 sleep。' },

  // —— 网络 ——
  WebFetch: { purpose: '抓取网页并按要求提取内容。', note: '停用后模型无法读取网页链接。' },
  WebSearch: { purpose: '联网搜索。', note: '停用后模型只能依靠自身知识。' },

  // —— 子智能体 / 协作 ——
  Task: { purpose: '启动子智能体处理独立的子任务（实际事件里叫 Agent）。', note: '停用后无法派发子任务，自定义智能体也用不了。' },
  Agent: { purpose: '启动子智能体处理独立的子任务。', note: '停用后无法派发子任务，自定义智能体也用不了。' },
  TaskStop: { purpose: '停止正在运行的后台子智能体 / 任务。' },
  TaskOutput: { purpose: '读取后台子智能体 / 任务的输出。' },
  SendMessage: { purpose: '给已启动的子智能体或其他会话发消息，继续之前的上下文。' },
  ListAgents: { purpose: '列出可以发消息的子智能体与本机其他会话。' },
  Skill: { purpose: '调用 skill（加载其说明后照做）。', note: '停用后所有 skill 都无法由模型调用。' },
  SlashCommand: { purpose: '由模型执行斜杠命令。' },

  // —— 计划 / 待办 ——
  TodoWrite: { purpose: '维护任务清单，跟踪多步骤工作的进度。' },
  TaskCreate: { purpose: '创建任务清单条目。' },
  TaskUpdate: { purpose: '更新任务清单条目的状态。' },
  TaskList: { purpose: '列出任务清单。' },
  TaskGet: { purpose: '读取某个任务清单条目。' },
  EnterPlanMode: { purpose: '进入计划模式（先出方案、不改文件）。' },
  ExitPlanMode: { purpose: '计划模式下提交方案，请求开始执行。' },
  AskUserQuestion: { purpose: '向你提出带选项的问题，等你选择后继续。' },

  // —— 定时 / 唤醒 ——
  CronCreate: { purpose: '创建定时任务（按 cron 表达式重复执行）。' },
  CronDelete: { purpose: '删除定时任务。' },
  CronList: { purpose: '列出已有的定时任务。' },
  ScheduleWakeup: { purpose: '/loop 自行安排下一次唤醒时间。', note: '只有 /loop 会用到。' },
  RemoteTrigger: { purpose: '触发云端运行的远程智能体。' },
  PushNotification: { purpose: '向你的设备发送推送通知。' },

  // —— 工作区 ——
  EnterWorktree: { purpose: '新建 git worktree 并切换进去，在隔离的副本里改代码。' },
  ExitWorktree: { purpose: '离开 git worktree，回到原工作目录。' },

  // —— 其他 ——
  ReportFindings: { purpose: '代码审查（/code-review）用来汇报发现的问题。', note: '只有代码审查会用到。' },
  DesignSync: { purpose: '设计稿与代码同步（design-sync）时使用。', note: '不做设计同步可以停用。' },
};

export const toolInfo = (name: string): ToolInfo | undefined => TOOL_CATALOG[name];
