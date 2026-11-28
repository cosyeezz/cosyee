// 委派任务用量采集（jobs.ts 的 onUsage 挂钩）：
// 支持 claude / codex / agy 三个委派后端；Kiro 账号走 claude 后端、accountKind='kiro'。
// 所有函数内部 try/catch，绝不抛错、绝不阻塞。
import type { CachePoint, LedgerAccountKind, LedgerBackend } from '@cosyee/shared';
import { cachePointToRequest, emitLedgerRequest } from './common.js';

export interface DelegateUsageMeta {
  backend: LedgerBackend;
  account: string;
  accountKind: LedgerAccountKind;
  /** 父会话 id（拿不到为 null） */
  session: string | null;
  /** 委派 agent 名称（job.agent.name） */
  agent: string;
  /** 委派 toolUseId */
  toolUseId: string | null;
  /** 后端会话 id（当 point.id 不具备全局唯一前缀时用于兜底拼前缀） */
  backendSessionId?: string | null;
  effort: string | null;
  reasoning?: number;
  at: number;
}

/** 构造全局唯一的账本请求 id：Claude 用 API message.id，Codex/agy 适配器已带 `codex:`/`agy:` 前缀，否则补前缀 */
export function resolveDelegateRequestId(
  backend: LedgerBackend,
  pointId: string,
  backendSessionId?: string | null,
): string {
  if (backend === 'claude') return pointId;
  if (pointId.includes(':')) return pointId;
  const sess = backendSessionId || 'unknown';
  return `${backend}:${sess}:${pointId}`;
}

export function isLedgerBackend(id: string): id is LedgerBackend {
  return id === 'claude' || id === 'codex' || id === 'agy';
}

/** 将委派后端上报的单个 CachePoint 写入账本 */
export function recordDelegateUsage(point: CachePoint, meta: DelegateUsageMeta): void {
  try {
    if (!point.id) return;
    const id = resolveDelegateRequestId(meta.backend, point.id, meta.backendSessionId);
    const req = cachePointToRequest(point, {
      backend: meta.backend,
      id,
      at: meta.at,
      account: meta.account,
      accountKind: meta.accountKind,
      session: meta.session,
      layer: 'delegate',
      agent: meta.agent,
      toolUseId: meta.toolUseId,
      effort: meta.effort,
      reasoning: meta.reasoning,
    });
    emitLedgerRequest(req);
  } catch { /* 绝不影响正常请求 */ }
}
