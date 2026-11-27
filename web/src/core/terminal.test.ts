import { describe, expect, it } from 'vitest';
import { TERM_OUTPUT_LIMIT, type TermBlock, type TermSnapshot } from '@cosyee/shared';
import { applyTerminalServerMsg, pushHistoryOptimistic } from './terminal';
import { clampTerminalHeight, readTerminalPrefs, saveTerminalPrefs, TERMINAL_PREFS_KEY } from './terminalPrefs';

const BASE_SNAP: TermSnapshot = {
  root: 'F:\\Cosyee',
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

  it('乐观更新历史去重并移到末尾', () => {
    expect(pushHistoryOptimistic(['a', 'b', 'c'], 'b')).toEqual(['a', 'c', 'b']);
    expect(pushHistoryOptimistic(['a'], '   ')).toEqual(['a']);
  });

  it('terminalPrefs 持久化与高度范围钳制', () => {
    localStorage.removeItem(TERMINAL_PREFS_KEY);
    expect(readTerminalPrefs()).toEqual({ open: false, height: 300 });
    saveTerminalPrefs({ open: true, height: 420 });
    expect(readTerminalPrefs()).toEqual({ open: true, height: 420 });
    expect(clampTerminalHeight(50, 600)).toBe(180);
    expect(clampTerminalHeight(999, 500)).toBe(500);
  });
});
