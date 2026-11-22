// 「选中回复」的引用块：拼接与解析（纯函数，无副作用）。
// 每段引用带着自己的回复（可为空）；发送时按「引用 → 它的回复 → 下一段引用 → …… → 正文」交错拼接，
// 引用文字每行前加 `> `，各部分之间空一行；展示 / 加载历史时从消息里把它们按段拆回来。
//
//   > 第一段          单段且回复为空：`> 引用\n\n正文`（与早期只支持一段时的格式完全一致）
//   >
//   > 第一段（引用内的空行写成 `> `，不会和段间空行混淆）
//
//   对第一段的回复
//
//   > 第二段
//
//   对第二段的回复
//
//   正文
//
// 拆分规则：「恰好一个空行 + 以 `> ` 开头的引用块（其后是空行或结尾）」视为下一段引用的开始（围栏代码里的不算）。
// 所以回复 / 正文本身以 `>` 开头时，拼接会在它前面多空一行（两个空行），解析时两个及以上空行后的引用行不算分段。

const NL = /\r\n?/g;

/** 一段引用及对它的回复（回复可为空） */
export interface QuoteReply {
  quote: string;
  reply: string;
}

/** 拆出来的一段：引用文字 + 紧跟其后的文字（最后一段的 text 含正文） */
export interface QuotePart {
  quote: string;
  text: string;
}

/** 规范化选中文字：统一换行，去掉首尾空白；全空白返回 '' */
export function normalizeQuote(text: string): string {
  return text.replace(NL, '\n').trim();
}

/**
 * 往引用列表里加一段（引用规范化后为空则不加）。
 * 引用与已有某段完全相同：不新增卡片，回复接在那段原有回复后面（换行分隔；回复为空或相同则不变）。
 * 没有变化时返回原数组（引用不变，React 不必重渲染）；保存的是规范化后的文字。
 */
export function addQuote(list: readonly QuoteReply[], quote: string, reply = ''): readonly QuoteReply[] {
  const q = normalizeQuote(quote);
  const r = normalizeQuote(reply);
  if (!q) return list;
  const idx = list.findIndex((x) => x.quote === q);
  if (idx < 0) return [...list, { quote: q, reply: r }];
  const old = list[idx].reply;
  if (!r || old === r) return list;
  const next = list.slice();
  next[idx] = { quote: q, reply: old ? `${old}\n${r}` : r };
  return next;
}

/** 引用行：`> xxx`，或空引用行 `>` */
const isQuoteLine = (l: string) => l.startsWith('> ') || l === '>';

type QuoteInput = string | QuoteReply;

/**
 * 把引用（及各自的回复）拼在正文前面。quotes 可以是单段字符串、单个 QuoteReply 或它们的数组；
 * 引用为空白的段整段忽略，没有有效引用时原样返回 body；回复 / body 为空时省略。
 */
export function buildQuotedMessage(quotes: QuoteInput | readonly QuoteInput[] | null | undefined, body: string): string {
  const list: readonly QuoteInput[] = quotes == null ? [] : Array.isArray(quotes) ? quotes : [quotes as QuoteInput];
  // 依次是「引用块」与「文字」两种部分；文字以 `>` 开头时前面多空一行，免得被解析成下一段引用
  const parts: Array<{ quote: boolean; s: string }> = [];
  for (const item of list) {
    const { quote, reply } = typeof item === 'string' ? { quote: item, reply: '' } : item;
    const q = normalizeQuote(quote);
    if (!q) continue;
    parts.push({ quote: true, s: q.split('\n').map((l) => `> ${l}`).join('\n') });
    const r = normalizeQuote(reply);
    if (r) parts.push({ quote: false, s: r });
  }
  if (!parts.length) return body;
  if (body !== '') parts.push({ quote: false, s: body });
  let out = parts[0].s;
  for (let k = 1; k < parts.length; k++) {
    const p = parts[k];
    const gap = !p.quote && isQuoteLine(p.s.split('\n', 1)[0]) ? '\n\n\n' : '\n\n';
    out += gap + p.s;
  }
  return out;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * 按引用拆分消息。要求第一行以 `> ` 开头，且第一个引用块之后是空行或结尾
 * （否则当作普通消息，避免误伤用户自己写的 `>` 文字），不是本功能的格式时返回 null。
 * 每段的 text 是该引用之后、下一段引用之前的文字（已去掉首尾分隔空行），最后一段的 text 含正文。
 */
export function parseQuotes(text: string): QuotePart[] | null {
  if (!text.startsWith('> ')) return null;
  const lines = text.replace(NL, '\n').split('\n');
  const n = lines.length;
  const blank = (k: number) => k >= 0 && k < n && lines[k].trim() === '';
  /** 从 k 开始的引用块的结束下标（不含） */
  const blockEnd = (k: number) => {
    while (k < n && isQuoteLine(lines[k])) k++;
    return k;
  };

  const parts: QuotePart[] = [];
  let i = 0;
  for (;;) {
    const end = blockEnd(i);
    const quote = lines.slice(i, end).map((l) => l.slice(2)).join('\n');
    // 引用块之后必须是空行或结尾，否则不是本功能的格式（后面各段在找分段时已保证这一点，实际只会在第一块触发）
    if (end < n && !blank(end)) return null;
    // 找下一段引用：恰好一个空行之后的引用块，且块后是空行或结尾；围栏代码里的不算
    let next = -1;
    let fence: string | null = null;
    for (let k = end; k < n; k++) {
      const m = FENCE.exec(lines[k]);
      if (fence) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length) fence = null;
        continue;
      }
      if (m) {
        fence = m[1];
        continue;
      }
      if (isQuoteLine(lines[k]) && blank(k - 1) && !blank(k - 2) && k - 1 >= end) {
        const e = blockEnd(k);
        if (e === n || blank(e)) {
          next = k;
          break;
        }
      }
    }
    const stop = next < 0 ? n : next - 1; // 去掉下一段引用前的那个分隔空行
    const body = lines.slice(end, stop).join('\n').replace(/^\n+/, '');
    parts.push({ quote, text: next < 0 ? body : body.replace(/\n+$/, '') });
    if (next < 0) break;
    i = next;
  }
  return parts;
}
