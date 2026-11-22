import { describe, expect, it } from 'vitest';
import { toolIconName } from './toolIcon';

describe('toolIconName', () => {
  it.each([
    ['Bash', 'tool-bash'],
    ['PowerShell', 'tool-bash'],
    ['Read', 'tool-read'],
    ['NotebookRead', 'tool-read'],
    ['Edit', 'tool-edit'],
    ['Write', 'tool-edit'],
    ['MultiEdit', 'tool-edit'],
    ['NotebookEdit', 'tool-edit'],
    ['Grep', 'tool-search'],
    ['Glob', 'tool-search'],
    ['ToolSearch', 'tool-search'],
    ['WebFetch', 'tool-web'],
    ['WebSearch', 'tool-web'],
    ['Agent', 'tool-agent'],
    ['Task', 'tool-agent'],
    ['mcp__github__create_issue', 'tool-mcp'],
    ['mcp__x', 'tool-mcp'],
    ['TodoWrite', 'tool-todo'],
    ['TaskCreate', 'tool-todo'],
    ['TaskUpdate', 'tool-todo'],
    ['TaskList', 'tool-todo'],
    ['TaskGet', 'tool-todo'],
    ['AskUserQuestion', 'info'],
    ['ExitPlanMode', 'mode-plan'],
  ])('%s -> %s', (name, icon) => {
    expect(toolIconName(name)).toBe(icon);
  });

  it('Task 是子代理，不是任务清单', () => {
    expect(toolIconName('Task')).toBe('tool-agent');
    expect(toolIconName('TaskCreate')).toBe('tool-todo');
  });

  it('其他工具走兜底图标，包括后台任务工具和原型链上的名字', () => {
    for (const n of ['Skill', 'TaskOutput', 'TaskStop', 'KillShell', 'toString', 'constructor', '', 'mcp_single']) {
      expect(toolIconName(n)).toBe('tool-generic');
    }
  });

  it('出错时换成 tool-fail（优先于所有映射）', () => {
    for (const n of ['Bash', 'Read', 'mcp__a__b', 'Whatever']) expect(toolIconName(n, true)).toBe('tool-fail');
    expect(toolIconName('Bash', false)).toBe('tool-bash');
  });
});
