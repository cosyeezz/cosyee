import { describe, expect, it } from 'vitest';
import { tokenize, CHIP_CHAR } from './mdHighlight';
import { listIndentEdit, listNewlineEdit, matchListItem, nextItemPrefix } from './mdList';

const join = (text: string) => tokenize(text).map((l) => l.pieces.map((p) => p.text).join('')).join('\n');
const clsOf = (text: string, piece: string) =>
  tokenize(text).flatMap((l) => l.pieces).find((p) => p.text === piece)?.cls;

describe('mdHighlight', () => {
  const samples = [
    '# 标题 **粗** `code`',
    '- [ ] 任务 *斜* ~~删~~',
    '1. 有序\n   2) 嵌套 [链接](http://x.y)',
    '> 引用 **b**\n> - 列表',
    '```ts\nconst a = *1*;\n```\n后面',
    '```\n没闭合 **x**',
    '---',
    `文件${CHIP_CHAR}和 https://example.com/a?b=1。结尾`,
    '\\*转义\\* ** 空 ** snake_case_name 2*3*4',
    '',
    '\n\n',
  ];
  it('所有片段拼回去与原文逐字相同（着色不改变序列化结果）', () => {
    for (const s of samples) expect(join(s)).toBe(s);
  });

  it('行数 = split("\\n") 的行数', () => {
    for (const s of samples) expect(tokenize(s).length).toBe(s.split('\n').length);
  });

  it('标记符号保留且变淡，内容带样式', () => {
    expect(clsOf('**粗**', '**')).toContain('cz-md-mark');
    expect(clsOf('**粗**', '粗')).toBe('cz-md-b');
    expect(clsOf('*斜*', '斜')).toBe('cz-md-i');
    expect(clsOf('`c`', 'c')).toBe('cz-md-icode');
    expect(clsOf('~~x~~', 'x')).toBe('cz-md-del');
    expect(clsOf('# 标题', '标题')).toContain('cz-md-h1');
    expect(clsOf('- 项', '- ')).toContain('cz-md-bullet');
  });

  it('代码块内不做行内着色，并标记 fence', () => {
    const lines = tokenize('```\n**x**\n```\n**y**');
    expect(lines.map((l) => l.fence)).toEqual([true, true, true, false]);
    expect(lines[1].pieces).toEqual([{ cls: 'cz-md-code', text: '**x**' }]);
  });

  it('蛇形命名与未配对符号不会被当成斜体', () => {
    expect(tokenize('snake_case_name').flatMap((l) => l.pieces).every((p) => !p.cls)).toBe(true);
    expect(tokenize('a * b').flatMap((l) => l.pieces).every((p) => !p.cls)).toBe(true);
  });

  it('几千字符的文本着色足够快', () => {
    const text = Array.from({ length: 300 }, (_, i) => `- 第 ${i} 项 **粗** \`code\` [l](http://a.b) *i*`).join('\n');
    expect(text.length).toBeGreaterThan(5000);
    const t = performance.now();
    expect(join(text)).toBe(text);
    expect(performance.now() - t).toBeLessThan(500);
  });
});

describe('mdList', () => {
  it('识别各种列表项', () => {
    expect(matchListItem('- a')?.prefixLen).toBe(2);
    expect(matchListItem('  * a')?.indent).toBe('  ');
    expect(matchListItem('12. a')?.num).toBe(12);
    expect(matchListItem('3) a')?.delim).toBe(')');
    expect(matchListItem('- [x] a')?.checkbox).toBe('[x] ');
    expect(matchListItem('-a')).toBeNull();
    expect(matchListItem('普通文字')).toBeNull();
  });

  it('下一项前缀：序号 +1、缩进保留、任务重置', () => {
    expect(nextItemPrefix(matchListItem('  9. x')!)).toBe('  10. ');
    expect(nextItemPrefix(matchListItem('- [x] x')!)).toBe('- [ ] ');
    expect(nextItemPrefix(matchListItem('+ x')!)).toBe('+ ');
  });

  it('换行续写', () => {
    const t = '1. 苹果';
    expect(listNewlineEdit(t, t.length)).toEqual({ from: 5, to: 5, insert: '\n2. ', caret: 9 });
  });

  it('空项退出列表（去掉前缀，不换行）', () => {
    const t = '- a\n- ';
    expect(listNewlineEdit(t, t.length)).toEqual({ from: 4, to: 6, insert: '', caret: 4 });
  });

  it('非列表 / 光标在前缀里 / 代码块里交给默认行为', () => {
    expect(listNewlineEdit('普通', 2)).toBeNull();
    expect(listNewlineEdit('- abc', 1)).toBeNull();
    expect(listNewlineEdit('- abc', 5, true)).toBeNull();
  });

  it('Tab 缩进 / Shift+Tab 反缩进', () => {
    const r = listIndentEdit('- a\n- b', 7, 7, false)!;
    expect(r.text).toBe('- a\n  - b');
    expect(r.start).toBe(9);
    expect(listIndentEdit(r.text, 9, 9, true)!.text).toBe('- a\n- b');
    expect(listIndentEdit('1. a', 0, 4, false)!.text).toBe('   1. a');
  });

  it('选区跨多行时每个列表项都缩进；非列表返回 null', () => {
    expect(listIndentEdit('- a\n- b', 0, 7, false)!.text).toBe('  - a\n  - b');
    expect(listIndentEdit('普通', 0, 2, false)).toBeNull();
  });

  it('已无缩进时反缩进吞掉按键但不改文本', () => {
    const r = listIndentEdit('- a', 3, 3, true)!;
    expect(r.text).toBe('- a');
  });
});
