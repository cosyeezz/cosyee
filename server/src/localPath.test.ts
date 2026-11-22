// 共享的本地路径纯函数（shared/src/localPath.ts）的单元测试。
// shared 包本身没有 vitest，这里借 server 的测试运行器跑。
import { describe, expect, it } from 'vitest';
import { isLocalPath, localFileLink, pathBasename, pathRelativeToFile, resolveAgainst } from '@cosyee/shared';

const p = (href: string) => localFileLink(href)?.path;

describe('localFileLink：本地路径', () => {
  it('Windows 绝对路径（正反斜杠都行，输出统一成 /）', () => {
    expect(localFileLink('F:\\Cosyee\\a.md')).toEqual({ path: 'F:/Cosyee/a.md' });
    expect(localFileLink('c:/x/y.txt')).toEqual({ path: 'c:/x/y.txt' });
  });
  it('posix 绝对路径', () => {
    expect(localFileLink('/home/u/a.ts')).toEqual({ path: '/home/u/a.ts' });
  });
  it('相对路径 ./ ../ 与裸名字', () => {
    expect(p('./a.ts')).toBe('./a.ts');
    expect(p('../b/c.ts')).toBe('../b/c.ts');
    expect(p('docs/readme.md')).toBe('docs/readme.md');
    expect(p('a.ts')).toBe('a.ts');
  });
  it('~/ 开头原样保留（由服务端展开）', () => {
    expect(p('~/notes/a.md')).toBe('~/notes/a.md');
  });
  it('file:// URL：盘符形式去掉开头的 /，posix 形式保留', () => {
    expect(p('file:///C:/x')).toBe('C:/x');
    expect(p('file:///x')).toBe('/x');
    expect(p('file://localhost/x/y')).toBe('/x/y');
    expect(p('file:///C:/my%20dir/a.md')).toBe('C:/my dir/a.md');
  });
  it('file://host/... 与带 ?query 的 file URL 拒绝', () => {
    expect(localFileLink('file://server/share/a')).toBeNull();
    expect(localFileLink('file:///x?y=1')).toBeNull();
  });
});

describe('localFileLink：行号与锚点', () => {
  it('a.ts:12 / a.ts:12:3 → 行号，路径不含后缀', () => {
    expect(localFileLink('a.ts:12')).toEqual({ path: 'a.ts', line: 12 });
    expect(localFileLink('a.ts:12:3')).toEqual({ path: 'a.ts', line: 12 });
    expect(localFileLink('F:\\a\\b.ts:7')).toEqual({ path: 'F:/a/b.ts', line: 7 });
  });
  it('#L12 / #L12C3 → 行号；其它 #section 作为 fragment', () => {
    expect(localFileLink('a.ts#L12')).toEqual({ path: 'a.ts', line: 12 });
    expect(localFileLink('a.ts#L12C3')).toEqual({ path: 'a.ts', line: 12 });
    expect(localFileLink('a.md#section')).toEqual({ path: 'a.md', fragment: 'section' });
    expect(localFileLink('a.md#%E4%B8%AD%E6%96%87')).toEqual({ path: 'a.md', fragment: '中文' });
  });
  it('纯锚点不是本地文件链接', () => {
    expect(localFileLink('#section')).toBeNull();
    expect(localFileLink('\u200b#x')).toBeNull();
  });
});

describe('localFileLink：URL 解码', () => {
  it('%20 解码为空格，中文百分号编码解码', () => {
    expect(p('a%20b.md')).toBe('a b.md');
    expect(p('%E4%B8%AD%E6%96%87.md')).toBe('中文.md');
  });
  it('%23 属于文件名而不是锚点', () => {
    expect(localFileLink('a%23b.md')).toEqual({ path: 'a#b.md' });
    expect(localFileLink('a%23b.md#top')).toEqual({ path: 'a#b.md', fragment: 'top' });
  });
  it('markdown 解析器把盘符路径的反斜杠编码成 %5C：仍是本地路径', () => {
    expect(localFileLink('F:%5Cx.md')).toEqual({ path: 'F:/x.md' });
    expect(localFileLink('C:%5CUsers%5Ca%20b.md#L3')).toEqual({ path: 'C:/Users/a b.md', line: 3 });
    expect(localFileLink('javascript:alert(1)')).toBeNull();
  });
  it('非法的百分号序列拒绝', () => {
    expect(localFileLink('a%zz.md')).toBeNull();
    expect(localFileLink('%E4%B8.md')).toBeNull();
  });
  it('解码后出现控制字符 / 冒号 / 双斜杠拒绝', () => {
    expect(localFileLink('a%00b')).toBeNull();
    expect(localFileLink('xy%3Ab')).toBeNull();
    expect(localFileLink('%2F%2Fhost/a')).toBeNull();
  });
});

describe('localFileLink：拒绝', () => {
  it('http / https / mailto / javascript / data / ftp', () => {
    for (const h of [
      'http://example.com/a.md',
      'https://example.com',
      'HTTPS://example.com',
      'mailto:a@b.com',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html;base64,AAAA',
      'ftp://host/a',
      'vscode://file/a',
      'C:foo',
    ]) {
      expect(localFileLink(h), h).toBeNull();
    }
  });
  it('?query 拒绝', () => {
    expect(localFileLink('a.md?x=1')).toBeNull();
    expect(localFileLink('/a/b?x')).toBeNull();
  });
  it('控制字符拒绝', () => {
    expect(localFileLink('a\nb.md')).toBeNull();
    expect(localFileLink('/a\u0000b')).toBeNull();
    expect(localFileLink('/a\u007fb')).toBeNull();
    expect(localFileLink('a\tb')).toBeNull();
  });
  it('//host 与 UNC 路径拒绝', () => {
    expect(localFileLink('//host/share/a.md')).toBeNull();
    expect(localFileLink('\\\\host\\share\\a.md')).toBeNull();
  });
  it('空串 / 超长拒绝', () => {
    expect(localFileLink('')).toBeNull();
    expect(localFileLink('/' + 'a'.repeat(5000))).toBeNull();
  });
  it('绝对路径前的零宽字符被剥掉', () => {
    expect(p('\u200bF:\\a.md')).toBe('F:/a.md');
    expect(p('\ufeff/a/b')).toBe('/a/b');
  });
});

describe('isLocalPath', () => {
  it('接受各种写法', () => {
    for (const v of ['/a', 'C:\\a', 'c:/a', '\\\\host\\s', '~/a', '~\\a', './a', '../a', '.\\a', 'file:///a']) {
      expect(isLocalPath(v), v).toBe(true);
    }
  });
  it('拒绝裸名字、URL、含控制字符的', () => {
    for (const v of ['a.ts', 'http://x', 'mailto:a@b', '', '/a\nb', 'C:foo', '~foo']) {
      expect(isLocalPath(v), v).toBe(false);
    }
  });
});

describe('pathRelativeToFile', () => {
  it('相对路径拼到文件所在目录；绝对路径原样', () => {
    expect(pathRelativeToFile('img/a.png', 'F:\\docs\\readme.md')).toBe('F:\\docs\\img/a.png');
    expect(pathRelativeToFile('../a.md', '/x/y/z.md')).toBe('/x/y/../a.md');
    expect(pathRelativeToFile('F:\\a.md', 'F:\\docs\\readme.md')).toBe('F:\\a.md');
    expect(pathRelativeToFile('/a.md', '/x/y.md')).toBe('/a.md');
    expect(pathRelativeToFile('~/a.md', '/x/y.md')).toBe('~/a.md');
    expect(pathRelativeToFile('a.md')).toBe('a.md');
  });
});

describe('resolveAgainst', () => {
  it('Windows：相对路径拼 cwd 并折叠 . / ..', () => {
    expect(resolveAgainst('F:\\Cosyee', 'web/src/a.ts')).toBe('F:\\Cosyee\\web\\src\\a.ts');
    expect(resolveAgainst('F:\\Cosyee\\web', '../shared/./b.ts')).toBe('F:\\Cosyee\\shared\\b.ts');
    expect(resolveAgainst('F:\\Cosyee\\', './a.ts')).toBe('F:\\Cosyee\\a.ts');
  });
  it('Windows：绝对路径只做规范化', () => {
    expect(resolveAgainst('F:\\Cosyee', 'C:/x/../y.txt')).toBe('C:\\y.txt');
  });
  it('posix', () => {
    expect(resolveAgainst('/home/u/proj', 'src/a.ts')).toBe('/home/u/proj/src/a.ts');
    expect(resolveAgainst('/home/u/proj', '../a.ts')).toBe('/home/u/a.ts');
    expect(resolveAgainst('/home/u', '/etc/x')).toBe('/etc/x');
  });
  it('.. 不会越过根', () => {
    expect(resolveAgainst('/a', '../../../b')).toBe('/b');
    expect(resolveAgainst('F:\\a', '..\\..\\b')).toBe('F:\\b');
  });
  it('~/ 与 file:// 原样（由服务端展开）', () => {
    expect(resolveAgainst('/a', '~/x')).toBe('~/x');
    expect(resolveAgainst('/a', 'file:///x')).toBe('file:///x');
  });
});

describe('pathBasename', () => {
  it('取最后一段', () => {
    expect(pathBasename('F:\\a\\b.md')).toBe('b.md');
    expect(pathBasename('/a/b/')).toBe('b');
    expect(pathBasename('x')).toBe('x');
  });
});
