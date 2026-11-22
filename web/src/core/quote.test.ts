import { describe, expect, it } from 'vitest';
import { labelChips, parseUserText, serialize, type Segment } from './composer';
import { addQuote, buildQuotedMessage, parseQuotes } from './quote';

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
    expect(buildQuotedMessage([], '正文')).toBe('正文');
    expect(buildQuotedMessage([' ', '\n'], '正文')).toBe('正文');
  });

  it('正文含路径标签：正文仍走 serialize，路径引用不变', () => {
    const segs: Segment[] = labelChips([
      { t: 'text', text: '看看 ' },
      { t: 'chip', kind: 'file', path: 'C:\\a\\b.ts', label: '' },
      { t: 'text', text: ' 这个' },
    ]);
    expect(buildQuotedMessage('引用', serialize(segs))).toBe('> 引用\n\n看看 @"C:\\a\\b.ts" 这个');
  });

  it('数组形式的单段引用与字符串形式字节一致', () => {
    expect(buildQuotedMessage(['引用'], '回复')).toBe(buildQuotedMessage('引用', '回复'));
    expect(buildQuotedMessage(['a\nb'], '')).toBe(buildQuotedMessage('a\nb', ''));
  });

  it('多段引用：各自成块，块之间空一行，再空一行接正文', () => {
    expect(buildQuotedMessage(['第一段', '第二段\n第二行'], '回复')).toBe('> 第一段\n\n> 第二段\n> 第二行\n\n回复');
    expect(buildQuotedMessage(['第一段', '第二段'], '')).toBe('> 第一段\n\n> 第二段');
  });

  it('多段引用中的空白段被忽略', () => {
    expect(buildQuotedMessage(['a', '  ', 'b'], 'x')).toBe('> a\n\n> b\n\nx');
  });

  it('正文以 > 开头：多空一行，避免被当成下一段引用', () => {
    expect(buildQuotedMessage(['a'], '> 我的话')).toBe('> a\n\n\n> 我的话');
    expect(buildQuotedMessage(['a'], '>')).toBe('> a\n\n\n>');
    expect(buildQuotedMessage(['a'], '>没有空格')).toBe('> a\n\n>没有空格');
  });
});

describe('buildQuotedMessage：每段带回复', () => {
  it('引用 → 它的回复 → 下一段引用 → …… → 正文', () => {
    expect(buildQuotedMessage([{ quote: '用哪台设备？', reply: '三者都有' }, { quote: '要不要配置？', reply: '最好不配置' }], ''))
      .toBe('> 用哪台设备？\n\n三者都有\n\n> 要不要配置？\n\n最好不配置');
    expect(buildQuotedMessage([{ quote: '甲', reply: 'r1' }, { quote: '乙', reply: '' }], '正文'))
      .toBe('> 甲\n\nr1\n\n> 乙\n\n正文');
  });

  it('回复为空等同于纯引用；字符串与 QuoteReply 可混用', () => {
    expect(buildQuotedMessage([{ quote: '甲', reply: '  ' }], '回复')).toBe(buildQuotedMessage('甲', '回复'));
    expect(buildQuotedMessage(['甲', { quote: '乙', reply: 'r' }], '')).toBe('> 甲\n\n> 乙\n\nr');
  });

  it('引用为空白的段整段忽略（连同回复）', () => {
    expect(buildQuotedMessage([{ quote: ' ', reply: 'r' }], '正文')).toBe('正文');
  });

  it('回复以 > 开头：前面多空一行', () => {
    expect(buildQuotedMessage([{ quote: '甲', reply: '> r' }], '')).toBe('> 甲\n\n\n> r');
  });
});

describe('addQuote', () => {
  it('追加到末尾，保存规范化后的引用与回复', () => {
    expect(addQuote([], '  甲\r\n乙 ', ' 好 ')).toEqual([{ quote: '甲\n乙', reply: '好' }]);
    expect(addQuote([{ quote: '甲', reply: '' }], '乙')).toEqual([{ quote: '甲', reply: '' }, { quote: '乙', reply: '' }]);
  });

  it('引用为空白 / 重复引用且回复为空或相同：返回原数组', () => {
    const list = [{ quote: '甲', reply: 'r' }];
    expect(addQuote(list, '  ', 'x')).toBe(list);
    expect(addQuote(list, ' 甲\n')).toBe(list);
    expect(addQuote(list, '甲', 'r')).toBe(list);
  });

  it('重复引用带新回复：不新增卡片，回复接在原回复后面', () => {
    expect(addQuote([{ quote: '甲', reply: 'r1' }], '甲', 'r2')).toEqual([{ quote: '甲', reply: 'r1\nr2' }]);
    expect(addQuote([{ quote: '甲', reply: '' }], '甲', 'r2')).toEqual([{ quote: '甲', reply: 'r2' }]);
  });
});

const P = (quote: string, text: string) => ({ quote, text });

describe('parseQuotes', () => {
  it('解析开头的引用块', () => {
    expect(parseQuotes('> 引用文字\n\n我的回复')).toEqual([P('引用文字', '我的回复')]);
  });

  it('多行引用（含空引用行）与往返', () => {
    const msg = buildQuotedMessage('a\nb\n\nd', '正文\n第二行');
    expect(parseQuotes(msg)).toEqual([P('a\nb\n\nd', '正文\n第二行')]);
  });

  it('只有引用块，没有正文', () => {
    expect(parseQuotes('> 只有引用')).toEqual([P('只有引用', '')]);
    expect(parseQuotes('> 只有引用\n\n')).toEqual([P('只有引用', '')]);
  });

  it('无引用块的普通消息：null', () => {
    for (const s of ['你好', '', '正文里有 > 符号\n> 不在开头', '>没有空格', '  > 前面有空格']) {
      expect(parseQuotes(s)).toBeNull();
    }
  });

  it('第一个引用块后紧跟非空行（不是本功能的格式）：null', () => {
    expect(parseQuotes('> a\n后面直接接字')).toBeNull();
  });

  it('后面的引用块紧跟非空行：不算分段，归入前一段的文字', () => {
    expect(parseQuotes('> a\n\n> b\n后面直接接字')).toEqual([P('a', '> b\n后面直接接字')]);
  });

  it('不破坏 parseUserText 的路径标签还原', () => {
    const msg = buildQuotedMessage('一段引用', '看看 @"C:\\a\\b.ts" 和 @"D:\\img\\x.png"');
    const parts = parseQuotes(msg)!;
    expect(parts.map((p) => p.quote)).toEqual(['一段引用']);
    const parsed = parseUserText(parts[0].text);
    expect(parsed.userText).toBe('看看 file1 和 img1');
    expect(parsed.attachments.map((a) => a.path)).toEqual(['C:\\a\\b.ts', 'D:\\img\\x.png']);
    // 整条消息先走 parseUserText（历史加载 / 回显）后再拆引用，同样成立
    const whole = parseUserText(msg);
    expect(parseQuotes(whole.userText)).toEqual([P('一段引用', '看看 file1 和 img1')]);
    expect(whole.attachments).toHaveLength(2);
  });

  it('旧格式（只支持一段时发出的消息）', () => {
    expect(parseQuotes('> 旧引用\n> 第二行\n\n旧回复\n\n另一段')).toEqual([P('旧引用\n第二行', '旧回复\n\n另一段')]);
  });

  it('旧的多段格式（引用全在前、正文在后）', () => {
    expect(parseQuotes('> 甲\n\n> 乙\n> 乙2\n\n> 丙\n\n回复')).toEqual([P('甲', ''), P('乙\n乙2', ''), P('丙', '回复')]);
    expect(parseQuotes('> 甲\n\n> 乙\n\n')).toEqual([P('甲', ''), P('乙', '')]);
  });

  it('每段后紧跟它的回复', () => {
    expect(parseQuotes('> 用哪台设备？\n\n三者都有\n\n> 要不要配置？\n\n最好不配置\n\n还有一件事'))
      .toEqual([P('用哪台设备？', '三者都有'), P('要不要配置？', '最好不配置\n\n还有一件事')]);
  });

  it('围栏代码里的 > 行不算分段', () => {
    expect(parseQuotes('> 甲\n\n```\nx\n\n> y\n```')).toEqual([P('甲', '```\nx\n\n> y\n```')]);
  });
});

describe('build → parse 往返', () => {
  type Q = string | { quote: string; reply: string };
  const cases: Array<{ name: string; quotes: Q[]; body: string; want: Array<[string, string]> }> = [
    { name: '单段 + 正文', quotes: ['引用'], body: '回复', want: [['引用', '回复']] },
    { name: '单段无正文', quotes: ['引用'], body: '', want: [['引用', '']] },
    { name: '两段', quotes: ['甲', '乙'], body: '回复', want: [['甲', ''], ['乙', '回复']] },
    { name: '引用内含空行', quotes: ['a\n\nb', 'c\n\n\nd'], body: '回复', want: [['a\n\nb', ''], ['c\n\n\nd', '回复']] },
    { name: '引用本身以 > 开头', quotes: ['> 嵌套', '>x'], body: '回复', want: [['> 嵌套', ''], ['>x', '回复']] },
    { name: '正文多段落', quotes: ['甲', '乙'], body: '第一段\n\n第二段\n- 列表', want: [['甲', ''], ['乙', '第一段\n\n第二段\n- 列表']] },
    { name: '正文以 > 开头', quotes: ['甲'], body: '> 我的话\n后续', want: [['甲', '> 我的话\n后续']] },
    { name: '正文就是 >', quotes: ['甲', '乙'], body: '>', want: [['甲', ''], ['乙', '>']] },
    {
      name: '每段带回复 + 正文',
      quotes: [{ quote: '甲', reply: 'r1\n\nr1b' }, { quote: '乙', reply: '' }, { quote: '丙', reply: '> r3' }],
      body: 'b',
      want: [['甲', 'r1\n\nr1b'], ['乙', ''], ['丙', '> r3\n\nb']],
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(parseQuotes(buildQuotedMessage(c.quotes, c.body))).toEqual(c.want.map(([q, t]) => P(q, t)));
    });
  }

  it('CRLF 消息同样可解析', () => {
    const msg = buildQuotedMessage([{ quote: '甲', reply: 'r' }, '乙'], '回复').replace(/\n/g, '\r\n');
    expect(parseQuotes(msg)).toEqual([P('甲', 'r'), P('乙', '回复')]);
  });
});
