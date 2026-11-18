import { describe, expect, it } from 'vitest';
import type { SessionSummary, Workspace } from '@cosyee/shared';
import { displayTitle, excludePinned, filterByTitle, samePath, workspaceName } from './sidebarUtil';

const mk = (id: string, title: string): SessionSummary => ({ id, cwd: 'F:\\a', title, lastActiveAt: 0, dot: null, pinned: null });

describe('sidebarUtil', () => {
  it('samePath 不区分大小写，忽略末尾分隔符，空值为 false', () => {
    expect(samePath('F:\\Cosyee', 'f:\\cosyee\\')).toBe(true);
    expect(samePath('F:\\a', 'F:\\b')).toBe(false);
    expect(samePath(null, 'F:\\a')).toBe(false);
  });

  it('workspaceName 优先取列表里的名字，没有就取路径最后一段', () => {
    const ws: Workspace[] = [{ path: 'F:\\Cosyee', name: '可可' }];
    expect(workspaceName('f:\\cosyee', ws)).toBe('可可');
    expect(workspaceName('D:\\work\\axiom', ws)).toBe('axiom');
  });

  it('displayTitle：空标题显示「新会话」', () => {
    expect(displayTitle('')).toBe('新会话');
    expect(displayTitle('abc')).toBe('abc');
  });

  it('filterByTitle 不区分大小写；空查询原样返回', () => {
    const list = [mk('1', 'Fix WebSocket'), mk('2', '重构侧栏'), mk('3', '')];
    expect(filterByTitle(list, 'websocket').map((s) => s.id)).toEqual(['1']);
    expect(filterByTitle(list, '侧栏').map((s) => s.id)).toEqual(['2']);
    expect(filterByTitle(list, '新会话').map((s) => s.id)).toEqual(['3']);
    expect(filterByTitle(list, '  ')).toBe(list);
    expect(filterByTitle(list, 'zzz')).toEqual([]);
  });

  it('excludePinned 去掉已置顶的会话', () => {
    const list = [mk('1', 'a'), mk('2', 'b')];
    expect(excludePinned(list, [mk('2', 'b')]).map((s) => s.id)).toEqual(['1']);
    expect(excludePinned(list, [])).toBe(list);
  });
});
