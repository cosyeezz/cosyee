// 朗读用的文本处理：把交付文字（Markdown）清洗成适合念出来的纯文本，再切成一句句的小段。
// 分段是为了「第一句合成好就开始播」：整篇一起合成，长回答要等好几秒才出声。

/** 单段最长字符数：太长的句子在逗号等处再切，避免一段合成太久 */
const MAX_SEG = 120;
/** 太短的句子并到下一句（「好的。」单独一段会显得断断续续） */
const MIN_SEG = 8;

const CODE_SKIP = '代码略。';
const TABLE_SKIP = '表格略。';

/** 路径只念最后一段（文件名）：F:/Cosyee/server/src/http.ts → http.ts */
function shortPath(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 行内格式：链接、图片、代码、强调、HTML 标签、裸 URL、长路径 */
function inline(s: string): string {
  return (
    s
      // 图片整个去掉
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      // 链接只留文字；文字本身是路径时只念文件名
      .replace(/\[([^\]]*)\]\([^)]*\)/g, (_, t: string) => (/[\\/]/.test(t) && !/\s/.test(t) ? shortPath(t) : t))
      // 行内代码：短的念出来（多是文件名、命令），长的略过
      .replace(/`([^`]+)`/g, (_, c: string) => (c.length > 40 ? CODE_SKIP : /[\\/]/.test(c) && !/\s/.test(c) ? shortPath(c) : c))
      .replace(/<[^>\n]+>/g, '')
      .replace(/https?:\/\/\S+/g, '链接')
      // 裸路径（至少两级目录）
      .replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@-]+){2,}[\\/]?/g, (p) => shortPath(p))
      // 强调符号：** __ ~~ 成对去掉；单个 * _ 只去掉包着词的那种，避免误伤 snake_case
      .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
  );
}

/** Markdown → 朗读文本。段落之间用换行分隔（分句时当作句子边界）。 */
export function speechText(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let fence: string | null = null;
  let inTable = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const f = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (f && f[1]![0] === fence[0] && f[1]!.length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1]!;
      out.push(CODE_SKIP);
      continue;
    }
    if (/^\s*\|/.test(line)) {
      if (!inTable) out.push(TABLE_SKIP);
      inTable = true;
      continue;
    }
    inTable = false;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) continue; // 分隔线
    const t = inline(
      line
        .replace(/^\s*#{1,6}\s+/, '') // 标题
        .replace(/^\s*(>\s*)+/, '') // 引用
        .replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, ''), // 列表、任务框
    ).trim();
    if (t) out.push(t);
  }
  // 连续的「略」只留一个
  return out.filter((s, i) => !(s === out[i - 1] && (s === CODE_SKIP || s === TABLE_SKIP))).join('\n');
}

/** 太长的句子在逗号、顿号、空格处切开，实在切不开就硬切 */
function splitLong(s: string): string[] {
  if (s.length <= MAX_SEG) return [s];
  const res: string[] = [];
  let rest = s;
  while (rest.length > MAX_SEG) {
    const head = rest.slice(0, MAX_SEG);
    const cut = Math.max(head.lastIndexOf('，'), head.lastIndexOf(','), head.lastIndexOf('、'), head.lastIndexOf(' '));
    const at = cut > MAX_SEG / 3 ? cut + 1 : MAX_SEG;
    res.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) res.push(rest);
  return res;
}

/** 两段拼接：中文结尾直接接，英文结尾补一个空格 */
const join = (a: string, b: string) => `${a}${/[\p{Script=Han}，。！？；：]$/u.test(a) ? '' : ' '}${b}`;

/** 朗读文本 → 小段。按中英文句末标点和换行切，过短的并到后面，过长的再切。 */
export function splitSentences(text: string): string[] {
  const pieces = text
    .split(/(?<=[。！？!?；;…])|(?<=\.)(?=\s)|\n+/)
    .map((s) => s.trim())
    .filter((s) => /[\p{L}\p{N}]/u.test(s)); // 只剩标点的不要
  const merged: string[] = [];
  let buf = '';
  for (const p of pieces) {
    buf = buf ? join(buf, p) : p;
    if (buf.length >= MIN_SEG) {
      merged.push(...splitLong(buf));
      buf = '';
    }
  }
  if (buf) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length + buf.length <= MAX_SEG) merged[merged.length - 1] = join(last, buf);
    else merged.push(buf);
  }
  return merged;
}
