import { describe, expect, it } from 'vitest';
import { speechText, splitSentences } from './speech/text.js';
import { encodeWav, pcm16ToFloat32 } from './speech/wav.js';

describe('speechText', () => {
  it('代码块、表格各念一次「略」，标题列表引用去掉标记', () => {
    const md = [
      '## 结论',
      '- 已修复 **登录** 问题',
      '> 注意备份',
      '```ts',
      'const a = 1;',
      '```',
      '```',
      'b',
      '```',
      '| a | b |',
      '|---|---|',
      '| 1 | 2 |',
      '---',
      '完成。',
    ].join('\n');
    expect(speechText(md).split('\n')).toEqual(['结论', '已修复 登录 问题', '注意备份', '代码略。', '表格略。', '完成。']);
  });

  it('链接留文字、路径只念文件名、URL 换成「链接」、长行内代码略过', () => {
    expect(speechText('改了 [http.ts](F:/Cosyee/server/src/http.ts:254)')).toBe('改了 http.ts');
    expect(speechText('见 F:/Cosyee/server/src/http.ts 和 `server/src/a.ts`')).toBe('见 http.ts 和 a.ts');
    expect(speechText('打开 https://example.com/x?y=1 看看')).toBe('打开 链接 看看');
    expect(speechText('运行 `npm test`，或者 `' + 'x'.repeat(50) + '`')).toBe('运行 npm test，或者 代码略。');
    expect(speechText('![图](a.png)snake_case 不动 *强调*')).toBe('snake_case 不动 强调');
  });
});

describe('splitSentences', () => {
  it('按句末标点切，过短的并到后一句', () => {
    expect(splitSentences('好的。我已经修复了这个问题！测试全部通过了吗？是的')).toEqual(['好的。我已经修复了这个问题！', '测试全部通过了吗？是的']);
  });
  it('英文句号后跟空格才切，文件名里的点不切', () => {
    expect(splitSentences('Fixed the bug in http.ts today. All tests pass now.')).toEqual(['Fixed the bug in http.ts today.', 'All tests pass now.']);
  });
  it('超长句在逗号处切开，每段不超过 120 字', () => {
    const long = Array.from({ length: 30 }, (_, i) => `第${i}项内容`).join('，');
    const segs = splitSentences(long);
    expect(segs.length).toBeGreaterThan(1);
    for (const s of segs) expect(s.length).toBeLessThanOrEqual(120);
    expect(segs.join('')).toBe(long);
  });
  it('只有标点或空白时没有段', () => {
    expect(splitSentences('\n…\n——\n')).toEqual([]);
  });
});

describe('wav', () => {
  it('WAV 头正确、样本截断到 [-1, 1]', () => {
    const b = encodeWav(new Float32Array([0, 1, -1, 2]), 22050);
    expect(b.length).toBe(44 + 8);
    expect(b.toString('ascii', 0, 4)).toBe('RIFF');
    expect(b.readUInt32LE(24)).toBe(22050);
    expect([b.readInt16LE(44), b.readInt16LE(46), b.readInt16LE(48), b.readInt16LE(50)]).toEqual([0, 32767, -32768, 32767]);
  });
  it('PCM16 转浮点', () => {
    const buf = Buffer.alloc(5);
    buf.writeInt16LE(16384, 0);
    buf.writeInt16LE(-32768, 2);
    expect(Array.from(pcm16ToFloat32(buf))).toEqual([0.5, -1]);
  });
});
