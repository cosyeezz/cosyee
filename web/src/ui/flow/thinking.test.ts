import { describe, expect, it } from 'vitest';
import { hasThinkingText, thinkingFirstLine, thinkingLabel } from './thinking';

describe('thinkingFirstLine', () => {
  it('取第一个非空行，跳过开头空行并压缩空白', () => {
    expect(thinkingFirstLine('\n\n  第一行   内容 \n第二行')).toBe('第一行 内容');
    expect(thinkingFirstLine('only')).toBe('only');
    expect(thinkingFirstLine('a\r\nb')).toBe('a');
  });
  it('去掉标题符号与整行加粗', () => {
    expect(thinkingFirstLine('**Planning the answer**\n\nbody')).toBe('Planning the answer');
    expect(thinkingFirstLine('## 标题\n正文')).toBe('标题');
    expect(thinkingFirstLine('**半行**加粗')).toBe('**半行**加粗');
  });
  it('空文本返回空串；超长单行兜底截断', () => {
    expect(thinkingFirstLine('')).toBe('');
    expect(thinkingFirstLine('   \n  ')).toBe('');
    expect(thinkingFirstLine('1234567890', 5)).toBe('12345…');
  });
});

describe('thinkingLabel', () => {
  it('有文本：思考中… / 已思考', () => {
    expect(thinkingLabel({ text: 'x', streaming: true, tokens: 30 })).toBe('思考中…');
    expect(thinkingLabel({ text: 'x', tokens: 30 })).toBe('已思考');
  });
  it('无文本：带 token 数；未知时省略', () => {
    expect(thinkingLabel({ text: '', tokens: 1234 })).toBe('已思考（1,234 tokens）');
    expect(thinkingLabel({ text: '', streaming: true, tokens: 50 })).toBe('思考中（50 tokens）');
    expect(thinkingLabel({ text: '' })).toBe('已思考');
    expect(thinkingLabel({ text: '  ', streaming: true })).toBe('思考中…');
    expect(thinkingLabel({ text: '', tokens: 0 })).toBe('已思考');
  });
  it('hasThinkingText 忽略纯空白', () => {
    expect(hasThinkingText(' \n ')).toBe(false);
    expect(hasThinkingText(' a ')).toBe(true);
  });
});
