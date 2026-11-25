import { describe, expect, it } from 'vitest';
import { normalizeForeignTool } from './foreignTool';

describe('normalizeForeignTool', () => {
  it('read_file → Read（含 StartLine / EndLine 换算与缺省省略）', () => {
    expect(normalizeForeignTool('read_file', { Path: 'F:\\a.ts', StartLine: 10, EndLine: 25, ByteOffset: 0 })).toEqual({
      name: 'Read',
      input: { file_path: 'F:\\a.ts', offset: 10, limit: 16 },
    });
    expect(normalizeForeignTool('read_file', { Path: 'F:\\a.ts', StartLine: 5 })).toEqual({
      name: 'Read',
      input: { file_path: 'F:\\a.ts', offset: 5 },
    });
    expect(normalizeForeignTool('read_file', { Path: 'F:\\a.ts', EndLine: 20 })).toEqual({
      name: 'Read',
      input: { file_path: 'F:\\a.ts' },
    });
    expect(normalizeForeignTool('read_file', {})).toEqual({ name: 'Read', input: {} });
  });

  it('edit_file → Edit', () => {
    expect(normalizeForeignTool('edit_file', { Path: 'a.ts', Target: 'old', Replacement: 'new' })).toEqual({
      name: 'Edit',
      input: { file_path: 'a.ts', old_string: 'old', new_string: 'new' },
    });
    expect(normalizeForeignTool('edit_file', { Path: 'a.ts' })).toEqual({
      name: 'Edit',
      input: { file_path: 'a.ts' },
    });
  });

  it('write_file → Write', () => {
    expect(normalizeForeignTool('write_file', { Path: 'a.ts', Content: 'hello', Overwrite: true })).toEqual({
      name: 'Write',
      input: { file_path: 'a.ts', content: 'hello' },
    });
    expect(normalizeForeignTool('write_file', { Path: 'a.ts' })).toEqual({
      name: 'Write',
      input: { file_path: 'a.ts' },
    });
  });

  it('run_command → Bash', () => {
    expect(normalizeForeignTool('run_command', { CommandLine: 'npm test', toolSummary: 'Run tests', WaitMsBeforeAsync: 5000 })).toEqual({
      name: 'Bash',
      input: { command: 'npm test', description: 'Run tests' },
    });
    expect(normalizeForeignTool('run_command', { CommandLine: 'ls' })).toEqual({
      name: 'Bash',
      input: { command: 'ls' },
    });
  });

  it('update_steps → TodoWrite（状态归一化）', () => {
    expect(
      normalizeForeignTool('update_steps', {
        steps: [
          { status: 'done', title: 'Step 1' },
          { status: 'completed', title: 'Step 2' },
          { status: 'in_progress', title: 'Step 3' },
          { status: 'pending', title: 'Step 4' },
          { status: 'skipped', title: 'Step 5' },
        ],
      }),
    ).toEqual({
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Step 1', status: 'completed' },
          { content: 'Step 2', status: 'completed' },
          { content: 'Step 3', status: 'in_progress' },
          { content: 'Step 4', status: 'pending' },
          { content: 'Step 5', status: 'pending' },
        ],
      },
    });
    expect(normalizeForeignTool('update_steps', {})).toEqual({ name: 'TodoWrite', input: {} });
  });

  it('ACP kind 兜底：read / edit（含 write 判别）/ execute', () => {
    expect(normalizeForeignTool('read', { Path: 'x.ts', StartLine: 1, EndLine: 10 })).toEqual({
      name: 'Read',
      input: { file_path: 'x.ts', offset: 1, limit: 10 },
    });
    expect(normalizeForeignTool('edit', { Path: 'x.ts', Target: 'a', Replacement: 'b' })).toEqual({
      name: 'Edit',
      input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' },
    });
    expect(normalizeForeignTool('edit', { Path: 'x.ts', Content: 'hello' })).toEqual({
      name: 'Write',
      input: { file_path: 'x.ts', content: 'hello' },
    });
    expect(normalizeForeignTool('edit', { Path: 'x.ts', Content: 'hello', Target: 'a', Replacement: 'b' })).toEqual({
      name: 'Edit',
      input: { file_path: 'x.ts', old_string: 'a', new_string: 'b' },
    });
    expect(normalizeForeignTool('execute', { CommandLine: 'git status' })).toEqual({
      name: 'Bash',
      input: { command: 'git status' },
    });
  });

  it('非对象 / 流式字符串入参原样保留，工具名仍归一化', () => {
    expect(normalizeForeignTool('read_file', '{"Path":"a')).toEqual({ name: 'Read', input: '{"Path":"a' });
    expect(normalizeForeignTool('run_command', undefined)).toEqual({ name: 'Bash', input: undefined });
    expect(normalizeForeignTool('edit', null)).toEqual({ name: 'Edit', input: null });
  });

  it('未知工具与 Claude 原生 / MCP 工具返回 null', () => {
    for (const name of ['Read', 'Edit', 'Write', 'Bash', 'TodoWrite', 'Grep', 'Glob', 'Agent', 'mcp__cosyee__delegate', 'mcp__x__read_file', 'unknown_tool', '']) {
      expect(normalizeForeignTool(name, { Path: 'a.ts' })).toBeNull();
    }
  });
});
