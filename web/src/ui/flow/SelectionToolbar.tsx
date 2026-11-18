// 选中回复：在助手答复里选中文字后，选区附近弹出「复制 | 回复」浮条；点「回复」变成带引用的小输入框。
// 位置用 position: fixed + range 的视口坐标，滚动时关闭（回复输入中不关，避免流式自动滚动丢掉已输入的内容）。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/Icon';
import { copyText } from './Markdown';
import './selection.css';

/** 只有助手答复的 Markdown 区域算数（不含用户气泡、展开区、输入框） */
const ANSWER_SELECTOR = '.cz-flow__answer';
const GAP = 8;
const EDGE = 8;

interface Anchor {
  text: string;
  /** 视口坐标：选区水平中心、首行顶部、末行底部 */
  cx: number;
  top: number;
  bottom: number;
}

type Mode = 'bar' | 'copied' | 'reply';
interface State { mode: Mode; anchor: Anchor }

/** 读取当前选区；不在同一个答复容器内、折叠或全是空白时返回 null */
function readAnchor(root: HTMLElement): Anchor | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const answer = el?.closest(ANSWER_SELECTOR);
  if (!answer || !root.contains(answer)) return null;
  const text = sel.toString().replace(/\r\n?/g, '\n').trim();
  if (!text) return null;
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  const box = range.getBoundingClientRect();
  const first = rects[0] ?? box;
  const last = rects[rects.length - 1] ?? box;
  return { text, cx: box.left + box.width / 2, top: first.top, bottom: last.bottom };
}

export interface SelectionToolbarProps {
  /** 会话流的滚动容器：选区必须在它里面，它滚动时关闭浮条 */
  scrollRef: RefObject<HTMLElement>;
  /** 变化时关闭（切换会话） */
  resetKey?: string | null;
  /** 确认回复：quote 是选中的文字，reply 是弹层里输入的内容（可为空） */
  onReply: (quote: string, reply: string) => void;
}

export function SelectionToolbar({ scrollRef, resetKey, onReply }: SelectionToolbarProps) {
  const [st, setSt] = useState<State | null>(null);
  const stRef = useRef(st);
  stRef.current = st;
  const boxRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setSt(null), []);

  // 切换会话时关闭
  useEffect(() => { setSt(null); }, [resetKey]);

  // 选区结束（鼠标抬起 / 键盘选择）后计算位置；回复输入中不再响应选区变化
  useEffect(() => {
    const evaluate = () => {
      const root = scrollRef.current;
      if (!root || stRef.current?.mode === 'reply') return;
      const anchor = readAnchor(root);
      setSt(anchor ? { mode: 'bar', anchor } : null);
    };
    const inBox = (t: EventTarget | null) => !!t && boxRef.current?.contains(t as Node);
    const onMouseUp = (e: MouseEvent) => {
      if (inBox(e.target)) return;
      // 等浏览器处理完这次点击（点在选区里会折叠选区）再读
      window.setTimeout(evaluate, 0);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (inBox(e.target) || e.key === 'Escape') return;
      evaluate();
    };
    const onMouseDown = (e: MouseEvent) => {
      if (stRef.current && !inBox(e.target)) setSt(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && stRef.current) setSt(null);
    };
    const onSelectionChange = () => {
      const cur = stRef.current;
      if (!cur || cur.mode !== 'bar') return;
      const root = scrollRef.current;
      if (!root || !readAnchor(root)) setSt(null);
    };
    const onScroll = () => { if (stRef.current && stRef.current.mode !== 'reply') setSt(null); };
    const onResize = () => setSt(null);
    const scroller = scrollRef.current;
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keyup', onKeyUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('selectionchange', onSelectionChange);
    scroller?.addEventListener('scroll', onScroll);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('selectionchange', onSelectionChange);
      scroller?.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
    };
  }, [scrollRef]);

  // 定位：优先放选区下方，放不下放上方；水平居中并夹在视口内。直接改样式，避免多一次渲染
  const mode = st?.mode;
  const anchor = st?.anchor;
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el || !anchor) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(EDGE, Math.min(anchor.cx - w / 2, vw - w - EDGE));
    let top = anchor.bottom + GAP;
    if (top + h > vh - EDGE) top = anchor.top - GAP - h;
    top = Math.max(EDGE, Math.min(top, vh - h - EDGE));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [anchor, mode]);

  // 「已复制」短暂显示后关闭
  useEffect(() => {
    if (mode !== 'copied') return;
    const id = window.setTimeout(close, 900);
    return () => window.clearTimeout(id);
  }, [mode, close]);

  if (!st) return null;

  const onCopy = async () => {
    const { anchor: a } = st;
    await copyText(a.text);
    setSt((cur) => (cur ? { ...cur, mode: 'copied' } : cur));
  };

  return createPortal(
    <div
      ref={boxRef}
      className={`cz-sel${st.mode === 'reply' ? ' cz-sel--reply' : ''}`}
      role={st.mode === 'reply' ? 'dialog' : 'toolbar'}
      aria-label="选中文字操作"
      // 浮条上的按钮不抢焦点，选区才不会丢；回复输入框要正常取得焦点
      onMouseDown={st.mode === 'reply' ? undefined : (e) => e.preventDefault()}
    >
      {st.mode === 'bar' && (
        <>
          <button type="button" className="cz-sel__btn" onClick={() => void onCopy()}>
            <Icon name="copy" size={14} />
            <span>复制</span>
          </button>
          <span className="cz-sel__sep" aria-hidden />
          <button
            type="button"
            className="cz-sel__btn"
            onClick={() => setSt((cur) => (cur ? { ...cur, mode: 'reply' } : cur))}
          >
            <Icon name="reply" size={14} />
            <span>回复</span>
          </button>
        </>
      )}
      {st.mode === 'copied' && (
        <span className="cz-sel__done" role="status">
          <Icon name="check" size={14} />
          <span>已复制</span>
        </span>
      )}
      {st.mode === 'reply' && (
        <ReplyBox
          quote={st.anchor.text}
          onCancel={close}
          onConfirm={(text) => {
            const quote = st.anchor.text;
            close();
            onReply(quote, text);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

function ReplyBox({ quote, onCancel, onConfirm }: { quote: string; onCancel: () => void; onConfirm: (text: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);

  const grow = () => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onConfirm(ref.current?.value.trim() ?? '');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="cz-sel__reply">
      <div className="cz-sel__quote" title={quote}>
        <span className="cz-sel__quote-text">{quote}</span>
      </div>
      <textarea
        ref={ref}
        className="cz-sel__input"
        rows={1}
        placeholder="我的回复"
        aria-label="我的回复"
        spellCheck={false}
        onInput={grow}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
      />
    </div>
  );
}
