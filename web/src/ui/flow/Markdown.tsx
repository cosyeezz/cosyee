// Markdown 渲染：remark-gfm + rehype-highlight；代码块带语言标签和复制按钮。
import { isValidElement, memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

const remarkPlugins = [remarkGfm];
const rehypePlugins: any[] = [[rehypeHighlight, { ignoreMissing: true }]];

/** 递归取 React 节点里的纯文本（高亮后代码被拆成很多 span） */
export function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children);
  return '';
}

/** 复制文字到剪贴板，失败静默 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

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
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
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

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`cz-flow__md${className ? ' ' + className : ''}`}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
