// 前后端约定。后端 server/ 与前端 web/ 都只通过这里的类型对接。
// 后端只监听 127.0.0.1:7878；前端开发时通过 Vite 代理访问 /api 与 /ws。
// 鉴权：每个请求带 token（REST 用请求头 `x-cosyee-token`，WS 用 `/ws?token=`），并校验 Origin。

// ───────────── 基础数据 ─────────────

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Workspace {
  /** 绝对路径，作为唯一 ID */
  path: string;
  /** 显示名（文件夹名） */
  name: string;
}

/** 会话列表的状态点：running=绿色（执行中），unread=蓝色（已完成未查看），null=不显示 */
export type SessionDot = 'running' | 'unread' | null;

/** 置顶来源：manual=用户手动置顶（一直保留到取消）；auto=执行中自动置顶（停止后空闲满 30 分钟自动回到工作空间列表） */
export type PinKind = 'manual' | 'auto';

export interface SessionSummary {
  id: string;
  cwd: string;
  title: string;
  /** 上次活动时间，毫秒时间戳 */
  lastActiveAt: number;
  dot: SessionDot;
  /** 置顶状态；null=未置顶 */
  pinned: PinKind | null;
  /** 并行模式下这个会话使用的账号 id（绑定的账号，没绑定时为当前账号）；切换模式下为 null / 不存在 */
  account?: string | null;
  /** 这个会话最近一次使用的配置（发送 / 切换模型时由服务端记下）；没有记录的旧会话不带 */
  config?: SessionConfig;
  /** 没有 config 记录时，从会话记录里最后一条 assistant 消息推断出的模型（原始 id，如 claude-sonnet-5-5-20260101；前端用 canonicalModel 归一） */
  lastModel?: string;
}

/** 「已删除」列表里的一项（软删除：只是从列表隐藏，会话记录文件原样保留） */
export interface DeletedSession {
  id: string;
  cwd: string;
  /** 删除时的标题快照 */
  title: string;
  /** 删除时间，毫秒时间戳 */
  deletedAt: number;
}

export interface Account {
  name: string;
  /** 例如 'Pro' / 'Max'；未知为 null */
  plan: string | null;
}

/** 账号切换列表里的一项。不含邮箱、uuid 等身份信息。 */
export interface AccountEntry {
  /** 'default' = 默认账号（基础配置目录） */
  id: string;
  /** 用户起的备注名；默认账号为空 */
  label: string;
  /** 显示名（来自登录信息）；未登录 / 读不到为 null */
  name: string | null;
  plan: string | null;
  /** 本地有登录凭据（不保证凭据仍有效） */
  loggedIn: boolean;
  active: boolean;
  isDefault: boolean;
}

/** 多账号模式：switch = 同一时间只有一个账号生效（切换时停止所有会话）；parallel = 每个会话绑定自己的账号，多个账号同时生效 */
export type AccountMode = 'switch' | 'parallel';

export interface AccountList {
  mode: AccountMode;
  list: AccountEntry[];
  /** 当前正在进行的登录（添加 / 重新登录账号），没有为 null */
  login: AccountLogin | null;
}

/** 添加 / 重新登录账号的进度 */
export interface AccountLogin {
  loginId: string;
  status: 'starting' | 'waiting' | 'done' | 'failed';
  /** 浏览器没自动打开时手动打开的登录页 */
  url: string | null;
  /** 完成后对应的账号 id */
  accountId: string | null;
  error: string | null;
}

export interface PickedItem {
  path: string;
  kind: 'file' | 'folder';
  /** 预览令牌：只有经选择窗口选出的路径才能被预览 */
  previewToken: string;
  /** 根据扩展名判断是否为图片 */
  isImage: boolean;
}

export interface PreviewInfo {
  path: string;
  kind: 'file' | 'folder';
  size: number | null;
  /** 毫秒时间戳 */
  mtime: number | null;
  isImage: boolean;
  /** 文件夹的直接子项数量；文件为 null */
  childCount?: number | null;
}

/**
 * 上下文面板数据。后端由 control_request get_context_usage 的响应换算（见 spike/FINDINGS2.md B1 §4）：
 * usedTokens=totalTokens，totalTokens=maxTokens（有效窗口），percent=percentage，
 * categories=kind 为 used/buffer/free 的类别，deferred=kind 为 deferred 的类别，
 * untilAutocompact=autoCompactThreshold-totalTokens（未开启自动压缩为 null）。
 */
/** 上下文大小分桶：[from, to)，to 为 null 表示不封顶 */
export interface TokenBucket {
  from: number;
  to: number | null;
}

/** 按「这次请求送给模型的上下文大小」分桶的请求统计（只含主线程） */
export interface ContextBucketStats extends TokenBucket {
  /** 请求数（一条 assistant 消息 = 一次请求） */
  requests: number;
  /** 这些请求发起的工具调用数 / 其中返回 is_error 的（含权限拒绝、用户拒绝） */
  toolCalls: number;
  toolErrors: number;
  /** 紧跟在这些请求之后的用户中断（[Request interrupted by user]） */
  interrupts: number;
  /** 输入 token 合计（未缓存 + 写缓存 + 读缓存），算平均每次请求的上下文 */
  inputTokens: number;
}

/** 按「压缩时的上下文大小（preTokens）」分桶的压缩统计；各字段为合计，比率由前端算 */
export interface CompactBucketStats extends TokenBucket {
  count: number;
  auto: number;
  /** postTokens 合计（有值的条数见 postCount） */
  post: number;
  postCount: number;
  /** 压缩前 / 后各 N 次请求（见 CompactStats.window）的工具调用与出错、中断 */
  callsBefore: number;
  errorsBefore: number;
  callsAfter: number;
  errorsAfter: number;
  interruptsAfter: number;
  /** 压缩后窗口内实际有的请求数（会话可能很快结束） */
  requestsAfter: number;
  /** 压缩后窗口内 Read 过的文件数（去重） / 其中压缩前（自上次压缩起）已经 Read 过的 */
  readsAfter: number;
  rereads: number;
  /** 到下一次压缩之间的请求数合计 / 有下一次压缩的条数 */
  gap: number;
  gapCount: number;
}

/** 跨会话的压缩效果统计（GET /api/compact/stats）：扫描全部主会话记录，观察性数据，不是对照实验 */
export interface CompactStats {
  byContext: ContextBucketStats[];
  byCompact: CompactBucketStats[];
  /** 压缩前后各取多少次请求做比较 */
  window: number;
  sessions: number;
  requests: number;
  at: number;
}

/** 跨会话的工具累计调用次数（GET /api/tools/stats）：扫描全部会话记录，含子智能体；已删除的会话不计 */
export interface ToolStats {
  /** 工具名 -> 调用次数（含 mcp__ 工具；子智能体派发按 CLI 记录的名字，新版为 Agent、旧版为 Task） */
  counts: Record<string, number>;
  /**
   * skill 名 -> 调用次数：模型调用 Skill 工具（按 input.skill，可能带或不带插件前缀）与用户输入 /名字。
   * 用户输入的斜杠命令里也有内置命令（clear 等），这里不区分；旧服务端没有这个字段
   */
  skills?: Record<string, number>;
  /** 统计到的会话数（主会话记录文件数） */
  sessions: number;
  at: number;
}

export interface ContextUsage {
  usedTokens: number;
  totalTokens: number;
  /** 0–100 */
  percent: number;
  /** name 保持 CLI 的英文原名（System tools、Messages、MCP tools、System prompt、Skills、MCP server instructions、Custom agents、Autocompact buffer、Free space），前端按名字配色；percent 为 0–100 */
  categories: { name: string; tokens: number; percent: number | null; color?: string }[];
  deferred: { name: string; tokens: number }[];
  mcpTools: { name: string; server: string; tokens: number }[];
  agents: { name: string; tokens: number }[];
  /** 全部 skill（含已关闭 / 仅手动的），顺序同 CLI；数据来自 init.skills、get_context_usage 与 get_settings */
  skills: ContextSkill[];
  /** MCP 服务器（来自 mcp_status），工具 token 来自 get_context_usage.mcpTools */
  mcpServers: ContextMcpServer[];
  /** Cosyee 保存的「已停用的内置工具」名单（全局）；前端据此显示开关。停用后的工具不再出现在 init.tools 里，所以要单独带上 */
  disabledTools?: string[];
  /**
   * Cosyee 保存的「已关闭的智能体」名单（全局，智能体名如 Explore、my-reviewer）。经 permissions.deny 的 Agent(名字) 下发：
   * 模型看不到 / 派发不了这些智能体；关闭后它们可能不再出现在 init.agents 与 agents 里，前端据此保留在列表上
   */
  disabledAgents?: string[];
  /**
   * 内置工具名（最近一次 system/init 的 tools，不含 mcp__ 工具）。探测进程不发消息、收不到 init，
   * 页面重开也会错过 init，所以服务端记下来随上下文下发：本会话的优先，否则用最近一次见到的（落盘）
   */
  tools?: string[];
  /**
   * 单个内置工具定义的 token 占用（get_context_usage 的 systemTools / deferredBuiltinTools）。
   * 目前的 CLI 版本这两项恒为空，只给「System tools」「System tools (deferred)」两个合计；CLI 以后给了才会有。
   * deferred = 延迟加载：平时只列名字，ToolSearch 加载后才把完整定义放进上下文。
   */
  toolTokens?: { name: string; tokens: number; deferred?: true }[];
  /** 距自动压缩还剩多少 token */
  untilAutocompact: number | null;
  /** 自动压缩的触发点（CLI 报告的 autoCompactThreshold，约等于 窗口 - 33k）；未开启自动压缩时没有 */
  autoCompactThreshold?: number;
  /** Cosyee 设置的自动压缩窗口（全局，CLAUDE_CODE_AUTO_COMPACT_WINDOW）；null = 不覆盖，沿用用户设置 / CLI 默认 */
  compactWindow?: number | null;
  /** 采集时间 */
  at: number;
}

/**
 * skill 的三种状态，取值与 CLI 设置 skillOverrides 相同：
 * on=模型能看到并自动调用；user-invocable-only=模型看不到，只能手动 /名字 调用；off=模型和 / 菜单都看不到。
 * （CLI 还有 name-only，Cosyee 不提供，读到时按 on 显示）
 */
export type SkillMode = 'on' | 'user-invocable-only' | 'off';
export const SKILL_MODES: readonly SkillMode[] = ['on', 'user-invocable-only', 'off'];

export interface ContextSkill {
  /** CLI 里的名字（插件 skill 带前缀，如 anthropic-skills:pdf），也是设置状态时用的键 */
  name: string;
  mode: SkillMode;
  /** 名字与描述占用的 token；模型看不到（仅手动 / 已关闭）时为 null */
  tokens: number | null;
  /** 来源：userSettings / projectSettings / plugin 等；未知为 null */
  source: string | null;
  /** 磁盘上是用户级 / 项目级 skill，可以移除（插件、内置的不行）；读不到磁盘信息时不带 */
  removable?: boolean;
}

/** 磁盘上的 SKILL.md（GET /api/skills/content） */
export interface SkillContent {
  name: string;
  /** frontmatter 的 description */
  description?: string;
  /** 去掉 frontmatter 的正文（参数占位符 $ARGUMENTS 未替换） */
  body: string;
  /** 技能目录 */
  dir: string;
}

/** MCP 服务器：status 取 mcp_status 的 connected / pending / failed / needs-auth / disabled；读不到 mcp_status 时为 unknown */
export interface ContextMcpServer {
  /** mcp_status 里的原名（mcp_toggle 用它） */
  name: string;
  status: string;
  /** 各工具 token 合计 */
  tokens: number;
  tools: { name: string; tokens: number | null }[];
}

/** 每个会话可调的启动参数，改动后下一轮生效 */
export interface SessionConfig {
  model: string;
  effort: Effort;
  ultracode?: boolean;
}

export type UsageSeverity = 'normal' | 'warning' | 'critical';

/** 订阅额度的一项限制（来自 CLI control_request get_usage 的 rate_limits.limits） */
export interface UsageLimit {
  /** session=当前 5 小时会话窗口；weekly=每周总额；scoped=某个模型单独的每周额度 */
  kind: 'session' | 'weekly' | 'scoped';
  /** 0–100 */
  percent: number;
  severity: UsageSeverity;
  /** 重置时间，毫秒时间戳 */
  resetsAt: number | null;
  /** scoped：模型显示名，如 Fable */
  model?: string;
  /** scoped：最多可使用每周限额的百分比 */
  allowance?: number | null;
  /** weekly：其中各模型专属额度用掉的部分（占每周限额的百分比） */
  shares?: { model: string; percent: number }[];
}

export interface UsageInfo {
  limits: UsageLimit[];
  /** 采集时间 */
  at: number;
}

// ───────────── REST ─────────────
// 所有接口 JSON 进出；出错时返回 { error: string } 与非 2xx 状态码。
//
// GET  /api/bootstrap                       → Bootstrap
// GET  /api/workspaces                      → { current: string | null; list: Workspace[] }
// POST /api/workspaces/pick                 → { workspace: Workspace | null }   调起系统的文件夹选择窗口并加入列表
// POST /api/workspaces/current  {path}      → { ok: true }
// POST /api/workspaces/top      {path}      → { current: string | null; list: Workspace[] }   移到列表最前
// POST /api/workspaces/remove   {path}      → { current: string | null; list: Workspace[] }   仅从最近列表移除，不动磁盘；移除当前工作空间时 current 切到下一个（或 null）
// POST /api/workspaces/reveal   {path}      → { ok: true }   在系统文件管理器里打开；path 必须在工作空间列表里
// GET  /api/sessions?cwd=                   → SessionSummary[]   按 lastActiveAt 倒序
// GET  /api/sessions/:id/history?cwd=&since= → { version: string; entries?: unknown[]; unchanged?: true }
//                                             主会话 jsonl 过滤后的条目；since 等于当前 version 时不返回 entries，只回 unchanged
// GET  /api/sessions/:id/subagent/:toolUseId?cwd= → { entries: unknown[] }  子代理 jsonl 原始条目
// POST /api/sessions/:id/rename {cwd,title} → { ok: true }
// POST /api/sessions/:id/viewed {cwd}       → { ok: true }   清除蓝点
// GET  /api/pins                            → SessionSummary[]   所有工作空间的置顶会话（手动置顶在前，按置顶时间倒序；其后是自动置顶）
// POST /api/sessions/:id/pin    {cwd}       → { ok: true }   手动置顶
// POST /api/sessions/:id/unpin  {cwd}       → { ok: true }   取消置顶（自动置顶的会话取消后隐藏，直到下次开始执行）
// GET  /api/deleted                         → DeletedSession[]   已删除（软删除）的会话，按删除时间倒序
// POST /api/sessions/:id/delete {cwd}       → { ok: true }   软删除：移入已删除列表，不碰会话记录文件；执行中的会话返回 409
// POST /api/sessions/:id/restore                → { ok: true }   从已删除列表恢复
// POST /api/sessions/:id/purge                  → { ok: true }   永久删除：删除记录文件 <id>.jsonl 与同名目录；只允许已在已删除列表里的会话
// POST /api/sessions/delete-many {cwd, ids}  → { deleted: number; skipped: number }   批量软删除（工作空间分组的「删除全部会话」）：
//                                             只处理该工作空间里存在且未删除的 id；执行中的跳过（计入 skipped）
// POST /api/deleted/restore {ids}           → { restored: number }   批量恢复；不在已删除列表里的 id 忽略
// POST /api/deleted/purge   {ids}           → { purged: number; failed: number; error: string | null }   批量永久删除；
//                                             每个 id 走单个 purge 的全部校验，单个失败不影响其它，error 为第一个失败的原因
// GET  /api/git?cwd=                        → { branch: string | null }
// GET  /api/account                         → Account | null   当前账号（并行模式下 = 新会话使用的账号）
// GET  /api/accounts                        → AccountList   账号列表（默认账号 + 添加的账号）与进行中的登录
// POST /api/accounts/switch {id, force?}    → { ok: true }   切换账号；有执行中的会话且没带 force 时返回 409 { error, running }。
//                                             切换模式：成功后停止所有会话进程并广播 account.changed {reload: true}；
//                                             并行模式：只改「新会话使用的账号」，不停止任何会话，广播 account.changed {reload: false}
// POST /api/accounts/mode {mode, force?}    → { ok: true }   切换多账号模式。并行 → 切换时，其它账号还有执行中的会话且没带 force 返回 409 { error, running }；
//                                             成功后停掉其它账号的进程并广播 account.changed {reload: true}
// POST /api/accounts/login {label?, accountId?} → AccountLogin   添加账号（或给已有账号重新登录）：后台运行 claude auth login，
//                                             自动打开浏览器；同一时间只允许一个
// GET  /api/accounts/login/:loginId         → AccountLogin
// POST /api/accounts/login/:loginId/code {code} → { ok: true }   浏览器回调失败时，把页面上的授权码交给 CLI
// POST /api/accounts/login/:loginId/cancel  → { ok: true }
// POST /api/accounts/remove {id}            → { ok: true }   移除添加的账号（删除其配置目录里的私有内容，共享内容只解除链接）；
//                                             默认账号与当前账号不能移除；并行模式下还有执行中会话的账号不能移除
// POST /api/accounts/label {id, label}      → { ok: true }   修改备注名
// POST /api/pick {mode?: 'mixed'|'files'|'folders'} → { items: PickedItem[]; supportsMixed: boolean }   系统对话框，仅本机连接
// GET  /api/browse?path=                    → BrowseDir   网页版选择窗口（远程连接）：列出服务端目录
// POST /api/pick/paths {paths: string[]}    → { items: PickedItem[]; supportsMixed: true }   登记网页里选好的路径
// POST /api/workspaces/open {path}          → { workspace }   网页里选好的工作空间文件夹
// GET  /api/preview/:token/info             → PreviewInfo
// GET  /api/preview/:token/raw              → 文件原始内容（仅图片）
// POST /api/defaults {model,effort}         → { ok: true }   记住模型与思考强度（全局，下次启动沿用）
// GET  /api/usage?refresh=1&session=&account= → UsageInfo | null   订阅额度（refresh=1 跳过缓存）；带 session 时取该会话所用账号的额度（并行模式），
//                                             否则取当前账号的；带 account=<账号 id> 时取指定账号的（各账号各自缓存，账号菜单逐个账号显示额度用），优先于 session；账号不存在 404
// POST /api/skills {name, mode}             → { ok: true }   设置一个 skill 的状态（全局，存 ~/.cosyee/state.json，不改 ~/.claude 配置）；
//                                             立即下发给所有运行中的会话，订阅者随后收到新的 context
// POST /api/skills {modes: {名字: mode}}    → { ok: true }   批量设置（「一键推荐配置」与撤销用），只落盘 / 下发 / 采集一次
// POST /api/skills/remove {name, session?, cwd?} → { ok: true, backup }   移除用户级 / 项目级 skill：目录移到 ~/.cosyee/removed-skills（可手动放回恢复）；
//                                             插件 / 内置 skill 不能移除（400），请改用「关」
// GET  /api/skills/content?name=&cwd=       → SkillContent   读磁盘上的 SKILL.md（技能面板展开时兜底：实时的 /技能 输入拿不到注入正文）；
//                                             项目级优先于用户级，插件 skill 按 plugin:name 找；找不到 404
// POST /api/context/:id/mcp {cwd?, server, enabled} → ContextUsage | null   开关 MCP 服务器（CLI 的 mcp_toggle，
//                                             与终端 /mcp 里的启用 / 禁用相同：按项目写进 ~/.claude.json）
// GET  /api/context/:id                     → ContextUsage | null   最近一次采集的上下文数据
// POST /api/context/:id/refresh             → ContextUsage | null   立即重新采集

export interface Bootstrap {
  version: string;
  platform: 'win32' | 'darwin' | string;
  homeDir: string;
  supportsMixedPick: boolean;
  defaults: SessionConfig;
  /**
   * 这次连接不是来自服务端本机（经 Tailscale 等远程访问）。此时不显示「在文件管理器中显示」「打开终端」
   * 「打开工作空间文件夹」——这些窗口会弹在服务端机器的桌面上，远程设备看不到；「添加文件」「打开文件夹」
   * 改用网页版选择窗口（/api/browse），在远端浏览服务端的文件。
   */
  remote: boolean;
}

// ───────────── WebSocket ─────────────

export type ClientMsg =
  /** 订阅会话事件（打开会话时发送；可同时订阅多个） */
  | { t: 'subscribe'; sessionId: string }
  | { t: 'unsubscribe'; sessionId: string }
  /**
   * 发送一条用户消息。
   * isNew=true：前端生成 UUID 作为 sessionId，后端用 --session-id 启动；
   * 否则后端若没有该会话的进程，用 --resume 启动。
   * text 中的标签已被替换为 @"<绝对路径>"。
   */
  | {
      t: 'send';
      sessionId: string;
      cwd: string;
      isNew: boolean;
      text: string;
      config: SessionConfig;
      /** 前端生成的 UUID，作为 CLI user 消息的 uuid（lifecycle / echo / transcript 的关联键，也是 rewind 的目标 id） */
      id: string;
      /**
       * 只在执行中发送时有意义（空闲时一律立即开始新的一轮）：
       * next=steering，并入当前这一轮（等当前工具返回后插入）；later=follow-up，这一轮结束后另开一轮。缺省 next。
       */
      mode?: QueueMode;
    }
  | { t: 'interrupt'; sessionId: string }
  /** 撤回一条还没开始执行的排队消息（CLI cancel_async_message）。结果用 queue.cancelled 回复 */
  | { t: 'queue.cancel'; sessionId: string; id: string }
  /** 立即发送一条排队消息：中断当前这一轮并马上执行它（CLI interrupt {send_now:true, message_uuid}） */
  | { t: 'queue.sendNow'; sessionId: string; id: string }
  /**
   * 回退到某条用户消息（CLI rewind_conversation，执行中时带 interrupt_if_running）：它及之后的对话从上下文中移除，
   * 原文通过 rewind.result 的 prefillText 填回输入框。没有该会话的进程时后端用 --resume 启动一个再回退。
   * reqId 由前端生成，用于对应 rewind.result。
   */
  | { t: 'rewind'; sessionId: string; cwd: string; config: SessionConfig; targetId: string; reqId: string }
  /** 修改模型、强度等，下一轮生效 */
  | { t: 'config'; sessionId: string; config: SessionConfig };

/**
 * idle：进程在，等待输入；running：一轮进行中（含 result 之后仍有后台子代理在跑、CLI 自动续轮的阶段）；
 * exited：进程已退出（正常或异常，异常时带 error）。
 */
export type RunStatus = 'idle' | 'starting' | 'running' | 'exited';

export interface AppliedSettings {
  model?: string;
  effort?: Effort;
  ultracode?: boolean;
  ultracodeAvailable?: boolean;
}

/**
 * 后端合成的事件，和 CLI 事件一起通过 { t:'event' } 下发（CLI 不回显用户消息）：
 * - cosyee_user：后端把一条用户消息写进 stdin 时发出，前端据此开始新的一轮。
 */
export interface CosyeeUserEvent {
  type: 'cosyee_user';
  /** 发给 CLI 的原文（标签已是 @"路径"） */
  text: string;
  /** 毫秒时间戳 */
  at: number;
  /** 消息 uuid（= ClientMsg send 的 id）。旧缓存事件可能没有 */
  id?: string;
  /**
   * start=空闲时发送，写入 stdin 时立即发出；
   * next=steering，CLI 把它并入当前这一轮时（echo 到达）发出，前端结束当前轮、从这里起新的一轮显示；
   * later=follow-up，CLI 开始执行它时（echo 到达）发出。
   */
  mode?: 'start' | QueueMode;
}

/** 执行中发送的两种排队方式 */
export type QueueMode = 'next' | 'later';

/** 已发给 CLI、还没开始执行的消息（lifecycle 处于 queued） */
export interface QueueItem {
  id: string;
  text: string;
  mode: QueueMode;
  /** 入队时间，毫秒时间戳 */
  at: number;
}

export type ServerMsg =
  /** CLI stdout 的一行 JSON，原样转发（包括 stream_event、system、assistant、user、result 等） */
  | { t: 'event'; sessionId: string; e: unknown }
  /**
   * 订阅时补发：如果该会话当前这一轮还没结束，后端把这一轮从 cosyee_user 开始缓存的全部事件一次性发来。
   * 前端加载历史时，若 replay 非空，就丢掉历史里最后一条真实用户消息及其之后的条目，再按顺序应用 replay，避免重复。
   */
  | { t: 'replay'; sessionId: string; events: unknown[]; status: RunStatus }
  | { t: 'status'; sessionId: string; status: RunStatus; error?: string }
  /** 排队消息列表（完整快照）。变化时广播；订阅时紧跟 replay 发一次（没有排队也发空数组） */
  | { t: 'queue'; sessionId: string; items: QueueItem[] }
  /** queue.cancel 的结果。ok=true 时 text 为被撤回消息的原文，前端填回输入框；ok=false 表示已开始执行或不存在 */
  | { t: 'queue.cancelled'; sessionId: string; id: string; ok: boolean; text?: string }
  /** rewind 的结果。ok=true 时 prefillText 为被回退消息的原文；失败时 error 为原因 */
  | { t: 'rewind.result'; sessionId: string; reqId: string; targetId: string; ok: boolean; prefillText?: string; error?: string }
  /** 会话列表需要刷新（新会话、状态点变化、改名） */
  | { t: 'sessions.changed'; cwd: string }
  /** 置顶 / 已删除集合变化（手动置顶、删除、恢复、自动置顶到期）：前端重取置顶、已删除与当前工作空间的会话列表 */
  | { t: 'sidebar.changed' }
  /** 当前账号变了：前端整页重新加载，避免残留上一个账号的任何数据 */
  /** 账号变了。reload = true：前端整页刷新（切换模式下切换账号）；false：只重取账号列表 / 会话列表 / 额度（并行模式） */
  | { t: 'account.changed'; reload: boolean }
  | { t: 'context'; sessionId: string; usage: ContextUsage }
  /** 会话实际生效的设置（来自 control_request get_settings 的 applied）。ultracodeAvailable 为 true 时前端才显示 Ultracode 开关 */
  | { t: 'settings'; sessionId: string; applied: AppliedSettings }
  | { t: 'error'; message: string };
