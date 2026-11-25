// 用户消息气泡：正文按 Markdown 渲染；占位名（file1 / img1 / folder1）渲染成内联标签。
// 气泡左侧悬停浮出两个按钮：复制原文、从这条消息之前分支出新会话。
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { isElementRef, type Attachment, type PreviewInfo } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { parseQuotes } from '../../core/quote';
import { api } from '../../core/api';
import { elementName, expandLabels } from '../../core/composer';
import { ChipPreview } from '../composer/ChipPreview';
import { useFiles } from '../files/FileContext';
import { Menu } from '../menus/Menu';
import { useFlowZoom } from './flowZoom';
import { CodeBlock, copyText, nodeText } from './Markdown';
import { attachmentIndex, prepareUserMarkdown } from './userMarkdown';
import './flow.css';
import './userMessage.css';

/** 气泡内容高度超过该阈值时默认折叠到 240px（flow.css），避免长任务提示把下方内容顶走 */
const COLLAPSE_THRESHOLD = 320;

const KIND_ICON: Record<Attachment['kind'], IconName> = { file: 'file', img: 'image', folder: 'folder', el: 'pick' };

/** 粘贴的图片（存在 <cosyee 目录>/pastes/ 下、名字由服务端生成）→ 文件名；其它路径返回 null */
export function pasteName(path: string): string | null {
  const m = /[\\/]pastes[\\/](paste-\d{1,16}-[0-9a-f]{12}\.(?:png|jpg|gif|webp))$/.exec(path);
  return m ? m[1]! : null;
}

/**
 * 附件标签：点击弹出和输入框里标签一样的预览浮窗（路径 / 大小 / 修改时间 / 图片缩略图）。
 * 历史消息没有预览令牌：粘贴的图片按文件名走粘贴图片接口，抓取的元素按文件名走元素接口；其它走「会话工作目录内的文件预览」接口，
 * 没有会话上下文或在工作目录之外时只显示路径。
 */
export const AttachmentTag = memo(function AttachmentTag({ attachment }: { attachment: Attachment }) {
  const files = useFiles();
  const session = files?.session;
  const cwd = files?.cwd;
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const info = useCallback(
    async (path: string): Promise<PreviewInfo> => {
      const paste = pasteName(path);
      if (paste) return api.pasteInfo(paste);
      const element = elementName(path);
      if (element) return api.elementInfo(`${element}.md`);
      if (isElementRef(path)) throw new Error('element ref'); // 定位文字本身就是内容，没有文件
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
  const rawUrl = useCallback((path: string) => {
    const paste = pasteName(path);
    if (paste) return api.pasteRawUrl(paste);
    const element = elementName(path);
    if (element) return api.elementRawUrl(`${element}.png`);
    return session ? api.fileRawUrl({ session, cwd, path }) : '';
  }, [session, cwd]);
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

/** 复制：复制成功后图标短暂变成对勾 */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="cz-flow__icon-btn"
      title={copied ? '已复制' : '复制原文'}
      aria-label={copied ? '已复制' : '复制原文'}
      onClick={() => {
        void (async () => {
          if (!(await copyText(text))) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })();
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
    </button>
  );
}

/** 分支：菜单里两种去向 —— 切到新会话，或留在当前会话（新会话只出现在侧栏） */
function ForkButton({ onFork }: { onFork: (stay: boolean) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const close = useCallback(() => setAnchor(null), []);
  return (
    <>
      <button
        type="button"
        className={`cz-flow__icon-btn${anchor ? ' is-open' : ''}`}
        title="从这条消息之前分支"
        aria-label="从这条消息之前分支"
        aria-expanded={anchor != null}
        onClick={(e) => {
          const el = e.currentTarget;
          setAnchor((a) => (a ? null : el));
        }}
      >
        <Icon name="branch" size={14} />
      </button>
      {anchor && (
        <Menu
          anchor={anchor}
          align="start"
          minWidth={240}
          onClose={close}
          items={[
            { key: 'go', label: '分支并切过去', note: '这条消息的原文填回输入框', onSelect: () => onFork(false) },
            { key: 'stay', label: '分支，留在当前会话', note: '新会话只出现在侧栏', onSelect: () => onFork(true) },
          ]}
        />
      )}
    </>
  );
}

export const UserMessage = memo(function UserMessage({
  text,
  attachments,
  onFork,
}: {
  text: string;
  attachments: Attachment[];
  /** 可分支时才传：stay=true 表示分支完留在当前会话 */
  onFork?: (stay: boolean) => void;
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
  // 复制 / 分支预填用的原文：占位名换回 @"绝对路径"，粘到别处可读，填回输入框能解析成标签
  const raw = useMemo(() => expandLabels(text, attachments), [text, attachments]);

  const bubbleRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const zoom = useFlowZoom();
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [prevText, setPrevText] = useState(text);
  if (text !== prevText) {
    setPrevText(text);
    if (expanded) setExpanded(false);
  }
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) return;
    const measure = () => {
      // 展开态下按钮在文档流里，扣掉按钮高度避免临界高度来回抖动；折叠态下按钮绝对定位不占 scrollHeight
      const btnH = expandedRef.current && toggleRef.current ? toggleRef.current.offsetHeight + 8 : 0;
      setOverflow(el.scrollHeight - btnH > COLLAPSE_THRESHOLD);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, attachments, zoom]);

  const collapsed = overflow && !expanded;

  return (
    <div className="cz-flow__user">
      <div className="cz-flow__acts">
        {onFork && <ForkButton onFork={onFork} />}
        <CopyButton text={raw} />
      </div>
      <div className={`cz-flow__bubble cz-spot${collapsed ? ' is-collapsed' : ''}`} ref={bubbleRef}>
        {parts
          ? parts.map((p, i) => (
              <div key={i} className="cz-flow__qpart">
                <div className="cz-flow__quote" title={p.quote}>{p.quote}</div>
                {md(p.text)}
              </div>
            ))
          : md(text)}
        {collapsed && <div className="cz-flow__bubble-fade" aria-hidden="true" />}
        {overflow && (
          <button
            ref={toggleRef}
            type="button"
            className="cz-flow__bubble-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? '收起' : '展开全文'}
          </button>
        )}
      </div>
    </div>
  );
});
