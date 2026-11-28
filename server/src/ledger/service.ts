// 订阅用量账本：对外服务入口（串联 SQLite 存储 + 窗口计算）。
import type {
  LedgerBackend,
  LedgerWindowDetail,
  LedgerWindowKind,
  LedgerWindowList,
  PriceTable,
} from '@cosyee/shared';
import type { LedgerRequest, LedgerSink } from './sink.js';
import { LedgerStore, RETENTION_MS } from './store.js';
import {
  EXTERNAL_TOLERANCE_MS,
  buildWindowDetail,
  parseWindowId,
  sliceWindowShells,
  toWindowSummary,
} from './windows.js';

export interface LedgerServiceOptions {
  /** SQLite 文件路径（默认 ~/.cosyee/usage-ledger.sqlite；测试可传 ':memory:'） */
  path?: string;
  /** 获取当前有效价格表 */
  prices: () => PriceTable;
  /** 查询账号显示名；查不到返回 null */
  accountInfo: (backend: LedgerBackend, account: string) => { name: string | null } | null;
  /** 时间源（测试可注入） */
  now?: () => number;
}

export interface LedgerWindowFilter {
  backend?: LedgerBackend;
  account?: string;
  kind?: LedgerWindowKind;
}

export interface LedgerService {
  sink: LedgerSink;
  list(filter?: LedgerWindowFilter): LedgerWindowList;
  detail(id: string): LedgerWindowDetail | null;
  enabled(): boolean;
  close(): void;
}

export function createLedger(opts: LedgerServiceOptions): LedgerService {
  const now = opts.now ?? Date.now;
  const store = new LedgerStore({ path: opts.path, now });

  const resolveAccountName = (backend: LedgerBackend, account: string): string | null => {
    try {
      return opts.accountInfo(backend, account)?.name ?? null;
    } catch {
      return null;
    }
  };

  return {
    sink: store,

    enabled(): boolean {
      return store.enabled();
    },

    list(filter: LedgerWindowFilter = {}): LedgerWindowList {
      if (!store.enabled()) return { windows: [], enabled: false };
      const currentNow = now();
      const sinceAt = currentNow - RETENTION_MS;
      const snapshots = store.querySnapshots({
        backend: filter.backend,
        account: filter.account,
        kind: filter.kind,
        sinceAt,
      });
      if (!store.enabled()) return { windows: [], enabled: false };
      if (snapshots.length === 0) return { windows: [], enabled: true };

      const shells = sliceWindowShells(snapshots);
      if (shells.length === 0) return { windows: [], enabled: true };

      // 按 (backend, account) 汇总最小/最大时间范围，利用 (backend, account, at) 索引分账号查询
      const ranges = new Map<string, { backend: LedgerBackend; account: string; minAt: number; maxAt: number }>();
      for (const sh of shells) {
        const key = `${sh.backend}\0${sh.account}`;
        const existing = ranges.get(key);
        const lo = sh.start - EXTERNAL_TOLERANCE_MS;
        const hi = Math.min(sh.end, currentNow) + EXTERNAL_TOLERANCE_MS;
        if (!existing) {
          ranges.set(key, { backend: sh.backend, account: sh.account, minAt: lo, maxAt: hi });
        } else {
          if (lo < existing.minAt) existing.minAt = lo;
          if (hi > existing.maxAt) existing.maxAt = hi;
        }
      }

      const requestsByAccount = new Map<string, LedgerRequest[]>();
      for (const [key, r] of ranges) {
        requestsByAccount.set(
          key,
          store.queryRequests({
            backend: r.backend,
            account: r.account,
            sinceAt: r.minAt,
            untilAt: r.maxAt,
          }),
        );
      }

      const prices = opts.prices();
      const nameCache = new Map<string, string | null>();
      const getName = (backend: LedgerBackend, account: string): string | null => {
        const k = `${backend}\0${account}`;
        if (!nameCache.has(k)) nameCache.set(k, resolveAccountName(backend, account));
        return nameCache.get(k) ?? null;
      };

      const windows = shells.map((sh) => {
        const reqs = requestsByAccount.get(`${sh.backend}\0${sh.account}`) ?? [];
        return toWindowSummary(
          buildWindowDetail(sh, reqs, {
            prices,
            now: currentNow,
            accountName: getName(sh.backend, sh.account),
          }),
        );
      });

      return { windows, enabled: store.enabled() };
    },

    detail(id: string): LedgerWindowDetail | null {
      if (!store.enabled()) return null;
      const parsed = parseWindowId(id);
      if (!parsed) return null;

      const currentNow = now();
      const sinceAt = currentNow - RETENTION_MS;
      const snapshots = store.querySnapshots({
        backend: parsed.backend,
        account: parsed.account,
        kind: parsed.kind,
        group: parsed.group,
        sinceAt,
      });
      if (snapshots.length === 0) return null;

      const shells = sliceWindowShells(snapshots);
      const shell = shells.find((sh) => sh.id === id);
      if (!shell) return null;

      const requests = store.queryRequests({
        backend: shell.backend,
        account: shell.account,
        sinceAt: shell.start - EXTERNAL_TOLERANCE_MS,
        untilAt: Math.min(shell.end, currentNow) + EXTERNAL_TOLERANCE_MS,
      });

      return buildWindowDetail(shell, requests, {
        prices: opts.prices(),
        now: currentNow,
        accountName: resolveAccountName(shell.backend, shell.account),
      });
    },

    close(): void {
      store.close();
    },
  };
}
