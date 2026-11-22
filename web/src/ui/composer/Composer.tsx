// 输入框：大圆角长条，左「+」、中间 contenteditable（文字与标签混排）、右侧麦克风与发送 / 停止，下方模型菜单。
// 编辑区的内部 DOM 完全由本组件命令式维护（React 不渲染其子节点），内容变化后统一走 afterChange()。
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PickedItem, PreviewInfo, QueueItem, QueueMode, SessionConfig, UsageInfo } from '@cosyee/shared';
import type { Attachment } from '@cosyee/shared';
import { itemKind, labelChips, serialize, splitMentions, toAttachments, trimSegments } from '../../core/composer';
import { buildQuotedMessage, type QuoteReply } from '../../core/quote';
import { Icon } from '../icons/Icon';
import { ModelMenu } from '../menus/ModelMenu';
import { ModeMenu } from '../menus/ModeMenu';
import { UsageMeter } from '../usage/UsageMeter';
import { ChipPreview } from './ChipPreview';
import { RewindPicker, type RewindTarget } from './RewindPicker';
import { SlashMenu } from './SlashMenu';
import { createChipElement } from './chipElement';
import { CHIP_CLASS, insertNodesAt, isEditorEmpty, readSegments, relabelChips } from './editorDom';
import { DRAFT_DELAY_MS, readDraft, writeDraft } from './draft';
import { applyTextEdit, charBeforeNode, getSelectionOffsets, highlightEditor, scanEditor, setEditorContent, setSelectionOffsets } from './mdEditorDom';
import { tokenize } from './mdHighlight';
import { listIndentEdit, listNewlineEdit } from './mdList';
import { filterSlash, matchSlash, type SlashItem } from './slash';
import { cleanPastedText } from './pasteText';
import './Composer.css';

/** 双击 Esc 的最大间隔 */
const DOUBLE_ESC_MS = 400;

export interface ComposerProps {
  /**
   * 空闲时只传前两个参数；执行中 Enter 为 'next'（插话，并入当前这一轮），Ctrl+Enter 为 'later'（排队，这一轮结束后再发）。
   */
  onSend: (text: string, attachments: Attachment[], mode?: QueueMode) => void;
  onInterrupt: () => void;
  running: boolean;
  /** 当前会话：换会话时流光直接消失（不带着绕圈的光头淡出，否则会闪一道蓝光） */
  sessionKey?: string | null;
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
  /**
   * 选中回复带来的引用（可有多段），每段带着对它的回复：显示在输入框顶部（每段一行：引用 + 可编辑的回复），
   * 发送时按「引用 → 它的回复 → 下一段 …… → 正文」交错拼在消息开头
   */
  quotes?: readonly QuoteReply[];
  /** 点某段引用的 ✕：只移除这一段（index 对应 quotes 下标） */
  onRemoveQuote?: (index: number) => void;
  /** 改了某段引用的回复（index 对应 quotes 下标） */
  onEditQuoteReply?: (index: number, reply: string) => void;
  /** 发送后调用，清掉全部引用 */
  onClearQuotes?: () => void;
  /** 已发给 CLI、还没开始执行的消息（后端推送的快照）：显示在输入框上方 */
  queue?: QueueItem[];
  /** 排队项的「立即发送」：中断当前这一轮，马上执行它 */
  onQueueSendNow?: (id: string) => void;
  /** 排队项的「撤回编辑」：撤回后原文由外部通过 restoreText 填回 */
  onQueueCancel?: (id: string) => void;
  /** 双击 Esc 浮层里可回退的用户消息（旧 → 新，不含 steering） */
  rewindTargets?: RewindTarget[];
  /** 在浮层里选定了回退目标 */
  onRewind?: (targetId: string) => void;
  /** 输入框下方一行的左侧内容（新会话时放工作空间选择器）；不传则不占位 */
  footLeft?: ReactNode;
}

/** 给外部（选中回复）用的命令式接口 */
export interface ComposerHandle {
  /** 把文字追加到编辑区末尾（空编辑区则直接填入），光标放到末尾并聚焦 */
  appendText: (text: string) => void;
  /**
   * 把撤回 / 回退的原文填回输入框（`@"路径"` 还原为标签）并聚焦。
   * replace：替换现有内容；append：编辑区为空时直接填入，否则换行后追加。
   */
  restoreText: (text: string, how: 'replace' | 'append') => void;
  /** 当前是否有未发送的内容（文字或标签） */
  hasContent: () => boolean;
}

interface SlashState {
  query: string;
  node: Text;
  start: number;
  end: number;
}

/** 带 `@"路径"` 的文本 → 文字节点 + 标签元素 */
function textToNodes(text: string): Node[] {
  return splitMentions(text).map((seg) =>
    seg.t === 'text' ? document.createTextNode(seg.text) : createChipElement({ kind: seg.kind, path: seg.path, label: '' }),
  );
}

/** 单行显示：取首个非空行 */
function oneLine(text: string): string {
  return (text.split('\n').find((l) => l.trim()) ?? '').trim();
}

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(props, handleRef) {
  const { onSend, onInterrupt, running, supportsMixed, slashCommands, skills, config, onConfigChange, disabled } = props;
  const editorRef = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);
  const composing = useRef(false);
  const picking = useRef(false);
  const [empty, setEmpty] = useState(true);
  // 全是空白的引用等同于没有；下标仍对应 props.quotes（移除时回传）
  const quoteItems = useMemo(
    () => (props.quotes ?? []).map((q, index) => ({ ...q, index })).filter((q) => q.quote.trim()),
    [props.quotes],
  );
  const hasQuote = quoteItems.length > 0;
  const [preview, setPreview] = useState<HTMLElement | null>(null);
  const [slash, setSlash] = useState<SlashState | null>(null);
  const [slashIdx, setSlashIdx] = useState(0);
  const slashRef = useRef<SlashState | null>(null);
  slashRef.current = slash;
  const [rewindOpen, setRewindOpen] = useState(false);
  const lastEsc = useRef(0);

  // 把会变的回调放进 ref，给 ChipPreview 传稳定引用，避免它反复请求
  const latest = useRef(props);
  latest.current = props;
  const previewInfo = useCallback((t: string) => latest.current.previewInfo(t), []);
  const previewRawUrl = useCallback((t: string) => latest.current.previewRawUrl(t), []);
  const closePreview = useCallback(() => setPreview(null), []);

  // ───────────── 草稿（全局一份，防抖写 localStorage） ─────────────

  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveDraftNow = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    const ed = editorRef.current;
    if (!ed) return;
    writeDraft(isEditorEmpty(ed) ? '' : serialize(readSegments(ed)));
  }, []);
  const scheduleDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(saveDraftNow, DRAFT_DELAY_MS);
  }, [saveDraftNow]);
  const clearDraft = useCallback(() => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    writeDraft('');
  }, []);
  useEffect(() => {
    // 页面关闭 / 切后台前补写一次，避免丢最后 300ms 的输入
    const flush = () => { if (draftTimer.current) saveDraftNow(); };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, [saveDraftNow]);

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
      // 在文本节点开头：前面紧邻的字符若是标签 / 非空白文字，则不算行首（着色后文本节点被拆进各种 span，所以按文档顺序找前一个字符）
      const before = charBeforeNode(ed, text);
      if (before !== null && !/\s/.test(before)) return setSlash(null);
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
    const ed = editorRef.current;
    if (ed && !composing.current) highlightEditor(ed);
    scheduleDraft();
  }, [slash, scheduleDraft]);

  // ───────────── 内容变化 ─────────────

  /**
   * skipHighlight：输入法组合期间不能动 DOM（重渲染会打断候选 / 移动光标），compositionend 之后再统一着色。
   */
  const afterChange = useCallback((skipHighlight = false) => {
    const ed = editorRef.current;
    if (!ed) return;
    if (skipHighlight !== true && !composing.current) highlightEditor(ed);
    relabelChips(ed);
    setEmpty(isEditorEmpty(ed));
    setPreview((p) => (p && p.isConnected ? p : null));
    evalSlash();
    scheduleDraft();
  }, [evalSlash, scheduleDraft]);

  // ───────────── 发送 ─────────────

  /** 读出编辑区内容并清空；空内容返回 null */
  const take = useCallback(() => {
    const ed = editorRef.current;
    if (!ed || disabled) return null;
    const segs = labelChips(trimSegments(readSegments(ed)));
    if (!segs.length && !hasQuote) return null; // 有引用时正文可以为空
    const out = { text: buildQuotedMessage(quoteItems, serialize(segs)), attachments: toAttachments(segs) };
    ed.innerHTML = '';
    setEmpty(true);
    setSlash(null);
    setPreview(null);
    clearDraft();
    if (hasQuote) latest.current.onClearQuotes?.();
    return out;
  }, [disabled, hasQuote, quoteItems, clearDraft]);

  // 空闲时直接发送；执行中按 mode 发给 CLI（next=插话 / later=排队），排队由后端与 CLI 维护，前端只显示快照
  const send = useCallback((mode: QueueMode = 'next') => {
    const m = take();
    if (!m) return;
    if (latest.current.running) onSend(m.text, m.attachments, mode);
    else onSend(m.text, m.attachments);
  }, [take, onSend]);

  // ───────────── 选中回复：聚焦编辑区 / 追加文字 ─────────────

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
    restoreText(text: string, how: 'replace' | 'append') {
      const ed = editorRef.current;
      if (!ed || disabled) return;
      const nodes: Node[] = [];
      if (how === 'append' && !isEditorEmpty(ed)) nodes.push(document.createTextNode('\n'));
      else ed.innerHTML = '';
      nodes.push(...textToNodes(text));
      ed.append(...nodes);
      ed.focus();
      const r = document.createRange();
      r.selectNodeContents(ed);
      r.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(r);
      afterChange();
      ed.scrollTop = ed.scrollHeight;
    },
    hasContent() {
      const ed = editorRef.current;
      return !!ed && !isEditorEmpty(ed);
    },
  }), [disabled, afterChange]);

  // 挂载时编辑区为空就恢复草稿（`@"路径"` 还原成标签，并套上 Markdown 着色）；不抢焦点
  useLayoutEffect(() => {
    const ed = editorRef.current;
    if (!ed || !isEditorEmpty(ed)) return;
    const d = readDraft();
    if (!d) return;
    ed.innerHTML = '';
    ed.append(...textToNodes(d));
    afterChange();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ───────────── Markdown 列表：换行续写 / 退出、Tab 缩进 ─────────────

  /** 折叠光标所在的列表项里换行：续写下一项或退出列表。返回是否已处理（已处理则要 preventDefault） */
  const continueList = useCallback((): boolean => {
    const ed = editorRef.current;
    if (!ed || disabled || composing.current) return false;
    const sel = getSelectionOffsets(ed);
    if (!sel || sel.anchor !== sel.focus) return false;
    const { text } = scanEditor(ed);
    const lineNo = text.slice(0, sel.focus).split('\n').length - 1;
    const lines = tokenize(text);
    const edit = listNewlineEdit(text, sel.focus, lines[lineNo]?.fence ?? false);
    if (!edit) return false;
    applyTextEdit(ed, edit);
    afterChange();
    return true;
  }, [disabled, afterChange]);

  /** Tab / Shift+Tab：缩进 / 反缩进选区里的列表项。返回是否已处理 */
  const indentList = useCallback((outdent: boolean): boolean => {
    const ed = editorRef.current;
    if (!ed || disabled || composing.current) return false;
    const sel = getSelectionOffsets(ed);
    if (!sel) return false;
    const { text, chips } = scanEditor(ed);
    const lines = tokenize(text);
    const start = Math.min(sel.anchor, sel.focus);
    const end = Math.max(sel.anchor, sel.focus);
    const res = listIndentEdit(text, start, end, outdent, (n) => lines[n]?.fence ?? false);
    if (!res) return false;
    if (res.text !== text) setEditorContent(ed, res.text, chips);
    const forward = sel.anchor <= sel.focus;
    setSelectionOffsets(ed, forward ? res.start : res.end, forward ? res.end : res.start);
    afterChange();
    return true;
  }, [disabled, afterChange]);

  // 软键盘 / 其它来源的「插入换行」也走列表续写（Shift+Enter 在 onKeyDown 里已处理）
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const onBeforeInput = (ev: Event) => {
      const t = (ev as InputEvent).inputType;
      if (t !== 'insertLineBreak' && t !== 'insertParagraph') return;
      if ((ev as InputEvent).isComposing) return;
      if (continueList()) ev.preventDefault();
    };
    ed.addEventListener('beforeinput', onBeforeInput);
    return () => ed.removeEventListener('beforeinput', onBeforeInput);
  }, [continueList]);

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
    if (e.key === 'Escape') {
      // 双击 Esc（400ms 内）：打开回退浮层。单击 Esc 不做任何事
      e.preventDefault();
      const now = Date.now();
      if (now - lastEsc.current <= DOUBLE_ESC_MS) {
        lastEsc.current = 0;
        if (props.rewindTargets?.length) setRewindOpen(true);
        else showHint('没有可回退的消息');
      } else {
        lastEsc.current = now;
      }
      return;
    }
    if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Shift+Enter 换行：在列表项里自动续写；其它情况走浏览器默认换行
      if (continueList()) e.preventDefault();
      return;
    }
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // 补全菜单打开时 Tab 已在上面用于选择；这里只处理列表缩进，非列表行保持默认
      if (indentList(e.shiftKey)) e.preventDefault();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      // Shift+Enter 走浏览器默认换行；执行中 Enter=插话，Ctrl/⌘+Enter=排队
      send(e.ctrlKey || e.metaKey ? 'later' : 'next');
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
  const queueItems = props.queue ?? [];

  return (
    <div className="cz-composer">
      {queueItems.length > 0 && (
        <ul className="cz-queue" aria-label="排队中的消息">
          {queueItems.map((q) => (
            <li key={q.id} className="cz-queue__item">
              <span className={`cz-queue__tag cz-queue__tag--${q.mode}`}>{q.mode === 'next' ? '插话' : '排队'}</span>
              <span className="cz-queue__text" title={q.text}>{oneLine(q.text)}</span>
              <button type="button" className="cz-queue__btn" title="中断当前任务，立即执行这条" onMouseDown={keepFocus} onClick={() => props.onQueueSendNow?.(q.id)}>立即发送</button>
              <button type="button" className="cz-queue__btn" title="撤回这条并放回输入框编辑" onMouseDown={keepFocus} onClick={() => props.onQueueCancel?.(q.id)}>撤回编辑</button>
            </li>
          ))}
        </ul>
      )}
      <div className="cz-composer__boxwrap">
      {rewindOpen && props.rewindTargets && props.rewindTargets.length > 0 && (
        <RewindPicker
          items={props.rewindTargets}
          onPick={(id) => { setRewindOpen(false); props.onRewind?.(id); }}
          onClose={() => setRewindOpen(false)}
        />
      )}
      {slashOpen && (
        <SlashMenu
          items={slashItems}
          activeIndex={Math.min(slashIdx, slashItems.length - 1)}
          onHover={setSlashIdx}
          onPick={pickSlash}
        />
      )}
      <div className={`cz-composer__box${disabled ? ' is-disabled' : ''}`}>
        {/* 磨砂玻璃底（单独一层） */}
        <span className="cz-composer__glass" aria-hidden="true" />
        {hasQuote && (
          <div className="cz-composer__quotes">
            {quoteItems.map(({ quote, reply, index }) => (
              <QuoteRow
                key={`${index}:${quote}`}
                quote={quote}
                reply={reply}
                disabled={!!disabled}
                onReply={(text) => props.onEditQuoteReply?.(index, text)}
                onRemove={() => props.onRemoveQuote?.(index)}
                onSend={(mode) => send(mode)}
                keepFocus={keepFocus}
              />
            ))}
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
              data-placeholder={running ? 'Enter 插话 · Ctrl+Enter 排队' : '输入 / 以使用命令'}
              onInput={(e) => afterChange(composing.current || (e.nativeEvent as InputEvent).isComposing === true)}
              onKeyDown={onKeyDown}
              onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') evalSlash(); }}
              onPaste={onPaste}
              onClick={onEditorClick}
              onMouseDown={onEditorMouseDown}
              onBlur={() => { setSlash(null); setRewindOpen(false); }}
              onCompositionStart={() => { composing.current = true; }}
              onCompositionEnd={() => { composing.current = false; afterChange(false); }}
              onDrop={(e) => e.preventDefault()}
              onDragOver={(e) => e.preventDefault()}
            />
          </div>
          {running && empty && !hasQuote ? (
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
          ) : empty && !hasQuote ? null : ( // 没有内容（空白 / 无附件 / 无引用）时不显示发送按钮，输入区自动占满空出的宽度
            <button
              type="button"
              className="cz-composer__btn cz-composer__btn--send"
              title={running ? '插话（Enter）· 排队（Ctrl+Enter）' : '发送（Enter）'}
              aria-label="发送"
              disabled={disabled}
              onMouseDown={keepFocus}
              onClick={() => send('next')}
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
        {props.footLeft && <div className="cz-composer__foot-left">{props.footLeft}</div>}
        <ModelMenu config={config} onChange={onConfigChange} disabled={disabled} ultracodeAvailable={props.ultracodeAvailable} />
        <ModeMenu mode={config.permissionMode ?? 'auto'} onChange={(m) => onConfigChange({ ...config, permissionMode: m })} disabled={disabled} />
        {props.loadUsage && <UsageMeter load={props.loadUsage} running={running} />}
      </div>
      {preview && (
        <ChipPreview anchor={preview} onClose={closePreview} previewInfo={previewInfo} previewRawUrl={previewRawUrl} />
      )}
    </div>
  );
});

/** 一段引用：左侧引用文字（单行省略），右侧是对这段的回复（可编辑，Enter 发送整条消息） */
function QuoteRow({
  quote, reply, disabled, onReply, onRemove, onSend, keepFocus,
}: {
  quote: string;
  reply: string;
  disabled: boolean;
  onReply: (text: string) => void;
  onRemove: () => void;
  onSend: (mode: QueueMode) => void;
  keepFocus: (e: React.MouseEvent) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  // 高度随内容（最多约 4 行）
  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 96)}px`;
  }, [reply]);
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend(e.ctrlKey || e.metaKey ? 'later' : 'next');
    }
  };
  return (
    <div className="cz-composer__quote">
      <Icon name="reply" size={14} className="cz-composer__quote-icon" />
      <span className="cz-composer__quote-text" title={quote}>{quote}</span>
      <textarea
        ref={ref}
        className="cz-composer__quote-reply"
        rows={1}
        value={reply}
        disabled={disabled}
        placeholder="回复这段（可留空）"
        aria-label="对这段引用的回复"
        spellCheck={false}
        onChange={(e) => onReply(e.target.value)}
        onKeyDown={onKeyDown}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
      />
      <button
        type="button"
        className="cz-composer__quote-x"
        title="移除引用"
        aria-label="移除引用"
        onMouseDown={keepFocus}
        onClick={onRemove}
      >
        <Icon name="close" size={12} />
      </button>
    </div>
  );
}
