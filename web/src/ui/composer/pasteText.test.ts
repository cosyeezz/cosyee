import { describe, expect, it } from 'vitest';
import { cleanPastedText } from './pasteText';

describe('cleanPastedText', () => {
  it('file:/// 链接转为本地路径并解码中文', () => {
    expect(
      cleanPastedText('file:///C:/Users/a/Downloads/%E4%BC%9A%E8%AF%9D%E7%94%9F%E5%91%BD%E5%91%A8%E6%9C%9F%E5%8A%A8%E6%95%88.html'),
    ).toBe('C:/Users/a/Downloads/会话生命周期动效.html');
  });

  it('句中的链接也处理，其余文字不变', () => {
    expect(cleanPastedText('看下 file:///C:/a/%E6%96%87%20b.txt 这个')).toBe('看下 C:/a/文 b.txt 这个');
  });

  it('Unix 与 UNC 路径', () => {
    expect(cleanPastedText('file:///home/u/%E6%96%87.md')).toBe('/home/u/文.md');
    expect(cleanPastedText('file://server/share/x')).toBe('//server/share/x');
  });

  it('http 链接解码中文但保留保留字符的编码', () => {
    expect(cleanPastedText('https://x.com/%E4%B8%AD?q=a%26b')).toBe('https://x.com/中?q=a%26b');
  });

  it('非法编码与普通文本原样返回', () => {
    expect(cleanPastedText('https://x.com/%E4%ZZ')).toBe('https://x.com/%E4%ZZ');
    expect(cleanPastedText('100% 完成')).toBe('100% 完成');
  });
});
