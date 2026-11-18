// 用户气泡的 Markdown 预处理（纯函数）：
//  1. 单个换行保留成换行（用户输入框里按 Shift+Enter 就是想换行；不引入 remark-breaks，改成行尾补两个空格）；
//  2. 文件 / 图片 / 文件夹占位名（file1 …）换成 `[file1](#cz-att-N)` 链接，渲染时再换成 AttachmentTag；
//  3. `<` 转义，用户写的 `<div>` 之类按字面显示，而不是被当成 HTML 吞掉。
// 围栏代码块和行内代码里的内容一律不动。
import type { Attachment } from '@cosyee/shared';

/** 附件链接的 href 前缀 */
export const ATT_HREF = '#cz-att-';

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 把一行里「不在行内代码里」的部分交给 fn 处理 */
function mapOutsideCode(line: string, fn: (s: string) => string): string {
  if (!line.includes('`')) return fn(line);
  let out = '';
  let i = 0;
  let plain = 0;
  while (i < line.length) {
    if (line[i] !== '`') {
      i++;
      continue;
    }
    let k = i;
    while (line[k] === '`') k++;
    const mark = line.slice(i, k);
    const close = line.indexOf(mark, k);
    if (close !== -1 && line[close + mark.length] !== '`') {
      out += fn(line.slice(plain, i)) + line.slice(i, close + mark.length);
      i = plain = close + mark.length;
    } else {
      i = k;
    }
  }
  return out + fn(line.slice(plain));
}

/**
 * 预处理用户消息正文，返回可直接喂给 react-markdown 的文本。
 * attachments 的下标会写进链接（#cz-att-<下标>）。
 */
export function prepareUserMarkdown(body: string, attachments: Attachment[]): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  let attRe: RegExp | null = null;
  if (attachments.length) {
    // 长的在前，避免 file1 抢走 file10；两侧不能是字母数字，避免命中 myfile1
    const alt = attachments.map((a) => a.label).sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    attRe = new RegExp(`(?<![A-Za-z0-9_])(${alt})(?![A-Za-z0-9_])`, 'g');
  }
  const indexByLabel = new Map(attachments.map((a, i) => [a.label, i]));

  const transform = (s: string): string => {
    let r = s.replace(/</g, '\\<');
    if (attRe) r = r.replace(attRe, (m) => `[${m}](${ATT_HREF}${indexByLabel.get(m)})`);
    return r;
  };

  let fence: { ch: string; len: number } | null = null;
  const inFence: boolean[] = [];
  const out: string[] = [];
  for (const line of lines) {
    if (fence) {
      inFence.push(true);
      const m = FENCE.exec(line);
      if (m && m[2][0] === fence.ch && m[2].length >= fence.len && m[3].trim() === '') fence = null;
      out.push(line);
      continue;
    }
    const m = FENCE.exec(line);
    if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
      fence = { ch: m[2][0], len: m[2].length };
      inFence.push(true);
      out.push(line);
      continue;
    }
    inFence.push(false);
    out.push(mapOutsideCode(line, transform));
  }

  // 硬换行：当前行与下一行都是正文（非空、不在代码块里）时，行尾补两个空格
  for (let i = 0; i < out.length - 1; i++) {
    if (inFence[i] || inFence[i + 1]) continue;
    if (out[i].trim() === '' || out[i + 1].trim() === '') continue;
    if (/ {2}$|\\$/.test(out[i])) continue;
    out[i] += '  ';
  }
  return out.join('\n');
}

/** 取出链接 href 指向的附件下标；不是附件链接返回 null */
export function attachmentIndex(href: string | undefined): number | null {
  if (!href || !href.startsWith(ATT_HREF)) return null;
  const n = Number(href.slice(ATT_HREF.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}
