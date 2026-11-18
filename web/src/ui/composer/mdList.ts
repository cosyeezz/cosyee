// 输入框里 Markdown 列表的纯逻辑：识别列表项、换行续写 / 退出、Tab 缩进。
// 所有函数都工作在「扁平文本」上（标签在文本里占 1 个字符 ￼），不碰 DOM，可单测。

export interface ListMatch {
  /** 行首缩进 */
  indent: string;
  /** 标记本身：`-` `*` `+` `12.` `3)` */
  marker: string;
  ordered: boolean;
  /** 有序列表的序号（无序为 0） */
  num: number;
  /** 有序列表的分隔符 `.` 或 `)` */
  delim: string;
  /** 任务列表复选框原文（含其后的空白，如 `[ ] `），没有则为 null */
  checkbox: string | null;
  /** 前缀（缩进 + 标记 + 空白 + 复选框）的长度，内容从这里开始 */
  prefixLen: number;
}

const LIST_RE = /^([ \t]*)([-*+]|(\d{1,9})([.)]))([ \t]+)(\[[ xX]\][ \t]+)?/;

/** 一行是不是列表项（`- ` `* ` `+ ` `1. ` `1) `，可带 `[ ] ` 复选框）。 */
export function matchListItem(line: string): ListMatch | null {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  const ordered = m[3] !== undefined;
  return {
    indent: m[1],
    marker: m[2],
    ordered,
    num: ordered ? Number(m[3]) : 0,
    delim: ordered ? m[4] : '',
    checkbox: m[6] ?? null,
    prefixLen: m[0].length,
  };
}

/** 下一项的前缀：序号 +1，保持缩进，任务列表的新项是未勾选 */
export function nextItemPrefix(m: ListMatch): string {
  const mark = m.ordered ? `${m.num + 1}${m.delim}` : m.marker;
  return `${m.indent}${mark} ${m.checkbox ? '[ ] ' : ''}`;
}

/** 文本里的一次替换：把 [from, to) 换成 insert，光标放到 caret（扁平文本的新偏移） */
export interface TextEdit {
  from: number;
  to: number;
  insert: string;
  caret: number;
}

function lineBounds(text: string, pos: number): { start: number; end: number } {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  const nl = text.indexOf('\n', pos);
  return { start, end: nl === -1 ? text.length : nl };
}

/**
 * 在 caret（折叠光标）处换行时的列表处理：
 *  - 光标在列表项内容里：插入 `\n` + 下一项前缀（有序序号 +1），光标放在新前缀之后；
 *  - 当前项是空项（前缀后没有内容）：删掉整行的前缀，退出列表（不换行）；
 *  - 不是列表项 / 光标落在前缀里 / 在代码块里：返回 null，交给浏览器默认换行。
 */
export function listNewlineEdit(text: string, caret: number, inFence = false): TextEdit | null {
  if (inFence) return null;
  const { start, end } = lineBounds(text, caret);
  const line = text.slice(start, end);
  const m = matchListItem(line);
  if (!m) return null;
  if (caret - start < m.prefixLen) return null;
  if (line.slice(m.prefixLen).trim() === '') {
    return { from: start, to: end, insert: '', caret: start };
  }
  const ins = '\n' + nextItemPrefix(m);
  return { from: caret, to: caret, insert: ins, caret: caret + ins.length };
}

/** 一级缩进的宽度：无序列表 2 格；有序列表取「标记 + 空格」的宽度，这样子项才能被 Markdown 识别成嵌套 */
function indentUnit(m: ListMatch): number {
  return m.ordered ? m.marker.length + 1 : 2;
}

export interface IndentResult {
  text: string;
  start: number;
  end: number;
}

/**
 * Tab / Shift+Tab：对选区覆盖到的每个列表项行缩进 / 反缩进。没有任何列表项行时返回 null（交给默认行为）。
 */
export function listIndentEdit(text: string, selStart: number, selEnd: number, outdent: boolean, inFence: (line: number) => boolean = () => false): IndentResult | null {
  const first = lineBounds(text, selStart).start;
  const lastPos = selEnd > selStart && text[selEnd - 1] === '\n' ? selEnd - 1 : selEnd; // 选区正好止于换行之后，不含下一行
  const last = lineBounds(text, Math.max(lastPos, selStart)).start;
  const edits: { ls: number; replaceLen: number; ins: string }[] = [];
  let sawList = false;
  let lineNo = text.slice(0, first).split('\n').length - 1;
  for (let ls = first; ls <= last; lineNo++) {
    const { end } = lineBounds(text, ls);
    const line = text.slice(ls, end);
    const m = inFence(lineNo) ? null : matchListItem(line);
    if (m) {
      sawList = true;
      const unit = indentUnit(m);
      if (!outdent) edits.push({ ls, replaceLen: 0, ins: ' '.repeat(unit) });
      else if (line.startsWith('\t')) edits.push({ ls, replaceLen: 1, ins: '' });
      else {
        const lead = /^ */.exec(line)![0].length;
        const n = Math.min(lead, unit);
        if (n > 0) edits.push({ ls, replaceLen: n, ins: '' });
      }
    }
    ls = end + 1;
  }
  if (!sawList) return null;
  if (!edits.length) return { text, start: selStart, end: selEnd }; // 已经没有缩进可去：吞掉按键，免得焦点跳走
  let out = '';
  let cursor = 0;
  for (const ed of edits) {
    out += text.slice(cursor, ed.ls) + ed.ins;
    cursor = ed.ls + ed.replaceLen;
  }
  out += text.slice(cursor);
  const map = (p: number) => {
    let r = p;
    for (const ed of edits) {
      if (p <= ed.ls) continue;
      r += ed.ins.length - Math.min(p - ed.ls, ed.replaceLen);
    }
    return r;
  };
  return { text: out, start: map(selStart), end: map(selEnd) };
}
