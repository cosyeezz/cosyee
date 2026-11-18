import { describe, expect, it } from 'vitest';
import type { Turn } from '@cosyee/shared';
import {
  describeToolInput,
  formatClock,
  formatDoneText,
  formatDuration,
  getLiveText,
  getStatusLine,
  shortReason,
  splitUserText,
  subagentProgress,
  thinkingPreview,
  toolContentToText,
  truncateText,
} from './format';

const baseTurn: Turn = {
  id: 't',
  userText: '',
  attachments: [],
  status: 'running',
  statusText: '',
  steps: [],
  answer: '',
  subagents: [],
  startedAt: 0,
};

describe('formatDuration', () => {
  it('秒 / 分秒 / 时分', () => {
    expect(formatDuration(12_000)).toBe('12 秒');
    expect(formatDuration(59_400)).toBe('59 秒');
    expect(formatDuration(185_000)).toBe('3 分 5 秒');
    expect(formatDuration(3_720_000)).toBe('1 小时 2 分');
    expect(formatDuration(-5)).toBe('0 秒');
    expect(formatDuration(NaN)).toBe('0 秒');
  });
});

describe('formatClock / formatDoneText', () => {
  it('HH:mm 补零', () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4).getTime())).toBe('03:04');
  });
  it('已完成文案', () => {
    const start = new Date(2026, 0, 2, 9, 0, 0).getTime();
    const end = start + 185_000;
    expect(formatDoneText({ startedAt: start, endedAt: end })).toBe('已完成 · 09:03 · 用时 3 分 5 秒');
    expect(formatDoneText({ startedAt: start })).toBe('已完成');
  });
});

describe('getStatusLine', () => {
  it('进行中：主短语固定为「正在处理」，不显示模型文字；meta 为用时', () => {
    const u = getStatusLine({ ...baseTurn, status: 'understanding', statusText: '正在理解问题' }, 3_000);
    expect(u).toEqual({ kind: 'active', text: '正在处理', meta: '3 秒' });
    const r = getStatusLine({ ...baseTurn, statusText: '先读一下 reducer' }, 12_400);
    expect(r).toEqual({ kind: 'active', text: '正在处理', meta: '12 秒' });
  });
  it('进行中：有未完成的子代理时附加进度，全部完成后不再显示', () => {
    const sub = (status: 'running' | 'done' | 'error') => ({ toolUseId: status, title: '', status, turn: baseTurn });
    const t = { ...baseTurn, subagents: [sub('done'), sub('running'), sub('error')] };
    expect(getStatusLine(t, 5_000).meta).toBe('5 秒 · 子代理 2/3');
    expect(getStatusLine({ ...t, subagents: [sub('done')] }, 5_000).meta).toBe('5 秒');
  });
  it('已完成：步数与用时', () => {
    const steps = [{ kind: 'text' as const, text: 'a' }, { kind: 'thinking' as const, text: 'b' }];
    expect(getStatusLine({ ...baseTurn, status: 'done', steps, endedAt: 185_000 })).toEqual({
      kind: 'done',
      text: '已完成',
      meta: '共 2 步 · 用时 3 分 5 秒',
    });
    expect(getStatusLine({ ...baseTurn, status: 'done', endedAt: 4_000 }).meta).toBe('用时 4 秒');
    expect(getStatusLine({ ...baseTurn, status: 'done' }).meta).toBe('');
  });
  it('中断 / 出错：主短语固定，原因进 meta（与主短语重复时省略）', () => {
    expect(getStatusLine({ ...baseTurn, status: 'interrupted', reason: '已中断' })).toMatchObject({ text: '已中断', meta: '' });
    expect(getStatusLine({ ...baseTurn, status: 'interrupted', reason: '用户停止' })).toMatchObject({ text: '已中断', meta: '用户停止' });
    expect(getStatusLine({ ...baseTurn, status: 'error', reason: 'API 超时' })).toEqual({
      kind: 'error',
      text: '出错了',
      meta: 'API 超时',
      title: 'API 超时',
    });
    expect(getStatusLine({ ...baseTurn, status: 'error' })).toMatchObject({ text: '出错了', meta: '' });
  });
});

describe('shortReason', () => {
  it('取首个非空行、压缩空白、超长截断', () => {
    expect(shortReason(undefined)).toBe('');
    expect(shortReason('\n  first   line \nsecond')).toBe('first line');
    expect(shortReason('x'.repeat(70), 60)).toBe('x'.repeat(60) + '…');
  });
});

describe('getLiveText', () => {
  const steps = [
    { kind: 'text' as const, text: '第一段' },
    { kind: 'tool' as const, id: 'a', name: 'Bash', input: {}, summary: 'ls' },
    { kind: 'text' as const, text: '第二段' },
    { kind: 'tool' as const, id: 'b', name: 'Read', input: {}, summary: 'x' },
  ];
  it('折叠：answer 优先，否则最后一段文字', () => {
    expect(getLiveText({ answer: '正在写', steps }, false)).toEqual({ text: '正在写', isAnswer: true });
    expect(getLiveText({ answer: '', steps }, false)).toEqual({ text: '第二段', isAnswer: false });
    expect(getLiveText({ answer: '', steps: [] }, false).text).toBe('');
  });
  it('展开：只给 answer，避免与展开区重复', () => {
    expect(getLiveText({ answer: '', steps }, true).text).toBe('');
    expect(getLiveText({ answer: '最终答复', steps }, true)).toEqual({ text: '最终答复', isAnswer: true });
  });
});

describe('toolContentToText', () => {
  it('string / 数组 / 其他', () => {
    expect(toolContentToText('abc')).toBe('abc');
    expect(toolContentToText(null)).toBe('');
    expect(toolContentToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(toolContentToText([{ type: 'image', source: {} }])).toBe('[图片]');
    expect(toolContentToText({ type: 'text', text: 'x' })).toBe('x');
    expect(toolContentToText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(toolContentToText(42)).toBe('42');
  });
});

describe('truncateText', () => {
  it('未超长原样返回，超长截断', () => {
    expect(truncateText('abc', 5)).toEqual({ text: 'abc', truncated: false, total: 3 });
    expect(truncateText('abcdef', 4)).toEqual({ text: 'abcd', truncated: true, total: 6 });
  });
});

describe('describeToolInput', () => {
  it('Bash 取 command，其余 JSON', () => {
    expect(describeToolInput({ name: 'Bash', input: { command: 'ls -la' } })).toEqual({ lang: 'bash', text: 'ls -la' });
    expect(describeToolInput({ name: 'Read', input: { file_path: 'a.ts' } }).text).toBe('{\n  "file_path": "a.ts"\n}');
    expect(describeToolInput({ name: 'X', input: undefined }).text).toBe('');
  });
});

describe('thinkingPreview', () => {
  it('压成一行并截断', () => {
    expect(thinkingPreview('a\n\n b   c', 40)).toBe('a b c');
    expect(thinkingPreview('1234567890', 5)).toBe('12345…');
  });
});

describe('subagentProgress', () => {
  it('error 计入已完成', () => {
    expect(subagentProgress([{ status: 'done' }, { status: 'running' }, { status: 'error' }])).toEqual({
      total: 3,
      finished: 2,
      allDone: false,
    });
    expect(subagentProgress([{ status: 'done' }, { status: 'error' }]).allDone).toBe(true);
    expect(subagentProgress([]).allDone).toBe(false);
  });
});

describe('splitUserText', () => {
  const atts = [
    { kind: 'file' as const, label: 'file1', path: 'C:\\a.ts' },
    { kind: 'folder' as const, label: 'folder1', path: 'C:\\d' },
  ];
  it('把占位名切成附件段', () => {
    expect(splitUserText('比较 file1 和 folder1。', atts)).toEqual([
      { type: 'text', text: '比较 ' },
      { type: 'attachment', attachment: atts[0] },
      { type: 'text', text: ' 和 ' },
      { type: 'attachment', attachment: atts[1] },
      { type: 'text', text: '。' },
    ]);
  });
  it('不误伤 myfile1 / file10', () => {
    expect(splitUserText('myfile1 file10', atts)).toEqual([{ type: 'text', text: 'myfile1 file10' }]);
  });
  it('无附件时整段文字', () => {
    expect(splitUserText('hi', [])).toEqual([{ type: 'text', text: 'hi' }]);
    expect(splitUserText('', [])).toEqual([]);
  });
});
