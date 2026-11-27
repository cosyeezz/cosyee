// Markdown 渲染：remark-gfm + rehype-highlight；代码块带语言标签和复制按钮。
// 本地路径：链接里的本地文件路径渲染成 FilePathLink（点击打开预览浮窗）；行内代码里的路径保持代码样式，悬停显示完整路径，点击同样打开预览浮窗；
// 远程链接只放行 http / https / mailto，其它（javascript: 等）退化成纯文本；http(s) 链接默认在内置浏览器面板里打开（ui/browser/links.ts）。
import { createContext, isValidElement, memo, useContext, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components, type UrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { type ExecResult, SHELL_LABEL, isLocalPath, localFileLink, localPathHref, pathRelativeToFile, resolveAgainst, snippetShell } from '@cosyee/shared';
import { copyText } from '../../core/browser';
import { openInBrowserPanel } from '../browser/links';
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
      <a href={href} target="_blank" rel="noreferrer noopener" onClick={(e) => openInBrowserPanel(e, href)}>
        {children}
      </a>
    );
  }
  return <span>{children}</span>;
}

/** 开头像路径但不当路径的行内代码：只有一段的根路径（`/compact` 多半是斜杠命令）、带选项的命令行（`./run.sh --watch`） */
const NOT_A_PATH = /^\/[^/\\]*$|\s--?[A-Za-z]/;

/**
 * 行内代码：内容像本地路径时，悬停显示解析后的完整路径，点击打开预览浮窗。
 * 用 <code role=button> 而不是 <button>：按钮是原子行内盒，长路径没法跟着正文换行，里面的文字也拖不出选区；
 * 在里面拖选了文字时不打开，方便复制路径。
 */
function InlineCode({ text, children }: { text: string; children?: ReactNode }) {
  const files = useFiles();
  const baseFile = useContext(BaseFileContext);
  const t = text.trim();
  // 行内代码是原样的文件系统路径：先转义 % # ?，免得文件名里的这些字符被当成 URL 语法
  const link = isLocalPath(t) && !NOT_A_PATH.test(t) ? localFileLink(localPathHref(t)) : null;
  if (!link) return <code>{children}</code>;
  const path = fullPath(link.path, files?.cwd, baseFile);
  const title = link.line ? `${path}:${link.line}` : path;
  if (!files) return <code title={title}>{children}</code>;
  const open = (el: HTMLElement) => files.open({ path, ...(link.line ? { line: link.line } : {}) }, el);
  return (
    <code
      className="cz-codepath"
      title={title}
      role="button"
      tabIndex={0}
      data-file-path={path}
      onClick={(e) => {
        const sel = window.getSelection();
        if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return;
        open(e.currentTarget);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(e.currentTarget);
        }
      }}
    >
      {children}
    </code>
  );
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

/** 一次运行的结果：正常结束 / 请求失败 / 用户点了停止 */
type RunState = { kind: 'done'; result: ExecResult } | { kind: 'error'; message: string } | { kind: 'stopped' };

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function RunOutput({ state, onClose }: { state: RunState; onClose: () => void }) {
  let status: ReactNode;
  let body: ReactNode = null;
  if (state.kind === 'stopped') {
    status = <span className="cz-flow__run-status is-bad">已停止</span>;
  } else if (state.kind === 'error') {
    status = <span className="cz-flow__run-status is-bad">运行失败</span>;
    body = <pre className="cz-flow__run-err">{state.message}</pre>;
  } else {
    const r = state.result;
    status = (
      <>
        {r.timedOut
          ? <span className="cz-flow__run-status is-bad">已超时</span>
          : <span className={`cz-flow__run-status ${r.exitCode === 0 ? 'is-ok' : 'is-bad'}`}>退出码 {r.exitCode ?? '—'}</span>}
        <span className="cz-flow__run-time">{formatMs(r.durationMs)}</span>
        {r.truncated && <span className="cz-flow__run-time">输出过长已截断</span>}
      </>
    );
    const empty = !r.stdout && !r.stderr;
    body = (
      <>
        {r.stdout && <pre className="cz-flow__run-out">{r.stdout.replace(/\n$/, '')}</pre>}
        {r.stderr && <pre className="cz-flow__run-err">{r.stderr.replace(/\n$/, '')}</pre>}
        {empty && <div className="cz-flow__run-empty">（无输出）</div>}
      </>
    );
  }
  return (
    <div className="cz-flow__run">
      <div className="cz-flow__run-head">
        <span className="cz-flow__run-meta">运行结果 {status}</span>
        <button type="button" className="cz-flow__code-copy" onClick={onClose} aria-label="收起运行结果">收起</button>
      </div>
      {body}
    </div>
  );
}

/**
 * 代码块。runnable 为真且语言是 shell 类、上下文提供了 exec 时，头部多一个「运行」按钮：
 * 在会话工作目录里执行，结果显示在代码块下方；运行中按钮变成「停止」。
 */
export function CodeBlock({ lang, text, children, runnable = false }: { lang?: string; text: string; children: ReactNode; runnable?: boolean }) {
  const files = useFiles();
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState<AbortController | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const shell = runnable && files?.exec && files.platform ? snippetShell(lang, files.platform) : null;
  const onCopy = async () => {
    if (await copyText(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };
  const onRun = async () => {
    if (running) {
      running.abort();
      return;
    }
    if (!files?.exec || !lang) return;
    const ac = new AbortController();
    setRunning(ac);
    setRun(null);
    try {
      setRun({ kind: 'done', result: await files.exec(lang, text, ac.signal) });
    } catch (e) {
      setRun(ac.signal.aborted ? { kind: 'stopped' } : { kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(null);
    }
  };
  return (
    <div className="cz-flow__code">
      <div className="cz-flow__code-head">
        <span className="cz-flow__code-lang">{lang || 'text'}</span>
        <span className="cz-flow__code-actions">
          {shell && (
            <button
              type="button"
              className={`cz-flow__code-copy cz-flow__code-run${running ? ' is-running' : ''}`}
              onClick={onRun}
              title={running ? '停止运行' : `在 ${files!.cwd} 中用 ${SHELL_LABEL[shell]} 执行`}
            >
              {running ? '停止' : '运行'}
            </button>
          )}
          <button type="button" className="cz-flow__code-copy" onClick={onCopy}>
            {copied ? '已复制' : '复制'}
          </button>
        </span>
      </div>
      <pre className="cz-flow__code-pre">{children}</pre>
      {running && <div className="cz-flow__run"><div className="cz-flow__run-head"><span className="cz-flow__run-meta">运行中…</span></div></div>}
      {!running && run && <RunOutput state={run} onClose={() => setRun(null)} />}
    </div>
  );
}

/**
 * 会话消息里的代码块可以运行；预览浮窗里渲染的 .md 文件（有基准文件）不行：
 * 文档里的命令通常相对文档所在目录，而运行用的是会话工作目录，容易跑错地方。
 */
function MdCodeBlock({ lang, text, children }: { lang?: string; text: string; children: ReactNode }) {
  const baseFile = useContext(BaseFileContext);
  return <CodeBlock lang={lang} text={text} runnable={!baseFile}>{children}</CodeBlock>;
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
      <MdCodeBlock lang={lang} text={nodeText(children).replace(/\n$/, '')}>
        {children}
      </MdCodeBlock>
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
