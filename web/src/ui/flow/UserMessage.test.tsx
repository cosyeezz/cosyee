// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Attachment } from '@cosyee/shared';
import { UserMessage } from './UserMessage';
import { prepareUserMarkdown } from './userMarkdown';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(text: string, attachments: Attachment[] = []) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<UserMessage text={text} attachments={attachments} />));
  return host;
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const att = (kind: Attachment['kind'], label: string, path: string): Attachment => ({ kind, label, path } as Attachment);

describe('UserMessage Markdown', () => {
  it('渲染标题 / 粗体 / 行内代码 / 列表', () => {
    const h = render('# 标题\n\n**粗** 和 `code`\n\n- 一\n- 二');
    expect(h.querySelector('h1')?.textContent).toBe('标题');
    expect(h.querySelector('strong')?.textContent).toBe('粗');
    expect(h.querySelector('p code')?.textContent).toBe('code');
    expect(h.querySelectorAll('li').length).toBe(2);
  });

  it('单个换行保留为换行', () => {
    const h = render('第一行\n第二行\n第三行');
    expect(h.querySelectorAll('p br').length).toBe(2);
    expect(h.querySelectorAll('p').length).toBe(1);
  });

  it('附件占位名渲染成 AttachmentTag，不变成链接', () => {
    const h = render('看 file1 和 img1', [att('file', 'file1', '/a/b.ts'), att('img', 'img1', '/a/c.png')]);
    const tags = h.querySelectorAll('.cz-flow__tag');
    expect(tags.length).toBe(2);
    expect(tags[0].getAttribute('title')).toBe('/a/b.ts');
    expect(tags[0].textContent).toBe('file1');
    expect(tags[1].className).toContain('cz-flow__tag--img');
    expect(h.querySelector('a')).toBeNull();
  });

  it('粗体里的附件也能还原；代码里的占位名保持原样', () => {
    const h = render('**file1** 与 `file1`', [att('file', 'file1', '/a/b.ts')]);
    expect(h.querySelectorAll('.cz-flow__tag').length).toBe(1);
    expect(h.querySelector('strong .cz-flow__tag')).not.toBeNull();
    expect(h.querySelector('code')?.textContent).toBe('file1');
  });

  it('引用块照常渲染在正文之前', () => {
    const h = render('> 被引用\n\n我的回复 **b**');
    expect(h.querySelector('.cz-flow__quote')?.textContent).toBe('被引用');
    expect(h.querySelector('strong')?.textContent).toBe('b');
    expect(h.querySelector('blockquote')).toBeNull();
  });

  it('只有引用没有正文时不渲染空的 Markdown 容器', () => {
    const h = render('> 只有引用');
    expect(h.querySelector('.cz-flow__quote')).not.toBeNull();
    expect(h.querySelector('.cz-umd')).toBeNull();
  });

  it('原始 HTML 按字面显示，不丢内容', () => {
    const h = render('用 <div> 包起来');
    expect(h.textContent).toContain('<div>');
  });

  it('围栏代码块带复制按钮，内部换行与星号不被处理', () => {
    const h = render('```ts\nconst a = 1;\n**x**\n```');
    expect(h.querySelector('.cz-flow__code-lang')?.textContent).toBe('ts');
    expect(h.querySelector('pre')?.textContent).toContain('**x**');
    expect(h.querySelector('.cz-flow__code-pre strong')).toBeNull();
  });

  it('链接在新标签页打开', () => {
    const h = render('[站点](https://example.com)');
    const a = h.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com');
    expect(a.getAttribute('target')).toBe('_blank');
  });
});

describe('prepareUserMarkdown', () => {
  it('段落内换行补硬换行，空行 / 代码块内不补', () => {
    expect(prepareUserMarkdown('a\nb\n\nc', [])).toBe('a  \nb\n\nc');
    expect(prepareUserMarkdown('```\na\nb\n```', [])).toBe('```\na\nb\n```');
  });
  it('已有硬换行的行不重复补', () => {
    expect(prepareUserMarkdown('a  \nb', [])).toBe('a  \nb');
  });
});
