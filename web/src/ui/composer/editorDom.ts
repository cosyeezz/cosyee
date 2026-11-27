// 编辑区（contenteditable）的 DOM 读写辅助。不依赖 React / Icon，可在 jsdom 里单测。
import { labelChips, labelOf, type ChipKind, type Segment } from '../../core/composer';

export const CHIP_CLASS = 'cz-chip';
const LABEL_CLASS = 'cz-chip__label';

export interface ChipData {
  kind: ChipKind;
  path: string;
  label: string;
  /** 预览令牌（来自选择窗口）；手工构造的标签可以没有 */
  token?: string;
}

/** 「上传中」占位标签：也是 .cz-chip（着色时和标签一样整体搬动），但不算内容、不编号、不发送 */
export const PENDING_ATTR = 'data-pending';
export const isPendingChip = (el: Element): boolean => el.hasAttribute(PENDING_ATTR);

export function readChip(el: HTMLElement): ChipData {
  const kind = (el.dataset.kind as ChipKind) || 'file';
  return { kind, path: el.dataset.path ?? '', label: el.dataset.label ?? '', token: el.dataset.token || undefined };
}

/** 读取编辑区内容为 Segment[]：文本节点、<br>、块级 <div>/<p>（换行）、标签元素 */
export function readSegments(root: HTMLElement): Segment[] {
  const out: Segment[] = [];
  let endsWithNewline = true; // 开头视为已换行，块级元素开头不再补换行
  const pushText = (s: string) => {
    if (!s) return;
    const last = out[out.length - 1];
    if (last && last.t === 'text') last.text += s;
    else out.push({ t: 'text', text: s });
    endsWithNewline = s.endsWith('\n');
  };
  const walk = (node: Node, isRootChild: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText((node.textContent ?? '').replace(/​/g, ''));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.classList.contains(CHIP_CLASS)) {
      if (isPendingChip(el)) return;
      const c = readChip(el);
      out.push({ t: 'chip', kind: c.kind, path: c.path, label: c.label });
      endsWithNewline = false;
      return;
    }
    if (el.tagName === 'BR') {
      // 编辑区最后一个子节点的 <br> 是浏览器放的占位符，不算换行
      if (isRootChild && el === root.lastChild) return;
      pushText('\n');
      return;
    }
    const block = el.tagName === 'DIV' || el.tagName === 'P';
    if (block && !endsWithNewline) pushText('\n');
    for (const child of Array.from(el.childNodes)) walk(child, false);
  };
  for (const child of Array.from(root.childNodes)) walk(child, true);
  return out;
}

/** 内容是否为空（没有标签，且文字全是空白） */
export function isEditorEmpty(root: HTMLElement): boolean {
  return readSegments(root).every((s) => s.t === 'text' && s.text.trim() === '');
}

/** 按文档顺序重新给标签编号并更新显示。返回是否有变化 */
export function relabelChips(root: HTMLElement): void {
  const els = Array.from(root.querySelectorAll<HTMLElement>(`.${CHIP_CLASS}:not([${PENDING_ATTR}])`));
  const segs = labelChips(
    els.map((el): Segment => {
      const c = readChip(el);
      return { t: 'chip', kind: c.kind, path: c.path, label: '' };
    }),
  );
  els.forEach((el, i) => {
    const seg = segs[i];
    if (seg.t !== 'chip') return;
    if (el.dataset.label !== seg.label) {
      el.dataset.label = seg.label;
      const span = el.querySelector(`.${LABEL_CLASS}`);
      if (span) span.textContent = seg.label;
    }
  });
}

/** 光标前一个字符（仅文本节点内），用于决定是否补空格 */
function charBefore(range: Range): string {
  const n = range.startContainer;
  if (n.nodeType === Node.TEXT_NODE && range.startOffset > 0) return (n.textContent ?? '')[range.startOffset - 1] ?? '';
  const prev = n.nodeType === Node.ELEMENT_NODE ? n.childNodes[range.startOffset - 1] : null;
  if (prev && prev.nodeType === Node.TEXT_NODE) return (prev.textContent ?? '').slice(-1);
  return '';
}

/**
 * 在保存的光标位置插入一组节点（标签 + 分隔空格），然后把光标放到最后一个节点之后。
 * saved 为空或已不在编辑区内时，插到末尾。选区非折叠时先删除选中内容。
 * 光标前紧贴非空白字符时，先补一个空格。
 */
export function insertNodesAt(root: HTMLElement, saved: Range | null, nodes: Node[]): void {
  if (!nodes.length) return;
  let range: Range;
  if (saved && root.contains(saved.commonAncestorContainer)) {
    range = saved.cloneRange();
  } else {
    range = document.createRange();
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.deleteContents();
  const frag = document.createDocumentFragment();
  const before = charBefore(range);
  if (before && !/\s/.test(before)) frag.appendChild(document.createTextNode(' '));
  for (const n of nodes) frag.appendChild(n);
  const last = nodes[nodes.length - 1];
  range.insertNode(frag);
  const sel = window.getSelection();
  if (sel) {
    const r = document.createRange();
    r.setStartAfter(last);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

export { labelOf };
