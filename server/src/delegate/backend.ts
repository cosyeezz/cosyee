// 委派后端的统一接口：模型只认识 delegate 系列工具，不知道背后是谁在干活。
// 第一个实现是 Antigravity（acp.ts，agy acp 常驻进程池）；以后接别的后端只需再实现一个 DelegateBackend。
// 后端名（label）只给界面用，永远不进工具说明、提示词或返回给模型的文字。
import type { CachePoint, DelegateEffort, DelegateModelList, Effort, SubagentAvailability, SubagentTypeOverrides } from '@cosyee/shared';
import type { Json } from '../transcript.js';

export interface BackendDefaults {
  model: string | null;
  effort: DelegateEffort | null;
  /** 主会话当前的模型 / 强度：后端配置为 null 时作为回退（Claude 委派用） */
  parentModel?: string | null;
  parentEffort?: Effort | null;
  /** 按代理类型名单独配置（新会话按智能体名匹配） */
  agents?: SubagentTypeOverrides<string, DelegateEffort>;
}

export interface BackendRunOptions {
  cwd: string;
  prompt: string;
  /** 续接的后端会话；不传 = 新会话 */
  sessionId?: string;
  /** 续接时绑定的后端账号 id；不传 = 新会话 */
  accountId?: string;
  /** 新会话用哪个账号（委派路线里选的）；不传 = 该后端的当前账号。续接时忽略（以 accountId 为准） */
  routeAccountId?: string;
  /** 主会话当前的 Claude 账号（dir 为 null = 默认账号）；Claude 委派新会话沿用 */
  account?: { id: string; dir: string | null };
  /** 主会话处于计划模式（只读） */
  readOnly?: boolean;
  /** 智能体本身是只读的（内置 Explore / Plan）；支持沙箱的后端（Codex）据此用只读沙箱，其他后端忽略 */
  agentReadOnly?: boolean;
  /** 智能体允许的内置工具白名单（frontmatter tools:，不含 '*'）；仅 Claude 后端生效 */
  tools?: readonly string[];
  /** 智能体额外禁用的工具（Explore / Plan 只读工具 + frontmatter disallowedTools:）；在 Claude 后端与 NATIVE_SUBAGENT_TOOLS 合并 */
  disallowedTools?: readonly string[];
  /** 只用于新会话：追加到后端系统提示词（智能体正文、项目规则）；续接的会话后端自己保留 */
  systemPrompt?: string;
  /** 用户设置里的默认模型 / 强度，只用于新会话 */
  defaults?: BackendDefaults;
  /** 智能体定义里的强度：用户设置没填强度时才用，只用于新会话 */
  effort?: DelegateEffort;
  signal: AbortSignal;
  /** 发 prompt 之前报告实际使用的模型（后端没报告时不调用） */
  onModel?: (m: { model: string; effort?: string | null }) => void;
  /** 本次 prompt 期间、本会话的进度（ACP session/update 的 update 对象形状；不含 load 回放） */
  onUpdate?: (update: Json) => void;
  /** 本次 prompt 期间产生的逐次 API 请求用量（同 id 可重发更新）；window 为模型上下文窗口（未知为 null） */
  onUsage?: (point: CachePoint, window: number | null, extra?: { reasoning?: number }) => void;
  /** 后端会话建立（或恢复）完成、开始 prompt 之前报告会话 id 与所属账号 id */
  onSession?: (sessionId: string, accountId?: string) => void;
}

export interface BackendResult {
  stopReason: string;
  /** 最终回答（见实现：最后一个工具调用之后的文字，没有就是全部文字） */
  response: string;
  sessionId: string;
  /** 实际执行该会话的后端账号 id */
  accountId?: string;
  usage?: Json;
  /** 本次 prompt 期间结束（completed / failed）的不同工具调用个数 */
  toolCalls: number;
}

/** 带后端会话 id 的错误：上层据此保留会话映射，让模型可以续接重试 */
export class BackendError extends Error {
  constructor(message: string, readonly sessionId?: string, readonly accountId?: string) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface DelegateBackend {
  /** 稳定 id，存进配置与任务映射（如 'agy'） */
  readonly id: string;
  /** 界面显示名（如 'Antigravity'）；不给模型看 */
  readonly label: string;
  /** 已安装且登录态可用（不保证网络可达） */
  available(): boolean;
  /** 详细可用性（含不可用原因，供界面显示与 fallbackReason）；未实现时按 available() 退回 */
  availability?(): SubagentAvailability;
  /** 指定账号能否用于新委派（后端已安装、账号存在且已登录；不起进程不联网）；未实现时按 availability() 退回 */
  accountAvailability?(accountId: string): SubagentAvailability;
  /** 可用模型；refresh = 强制重新拉取；accountId 不传 = 当前账号 */
  models(o: { cwd: string; refresh?: boolean; accountId?: string }): Promise<DelegateModelList>;
  run(o: BackendRunOptions): Promise<BackendResult>;
  /** 后台预热该工作区（可用时才做，失败静默）；不阻塞调用方。accountId 不传 = 当前账号 */
  prewarm?(cwd: string, accountId?: string): void;
  /**
   * 该工作区有活着的主会话进程：持有期间不回收它的热进程（释放后才按空闲时间回收）。
   * 返回释放函数，重复调用无害。
   */
  hold?(cwd: string): () => void;
}
