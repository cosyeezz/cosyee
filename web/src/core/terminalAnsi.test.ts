import { describe, expect, it } from 'vitest';
import { ansi256Color, createAnsiParser, parseAnsi, stripAnsi } from './terminalAnsi';

describe('terminalAnsi', () => {
  it('解析基础 SGR 样式与 16 色 / 亮色', () => {
    const lines = parseAnsi('\x1b[1;3;4;31merr\x1b[22;23;24;92mok\x1b[0mplain');
    expect(lines).toHaveLength(1);
    const spans = lines[0]!;
    expect(spans).toHaveLength(3);
    expect(spans[0]).toMatchObject({
      text: 'err',
      style: { bold: true, italic: true, underline: true, fg: 'var(--term-c1)' },
    });
    expect(spans[1]).toMatchObject({
      text: 'ok',
      style: { fg: 'var(--term-c10)' },
    });
    expect(spans[1]!.style.bold).toBeUndefined();
    expect(spans[2]).toEqual({ text: 'plain', style: {} });
  });

  it('支持暗淡、反色、删除线与 256 色 / 真彩色', () => {
    const lines = parseAnsi(
      '\x1b[2;7;9;38;5;196;48;2;10;20;30mhi\x1b[27;29;39;49m\x1b[38:2::255:128:0mrgb',
    );
    expect(lines).toHaveLength(1);
    const [a, b] = lines[0]!;
    expect(a!.text).toBe('hi');
    expect(a!.style).toMatchObject({
      dim: true,
      inverse: true,
      strike: true,
      fg: ansi256Color(196),
      bg: 'rgb(10, 20, 30)',
    });
    expect(b!.text).toBe('rgb');
    expect(b!.style).toMatchObject({
      dim: true,
      fg: 'rgb(255, 128, 0)',
    });
    expect(b!.style.inverse).toBeUndefined();
    expect(b!.style.bg).toBeUndefined();
  });

  it('正确处理 \\r 同一行回车覆盖（进度条）与 \\r\\n 换行', () => {
    const lines = parseAnsi('Downloading 10%\rDownloading 55%\rDownloading 100% done!\r\nNext line');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.map((s) => s.text).join('')).toBe('Downloading 100% done!');
    expect(lines[1]!.map((s) => s.text).join('')).toBe('Next line');
  });

  it('正确处理 \\b 退格覆盖与 CSI K 清除到行尾', () => {
    const lines = parseAnsi('abc\b\bXY\nhello world\rhi\x1b[K');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.map((s) => s.text).join('')).toBe('aXY');
    expect(lines[1]!.map((s) => s.text).join('')).toBe('hi');
  });

  it('识别普通 http(s) URL 并去除尾随标点', () => {
    const lines = parseAnsi('Local: http://localhost:5173/app?a=1. (see https://example.com/docs)');
    expect(lines).toHaveLength(1);
    const links = lines[0]!.filter((s) => s.href);
    expect(links.map((s) => s.href)).toEqual([
      'http://localhost:5173/app?a=1',
      'https://example.com/docs',
    ]);
  });

  it('支持 OSC 8 超链接并剥离其他 OSC / CSI 控制序列', () => {
    const input = '\x1b]0;Window Title\x07\x1b[?25l\x1b]8;;https://cosyee.dev\x07Cosyee\x1b]8;;\x07\x1b[?25h';
    const lines = parseAnsi(input);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveLength(1);
    expect(lines[0]![0]).toMatchObject({
      text: 'Cosyee',
      href: 'https://cosyee.dev',
    });
  });

  it('增量解析支持跨分片转义序列并复用已完成行的引用', () => {
    const p = createAnsiParser();
    p.append('line1\n\x1b[38;2;');
    const firstSnap = p.getLines();
    expect(firstSnap).toHaveLength(1);
    const line1Ref = firstSnap[0];

    p.append('12;34;56mcolored');
    const secondSnap = p.getLines();
    expect(secondSnap).toHaveLength(2);
    expect(secondSnap[0]).toBe(line1Ref);
    expect(secondSnap[1]![0]).toMatchObject({
      text: 'colored',
      style: { fg: 'rgb(12, 34, 56)' },
    });
  });

  it('stripAnsi 输出干净纯文本', () => {
    expect(stripAnsi('\x1b[32mPASS\x1b[0m 10%\r\x1b[32mPASS\x1b[0m 100%\nDone')).toBe('PASS 100%\nDone');
  });
});
