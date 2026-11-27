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
  ToolSearch: { purpose: '按需加载「延迟工具」的完整定义（自身始终常驻、不会延迟加载）；部分工具平时只列名字，要靠它才能调用。', note: '停用后延迟加载的工具都无法使用。' },
  LSP: { purpose: '通过语言服务器获取代码智能信息（定义、引用、符号、悬停提示与诊断等）。' },

  // —— 终端 ——
  Bash: { purpose: '执行 shell 命令（Windows 上是 Git Bash）。', core: true },
  PowerShell: { purpose: '执行 PowerShell 命令（Windows）。' },
  BashOutput: { purpose: '读取后台运行命令的输出。' },
  KillShell: { purpose: '结束后台运行的命令（TaskStop 的旧名）。' },
  KillBash: { purpose: '结束后台运行的命令（TaskStop 的旧名）。' },
  Monitor: { purpose: '运行后台命令并将输出行、状态更新或文件变更事件持续回传到对话中，替代 sleep 轮询。' },

  // —— 网络 ——
  WebFetch: { purpose: '抓取网页并按要求提取内容。', note: '停用后模型无法读取网页链接。' },
  WebSearch: { purpose: '联网搜索。', note: '停用后模型只能依靠自身知识。' },

  // —— 子智能体 / 协作 ——
  Task: { purpose: '启动子智能体处理独立的子任务（实际事件里叫 Agent）。', note: '停用后无法派发子任务，自定义智能体也用不了。' },
  Agent: { purpose: '启动子智能体处理独立的子任务。', note: '停用后无法派发子任务，自定义智能体也用不了。' },
  TaskStop: { purpose: '按任务 ID 停止运行中的后台任务、后台命令、子智能体或协作同伴（替代 KillShell / KillBash）。' },
  TaskOutput: { purpose: '读取后台子智能体 / 任务的输出。' },
  SendMessage: { purpose: '给已有的子智能体或智能体团队成员发消息。' },
  ListAgents: { purpose: '列出可通过 SendMessage 通信的子智能体与协作同伴。' },
  ListPeers: { purpose: '列出可通过 SendMessage 通信的子智能体与协作同伴（ListAgents 的旧名）。' },
  SubagentHandback: { purpose: '供子智能体将最终结果交还给父会话。' },
  Workflow: { purpose: '在后台运行确定性的 JavaScript 工作流脚本，编排多个子智能体协作。', note: '仅在启用工作流功能时用到。' },
  mcp__cosyee__delegate: { purpose: 'Cosyee 自带：把任务交给委派智能体（按名字选 Explore / Plan / general-purpose 或自定义智能体）在同一目录里完成，默认后台、可并行，做完收到只带 result_id 的通知。', note: '需要本机装好可用的委派后端（目前是 agy）并已登录。停用后新启动的会话不再注册它（也不往系统提示词里加它的用法）；重新启用后要等会话进程重启才回来。' },
  mcp__cosyee__delegate_agents: { purpose: 'Cosyee 自带：列出可委派的智能体（名字与说明），可按关键词过滤；只读。', note: '依赖 delegate；平时不常驻，模型需要时经 ToolSearch 加载。' },
  mcp__cosyee__delegate_send: { purpose: 'Cosyee 自带：给已有的委派任务追加消息（steer 立即插话 / queue 排到当前这轮之后）；任务已结束时会在后台接着跑。', note: '依赖 delegate。停用后新启动的会话里模型不能再给委派任务追加消息。' },
  mcp__cosyee__delegate_stop: { purpose: 'Cosyee 自带：停止一个正在运行的委派任务。', note: '依赖 delegate。停用后模型不能自己停掉委派任务（你仍可在界面上点停止）。' },
  mcp__cosyee__delegate_status: { purpose: 'Cosyee 旧版工具：查询委派任务的状态和最近输出。新版改为任务结束时自动发完成通知，已不再注册。', note: '只出现在旧会话的统计里；停用与否对新会话没有影响。' },
  mcp__cosyee__delegate_result: { purpose: 'Cosyee 自带：凭完成通知里的 result_id 读取后台委派任务的完整结果。任务结束前没有 id，不能用来查进度。', note: '依赖 delegate。完成通知里只有 id、没有正文，停用后模型读不到后台任务的结果。' },
  Skill: { purpose: '调用 skill（加载其说明后照做）。', note: '停用后所有 skill 都无法由模型调用。' },
  SlashCommand: { purpose: '由模型执行斜杠命令。' },
  propose_skills: { purpose: '从重复出现的流程中提炼可复用的 skill 草案，供你审核。' },

  // —— MCP ——
  WaitForMcpServers: { purpose: '等待 MCP 服务器完成连接初始化。' },
  McpTaskCheck: { purpose: '查询后台 MCP 任务的当前状态（运行中、已完成或停止是否生效），不用于轮询等待。', note: '只有支持异步任务的第三方 MCP 服务器会用到；Cosyee 自带的委派（delegate）不使用它。' },
  ListMcpResourcesTool: { purpose: '列出已连接 MCP 服务器提供的资源列表。' },
  ReadMcpResourceTool: { purpose: '按 URI 读取 MCP 服务器上的指定资源内容。' },
  ReadMcpResourceDirTool: { purpose: '列出 MCP 目录资源下的子项。' },

  // —— 计划 / 待办 / 交互 ——
  TodoWrite: { purpose: '维护任务清单，跟踪多步骤工作的进度。' },
  TaskCreate: { purpose: '创建任务清单条目。' },
  TaskUpdate: { purpose: '更新任务清单条目的状态。' },
  TaskList: { purpose: '列出任务清单。' },
  TaskGet: { purpose: '读取某个任务清单条目。' },
  EnterPlanMode: { purpose: '由模型主动请求在动手改代码前切换到计划模式。', note: '在 Cosyee 里模型自己进入计划模式不会经过你确认，界面也不会同步显示为计划模式；建议停用，需要时手动切到计划模式。' },
  ExitPlanMode: { purpose: '提交计划方案请求你确认，并在批准后退出计划模式。', note: '手动计划模式靠它提交方案，不要停用。' },
  AskUserQuestion: { purpose: '向你提出带选项的问题，等你选择后继续。', note: '在 Cosyee 里问题会显示在输入框上方；停用后模型遇到歧义只能自行猜测而不会向你确认。' },
  SetGoal: { purpose: '在向你确认后设定当前会话的目标完成条件。' },
  SendUserMessage: { purpose: '向你发送可见消息（在 brief / channel 模式下作为主要输出渠道，旧名 Brief）。' },
  Brief: { purpose: '向你发送可见消息（SendUserMessage 的旧名，用于 brief / channel 模式）。' },
  SendUserFile: { purpose: '向你交付已完成的文件。' },
  EndConversation: { purpose: '在持续滥用或你明确要求结束时终止当前对话。' },

  // —— 定时 / 唤醒 / 通知 ——
  CronCreate: { purpose: '创建定时任务（按 cron 表达式周期或单次执行）。' },
  CronDelete: { purpose: '删除定时任务。' },
  CronList: { purpose: '列出已有的定时任务。' },
  ScheduleWakeup: { purpose: '/loop 自行安排下一次唤醒时间。', note: '只有 /loop 会用到。' },
  RemoteTrigger: { purpose: '管理 claude.ai 云端定时任务（routines）并查看运行日志。' },
  PushNotification: { purpose: '通过终端（以及可选的手机端）向你发送推送通知。' },
  ReadNotifications: { purpose: '读取来自 webhook 或触发器的排队外部通知。' },
  FetchInboxMessage: { purpose: '读取来自关联会话线程的收件箱转发消息。' },

  // —— 工作区 ——
  EnterWorktree: { purpose: '新建 git worktree 并切换进去，在隔离的副本里改代码。' },
  ExitWorktree: { purpose: '离开 git worktree，回到原工作目录。' },

  // —— claude.ai 云端 / Artifact / 设计 ——
  Projects: { purpose: '读写当前会话关联的 claude.ai 项目内容。' },
  SendToProject: { purpose: '把一条消息发到 claude.ai/code 的云端项目（Claude Project），可顺带新建项目。', note: '只在你运行 /send-to-project 时可用；Cosyee 无头模式下它自带的确认框可能被自动放行，建议停用。' },
  SendToProjectContext: { purpose: '读取 /send-to-project 收集到的本目录与目标项目信息，供 SendToProject 使用。', note: '只读，配合 SendToProject 使用；只在你运行 /send-to-project 时可用。' },
  Artifact: { purpose: '将 HTML 或 Markdown 文件渲染为可交互的 claude.ai Artifact 页面。' },
  ArtifactComments: { purpose: '管理 claude.ai Artifact 上的评论（查看、回复、标记已解决、关注或取消关注）。', note: '不用 claude.ai Artifact 协作可以停用。' },
  ArtifactData: { purpose: '读写 claude.ai Artifact 背后的数据库数据。', note: '不用 claude.ai Artifact 可以停用。' },
  ClaudeDesign: { purpose: '操作与管理 claude.ai/design 设计项目。', note: '不用 claude.ai/design 可以停用。' },
  DesignSync: { purpose: '将本地设计系统组件同步到 claude.ai/design 项目（供 /design-sync 使用）。', note: '不做设计同步可以停用。' },
  ListPlugins: { purpose: '列出你 claude.ai 账号上已启用的云端插件（不是本机 /plugin 安装的插件）。' },
  ListSkills: { purpose: '列出你 claude.ai 账号上已启用的云端 skill（可按主题筛选）。' },
  SearchSkills: { purpose: '按关键词搜索你或团队的 claude.ai 云端 skill。' },

  // —— 审查 / 引导 / 反馈 ——
  ReportFindings: { purpose: '将已核实的代码审查问题整理为结构化列表提交给宿主界面展示。', note: '只有代码审查（/code-review）会用到。' },
  SendFeedback: { purpose: '起草并提交产品或模型行为反馈报告。' },
  OfferChromeSetup: { purpose: '引导配置 Claude in Chrome 浏览器扩展。' },
  ShareOnboardingGuide: { purpose: '上传 ONBOARDING.md 并返回可分享的链接。' },
  ShowOnboardingRolePicker: { purpose: '显示 Cowork 入门引导的角色选择器。' },
};

export const toolInfo = (name: string): ToolInfo | undefined => TOOL_CATALOG[name];
