// 输入框：大圆角长条，左「+」、中间 contenteditable（文字与标签混排）、右侧麦克风与发送 / 停止，下方模型菜单。
// 编辑区的内部 DOM 完全由本组件命令式维护（React 不渲染其子节点），内容变化后统一走 afterChange()。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { PickedItem, PreviewInfo, SessionConfig, UsageInfo } from '@cosyee/shared';
import type { Attachment } from '@cosyee/shared';
import { itemKind, labelChips, serialize, toAttachments, trimSegments } from '../../core/composer';
import { buildQuotedMessage } from '../../core/quote';
import { Icon } from '../icons/Icon';
import { ModelMenu } from '../menus/ModelMenu';
import { UsageMeter } from '../usage/UsageMeter';
import { ChipPreview } from './ChipPreview';
import { SlashMenu } from './SlashMenu';
import { createChipElement } from './chipElement';
import { CHIP_CLASS, insertNodesAt, isEditorEmpty, readSegments, relabelChips } from './editorDom';
import { filterSlash, matchSlash, type SlashItem } from './slash';
import { cleanPastedText } from './pasteText';
import './Composer.css';

export interface ComposerProps {
  onSend: (text: string, attachments: Attachment[]) => void;
  onInterrupt: () => void;
  running: boolean;
  pick: (mode?: 'mixed' | 'files' | 'folders') => Promise<{ items: PickedItem[]; supportsMixed: boolean }>;
  /** 粘贴图片：上传到后端，返回可作为标签的项。不传则忽略剪贴板里的图片 */
  paste?: (blob: Blob) => Promise<PickedItem>;
  /** 系统选择窗口是否支持文件 / 文件夹混选（决定「+」的行为） */
  supportsMixed: boolean;
  previewInfo: (token: string) => Promise<PreviewInfo>;
  previewRawUrl: (token: string) => string;
  slashCommands: string[];
  skills: string[];
  config: SessionConfig;
  onConfigChange: (c: SessionConfig) => void;
  disabled?: boolean;
  /** 读取订阅额度；不传则不显示额度 */
  loadUsage?: (refresh: boolean) => Promise<UsageInfo | null>;
  /** false 时模型菜单隐藏 Ultracode 开关 */
  ultracodeAvailable?: boolean;
  /** 选中回复带来的引用文字：显示在输入框顶部的引用卡片里，发送时作为 `> ` 引用块拼在消息开头 */
  quote?: string | null;
  /** 点引用卡片的 ✕；发送后也会调用它清掉引用 */
  onClearQuote?: () => void;
}

/** 给外部（选中回复）用的命令式接口 */
export interface ComposerHandle {
  /** 把文字追加到编辑区末尾（空编辑区则直接填入），光标放到末尾并聚焦 */
  appendText: (text: string) => void;
}

interface SlashState {
  query: string;
  node: Text;
  start: number;
  end: number;
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, handleRef) {
  const { onSend, onInterrupt, running, supportsMixed, slashCommands, skills, config, onConfigChange, disabled } = props;
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const composing = useRef(false);
  const picking = useRef(false);
  const [empty, setEmpty] = useState(true);
  // 全是空白的引用等同于没有
  const quote = props.quote && props.quote.trim() ? props.quote : null;
  const [preview, setPreview] = useState<HTMLElement | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const slashRef = useRef<SlashState | null>(null);
  slashRef.current = slash;

  // 把会变的回调放进 ref，给 ChipPreview 传稳定引用，避免它反复请求
  const latest = useRef(props);
  latest.current = props;
  const previewInfo = useCallback((t: string) => latest.current.previewInfo(t), []);
  const previewRawUrl = useCallback((t: string) => latest.current.previewRawUrl(t), []);
  const closePreview = useCallback(() => setPreview(null), []);

  // 记住编辑区里最后一次选区，点「+」之前的光标位置靠它
  useEffect(() => {
    const onSel = () => {
      const ed = editorRef.current;
      const sel = window.getSelection();
      if (ed && sel && sel.rangeCount && ed.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);

  // ───────────── / 菜单 ─────────────

  const slashItems: SlashItem[] = useMemo(
    () => (slash ? filterSlash(slashCommands, skills, slash.query) : []),
    [slash, slashCommands, skills],
  );
  const slashOpen = slash !== null && slashItems.length > 0;

  const evalSlash = useCallback(() => {
    const ed = editorRef.current;
    const sel = window.getSelection();
    if (!ed || !sel || !sel.rangeCount || !sel.isCollapsed) return setSlash(null);
    const r = sel.getRangeAt(0);
    const node = r.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !ed.contains(node)) return setSlash(null);
    const text = node as Text;
    const m = matchSlash(text.data.slice(0, r.startOffset));
    if (!m) return setSlash(null);
    if (m.start === 0) {
      // 在文本节点开头：前一个兄弟若是标签 / 非空白文字，则不算行首
      const prev = text.previousSibling;
      const prevOk = !prev || prev.nodeName === 'BR' || (prev.nodeType === Node.TEXT_NODE && /\s$/.test((prev as Text).data));
      if (!prevOk) return setSlash(null);
    }
    if (!slashRef.current || slashRef.current.query !== m.query) setSlashIdx(0);
    setSlash({ query: m.query, node: text, start: m.start, end: r.startOffset });
  }, []);

  const pickSlash = useCallback((item: SlashItem) => {
    if (!slash) return;
    const { node, start, end } = slash;
    const ins = `/${item.name} `;
    const after = node.data.slice(end);
    node.data = node.data.slice(0, start) + ins + after.replace(/^ /, '');
    const r = document.createRange();
    r.setStart(node, start + ins.length);
    r.collapse(true);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(r);
    setSlash(null);
    setEmpty(false);
  }, [slash]);

  // ───────────── 内容变化 ─────────────

  const afterChange = useCallback(() => {
    const ed = editorRef.current;
    if (!ed) return;
    relabelChips(ed);
    setEmpty(isEditorEmpty(ed));
    setPreview((p) => (p && p.isConnected ? p : null));
    evalSlash();
  }, [evalSlash]);

  // ───────────── 发送 ─────────────

  // Ctrl+Enter 在运行中加入的队列：一轮结束后逐条发出
  const queue = useRef<{ text: string; attachments: Attachment[] }[]>([]);
  const [queued, setQueued] = useState(0);

  /** 读出编辑区内容并清空；空内容返回 null */
  const take = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || disabled) return null;
    const segs = labelChips(trimSegments(readSegments(ed)));
    if (!segs.length && !quote) return null; // 有引用时正文可以为空
    const out = { text: buildQuotedMessage(quote, serialize(segs)), attachments: toAttachments(segs) };
    ed.innerHTML = '';
    setEmpty(true);
    setSlash(null);
    setPreview(null);
    if (quote) latest.current.onClearQuote?.();
    return out;
  }, [disabled, quote]);

  // 运行中按 Enter 直接发出（CLI 自己排队）；空闲时同样
  const send = useCallback(() => {
    const m = take();
    if (m) onSend(m.text, m.attachments);
  }, [take, onSend]);

  const enqueue = useCallback(() => {
    const m = take();
    if (!m) return;
    if (!latest.current.running) return onSend(m.text, m.attachments);
    queue.current.push(m);
    setQueued(queue.current.length);
  }, [take, onSend]);

  useEffect(() => {
    if (running || !queue.current.length) return;
    const m = queue.current.shift()!;
    setQueued(queue.current.length);
    onSend(m.text, m.attachments);
  }, [running, onSend]);

  // ───────────── 选中回复：把弹层里输入的内容放进编辑区 ─────────────

  useImperativeHandle(handleRef, () => ({
    appendText(text: string) {
      const ed = editorRef.current;
      if (!ed || disabled) return;
      if (isEditorEmpty(ed)) ed.innerHTML = '';
      ed.focus();
      if (text) {
        const end = document.createRange();
        end.selectNodeContents(ed);
        end.collapse(false);
        insertNodesAt(ed, end, [document.createTextNode(text)]); // 光标落在插入内容之后
      } else {
        const r = document.createRange();
        r.selectNodeContents(ed);
        r.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      }
      afterChange();
      ed.scrollTop = ed.scrollHeight;
    },
  }), [disabled, afterChange]);

  // ───────────── 「+」选择文件 ─────────────

  const doPick = useCallback(async (shift: boolean) => {
    const ed = editorRef.current;
    if (!ed || picking.current || disabled) return;
    const saved = savedRange.current ? savedRange.current.cloneRange() : null; // 点按钮前的光标位置
    const mode = supportsMixed ? 'mixed' : shift ? 'folders' : 'files';
    picking.current = true;
    try {
      const { items } = await latest.current.pick(mode);
      if (!items.length) return;
      const nodes: Node[] = [];
      for (const it of items) {
        nodes.push(createChipElement({ kind: itemKind(it), path: it.path, label: '', token: it.previewToken }));
        nodes.push(document.createTextNode(' '));
      }
      ed.focus();
      insertNodesAt(ed, saved, nodes);
      afterChange();
    } catch {
      /* 选择窗口失败：忽略，用户可重试 */
    } finally {
      picking.current = false;
    }
  }, [supportsMixed, disabled, afterChange]);

  // ───────────── 事件 ─────────────

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (slashOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setSlashIdx((i) => (i + d + slashItems.length) % slashItems.length);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        pickSlash(slashItems[Math.min(slashIdx, slashItems.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlash(null);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Shift+Enter 走浏览器默认换行；Ctrl/⌘+Enter 运行中加入队列
      if (e.ctrlKey || e.metaKey) enqueue();
      else send();
    }
  };

  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showHint = useCallback((msg: string) => {
    setHint(msg);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 4000);
  }, []);
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  /** 上传剪贴板里的图片，按顺序在粘贴时的光标处插入标签。 */
  const pasteImages = useCallback(async (files: File[], at: Range | null) => {
    const ed = editorRef.current;
    const upload = latest.current.paste;
    if (!ed || !upload) return;
    try {
      const items = await Promise.all(files.map((f) => upload(f)));
      const nodes: Node[] = [];
      for (const it of items) {
        nodes.push(createChipElement({ kind: itemKind(it), path: it.path, label: '', token: it.previewToken }));
        nodes.push(document.createTextNode(' '));
      }
      ed.focus();
      insertNodesAt(ed, at, nodes);
      afterChange();
    } catch (err) {
      showHint(`图片粘贴失败：${err instanceof Error ? err.message : err}`);
    }
  }, [afterChange, showHint]);

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault(); // 只接受纯文本与图片
    const images = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (images.length) {
      // 剪贴板里同时有图片和文字时（如从网页复制）以图片为准
      if (latest.current.paste) {
        const sel = window.getSelection();
        const ed = editorRef.current;
        const at = sel && sel.rangeCount && ed?.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : savedRange.current;
        void pasteImages(images, at);
      }
      return;
    }
    const text = cleanPastedText(e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n'));
    if (!text) return;
    if (!document.execCommand('insertText', false, text)) {
      const ed = editorRef.current;
      if (ed) insertNodesAt(ed, savedRange.current, [document.createTextNode(text)]);
    }
    afterChange();
  };

  const onEditorClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const chip = (e.target as Element).closest<HTMLElement>(`.${CHIP_CLASS}`);
    if (chip) {
      setPreview((p) => (p === chip ? null : chip)); // 再点同一个标签关闭
      return;
    }
    evalSlash();
  };

  const onEditorMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    // 点标签不移动光标，也不让编辑区失焦
    if ((e.target as Element).closest(`.${CHIP_CLASS}`)) {
      e.preventDefault();
      editorRef.current?.focus();
    }
  };

  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="cz-composer">
      <div className="cz-composer__boxwrap">
      {slashOpen && (
        <SlashMenu
          items={slashItems}
          activeIndex={Math.min(slashIdx, slashItems.length - 1)}
          onHover={setSlashIdx}
          onPick={pickSlash}
        />
      )}
      <div className={`cz-composer__box${disabled ? ' is-disabled' : ''}`}>
        {quote && (
          <div className="cz-composer__quote">
            <Icon name="reply" size={14} className="cz-composer__quote-icon" />
            <span className="cz-composer__quote-text" title={quote}>“{quote}”</span>
            <span className="cz-composer__quote-tag">附带回复</span>
            <button
              type="button"
              className="cz-composer__quote-x"
              title="移除引用"
              aria-label="移除引用"
              onMouseDown={keepFocus}
              onClick={() => props.onClearQuote?.()}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        )}
        <div className="cz-composer__row">
          <button
            type="button"
            className="cz-composer__btn"
            disabled={disabled}
            title={supportsMixed ? '添加文件或文件夹' : '添加文件（按住 Shift 点击添加文件夹）'}
            aria-label="添加文件"
            onMouseDown={keepFocus}
            onClick={(e) => { void doPick(e.shiftKey); }}
          >
            <Icon name="plus" size={18} />
          </button>
          <div className="cz-composer__editor-wrap">
            <div
              ref={editorRef}
              className="cz-composer__editor"
              role="textbox"
              aria-multiline="true"
              aria-label="输入消息"
              contentEditable={!disabled}
              suppressContentEditableWarning
              spellCheck={false}
              data-empty={empty ? 'true' : 'false'}
              data-placeholder={running ? '按 Enter 发送，按 Ctrl+Enter 加入队列稍后发送' : '输入 / 以使用命令'}
              onInput={afterChange}
              onKeyDown={onKeyDown}
              onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') evalSlash(); }}
              onPaste={onPaste}
              onClick={onEditorClick}
              onMouseDown={onEditorMouseDown}
              onBlur={() => setSlash(null)}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; afterChange(); }}
              onDrop={(e) => e.preventDefault()}
              onDragOver={(e) => e.preventDefault()}
            />
          </div>
          {running && empty && !quote ? (
            <button
              type="button"
              className="cz-composer__btn cz-composer__btn--stop"
              title="停止"
              aria-label="停止"
              onMouseDown={keepFocus}
              onClick={onInterrupt}
            >
              <Icon name="stop" size={16} />
            </button>
          ) : empty && !quote ? null : ( // 没有内容（空白 / 无附件 / 无引用）时不显示发送按钮，输入区自动占满空出的宽度
            <button
              type="button"
              className="cz-composer__btn cz-composer__btn--send"
              title={running ? '发送（Enter）· 加入队列（Ctrl+Enter）' : '发送（Enter）'}
              aria-label="发送"
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={send}
            >
              <Icon name="send" size={18} />
            </button>
          )}
          <button type="button" className="cz-composer__btn" title="语音输入（暂未实现）" aria-label="语音输入" onMouseDown={keepFocus}>
            <Icon name="mic" size={18} />
          </button>
        </div>
      </div>
      </div>
      {hint && <div className="cz-composer__hint" role="status">{hint}</div>}
      <div className="cz-composer__foot">
        {queued > 0 && <span className="cz-composer__queued">队列中 {queued} 条</span>}
        <ModelMenu config={config} onChange={onConfigChange} disabled={disabled} ultracodeAvailable={props.ultracodeAvailable} />
        {props.loadUsage && <UsageMeter load={props.loadUsage} running={running} />}
      </div>
      {preview && (
        <ChipPreview anchor={preview} onClose={closePreview} previewInfo={previewInfo} previewRawUrl={previewRawUrl} />
      )}
    </div>
  );
});
