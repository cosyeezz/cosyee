// 输入框里的 Markdown 实时着色：逐行 tokenizer（纯函数，不碰 DOM）。
// 输入是「扁平文本」（文件标签在其中占 1 个字符 CHIP_CHAR），输出每行的 Piece 序列：
// 所有 Piece 的 text 依次拼起来 === 原文（逐字不变，标记符号保留，只是带上 class），
// 所以着色不会改变序列化结果。
import { matchListItem } from './mdList';

/** 标签在扁平文本里的占位字符 */
export const CHIP_CHAR = '￼';

/** 一段带样式的文字；cls 为 null 表示普通文字 */
export interface Piece {
  cls: string | null;
  text: string;
}

export interface MdLine {
  pieces: Piece[];
  /** 这一行是否在围栏代码块里（含围栏行本身） */
  fence: boolean;
}

/** 超过这个长度的单行不做行内着色（避免病态输入拖慢） */
const MAX_INLINE_LINE = 3000;
/** 超过这个总长度整体不着色 */
export const MAX_HIGHLIGHT_CHARS = 60000;

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^( {0,3})(#{1,6})([ \t]+|$)/;
const QUOTE = /^( {0,3})((?:>[ \t]?)+)/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

const MARK = 'cz-md-mark';

function cat(base: string | null, extra: string): string {
  return base ? `${base} ${extra}` : extra;
}

function push(out: Piece[], cls: string | null, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.cls === cls) last.text += text;
  else out.push({ cls, text });
}

const isWs = (c: string | undefined) => c === undefined || c === '' || /\s/.test(c);
const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** 在 s 里从 from 起找长度恰为 n 的 ch 连续串（不能是更长连续串的一部分）。返回起点，没有返回 -1 */
function findCloser(s: string, from: number, ch: string, n: number): number {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '`') {
      // 行内代码里的 * _ 不算：跳过整段代码
      let k = j;
      while (s[k] === '`') k++;
      const close = s.indexOf(s.slice(j, k), k);
      if (close !== -1) { j = close + (k - j) - 1; continue; }
      j = k - 1;
      continue;
    }
    if (c !== ch) continue;
    let k = j;
    while (s[k] === ch) k++;
    if (k - j === n && !isWs(s[j - 1]) && (ch !== '_' || !isWord(s[k]))) return j;
    j = k - 1;
  }
  return -1;
}

/** 行内着色：`code`、**粗体**、*斜体*、~~删除线~~、[链接](url)、裸 URL */
function inline(s: string, base: string | null, out: Piece[]): void {
  if (s.length > MAX_INLINE_LINE) {
    push(out, base, s);
    return;
  }
  let plainFrom = 0;
  let i = 0;
  const flush = (to: number) => {
    if (to > plainFrom) push(out, base, s.slice(plainFrom, to));
  };
  const mark = (text: string) => push(out, cat(base, MARK), text);
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      let k = i;
      while (s[k] === '`') k++;
      const fence = s.slice(i, k);
      const close = s.indexOf(fence, k);
      if (close !== -1 && s[close + fence.length] !== '`') {
        flush(i);
        mark(fence);
        push(out, cat(base, 'cz-md-icode'), s.slice(k, close));
        mark(fence);
        i = plainFrom = close + fence.length;
        continue;
      }
      i = k;
      continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const bang = c === '!';
      const m = /^\[([^\]\n]*)\]\(([^)\n]*)\)/.exec(s.slice(i + (bang ? 1 : 0)));
      if (m) {
        flush(i);
        mark((bang ? '![' : '['));
        push(out, cat(base, 'cz-md-link'), m[1]);
        mark('](');
        push(out, cat(base, 'cz-md-url'), m[2]);
        mark(')');
        i = plainFrom = i + (bang ? 1 : 0) + m[0].length;
        continue;
      }
    }
    if (c === 'h' && /^https?:\/\//.test(s.slice(i, i + 8)) && !/[A-Za-z0-9]/.test(s[i - 1] ?? '')) {
      const m = /^https?:\/\/[^\s<>￼]+/.exec(s.slice(i))!;
      const url = m[0].replace(/[.,;:!?)\]}，。；：！？）]+$/, '');
      if (url.length > 8) {
        flush(i);
        push(out, cat(base, 'cz-md-link'), url);
        i = plainFrom = i + url.length;
        continue;
      }
    }
    if (c === '~' && s[i + 1] === '~' && s[i + 2] !== '~') {
      const close = findCloser(s, i + 2, '~', 2);
      if (close !== -1 && close > i + 2) {
        flush(i);
        mark('~~');
        inline(s.slice(i + 2, close), cat(base, 'cz-md-del'), out);
        mark('~~');
        i = plainFrom = close + 2;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      let k = i;
      while (s[k] === c) k++;
      const run = k - i;
      const n = Math.min(run, 3);
      const open = i + (run - n); // 多出来的前导符号当普通字符
      const after = s[k];
      const before = s[i - 1];
      const canOpen = !isWs(after) && (c === '*' || !isWord(before));
      if (canOpen && run <= 3) {
        const close = findCloser(s, k, c, n);
        if (close !== -1 && close > k) {
          flush(open);
          const delim = c.repeat(n);
          const cls = n === 3 ? 'cz-md-b cz-md-i' : n === 2 ? 'cz-md-b' : 'cz-md-i';
          mark(delim);
          inline(s.slice(k, close), cat(base, cls), out);
          mark(delim);
          i = plainFrom = close + n;
          continue;
        }
      }
      i = k;
      continue;
    }
    i++;
  }
  flush(s.length);
}

/**
 * 给整段扁平文本着色，按 '\n' 切成行。
 * 返回的行数 = text.split('\n').length；每行的 pieces 拼接 === 该行原文（不含换行符）。
 */
export function tokenize(text: string): MdLine[] {
  const rawLines = text.split('\n');
  const out: MdLine[] = [];
  let fence: { ch: string; len: number } | null = null;
  for (const line of rawLines) {
    const pieces: Piece[] = [];
    let inFence = false;
    if (fence) {
      inFence = true;
      const close = new RegExp(`^ {0,3}${fence.ch === '`' ? '`' : '~'}{${fence.len},}[ \\t]*$`);
      if (close.test(line)) {
        push(pieces, cat(null, `${MARK} cz-md-fence`), line);
        fence = null;
      } else {
        push(pieces, 'cz-md-code', line);
      }
      out.push({ pieces, fence: inFence });
      continue;
    }
    const fo = FENCE_OPEN.exec(line);
    if (fo && !(fo[2][0] === '`' && fo[3].includes('`'))) {
      fence = { ch: fo[2][0], len: fo[2].length };
      push(pieces, `${MARK} cz-md-fence`, fo[1] + fo[2]);
      push(pieces, 'cz-md-fence-info', fo[3]);
      out.push({ pieces, fence: true });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      push(pieces, null, h[1]);
      push(pieces, MARK, h[2] + h[3]);
      inline(line.slice(h[0].length), `cz-md-h cz-md-h${h[2].length}`, pieces);
    } else if (HR.test(line)) {
      push(pieces, `${MARK} cz-md-hr`, line);
    } else {
      const q = QUOTE.exec(line);
      if (q) {
        push(pieces, null, q[1]);
        push(pieces, MARK, q[2]);
        // 引用里还可以套列表 / 行内样式
        const rest = line.slice(q[0].length);
        const lm = matchListItem(rest);
        if (lm) {
          push(pieces, 'cz-md-quote', rest.slice(0, lm.prefixLen));
          inline(rest.slice(lm.prefixLen), 'cz-md-quote', pieces);
        } else {
          inline(rest, 'cz-md-quote', pieces);
        }
      } else {
        const lm = matchListItem(line);
        if (lm) {
          const prefix = line.slice(0, lm.prefixLen);
          const body = /^([ \t]*)(\S+)([ \t]+)(\[[ xX]\][ \t]+)?/.exec(prefix)!;
          push(pieces, null, body[1]);
          push(pieces, `${MARK} cz-md-bullet`, body[2] + body[3]);
          if (body[4]) push(pieces, `${MARK} cz-md-task`, body[4]);
          inline(line.slice(lm.prefixLen), null, pieces);
        } else {
          inline(line, null, pieces);
        }
      }
    }
    out.push({ pieces, fence: false });
  }
  return out;
}
