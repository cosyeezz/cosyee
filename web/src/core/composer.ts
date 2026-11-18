// 输入框的文档模型与序列化（纯函数，无副作用）。
// 发送时：标签 → `@"<绝对路径>"`；加载历史 / 实时回显时：把 `@"..."` 还原成占位名 + attachments。
import type { Attachment, PickedItem } from '@cosyee/shared';

export type ChipKind = 'file' | 'img' | 'folder';

export type Segment =
  | { t: 'text'; text: string }
  | { t: 'chip'; kind: ChipKind; path: string; label: string };

/** 占位名前缀就是 kind 本身：file1 / img1 / folder1 */
export const labelOf = (kind: ChipKind, n: number): string => `${kind}${n}`;

/** PickedItem → 标签类型 */
export function itemKind(p: PickedItem): ChipKind {
  if (p.kind === 'folder') return 'folder';
  return p.isImage ? 'img' : 'file';
}

/**
 * 按出现顺序给每类标签重新编号（file1、file2、img1、folder1…），每条消息从 1 开始。
 * 约定：同一路径重复出现时仍分别编号（每个标签各占一个序号，不去重），
 * 这样「编辑器里的标签数 = attachments 数」，往返解析也能保持一致。
 * 返回新数组，不修改入参。
 */
export function labelChips(segments: Segment[]): Segment[] {
  const n: Record<ChipKind, number> = { file: 0, img: 0, folder: 0 };
  return segments.map((s) => (s.t === 'chip' ? { ...s, label: labelOf(s.kind, ++n[s.kind]) } : s));
}

/** 从（已编号的）片段里取出 attachments，顺序与出现顺序一致 */
export function toAttachments(segments: Segment[]): Attachment[] {
  const out: Attachment[] = [];
  for (const s of segments) if (s.t === 'chip') out.push({ kind: s.kind, label: s.label, path: s.path });
  return out;
}

/** 去掉整段内容首尾的空白（只动第一个 / 最后一个文本片段），并丢弃变空的文本片段 */
export function trimSegments(segments: Segment[]): Segment[] {
  const out = segments.map((s) => ({ ...s }));
  if (out.length && out[0].t === 'text') (out[0] as { text: string }).text = (out[0] as { text: string }).text.trimStart();
  const last = out[out.length - 1];
  if (last && last.t === 'text') last.text = last.text.trimEnd();
  return out.filter((s) => s.t !== 'text' || s.text !== '');
}

/**
 * 路径引用写法：`@"<绝对路径>"`。
 * 路径中含双引号（只可能出现在 macOS）：Claude Code 的 @ 提及语法没有公开的转义规则，
 * 这里保留原样不转义；解析侧用「引号后紧跟空白/标点/结尾」判定结束，所以多数情况下仍可往返。
 */
export function mention(path: string): string {
  return `@"${path}"`;
}

/**
 * 序列化：文本原样拼接，标签 → `@"<路径>"`。
 * 标签前面紧贴非空白字符、后面紧跟非空白（且非标点）字符时，各补一个空格（避免路径引用和文字粘在一起）。
 */
export function serialize(segments: Segment[]): string {
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.t === 'text') {
      // 前一个是标签、而本段文字以非空白开头 → 在标签后补空格
      const prev = segments[i - 1];
      // 例外：后面紧跟标点（，。；：！？）,.;:!?]）时不补，解析侧认这些标点作为引用的结束
      if (prev?.t === 'chip' && s.text !== '' && !/^[\s,.;:!?)\]，。；：！？）]/.test(s.text)) out += ' ';
      out += s.text;
    } else {
      if (out !== '' && !/\s$/.test(out)) out += ' ';
      out += mention(s.path);
    }
  }
  return out;
}

// ───────────── 解析 ─────────────

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

/**
 * 路径 → kind 的启发式（历史消息里没有 stat 信息，只能猜）：
 *  - 扩展名是图片 → img
 *  - 以 / 或 \ 结尾，或最后一段没有扩展名 → folder（所以无扩展名文件如 Makefile 会被当成文件夹）
 *  - 否则 file（以点开头的隐藏文件如 .gitignore 视为 file）
 */
export function guessKind(path: string): ChipKind {
  if (/[\\/]$/.test(path)) return 'folder';
  const base = path.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (base.startsWith('.') && dot === 0) return 'file';
  if (dot <= 0 || dot === base.length - 1) return 'folder';
  const ext = base.slice(dot + 1).toLowerCase();
  return IMAGE_EXT.has(ext) ? 'img' : 'file';
}

// 引用必须出现在行首 / 空白 / 开括号引号之后，避免误判 email@x.com
// 带引号：@"..."，到「引号 + 结尾/空白/常见标点」为止（惰性匹配）
// 不带引号：@ 后必须是 盘符:\ 盘符:/ / \ \\ ~/ ~\ 之一，到空白为止（所以 @someone 不算）
const MENTION_RE =
  /(?<=^|[\s(（[「“'])@(?:"([^\n]+?)"(?=$|[\s,.;:!?)\]，。；：！？）])|((?:[A-Za-z]:[\\/]|[\\/]|~[\\/])[^\s"]+))/g;
const TRAILING_PUNCT_RE = /[,.;:!?)\]}，。；：！？）]+$/;

/**
 * 从用户消息文本里识别路径引用，还原成「占位名文本 + attachments」。
 * 无副作用；每次从 1 开始编号，规则同 labelChips（重复路径也各占一号）。
 * 不带引号的形式会剥掉末尾的标点（句号、逗号、右括号等）并留在文本里。
 * 已知限制：不带引号的路径到空白为止，「看@/a/b.ts的内容」这类中文紧贴会把后面的字吞进路径。
 */
export function parseUserText(text: string): { userText: string; attachments: Attachment[] } {
  const attachments: Attachment[] = [];
  const n: Record<ChipKind, number> = { file: 0, img: 0, folder: 0 };
  const userText = text.replace(MENTION_RE, (_all, quoted: string | undefined, bare: string | undefined) => {
    let path = quoted ?? bare ?? '';
    let tail = '';
    if (bare !== undefined) {
      const m = TRAILING_PUNCT_RE.exec(path);
      if (m) {
        tail = m[0];
        path = path.slice(0, m.index);
      }
      if (path === '') return _all;
    }
    const kind = guessKind(path);
    const label = labelOf(kind, ++n[kind]);
    attachments.push({ kind, label, path });
    return label + tail;
  });
  return { userText, attachments };
}
