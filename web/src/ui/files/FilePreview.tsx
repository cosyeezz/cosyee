// 本地文件预览浮窗：非模态的悬浮窗口（不遮挡、不替换右侧上下文栏），Esc / 点击窗口外关闭，可最大化。
// 内容由服务端 /api/files/preview 返回（只能预览会话工作目录内、或会话中提到过的文件）；这里只负责展示，不做编辑 / 保存。
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import type { FilePreview as FilePreviewData } from '@cosyee/shared';
import { pathBasename } from '@cosyee/shared';
import { api, type FileTarget } from '../../core/api';
import { Icon } from '../icons/Icon';
import { formatSize } from '../composer/ChipPreview';
import { Markdown } from '../flow/Markdown';
import { useFiles } from './FileContext';
import { LocalPath } from './PathActions';
import { splitHighlightedLines, splitPlainLines } from './codeLines';
import { useMorph } from '../motion/morph';
import '../flow/flow.css';
import './FilePreview.css';

/** 超过这个长度不做语法高亮（hljs 在主线程同步跑，大文件会卡住界面） */
const HIGHLIGHT_LIMIT = 200_000;
/** 一次最多渲染的行数；其余点「显示全部」再展开（几万个 DOM 行会让滚动变卡） */
const ROW_CAP = 3000;

const rehypePlugins: any[] = [[rehypeHighlight, { ignoreMissing: true }]];

type Mode = 'read' | 'source' | 'split';
const MODE_LABEL: Record<Mode, string> = { read: '阅读', source: '源码', split: '对比' };

const isHtmlFile = (name: string): boolean => /\.html?$/i.test(name);

// ───────────── 带行号的代码视图 ─────────────

interface LinesProps {
  text: string;
  language?: string;
  /** 要定位 / 高亮的行（1 起） */
  line?: number;
  wrap: boolean;
}

function Rows({ lines, line, wrap }: { lines: ReactNode[]; line?: number; wrap: boolean }) {
  const [all, setAll] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const cap = all || (line ?? 0) > ROW_CAP - 50 ? lines.length : ROW_CAP;
  const shown = lines.length > cap ? lines.slice(0, cap) : lines;
  const digits = String(lines.length).length;

  // 定位到目标行（居中），只在目标行变化 / 首次挂载时执行（展开更多行不再跳动）；jsdom 等没有 scrollIntoView 的环境跳过
  useEffect(() => {
    if (!line) return;
    const el = hostRef.current?.querySelector<HTMLElement>(`[data-line="${line}"]`);
    el?.scrollIntoView?.({ block: 'center' });
  }, [line]);

  return (
    <div ref={hostRef} className={`cz-fp__code${wrap ? ' is-wrap' : ''}`} style={{ ['--cz-fp-ln' as string]: `${digits}ch` }}>
      {shown.map((content, i) => (
        <div key={i} className={`cz-fp__row${line === i + 1 ? ' is-target' : ''}`} data-line={i + 1}>
          <span className="cz-fp__ln" aria-hidden="true">
            {i + 1}
          </span>
          <span className="cz-fp__lc">{content}</span>
        </div>
      ))}
      {shown.length < lines.length && (
        <button type="button" className="cz-fp__more" onClick={() => setAll(true)}>
          仅显示前 {shown.length} 行，共 {lines.length} 行，显示全部
        </button>
      )}
    </div>
  );
}

/** 用 react-markdown + rehype-highlight 跑一遍围栏代码块，拿到与会话里代码块一致的高亮节点树，再按行拆开 */
const HighlightedLines = memo(function HighlightedLines({ text, language, line, wrap }: LinesProps) {
  const components = useMemo<Components>(
    () => ({
      pre: ({ children }) => <>{children}</>,
      code: ({ children }) => <Rows lines={splitHighlightedLines(children)} line={line} wrap={wrap} />,
    }),
    [line, wrap],
  );
  const source = useMemo(() => {
    // 去掉文件末尾的一个换行：围栏收尾时 hast 会再补一个，免得多出一个空行
    const body = text.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((m) => m.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    const lang = language && /^[\w+#-]+$/.test(language) ? language : '';
    return `${fence}${lang}\n${body}\n${fence}`;
  }, [text, language]);
  return (
    <ReactMarkdown rehypePlugins={rehypePlugins} components={components}>
      {source}
    </ReactMarkdown>
  );
});

function CodeView({ text, language, line, wrap }: LinesProps) {
  const plain = useMemo(() => (language && text.length <= HIGHLIGHT_LIMIT ? null : splitPlainLines(text)), [text, language]);
  if (plain) return <Rows lines={plain} line={line} wrap={wrap} />;
  return <HighlightedLines text={text} language={language} line={line} wrap={wrap} />;
}

// ───────────── HTML 阅读：沙箱 iframe（无脚本、无同源、不加载外部资源） ─────────────

const HTML_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>*{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>`;

function HtmlFrame({ text, title }: { text: string; title: string }) {
  return <iframe className="cz-fp__frame" title={title} sandbox="" srcDoc={HTML_CSP + text} />;
}

// ───────────── 目录 ─────────────

function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[\\/]+$/, '') + sep + name;
}

const normKey = (p: string): string => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();

function DirView({ data, atRoot, onGo }: { data: FilePreviewData; atRoot: boolean; onGo: (path: string) => void }) {
  const entries = data.entries ?? [];
  return (
    <ul className="cz-fp__dir">
      {!atRoot && (
        <li>
          <button type="button" className="cz-fp__entry" onClick={() => onGo(data.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '') || '/')}>
            <Icon name="folder" size={14} />
            <span>..</span>
          </button>
        </li>
      )}
      {entries.map((e) => (
        <li key={e.name}>
          <button type="button" className="cz-fp__entry" onClick={() => onGo(joinPath(data.path, e.name))}>
            <Icon name={e.isDir ? 'folder' : 'file'} size={14} />
            <span>{e.name}</span>
          </button>
        </li>
      ))}
      {entries.length === 0 && <li className="cz-fp__empty">（空目录）</li>}
      {data.truncated && <li className="cz-fp__empty">仅显示前 {entries.length} 项</li>}
    </ul>
  );
}

// ───────────── 浮窗 ─────────────

export interface FilePreviewProps {
  session: string;
  /** 会话所属工作空间（授权提示，服务端只在它是已登记的工作空间时才采信） */
  cwd?: string;
  path: string;
  line?: number;
  /** 每次从外部（再次点击链接）打开时递增，用来让浮窗跳到新的文件 */
  nonce: number;
  /** restoreFocus：是否把焦点还给打开它的元素（Esc / 关闭按钮：是；点击窗口外：否） */
  onClose: (restoreFocus: boolean) => void;
}

export function FilePreview({ session, cwd, path, line, nonce, onClose }: FilePreviewProps) {
  const files = useFiles();
  const panelRef = useRef<HTMLElement>(null);
  // 从被点击的文件链接原位展开；Esc / 关闭按钮缩回原处。
  // 点击窗口外是「顺手去做别的事」（可能正是点了另一个文件链接），直接关，不等动画
  const { requestClose } = useMorph(panelRef);
  const closeAnimated = useCallback(() => requestClose(() => onClose(true)), [requestClose, onClose]);
  const [target, setTarget] = useState({ path, line });
  const [seenNonce, setSeenNonce] = useState(nonce);
  const [mode, setMode] = useState<Mode | null>(null);
  const [wrap, setWrap] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [reloadN, setReloadN] = useState(0);
  const [state, setState] = useState<{ data: FilePreviewData | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });

  // 外部再次打开（点了另一个链接）：跳到新文件，模式回到默认（渲染期调整，避免多一帧旧内容）
  if (seenNonce !== nonce) {
    setSeenNonce(nonce);
    setTarget({ path, line });
    setMode(null);
  }
  const go = useCallback((p: string) => {
    setTarget({ path: p, line: undefined });
    setMode(null);
  }, []);

  const req = useMemo<FileTarget>(() => ({ session, cwd, path: target.path, line: target.line }), [session, cwd, target.path, target.line]);

  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ data: s.data, error: null, loading: true }));
    api
      .filePreview(req)
      .then((data) => {
        if (!cancelled) setState({ data, error: null, loading: false });
      })
      .catch((e: unknown) => {
        if (!cancelled) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [req, reloadN]);

  // 打开时把焦点放进窗口（Esc 才有效，读屏也能读到）
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Esc 关闭：捕获阶段拦截，不让下面的子代理浮层等同时响应
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      closeAnimated();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closeAnimated]);

  // 点击窗口外关闭（非模态：窗口外的界面照常可用，输入框里的草稿不受影响）
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const panel = panelRef.current;
      if (panel && e.target instanceof Node && !panel.contains(e.target)) onClose(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [onClose]);

  const { data, error, loading } = state;
  const isText = !!data && (data.kind === 'markdown' || data.kind === 'code' || data.kind === 'text');
  const text = data?.text ?? '';
  const html = !!data && data.kind === 'code' && isHtmlFile(data.name);
  const modes: Mode[] = data?.kind === 'markdown' ? ['read', 'source', 'split'] : html ? ['source', 'read', 'split'] : [];
  const active: Mode = mode && modes.includes(mode) ? mode : (modes[0] ?? 'source');
  const shownPath = data?.path ?? target.path;
  const name = data?.name ?? pathBasename(target.path);
  const lineCount = useMemo(() => (isText ? splitPlainLines(text).length : 0), [isText, text]);
  const atRoot = !!files?.cwd && !!data && normKey(data.path) === normKey(files.cwd);

  const source = data && (
    <CodeView text={text} language={data.language ?? (data.kind === 'markdown' ? 'markdown' : undefined)} line={data.line ?? target.line} wrap={wrap} />
  );
  const rendered =
    data &&
    (data.kind === 'markdown' ? (
      <div className="cz-fp__read">
        <Markdown text={text} baseFile={data.path} />
      </div>
    ) : (
      <HtmlFrame text={text} title={data.name} />
    ));

  let body: ReactNode;
  if (error) {
    body = (
      <div className="cz-fp__state" role="alert">
        <p>{error}</p>
        <button type="button" className="cz-fp__btn" onClick={() => setReloadN((n) => n + 1)}>
          重试
        </button>
      </div>
    );
  } else if (!data) {
    body = <div className="cz-fp__state">正在加载…</div>;
  } else if (isText) {
    body =
      modes.length === 0 || active === 'source' ? (
        source
      ) : active === 'read' ? (
        rendered
      ) : (
        <div className="cz-fp__split">
          <div className="cz-fp__pane">{source}</div>
          <div className="cz-fp__pane">{rendered}</div>
        </div>
      );
  } else if (data.kind === 'image') {
    body = (
      <div className="cz-fp__media">
        <img src={api.fileRawUrl(req)} alt={data.name} />
      </div>
    );
  } else if (data.kind === 'pdf') {
    body = <iframe className="cz-fp__frame" title={data.name} src={api.fileRawUrl(req)} />;
  } else if (data.kind === 'directory') {
    body = <DirView data={data} atRoot={atRoot} onGo={go} />;
  } else {
    body = <div className="cz-fp__state">{data.reason ?? '不支持预览这种文件'}</div>;
  }

  const footer = data
    ? [
        data.kind === 'directory' ? `${data.entries?.length ?? 0} 项` : formatSize(data.size),
        isText ? `${lineCount} 行` : null,
        isText ? data.encoding : null,
      ].filter(Boolean)
    : [];

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      className={`cz-flow cz-fp${maximized ? ' is-max' : ''}`}
      role="dialog"
      aria-modal="false"
      aria-label={`文件预览：${name}`}
    >
      <header className="cz-fp__head">
        <div className="cz-fp__title">
          <Icon name={data?.kind === 'directory' ? 'folder' : data?.kind === 'image' ? 'image' : 'file'} size={16} />
          <span className="cz-fp__name" title={name}>
            {name}
          </span>
        </div>
        <button
          type="button"
          className="cz-fp__icon-btn"
          aria-label={maximized ? '还原' : '最大化'}
          title={maximized ? '还原' : '最大化'}
          onClick={() => setMaximized((v) => !v)}
        >
          <Icon name={maximized ? 'window-restore' : 'maximize'} size={16} />
        </button>
        <button type="button" className="cz-fp__icon-btn" aria-label="关闭" title="关闭 (Esc)" onClick={closeAnimated}>
          <Icon name="close" size={16} />
        </button>
        <LocalPath path={shownPath} className="cz-fp__path" />
      </header>
      <div className="cz-fp__bar">
        {modes.length > 0 && (
          <div className="cz-fp__modes" role="group" aria-label="显示方式">
            {modes.map((m) => (
              <button key={m} type="button" className={`cz-fp__mode${active === m ? ' is-on' : ''}`} aria-pressed={active === m} onClick={() => setMode(m)}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        )}
        <span className="cz-fp__spacer" />
        {isText && (
          <button type="button" className={`cz-fp__btn${wrap ? ' is-on' : ''}`} aria-pressed={wrap} title="自动换行" onClick={() => setWrap((v) => !v)}>
            <Icon name="wrap" size={14} />
            <span>换行</span>
          </button>
        )}
        <button type="button" className="cz-fp__icon-btn" aria-label="重新加载" title="重新加载" onClick={() => setReloadN((n) => n + 1)}>
          <Icon name="refresh" size={14} />
        </button>
      </div>
      <div className="cz-fp__body" aria-busy={loading}>
        {body}
      </div>
      <footer className="cz-fp__foot">{footer.join(' · ')}</footer>
    </section>
  );
}
