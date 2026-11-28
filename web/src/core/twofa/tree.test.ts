import { describe, expect, it } from 'vitest';
import {
  buildGroupMap,
  buildRecursiveCounts,
  buildViewModel,
  compareEntries,
  sortBetween,
  flattenGroupTree,
  formatGroupPath,
  getDescendantIds,
} from './tree';
import type { TwoFaData, TwoFaEntry, TwoFaGroup, TwoFaTag } from './types';

const now = '2026-11-27T00:00:00.000Z';

function mkEntry(partial: Partial<TwoFaEntry> & Pick<TwoFaEntry, 'id' | 'issuer'>): TwoFaEntry {
  return {
    account: 'user@example.com',
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    groupId: null,
    pinned: false,
    tags: [],
    sort: 0,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...partial,
  };
}

function mkGroup(id: string, name: string, parentId: string | null = null, sort = 0): TwoFaGroup {
  return { id, name, parentId, sort, updatedAt: now, version: 1 };
}

function mkTag(id: string, name: string, color = 'blue'): TwoFaTag {
  return { id, name, color, updatedAt: now, version: 1 };
}

describe('2FA sorting & tree helpers', () => {
  const groups: TwoFaGroup[] = [
    mkGroup('g-work', '工作', null, 1),
    mkGroup('g-cloud', '云服务', 'g-work', 0),
    mkGroup('g-prod', '生产环境', 'g-cloud', 0),
    mkGroup('g-life', '个人', null, 2),
  ];
  const tags: TwoFaTag[] = [
    mkTag('t-prod', '生产', 'red'),
    mkTag('t-ssh', 'SSH', 'blue'),
    mkTag('t-fin', '金融', 'amber'),
  ];
  const entries: TwoFaEntry[] = [
    mkEntry({ id: 'e-aws', sort: 0, issuer: 'AWS', account: 'ops@prod', groupId: 'g-prod', pinned: true, tags: ['t-prod', 't-ssh'], note: '核心账号' }),
    mkEntry({ id: 'e-gh', sort: 1, issuer: 'GitHub', account: 'dev@co', groupId: 'g-work', tags: ['t-ssh'] }),
    mkEntry({ id: 'e-cf', sort: 2, issuer: 'Cloudflare', account: 'dns@co', groupId: 'g-cloud', tags: ['t-prod'] }),
    mkEntry({ id: 'e-gmail', sort: 3, issuer: 'Google', account: 'me@gmail.com', groupId: null, pinned: false, tags: [] }),
    mkEntry({ id: 'e-apple', sort: 4, issuer: 'Apple', account: 'me@icloud.com', groupId: null, pinned: false, tags: ['t-fin'] }),
    mkEntry({ id: 'e-bank', sort: 5, issuer: '招商银行', account: '6225****', groupId: 'g-life', pinned: true, tags: ['t-fin'] }),
  ];
  const usage: TwoFaData['usage'] = {
    'e-aws': { count: 12, lastUsedAt: '2026-11-26T10:00:00Z' },
    'e-gh': { count: 5, lastUsedAt: '2026-11-26T09:00:00Z' },
    'e-gmail': { count: 5, lastUsedAt: '2026-11-26T12:00:00Z' },
    'e-apple': { count: 5, lastUsedAt: '2026-11-26T12:00:00Z' },
    'e-bank': { count: 2, lastUsedAt: '2026-11-20T00:00:00Z' },
  };
  const data = { entries, groups, tags, usage };

  it('orders entries by sort, then createdAt, then id (usage is ignored)', () => {
    const list = [
      mkEntry({ id: 'c', issuer: 'C', sort: 2 }),
      mkEntry({ id: 'b', issuer: 'B', sort: 1, createdAt: '2026-11-27T00:00:02.000Z' }),
      mkEntry({ id: 'a', issuer: 'A', sort: 1, createdAt: '2026-11-27T00:00:01.000Z' }),
      mkEntry({ id: 'd', issuer: 'D', sort: 1, createdAt: '2026-11-27T00:00:01.000Z' }),
    ];
    expect([...list].sort(compareEntries).map((e) => e.id)).toEqual(['a', 'd', 'b', 'c']);
  });

  it('computes sort between neighbours', () => {
    expect(sortBetween(null, null)).toBe(0);
    expect(sortBetween(null, 5)).toBe(5 - 1024);
    expect(sortBetween(5, null)).toBe(5 + 1024);
    expect(sortBetween(1, 3)).toBe(2);
  });

  it('computes recursive entry counts and group paths', () => {
    const counts = buildRecursiveCounts(entries, groups);
    expect(counts.get('g-work')).toBe(3);  // e-gh + e-cf + e-aws
    expect(counts.get('g-cloud')).toBe(2); // e-cf + e-aws
    expect(counts.get('g-prod')).toBe(1);  // e-aws
    expect(counts.get('g-life')).toBe(1);  // e-bank

    const map = buildGroupMap(groups);
    expect(formatGroupPath('g-prod', map)).toBe('工作 / 云服务 / 生产环境');
    expect(formatGroupPath(null, map)).toBe('');
  });

  it('builds root view: pinned (with path) → root groups → ungrouped non-pinned entries', () => {
    const vm = buildViewModel(data, null, '', []);
    expect(vm.mode).toBe('root');
    if (vm.mode !== 'root') return;
    expect(vm.pinned.map((x) => [x.entry.id, x.groupPath])).toEqual([
      ['e-aws', '工作 / 云服务 / 生产环境'],
      ['e-bank', '个人'],
    ]);
    expect(vm.groups.map((g) => [g.group.id, g.entryCount])).toEqual([
      ['g-work', 3],
      ['g-life', 1],
    ]);
    expect(vm.ungrouped.map((x) => x.entry.id)).toEqual(['e-gmail', 'e-apple']);
  });

  it('builds group view: breadcrumb, child groups, and entries including pinned ones inside that group', () => {
    const vm = buildViewModel(data, 'g-prod', '', []);
    expect(vm.mode).toBe('group');
    if (vm.mode !== 'group') return;
    expect(vm.breadcrumb.map((g) => g.name)).toEqual(['工作', '云服务', '生产环境']);
    expect(vm.groups).toEqual([]);
    expect(vm.entries.map((x) => x.entry.id)).toEqual(['e-aws']);
  });

  it('filters with AND semantics across selected tags', () => {
    const vmOne = buildViewModel(data, null, '', ['t-prod']);
    expect(vmOne.mode).toBe('search');
    if (vmOne.mode === 'search') {
      expect(vmOne.entries.map((x) => x.entry.id)).toEqual(['e-aws', 'e-cf']);
    }

    const vmBoth = buildViewModel(data, null, '', ['t-prod', 't-ssh']);
    expect(vmBoth.mode).toBe('search');
    if (vmBoth.mode === 'search') {
      expect(vmBoth.entries.map((x) => x.entry.id)).toEqual(['e-aws']);
    }
  });

  it('searches across issuer, account, note, tag name, and group path (case-insensitive)', () => {
    // 搜路径名
    const byPath = buildViewModel(data, null, '云服务', []);
    expect(byPath.mode).toBe('search');
    if (byPath.mode === 'search') {
      expect(byPath.entries.map((x) => x.entry.id)).toEqual(['e-aws', 'e-cf']);
    }
    // 搜备注
    const byNote = buildViewModel(data, null, '核心', []);
    if (byNote.mode === 'search') {
      expect(byNote.entries.map((x) => x.entry.id)).toEqual(['e-aws']);
    }
    // 搜标签名（不区分大小写）
    const byTag = buildViewModel(data, null, 'ssh', []);
    if (byTag.mode === 'search') {
      expect(byTag.entries.map((x) => x.entry.id)).toEqual(['e-aws', 'e-gh']);
    }
  });

  it('computes descendant set and flattened tree options', () => {
    expect([...getDescendantIds('g-work', groups)].sort()).toEqual(['g-cloud', 'g-prod', 'g-work']);
    const flat = flattenGroupTree(groups);
    expect(flat.map((o) => [o.group.id, o.depth, o.path])).toEqual([
      ['g-work', 0, '工作'],
      ['g-cloud', 1, '工作 / 云服务'],
      ['g-prod', 2, '工作 / 云服务 / 生产环境'],
      ['g-life', 0, '个人'],
    ]);
  });
});
