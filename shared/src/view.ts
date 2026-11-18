// 会话流视图模型。web/src/core/reducer.ts 把 CLI 事件（实时）或 jsonl 条目（历史）归约成这里的结构，
// web/src/ui/flow 只负责渲染。规则见 SPEC.md §4。

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
  /** 子代理的 agent id（= 后台任务的 task_id）；SendMessage 恢复时靠它找回原来的子代理 */
  taskId?: string;
  /** 实际使用的模型：子代理 assistant 消息里的 model；还没有输出时取 Agent 调用参数里的 model（如 sonnet） */
  model?: string;
  /** Agent 调用参数里指定的思考等级；未指定时为空，UI 显示「继承主会话」 */
  effort?: string;
  status: 'running' | 'done' | 'error';
  /** 子代理自己的会话流（只有一轮；不会再有 subagents） */
  turn: Turn;
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
}

export interface Conversation {
  turns: Turn[];
  meta: SessionMeta;
}
