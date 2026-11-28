// Claude 空闲补点探测器 + /api/usage 快照包装器：
// - 当某个 Claude 订阅账号在最近 5 小时内有过账本活动、且当前没有运行中的进程时，
//   每 5 分钟通过 deps.getUsage(accountId)（复用 server.ts 的 UsageProvider 缓存）补一个快照（source='probe'）；
// - 5 小时内无活动不探测；API / Kiro 账号不探测；正在运行中不探测（由 rate_limit_event 推送）；
// - 包装 /api/usage 调用：主动查额度拿到 UsageInfo 时同样记入账本快照。
import type { LedgerAccountKind, UsageInfo } from '@cosyee/shared';
import { FIVE_HOURS_MS } from '../sink.js';
import { recordClaudeUsageSnapshot } from './claudeSnapshots.js';
import { lastActivityOf } from './common.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export interface LedgerProbeDeps {
  /** 复用 server.ts 的 UsageProvider 缓存获取 Claude 订阅额度（不应抛错，失败返回 null） */
  getUsage(accountId: string): Promise<UsageInfo | null>;
  /** 该账号当前是否有运行中的 Claude 进程（主会话 + Claude 委派） */
  isRunning(accountId: string): boolean;
  /** 账号计费类型（仅 'subscription' 参与 Claude 空闲探测） */
  accountKind(accountId: string): LedgerAccountKind;
  /** 列出全部 Claude 账号 id（包含 'default'） */
  listClaudeAccounts(): string[];
  /** 探测间隔（毫秒），默认 5 分钟 */
  intervalMs?: number;
  /** 活跃判定窗口（毫秒），默认 5 小时（FIVE_HOURS_MS） */
  activeWindowMs?: number;
  now?: () => number;
}

export interface LedgerProbeHandle {
  /** 立即执行一轮检查（主要供测试调用） */
  tick(): Promise<void>;
  /** 停止定时器 */
  stop(): void;
}

/**
 * 启动 Claude 空闲额度补点定时器。返回停止句柄（含 stop() 与 tick()）。
 * 所有回调均包 try/catch，绝不向外抛错。
 */
export function startLedgerProbes(deps: LedgerProbeDeps): LedgerProbeHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
  const activeWindowMs = deps.activeWindowMs ?? FIVE_HOURS_MS;
  const now = deps.now ?? Date.now;
  const inflight = new Set<string>();
  let stopped = false;

  const probeAccount = async (id: string): Promise<void> => {
    if (stopped || inflight.has(id)) return;
    inflight.add(id);
    try {
      const info = await deps.getUsage(id);
      if (!stopped && info) {
        recordClaudeUsageSnapshot(info, id, 'subscription', 'probe');
      }
    } catch { /* 绝不影响正常服务 */ } finally {
      inflight.delete(id);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    let ids: string[];
    try {
      ids = deps.listClaudeAccounts();
    } catch {
      return;
    }
    const ts = now();
    const tasks: Promise<void>[] = [];
    for (const id of ids) {
      try {
        if (deps.accountKind(id) !== 'subscription') continue;
        if (deps.isRunning(id)) continue;
        const last = lastActivityOf('claude', id);
        if (last === null || ts - last > activeWindowMs) continue;
        tasks.push(probeAccount(id));
      } catch { /* 单账号检查失败不影响其它账号 */ }
    }
    if (tasks.length) await Promise.all(tasks);
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return {
    tick,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * 包装 server.ts 的 `/api/usage` 获取函数：
 * 原样透传返回值与异常，但在成功拿到 UsageInfo 时顺便写入一条账本快照（source='probe'）。
 */
export function wrapClaudeUsageFetch(
  accountId: string,
  accountKind: LedgerAccountKind,
  promise: Promise<UsageInfo | null>,
): Promise<UsageInfo | null> {
  if (accountKind !== 'subscription') return promise;
  return promise.then((info) => {
    if (info) recordClaudeUsageSnapshot(info, accountId, accountKind, 'probe');
    return info;
  });
}
