import { describe, expect, it } from 'vitest';
import {
  guessKind, itemKind, labelChips, parseUserText, serialize, splitMentions, toAttachments, trimSegments, type Segment,
} from './composer';

const chip = (kind: 'file' | 'img' | 'folder', path: string): Segment => ({ t: 'chip', kind, path, label: '' });
const text = (s: string): Segment => ({ t: 'text', text: s });

describe('labelChips', () => {
  it('按类型分别从 1 开始编号', () => {
    const out = labelChips([
      chip('file', 'a'), text(' '), chip('img', 'b.png'), text(' '), chip('file', 'c'), chip('folder', 'd/'), chip('img', 'e.jpg'),
    ]);
    const labels = out.filter((s) => s.t === 'chip').map((s) => (s as { label: string }).label);
    expect(labels).toEqual(['file1', 'img1', 'file2', 'folder1', 'img2']);
  });

  it('同一路径重复出现仍分别编号，且不修改入参', () => {
    const input = [chip('file', 'x'), chip('file', 'x')];
    const out = labelChips(input);
    expect(toAttachments(out).map((a) => a.label)).toEqual(['file1', 'file2']);
    expect((input[0] as { label: string }).label).toBe('');
  });

  it('删除前面的标签后重新编号', () => {
    const out = labelChips([chip('file', 'b'), chip('file', 'c')]);
    expect(toAttachments(out).map((a) => a.label)).toEqual(['file1', 'file2']);
  });
});

describe('itemKind / guessKind', () => {
  it('PickedItem → 标签类型', () => {
    expect(itemKind({ path: 'a', kind: 'folder', previewToken: 't', isImage: false })).toBe('folder');
    expect(itemKind({ path: 'a.png', kind: 'file', previewToken: 't', isImage: true })).toBe('img');
    expect(itemKind({ path: 'a.ts', kind: 'file', previewToken: 't', isImage: false })).toBe('file');
  });
  it('路径启发式', () => {
    expect(guessKind('C:\\a\\b.PNG')).toBe('img');
    expect(guessKind('/a/b.svg')).toBe('img');
    expect(guessKind('/a/b.ts')).toBe('file');
    expect(guessKind('/a/b/')).toBe('folder');
    expect(guessKind('C:\\a\\b\\')).toBe('folder');
    expect(guessKind('/a/src')).toBe('folder');
    expect(guessKind('/a/.gitignore')).toBe('file');
  });
});

describe('serialize', () => {
  it('标签转成 @"路径"，文本原样', () => {
    const s = labelChips([text('比较 '), chip('file', 'C:\\a\\b.ts'), text(' 和 '), chip('folder', 'D:\\x')]);
    expect(serialize(s)).toBe('比较 @"C:\\a\\b.ts" 和 @"D:\\x"');
  });
  it('紧贴非空白时补空格', () => {
    expect(serialize([text('看'), chip('file', '/a/b.ts'), text('的内容')])).toBe('看 @"/a/b.ts" 的内容');
    expect(serialize([chip('file', '/a'), chip('file', '/b')])).toBe('@"/a" @"/b"');
    expect(serialize([chip('file', '/a'), text('，好')])).toBe('@"/a"，好');
  });
  it('已有空白（含换行）时不重复补', () => {
    expect(serialize([text('a\n'), chip('file', '/a'), text('\nb')])).toBe('a\n@"/a"\nb');
  });
  it('路径含双引号时原样保留', () => {
    expect(serialize([chip('file', '/a/"q".txt')])).toBe('@"/a/"q".txt"');
  });
});

describe('trimSegments', () => {
  it('只裁首尾空白，丢弃空文本', () => {
    const out = trimSegments([text('  '), chip('file', '/a'), text(' hi \n')]);
    expect(out).toEqual([chip('file', '/a'), text(' hi')]);
  });
});

describe('parseUserText', () => {
  it('Windows 路径含空格', () => {
    const r = parseUserText('看 @"C:\\Users\\Some One\\My Docs\\a b.ts" 这个');
    expect(r.userText).toBe('看 file1 这个');
    expect(r.attachments).toEqual([{ kind: 'file', label: 'file1', path: 'C:\\Users\\Some One\\My Docs\\a b.ts' }]);
  });
  it('中文路径、Mac 路径、图片、文件夹', () => {
    const r = parseUserText('比较 @"D:\\项目\\设计稿.png" @"/Users/张三/文档/报告.md" 和 @"/Users/zs/src/" 以及 @"C:\\data"');
    expect(r.userText).toBe('比较 img1 file1 和 folder1 以及 folder2');
    expect(r.attachments.map((a) => a.kind)).toEqual(['img', 'file', 'folder', 'folder']);
    expect(r.attachments[0].path).toBe('D:\\项目\\设计稿.png');
  });
  it('无引号形式（到空白为止，剥掉末尾标点）', () => {
    const r = parseUserText('看 @C:\\a\\b.ts, 还有 @/usr/lib/x.so。 再见 @~/notes.md.');
    expect(r.userText).toBe('看 file1, 还有 file2。 再见 file3.');
    expect(r.attachments.map((a) => a.path)).toEqual(['C:\\a\\b.ts', '/usr/lib/x.so', '~/notes.md']);
  });
  it('普通 @ 不误判', () => {
    for (const t of ['联系 email@x.com 吧', '问 @someone 一下', '@ 单独的', 'a@/b', '@C 盘', '路径 @/ 结尾']) {
      const r = parseUserText(t);
      expect(r.attachments).toEqual([]);
      expect(r.userText).toBe(t);
    }
  });
  it('无引用时原样返回', () => {
    expect(parseUserText('hello\nworld')).toEqual({ userText: 'hello\nworld', attachments: [] });
  });
  it('同一路径重复出现分别编号', () => {
    const r = parseUserText('@"/a/x.ts" @"/a/x.ts"');
    expect(r.userText).toBe('file1 file2');
    expect(r.attachments).toHaveLength(2);
  });
  it('行首、括号后可识别', () => {
    expect(parseUserText('@"/a/b.ts"\n(@"/c/d.png")').userText).toBe('file1\n(img1)');
  });
  it('路径含双引号时仍可往返（引号后不跟空白/标点）', () => {
    const r = parseUserText(serialize([chip('file', '/a/"q"x.txt')]));
    expect(r.attachments[0].path).toBe('/a/"q"x.txt');
  });
  it('无副作用：连续调用结果一致', () => {
    const t = '看 @"/a/b.ts" 和 @"/a/c/"';
    expect(parseUserText(t)).toEqual(parseUserText(t));
  });
});

describe('往返', () => {
  const cases: Segment[][] = [
    [text('比较 '), chip('file', 'C:\\Users\\Some One\\a b.ts'), text(' 和 '), chip('folder', 'D:\\项目\\资料'), text('，然后看 '), chip('img', '/Users/x/图 1.png')],
    [chip('file', '/a/b.ts'), text(' '), chip('file', '/c/d.ts'), text('\n第二行 '), chip('img', 'C:\\p.jpg')],
    [text('纯文本 @someone')],
  ];
  it.each(cases.map((c, i) => [i, c] as const))('case %i：serialize 后 parse，label / 路径一致', (_i, segs) => {
    const labelled = labelChips(segs);
    const expectAtt = toAttachments(labelled);
    const r = parseUserText(serialize(labelled));
    expect(r.attachments).toEqual(expectAtt);
    // 文本：把标签占位名换回去应与「标签显示文本」一致
    const display = labelled.map((s) => (s.t === 'text' ? s.text : s.label)).join('');
    expect(r.userText).toBe(display);
  });
});

describe('splitMentions', () => {
  it('把 @"路径" 与 @路径 还原为标签，其余保持文字', () => {
    expect(splitMentions('看 @"C:\\a b\\c.ts" 和 @/src/x.ts, 好')).toEqual([
      text('看 '), chip('file', 'C:\\a b\\c.ts'), text(' 和 '), chip('file', '/src/x.ts'), text(', 好'),
    ]);
  });
  it('没有提及时返回单段文字；空串返回空数组', () => {
    expect(splitMentions('普通文字')).toEqual([text('普通文字')]);
    expect(splitMentions('')).toEqual([]);
  });
});
