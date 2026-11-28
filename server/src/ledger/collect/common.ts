// 账本采集通用工具：时间换算、百分比归一、最近活动时间追踪（供空闲补点判断）与 CachePoint → LedgerRequest 换算。
import type { CachePoint, LedgerAccountKind, LedgerBackend, LedgerLayer } from '@cosyee/shared';
import { type LedgerRequest, ledger } from '../sink.js';

export type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function posNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** Epoch 秒或毫秒（或 ISO 字符串）→ 毫秒；非法 / 非正返回 null */
export function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
    return v < 1e12 ? Math.round(v * 1000) : Math.round(v);
  }
  if (typeof v === 'string' && v.trim()) {
    const t = Date.parse(v);
    return Number.isFinite(t) && t > 0 ? Math.round(t) : null;
  }
  return null;
}

/** 百分比限幅到 [0, 100]，保留至多两位小数 */
export function clampPercent(v: number): number {
  if (!Number.isFinite(v)) return 0;
  const clamped = Math.max(0, Math.min(100, v));
  return Math.round(clamped * 100) / 100;
}

/**
 * 0–1 小数或 0–100 百分比 → 0–100 百分比。
 * Claude rate_limit_event 的 utilization 是 0–1 小数（0 = 0%，1 = 100%）；
 * 若遇到 > 1 的数值则视为已是 0–100 百分比。
 */
export function utilizationToPercent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
  const pct = v <= 1 ? v * 100 : v;
  return clampPercent(pct);
}

/** 账号最近一次在 Cosyee 内产生账本活动的时间（毫秒），key = `${backend}\0${account}` */
const activityMap = new Map<string, number>();

export function recordActivity(backend: LedgerBackend, account: string, at: number = Date.now()): void {
  const key = `${backend}\0${account}`;
  const prev = activityMap.get(key) ?? 0;
  if (at > prev) activityMap.set(key, at);
}

export function lastActivityOf(backend: LedgerBackend, account: string): number | null {
  return activityMap.get(`${backend}\0${account}`) ?? null;
}

/** 测试用：清空活动记录 */
export function clearActivityForTest(): void {
  activityMap.clear();
}

export interface PointRecordMeta {
  backend: LedgerBackend;
  id: string;
  at: number;
  account: string;
  accountKind: LedgerAccountKind;
  session: string | null;
  layer: LedgerLayer;
  agent: string | null;
  toolUseId: string | null;
  effort: string | null;
  reasoning?: number;
}

/** CachePoint → LedgerRequest（注意 create 是总缓存写入，create5m = create - create1h） */
export function cachePointToRequest(point: CachePoint, meta: PointRecordMeta): LedgerRequest {
  const input = posNum(point.input);
  const totalCreate = posNum(point.create);
  const create1h = Math.min(posNum(point.create1h), totalCreate);
  const create5m = Math.max(0, totalCreate - create1h);
  const read = posNum(point.read);
  const output = posNum(point.output);
  const reasoning = posNum(meta.reasoning);
  return {
    backend: meta.backend,
    id: meta.id,
    at: meta.at,
    account: meta.account,
    accountKind: meta.accountKind,
    session: meta.session,
    layer: meta.layer,
    agent: meta.agent,
    toolUseId: meta.toolUseId,
    model: point.model && !point.model.startsWith('<') ? point.model : null,
    effort: meta.effort,
    input,
    create5m,
    create1h,
    read,
    output,
    reasoning,
    fast: point.fast === true,
    usGeo: point.usGeo === true,
    estimated: point.estimated === true,
  };
}

/** 写入一条请求并同步刷新该账号的最近活动时间；内部 try/catch，永不抛错 */
export function emitLedgerRequest(req: LedgerRequest): void {
  try {
    recordActivity(req.backend, req.account, req.at);
    ledger.record(req);
  } catch { /* 绝不影响正常请求 */ }
}
