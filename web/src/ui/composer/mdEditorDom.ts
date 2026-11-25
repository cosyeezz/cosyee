// 输入框 DOM 的 Markdown 着色与光标换算（命令式，不依赖 React，可在 jsdom 里单测）。
//
// 编辑区内容模型：「源文本 + 文件标签」。着色后 DOM 的形状固定为：
//   <span class="cz-md-line">…若干文本节点 / <span class="cz-md-xxx"> / 标签元素…（行尾带 '\n'）</span> × N
//   [<br>]            ← 仅当全文以换行结尾时的占位符（readSegments 不把它算作换行）
// 每个字符仍是原文，只是多了包装元素，所以 readSegments / serialize 的结果与着色前完全一致。
//
// 刷新流程：scanEditor（扁平文本 + 光标偏移）→ tokenize → 与现有 DOM 逐行比对，只重建不一致的行 →
// 按偏移还原光标。内容没变的行不动（保住原生撤回栈与光标），所以平时打字几乎零 DOM 写入。
import { CHIP_CLASS } from './editorDom';
import { CHIP_CHAR, MAX_HIGHLIGHT_CHARS, tokenize, type Piece } from './mdHighlight';

export const LINE_CLASS = 'cz-md-line';

const ZWSP = /​/g;

export interface ScanPoint {
  node: Node;
  offset: number;
}

export interface ScanResult {
  /** 扁平文本：文字原样，标签 → CHIP_CHAR，<br> 与块级边界 → '\n'（规则与 readSegments 一致） */
  text: string;
  /** 按出现顺序的标签元素，与 text 里的 CHIP_CHAR 一一对应 */
  chips: HTMLElement[];
  /** 与入参 points 一一对应的扁平文本偏移；不在编辑区内的点为 -1 */
  offsets: number[];
}

const isChip = (n: Node): boolean => n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains(CHIP_CLASS);

/**
 * 着色行里只剩一个 <br>（其余都是空文本）：WebKit 把整行删空时放的占位符，不是换行。
 * 当成换行会多出一行，删空后输入框仍占两行。
 */
function isPlaceholderBr(root: HTMLElement, parent: HTMLElement, br: HTMLElement): boolean {
  // 只认最后一行（后面最多还有末尾占位符 <br>），中间行的 <br> 仍按换行算
  if (parent.parentNode !== root || !parent.classList.contains(LINE_CLASS)) return false;
  const next = parent.nextSibling;
  if (next && !(next === root.lastChild && next.nodeType === Node.ELEMENT_NODE && (next as HTMLElement).tagName === 'BR')) return false;
  for (const n of Array.from(parent.childNodes)) {
    if (n === br) continue;
    if (n.nodeType !== Node.TEXT_NODE || (n.textContent ?? '').replace(ZWSP, '') !== '') return false;
  }
  return true;
}

/** 读出编辑区的扁平文本，并把若干 DOM 位置换算成扁平文本偏移。 */
export function scanEditor(root: HTMLElement, points: ScanPoint[] = []): ScanResult {
  let text = '';
  const chips: HTMLElement[] = [];
  const offsets = points.map(() => -1);
  const mark = (parent: Node, idx: number) => {
    for (let k = 0; k < points.length; k++) {
      if (offsets[k] < 0 && points[k].node === parent && points[k].offset === idx) offsets[k] = text.length;
    }
  };
  const walk = (el: HTMLElement, isRoot: boolean) => {
    const kids = Array.from(el.childNodes);
    for (let i = 0; i < kids.length; i++) {
      mark(el, i);
      const node = kids[i];
      if (node.nodeType === Node.TEXT_NODE) {
        const data = (node.textContent ?? '');
        for (let k = 0; k < points.length; k++) {
          if (offsets[k] < 0 && points[k].node === node) offsets[k] = text.length + data.slice(0, points[k].offset).replace(ZWSP, '').length;
        }
        text += data.replace(ZWSP, '');
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const child = node as HTMLElement;
      if (isChip(child)) {
        for (let k = 0; k < points.length; k++) {
          if (offsets[k] < 0 && child.contains(points[k].node)) offsets[k] = text.length;
        }
        chips.push(child);
        text += CHIP_CHAR;
        continue;
      }
      if (child.tagName === 'BR') {
        if (isRoot && child === root.lastChild) continue; // 末尾占位符
        if (isPlaceholderBr(root, el, child)) continue; // 着色行被删空后浏览器留下的占位符
        text += '\n';
        continue;
      }
      const block = child.tagName === 'DIV' || child.tagName === 'P';
      if (block && text !== '' && !text.endsWith('\n')) text += '\n';
      walk(child, false);
    }
    mark(el, kids.length);
  };
  walk(root, true);
  return { text, chips, offsets };
}

// ───────────── 光标 ─────────────

/** 扁平文本偏移 → DOM 位置（优先落在文本节点内；换行符之后的位置落到下一节点开头） */
export function locateOffset(root: HTMLElement, offset: number): ScanPoint {
  let rem = Math.max(0, offset);
  const walk = (el: Node): ScanPoint | null => {
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.nodeType === Node.TEXT_NODE) {
        const len = (c.textContent ?? '').replace(ZWSP, '').length;
        if (rem < len || (rem === len && !(c.textContent ?? '').endsWith('\n'))) return { node: c, offset: Math.min(rem, (c.textContent ?? '').length) };
        rem -= len;
      } else if (c.nodeType === Node.ELEMENT_NODE) {
        const e = c as HTMLElement;
        if (isChip(e) || e.tagName === 'BR') {
          if (rem === 0) return { node: el, offset: i };
          rem -= 1;
        } else {
          const r = walk(e);
          if (r) return r;
        }
      }
    }
    return null;
  };
  return walk(root) ?? { node: root, offset: root.childNodes.length };
}

/** 当前选区（锚点 / 焦点）的扁平文本偏移；选区不在编辑区内返回 null */
export function getSelectionOffsets(root: HTMLElement): { anchor: number; focus: number } | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.anchorNode || !sel.focusNode) return null;
  if (!root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return null;
  const { offsets } = scanEditor(root, [
    { node: sel.anchorNode, offset: sel.anchorOffset },
    { node: sel.focusNode, offset: sel.focusOffset },
  ]);
  if (offsets[0] < 0 || offsets[1] < 0) return null;
  return { anchor: offsets[0], focus: offsets[1] };
}

export function setSelectionOffsets(root: HTMLElement, anchor: number, focus: number = anchor): void {
  const sel = window.getSelection();
  if (!sel) return;
  const a = locateOffset(root, anchor);
  const f = anchor === focus ? a : locateOffset(root, focus);
  if (typeof sel.setBaseAndExtent === 'function') {
    sel.setBaseAndExtent(a.node, a.offset, f.node, f.offset);
  } else {
    const r = document.createRange();
    r.setStart(a.node, a.offset);
    r.setEnd(f.node, f.offset);
    sel.removeAllRanges();
    sel.addRange(r);
  }
}

// ───────────── 渲染 ─────────────

interface LineSpec {
  pieces: Piece[];
  chipCount: number;
  chipStart: number;
}

function pushPiece(out: Piece[], cls: string | null, text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.cls === cls) last.text += text;
  else out.push({ cls, text });
}

/** 把扁平文本着色并切成行；末尾空行不产出（由占位符 <br> 表示） */
function buildLines(text: string): LineSpec[] {
  const lines = tokenize(text);
  const out: LineSpec[] = [];
  let chipStart = 0;
  lines.forEach((l, i) => {
    const pieces: Piece[] = [];
    for (const p of l.pieces) pushPiece(pieces, p.cls, p.text);
    if (i < lines.length - 1) pushPiece(pieces, null, '\n');
    if (!pieces.length) return; // 末尾空行：靠占位符 <br> 表示
    let chipCount = 0;
    for (const p of pieces) for (const ch of p.text) if (ch === CHIP_CHAR) chipCount++;
    out.push({ pieces, chipCount, chipStart });
    chipStart += chipCount;
  });
  return out;
}

function buildLineNode(spec: LineSpec, chips: HTMLElement[]): HTMLElement {
  const line = document.createElement('span');
  line.className = LINE_CLASS;
  let ci = spec.chipStart;
  for (const p of spec.pieces) {
    const host: Node = p.cls ? line.appendChild(Object.assign(document.createElement('span'), { className: p.cls })) : line;
    const parts = p.text.split(CHIP_CHAR);
    parts.forEach((part, k) => {
      if (k > 0) host.appendChild(chips[ci++]);
      if (part) host.appendChild(document.createTextNode(part));
    });
  }
  return line;
}

/** 现有 DOM 里一行的内容（Piece 序列 + 标签元素）；形状不认识时返回 null */
function readLineNode(node: Node): { pieces: Piece[]; chips: HTMLElement[] } | null {
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as HTMLElement;
  if (el.tagName !== 'SPAN' || el.className !== LINE_CLASS) return null;
  const pieces: Piece[] = [];
  const chips: HTMLElement[] = [];
  let ok = true;
  const text = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent ?? '';
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const e = n as HTMLElement;
    if (isChip(e)) {
      chips.push(e);
      return CHIP_CHAR;
    }
    if (e.tagName !== 'SPAN') {
      ok = false;
      return '';
    }
    return Array.from(e.childNodes).map(text).join('');
  };
  for (const c of Array.from(el.childNodes)) {
    if (c.nodeType === Node.ELEMENT_NODE && !isChip(c) && (c as HTMLElement).tagName === 'SPAN') {
      pushPiece(pieces, (c as HTMLElement).className, text(c));
    } else {
      pushPiece(pieces, null, text(c));
    }
  }
  return ok ? { pieces, chips } : null;
}

function sameLine(node: Node, spec: LineSpec, chips: HTMLElement[]): boolean {
  const cur = readLineNode(node);
  if (!cur || cur.pieces.length !== spec.pieces.length || cur.chips.length !== spec.chipCount) return false;
  for (let i = 0; i < spec.pieces.length; i++) {
    if (cur.pieces[i].cls !== spec.pieces[i].cls || cur.pieces[i].text !== spec.pieces[i].text) return false;
  }
  return cur.chips.every((c, k) => c === chips[spec.chipStart + k]);
}

/**
 * 把编辑区渲染成「扁平文本 + 标签」对应的着色结构，只重建与现有 DOM 不一致的行。
 * 返回 DOM 是否有改动。文本超长时不处理（返回 false）。
 */
export function renderEditor(root: HTMLElement, text: string, chips: HTMLElement[]): boolean {
  if (text.length > MAX_HIGHLIGHT_CHARS) return false;
  const specs = buildLines(text);
  const wantTail = text.endsWith('\n');
  let changed = false;

  let existing = Array.from(root.childNodes);
  let tail: Node | null = null;
  const lastNode = existing[existing.length - 1];
  if (lastNode && lastNode.nodeType === Node.ELEMENT_NODE && (lastNode as HTMLElement).tagName === 'BR') {
    tail = lastNode;
    existing = existing.slice(0, -1);
  }

  let pre = 0;
  while (pre < specs.length && pre < existing.length && sameLine(existing[pre], specs[pre], chips)) pre++;
  let suf = 0;
  while (
    suf < specs.length - pre &&
    suf < existing.length - pre &&
    sameLine(existing[existing.length - 1 - suf], specs[specs.length - 1 - suf], chips)
  ) suf++;

  const oldMid = existing.slice(pre, existing.length - suf);
  const newSpecs = specs.slice(pre, specs.length - suf);
  if (oldMid.length || newSpecs.length) {
    changed = true;
    const frag = document.createDocumentFragment();
    for (const s of newSpecs) frag.appendChild(buildLineNode(s, chips)); // 标签元素在此被移到新行里
    const anchor = suf > 0 ? existing[existing.length - suf] : tail;
    for (const n of oldMid) if (n.parentNode === root) root.removeChild(n);
    root.insertBefore(frag, anchor && anchor.parentNode === root ? anchor : null);
  }

  const hasTail = !!tail && tail.parentNode === root;
  if (wantTail && !hasTail) {
    root.appendChild(document.createElement('br'));
    changed = true;
  } else if (!wantTail && hasTail) {
    root.removeChild(tail!);
    changed = true;
  }
  return changed;
}

/**
 * 重新着色编辑区；有变化时保持选区（按扁平文本偏移还原）。
 * 调用方负责：输入法组合期间不要调用。
 */
export function highlightEditor(root: HTMLElement): boolean {
  const sel = window.getSelection();
  const points: ScanPoint[] = [];
  const inside = !!sel && sel.rangeCount > 0 && !!sel.anchorNode && !!sel.focusNode && root.contains(sel.anchorNode) && root.contains(sel.focusNode);
  if (inside) {
    points.push({ node: sel!.anchorNode!, offset: sel!.anchorOffset }, { node: sel!.focusNode!, offset: sel!.focusOffset });
  }
  const { text, chips, offsets } = scanEditor(root, points);
  const changed = renderEditor(root, text, chips);
  if (changed && inside && offsets[0] >= 0 && offsets[1] >= 0) setSelectionOffsets(root, offsets[0], offsets[1]);
  return changed;
}

/** 用新的扁平文本整体替换内容（chips 须与 text 里的 CHIP_CHAR 一一对应），并把选区放到 sel（偏移）。 */
export function setEditorContent(root: HTMLElement, text: string, chips: HTMLElement[], sel?: { anchor: number; focus?: number }): void {
  if (text.length > MAX_HIGHLIGHT_CHARS) {
    // 超长文本不着色：退回朴素的单文本节点（仍保证标签与光标正确）
    root.textContent = '';
    let ci = 0;
    text.split(CHIP_CHAR).forEach((part, k) => {
      if (k > 0) root.appendChild(chips[ci++]);
      if (part) root.appendChild(document.createTextNode(part));
    });
  } else {
    renderEditor(root, text, chips);
  }
  if (sel) setSelectionOffsets(root, sel.anchor, sel.focus ?? sel.anchor);
}

/** 光标之前的最后一个字符（跨节点）；文档开头返回 null，标签返回 CHIP_CHAR，<br> 返回 '\n' */
export function charBeforeNode(root: HTMLElement, node: Node): string | null {
  const lastChar = (n: Node): string | null => {
    if (n.nodeType === Node.TEXT_NODE) {
      const d = n.textContent ?? '';
      return d ? d[d.length - 1] : null;
    }
    if (n.nodeType !== Node.ELEMENT_NODE) return null;
    const e = n as HTMLElement;
    if (isChip(e)) return CHIP_CHAR;
    if (e.tagName === 'BR') return '\n';
    for (let c = e.lastChild; c; c = c.previousSibling) {
      const r = lastChar(c);
      if (r !== null) return r;
    }
    return null;
  };
  for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
    for (let p = n.previousSibling; p; p = p.previousSibling) {
      const r = lastChar(p);
      if (r !== null) return r;
    }
  }
  return null;
}

/**
 * 在扁平文本上做一次替换（[from, to) → insert），落在被删范围里的标签一并删除；光标放到 caret。
 * 用于列表续写 / 退出等需要「自己改文本」的编辑。
 */
export function applyTextEdit(root: HTMLElement, edit: { from: number; to: number; insert: string; caret: number }): void {
  const { text, chips } = scanEditor(root);
  const before = text.slice(0, edit.from).split(CHIP_CHAR).length - 1;
  const removed = text.slice(edit.from, edit.to).split(CHIP_CHAR).length - 1;
  const kept = [...chips.slice(0, before), ...chips.slice(before + removed)];
  const next = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  setEditorContent(root, next, kept, { anchor: edit.caret });
}
