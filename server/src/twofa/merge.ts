// 2FA 同步快照的纯函数合并：按 id 逐行合并，updatedAt 较新者胜，平局取 version 较高者，再平局取远端；删除标记（deletedAt）随行传播。
import type { SnapshotEntry, SnapshotGroup, SnapshotTag, TwoFaSnapshot } from './types.js';

interface VersionedRow {
  id: string;
  updatedAt: string;
  version: number;
}

/** 比较两个 ISO 时间戳；优先按毫秒时间戳比较，无法解析时回退字典序 */
function compareUpdatedAt(a: string, b: string): number {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
    return ta > tb ? 1 : -1;
  }
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

/** 从本地与远端同一 id 的两行中选出胜出者：updatedAt 较新 > version 较高 > remote */
function pickWinner<T extends VersionedRow>(local: T, remote: T): T {
  const cmp = compareUpdatedAt(local.updatedAt, remote.updatedAt);
  if (cmp > 0) return local;
  if (cmp < 0) return remote;
  if (local.version > remote.version) return local;
  if (local.version < remote.version) return remote;
  return remote;
}

function mergeRows<T extends VersionedRow>(local: readonly T[], remote: readonly T[]): T[] {
  const localMap = new Map<string, T>();
  for (const row of local) localMap.set(row.id, row);

  const remoteMap = new Map<string, T>();
  for (const row of remote) remoteMap.set(row.id, row);

  const ids = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
  const out: T[] = [];
  for (const id of [...ids].sort()) {
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    if (l && r) out.push(structuredClone(pickWinner(l, r)));
    else if (l) out.push(structuredClone(l));
    else if (r) out.push(structuredClone(r));
  }
  return out;
}

function normalizeEntry(e: SnapshotEntry): Record<string, unknown> {
  return {
    id: e.id,
    issuer: e.issuer,
    account: e.account,
    secret: e.secret,
    algorithm: e.algorithm,
    digits: e.digits,
    period: e.period,
    groupId: e.groupId,
    pinned: e.pinned,
    tags: [...e.tags],
    note: e.note ?? null,
    sort: e.sort,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    deletedAt: e.deletedAt ?? null,
    version: e.version,
  };
}

function normalizeGroup(g: SnapshotGroup): Record<string, unknown> {
  return {
    id: g.id,
    parentId: g.parentId,
    name: g.name,
    sort: g.sort,
    updatedAt: g.updatedAt,
    deletedAt: g.deletedAt ?? null,
    version: g.version,
  };
}

function normalizeTag(t: SnapshotTag): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    color: t.color,
    updatedAt: t.updatedAt,
    deletedAt: t.deletedAt ?? null,
    version: t.version,
  };
}

/** 规范化快照序列化，用于精确比较两个快照内容是否完全等价 */
export function canonicalSnapshotKey(s: TwoFaSnapshot): string {
  const entries = [...s.entries].sort((a, b) => a.id.localeCompare(b.id)).map(normalizeEntry);
  const groups = [...s.groups].sort((a, b) => a.id.localeCompare(b.id)).map(normalizeGroup);
  const tags = [...s.tags].sort((a, b) => a.id.localeCompare(b.id)).map(normalizeTag);
  return JSON.stringify({ schema: 2, entries, groups, tags });
}

export function snapshotsEqual(a: TwoFaSnapshot, b: TwoFaSnapshot): boolean {
  return canonicalSnapshotKey(a) === canonicalSnapshotKey(b);
}

export interface MergeResult {
  merged: TwoFaSnapshot;
  /** 合并结果与本地不同（需要写回本地 DB 并广播变更） */
  changedLocal: boolean;
  /** 合并结果与远端不同（需要加密推送到 GitHub） */
  differsFromRemote: boolean;
}

/**
 * 给缺少 sort 的条目补默认值（旧版远端快照没有该字段）：
 * 按 createdAt 升序（同时刻按 id）取名次 * 1024，结果只取决于快照内容，各端补出来一致。
 */
export function withEntrySort(s: TwoFaSnapshot): TwoFaSnapshot {
  const has = (e: SnapshotEntry) => typeof e.sort === 'number' && Number.isFinite(e.sort);
  if (s.entries.every(has)) return s;
  const ranked = [...s.entries].sort((a, b) => compareUpdatedAt(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const rank = new Map(ranked.map((e, i) => [e.id, i * 1024]));
  return { ...s, entries: s.entries.map((e) => (has(e) ? e : { ...e, sort: rank.get(e.id)! })) };
}

/** 合并本地与远端快照 */
export function mergeSnapshots(rawLocal: TwoFaSnapshot, rawRemote: TwoFaSnapshot): MergeResult {
  const local = withEntrySort(rawLocal);
  const remote = withEntrySort(rawRemote);
  const merged: TwoFaSnapshot = {
    schema: 2,
    entries: mergeRows(local.entries, remote.entries),
    groups: mergeRows(local.groups, remote.groups),
    tags: mergeRows(local.tags, remote.tags),
  };
  const mergedKey = canonicalSnapshotKey(merged);
  return {
    merged,
    changedLocal: mergedKey !== canonicalSnapshotKey(local),
    differsFromRemote: mergedKey !== canonicalSnapshotKey(remote),
  };
}
