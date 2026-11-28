// 前后端约定。后端 server/ 与前端 web/ 都只通过这里的类型对接。
// 后端只监听 127.0.0.1:7878；前端开发时通过 Vite 代理访问 /api 与 /ws。
// 鉴权：每个请求带 token（REST 用请求头 `x-cosyee-token`，WS 用 `/ws?token=`），并校验 Origin。
import type { CostParts } from './pricing.ts';
import type { CachePoint } from './view.ts';

// ───────────── 基础数据 ─────────────

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 委派后端（Antigravity / Codex）的思考强度，按强弱排序；Claude 原生仍只用 Effort */
export type DelegateEffort = Effort | 'none' | 'minimal' | 'ultra';
export const DELEGATE_EFFORTS: readonly DelegateEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

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

/**
 * 会话悬浮卡片的详情：悬停时才读（不随列表下发），由会话记录统计得出。
 * 只统计主线程、当前链（rewind 废弃的分支不算）；文本都已压成单行并截断。读不到的项为 null，不编造。
 */
export interface SessionDetail {
  /** 第一条带时间戳的消息时间，毫秒 */
  createdAt: number | null;
  /** 最后一条带时间戳的消息时间，毫秒 */
  lastMessageAt: number | null;
  /** 用户真实发送的消息条数（不含工具结果、系统注入） */
  userMessages: number;
  /** 工具调用次数 */
  toolCalls: number;
  /** 用户的第一条 / 最后一条消息；只有一条时 lastPrompt 为 null */
  firstPrompt: string | null;
  lastPrompt: string | null;
  /** 助手最后一段文字回复 */
  lastReply: string | null;
  /** 最后一条 assistant 消息的模型（原始 id） */
  model: string | null;
  /** 记录里最后一次出现的 git 分支（detached HEAD 时为 null） */
  branch: string | null;
  /** 最近一次请求的上下文占用（输入 + 缓存读写），token */
  contextTokens: number | null;
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
  /** 订阅开始时间，毫秒（来自登录信息）。官方不提供到期日，前端据此按月推算并标明是推算；读不到为 null / 不带 */
  subscribedAt?: number | null;
  /** 登录凭据的失效时间，毫秒（到时需要重新登录）；读不到为 null / 不带 */
  loginExpiresAt?: number | null;
  /** API 账号（API Key + 可选的自定义 Base URL）才有；claude.ai 登录的账号没有 */
  api?: AccountApiInfo;
  /** Kiro 账号（本机 kiro.rs 代理）才有；这类账号不下发 api */
  kiro?: AccountKiroInfo;
}

/** API 账号的认证方式：apiKey = ANTHROPIC_API_KEY（x-api-key 头）；authToken = ANTHROPIC_AUTH_TOKEN（Authorization: Bearer） */
export type ApiAuthType = 'apiKey' | 'authToken';

/** API 账号的配置（不含密钥本身） */
export interface AccountApiInfo {
  /** 空字符串 = 官方地址 */
  baseUrl: string;
  authType: ApiAuthType;
  /** 密钥末 4 位，用于辨认；密钥太短时为空 */
  keyHint: string;
  /** 模型映射；没配置时不存在（= 不介入，别名原样发给服务商） */
  models?: ApiModelMap;
}

/** 可重映射的模型别名：CLI 用 ANTHROPIC_DEFAULT_<别名>_MODEL 把它换成实际请求的模型 */
export const MODEL_ALIASES = ['sonnet', 'opus', 'fable', 'haiku'] as const;
export type ModelAlias = (typeof MODEL_ALIASES)[number];

/** 映射表里的一项：别名或自定义条目指向的实际模型 */
export interface ApiModelTarget {
  /** 实际发给服务商的模型 id */
  id: string;
  /** 菜单里显示的名字；空 = 用 id */
  label?: string;
  /** 声明该模型支持 100 万 token 上下文 */
  m1?: boolean;
}

/**
 * API 账号的模型映射。四个别名走 CLI 原生的别名重映射（环境变量），
 * extra 里的条目直接作为 --model 的值发出去。整个对象缺省 = 不介入。
 */
export interface ApiModelMap {
  /** 别名 → 实际模型；某个别名没配 = 该别名不重映射，也不进菜单 */
  alias?: Partial<Record<ModelAlias, ApiModelTarget>>;
  /** 子代理用的模型（不进菜单） */
  subagent?: string;
  /** 兜底：映射表以外的模型名落到这里 */
  fallback?: string;
  /** 自由添加的条目，进菜单的「自定义模型」子菜单 */
  extra?: ApiModelTarget[];
}

/** 服务端探测到的模型列表（供映射表的下拉用） */
export interface ApiModelListing {
  /** 实际请求成功的端点 */
  url: string;
  /** 模型 id；按服务商返回的顺序 */
  models: string[];
}

/**
 * CLI 报告的可用模型（initialize 控制请求的 models，按账号拉取）。模型菜单以它为准，拉不到时退回内置表。
 * 订阅账号：别名 + 若干全名；API 账号：只有别名（映射过的别名 displayName 已是映射名）。
 */
export interface CliModel {
  /** 传给 --model / set_model 的值 */
  value: string;
  /** 实际模型（别名解析后；映射过的别名是映射值，可能带 [1m]） */
  resolvedModel?: string;
  displayName: string;
  description?: string;
  /** 支持的思考强度；不存在 = 不支持强度 */
  efforts?: Effort[];
}

export interface CliModelList {
  models: CliModel[];
  /** 拉取时间（ms） */
  at: number;
}

/**
 * 子代理模式（全局）：
 * - native：Claude 自带的 Agent 工具（在主进程里运行，跟随主会话账号）；停用 cosyee 的 delegate 系列工具。
 * - delegate：自定义委派工具（delegate 系列）；停用 Agent 工具。每个代理类型按自己的路线（SubagentRoute）
 *   选后端、账号与模型，例如 Explore 走 Antigravity 的 Gemini、Plan 走某个 Claude 账号的 Opus。
 * 默认路线不可用（后端未安装 / 账号未登录 / 没选）时服务端退回原生，免得两头都没有。
 */
export type SubagentMode = 'native' | 'delegate';
export const SUBAGENT_MODES: readonly SubagentMode[] = ['native', 'delegate'];

/** 委派后端：claude = Claude CLI（无头 claude -p）；agy = Antigravity（agy acp）；codex = OpenAI Codex（codex app-server） */
export type DelegateBackendId = 'claude' | 'agy' | 'codex';
export const DELEGATE_BACKEND_IDS: readonly DelegateBackendId[] = ['claude', 'agy', 'codex'];

/**
 * 委派路线：某个代理类型由哪个后端的哪个账号、用什么模型执行。
 * - claude：accountId 是 AccountEntry.id（claude.ai 登录 / API / Kiro 都行）；model 是别名或模型 id，null = 跟随主会话当前的模型；
 *   effort null = 跟随主会话（仅允许 Effort）。
 * - agy：accountId 是 AgyAccountEntry.id；model 是基础模型（DelegateModel.value），null = 用 agy 自己的默认；effort null = 默认。
 * - codex：accountId 是 CodexAccountEntry.id；model 是模型 id，null = 用该账号的默认模型；effort null = 默认（支持 DelegateEffort）。
 * 生效优先级：类型自己的路线 > 智能体定义里的 model / effort > 默认路线。
 */
export interface SubagentRoute {
  backend: DelegateBackendId;
  accountId: string;
  model: string | null;
  effort: DelegateEffort | null;
}

/**
 * 子代理配置（全局，上下文栏「子代理」里设置）。
 * GET /api/subagents 取 SubagentState；POST /api/subagents 整体提交 SubagentConfig，返回 { ok, state: SubagentState }。
 * 改动对运行中的会话立即生效（工具开关经 permissions.deny 推送；新启动的会话按启动时的配置注册）。
 */
export interface SubagentConfig {
  mode: SubagentMode;
  /**
   * 原生子代理（Agent 工具）：服务端用 PreToolUse hook 给没写 model / effort 的调用补上这里的值，
   * 因此优先于智能体定义里的 model / effort（CLI 里调用参数 > 定义 > 环境变量）；调用时点名的值不动。
   * model 只能是别名：Agent 工具的 model 参数是枚举。
   */
  native: { model: ModelAlias; effort: Effort; agents?: SubagentTypeOverrides<ModelAlias> };
  /** 委派：default = 默认路线（null = 还没选）；agents = 代理类型名 → 自己的路线，不含某类型 = 跟随默认 */
  delegate: { default: SubagentRoute | null; agents?: Record<string, SubagentRoute> };
}

/**
 * 某个代理类型（智能体，如 Explore / Plan / general-purpose / 自定义）在原生模式下的单独配置。
 * null = 不单独设置。生效优先级：调用时点名的值 > 这里的值 > 智能体定义里的 model / effort > 原生默认值。
 */
export interface SubagentTypeOverride<M extends string = string, E extends string = Effort> {
  model: M | null;
  effort: E | null;
}

/** 代理类型名 → 单独配置；缺省 / 不含某类型 = 该类型全部跟随默认 */
export type SubagentTypeOverrides<M extends string = string, E extends string = Effort> = Record<string, SubagentTypeOverride<M, E>>;

/**
 * 可配置的代理类型（GET /api/subagents 的 SubagentState.agents）：委派后端可用的智能体
 * （内置 Explore / Plan / general-purpose + 项目 / 用户 / 插件里的自定义智能体）。
 * 原生模式下 CLI 还会报告它自带的其它类型（SessionMeta.agents），前端合并显示。
 * 开关沿用全局的已关闭名单（POST /api/agents，SubagentState.disabledAgents），两种模式同时生效。
 */
export interface SubagentTypeInfo {
  name: string;
  description: string;
  source: 'builtin' | 'projectSettings' | 'userSettings' | 'plugin';
  /** 只读类型（Explore / Plan）：委派后端里强制不能改文件 */
  readOnly?: boolean;
  /** 智能体定义里写的模型 / 强度（frontmatter），没写不给 */
  model?: string;
  effort?: Effort;
}

export const DEFAULT_SUBAGENTS: SubagentConfig = {
  mode: 'native',
  native: { model: 'sonnet', effort: 'medium' },
  delegate: { default: null },
};

/** 某种子代理在本机能不能用；reason = 不能用的原因（给界面显示，如「未安装 Antigravity CLI」） */
export interface SubagentAvailability {
  ok: boolean;
  reason?: string;
}

/** 委派路线可选的账号（只列现在能用的：后端已安装、账号已登录） */
export interface SubagentAccountOption {
  backend: DelegateBackendId;
  /** AccountEntry.id、AgyAccountEntry.id 或 CodexAccountEntry.id */
  id: string;
  /** 显示名（备注名 > 登录名） */
  label: string;
  /** 分组：Claude 订阅 / API / Kiro / Antigravity / Codex */
  group: 'claude' | 'api' | 'kiro' | 'agy' | 'codex';
}

export interface SubagentState {
  config: SubagentConfig;
  /** 实际生效的模式：委派的默认路线不可用（或委派工具被停用）时为 'native' */
  effective: SubagentMode;
  /** 委派路线可选的账号（只含能用的） */
  accounts: SubagentAccountOption[];
  /** 自己的路线不可用、改用默认路线的代理类型 → 原因；没有为空对象 */
  routeFallbacks: Record<string, string>;
  /** 可配置的代理类型（按当前工作区解析项目级智能体；GET /api/subagents?cwd=...）；老服务端不给 */
  agents?: SubagentTypeInfo[];
  /** 已关闭的代理类型名（全局，与 usage.disabledAgents 同源）；老服务端不给 */
  disabledAgents?: string[];
  /** effective 与 config.mode 不同（退回原生）时的原因，给界面直接显示，如「默认账号未登录」「委派工具已在工具面板停用」 */
  fallbackReason?: string;
}

/** 委派后端的一个基础模型；efforts 为空 = 不分思考强度 */
export interface DelegateModel {
  value: string;
  displayName: string;
  efforts: DelegateEffort[];
}

/**
 * GET /api/delegate/models?backend=claude|agy|codex&account=<账号 id>&cwd=（?refresh=1 强制重新拉取）：该委派账号可用的模型。
 * 不传 backend = agy；不传 account = 该后端的当前账号。后端未安装 / 账号未登录时返回 503 + 错误信息。
 */
export interface DelegateModelList {
  models: DelegateModel[];
  /** 后端自己的默认模型与思考强度 */
  current: { model: string; effort: DelegateEffort | null } | null;
  at: number;
}

/** 多账号模式：switch = 同一时间只有一个账号生效（切换时停止所有会话）；parallel = 每个会话绑定自己的账号，多个账号同时生效 */
export type AccountMode = 'switch' | 'parallel';

export interface AccountList {
  mode: AccountMode;
  list: AccountEntry[];
  /** 当前正在进行的登录（添加 / 重新登录账号），没有为 null */
  login: AccountLogin | null;
  /** list() 去重时隐藏的重复条目数（同一个真实账号添加了多次）；没有时省略或为 0 */
  duplicates?: number;
  /** 上面的重复数按账号类型拆开：订阅（同一个 Claude 账号）、API（同一个地址 + Key）、Kiro（同一个登录邮箱） */
  duplicateKinds?: Partial<Record<'claude' | 'api' | 'kiro', number>>;
  /** 子代理按类型选用的账号；老服务端没有。见 SubagentAccounts */
  subagent?: SubagentAccounts;
}

/**
 * 账号分主代理 / 子代理两部分：
 * - 主代理：上面的 list，切换模式 / 并行模式只对主代理生效。
 * - 子代理：按类型各选一个账号，复用账号列表里已有的登录态，不单独登录；与主代理的模式、当前账号无关。
 *   原生子代理（Agent 工具）在主进程里运行，只能跟随主代理的账号，没有单独的选项。
 *   Claude 委派：从上面的 list 里选（claude.ai 登录 / API / Kiro 都行）。执行环境与主代理隔离：
 *   每个账号另有一个子代理配置空间，登录态从主代理空间复制过去（双向同步令牌刷新），会话记录、输入历史等运行状态各自独立，
 *   skill / 智能体 / 命令 / 插件 / 设置 / 全局 CLAUDE.md 与主代理共享。
 *   Antigravity 委派：就是 AgyAccountList 里 active 的那个账号（原有接口不变）。
 * POST /api/accounts/subagent {id} → AccountList   设置 Claude 委派用的账号；只影响新的委派，已有的委派继续用原来的账号。
 */
export interface SubagentAccounts {
  /** Claude 委派使用的账号 id（AccountEntry.id）；该账号被移除时服务端退回 'default' */
  claude: string;
  /** 复制 / 同步登录态失败的原因（给界面显示）；正常时省略 */
  claudeError?: string;
}

export interface AccountDedupeResult {
  /** 删掉的重复条目数 */
  removed: number;
  /** 因默认账号 / 当前账号 / 正在登录 / 有执行中会话或委派任务而保留的条目数 */
  skipped: number;
}

/** Kiro 账号的登录方式：builderId / idc = 设备码登录；kiroIde / kiroCli = 导入本机已有的登录；apiKey = Kiro API Key（ksk_…） */
export type KiroLoginMethod = 'builderId' | 'idc' | 'kiroIde' | 'kiroCli' | 'apiKey';

/** Kiro 账号的公开信息：不含令牌、clientSecret、密钥 */
export interface AccountKiroInfo {
  method: KiroLoginMethod;
  /** 凭据的登录邮箱（kiro.rs 查过额度后才有；API Key 登录可能一直没有） */
  email?: string | null;
  /** 内置 kiro.rs 服务的状态（全部 Kiro 账号共用一个服务，随 cosyee 启动） */
  proxy: 'stopped' | 'starting' | 'ready' | 'failed';
  error: string | null;
  /** 该账号凭据在 kiro.rs 里的状态（服务没在跑或还没读到 = unknown） */
  credential: KiroCredentialState;
  /** credential 为 disabled 时 kiro.rs 给的原因 */
  credentialReason?: string | null;
  /** 从服务 /v1/models 自动拉取生成的模型映射；还没拉到 = 没有，菜单用 CLI 内置别名 */
  models?: ApiModelMap;
}

/** ok = 可用；quota = 额度用完被 kiro.rs 停用；disabled = 因其它原因被停用；missing = 服务里没有这个凭据 */
export type KiroCredentialState = 'ok' | 'quota' | 'disabled' | 'missing' | 'unknown';

export interface KiroBalance {
  subscription: string | null;
  used: number;
  limit: number;
  /** 重置时间，毫秒时间戳；未知为 null */
  resetsAt: number | null;
}

export interface KiroEngineVersion {
  /** 版本号：ZyphrZero/kiro.rs 的 release tag（如 v0.9.9）。字段名沿用旧的 commit */
  commit: string;
  /** 发布时间，毫秒 */
  date: number | null;
  /** release 名 */
  title: string | null;
}

/** kiro.rs 引擎：ZyphrZero/kiro.rs 的 GitHub Release 预编译包（校验 SHA256 后安装） */
export interface KiroEngineStatus {
  /** env = COSYEE_KIRO_RS 指定；managed = ~/.cosyee/kiro-rs 里下载的；none = 还没有 */
  source: 'env' | 'managed' | 'none';
  current: KiroEngineVersion | null;
  /** 上次检查到的上游最新版；没检查过为 null */
  latest: KiroEngineVersion | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  build: { state: 'idle' | 'running' | 'failed'; step: string | null; error: string | null };
}

/** 内置 kiro.rs 服务：一个进程托管全部 Kiro 账号（每个账号 = 一个凭据 + 同名分组 + 绑定该分组的客户端 Key） */
export interface KiroServiceStatus {
  /** 总开关：false = 用户停止了服务，会话也不会再自动拉起代理；默认 true */
  enabled: boolean;
  /** Kiro 账号数 */
  accounts: number;
  /** 服务在运行 / 启动失败：0 或 1 */
  running: number;
  failed: number;
  /** 正在执行的 Kiro 会话数（停止 / 重启前确认用） */
  busySessions: number;
  /** 服务在运行但还是旧版引擎：0 或 1（重启后用新版） */
  outdated: number;
  /** 凭据可用的 Kiro 账号数 */
  usable: number;
}

/** Antigravity CLI（agy）本体的版本与运行情况；安装 / 升级都走官方渠道，不改它的文件 */
export interface AgyCliStatus {
  installed: boolean;
  /** COSYEE_AGY 指定的程序：只显示，不安装 / 升级 */
  custom: boolean;
  version: string | null;
  /** 官方最新版；没查过或查不到 = null */
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  checkError: string | null;
  /** Cosyee 持有的 agy acp 常驻进程数，其中正在执行任务的数量 */
  processes: number;
  busy: number;
  job: { kind: 'install' | 'update'; state: 'running' | 'failed'; error: string | null } | null;
}

/** OpenAI Codex CLI 本体的版本与运行情况；字段语义同 AgyCliStatus */
export interface CodexCliStatus {
  installed: boolean;
  /** COSYEE_CODEX 指定的程序：只显示，不安装 / 升级 */
  custom: boolean;
  /** 安装方式：npm 全局包 / 官方独立安装包 / 自定义路径；没装为 undefined */
  installKind?: 'npm' | 'standalone' | 'custom';
  version: string | null;
  /** 官方最新版；没查过或查不到 = null */
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  checkError: string | null;
  /** Cosyee 持有的 codex app-server 常驻进程数，其中正在执行任务的数量 */
  processes: number;
  busy: number;
  job: { kind: 'install' | 'update'; state: 'running' | 'failed'; error: string | null } | null;
}

/** 本机组件：Claude CLI、kiro.rs 引擎、Antigravity CLI、Codex CLI、内置浏览器（agent-browser）、cosyee 服务端 */
export type ComponentId = 'claude' | 'kiro' | 'agy' | 'codex' | 'browser' | 'server';
export const COMPONENT_IDS: readonly ComponentId[] = ['claude', 'kiro', 'agy', 'codex', 'browser', 'server'];

/** 本机组件的版本与自动更新状态（GET /api/components） */
export interface ComponentStatus {
  id: ComponentId;
  /** 显示名：Claude CLI / kiro.rs / Antigravity CLI / Cosyee 服务端 */
  name: string;
  installed: boolean;
  /** 用户用环境变量指定 / 源码运行：只显示，不检查安装、不自动更新 */
  custom: boolean;
  version: string | null;
  /** 上次检查到的最新版；没查过或查不到 = null */
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  checkError: string | null;
  /** 自动更新开关，默认 true（存 ~/.cosyee/components.json） */
  autoUpdate: boolean;
  /** 正在使用这个组件的任务数；>0 时不自动安装 */
  busy: number;
  /** 有新版、开关开着、不是 custom，但组件忙，等空闲后自动更新 */
  pending: boolean;
  /** 谁执行更新：server 组件由桌面客户端停服务、npm 安装、再启动 */
  updatedBy: 'server' | 'client';
  /** 没安装时能否在「本机组件」里直接安装（目前只有内置浏览器） */
  installable?: boolean;
  job: { kind: 'install' | 'update'; state: 'running' | 'failed'; error: string | null } | null;
  /** 带常驻服务的组件（目前只有 kiro.rs）：服务状态，可以启动 / 停止 / 重启 */
  service?: ComponentService;
}

export interface ComponentService {
  state: 'stopped' | 'starting' | 'ready' | 'failed';
  error: string | null;
  /** false = 用户手动停止（持久化），cosyee 启动时不再自动拉起 */
  enabled: boolean;
  /** 在运行但还是旧版：重启后用新版 */
  outdated: boolean;
  port: number | null;
  /** kiro.rs：账号总数与凭据可用的账号数 */
  accounts: { total: number; usable: number };
}

// ───────────── 内置浏览器（agent-browser） ─────────────

/** 页面坐标系（CSS px，相对视口左上角）里的矩形 */
export interface BrowserRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 浏览器身份：每个身份一份独立的登录状态（profile），同一网站可以在不同身份里登录不同账号 */
export interface BrowserProfile {
  /** 'default' 是默认身份（不能删除），其余是 8 位十六进制 */
  id: string;
  name: string;
}

export interface BrowserProfileStatus extends BrowserProfile {
  /** 这个身份的后台浏览器是否在运行（各身份可以同时运行） */
  running: boolean;
  /** 正在独立的有界面 Chrome 窗口里登录（Google 等网站拦截无界面浏览器的登录）；关掉窗口后回到内置 */
  window: boolean;
  url: string | null;
  title: string | null;
  /** 正在看画面的窗口数 */
  viewers: number;
}

/** GET /api/browser：内置浏览器的状态 */
export interface BrowserStatus {
  /** agent-browser 是否已安装（没装时面板里直接安装） */
  installed: boolean;
  /** 身份列表，默认身份在第一个 */
  profiles: BrowserProfileStatus[];
}

/** 抓取模式里鼠标悬停的元素（只用于画高亮框） */
export interface BrowserHover {
  rect: BrowserRect | null;
  /** 简短描述：tag#id.class */
  label: string;
}

/** 抓取到的元素 */
export interface BrowserElement {
  url: string;
  title: string;
  tag: string;
  /** 尽量唯一的 CSS 选择器 */
  selector: string;
  /** 可见文字（截断） */
  text: string;
  rect: BrowserRect;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  /** 是否在 iframe 里（此时选择器相对 iframe 文档） */
  inFrame: boolean;
}

/** POST /api/browser/pick：元素描述存成文件后，按「选出的文件」登记，前端当附件标签用 */
export interface BrowserPickResult {
  /** 插进输入框的一行定位文字 */
  text: string;
  element: BrowserElement;
}

/** GET /api/browser/history：地址栏的历史联想（读身份自己的 Chrome 历史） */
export interface BrowserHistoryItem {
  url: string;
  title: string;
}

export interface ComponentList {
  list: ComponentStatus[];
}

export interface KiroStatus {
  service: KiroServiceStatus;
  /** 本机有没有可导入的登录（只看文件 / 记录是否存在） */
  imports: { kiroIde: boolean; kiroCli: boolean };
  login: AccountLogin | null;
}

/** 添加 / 重新登录账号的进度 */
export interface AccountLogin {
  /** 设备码登录（Kiro）时要在网页上核对的验证码 */
  userCode?: string | null;
  /** Codex 登录方式（其它后端不给） */
  method?: CodexLoginMethod;
  loginId: string;
  status: 'starting' | 'waiting' | 'done' | 'failed';
  /** 浏览器没自动打开时手动打开的登录页 */
  url: string | null;
  /** 完成后对应的账号 id */
  accountId: string | null;
  error: string | null;
}

/** Antigravity 一条额度窗口（同组模型共享）：window = '5h' | 'weekly' | 其它原样透传 */
export interface AgyQuotaBucket {
  window: string;
  /** 已用百分比 0–100（agy 给的是剩余比例，这里换算成已用，与 Claude 额度一致） */
  percent: number;
  severity: UsageSeverity;
  /** 重置时间，毫秒时间戳 */
  resetsAt: number | null;
}

/** Antigravity 一组共享额度的模型（如「Gemini」「Claude · GPT」） */
export interface AgyQuotaGroup {
  name: string;
  buckets: AgyQuotaBucket[];
}

export interface AgyQuota {
  groups: AgyQuotaGroup[];
  /** 采集时间 */
  at: number;
}

/** Antigravity（agy）账号列表里的一项；委派任务用。不含令牌；邮箱只用来显示。 */
export interface AgyAccountEntry {
  /** 在 Cosyee 里登录的账号 id（各自独立的数据目录）；没有「本机默认账号」 */
  id: string;
  /** 用户起的备注名；没填为空，界面显示邮箱 */
  label: string;
  /** 套餐名（如 'Google AI Pro'）；还没读到为 null */
  plan: string | null;
  /** 账号目录里有没有令牌文件；服务端不再返回 null（旧版本 null = 正在检测） */
  loggedIn: boolean | null;
  /** 新的委派任务用这个账号 */
  active: boolean;
  /** 恒为 false（旧版本的本机默认账号已去掉，字段保留兼容） */
  isDefault: boolean;
  /** 正在用该账号执行的委派任务数 */
  running: number;
  /** 登录的 Google 账号邮箱（优先读自令牌文件，探测结果可作补充，不落盘）；读不到为 null。没起备注名时用它当标题 */
  email?: string | null;
  /** 各组模型的额度（有存活委派进程时直接读其 language server，无进程时后台探测）；还没读到 / 读取失败为 null */
  quota?: AgyQuota | null;
}

export interface AgyAccountList {
  /** 本机装了 agy；没装时 list 为空，不能添加 */
  installed: boolean;
  list: AgyAccountEntry[];
  /** 当前正在进行的登录，没有为 null */
  login: AccountLogin | null;
  /** list() 去重时隐藏的重复条目数（同一个真实账号添加了多次）；没有时省略或为 0 */
  duplicates?: number;
}

/** Codex 登录方式：chatgpt = 浏览器 OAuth；deviceAuth = 设备码（无浏览器 / 远程）；apiKey = OpenAI API Key */
export type CodexLoginMethod = 'chatgpt' | 'deviceAuth' | 'apiKey';

/** Codex 一个限额窗口（primary = 短窗口如 5h，secondary = 长窗口如每周） */
export interface CodexQuotaWindow {
  /** 已用百分比 0–100 */
  usedPercent: number;
  /** 窗口时长（分钟）；未知为 null */
  windowMins: number | null;
  /** 重置时间，毫秒时间戳；未知为 null */
  resetsAt: number | null;
}

/** 一个限额分组（limitId 如 'codex'，limitName 为显示名，没有时用 limitId） */
export interface CodexQuotaGroup {
  limitId: string;
  limitName?: string | null;
  primary: CodexQuotaWindow | null;
  secondary: CodexQuotaWindow | null;
}

export interface CodexQuota {
  groups: CodexQuotaGroup[];
  /** 套餐类型（如 'plus' / 'pro'）；未知为 null */
  planType?: string | null;
  /** 采集时间，毫秒时间戳 */
  fetchedAt: number;
}

/** Codex 账号列表里的一项；委派任务用。不含令牌；邮箱只用来显示。 */
export interface CodexAccountEntry {
  /** 'default' = 本机 codex 自己的登录（~/.codex 或 CODEX_HOME）；其它 = 在 Cosyee 里添加的账号（各自独立的 CODEX_HOME） */
  id: string;
  /** 用户起的备注名；没填时服务端自动起「账号 2」这样的名字；默认账号为空 */
  label: string;
  /** 套餐名（如 'plus'）；还没读到为 null */
  plan: string | null;
  /** null = 正在检测 */
  loggedIn: boolean | null;
  /** 新的委派任务用这个账号 */
  active: boolean;
  isDefault: boolean;
  /** 正在用该账号执行的委派任务数 */
  running: number;
  /** 登录的邮箱；还没读到为 null。没起备注名时用它当标题 */
  email?: string | null;
  /** 登录方式：ChatGPT 账号 / API Key；未登录或未知为 null */
  authMode?: 'chatgpt' | 'apiKey' | null;
  /** 套餐类型原始值（同 quota.planType）；还没读到为 null */
  planType?: string | null;
  /** 限额；还没读到 / 读取失败 / API Key 账号为 null */
  quota?: CodexQuota | null;
}

export interface CodexAccountList {
  /** 本机装了 codex；没装时 list 为空，不能添加 */
  installed: boolean;
  list: CodexAccountEntry[];
  /** 当前正在进行的登录，没有为 null */
  login: AccountLogin | null;
  /** list() 去重时隐藏的重复条目数（同一个真实账号添加了多次）；没有时省略或为 0 */
  duplicates?: number;
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

/**
 * 一个子智能体（subagents/agent-<id>.jsonl）的累计花费，按服务端当前价格表计算（GET /api/sessions/:id/subagent-costs）。
 * 同一条消息在记录里分成多行时按 message.id 去重；只算有 usage 的 assistant 消息。
 */
export interface SubagentCost {
  agentId: string;
  /** 派发它的 Agent 工具调用 id（来自 agent-<id>.meta.json）；没有 meta 的旧记录为 null */
  toolUseId: string | null;
  /** meta 里的 agentType，如 general-purpose / web-fetch；压缩等内部任务可能没有 */
  agentType?: string;
  /** 来源后端：native = 原生 Claude 子代理；其余为委派后端 */
  source?: 'native' | 'claude' | 'codex' | 'agy';
  /** 有 usage 的请求数 */
  requests: number;
  /** 能定价的请求的花费 */
  cost: CostParts;
  /** 假如完全不用缓存的花费（能定价的请求） */
  uncached: number;
  /** 模型不在价格表里、没算进 cost 的请求数 */
  unpriced: number;
  /** 出现过的模型 id（原样） */
  models: string[];
  /** 逐次 API 请求的用量记录（turn 一律为 0；同 id 已合并 tools 与最大 output） */
  points?: CachePoint[];
}

export type ToolLoadClass = 'resident' | 'deferred' | 'unknown';
export type ToolLoadSource = 'session' | 'cache' | 'static';

export interface ToolTokenEntry {
  name: string;
  tokens: number;
  deferred?: true;
  /** 按定义长度权重从 CLI 合计中分摊的估算值 */
  estimated?: true;
  /** 懒加载工具本会话已加载完整定义 */
  loaded?: true;
}

export interface ToolLoadEntry {
  load: ToolLoadClass;
  /** 懒加载工具本会话已加载完整定义 */
  loaded?: true;
  /** 该条分类的来源（unknown 时省略） */
  source?: ToolLoadSource;
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
  /** Cosyee 保存的「原生子代理」开关（全局）；false = 有可用委派的会话停用整个 Agent 工具。旧服务端不带 */
  nativeAgents?: boolean;
  /** 智能体名 → 描述原文（CLI initialize 的 agents，含内置；已关闭的读磁盘上的定义）。Agent 工具里列给模型的就是它 */
  agentDescriptions?: Record<string, string>;
  /**
   * 内置工具名（最近一次 system/init 的 tools，不含 mcp__ 工具）。探测进程不发消息、收不到 init，
   * 页面重开也会错过 init，所以服务端记下来随上下文下发：本会话的优先，否则用最近一次见到的（落盘）
   */
  tools?: string[];
  /**
   * 可用的斜杠命令名（来自 system/init 的 slash_commands；探测进程收不到 init 时取 initialize 响应的 commands）。
   * 供输入框 `/` 菜单在会话尚未发过消息、未收到 init 时兜底
   */
  slashCommands?: string[];
  /**
   * 单个内置工具定义的 token 占用。
   * CLI 直接给单工具值（systemTools / deferredBuiltinTools）或 Cosyee 自带工具（mcp__cosyee__*）为精确值；
   * 当前 CLI 只给「System tools」「System tools (deferred)」合计时，由服务端按定义长度权重分摊并标 estimated: true。
   * deferred = 懒加载：平时只列名字，ToolSearch 加载后才把完整定义放进上下文（loaded: true）。
   */
  toolTokens?: ToolTokenEntry[];
  /** 每个内置工具（含已停用）的加载方式（常驻 / 懒加载 / 未确定）与本会话是否已加载 */
  toolLoad?: Record<string, ToolLoadEntry>;
  /** 本次工具加载分类的主要来源：session=本会话记录 / cache=上次观测缓存 / static=静态默认表 */
  toolLoadSource?: ToolLoadSource;
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
/** Cosyee 内置的 skill：始终开启，不能改状态（设置里存的值被忽略，界面上锁住） */
export const BUILTIN_SKILLS: readonly string[] = ['cosyee:browser'];
export const isBuiltinSkill = (name: string): boolean => BUILTIN_SKILLS.includes(name);

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
  /** Cosyee 内置（BUILTIN_SKILLS）：始终开启，不能改状态 */
  locked?: boolean;
  /** 在磁盘上找得到目录（用户级 / 项目级 / 已安装插件 / 云端同步），可以打开文件位置；读不到磁盘信息时不带 */
  onDisk?: boolean;
  /**
   * 放进系统提示词 skill 清单里的描述原文（CLI initialize 的 commands，取不到时读 SKILL.md 的 description）；
   * 模型看到的那一行是「- 名字: 描述」。都取不到时不带
   */
  description?: string;
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
  /** description：mcp_status 报告的工具描述（随工具定义放进上下文）；CLI 没给时不带 */
  tools: { name: string; tokens: number | null; description?: string }[];
}

/**
 * 权限模式：auto=自动（CLI bypassPermissions，不需要审批）；plan=计划（CLI plan，只读调研并给出计划，
 * 模型调用 ExitPlanMode 时等用户批准，批准后切回 auto 开始执行）。
 */
export type PermissionMode = 'auto' | 'plan';

/** 每个会话可调的启动参数，改动后下一轮生效（permissionMode 运行中切换立即生效） */
export interface SessionConfig {
  model: string;
  effort: Effort;
  ultracode?: boolean;
  /** 缺省 = auto */
  permissionMode?: PermissionMode;
}

// ───────────── 需要用户回应的请求（AskUserQuestion / ExitPlanMode） ─────────────

/** AskUserQuestion 的一个问题（CLI 工具输入 questions[] 的一项） */
export interface AskQuestion {
  question: string;
  /** 短标签（如 "Greeting"） */
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

/**
 * CLI 发来的 can_use_tool 中需要用户回应的那几种（其余工具一律自动放行）。
 * id = control_request 的 request_id；toolUseId = 对应 assistant tool_use 块的 id（前端可据此关联流里的工具步骤）。
 */
export type PendingPrompt =
  | { kind: 'question'; id: string; toolUseId?: string; questions: AskQuestion[]; at: number }
  | { kind: 'plan'; id: string; toolUseId?: string; plan: string; planFilePath?: string; at: number };

/**
 * 对一个 PendingPrompt 的回应：
 * - answer：回答问题。answers 的键 = 问题原文，值 = 选中的 label（多选用 ", " 连接；自定义回答直接是文字）
 * - skip：不回答（拒绝这次提问，模型自行继续）
 * - approve：批准计划，后端随即把会话切到 auto 模式
 * - revise：不批准，带上修改意见，模型留在计划模式继续完善
 */
export type PromptReply =
  | { kind: 'answer'; answers: Record<string, string> }
  | { kind: 'skip' }
  | { kind: 'approve' }
  | { kind: 'revise'; feedback: string };

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
// GET  /api/sessions/:id/subagent-costs?cwd=  → { items: SubagentCost[] }  该会话所有子智能体的花费（没有子智能体为空数组）
// GET  /api/pricing                            → PriceTable   当前价格表（官方页面抓取成功则为 official，否则内置）
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
// POST /api/accounts/api {id?, label?, baseUrl?, apiKey?, authType?} → { ok: true, id }   添加（不带 id）或修改 API 账号。
//                                             baseUrl 空 = 官方地址；修改时 apiKey 留空 = 不变；该账号有执行中的会话时 409，空闲进程会先停掉
// GET  /api/kiro                            → KiroStatus   内置 kiro.rs 服务概况、可导入的登录、进行中的登录（安装 / 更新 / 启停走 /api/components/kiro/*）
// POST /api/kiro/service/admin              → { url, key }     内置 kiro.rs 服务的管理页面地址与管理密钥（全部账号共用）；服务没运行时先启动。仅本机的非浏览器请求（带 Origin / Sec-Fetch-Site 的一律 403），不写日志
// GET  /api/components                      → ComponentList   本机组件版本与自动更新状态；带服务的组件（kiro）附 service
// POST /api/components/<id>/check           → ComponentStatus   立即查询最新版；仅本机连接
// POST /api/components/<id>/update          → ComponentStatus   后台安装 / 更新；仅本机连接；已在进行 / 组件忙 409；custom 或没安装（且不可安装）409；server 组件 409「由桌面客户端更新」
// POST /api/components/<id>/auto?enabled=0|1 → ComponentStatus   自动更新开关（持久化）；仅本机连接
// GET  /api/components/<id>/log?from=<n>    → { lines: string[]; next: number }   本次更新日志的增量
// POST /api/components/<id>/start           → ComponentStatus   启动组件的服务（kiro：打开总开关并启动 kiro.rs；没装 409）；仅本机连接；没有服务的组件 404
// POST /api/components/<id>/stop[?force=1]  → ComponentStatus   停止服务（kiro：关闭总开关并持久化）；有执行中的会话且没带 force 时 409 { error, running }；仅本机连接
// POST /api/components/<id>/restart[?force=1] → ComponentStatus 用当前版本重启服务；409 同上；仅本机连接
//                                             components/* 的 POST 都没有请求体；<id> 不是 ComponentId 时 404
// POST /api/kiro/login {method, label?, accountId?, startUrl?, region?, apiKey?} → AccountLogin   添加或重新登录 Kiro 账号；同一时间只允许一个
// GET  /api/kiro/login/:loginId             → AccountLogin
// POST /api/kiro/login/:loginId/cancel      → { ok: true }
// GET  /api/kiro/balance?account=<id>       → KiroBalance   Kiro 账号额度（会按需启动服务）
// GET  /api/agy-accounts                    → AgyAccountList   在 Cosyee 里登录的 Antigravity（agy）账号与进行中的登录；
//                                             登录状态看令牌文件，邮箱优先读自令牌文件，套餐与额度优先读存活委派进程、无进程时后台探测，变化时广播 agy.changed；
//                                             ?refresh=1 时对超过 90 秒没更新的已登录账号触发后台刷新
// POST /api/agy-accounts/switch {id}        → { ok: true }   新的委派任务改用该账号；执行中的任务和已有的委派会话继续用原来的账号，不停止任何进程
// POST /api/agy-accounts/login {label?, accountId?} → AccountLogin   添加账号（或重新登录）：后台运行 agy acp --login，不打开本机浏览器，
//                                             只给出登录链接，登录后把页面上的授权码（或完整网址）交回来；同一时间只允许一个
// GET  /api/agy-accounts/login/:loginId     → AccountLogin
// POST /api/agy-accounts/login/:loginId/code {code} → { ok: true }
// POST /api/agy-accounts/login/:loginId/cancel → { ok: true }
// POST /api/agy-accounts/remove {id}        → { ok: true }   移除账号并删除它的数据目录；正在登录 / 有执行中任务的不能移除（409）；移除当前账号后自动换到下一个
// POST /api/agy-accounts/label {id, label}  → { ok: true }   修改备注名
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
// POST /api/skills {modes: {名字: mode}}    → { ok: true }   批量设置（勾选批量操作与撤销用），只落盘 / 下发 / 采集一次
// POST /api/skills/remove {name, session?, cwd?} → { ok: true, backup }   移除用户级 / 项目级 skill：目录移到 ~/.cosyee/removed-skills（可手动放回恢复）；
//                                             插件 / 内置 skill 不能移除（400），请改用「关」
// POST /api/skills/reveal {name, session?, cwd?} → { ok: true }   在文件管理器中选中它的 SKILL.md；只允许服务端本机（远程 403）；磁盘上找不到 404
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
  /**
   * 服务端的 Tailscale HTTPS 入口（https://<机器名>.<tailnet>.ts.net，tailscale serve 反代）。
   * 浏览器只在 HTTPS / 本机页面里允许用麦克风：经 http 远程访问时网页自动跳到这里。没有时 null。
   */
  httpsUrl?: string | null;
}

// ───────────── 语音：朗读交付文字（TTS）/ 语音输入（STT），都在服务端用本地模型 ─────────────
// 模型和运行库首次使用时下载到 ~/.cosyee/speech，之后离线可用。
//   GET  /api/speech/status            → SpeechStatus
//   POST /api/speech/prepare { kind }  → SpeechStatus（未就绪则开始下载；已在下载 / 已就绪时不重复）
//   POST /api/tts { text }             → TtsPrepared（未就绪 409；text 是交付文字原文 Markdown，服务端清洗、分句）
//   GET  /api/tts/:id/:i               → 第 i 段音频（audio/wav）
//   POST /api/stt?rate=16000           → { text }（请求体：单声道 16 位小端 PCM，application/octet-stream；未就绪 409）

export type SpeechKind = 'tts' | 'stt';

export interface SpeechAssetStatus {
  /** missing = 未下载；downloading = 下载 / 解压中；ready = 可用；error = 上次准备失败（可再次 prepare 重试） */
  phase: 'missing' | 'downloading' | 'ready' | 'error';
  /** 下载进度（字节，包含运行库），phase = downloading 时有；total 未知时为 0 */
  received?: number;
  total?: number;
  error?: string;
}

export type SpeechStatus = Record<SpeechKind, SpeechAssetStatus>;

/** 朗读准备结果：count 段音频，按 /api/tts/:id/0..count-1 依次播放；没有可朗读的内容时 count = 0 */
export interface TtsPrepared {
  id: string;
  count: number;
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
  | { t: 'config'; sessionId: string; config: SessionConfig }
  /** 回应一个待处理的请求（id = PendingPrompt.id）。已不存在（被取消 / 已回应）时忽略 */
  | { t: 'prompt.reply'; sessionId: string; id: string; reply: PromptReply }
  /** 停止一个委派任务（toolUseId = DelegateJobInfo.toolUseId）。前台任务的工具调用返回「用户已停止」 */
  | { t: 'delegate.stop'; sessionId: string; toolUseId: string }
  /** 给委派任务追加消息：steer=打断当前 prompt 立即带上这条重新执行（缺省）；queue=当前 prompt 结束后再执行 */
  | { t: 'delegate.send'; sessionId: string; toolUseId: string; text: string; mode?: DelegateSendMode }
  /** 立即重试一次因错误停止的会话（同样要求会话空闲）；没有停止记录时忽略 */
  | { t: 'retry.now'; sessionId: string }
  /** 取消自动重试：停止记录保留（state=stopped）用于显示原因 */
  | { t: 'retry.cancel'; sessionId: string };

/**
 * 会话因错误停止的记录（服务端落盘，切换会话 / 重启后仍在）。
 * rate_limit：额度用尽，到 retryAt（额度重置时间之后）自动重试；transient：过载 / 5xx / 网络 / 进程异常退出，按退避自动重试；
 * fatal：安全拦截、未登录、上下文过长等，不自动重试，只用于显示原因；
 * interrupted：一轮执行中服务被关闭 / 重启 / 崩溃，启动时补记，state = stopped，只提供手动重试。
 * state：waiting = 等待自动重试；retrying = 已发出重试消息、这一轮在执行；gave_up = 多次自动重试仍失败；stopped = 用户取消、fatal 或 interrupted。
 * 用户自己发消息 / 回退 / 删除会话、或重试成功后记录清除。
 */
export type StopKind = 'rate_limit' | 'transient' | 'fatal' | 'interrupted';
export type StopState = 'waiting' | 'retrying' | 'gave_up' | 'stopped';
export interface StopInfo {
  kind: StopKind;
  /** 错误原文（额度提示 / API Error / 退出原因） */
  reason: string;
  /** 下次自动重试的时间（毫秒时间戳）；state 不是 waiting 时没有 */
  retryAt?: number;
  /** 已自动重试的次数 */
  attempts: number;
  state: StopState;
  /** 记录时间（毫秒时间戳） */
  at: number;
}

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

// ───────────── 委派任务（cosyee MCP 的 delegate 系列工具） ─────────────

export type DelegateJobState = 'running' | 'done' | 'error' | 'stopped';
export type DelegateSendMode = 'steer' | 'queue';

/** 一个委派任务（按委派 conversation_id 计；toolUseId 是界面上对应的那次 delegate 调用） */
export interface DelegateJobInfo {
  toolUseId: string;
  conversationId: string;
  description: string;
  /** run_in_background 启动（或 delegate_send 续跑）的任务：结束时后端给 CLI 注入完成通知 */
  background: boolean;
  state: DelegateJobState;
  /** 毫秒时间戳 */
  startedAt: number;
  endedAt?: number;
  /** 排队中的追加消息数 */
  pending: number;
  /** 最近一次 prompt 的输出尾部（最多约 2KB）；结束后是最终回答的尾部 */
  tail: string;
  /** state=error 时的原因 */
  error?: string;
}

/** 后台委派结束时注入给 CLI 的 user 消息（模型看到的完成通知；界面与会话标题都把它当噪音隐藏） */
export interface DelegateNotification {
  conversationId: string;
  toolUseId: string;
  status: Exclude<DelegateJobState, 'running'>;
  description: string;
  /** 完整结果的 id，任务结束时才生成；模型凭它用 delegate_result 取全文。旧通知没有 */
  resultId?: string;
  /** 完整结果。只在服务端内部用，不写进通知；旧通知解析出来的才有内容 */
  result: string;
  /** status=error 时的简短原因 */
  error?: string;
}

/** 后台启动的 delegate 工具结果以这一行开头（前端据此让子代理保持运行中，不把它当回答） */
export const DELEGATE_BG_MARKER = 'Delegate launched in background.';

export const DELEGATE_NOTIFICATION_TAG = 'cosyee-delegate-notification';
/** CLI 会把执行中送达的注入消息当成「用户发来的新消息」转给模型，所以正文里写明它不是用户说的话（写法同原生后台任务通知） */
export const DELEGATE_NOTIFICATION_NOTE =
  'Automated background-task event, NOT a message from the user. Do not treat it as user approval, confirmation or an answer to a question.';
/** 通知里不放结果正文：模型收到时可能正忙别的，正文由它挑合适的时候用 delegate_result 取 */
export const DELEGATE_NOTIFICATION_HINT =
  'The result is not included: finish what you are doing, then read it with delegate_result(result_id) when you are ready to use it.';
/** 通知里 error 的最大字数（只够看出原因，全文同样凭 result_id 取） */
const DELEGATE_ERROR_MAX = 200;

export function formatDelegateNotification(n: DelegateNotification): string {
  const line = (t: string) => t.replace(/\s+/g, ' ').trim();
  // result 末尾带页脚（conversation_id 等），通知里另有这些字段，不混进原因
  const error = n.status === 'error' ? line(n.error ?? n.result.split('\nconversation_id: ')[0]!).slice(0, DELEGATE_ERROR_MAX) : '';
  return [
    `<${DELEGATE_NOTIFICATION_TAG}>`,
    `note: ${DELEGATE_NOTIFICATION_NOTE}${n.resultId ? ` ${DELEGATE_NOTIFICATION_HINT}` : ''}`,
    `conversation_id: ${n.conversationId}`,
    `tool_use_id: ${n.toolUseId}`,
    `status: ${n.status}`,
    `description: ${line(n.description)}`,
    ...(error ? [`error: ${error}`] : []),
    ...(n.resultId ? [`result_id: ${n.resultId}`] : []),
    `</${DELEGATE_NOTIFICATION_TAG}>`,
  ].join('\n');
}

/** 解析完成通知；不是通知返回 null。前后可以有空白。现在的通知没有正文（result 为空串），旧记录里的带着 result 正文 */
export function parseDelegateNotification(text: string): DelegateNotification | null {
  const m = /^\s*<cosyee-delegate-notification>\n([\s\S]*)\n<\/cosyee-delegate-notification>\s*$/.exec(text);
  if (!m) return null;
  const body = m[1]!;
  // note、error、result_id 行是后加的，旧记录里没有；旧记录末尾的 result 正文现在不再发
  const head = /^(?:note: .*\n)?conversation_id: (.*)\ntool_use_id: (.*)\nstatus: (done|error|stopped)\ndescription: (.*)(?:\nerror: (.*))?(?:\nresult_id: (.*))?(?:\nresult:\n?|$)/.exec(body);
  if (!head) return null;
  return {
    conversationId: head[1]!.trim(),
    toolUseId: head[2]!.trim(),
    status: head[3] as DelegateNotification['status'],
    description: head[4]!.trim(),
    ...(head[5] ? { error: head[5].trim() } : {}),
    ...(head[6] ? { resultId: head[6].trim() } : {}),
    result: body.slice(head[0].length),
  };
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
  /**
   * 等用户回应的请求（完整快照，按到达顺序）。变化时广播；订阅时紧跟 queue 发一次（没有也发空数组）。
   * 计划被批准时后端已把会话切到 auto（runner 的已生效配置与服务端记下的会话配置都改成 auto），
   * 前端批准时自己把输入框的 config.permissionMode 改成 auto
   */
  | { t: 'prompts'; sessionId: string; items: PendingPrompt[] }
  /** 本会话的委派任务（完整快照）。变化时广播；订阅时紧跟 prompts 发一次（没有也发空数组）。只在内存里，服务端重启后为空 */
  | { t: 'delegates'; sessionId: string; jobs: DelegateJobInfo[] }
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
  /** Antigravity 账号列表 / 当前账号 / 登录状态变了：前端重取列表，并丢掉缓存的委派模型列表 */
  | { t: 'agy.changed' }
  | { t: 'codex.changed' }
  /** 子代理配置或可用性变了（任一窗口改了设置、开关了代理类型、后端装上 / 卸载 / 登录状态变化）：前端重新 GET /api/subagents */
  | { t: 'subagents.changed' }
  /** 2FA 条目 / 分组 / 标签 / 同步状态变化：前端重新 GET /api/2fa/data */
  | { t: '2fa.changed' }
  | { t: 'context'; sessionId: string; usage: ContextUsage }
  /** 会话实际生效的设置（来自 control_request get_settings 的 applied）。ultracodeAvailable 为 true 时前端才显示 Ultracode 开关 */
  | { t: 'settings'; sessionId: string; applied: AppliedSettings }
  /** 会话的停止记录（见 StopInfo）。变化时广播；订阅时紧跟 status 发一次（没有记录发 null） */
  | { t: 'stop'; sessionId: string; info: StopInfo | null }
  | { t: 'error'; message: string };
