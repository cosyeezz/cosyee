// 会话记录里是否「提到过」某个路径：文件预览放行 cwd 之外的路径时用（见 files.ts）。
// 只认完整路径的字面出现（前后都是边界），`/tmp/a.png` 不会因为记录里有 `/tmp/a.png.bak` 或 `/x/tmp/a.png` 被放行。
import fs from 'node:fs';

/** 路径里会出现的字符：紧挨在匹配前面说明匹配只是更长路径的一段 */
const PATH_BEFORE = /[A-Za-z0-9._\-~/]/;
/** 紧挨在匹配后面说明是更长的文件名 / 子路径（`.` 另判：句末标点 vs 扩展名） */
const PATH_AFTER = /[A-Za-z0-9_\-~/]/;

function boundedAt(text: string, start: number, end: number): boolean {
  const prev = text[start - 1];
  if (prev !== undefined && PATH_BEFORE.test(prev) && !(prev === '/' && text.endsWith('file://', start))) return false;
  const next = text[end];
  if (next === undefined) return true;
  if (PATH_AFTER.test(next)) return false;
  if (next === '.' && /[A-Za-z0-9_\-~]/.test(text[end + 1] ?? '')) return false;
  // JSON 里转义过的反斜杠（Windows 分隔符）：后面接的是子路径
  if (next === '\\' && text[end + 1] === '\\') return false;
  return true;
}

/** text 里 needle 是否作为完整路径出现过。matchEnd 之后没有字符的匹配视为不确定（流式读取时留给下一块判断），除非 final。 */
export function textMentions(text: string, needle: string, final = true): boolean {
  if (!needle) return false;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    const end = i + needle.length;
    if (!final && end >= text.length - 1) continue;
    if (boundedAt(text, i, end)) return true;
  }
  return false;
}

/** 流式扫描文件，任一 needle 出现即返回 true。块与块之间保留足够长的重叠，跨块的匹配不会漏。 */
export async function fileMentions(file: string, needles: string[], ignoreCase = false): Promise<boolean> {
  const list = needles.filter(Boolean).map((n) => (ignoreCase ? n.toLowerCase() : n));
  if (!list.length) return false;
  const keep = Math.max(...list.map((n) => n.length)) + 16;
  const stream = fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 256 * 1024 });
  let carry = '';
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      const text = carry + (ignoreCase ? chunk.toLowerCase() : chunk);
      if (list.some((n) => textMentions(text, n, false))) return true;
      carry = text.slice(-keep);
    }
    return list.some((n) => textMentions(carry, n, true));
  } finally {
    stream.destroy();
  }
}
