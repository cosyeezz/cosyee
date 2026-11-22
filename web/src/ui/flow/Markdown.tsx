// Markdown 渲染：remark-gfm + rehype-highlight；代码块带语言标签和复制按钮。
// 本地路径：链接里的本地文件路径渲染成 FilePathLink（点击打开预览浮窗），行内代码里的路径带完整路径 tooltip；
// 远程链接只放行 http / https / mailto，其它（javascript: 等）退化成纯文本。
import { createContext, isValidElement, memo, useContext, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { isLocalPath, localFileLink, localPathHref, pathRelativeToFile, resolveAgainst } from '@cosyee/shared';
import { copyText } from '../../core/browser';
import { useFiles } from '../files/FileContext';
import { FilePathLink } from '../files/FilePathLink';

const remarkPlugins = [remarkGfm];
const rehypePlugins: any[] = [[rehypeHighlight, { ignoreMissing: true }]];

/**
 * 默认的 urlTransform 会把 `F:\a.md`、`file:///…` 这类「未知协议」的 href 清空：
 * href 能解析成本地文件链接就原样保留，其余（含图片 src）仍走默认的安全过滤。
 */
const urlTransform: UrlTransform = (url, key) => (key === 'href' && localFileLink(url) ? url : defaultUrlTransform(url));

/** 相对路径的基准文件：预览浮窗里渲染 .md 时是该文件的完整路径，其中的相对链接按它所在目录解析 */
const BaseFileContext = createContext<string | undefined>(undefined);

/** 路径 → 完整路径：先按基准文件所在目录，再按会话工作目录；`~/` 和 file:// 留给服务端 */
function fullPath(path: string, cwd: string | undefined, baseFile: string | undefined): string {
  const p = pathRelativeToFile(path, baseFile);
  return cwd ? resolveAgainst(cwd, p) : p;
}

const REMOTE_HREF = /^(?:https?:|mailto:)/i;

function MdLink({ children, href }: { children?: ReactNode; href?: string }) {
  const files = useFiles();
  const baseFile = useContext(BaseFileContext);
  const link = href ? localFileLink(href) : null;
  if (link) {
    return (
      <FilePathLink path={fullPath(link.path, files?.cwd, baseFile)} line={link.line}>
        {children}
      </FilePathLink>
    );
  }
  if (href && REMOTE_HREF.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  }
  return <span>{children}</span>;
}

/** 行内代码：内容像本地路径时，悬停显示解析后的完整路径 */
function InlineCode({ text, children }: { text: string; children?: ReactNode }) {
  const files = useFiles();
  const baseFile = useContext(BaseFileContext);
  const t = text.trim();
  // 行内代码是原样的文件系统路径：先转义 % # ?，免得文件名里的这些字符被当成 URL 语法
  const link = isLocalPath(t) ? localFileLink(localPathHref(t)) : null;
  const title = link ? fullPath(link.path, files?.cwd, baseFile) + (link.line ? `:${link.line}` : '') : undefined;
  return <code title={title}>{children}</code>;
}

/** 递归取 React 节点里的纯文本（高亮后代码被拆成很多 span） */
export function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

export { copyText };

export function CodeBlock({ lang, text, children }: { lang?: string; text: string; children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  return (
    <div className="cz-flow__code">
      <div className="cz-flow__code-head">
        <span className="cz-flow__code-lang">{lang || 'text'}</span>
        <button type="button" className="cz-flow__code-copy" onClick={onCopy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="cz-flow__code-pre">{children}</pre>
    </div>
  );
}

const components: Components = {
  pre({ children }) {
    // children 通常是一个 <code className="hljs language-xxx">
    const el = Array.isArray(children) ? children[0] : children;
    let lang: string | undefined;
    if (isValidElement(el)) {
      const cls = (el.props as { className?: string }).className ?? '';
      lang = /language-([\w+#-]+)/.exec(cls)?.[1];
    }
    return (
      <CodeBlock lang={lang} text={nodeText(children).replace(/\n$/, '')}>
        {children}
      </CodeBlock>
    );
  },
  a({ children, href }) {
    return <MdLink href={href}>{children}</MdLink>;
  },
  code({ children, className }) {
    // 围栏代码块（带 language-/hljs 类，或含换行）原样输出，由上面的 pre 包装
    const text = nodeText(children);
    if (className || text.includes('\n')) return <code className={className}>{children}</code>;
    return <InlineCode text={text}>{children}</InlineCode>;
  },
  table({ children }) {
    return (
      <div className="cz-flow__table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

export const Markdown = memo(function Markdown({ text, className, baseFile }: { text: string; className?: string; baseFile?: string }) {
  return (
    <div className={`cz-flow__md${className ? ' ' + className : ''}`}>
      <BaseFileContext.Provider value={baseFile}>
        <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} urlTransform={urlTransform}>
          {text}
        </ReactMarkdown>
      </BaseFileContext.Provider>
    </div>
  );
});
