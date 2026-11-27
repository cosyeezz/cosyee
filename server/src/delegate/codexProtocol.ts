// Codex app-server（codex app-server --listen stdio://）v2 协议的精简类型子集 + 运行时防错解析。
// 依据：codex-cli 0.144.6 用 `codex app-server generate-ts` 导出的类型（v2/ 下）；只写我们用到的字段，其余忽略。
// 线路格式：按行 JSON；app-server 回的消息不带 "jsonrpc" 字段，我们发的也可以不带（带上无害，沿用 2.0 写法）。

/**
 * 最低支持的 codex-cli 版本。
 * 依据：app-server v2 的 thread/start（developerInstructions / sandbox / approvalPolicy）、turn/start（sandboxPolicy / effort）、
 * thread/unsubscribe、model/list（isDefault / supportedReasoningEfforts）、account/rateLimits/read 在 0.144 导出的协议里齐全；
 * 更早的版本没有逐项核对过，不保证兼容。
 */
export const MIN_CODEX_VERSION = '0.144.0';

export type JsonObj = Record<string, any>;

// ───────────── 请求参数 / 响应 ─────────────

export interface InitializeParams {
  clientInfo: { name: string; title?: string | null; version: string };
  capabilities: { experimentalApi: boolean; requestAttestation?: boolean; optOutNotificationMethods?: string[] | null } | null;
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type AskForApproval = 'untrusted' | 'on-request' | 'never';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };

export interface ThreadStartParams {
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  developerInstructions?: string | null;
  ephemeral?: boolean | null;
}

export interface ThreadResumeParams {
  threadId: string;
  model?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, unknown> | null;
  developerInstructions?: string | null;
}

export interface ThreadOpenResult {
  threadId: string;
  model: string | null;
  effort: string | null;
}

export type UserInput = { type: 'text'; text: string; text_elements: unknown[] };

export interface TurnStartParams {
  threadId: string;
  input: UserInput[];
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  effort?: string | null;
}

export type TurnStatus = 'completed' | 'interrupted' | 'failed' | 'inProgress';

export interface TurnError {
  message: string;
  codexErrorInfo: unknown;
  additionalDetails: string | null;
}

export interface TurnInfo {
  id: string;
  status: TurnStatus;
  error: TurnError | null;
}

export interface TokenUsageBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  hidden: boolean;
  isDefault: boolean;
  defaultReasoningEffort: string | null;
  supportedReasoningEfforts: string[];
}

export interface ModelListPage {
  data: CodexModel[];
  nextCursor: string | null;
}

export interface CodexAccountInfo {
  /** null = 没有登录（requiresOpenaiAuth 为 true 时） */
  account: { type: 'apiKey' } | { type: 'chatgpt'; email: string | null; planType: string | null } | { type: 'amazonBedrock' } | { type: string } | null;
  requiresOpenaiAuth: boolean;
}

export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  planType: string | null;
  /** 原样保留，供上层按需取 credits 等字段 */
  raw: JsonObj;
}

// ───────────── 服务端通知 / 请求的方法名 ─────────────

export const N = {
  threadStarted: 'thread/started',
  threadTokenUsage: 'thread/tokenUsage/updated',
  threadClosed: 'thread/closed',
  turnStarted: 'turn/started',
  turnCompleted: 'turn/completed',
  turnPlanUpdated: 'turn/plan/updated',
  itemStarted: 'item/started',
  itemCompleted: 'item/completed',
  agentMessageDelta: 'item/agentMessage/delta',
  planDelta: 'item/plan/delta',
  reasoningSummaryDelta: 'item/reasoning/summaryTextDelta',
  reasoningTextDelta: 'item/reasoning/textDelta',
  reasoningSummaryPartAdded: 'item/reasoning/summaryPartAdded',
  commandOutputDelta: 'item/commandExecution/outputDelta',
  fileChangePatchUpdated: 'item/fileChange/patchUpdated',
  mcpProgress: 'item/mcpToolCall/progress',
  error: 'error',
  rateLimitsUpdated: 'account/rateLimits/updated',
  accountUpdated: 'account/updated',
} as const;

export const SR = {
  commandApproval: 'item/commandExecution/requestApproval',
  fileApproval: 'item/fileChange/requestApproval',
  permissionsApproval: 'item/permissions/requestApproval',
  userInput: 'item/tool/requestUserInput',
  elicitation: 'mcpServer/elicitation/request',
  dynamicTool: 'item/tool/call',
  authRefresh: 'account/chatgptAuthTokens/refresh',
  attestation: 'attestation/generate',
  legacyPatchApproval: 'applyPatchApproval',
  legacyExecApproval: 'execCommandApproval',
} as const;

// ───────────── 运行时防错解析 ─────────────

const isObj = (v: unknown): v is JsonObj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 通知所属线程：大多数在 params.threadId，thread/started 在 params.thread.id */
export function threadIdOf(params: unknown): string | null {
  if (!isObj(params)) return null;
  return str(params.threadId) ?? (isObj(params.thread) ? str(params.thread.id) : null);
}

/** 通知所属 turn：params.turnId 或 params.turn.id */
export function turnIdOf(params: unknown): string | null {
  if (!isObj(params)) return null;
  return str(params.turnId) ?? (isObj(params.turn) ? str(params.turn.id) : null);
}

export function parseTurn(v: unknown): TurnInfo | null {
  if (!isObj(v)) return null;
  const id = str(v.id);
  if (!id) return null;
  const s = str(v.status);
  const status: TurnStatus = s === 'completed' || s === 'interrupted' || s === 'failed' || s === 'inProgress' ? s : 'inProgress';
  const e = isObj(v.error) ? v.error : null;
  return {
    id,
    status,
    error: e ? { message: str(e.message) ?? '', codexErrorInfo: e.codexErrorInfo ?? null, additionalDetails: str(e.additionalDetails) } : null,
  };
}

/** thread/start 或 thread/resume 的响应 */
export function parseThreadOpen(res: unknown): ThreadOpenResult {
  const r = isObj(res) ? res : {};
  const threadId = isObj(r.thread) ? str(r.thread.id) : null;
  if (!threadId) throw new Error('thread/start 没有返回 thread.id');
  return { threadId, model: str(r.model), effort: str(r.reasoningEffort) };
}

/** turn/start 的响应 → turn id */
export function parseTurnStart(res: unknown): string | null {
  return isObj(res) && isObj(res.turn) ? str(res.turn.id) : null;
}

export interface ParsedTokenUsage {
  total: TokenUsageBreakdown;
  last: TokenUsageBreakdown;
  modelContextWindow: number | null;
}

export function parseTokenUsage(v: unknown): ParsedTokenUsage | null {
  if (!isObj(v)) return null;
  const b = (x: unknown): TokenUsageBreakdown | null => {
    if (!isObj(x)) return null;
    return {
      totalTokens: num(x.totalTokens) ?? 0,
      inputTokens: num(x.inputTokens) ?? 0,
      cachedInputTokens: num(x.cachedInputTokens) ?? 0,
      outputTokens: num(x.outputTokens) ?? 0,
      reasoningOutputTokens: num(x.reasoningOutputTokens) ?? 0,
    };
  };
  const total = b(v.total);
  if (!total) return null;
  const rawWin = num(v.modelContextWindow);
  const modelContextWindow = rawWin !== null && rawWin > 0 ? rawWin : null;
  return { total, last: b(v.last) ?? total, modelContextWindow };
}

export function parseModelPage(res: unknown): ModelListPage {
  const r = isObj(res) ? res : {};
  const data: CodexModel[] = [];
  for (const m of Array.isArray(r.data) ? r.data : []) {
    if (!isObj(m)) continue;
    const model = str(m.model) ?? str(m.id);
    if (!model) continue;
    const efforts: string[] = [];
    for (const o of Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []) {
      const e = isObj(o) ? str(o.reasoningEffort) : str(o);
      if (e && !efforts.includes(e)) efforts.push(e);
    }
    data.push({
      id: str(m.id) ?? model,
      model,
      displayName: str(m.displayName) || model,
      hidden: m.hidden === true,
      isDefault: m.isDefault === true,
      defaultReasoningEffort: str(m.defaultReasoningEffort),
      supportedReasoningEfforts: efforts,
    });
  }
  return { data, nextCursor: str(r.nextCursor) || null };
}

export function parseAccount(res: unknown): CodexAccountInfo {
  const r = isObj(res) ? res : {};
  const a = isObj(r.account) ? r.account : null;
  let account: CodexAccountInfo['account'] = null;
  if (a) {
    const type = str(a.type) ?? 'unknown';
    account = type === 'chatgpt' ? { type, email: str(a.email), planType: str(a.planType) } : { type };
  }
  return { account, requiresOpenaiAuth: r.requiresOpenaiAuth === true };
}

function parseWindow(v: unknown): RateLimitWindow | null {
  if (!isObj(v)) return null;
  const used = num(v.usedPercent);
  if (used === null) return null;
  return { usedPercent: used, windowDurationMins: num(v.windowDurationMins), resetsAt: num(v.resetsAt) };
}

export function parseRateLimitSnapshot(v: unknown): RateLimitSnapshot | null {
  if (!isObj(v)) return null;
  return {
    limitId: str(v.limitId),
    limitName: str(v.limitName),
    primary: parseWindow(v.primary),
    secondary: parseWindow(v.secondary),
    planType: str(v.planType),
    raw: v,
  };
}

/** account/rateLimits/read 的响应：取 rateLimits（单桶视图） */
export function parseRateLimitsResponse(res: unknown): RateLimitSnapshot | null {
  return isObj(res) ? parseRateLimitSnapshot(res.rateLimits) : null;
}

// ───────────── 协议不兼容判定 ─────────────

/** JSON-RPC 的 method not found */
export const RPC_METHOD_NOT_FOUND = -32601;

export class RpcError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * 是否「协议不兼容」：服务端不认识我们发的方法（-32601）、不认识的子命令 / 参数（CLI 太旧：app-server 子命令不存在、
 * `--listen` 不被识别），或握手响应根本不是 JSON-RPC。运行期据此降级：标记后端不可用，提示升级组件。
 */
export function isProtocolIncompatible(e: unknown): boolean {
  if (e instanceof RpcError && e.code === RPC_METHOD_NOT_FOUND) return true;
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /method not found|unrecognized subcommand|unexpected argument|unknown (?:option|command|variant)|invalid (?:request|params)\b.*unknown field|Found argument '.*' which wasn't expected/i.test(msg);
}

/** 版本号比较：a < b 返回 true（只比较数字段，忽略预发布后缀） */
export function versionLess(a: string, b: string): boolean {
  const pa = a.split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = b.split(/[.+-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const y = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (x !== y) return x < y;
  }
  return false;
}

/** 从 `codex --version` 的输出（codex-cli 0.144.6）里取版本号 */
export function parseCodexVersion(out: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(out);
  return m ? m[1]! : null;
}
