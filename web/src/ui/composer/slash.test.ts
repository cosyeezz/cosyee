import { describe, expect, it } from 'vitest';
import { filterSlash, matchSlash } from './slash';

describe('matchSlash', () => {
  it('行首 / 空白后的 /', () => {
    expect(matchSlash('/')).toEqual({ start: 0, query: '' });
    expect(matchSlash('/com')).toEqual({ start: 0, query: 'com' });
    expect(matchSlash('看看 /re')).toEqual({ start: 3, query: 're' });
    expect(matchSlash('a\n/x')).toEqual({ start: 2, query: 'x' });
  });
  it('路径、URL、已有空白不触发', () => {
    expect(matchSlash('a/b')).toBeNull();
    expect(matchSlash('http://x')).toBeNull();
    expect(matchSlash('/compact ')).toBeNull();
    expect(matchSlash('/a/b')).toBeNull();
    expect(matchSlash('hello')).toBeNull();
  });
});

describe('filterSlash', () => {
  it('分组、过滤、前缀优先', () => {
    const r = filterSlash(['compact', 'clear', 'context'], ['code-review', 'frontend-design'], 'c');
    expect(r.map((i) => `${i.group}:${i.name}`)).toEqual(['command:compact', 'command:clear', 'command:context', 'skill:code-review']);
    expect(filterSlash(['review'], ['pr-review'], 'rev').map((i) => i.name)).toEqual(['review', 'pr-review']);
    expect(filterSlash(['xreview', 'review'], [], 'rev').map((i) => i.name)).toEqual(['review', 'xreview']);
  });
  it('空查询列出全部；去掉前导 /', () => {
    expect(filterSlash(['/help'], [], '').map((i) => i.name)).toEqual(['help']);
  });
});
