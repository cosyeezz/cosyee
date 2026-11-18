import { describe, expect, it } from 'vitest';
import { toolRows } from './tools';

describe('toolRows', () => {
  it('init 工具在前、仅停用的在后；去重；排除 mcp__ 与非法名字', () => {
    expect(
      toolRows(['Bash', 'mcp__a__b', 'Read', 'Bash', 'bad name'], ['Read', 'Notebook', 'mcp__x__y', 'Notebook', '']),
    ).toEqual([
      { name: 'Bash', enabled: true },
      { name: 'Read', enabled: false },
      { name: 'Notebook', enabled: false },
    ]);
  });
  it('入参缺省时返回空', () => {
    expect(toolRows(undefined, undefined)).toEqual([]);
  });
});
