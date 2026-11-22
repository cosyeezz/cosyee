// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Attachment } from '@cosyee/shared';
import { UserMessage, pasteName } from './UserMessage';
import { api } from '../../core/api';
import { FilesContext } from '../files/FileContext';
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

  it('多段引用：每段一个引用块，按顺序渲染在正文之前', () => {
    const h = render('> 甲\n\n> 乙\n> 乙2\n\n我的回复 **b**');
    const qs = [...h.querySelectorAll('.cz-flow__quote')];
    expect(qs.map((q) => q.textContent)).toEqual(['甲', '乙\n乙2']);
    expect(h.querySelector('strong')?.textContent).toBe('b');
    expect(h.querySelector('blockquote')).toBeNull();
    expect(h.querySelector('.cz-umd')?.textContent).toContain('我的回复');
  });

  it('每段引用后紧跟它自己的回复', () => {
    const h = render('> 用哪台设备？\n\n三者都有\n\n> 要不要配置？\n\n最好不配置');
    const parts = [...h.querySelectorAll('.cz-flow__qpart')];
    expect(parts.map((p) => [p.querySelector('.cz-flow__quote')?.textContent, p.querySelector('.cz-umd')?.textContent?.trim()]))
      .toEqual([['用哪台设备？', '三者都有'], ['要不要配置？', '最好不配置']]);
  });

  it('多段引用没有正文时不渲染空的 Markdown 容器', () => {
    const h = render('> 甲\n\n> 乙');
    expect(h.querySelectorAll('.cz-flow__quote')).toHaveLength(2);
    expect(h.querySelector('.cz-umd')).toBeNull();
  });

  it('没有引用时不渲染引用块', () => {
    expect(render('普通消息').querySelector('.cz-flow__quote')).toBeNull();
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

describe('UserMessage 附件标签预览（与输入框标签同一个浮窗）', () => {
  const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('点击标签弹出预览（显示路径），再点关闭；Esc 也能关', () => {
    const h = render('看 file1', [att('file', 'file1', '/a/b.ts')]);
    const tag = h.querySelector('.cz-flow__tag')!;
    click(tag);
    expect(document.querySelector('.cz-preview__path')?.textContent).toBe('/a/b.ts');
    click(tag);
    expect(document.querySelector('.cz-preview')).toBeNull();
    click(tag);
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('.cz-preview')).toBeNull();
  });

  it('有会话上下文时按文件预览接口取大小；图片显示缩略图', async () => {
    const spy = vi.spyOn(api, 'filePreview').mockResolvedValue({
      name: 'c.png', path: '/w/c.png', size: 2048, mtime: 0, kind: 'image', mimeType: 'image/png',
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
      <FilesContext.Provider value={{ cwd: '/w', session: 's1', open: () => {} }}>
        <UserMessage text="img1" attachments={[att('img', 'img1', '/w/c.png')]} />
      </FilesContext.Provider>,
    ));
    click(host.querySelector('.cz-flow__tag')!);
    await flush();
    expect(spy).toHaveBeenCalledWith({ session: 's1', cwd: '/w', path: '/w/c.png' });
    expect(document.querySelector('.cz-preview__meta')?.textContent).toContain('2.0 KB');
    expect(document.querySelector('.cz-preview__thumb img')?.getAttribute('src')).toContain('/api/files/raw?session=s1');
  });

  it('粘贴的图片（工作目录之外）按文件名走粘贴图片接口，没有会话上下文也有缩略图', async () => {
    const files = vi.spyOn(api, 'filePreview');
    const p = 'C:\\Users\\u\\.cosyee\\pastes\\paste-1795354327668-3fb7c25096ed.png';
    const spy = vi.spyOn(api, 'pasteInfo').mockResolvedValue({
      path: p, kind: 'file', size: 4096, mtime: 0, isImage: true, childCount: null,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<UserMessage text="img1" attachments={[att('img', 'img1', p)]} />));
    click(host.querySelector('.cz-flow__tag')!);
    await flush();
    expect(spy).toHaveBeenCalledWith('paste-1795354327668-3fb7c25096ed.png');
    expect(files).not.toHaveBeenCalled();
    expect(document.querySelector('.cz-preview__meta')?.textContent).toContain('4.0 KB');
    expect(document.querySelector('.cz-preview__thumb img')?.getAttribute('src')).toBe('/api/pastes/paste-1795354327668-3fb7c25096ed.png/raw');
  });

  it('pasteName 只认 pastes 目录下服务端生成的文件名', () => {
    expect(pasteName('/home/u/.cosyee/pastes/paste-1-0123456789ab.webp')).toBe('paste-1-0123456789ab.webp');
    expect(pasteName('/w/paste-1-0123456789ab.png')).toBeNull();
    expect(pasteName('/home/u/.cosyee/pastes/shot.png')).toBeNull();
    expect(pasteName('/home/u/.cosyee/pastes/paste-1-0123456789ab.svg')).toBeNull();
  });

  it('信息取不到（工作目录之外）时仍显示路径', async () => {
    vi.spyOn(api, 'filePreview').mockRejectedValue(new Error('403'));
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(
      <FilesContext.Provider value={{ cwd: '/w', session: 's1', open: () => {} }}>
        <UserMessage text="folder1" attachments={[att('folder', 'folder1', '/x/dir')]} />
      </FilesContext.Provider>,
    ));
    click(host.querySelector('.cz-flow__tag')!);
    await flush();
    expect(document.querySelector('.cz-preview__path')?.textContent).toBe('/x/dir');
    expect(document.querySelector('.cz-preview__thumb')).toBeNull();
  });
});
