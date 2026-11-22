// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { splitHighlightedLines, splitPlainLines } from './codeLines';

describe('splitPlainLines', () => {
  it('按换行拆行，去掉末尾换行产生的空行，保留中间空行；CRLF 视为一个换行', () => {
    expect(splitPlainLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitPlainLines('a\n\nb')).toEqual(['a', '', 'b']);
    expect(splitPlainLines('a\r\nb')).toEqual(['a', 'b']);
    expect(splitPlainLines('')).toEqual(['']);
  });
});

describe('splitHighlightedLines', () => {
  it('跨行的高亮节点按行拆开，每行都带着自己的 span 样式', () => {
    const tree = (
      <>
        <span className="hljs-comment">{'/* a\nb */'}</span>
        {'\nx'}
      </>
    );
    const lines = splitHighlightedLines(tree);
    expect(lines).toHaveLength(3);
    const html = lines.map((l) => renderToStaticMarkup(<>{l}</>));
    expect(html[0]).toBe('<span class="hljs-comment">/* a</span>');
    expect(html[1]).toBe('<span class="hljs-comment">b */</span>');
    expect(html[2]).toBe('x');
  });

  it('末尾换行不产生多余的空行', () => {
    expect(splitHighlightedLines('a\nb\n')).toHaveLength(2);
  });
});
