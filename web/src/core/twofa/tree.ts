// 2FA 列表排序、多级分组树、路径导航、标签交集筛选与全局搜索纯函数。
import type { TwoFaData, TwoFaEntry, TwoFaGroup, TwoFaTag, TwoFaTagColor } from './types';
import { TWOFA_TAG_COLORS } from './types';

export interface EntryViewItem {
  entry: TwoFaEntry;
  /** 分组路径文本（根目录记录为空字符串） */
  groupPath: string;
}

export interface GroupViewItem {
  group: TwoFaGroup;
  /** 含子分组在内的递归记录总数 */
  entryCount: number;
}

export type TwoFaViewModel =
  | {
      mode: 'search';
      entries: EntryViewItem[];
    }
  | {
      mode: 'root';
      pinned: EntryViewItem[];
      groups: GroupViewItem[];
      ungrouped: EntryViewItem[];
    }
  | {
      mode: 'group';
      breadcrumb: TwoFaGroup[];
      groups: GroupViewItem[];
      entries: EntryViewItem[];
    };

/** 记录排序：sort 升序 → createdAt 升序 → id 升序（稳定，不随使用频率变化） */
export function compareEntries(a: TwoFaEntry, b: TwoFaEntry): number {
  if (a.sort !== b.sort) return a.sort - b.sort;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 在已排序序列中，取插入到 index 位置时的新 sort（相邻两项中点；两端各留 1024 间距） */
export function sortBetween(prev: number | null, next: number | null): number {
  if (prev === null && next === null) return 0;
  if (prev === null) return (next as number) - 1024;
  if (next === null) return prev + 1024;
  return (prev + next) / 2;
}

/** 分组排序：sort 升序 → name 升序 */
export function compareGroups(a: TwoFaGroup, b: TwoFaGroup): number {
  if (a.sort !== b.sort) return a.sort - b.sort;
  return a.name.localeCompare(b.name, 'zh-CN');
}

export function buildGroupMap(groups: TwoFaGroup[]): Map<string, TwoFaGroup> {
  const map = new Map<string, TwoFaGroup>();
  for (const g of groups) map.set(g.id, g);
  return map;
}

export function buildTagMap(tags: TwoFaTag[]): Map<string, TwoFaTag> {
  const map = new Map<string, TwoFaTag>();
  for (const t of tags) map.set(t.id, t);
  return map;
}

/** 从根到目标分组的有序链路（自动防环） */
export function getGroupPath(groupId: string | null, groupMap: Map<string, TwoFaGroup>): TwoFaGroup[] {
  if (!groupId) return [];
  const chain: TwoFaGroup[] = [];
  const seen = new Set<string>();
  let cur: string | null = groupId;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const g = groupMap.get(cur);
    if (!g) break;
    chain.push(g);
    cur = g.parentId;
  }
  chain.reverse();
  return chain;
}

export function formatGroupPath(groupId: string | null, groupMap: Map<string, TwoFaGroup>): string {
  const chain = getGroupPath(groupId, groupMap);
  return chain.map((g) => g.name).join(' / ');
}

/** 返回自身及所有后代分组 ID 集合（移动分组时用来禁止移入自身或子孙） */
export function getDescendantIds(groupId: string, groups: TwoFaGroup[]): Set<string> {
  const childrenMap = new Map<string | null, string[]>();
  for (const g of groups) {
    const arr = childrenMap.get(g.parentId) ?? [];
    arr.push(g.id);
    childrenMap.set(g.parentId, arr);
  }
  const result = new Set<string>();
  const stack = [groupId];
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    const kids = childrenMap.get(id);
    if (kids) for (const k of kids) stack.push(k);
  }
  return result;
}

/** 计算每个分组（含所有子孙分组）的递归记录数 */
export function buildRecursiveCounts(
  entries: TwoFaEntry[],
  groups: TwoFaGroup[],
): Map<string, number> {
  const groupMap = buildGroupMap(groups);
  const counts = new Map<string, number>();
  for (const g of groups) counts.set(g.id, 0);
  for (const e of entries) {
    if (!e.groupId) continue;
    const seen = new Set<string>();
    let cur: string | null = e.groupId;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const g = groupMap.get(cur);
      if (!g) break;
      counts.set(cur, (counts.get(cur) ?? 0) + 1);
      cur = g.parentId;
    }
  }
  return counts;
}

/** 标签交集筛选（AND）+ 全局搜索（issuer / account / note / 标签名 / 分组路径，不区分大小写） */
export function matchesEntry(
  entry: TwoFaEntry,
  query: string,
  selectedTagIds: readonly string[],
  groupMap: Map<string, TwoFaGroup>,
  tagMap: Map<string, TwoFaTag>,
): boolean {
  if (selectedTagIds.length > 0) {
    for (const tid of selectedTagIds) {
      if (!entry.tags.includes(tid)) return false;
    }
  }
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (entry.issuer.toLowerCase().includes(q)) return true;
  if (entry.account.toLowerCase().includes(q)) return true;
  if (entry.note && entry.note.toLowerCase().includes(q)) return true;
  const path = formatGroupPath(entry.groupId, groupMap).toLowerCase();
  if (path && path.includes(q)) return true;
  for (const tid of entry.tags) {
    const tag = tagMap.get(tid);
    if (tag && tag.name.toLowerCase().includes(q)) return true;
  }
  return false;
}

/** 构建当前视图数据（搜索/标签平铺 vs 根目录 vs 分组内） */
export function buildViewModel(
  data: Pick<TwoFaData, 'entries' | 'groups' | 'tags' | 'usage'>,
  currentGroupId: string | null,
  query: string,
  selectedTagIds: readonly string[],
): TwoFaViewModel {
  const groupMap = buildGroupMap(data.groups);
  const tagMap = buildTagMap(data.tags);
  const isFiltering = query.trim().length > 0 || selectedTagIds.length > 0;

  if (isFiltering) {
    const matched = data.entries
      .filter((e) => matchesEntry(e, query, selectedTagIds, groupMap, tagMap))
      .sort((a, b) => compareEntries(a, b))
      .map((entry) => ({
        entry,
        groupPath: formatGroupPath(entry.groupId, groupMap),
      }));
    return { mode: 'search', entries: matched };
  }

  const counts = buildRecursiveCounts(data.entries, data.groups);

  // 如果当前分组已被删除，自动回到根目录
  const validGroupId = currentGroupId && groupMap.has(currentGroupId) ? currentGroupId : null;

  if (validGroupId === null) {
    const pinned = data.entries
      .filter((e) => e.pinned)
      .sort((a, b) => compareEntries(a, b))
      .map((entry) => ({
        entry,
        groupPath: formatGroupPath(entry.groupId, groupMap),
      }));
    const groups = data.groups
      .filter((g) => g.parentId === null)
      .sort(compareGroups)
      .map((group) => ({ group, entryCount: counts.get(group.id) ?? 0 }));
    const ungrouped = data.entries
      .filter((e) => e.groupId === null && !e.pinned)
      .sort((a, b) => compareEntries(a, b))
      .map((entry) => ({ entry, groupPath: '' }));
    return { mode: 'root', pinned, groups, ungrouped };
  }

  const breadcrumb = getGroupPath(validGroupId, groupMap);
  const groups = data.groups
    .filter((g) => g.parentId === validGroupId)
    .sort(compareGroups)
    .map((group) => ({ group, entryCount: counts.get(group.id) ?? 0 }));
  // 分组内显示该分组的所有记录（包括已置顶的），按固定顺序排列（sort、createdAt、id），不随使用频率变化
  const entries = data.entries
    .filter((e) => e.groupId === validGroupId)
    .sort((a, b) => compareEntries(a, b))
    .map((entry) => ({ entry, groupPath: '' }));
  return { mode: 'group', breadcrumb, groups, entries };
}

/** 扁平化分组树用于选择器下拉 / 移动分组弹窗 */
export interface FlatGroupOption {
  group: TwoFaGroup;
  depth: number;
  path: string;
}

export function flattenGroupTree(groups: TwoFaGroup[]): FlatGroupOption[] {
  const byParent = new Map<string | null, TwoFaGroup[]>();
  for (const g of groups) {
    const list = byParent.get(g.parentId) ?? [];
    list.push(g);
    byParent.set(g.parentId, list);
  }
  for (const list of byParent.values()) list.sort(compareGroups);

  const out: FlatGroupOption[] = [];
  const seen = new Set<string>();
  const walk = (parentId: string | null, depth: number, prefix: string) => {
    const kids = byParent.get(parentId) ?? [];
    for (const g of kids) {
      if (seen.has(g.id)) continue;
      seen.add(g.id);
      const path = prefix ? `${prefix} / ${g.name}` : g.name;
      out.push({ group: g, depth, path });
      walk(g.id, depth + 1, path);
    }
  };
  walk(null, 0, '');
  return out;
}

/** 根据 issuer 名称计算稳定的头像调色板 key */
const AVATAR_KEYS: readonly TwoFaTagColor[] = [
  'blue', 'indigo', 'violet', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'slate',
];

export function issuerColorKey(issuer: string): TwoFaTagColor {
  const s = (issuer || '?').trim().toLowerCase();
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return AVATAR_KEYS[Math.abs(h) % AVATAR_KEYS.length]!;
}

export function issuerInitial(issuer: string, account?: string): string {
  const src = (issuer || account || '?').trim();
  if (!src) return '?';
  const first = Array.from(src)[0] ?? '?';
  return first.toUpperCase();
}

export function normalizeTagColor(color?: string): TwoFaTagColor {
  if (color && (TWOFA_TAG_COLORS as readonly string[]).includes(color)) {
    return color as TwoFaTagColor;
  }
  return 'blue';
}
