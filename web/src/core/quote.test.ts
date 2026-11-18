import { describe, expect, it } from 'vitest';
import { labelChips, parseUserText, serialize, type Segment } from './composer';
import { buildQuotedMessage, parseQuote } from './quote';

describe('buildQuotedMessage', () => {
  it('单行引用 + 正文：引用块、空一行、正文', () => {
    expect(buildQuotedMessage('这是一句话', '我的回复')).toBe('> 这是一句话\n\n我的回复');
  });

  it('多行引用：每行前加 > ，统一 CRLF', () => {
    expect(buildQuotedMessage('第一行\r\n第二行\n\n第四行', '好')).toBe('> 第一行\n> 第二行\n> \n> 第四行\n\n好');
  });

  it('正文为空：只有引用块', () => {
    expect(buildQuotedMessage('abc', '')).toBe('> abc');
  });

  it('没有引用 / 引用全是空白：原样返回正文', () => {
    expect(buildQuotedMessage(null, '正文')).toBe('正文');
    expect(buildQuotedMessage('  \n ', '正文')).toBe('正文');
  });

  it('正文含路径标签：正文仍走 serialize，路径引用不变', () => {
    const segs: Segment[] = labelChips([
      { t: 'text', text: '看看 ' },
      { t: 'chip', kind: 'file', path: 'C:\\a\\b.ts', label: '' },
      { t: 'text', text: ' 这个' },
    ]);
    expect(buildQuotedMessage('引用', serialize(segs))).toBe('> 引用\n\n看看 @"C:\\a\\b.ts" 这个');
  });
});

describe('parseQuote', () => {
  it('解析开头的引用块', () => {
    expect(parseQuote('> 引用文字\n\n我的回复')).toEqual({ quote: '引用文字', body: '我的回复' });
  });

  it('多行引用（含空引用行）与往返', () => {
    const msg = buildQuotedMessage('a\nb\n\nd', '正文\n第二行');
    expect(parseQuote(msg)).toEqual({ quote: 'a\nb\n\nd', body: '正文\n第二行' });
  });

  it('只有引用块，没有正文', () => {
    expect(parseQuote('> 只有引用')).toEqual({ quote: '只有引用', body: '' });
    expect(parseQuote('> 只有引用\n\n')).toEqual({ quote: '只有引用', body: '' });
  });

  it('无引用块的普通消息不受影响', () => {
    for (const s of ['你好', '', '正文里有 > 符号\n> 不在开头', '>没有空格', '  > 前面有空格']) {
      expect(parseQuote(s)).toEqual({ quote: null, body: s });
    }
  });

  it('引用块后紧跟非空行（不是本功能的格式）：当作普通消息', () => {
    expect(parseQuote('> a\n后面直接接字')).toEqual({ quote: null, body: '> a\n后面直接接字' });
  });

  it('不破坏 parseUserText 的路径标签还原', () => {
    const msg = buildQuotedMessage('一段引用', '看看 @"C:\\a\\b.ts" 和 @"D:\\img\\x.png"');
    const { quote, body } = parseQuote(msg);
    expect(quote).toBe('一段引用');
    const parsed = parseUserText(body);
    expect(parsed.userText).toBe('看看 file1 和 img1');
    expect(parsed.attachments.map((a) => a.path)).toEqual(['C:\\a\\b.ts', 'D:\\img\\x.png']);
    // 整条消息先走 parseUserText（历史加载 / 回显）后再拆引用，同样成立
    const whole = parseUserText(msg);
    expect(parseQuote(whole.userText)).toEqual({ quote: '一段引用', body: '看看 file1 和 img1' });
    expect(whole.attachments).toHaveLength(2);
  });
});
