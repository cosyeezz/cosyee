// 「选中回复」的引用块：拼接与解析（纯函数，无副作用）。
// 发送时：引用文字每行前加 `> `，空一行，再接正文；展示 / 加载历史时从消息开头把它拆回来。

const NL = /\r\n?/g;

/** 规范化选中文字：统一换行，去掉首尾空白；全空白返回 '' */
export function normalizeQuote(text: string): string {
  return text.replace(NL, '\n').trim();
}

/**
 * 把引用拼在正文前面：`> 第一行\n> 第二行\n\n正文`。
 * quote 为空（或全是空白）时原样返回 body；body 为空时只返回引用块。
 */
export function buildQuotedMessage(quote: string | null | undefined, body: string): string {
  const q = quote ? normalizeQuote(quote) : '';
  if (!q) return body;
  const block = q.split('\n').map((l) => `> ${l}`).join('\n');
  return body === '' ? block : `${block}\n\n${body}`;
}

/** 引用行：`> xxx`，或空引用行 `>` */
const isQuoteLine = (l: string) => l.startsWith('> ') || l === '>';

/**
 * 解析消息开头的引用块。要求第一行以 `> ` 开头，且引用块之后是空行或结尾
 * （否则当作普通消息，避免误伤用户自己写的 `>` 文字）。
 * 返回引用文字（已去掉每行的 `> `）与剩余正文；没有引用块时 quote 为 null、body 为原文。
 */
export function parseQuote(text: string): { quote: string | null; body: string } {
  if (!text.startsWith('> ')) return { quote: null, body: text };
  const lines = text.replace(NL, '\n').split('\n');
  let n = 0;
  while (n < lines.length && isQuoteLine(lines[n])) n++;
  if (n < lines.length && lines[n].trim() !== '') return { quote: null, body: text };
  const quote = lines.slice(0, n).map((l) => l.slice(2)).join('\n');
  // 引用块后的空行（拼接时只有一个）不属于正文
  const body = lines.slice(n).join('\n').replace(/^\n+/, '');
  return { quote, body };
}
