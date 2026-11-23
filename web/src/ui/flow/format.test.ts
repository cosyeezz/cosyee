import { describe, expect, it } from 'vitest';
import type { Turn } from '@cosyee/shared';
import {
  describeToolInput,
  parseAskAnswers,
  parseAskQuestions,
  planVerdict,
  toolLine,
  formatClock,
  formatDoneText,
  formatDuration,
  formatStamp,
  getLiveText,
  getStatusLine,
  isHiddenTurn,
  latestTextLine,
  plainFirstLine,
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

describe('formatClock / formatStamp / formatDoneText', () => {
  it('HH:mm 补零', () => {
    expect(formatClock(new Date(2026, 0, 2, 3, 4).getTime())).toBe('03:04');
  });
  it('formatStamp：今天只写时间，今年其他日子带月日，跨年带年份', () => {
    const now = new Date(2026, 5, 15, 18, 0).getTime();
    expect(formatStamp(new Date(2026, 5, 15, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatStamp(new Date(2026, 5, 14, 23, 59).getTime(), now)).toBe('6月14日 23:59');
    expect(formatStamp(new Date(2026, 0, 2, 3, 4).getTime(), now)).toBe('1月2日 03:04');
    expect(formatStamp(new Date(2025, 11, 31, 8, 0).getTime(), now)).toBe('2025年12月31日 08:00');
  });
  it('已完成文案', () => {
    const start = new Date(2026, 0, 2, 9, 0, 0).getTime();
    const end = start + 185_000;
    expect(formatDoneText({ startedAt: start, endedAt: end }, end)).toBe('已完成 · 09:03 · 用时 3 分 5 秒');
    expect(formatDoneText({ startedAt: start, endedAt: end }, new Date(2026, 0, 3, 9, 0).getTime())).toBe(
      '已完成 · 1月2日 09:03 · 用时 3 分 5 秒',
    );
    expect(formatDoneText({ startedAt: start })).toBe('已完成');
  });
});

describe('plainFirstLine / latestTextLine', () => {
  it('取首个非空行并去掉 markdown 符号', () => {
    expect(plainFirstLine('\n\n  第一行   内容 \n第二行')).toBe('第一行 内容');
    expect(plainFirstLine('## 标题\n正文')).toBe('标题');
    expect(plainFirstLine('- [x] **加粗**和`代码`、[链接](http://a.b)')).toBe('加粗和代码、链接');
    expect(plainFirstLine('> 引用 *斜体* ~~删~~')).toBe('引用 斜体 删');
    expect(plainFirstLine('1. 步骤一')).toBe('步骤一');
  });
  it('跳过代码围栏与分隔线；全空返回空串；超长兜底截断', () => {
    expect(plainFirstLine('```ts\nconst a = 1\n```')).toBe('const a = 1');
    expect(plainFirstLine('---\n\n正文')).toBe('正文');
    expect(plainFirstLine('  \n ')).toBe('');
    expect(plainFirstLine('1234567890', 5)).toBe('12345…');
  });
  it('latestTextLine：answer 优先，否则最后一个有内容的文字步骤；思考和工具不参与', () => {
    const steps = [
      { kind: 'text' as const, text: '第一段' },
      { kind: 'text' as const, text: '**第二段**\n更多' },
      { kind: 'thinking' as const, text: '想一想' },
      { kind: 'tool' as const, id: 'a', name: 'Bash', input: {}, summary: 'ls' },
    ];
    expect(latestTextLine({ answer: '', steps })).toBe('第二段');
    expect(latestTextLine({ answer: '正在写的', steps })).toBe('正在写的');
    expect(latestTextLine({ answer: '', steps: steps.slice(2) })).toBe('');
    expect(latestTextLine({ answer: '  \n', steps: [{ kind: 'text', text: '   ' }] })).toBe('');
  });
});

describe('getStatusLine', () => {
  const text = (t: string) => ({ kind: 'text' as const, text: t });
  const tool = { kind: 'tool' as const, id: 'a', name: 'Bash', input: {}, summary: 'ls' };
  const thinking = { kind: 'thinking' as const, text: '思考内容', streaming: true };

  it('进行中、还没有文本：理解中（星轨），与 statusText 无关', () => {
    const u = getStatusLine({ ...baseTurn, status: 'understanding', statusText: '别的' }, 3_000);
    expect(u).toEqual({ kind: 'active', phase: 'understanding', text: '正在理解问题', meta: '3 秒' });
    expect(getStatusLine({ ...baseTurn, statusText: '先读一下 reducer' }, 12_400)).toMatchObject({
      phase: 'understanding',
      text: '正在理解问题',
      meta: '12 秒',
    });
  });
  it('思考和工具调用不改变状态：没有文本时仍是理解中', () => {
    const t = { ...baseTurn, steps: [thinking, tool] };
    expect(getStatusLine(t, 1_000)).toMatchObject({ phase: 'understanding', text: '正在理解问题' });
  });
  it('有文本：显示最近一段文本的单行形式；之后的思考 / 工具不改变它', () => {
    const t1 = { ...baseTurn, steps: [text('先读一下 **reducer**\n再看测试')] };
    expect(getStatusLine(t1, 2_000)).toEqual({
      kind: 'active',
      phase: 'text',
      text: '先读一下 reducer',
      meta: '2 秒',
      title: '先读一下 reducer',
    });
    const t2 = { ...t1, steps: [...t1.steps, tool, thinking] };
    expect(getStatusLine(t2, 2_000)).toMatchObject({ phase: 'text', text: '先读一下 reducer' });
    // 新的一段替换上一段
    const t3 = { ...t2, steps: [...t2.steps, text('## 接着改')] };
    expect(getStatusLine(t3, 2_000)).toMatchObject({ phase: 'text', text: '接着改' });
    // 正在写的 answer 优先
    expect(getStatusLine({ ...t3, answer: '最终结论如下' }, 2_000)).toMatchObject({ phase: 'text', text: '最终结论如下' });
  });
  it('委派子代理与文字同等对待：文字图标 + 委派描述，谁新显示谁', () => {
    const sub = (title: string, afterStep?: number) => ({
      toolUseId: title,
      title,
      status: 'running' as const,
      turn: baseTurn,
      ...(afterStep != null ? { afterStep } : {}),
    });
    // 没有文字，直接委派
    const one = { ...baseTurn, subagents: [sub('重构登录模块', 0)] };
    expect(getStatusLine(one, 1_000)).toMatchObject({ kind: 'active', phase: 'text', text: '委派子代理：重构登录模块' });
    // 同一条消息并行委派：合成一行；没有描述的只计数
    const many = { ...baseTurn, steps: [thinking], subagents: [sub('A', 1), sub('B', 1), sub('', 1)] };
    expect(getStatusLine(many, 1_000)).toMatchObject({ phase: 'text', text: '委派 3 个子代理：A、B' });
    expect(getStatusLine({ ...baseTurn, subagents: [sub('', 0)] }, 1_000)).toMatchObject({ text: '委派子代理' });
    // 先文字后委派 → 委派；委派之后又有文字 → 文字
    const s1 = [text('先拆一下任务'), tool];
    const t1 = { ...baseTurn, steps: s1, subagents: [sub('A', 2)] };
    expect(getStatusLine(t1, 1_000)).toMatchObject({ text: '委派子代理：A' });
    const t2 = { ...t1, steps: [...s1, text('A 做完了，接着派 B')] };
    expect(getStatusLine(t2, 1_000)).toMatchObject({ text: 'A 做完了，接着派 B' });
    // 再委派一批：只显示最新这一批
    const t3 = { ...t2, steps: [...t2.steps, tool], subagents: [...t2.subagents, sub('B', 4)] };
    expect(getStatusLine(t3, 1_000)).toMatchObject({ text: '委派子代理：B' });
    // 正在写的 answer 一定最新
    expect(getStatusLine({ ...t3, answer: '汇总一下' }, 1_000)).toMatchObject({ text: '汇总一下' });
    // 旧数据没有 afterStep：视为最早，有文字时显示文字
    expect(getStatusLine({ ...baseTurn, steps: [text('先看看')], subagents: [sub('A')] }, 1_000)).toMatchObject({ text: '先看看' });
    expect(getStatusLine({ ...baseTurn, subagents: [sub('A')] }, 1_000)).toMatchObject({ text: '委派子代理：A' });
  });
  it('进行中：有未完成的子代理时附加进度，全部完成后不再显示', () => {
    const sub = (status: 'running' | 'done' | 'error') => ({ toolUseId: status, title: '', status, turn: baseTurn });
    const t = { ...baseTurn, subagents: [sub('done'), sub('running'), sub('error')] };
    expect(getStatusLine(t, 5_000).meta).toBe('5 秒 · 子代理 2/3');
    expect(getStatusLine({ ...t, subagents: [sub('done')] }, 5_000).meta).toBe('5 秒');
  });
  it('已完成：具体时间 · 步数 · 用时；非今天带日期', () => {
    const start = new Date(2026, 5, 15, 14, 29, 42).getTime();
    const end = start + 18_000;
    const steps = [text('a'), { kind: 'thinking' as const, text: 'b' }];
    const done = { ...baseTurn, status: 'done' as const, steps, startedAt: start, endedAt: end };
    expect(getStatusLine(done, end + 1_000)).toEqual({
      kind: 'done',
      text: '已完成',
      meta: '14:30 · 共 2 步 · 用时 18 秒',
    });
    const nextDay = new Date(2026, 5, 16, 8, 0).getTime();
    expect(getStatusLine(done, nextDay).meta).toBe('6月15日 14:30 · 共 2 步 · 用时 18 秒');
    expect(getStatusLine({ ...done, steps: [] }, end).meta).toBe('14:30 · 用时 18 秒');
    expect(getStatusLine({ ...baseTurn, status: 'done' }).meta).toBe('');
  });
  it('中断 / 出错：主短语固定，具体时间与原因进 meta（与主短语重复时省略）', () => {
    const start = new Date(2026, 5, 15, 9, 0).getTime();
    const end = start + 5_000;
    const mk = (status: 'interrupted' | 'error', reason?: string) => ({ ...baseTurn, status, reason, startedAt: start, endedAt: end });
    expect(getStatusLine(mk('interrupted', '已中断'), end)).toMatchObject({ kind: 'interrupted', text: '已中断', meta: '09:00' });
    expect(getStatusLine(mk('interrupted', '用户停止'), end)).toMatchObject({ text: '已中断', meta: '09:00 · 用户停止' });
    expect(getStatusLine(mk('error', 'API 超时'), end)).toEqual({
      kind: 'error',
      text: '出错了',
      meta: '09:00 · API 超时',
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
  const done = { status: 'done' as const };
  it('执行中：一律为空（过程不占交付区，正在写的 answer 也不显示）', () => {
    expect(getLiveText({ answer: '', steps, status: 'running' }, false)).toBe('');
    expect(getLiveText({ answer: '正在写', steps, status: 'running' }, false)).toBe('');
    expect(getLiveText({ answer: '正在写', steps, status: 'understanding' }, false)).toBe('');
  });
  it('结束后折叠：answer 优先，否则最后一段文字', () => {
    expect(getLiveText({ answer: '最终答复', steps, ...done }, false)).toBe('最终答复');
    expect(getLiveText({ answer: '', steps, ...done }, false)).toBe('第二段');
    expect(getLiveText({ answer: '', steps: [], ...done }, false)).toBe('');
  });
  it('结束后展开：只给 answer，避免与展开区重复', () => {
    expect(getLiveText({ answer: '', steps, ...done }, true)).toBe('');
    expect(getLiveText({ answer: '最终答复', steps, ...done }, true)).toBe('最终答复');
  });
  it('中断 / 出错：已写出的部分仍然显示', () => {
    expect(getLiveText({ answer: '写到一半', steps, status: 'interrupted' }, false)).toBe('写到一半');
    expect(getLiveText({ answer: '', steps, status: 'error' }, false)).toBe('第二段');
  });
});

describe('isHiddenTurn', () => {
  const local = { ...baseTurn, local: true as const, status: 'done' as const };
  it('本地命令且没有任何模型内容 → 整轮不渲染', () => {
    expect(isHiddenTurn(local)).toBe(true);
  });
  it('普通一轮照常渲染', () => {
    expect(isHiddenTurn(baseTurn)).toBe(false);
  });
  it('本地命令意外产生了内容 → 仍然渲染（命令名单收错时不让整轮消失）', () => {
    expect(isHiddenTurn({ ...local, answer: '文字' })).toBe(false);
    expect(isHiddenTurn({ ...local, steps: [{ kind: 'text', text: 'x' }] })).toBe(false);
    expect(isHiddenTurn({ ...local, skills: [{ id: 'k', name: 's', source: 'user', status: 'loaded', afterStep: 0 }] })).toBe(false);
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

describe('AskUserQuestion / ExitPlanMode 展示', () => {
  const ask = { questions: [{ question: '选哪个？', header: 'H', options: [{ label: 'A', description: 'd' }, { label: 'B' }] }, { question: '再选', options: [] }] };
  it('toolLine', () => {
    expect(toolLine({ name: 'AskUserQuestion', input: ask, summary: 'x' })).toBe('提问：选哪个？（等 2 个问题）');
    expect(toolLine({ name: 'AskUserQuestion', input: { questions: [ask.questions[0]] }, summary: 'x' })).toBe('提问：选哪个？');
    expect(toolLine({ name: 'AskUserQuestion', input: {}, summary: 'AskUserQuestion' })).toBe('AskUserQuestion');
    expect(toolLine({ name: 'ExitPlanMode', input: { plan: '## 重构方案\n\n步骤' }, summary: 'ExitPlanMode' })).toBe('计划：重构方案');
    expect(toolLine({ name: 'ExitPlanMode', input: {}, summary: 'ExitPlanMode' })).toBe('计划');
    expect(toolLine({ name: 'Bash', input: {}, summary: 'Bash: ls' })).toBe('Bash: ls');
  });
  it('parseAskQuestions 容错', () => {
    const qs = parseAskQuestions(ask);
    expect(qs).toHaveLength(2);
    expect(qs[0]!.options[0]).toEqual({ label: 'A', description: 'd' });
    expect(parseAskQuestions(null)).toEqual([]);
    expect(parseAskQuestions({ questions: [1, { question: '' }] })).toEqual([]);
  });
  it('parseAskAnswers', () => {
    const t = 'Your questions have been answered: "Q1"="A1", "Q2"="B, C". You can now continue.';
    expect(parseAskAnswers(t)).toEqual({ Q1: 'A1', Q2: 'B, C' });
    expect(parseAskAnswers('nothing')).toBeNull();
  });
  it('planVerdict', () => {
    expect(planVerdict('User has approved your plan. You can now start coding.', false)).toEqual({ approved: true });
    expect(planVerdict("The user doesn't want to proceed. The user said: 加上测试", true)).toEqual({ approved: false, feedback: '加上测试' });
    expect(planVerdict('', false)).toBeNull();
  });
});
