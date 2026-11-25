// 会话流视图模型。web/src/core/reducer.ts 把 CLI 事件（实时）或 jsonl 条目（历史）归约成这里的结构，
// web/src/ui/flow 只负责渲染。规则见 SPEC.md §4。
import type { CliModelCost } from './pricing.ts';

export interface ToolStep {
  kind: 'tool';
  /** tool_use id */
  id: string;
  name: string;
  input: unknown;
  /** 一行摘要，例如 `Bash: npm test`、`Read: src/a.ts` */
  summary: string;
  result?: { content: unknown; isError: boolean };
  /** 输入参数仍在流式生成中 */
  streaming?: boolean;
}

export interface TextStep {
  kind: 'text';
  text: string;
}

export interface ThinkingStep {
  kind: 'thinking';
  /** 部分模型不返回思考文本（始终为空串），此时 UI 显示「已思考（N tokens）」 */
  text: string;
  /** 思考 token 数（来自 system/thinking_tokens 估算或 usage） */
  tokens?: number;
  /** 仍在思考 */
  streaming?: boolean;
}

export type Step = ToolStep | TextStep | ThinkingStep;

export type TurnStatus =
  /** 已发送，还没有实质输出。UI 与 running 同样显示固定的「正在处理」 */
  | 'understanding'
  /** 执行中（有模型输出 / 工具调用）。状态行措辞固定，不显示模型文字 */
  | 'running'
  | 'done'
  | 'interrupted'
  | 'error';

export interface SubagentRun {
  /** 主代理里 Agent 工具调用的 tool_use id */
  toolUseId: string;
  /** Agent 工具调用的 description */
  title: string;
  subagentType?: string;
  /** delegate 工具发起的委派（不是 claude 原生子代理） */
  delegate?: boolean;
  /** 子代理的 agent id（= 后台任务的 task_id）；SendMessage 恢复时靠它找回原来的子代理 */
  taskId?: string;
  /** 实际使用的模型：子代理 assistant 消息里的 model；还没有输出时取 Agent 调用参数里的 model（如 sonnet） */
  model?: string;
  /** 思考等级：调用时点名的、服务端按「子代理模型」设置补上的，或子代理记录里的；为空时 UI 显示设置里的值 */
  effort?: string;
  status: 'running' | 'done' | 'error';
  /** 后台运行（delegate run_in_background / delegate_send 续跑）：主轮结束不影响它，状态由委派任务快照或完成通知决定 */
  background?: boolean;
  /**
   * 委派时所在轮的 steps.length：它排在 steps[afterStep - 1] 之后。
   * 状态行把委派当作模型输出，与文字比先后、显示最新的那个；旧数据没有时视为排在最前。
   */
  afterStep?: number;
  /** 子代理自己的会话流（只有一轮；不会再有 subagents） */
  turn: Turn;
}

/**
 * 一次技能加载。模型调用 Skill 工具、或用户输入「/技能名 参数」都算。
 * 同一轮里同名技能各自一条，UI 按名字合并成一行（×N）。
 */
export interface SkillLoad {
  /** 模型调用：Skill 工具的 tool_use id；用户输入：`user:<turn.id>` */
  id: string;
  /** 技能名（插件技能带前缀，如 anthropic-skills:pdf） */
  name: string;
  /** 调用参数（Skill 工具的 args / 命令后面的文字）；没有为空 */
  args?: string;
  /** model = 模型调用 Skill 工具；user = 用户输入 /技能名（UI 标「手动」） */
  source: 'model' | 'user';
  status: 'loading' | 'loaded' | 'error';
  /**
   * 模型实际看到的注入正文（已替换参数、不含 frontmatter，去掉了首行「Base directory for this skill: …」）。
   * 实时的 /技能 输入 CLI 不回传正文，此时为空，UI 展开时调 GET /api/skills/content 读磁盘兜底。
   */
  body?: string;
  /** 「Base directory for this skill:」后的目录 */
  dir?: string;
  /** 加载失败的原因（已去掉 <tool_use_error> 标签） */
  error?: string;
  /** 加载时所在轮的 steps.length（同 SubagentRun.afterStep） */
  afterStep?: number;
}

export interface Attachment {
  kind: 'file' | 'img' | 'folder';
  /** 占位名：file1 / img1 / folder1，每条消息内编号 */
  label: string;
  path: string;
}

export interface Turn {
  id: string;
  /**
   * 这一轮用户消息的 uuid：实时为 cosyee_user.id；历史为 user 条目的 uuid，steering 为 queued_command 附件的 source_uuid。
   * rewind 的目标 id。旧数据可能没有。
   */
  userId?: string;
  /** 这条用户消息是 steering（并入上一轮执行的插话）。CLI 的 rewind 选择列表不含它们 */
  steer?: boolean;
  /**
   * 这一轮是 CLI 自己处理的本地命令（/compact、/model 等），不会产生模型回复。
   * 仍然建一轮（后续事件落在它上面，不污染上一轮），但确认没有任何模型内容时整轮不渲染（见 web 的 isHiddenTurn）。
   */
  local?: boolean;
  /** 用户消息正文（标签处为占位名，例如「比较 file1 和 folder1」） */
  userText: string;
  attachments: Attachment[];
  status: TurnStatus;
  /**
   * reducer 记录的最近一句模型文字（understanding 时为「正在理解问题」）。
   * 仅保留作内部状态，UI 不再显示：状态行措辞固定，由 UI 按 status 拼出（见 web 的 getStatusLine）。
   */
  statusText: string;
  /** 执行过程，按时间顺序（思考 / 文字 / 工具），展开区全部列出；不含正在写的 answer */
  steps: Step[];
  /**
   * 正在写的一段模型文字，流式期间实时增长；若之后出现工具调用则作为 TextStep 并入 steps 并清空。
   * 状态行下方显示：折叠时为 answer，空则取 steps 里最后一段文字；展开时只显示 answer。结束后留下的即最终答复。
   */
  answer: string;
  /** 本轮所有子代理，按启动顺序追加 */
  subagents: SubagentRun[];
  /** 本轮加载的技能，按加载顺序追加（子代理加载的在子代理自己的 turn 里）。旧数据可能没有 */
  skills?: SkillLoad[];
  startedAt: number;
  endedAt?: number;
  /** interrupted / error 时的一句原因 */
  reason?: string;
}

/** 一次 API 请求的缓存命中情况（主线程；一条 assistant 消息 = 一次请求） */
export interface CachePoint {
  /** assistant message.id（去重用） */
  id: string;
  /** 所属轮的序号（回退时按它截断） */
  turn: number;
  /** 未命中缓存的输入 token */
  input: number;
  /** 写入缓存的 token（cache_creation_input_tokens） */
  create: number;
  /** 命中缓存的 token（cache_read_input_tokens） */
  read: number;
  /** 命中率 0–100 = read / (input + create + read) */
  rate: number;
  /** 这次请求的回复里调用的工具（tool_use id，按出现顺序）；没有调用工具时为空 */
  tools?: string[];
  /** 输出 token（流式期间可能先是部分值，同 id 后到的更大值覆盖）；旧数据没有 */
  output?: number;
  /** 这次请求的模型（message.model，原样）；旧数据没有 */
  model?: string;
  /** create 里写入 1 小时缓存的部分（usage.cache_creation.ephemeral_1h_input_tokens）；没有明细时不设 */
  create1h?: number;
  /** usage.speed === 'fast' */
  fast?: true;
  /** usage.inference_geo === 'us'（价格 ×1.1） */
  usGeo?: true;
}

/** 一次会话压缩（compact_boundary）：只含主线程 */
export interface CompactMark {
  /** compact_boundary 的 uuid（去重用） */
  id: string;
  /** 发生在第几轮（回退时按它截断） */
  turn: number;
  trigger: 'auto' | 'manual';
  /** 压缩前 / 后的上下文 token（CLI 报告） */
  pre: number;
  post: number | null;
  /** 压缩耗时（毫秒） */
  durationMs: number | null;
  /** 压缩前最后一次请求的 CachePoint id（图上把标记画在它之后）；会话开头就压缩时为 null */
  after: string | null;
  /** 时间戳（毫秒） */
  at: number;
}

export interface SessionMeta {
  sessionId?: string;
  model?: string;
  cwd?: string;
  tools?: string[];
  slashCommands?: string[];
  skills?: string[];
  agents?: string[];
  mcpServers?: { name: string; status: string }[];
  /** 缓存命中率走势：每次 API 请求一个点（只含主线程，按 message.id 去重） */
  cache?: CachePoint[];
  /** 会话压缩记录（主线程，按发生顺序） */
  compactions?: CompactMark[];
  /** 最近一次 result 事件的 modelUsage（CLI 自己算的本进程累计花费，用来核对价格表）；只有实时会话有 */
  cliCost?: CliModelCost[];
}

export interface Conversation {
  turns: Turn[];
  meta: SessionMeta;
}
