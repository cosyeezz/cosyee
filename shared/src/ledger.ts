// 订阅用量账本：服务端 → 前端的接口类型。
// 账本按「每次模型请求」记 token，按「额度快照」切出每个额度窗口（5 小时 / 周 / 按模型的周额度 / 月），
// 查询时用当前价格表现算等效 API 花费，并用窗口内「花费 ÷ 百分比增量」推算 100% 额度约合多少美元。
//
// 接口：
//   GET /api/ledger/windows?backend=&account=&kind=   → LedgerWindowList（按 end 倒序）
//   GET /api/ledger/windows/:id（id 需 encodeURIComponent） → LedgerWindowDetail；不存在 404

/** 发出请求的后端：claude = Claude CLI（主会话 / 原生子代理 / Claude 委派，含 API 与 Kiro 账号）；codex / agy = 委派后端 */
export type LedgerBackend = 'claude' | 'codex' | 'agy';

/** 账号计费类型：subscription = 订阅额度（Claude Pro/Max、Codex Plus/Pro、Antigravity）；api = API Key / 中转；kiro = Kiro credits */
export type LedgerAccountKind = 'subscription' | 'api' | 'kiro';

/** 请求层级：main = 主代理；native = CLI 原生子代理（Agent/Task）；delegate = Cosyee 委派；internal = 自动标题 / compact / WebSearch 等内部调用（按每轮总量差额兜底） */
export type LedgerLayer = 'main' | 'native' | 'delegate' | 'internal';

/** 额度窗口种类：session = 5 小时；weekly = 周；scoped = 按模型的周额度（group = 模型名）；monthly = 月（Kiro credits） */
export type LedgerWindowKind = 'session' | 'weekly' | 'scoped' | 'monthly';

export interface LedgerTokens {
  /** 未命中缓存的输入 */
  input: number;
  /** 写入 5 分钟缓存 */
  create5m: number;
  /** 写入 1 小时缓存 */
  create1h: number;
  /** 命中缓存 */
  read: number;
  /** 输出（Codex / Antigravity 已含推理 token） */
  output: number;
  /** 其中推理 token（只有 Codex / Antigravity 有；已含在 output 里，仅供展示） */
  reasoning: number;
}

export interface LedgerEstimate {
  /** 推算的 100% 额度约合多少美元；增量不足（< 5 个百分点）或数据不可靠时为 null */
  usdPer100: number | null;
  /** 推算所用的百分比增量（百分点） */
  basisPercent: number;
  /** 推算所用的花费（美元） */
  basisCost: number;
  /** false = 窗口内检测到 Cosyee 外部用量或其它不可靠因素（推算值仅供参考） */
  reliable: boolean;
}

export interface LedgerWindowSummary {
  /** 窗口 id：`${backend}|${account}|${kind}|${group ?? ''}|${end}`，作为 /api/ledger/windows/:id 的参数 */
  id: string;
  backend: LedgerBackend;
  account: string;
  /** 账号显示名（取不到时为 null） */
  accountName: string | null;
  accountKind: LedgerAccountKind;
  kind: LedgerWindowKind;
  /** scoped = 模型名；Antigravity = 模型组名（如 Gemini、Claude · GPT）；其它为 null */
  group: string | null;
  /** 窗口起点（毫秒）= end - 窗口时长 */
  start: number;
  /** 窗口终点（毫秒）= 重置时间 */
  end: number;
  /** 当前时间仍在窗口内 */
  current: boolean;
  /** 窗口内第一个 / 最后一个额度快照的百分比与时间；窗口内没有快照时为 null */
  startPercent: number | null;
  endPercent: number | null;
  firstSnapshotAt: number | null;
  lastSnapshotAt: number | null;
  /** Kiro credits：最后一次快照的已用 / 总额 */
  used?: number | null;
  limit?: number | null;
  /** 窗口内账本请求数（该账号、该窗口匹配的请求） */
  requests: number;
  tokens: LedgerTokens;
  /** 等效 API 花费（美元，不含无价格的模型） */
  costUsd: number;
  /** 价格表里找不到的请求数 */
  unpricedRequests: number;
  estimate: LedgerEstimate;
  /** 检测到 Cosyee 外部用量：相邻快照之间百分比上涨 ≥ 2 个百分点，但账本里没有该账号的请求 */
  external: boolean;
}

export interface LedgerWindowList {
  windows: LedgerWindowSummary[];
  /** 账本是否在工作（写库失败自动停用时为 false） */
  enabled: boolean;
}

export interface LedgerBreakdownRow {
  model: string | null;
  layer: LedgerLayer;
  /** 原生子代理的 subagent_type / 委派的 agent 名；主代理与内部调用为 null */
  agent: string | null;
  requests: number;
  tokens: LedgerTokens;
  costUsd: number;
  /** 价格表里找不到的请求数 */
  unpricedRequests: number;
  /** 含按比例分摊的估算请求（Antigravity 一轮多次请求） */
  estimated: boolean;
}

export interface LedgerSnapshotPoint {
  at: number;
  percent: number;
  source: 'event' | 'probe';
}

export interface LedgerWindowDetail extends LedgerWindowSummary {
  /** 按 模型 × 层级 × agent 聚合，按花费倒序 */
  rows: LedgerBreakdownRow[];
  /** 窗口内额度快照，按时间正序（相邻重复值已合并） */
  snapshots: LedgerSnapshotPoint[];
}
