import { describe, expect, it } from 'vitest';
import { hasThinkingText, thinkingFirstLine, thinkingTokensLabel } from './thinking';

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

describe('thinkingTokensLabel', () => {
  it('有文本：没有附注（不再有「思考中 / 已思考」措辞）', () => {
    expect(thinkingTokensLabel({ text: 'x', tokens: 30 })).toBe('');
  });
  it('无文本：只有 token 数；未知 / 为 0 时为空串', () => {
    expect(thinkingTokensLabel({ text: '', tokens: 1234 })).toBe('1,234 tokens');
    expect(thinkingTokensLabel({ text: '  ', tokens: 50 })).toBe('50 tokens');
    expect(thinkingTokensLabel({ text: '' })).toBe('');
    expect(thinkingTokensLabel({ text: '', tokens: 0 })).toBe('');
  });
  it('hasThinkingText 忽略纯空白', () => {
    expect(hasThinkingText(' \n ')).toBe(false);
    expect(hasThinkingText(' a ')).toBe(true);
  });
});
