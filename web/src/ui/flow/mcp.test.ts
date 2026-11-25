import { describe, expect, it } from 'vitest';
import type { ToolStep } from '@cosyee/shared';
import { groupMcpCalls, parseMcpName } from './mcp';

const tool = (id: string, name: string, result?: ToolStep['result']): ToolStep => ({
  kind: 'tool', id, name, input: {}, summary: name, result,
});

describe('parseMcpName', () => {
  it('按第一个 __ 拆', () => {
    expect(parseMcpName('mcp__playwright__browser_click')).toEqual({ server: 'playwright', tool: 'browser_click' });
  });
  it('服务器名含 - 和单个 _', () => {
    expect(parseMcpName('mcp__my-server_x__do_it')).toEqual({ server: 'my-server_x', tool: 'do_it' });
  });
  it('已知服务器名最长前缀优先', () => {
    expect(parseMcpName('mcp__a__b__tool', ['a', 'a__b'])).toEqual({ server: 'a__b', tool: 'tool' });
    expect(parseMcpName('mcp__a__b__tool', ['a'])).toEqual({ server: 'a', tool: 'b__tool' });
  });
  it('非 MCP 或残缺返回 null', () => {
    expect(parseMcpName('Bash')).toBeNull();
    expect(parseMcpName('mcp__only')).toBeNull();
    expect(parseMcpName('mcp____x')).toBeNull();
  });
});

describe('groupMcpCalls', () => {
  it('按服务器、工具分组并保持首次调用顺序', () => {
    const g = groupMcpCalls([
      tool('1', 'mcp__s1__a', { content: 'x', isError: false }),
      { kind: 'text', text: 'hi' },
      tool('2', 'mcp__s2__b', { content: 'x', isError: true }),
      tool('3', 'mcp__s1__a'),
      tool('4', 'mcp__s1__c', { content: 'x', isError: false }),
      tool('5', 'Bash'),
    ]);
    expect(g.map((x) => x.server)).toEqual(['s1', 's2']);
    expect(g[0].tools.map((t) => [t.tool, t.calls.length])).toEqual([['a', 2], ['c', 1]]);
    expect(g[0].running).toBe(true);
    expect(g[0].tools[0].running).toBe(true);
    expect(g[0].tools[1].running).toBe(false);
    expect(g[1].failed).toBe(true);
    expect(g[0].callCount).toBe(3);
  });
  it('没有 MCP 调用时为空', () => {
    expect(groupMcpCalls([tool('1', 'Read')])).toEqual([]);
  });
  it('排除 Cosyee 自带工具，外部 MCP 行为不变；parseMcpName 仍纯解析', () => {
    expect(parseMcpName('mcp__cosyee__delegate_send')).toEqual({ server: 'cosyee', tool: 'delegate_send' });
    expect(groupMcpCalls([
      tool('1', 'mcp__cosyee__delegate'),
      tool('2', 'mcp__cosyee__delegate_send'),
      tool('3', 'mcp__cosyee__delegate_agents'),
    ])).toEqual([]);
    const mixed = groupMcpCalls([
      tool('1', 'mcp__cosyee__delegate_send'),
      tool('2', 'mcp__github__search', { content: 'ok', isError: false }),
      tool('3', 'mcp__cosyee__delegate_result'),
    ]);
    expect(mixed.map((x) => x.server)).toEqual(['github']);
    expect(mixed[0]!.tools.map((t) => t.tool)).toEqual(['search']);
    expect(mixed[0]!.callCount).toBe(1);
  });
});
