// 轻量级 ANSI 转义序列与终端行缓冲解析器（不依赖 xterm）。
// 支持：
// - SGR：粗体/暗淡/斜体/下划线/反色/删除线、16 色（映射到主题 CSS 变量）、256 色、24 位真彩色
// - \r（回车回到行首覆盖，用于进度条）与 \b（退格）
// - OSC 8 超链接（\x1b]8;;url\x07text\x1b]8;;\x07）与普通 http(s) URL 自动识别
// - 剥离其他 CSI / OSC / 单字节 ESC 控制序列
// - 增量解析（AnsiParser）：长输出流式到达时只解析新增分片，避免 O(N^2) 重算

export interface AnsiStyle {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
  link?: string;
}

export interface AnsiSpan {
  text: string;
  style: AnsiStyle;
  /** 自动识别或 OSC 8 提供的链接地址 */
  href?: string;
}

export type AnsiLine = AnsiSpan[];

/** 16 色映射到 CSS 变量，亮暗主题各自在 CSS 中定义 */
const ANSI_16_VARS: readonly string[] = [
  'var(--term-c0)',
  'var(--term-c1)',
  'var(--term-c2)',
  'var(--term-c3)',
  'var(--term-c4)',
  'var(--term-c5)',
  'var(--term-c6)',
  'var(--term-c7)',
  'var(--term-c8)',
  'var(--term-c9)',
  'var(--term-c10)',
  'var(--term-c11)',
  'var(--term-c12)',
  'var(--term-c13)',
  'var(--term-c14)',
  'var(--term-c15)',
];

/** 将 xterm 256 色索引转换为 CSS 颜色值 */
export function ansi256Color(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
  if (index < 16) return ANSI_16_VARS[index];
  if (index < 232) {
    const n = index - 16;
    const b = n % 6;
    const g = Math.floor(n / 6) % 6;
    const r = Math.floor(n / 36);
    const levels = [0, 95, 135, 175, 215, 255];
    return `rgb(${levels[r]}, ${levels[g]}, ${levels[b]})`;
  }
  const v = 8 + (index - 232) * 10;
  return `rgb(${v}, ${v}, ${v})`;
}

function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(255, Math.round(n)));
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.inverse === b.inverse &&
    a.strike === b.strike &&
    a.link === b.link
  );
}

function cloneStyle(s: AnsiStyle): AnsiStyle {
  const out: AnsiStyle = {};
  if (s.fg !== undefined) out.fg = s.fg;
  if (s.bg !== undefined) out.bg = s.bg;
  if (s.bold) out.bold = true;
  if (s.dim) out.dim = true;
  if (s.italic) out.italic = true;
  if (s.underline) out.underline = true;
  if (s.inverse) out.inverse = true;
  if (s.strike) out.strike = true;
  if (s.link !== undefined) out.link = s.link;
  return out;
}

function applySgr(style: AnsiStyle, rawParams: string): AnsiStyle {
  const next = cloneStyle(style);
  if (!rawParams) {
    return next.link ? { link: next.link } : {};
  }
  // 兼容分号与冒号子参数（如 38:2::255:128:0）
  const parts = rawParams.split(';');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.includes(':')) {
      const sub = part.split(':').map((x) => (x === '' ? 0 : Number(x)));
      const head = sub[0];
      if ((head === 38 || head === 48) && sub[1] === 5 && sub.length >= 3) {
        const c = ansi256Color(sub[2]!);
        if (c) {
          if (head === 38) next.fg = c;
          else next.bg = c;
        }
      } else if ((head === 38 || head === 48) && sub[1] === 2) {
        // 38:2:cs:r:g:b 或 38:2:r:g:b
        const off = sub.length >= 6 ? 3 : 2;
        if (sub.length >= off + 3) {
          const c = `rgb(${clampByte(sub[off]!)}, ${clampByte(sub[off + 1]!)}, ${clampByte(sub[off + 2]!)})`;
          if (head === 38) next.fg = c;
          else next.bg = c;
        }
      }
      continue;
    }

    const code = part === '' ? 0 : Number(part);
    if (!Number.isFinite(code)) continue;

    if (code === 0) {
      const link = next.link;
      for (const k of Object.keys(next) as (keyof AnsiStyle)[]) delete next[k];
      if (link !== undefined) next.link = link;
    } else if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 7) {
      next.inverse = true;
    } else if (code === 9) {
      next.strike = true;
    } else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) {
      delete next.italic;
    } else if (code === 24) {
      delete next.underline;
    } else if (code === 27) {
      delete next.inverse;
    } else if (code === 29) {
      delete next.strike;
    } else if (code >= 30 && code <= 37) {
      next.fg = ANSI_16_VARS[code - 30];
    } else if (code === 39) {
      delete next.fg;
    } else if (code >= 40 && code <= 47) {
      next.bg = ANSI_16_VARS[code - 40];
    } else if (code === 49) {
      delete next.bg;
    } else if (code >= 90 && code <= 97) {
      next.fg = ANSI_16_VARS[code - 90 + 8];
    } else if (code >= 100 && code <= 107) {
      next.bg = ANSI_16_VARS[code - 100 + 8];
    } else if (code === 38 || code === 48) {
      const mode = Number(parts[i + 1]);
      if (mode === 5 && i + 2 < parts.length) {
        const c = ansi256Color(Number(parts[i + 2]));
        if (c) {
          if (code === 38) next.fg = c;
          else next.bg = c;
        }
        i += 2;
      } else if (mode === 2 && i + 4 < parts.length) {
        const r = clampByte(Number(parts[i + 2]));
        const g = clampByte(Number(parts[i + 3]));
        const b = clampByte(Number(parts[i + 4]));
        const c = `rgb(${r}, ${g}, ${b})`;
        if (code === 38) next.fg = c;
        else next.bg = c;
        i += 4;
      }
    }
  }
  return next;
}

const URL_RE = /https?:\/\/[^\s<>"'`\u0000-\u001f]+/g;

function trimTrailingPunct(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (ch === '.' || ch === ',' || ch === ';' || ch === ':' || ch === '!' || ch === '?') {
      end--;
    } else if (ch === ')') {
      const opens = (url.slice(0, end).match(/\(/g) ?? []).length;
      const closes = (url.slice(0, end).match(/\)/g) ?? []).length;
      if (closes > opens) end--;
      else break;
    } else if (ch === ']') {
      const opens = (url.slice(0, end).match(/\[/g) ?? []).length;
      const closes = (url.slice(0, end).match(/\]/g) ?? []).length;
      if (closes > opens) end--;
      else break;
    } else {
      break;
    }
  }
  return url.slice(0, end);
}

/** 把纯文本 span 中内嵌的 http(s) URL 拆出带 href 的 span */
function splitUrls(span: AnsiSpan): AnsiSpan[] {
  if (span.style.link) {
    return [{ ...span, href: span.style.link }];
  }
  if (!span.text.includes('http://') && !span.text.includes('https://')) {
    return [span];
  }
  URL_RE.lastIndex = 0;
  const out: AnsiSpan[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(span.text)) !== null) {
    const raw = m[0];
    const clean = trimTrailingPunct(raw);
    if (!clean) continue;
    const start = m.index;
    if (start > last) {
      out.push({ text: span.text.slice(last, start), style: span.style });
    }
    out.push({ text: clean, style: span.style, href: clean });
    last = start + clean.length;
    URL_RE.lastIndex = last;
  }
  if (last === 0) return [span];
  if (last < span.text.length) {
    out.push({ text: span.text.slice(last), style: span.style });
  }
  return out;
}

interface Cell {
  ch: string;
  style: AnsiStyle;
}

function cellsToLine(cells: Cell[]): AnsiLine {
  if (cells.length === 0) return [];
  const merged: AnsiSpan[] = [];
  let curText = cells[0]!.ch;
  let curStyle = cells[0]!.style;
  for (let i = 1; i < cells.length; i++) {
    const c = cells[i]!;
    if (sameStyle(curStyle, c.style)) {
      curText += c.ch;
    } else {
      merged.push({ text: curText, style: curStyle });
      curText = c.ch;
      curStyle = c.style;
    }
  }
  merged.push({ text: curText, style: curStyle });

  const out: AnsiSpan[] = [];
  for (const s of merged) {
    const parts = splitUrls(s);
    for (const p of parts) out.push(p);
  }
  return out;
}

type ParserMode = 'text' | 'esc' | 'csi' | 'osc' | 'osc_esc';

export interface AnsiParser {
  /** 追加增量文本并更新内部行缓冲 */
  append: (chunk: string) => void;
  /** 获取已解析的所有行（引用稳定：未变化的历史行复用原数组） */
  getLines: () => readonly AnsiLine[];
  /** 重置状态 */
  reset: () => void;
}

export function createAnsiParser(): AnsiParser {
  let style: AnsiStyle = {};
  let mode: ParserMode = 'text';
  let seqBuf = '';
  let lines: AnsiLine[] = [];
  let curCells: Cell[] = [];
  let cursor = 0;
  let dirtyCur = true;
  let cachedCurLine: AnsiLine = [];
  let cachedSnapshot: readonly AnsiLine[] | null = null;

  const commitLine = () => {
    lines.push(cellsToLine(curCells));
    curCells = [];
    cursor = 0;
    dirtyCur = true;
    cachedSnapshot = null;
  };

  const writeChar = (ch: string) => {
    if (cursor < curCells.length) {
      curCells[cursor] = { ch, style };
    } else {
      while (curCells.length < cursor) {
        curCells.push({ ch: ' ', style: {} });
      }
      curCells.push({ ch, style });
    }
    cursor++;
    dirtyCur = true;
    cachedSnapshot = null;
  };

  const handleOsc = (body: string) => {
    // OSC 8: 8;params;uri
    if (body.startsWith('8;')) {
      const second = body.indexOf(';', 2);
      if (second !== -1) {
        const uri = body.slice(second + 1).trim();
        const next = cloneStyle(style);
        if (uri && /^https?:\/\//i.test(uri)) {
          next.link = uri;
        } else {
          delete next.link;
        }
        style = next;
      }
    }
  };

  const handleCsi = (params: string, finalCh: string) => {
    if (finalCh === 'm') {
      style = applySgr(style, params);
    } else if (finalCh === 'K') {
      // EL (Erase in Line): 0 或空 = 清除光标到行尾，1 = 清除行首到光标，2 = 清除整行
      const n = params === '' ? 0 : Number(params);
      if (n === 0) {
        if (cursor < curCells.length) {
          curCells.length = cursor;
          dirtyCur = true;
          cachedSnapshot = null;
        }
      } else if (n === 2) {
        curCells = [];
        cursor = 0;
        dirtyCur = true;
        cachedSnapshot = null;
      }
    } else if (finalCh === 'G') {
      // CHA (Cursor Horizontal Absolute): 1-based column
      const col = Math.max(1, Number(params) || 1);
      cursor = col - 1;
    }
    // 其他 CSI 序列安全剥离
  };

  const append = (chunk: string) => {
    if (!chunk) return;
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      const code = ch.charCodeAt(0);

      if (mode === 'text') {
        if (code === 0x1b) {
          mode = 'esc';
          seqBuf = '';
        } else if (ch === '\n') {
          commitLine();
        } else if (ch === '\r') {
          cursor = 0;
        } else if (ch === '\b') {
          if (cursor > 0) cursor--;
        } else if (ch === '\t') {
          const spaces = 4 - (cursor % 4);
          for (let s = 0; s < spaces; s++) writeChar(' ');
        } else if (code < 0x20 || code === 0x7f) {
          // 忽略其他不可见控制字符（如 BEL \x07）
        } else {
          // 处理 UTF-16 代理对（emoji / 扩展汉字）
          if (code >= 0xd800 && code <= 0xdbff && i + 1 < chunk.length) {
            const nextCode = chunk.charCodeAt(i + 1);
            if (nextCode >= 0xdc00 && nextCode <= 0xdfff) {
              writeChar(ch + chunk[i + 1]!);
              i++;
              continue;
            }
          }
          writeChar(ch);
        }
      } else if (mode === 'esc') {
        if (ch === '[') {
          mode = 'csi';
          seqBuf = '';
        } else if (ch === ']') {
          mode = 'osc';
          seqBuf = '';
        } else if (ch === '(' || ch === ')' || ch === '*' || ch === '+') {
          // 字符集选择 ESC ( B 等：跳过下一个字节
          i++;
          mode = 'text';
        } else {
          mode = 'text';
        }
      } else if (mode === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          handleCsi(seqBuf, ch);
          mode = 'text';
          seqBuf = '';
        } else if (seqBuf.length > 64) {
          mode = 'text';
          seqBuf = '';
        } else {
          seqBuf += ch;
        }
      } else if (mode === 'osc') {
        if (code === 0x07) {
          handleOsc(seqBuf);
          mode = 'text';
          seqBuf = '';
        } else if (code === 0x1b) {
          mode = 'osc_esc';
        } else if (seqBuf.length > 2048) {
          mode = 'text';
          seqBuf = '';
        } else {
          seqBuf += ch;
        }
      } else if (mode === 'osc_esc') {
        if (ch === '\\') {
          handleOsc(seqBuf);
          mode = 'text';
          seqBuf = '';
        } else {
          mode = 'text';
          seqBuf = '';
        }
      }
    }
  };

  const getLines = (): readonly AnsiLine[] => {
    if (dirtyCur) {
      cachedCurLine = cellsToLine(curCells);
      dirtyCur = false;
    }
    if (!cachedSnapshot) {
      if (lines.length === 0 && cachedCurLine.length === 0) {
        cachedSnapshot = [];
      } else if (cachedCurLine.length > 0) {
        cachedSnapshot = [...lines, cachedCurLine];
      } else {
        // 末尾有换行时，不额外多渲染一个空尾行（除非只有空行）
        cachedSnapshot = [...lines];
      }
    }
    return cachedSnapshot;
  };

  const reset = () => {
    style = {};
    mode = 'text';
    seqBuf = '';
    lines = [];
    curCells = [];
    cursor = 0;
    dirtyCur = true;
    cachedCurLine = [];
    cachedSnapshot = null;
  };

  return { append, getLines, reset };
}

/** 一次性解析完整文本为行数组 */
export function parseAnsi(text: string): readonly AnsiLine[] {
  const p = createAnsiParser();
  p.append(text);
  return p.getLines();
}

/** 将 ANSI 文本剥离转义并应用 \r / \b，得到适合复制的纯文本 */
export function stripAnsi(text: string): string {
  const lines = parseAnsi(text);
  return lines.map((line) => line.map((s) => s.text).join('')).join('\n');
}
