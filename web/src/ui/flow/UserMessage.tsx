// 用户消息气泡：正文按 Markdown 渲染；占位名（file1 / img1 / folder1）渲染成内联标签。
import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import type { Attachment } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { parseQuote } from '../../core/quote';
import { CodeBlock, nodeText } from './Markdown';
import { attachmentIndex, prepareUserMarkdown } from './userMarkdown';
import './flow.css';
import './userMessage.css';

const KIND_ICON: Record<Attachment['kind'], IconName> = { file: 'file', img: 'image', folder: 'folder' };

export const AttachmentTag = memo(function AttachmentTag({ attachment }: { attachment: Attachment }) {
  return (
    <span className={`cz-flow__tag cz-flow__tag--${attachment.kind}`} title={attachment.path}>
      <Icon name={KIND_ICON[attachment.kind]} size={13} />
      <span>{attachment.label}</span>
    </span>
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
  // 开头的 `> ` 引用块（选中回复）单独渲染，正文照常还原路径标签
  const { quote, body } = useMemo(() => parseQuote(text), [text]);
  const md = useMemo(() => prepareUserMarkdown(body, attachments), [body, attachments]);
  const components = useMemo(() => buildComponents(attachments), [attachments]);
  return (
    <div className="cz-flow__user">
      <div className="cz-flow__bubble">
        {quote !== null && <div className="cz-flow__quote" title={quote}>{quote}</div>}
        {md.trim() !== '' && (
          <div className="cz-umd">
            <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
              {md}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
});
