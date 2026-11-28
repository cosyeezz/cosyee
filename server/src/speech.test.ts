import { describe, expect, it } from 'vitest';
import { MAX_STT_SECONDS } from './speech/index.js';
import { PAUSE_MS, speakable, speechSegments, speechText, splitSentences } from './speech/text.js';
import { appendSilence, encodeWav, joinTranscripts, normalizeLoudness, pcm16ToFloat32, splitAudioChunks, trimSilence } from './speech/wav.js';

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

  it('URL 替换不吞掉紧跟的中文标点与结尾半角标点', () => {
    expect(speechText('请看 https://a.com。')).toBe('请看 链接。');
    expect(speechText('访问 https://a.com/x，以及 https://b.com/y！')).toBe('访问 链接，以及 链接！');
    expect(speechText('见「https://a.com/doc」（详情见 https://b.com/ref）。')).toBe('见「链接」（详情见 链接）。');
    expect(speechText('See (https://a.com/foo), and https://b.com/bar.')).toBe('See (链接), and 链接.');
  });
});

describe('speechSegments', () => {
  it('短标题单独成段不与下一句合并，标题前后停顿达标', () => {
    const md = ['## 结论', '已经修复了登录问题。这是第二句说明。', '## 下一步', '完成。'].join('\n');
    const segs = speechSegments(md);
    expect(segs).toEqual([
      { text: '结论', pause: 'heading' },
      { text: '已经修复了登录问题。', pause: 'sentence' },
      { text: '这是第二句说明。', pause: 'paragraph' },
      { text: '下一步', pause: 'heading' },
      { text: '完成。', pause: 'paragraph' },
    ]);
    expect(PAUSE_MS.heading).toBeGreaterThanOrEqual(600);
    expect(PAUSE_MS.paragraph).toBeGreaterThanOrEqual(500);
  });

  it('列表项不跨项合并，标题前的列表项停顿升级到至少 paragraph', () => {
    const md = ['- 第一项', '- 第二项', '## 总结', '全部完成。'].join('\n');
    expect(speechSegments(md)).toEqual([
      { text: '第一项', pause: 'item' },
      { text: '第二项', pause: 'paragraph' },
      { text: '总结', pause: 'heading' },
      { text: '全部完成。', pause: 'paragraph' },
    ]);
  });

  it('段内短句合并但绝不跨段落合并', () => {
    const md = ['好的。', '完成。', '好的。我已经修复了这个问题！'].join('\n');
    expect(speechSegments(md)).toEqual([
      { text: '好的。', pause: 'paragraph' },
      { text: '完成。', pause: 'paragraph' },
      { text: '好的。我已经修复了这个问题！', pause: 'paragraph' },
    ]);
  });

  it('超长句均匀切分，中间段停顿为 clause，末尾段继承块停顿', () => {
    const long = Array.from({ length: 24 }, (_, i) => `第${i}项内容`).join('，');
    const segs = speechSegments(long);
    expect(segs.length).toBeGreaterThan(1);
    for (let i = 0; i < segs.length; i++) {
      expect(segs[i]!.text.length).toBeLessThanOrEqual(120);
      expect(segs[i]!.text.length).toBeGreaterThanOrEqual(20); // 均匀切分，无极短碎片
      expect(segs[i]!.pause).toBe(i === segs.length - 1 ? 'paragraph' : 'clause');
    }
    expect(segs.map((s) => s.text).join('')).toBe(long);
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

  it('trimSilence 裁掉首尾静音并保留 pad，全静音返回空', () => {
    const sr = 1000; // 1ms = 1 sample
    const samples = new Float32Array(500);
    // [200, 300) 放有效信号
    for (let i = 200; i < 300; i++) samples[i] = 0.2 * Math.sin(i);
    const trimmed = trimSilence(samples, sr, { threshold: 0.01, frameMs: 10, padMs: 30 });
    expect(trimmed.length).toBe(160); // 100ms 语音 + 前后各 30ms
    expect(trimSilence(new Float32Array(200), sr).length).toBe(0);
  });

  it('normalizeLoudness 拉齐 RMS、限制峰值与增益上下限', () => {
    // 较轻信号：RMS = 0.05 -> 目标 0.1（-20 dBFS），gain = 2.0
    const quiet = new Float32Array(1000).fill(0.05);
    const norm = normalizeLoudness(quiet);
    expect(norm[0]).toBeCloseTo(0.1, 4);

    // 极小底噪：RMS = 0.001 -> 目标 0.1 需要 gain=100，应被 maxGain=4.0 限制
    const noise = new Float32Array(1000).fill(0.001);
    const normNoise = normalizeLoudness(noise);
    expect(normNoise[0]).toBeCloseTo(0.004, 5);

    // 高峰值脉冲：峰值限制到 0.95
    const spiky = new Float32Array(1000).fill(0.01);
    spiky[0] = 0.9;
    const normSpiky = normalizeLoudness(spiky);
    let maxPeak = 0;
    for (let i = 0; i < normSpiky.length; i++) maxPeak = Math.max(maxPeak, Math.abs(normSpiky[i]!));
    expect(maxPeak).toBeLessThanOrEqual(0.9501);
  });

  it('appendSilence 追加精确样本数静音', () => {
    const s = new Float32Array([0.5, -0.5]);
    const out = appendSilence(s, 1000, 120);
    expect(out.length).toBe(122);
    expect(out[0]).toBe(0.5);
    expect(out[1]).toBe(-0.5);
    expect(out[2]).toBe(0);
    expect(out[121]).toBe(0);
  });

  it('splitAudioChunks 短音频不切，长音频在 [15s, 25s] 最低能量处切开', () => {
    const sr = 1000;
    // 18s 不切
    const shortAudio = new Float32Array(18 * sr).fill(0.2);
    expect(splitAudioChunks(shortAudio, sr).length).toBe(1);

    // 45s 音频，在第 18s 和第 37s 放 0.5s 静音谷
    const longAudio = new Float32Array(45 * sr);
    for (let i = 0; i < longAudio.length; i++) longAudio[i] = 0.3 * Math.sin(i * 0.1);
    longAudio.fill(0, 18_000, 18_500);
    longAudio.fill(0, 37_000, 37_500);

    const chunks = splitAudioChunks(longAudio, sr);
    expect(chunks.length).toBe(3);
    // 第一刀落在 18s 静音谷附近
    expect(chunks[0]!.length).toBeGreaterThanOrEqual(18_000);
    expect(chunks[0]!.length).toBeLessThanOrEqual(18_500);
    // 第二刀落在 37s 静音谷附近
    const secondCut = chunks[0]!.length + chunks[1]!.length;
    expect(secondCut).toBeGreaterThanOrEqual(37_000);
    expect(secondCut).toBeLessThanOrEqual(37_500);
    // 总长度守恒
    expect(chunks.reduce((acc, c) => acc + c.length, 0)).toBe(longAudio.length);
  });

  it('joinTranscripts 中文直接拼，拉丁字母/数字两侧补空格', () => {
    expect(joinTranscripts(['你好世界', '今天天气真好'])).toBe('你好世界今天天气真好');
    expect(joinTranscripts(['hello world', 'how are you'])).toBe('hello world how are you');
    expect(joinTranscripts(['版本 v2', '300 完成'])).toBe('版本 v2 300 完成');
    expect(joinTranscripts(['测试 test', '完成'])).toBe('测试 test完成');
    expect(joinTranscripts(['', '  ', '第一段。', '第二段。'])).toBe('第一段。第二段。');
  });

  it('MAX_STT_SECONDS 已提高到 180 秒', () => {
    expect(MAX_STT_SECONDS).toBe(180);
  });
});

describe('speakable', () => {
  it('百分号改成「百分之」、全角冒号分号换成逗号', () => {
    expect(speakable('覆盖率 87.5%，失败率 3％')).toBe('覆盖率 百分之87.5，失败率 百分之3');
    expect(speakable('总结：第一；第二')).toBe('总结，第一，第二');
    expect(speakable('第一项；')).toBe('第一项');
  });
});
