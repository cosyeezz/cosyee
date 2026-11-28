import { describe, expect, it } from 'vitest';
import { TERM_OUTPUT_LIMIT, type TermBlock, type TermSnapshot, type TermTabInfo } from '@cosyee/shared';
import {
  applyTerminalServerMsg,
  pushHistoryOptimistic,
  reorderTabs,
  terminalWsUrl,
} from './terminal';
import {
  clampTerminalHeight,
  readTerminalActiveTab,
  readTerminalPrefs,
  saveTerminalActiveTab,
  saveTerminalPrefs,
  TERMINAL_ACTIVE_TABS_KEY,
  TERMINAL_PREFS_KEY,
} from './terminalPrefs';

const TAB_1: TermTabInfo = {
  id: 't1',
  cwd: 'F:\\Cosyee',
  shell: 'pwsh',
  status: 'idle',
  createdAt: 1000,
};

const BASE_SNAP: TermSnapshot = {
  id: 't1',
  root: 'F:\\Cosyee',
  tabs: [TAB_1],
  cwd: 'F:\\Cosyee',
  shell: 'pwsh',
  shells: [{ id: 'pwsh', label: 'PowerShell 7' }],
  platform: 'win32',
  blocks: [],
  history: ['git status'],
};

describe('terminal state reducer', () => {
  it('合并 block、out、end 并处理超长截断', () => {
    const b: TermBlock = {
      id: 'b1',
      cmd: 'npm test',
      cwd: 'F:\\Cosyee',
      shell: 'pwsh',
      startedAt: 1000,
      state: 'running',
      output: '',
    };
    let snap = applyTerminalServerMsg(BASE_SNAP, { t: 'block', block: b })!;
    expect(snap.blocks).toHaveLength(1);

    snap = applyTerminalServerMsg(snap, { t: 'out', id: 'b1', data: 'hello ' })!;
    snap = applyTerminalServerMsg(snap, { t: 'out', id: 'b1', data: 'world' })!;
    expect(snap.blocks[0]!.output).toBe('hello world');

    // 超过 TERM_OUTPUT_LIMIT 时保留末尾并标 truncated
    const huge = 'x'.repeat(TERM_OUTPUT_LIMIT + 100);
    snap = applyTerminalServerMsg(snap, { t: 'out', id: 'b1', data: huge })!;
    expect(snap.blocks[0]!.output.length).toBe(TERM_OUTPUT_LIMIT);
    expect(snap.blocks[0]!.truncated).toBe(true);

    snap = applyTerminalServerMsg(snap, {
      t: 'end',
      id: 'b1',
      state: 'done',
      exitCode: 0,
      endedAt: 2500,
    })!;
    expect(snap.blocks[0]!.state).toBe('done');
    expect(snap.blocks[0]!.exitCode).toBe(0);
    expect(snap.blocks[0]!.endedAt).toBe(2500);
  });

  it('cleared 只保留 keep 里的运行中块', () => {
    const snap0: TermSnapshot = {
      ...BASE_SNAP,
      blocks: [
        { id: 'done-1', cmd: 'echo 1', cwd: 'F:\\Cosyee', shell: 'pwsh', startedAt: 1, state: 'done', exitCode: 0, output: '1' },
        { id: 'run-1', cmd: 'npm run dev', cwd: 'F:\\Cosyee', shell: 'pwsh', startedAt: 2, state: 'running', output: '' },
      ],
    };
    const next = applyTerminalServerMsg(snap0, { t: 'cleared', keep: ['run-1'] })!;
    expect(next.blocks.map((b) => b.id)).toEqual(['run-1']);
  });

  it('tabs 消息合并更新快照中的标签列表', () => {
    const nextTabs: TermTabInfo[] = [
      { ...TAB_1, status: 'running', runningCmd: 'npm run dev' },
      { id: 't2', name: '后端', cwd: 'F:\\Cosyee\\server', shell: 'gitbash', status: 'failed', createdAt: 2000 },
    ];
    const next = applyTerminalServerMsg(BASE_SNAP, { t: 'tabs', tabs: nextTabs })!;
    expect(next.tabs).toEqual(nextTabs);
    expect(next.blocks).toEqual(BASE_SNAP.blocks);
  });

  it('reorderTabs 按移除后数组计算下标并夹到两端', () => {
    const tabs: TermTabInfo[] = [
      { ...TAB_1, id: 'a' },
      { ...TAB_1, id: 'b' },
      { ...TAB_1, id: 'c' },
    ];
    expect(reorderTabs(tabs, 'a', 2).map((t) => t.id)).toEqual(['b', 'c', 'a']);
    expect(reorderTabs(tabs, 'c', 0).map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(reorderTabs(tabs, 'b', 99).map((t) => t.id)).toEqual(['a', 'c', 'b']);
    expect(reorderTabs(tabs, 'b', -5).map((t) => t.id)).toEqual(['b', 'a', 'c']);
  });

  it('terminalWsUrl 正确拼接 id 与 create 参数', () => {
    const base = terminalWsUrl('F:\\Cosyee');
    expect(base).toContain('/api/terminal/ws?root=F%3A%5CCosyee');
    expect(base).not.toContain('&id=');
    expect(base).not.toContain('&create=1');

    const withId = terminalWsUrl('F:\\Cosyee', 'abc-123');
    expect(withId).toContain('&id=abc-123');
    expect(withId).not.toContain('&create=1');

    const withCreate = terminalWsUrl('F:\\Cosyee', 'abc-123', true);
    expect(withCreate).toContain('&id=abc-123&create=1');
  });

  it('乐观更新历史去重并移到末尾', () => {
    expect(pushHistoryOptimistic(['a', 'b', 'c'], 'b')).toEqual(['a', 'c', 'b']);
    expect(pushHistoryOptimistic(['a'], '   ')).toEqual(['a']);
  });

  it('terminalPrefs 与按工作空间记住当前标签 id 的持久化', () => {
    localStorage.removeItem(TERMINAL_PREFS_KEY);
    localStorage.removeItem(TERMINAL_ACTIVE_TABS_KEY);
    expect(readTerminalPrefs()).toEqual({ open: false, height: 300 });
    saveTerminalPrefs({ open: true, height: 420 });
    expect(readTerminalPrefs()).toEqual({ open: true, height: 420 });
    expect(clampTerminalHeight(50, 600)).toBe(180);
    expect(clampTerminalHeight(999, 500)).toBe(500);

    expect(readTerminalActiveTab('F:\\Cosyee')).toBeNull();
    saveTerminalActiveTab('F:\\Cosyee\\', 'tab-a');
    expect(readTerminalActiveTab('f:\\cosyee')).toBe('tab-a');
    saveTerminalActiveTab('F:\\Cosyee', null);
    expect(readTerminalActiveTab('F:\\Cosyee')).toBeNull();
  });
});
