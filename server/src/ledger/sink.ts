// 账本写入入口（采集端 → 账本核心的契约）。
// 采集端（manager.ts / jobs.ts / codex.ts / agy / kiro / 空闲探测）只 import 本文件的 `ledger`，
// 调用 ledger.record(...) / ledger.snapshot(...)。本文件保证：
// - 永不抛异常（内部 try/catch 吞掉），永不阻塞（同步入队即返回）；
// - 账本核心未初始化（setLedgerSink 未调用）或已停用时为空操作。
// 「绝对不能影响正常请求」：采集端调用前后也不要 await、不要改变原有控制流。
import type { LedgerAccountKind, LedgerBackend, LedgerLayer, LedgerWindowKind } from '@cosyee/shared';

/** 一次模型请求。主键 = backend + id；同主键再次写入为 upsert：token 字段取较大值，其余非空字段覆盖。 */
export interface LedgerRequest {
  backend: LedgerBackend;
  /** 请求 id：Claude = API message.id；Codex = `${threadId}:${turnId}:${序号}`；agy = `${sessionId}:${轮次}:${序号}`；内部调用差额 = `${sessionId}:internal:${resultUuid 或 序号}` */
  id: string;
  /** 请求时间（毫秒，首次写入为准） */
  at: number;
  /** 账号 id（与账号管理里的 id 一致；Claude 默认账号为 'default'） */
  account: string;
  accountKind: LedgerAccountKind;
  /** Cosyee 会话 id（委派为父会话 id）；拿不到为 null */
  session: string | null;
  layer: LedgerLayer;
  /** 原生子代理 subagent_type / 委派 agent 名 */
  agent: string | null;
  /** 原生子代理 parent_tool_use_id / 委派的 toolUseId */
  toolUseId: string | null;
  model: string | null;
  effort: string | null;
  input: number;
  create5m: number;
  create1h: number;
  read: number;
  output: number;
  reasoning: number;
  fast: boolean;
  usGeo: boolean;
  /** 按比例分摊的估算值（agy 一轮多次请求） */
  estimated: boolean;
}

/** 一次额度快照。 */
export interface LedgerSnapshot {
  backend: LedgerBackend;
  account: string;
  accountKind: LedgerAccountKind;
  kind: LedgerWindowKind;
  /** scoped：模型名（如 'opus' / 'sonnet'）；agy：模型组名（quotaGroupName 的结果）；其它 null */
  group: string | null;
  /** 快照时间（毫秒） */
  at: number;
  /** 已用百分比 0–100 */
  percent: number;
  /** 窗口重置时间（毫秒）；拿不到为 null（这种快照不参与窗口切分，只保留） */
  resetsAt: number | null;
  /** 窗口时长（毫秒）：5h = 18_000_000，周 = 604_800_000；Codex 用 windowDurationMins；Kiro 月按 resetsAt 往前推一个自然月可传 null */
  windowMs: number | null;
  source: 'event' | 'probe';
  /** Kiro credits */
  used?: number | null;
  limit?: number | null;
}

export interface LedgerSink {
  record(r: LedgerRequest): void;
  snapshot(s: LedgerSnapshot): void;
}

let sink: LedgerSink | null = null;
let warned = false;

export function setLedgerSink(s: LedgerSink | null): void {
  sink = s;
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    if (!warned) {
      warned = true;
      console.warn('[ledger] 采集异常（已忽略，不影响请求）:', e);
    }
  }
}

export const ledger: LedgerSink = {
  record(r) {
    if (sink) guard(() => sink!.record(r));
  },
  snapshot(s) {
    if (sink) guard(() => sink!.snapshot(s));
  },
};

/** 常用窗口时长 */
export const FIVE_HOURS_MS = 5 * 3600_000;
export const WEEK_MS = 7 * 24 * 3600_000;
