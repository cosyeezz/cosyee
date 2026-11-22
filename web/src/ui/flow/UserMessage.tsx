// 用户消息气泡：正文按 Markdown 渲染；占位名（file1 / img1 / folder1）渲染成内联标签。
import { memo, useCallback, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Attachment, PreviewInfo } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { parseQuotes } from '../../core/quote';
import { api } from '../../core/api';
import { ChipPreview } from '../composer/ChipPreview';
import { useFiles } from '../files/FileContext';
import { CodeBlock, nodeText } from './Markdown';
import { attachmentIndex, prepareUserMarkdown } from './userMarkdown';
import './flow.css';
import './userMessage.css';

const KIND_ICON: Record<Attachment['kind'], IconName> = { file: 'file', img: 'image', folder: 'folder' };

/**
 * 附件标签：点击弹出和输入框里标签一样的预览浮窗（路径 / 大小 / 修改时间 / 图片缩略图）。
 * 历史消息没有预览令牌，信息改走「会话工作目录内的文件预览」接口；没有会话上下文或在工作目录之外时只显示路径。
 */
export const AttachmentTag = memo(function AttachmentTag({ attachment }: { attachment: Attachment }) {
  const files = useFiles();
  const session = files?.session;
  const cwd = files?.cwd;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const info = useCallback(
    async (path: string): Promise<PreviewInfo> => {
      if (!session) throw new Error('no session');
      const p = await api.filePreview({ session, cwd, path });
      const dir = p.kind === 'directory';
      return {
        path: p.path,
        kind: dir ? 'folder' : 'file',
        size: dir ? null : p.size,
        mtime: p.mtime,
        isImage: p.kind === 'image',
        childCount: dir ? (p.entries?.length ?? null) : null,
      };
    },
    [session, cwd],
  );
  const rawUrl = useCallback((path: string) => (session ? api.fileRawUrl({ session, cwd, path }) : ''), [session, cwd]);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <span
        className={`cz-flow__tag cz-flow__tag--${attachment.kind}`}
        title={attachment.path}
        role="button"
        tabIndex={0}
        aria-expanded={anchor != null}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            const el = e.currentTarget;
            setAnchor((a) => (a ? null : el));
          }
        }}
      >
        <Icon name={KIND_ICON[attachment.kind]} size={13} />
        <span>{attachment.label}</span>
      </span>
      {anchor &&
        createPortal(
          <ChipPreview
            anchor={anchor}
            chip={{ kind: attachment.kind, path: attachment.path, label: attachment.label, token: attachment.path }}
            onClose={close}
            previewInfo={info}
            previewRawUrl={rawUrl}
          />,
          document.body,
        )}
    </>
  );
});

const remarkPlugins = [remarkGfm];
const rehypePlugins: any[] = [[rehypeHighlight, { ignoreMissing: true }]];

/** 带附件表的 components：附件链接 → AttachmentTag；图片不加载远程资源，按链接文字显示 */
function buildComponents(attachments: Attachment[]): Components {
  return {
    a({ children, href }) {
      const idx = attachmentIndex(href);
      if (idx !== null && attachments[idx]) return <AttachmentTag attachment={attachments[idx]} />;
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      );
    },
    img({ alt, src }) {
      return (
        <a href={src} target="_blank" rel="noreferrer noopener">
          {alt || src}
        </a>
      );
    },
    pre({ children }) {
      const el = Array.isArray(children) ? children[0] : children;
      let lang: string | undefined;
      if (el && typeof el === 'object' && 'props' in el) {
        const cls = (el.props as { className?: string }).className ?? '';
        lang = /language-([\w+#-]+)/.exec(cls)?.[1];
      }
      return (
        <CodeBlock lang={lang} text={nodeText(children).replace(/\n$/, '')}>
          {children}
        </CodeBlock>
      );
    },
    table({ children }) {
      return (
        <div className="cz-flow__table-wrap">
          <table>{children}</table>
        </div>
      );
    },
  };
}

export const UserMessage = memo(function UserMessage({
  text,
  attachments,
}: {
  text: string;
  attachments: Attachment[];
}) {
  // 选中回复的消息（`> ` 引用开头，可有多段）：按段渲染「引用 + 紧跟其后的回复」；回复 / 正文照常还原路径标签
  const parts = useMemo(() => parseQuotes(text), [text]);
  const components = useMemo(() => buildComponents(attachments), [attachments]);
  const md = (s: string) => {
    const src = prepareUserMarkdown(s, attachments);
    if (src.trim() === '') return null;
    return (
      <div className="cz-umd">
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
          {src}
        </ReactMarkdown>
      </div>
    );
  };
  return (
    <div className="cz-flow__user">
      <div className="cz-flow__bubble cz-spot">
        {parts
          ? parts.map((p, i) => (
              <div key={i} className="cz-flow__qpart">
                <div className="cz-flow__quote" title={p.quote}>{p.quote}</div>
                {md(p.text)}
              </div>
            ))
          : md(text)}
      </div>
    </div>
  );
});
