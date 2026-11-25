// 会话工作目录内的文件预览：解析路径、授权（必须在会话 cwd 内）、安全读取、类型识别、文本解码。
//
// 授权模型：可读范围 = 会话 cwd 之内的任何文件 + 会话记录里原样提到过的 cwd 之外的路径（如 agent 截图存到 /tmp）。
// - 词法检查：`..` 逃逸、cwd 之外的绝对路径 → 交给调用方的 OutsideCheck（查会话记录），没提到过 → 403；
// - realpath 检查：符号链接 / junction 指向 cwd 之外 → 403（比较 realpath(目标) 与 realpath(cwd)）；
//   cwd 之外、已被会话提到过的路径不做这项比较（macOS 的 /tmp 本身就是指向 /private/tmp 的链接）；
//   提到过只放行那一个路径本身，目录里的其它文件仍要各自被提到过；
// - 设备路径（`\\.\`、`\\?\`、UNC）与 Windows 保留名（con / nul / com1…）→ 403；
// - 读取：O_NOFOLLOW + dev/ino 校验，读前读后 size / mtime 校验，读期间被换掉则 409。
import { constants } from 'node:fs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { localFileLink, type FileEntry, type FilePreview } from '@cosyee/shared';
import { normalizeDir, pathKey } from './paths.js';
import { MAX_RAW_BYTES } from './preview.js';
import { HttpError } from './workspaces.js';

/** 文本预览上限：超过的文件不读，返回 unsupported + 原因 */
export const TEXT_LIMIT = 2 * 1024 * 1024;
/** 目录列表上限 */
export const LIST_LIMIT = 500;

const isWin = process.platform === 'win32';
const sepOf = isWin ? '\\' : '/';

const languages: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  py: 'python', rb: 'ruby', php: 'php', pl: 'perl', lua: 'lua', r: 'r',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', bat: 'dos', cmd: 'dos',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', conf: 'ini',
  rs: 'rust', go: 'go', java: 'java', kt: 'kotlin', swift: 'swift', scala: 'scala',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp', m: 'objectivec',
  sql: 'sql', graphql: 'graphql', diff: 'diff', patch: 'diff', dockerfile: 'dockerfile', makefile: 'makefile',
};
const MARKDOWN_EXT = new Set(['md', 'markdown', 'mdown']);
/** 已知的二进制扩展名：不读内容，直接给原因 */
const BINARY_EXT = new Set([
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip', 'gz', 'tgz', '7z', 'rar', 'tar', 'exe', 'dll', 'so', 'dylib',
  'ico', 'woff', 'woff2', 'ttf', 'otf', 'mp4', 'mov', 'mkv', 'mp3', 'wav', 'flac', 'db', 'sqlite', 'wasm', 'class', 'jar',
]);

/** 扩展名 → 高亮语言（无则 undefined）；`Dockerfile` / `Makefile` 这类无扩展名文件按全名 */
export function languageOf(file: string): string | undefined {
  const name = path.basename(file).toLowerCase();
  const ext = path.extname(name).slice(1);
  return languages[ext] ?? (ext ? undefined : languages[name]);
}

/** 解码文本：BOM（UTF-8 / UTF-16）、UTF-8 严格解码失败回退 GB18030、含控制字符或 NUL 视为二进制。失败返回 null。 */
export function decodeFileText(bytes: Buffer): { text: string; encoding: string } | null {
  let encoding = 'utf-8';
  let start = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    start = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    start = 2;
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  else if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(start));
  } catch {
    if (encoding !== 'utf-8') return null;
    try {
      encoding = 'gb18030';
      text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return null;
  return { text, encoding: encoding.toUpperCase() + (encoding === 'gb18030' ? ' · 自动识别' : '') };
}

/** 按文件头魔数识别图片 / PDF（不信扩展名）；SVG 靠扩展名 + 内容里有 `<svg`，由调用方另判 */
export function sniffMedia(head: Buffer): { type: string; kind: 'image' | 'pdf' } | null {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { type: 'image/png', kind: 'image' };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { type: 'image/jpeg', kind: 'image' };
  if (/^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'))) return { type: 'image/gif', kind: 'image' };
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return { type: 'image/webp', kind: 'image' };
  if (head[0] === 0x42 && head[1] === 0x4d) return { type: 'image/bmp', kind: 'image' };
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return { type: 'application/pdf', kind: 'pdf' };
  return null;
}
const MEDIA_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'pdf']);
const looksLikeSvg = (head: Buffer): boolean => /<svg[\s>]/i.test(head.toString('utf8', 0, 4096));

// ───────────── 路径解析与授权 ─────────────

const forbidden = (msg = '只能查看会话工作目录内、或会话中提到过的文件') => new HttpError(403, msg);

/** cwd 之外的绝对路径是否放行（调用方按会话记录判断）；不传则一律 403 */
export type OutsideCheck = (abs: string) => Promise<boolean>;

/**
 * 同一路径在会话记录（jsonl）里可能的几种写法，已按 JSON 字符串转义：
 * 原样、`~/…`（在家目录下时）、Windows 的正斜杠写法、Markdown 链接里的百分号编码。
 */
export function mentionForms(abs: string): string[] {
  const forms = new Set<string>([abs]);
  if (isWin) forms.add(abs.replace(/\\/g, '/'));
  const home = os.homedir();
  if (home && isInside(abs, home) && pathKey(abs) !== pathKey(home)) forms.add('~' + abs.slice(home.length).replace(/\\/g, '/'));
  for (const f of [...forms]) {
    const enc = encodeURI(f.replace(/\\/g, '/'));
    if (enc !== f) forms.add(enc);
  }
  return [...forms].map((f) => JSON.stringify(f).slice(1, -1));
}

const RESERVED = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\..*)?$/i;

/** Windows 保留设备名（con / nul / com1…，带不带扩展名、末尾带点或空格都算） */
export function hasReservedName(p: string): boolean {
  return p.split(/[\\/]/).some((seg) => RESERVED.test(seg.replace(/[. ]+$/, '')));
}

/** target 是否在 base 之内（含 base 本身）；按平台的大小写 / 分隔符规则比较 */
export function isInside(target: string, base: string): boolean {
  const t = pathKey(target);
  let b = pathKey(base);
  if (!b.endsWith(sepOf)) b += sepOf;
  return t === b.slice(0, -1) || t.startsWith(b);
}

export interface Target {
  /** 请求的绝对路径（已规范化，不含行号 / 锚点） */
  abs: string;
  /** realpath；读取只用它 */
  real: string;
  stat: fs.Stats;
  /** 在 cwd 之外、因会话提到过而放行 */
  external: boolean;
  line?: number;
  fragment?: string;
}

/**
 * 请求里的 path（href 或路径）→ 绝对路径。只做字符串运算与词法授权，不碰文件系统。
 * allowOutside 为真时 cwd 之外的路径不抛错，返回 outside: true 交给调用方再判断。
 */
export function lexicalTarget(
  cwd: string,
  input: unknown,
  allowOutside = false,
): { abs: string; cwdAbs: string; outside: boolean; line?: number; fragment?: string } {
  if (typeof input !== 'string' || !input) throw new HttpError(400, '缺少 path');
  const link = localFileLink(input);
  if (!link) throw new HttpError(400, '不是本地文件路径');
  let p = link.path;
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  const cwdAbs = normalizeDir(cwd);
  const abs = path.resolve(cwdAbs, p);
  // 设备路径 / UNC（link 解析已拒绝 `//`，这里对 `\\.\`、`\\?\` 再兜底一次）
  if (abs.startsWith('\\\\') || abs.startsWith('//')) throw forbidden('不支持设备路径或网络路径');
  if (isWin) {
    if (hasReservedName(abs)) throw forbidden('不支持设备名');
    if (abs.slice(2).includes(':')) throw forbidden('不支持备用数据流路径');
  }
  const outside = !isInside(abs, cwdAbs);
  if (outside && !allowOutside) throw forbidden();
  return { abs, cwdAbs, outside, ...(link.line ? { line: link.line } : {}), ...(link.fragment ? { fragment: link.fragment } : {}) };
}

/** 完整解析：词法授权 + realpath 授权。路径不存在 404，在 cwd 之外 / 符号链接逃逸 403。 */
export async function resolveTarget(cwd: string, input: unknown, outsideOk?: OutsideCheck): Promise<Target> {
  const lex = lexicalTarget(cwd, input, !!outsideOk);
  if (lex.outside && !(await outsideOk!(lex.abs))) throw forbidden();
  const t = await authorize(lex.abs, lex.cwdAbs, lex.outside);
  return { ...t, ...(lex.line ? { line: lex.line } : {}), ...(lex.fragment ? { fragment: lex.fragment } : {}) };
}

/** 已规范化的绝对路径（不再按 href 解析，文件名里的 `#` / `%` 保持原样）→ realpath 授权 */
async function authorize(abs: string, cwdAbs: string, external: boolean): Promise<Target> {
  let cwdReal: string;
  try {
    cwdReal = await fs.promises.realpath(cwdAbs);
  } catch {
    throw new HttpError(404, '工作目录不存在');
  }
  const real = await realpathOf(abs);
  if (!external && !isInside(real, cwdReal)) throw forbidden('路径指向工作目录之外（符号链接 / junction）');
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(real);
  } catch (e) {
    throw mapFsError(e);
  }
  if (!stat.isFile() && !stat.isDirectory()) throw forbidden('不是普通文件或目录');
  return { abs, real, stat, external };
}

async function realpathOf(p: string): Promise<string> {
  try {
    return await fs.promises.realpath(p);
  } catch (e) {
    throw mapFsError(e);
  }
}

function mapFsError(e: unknown): HttpError {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new HttpError(404, '文件不存在或已移动');
  if (code === 'EACCES' || code === 'EPERM' || code === 'ELOOP') return forbidden('无权访问该路径');
  return new HttpError(500, '无法读取文件');
}

// ───────────── 并发限制 ─────────────

let reading = 0;
const MAX_READING = 4;
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (reading >= MAX_READING) throw new HttpError(429, '文件预览请求过多，请稍后重试');
  reading++;
  try {
    return await fn();
  } finally {
    reading--;
  }
}

// ───────────── 读取 ─────────────

const O_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** 打开并校验：必须仍是 resolveTarget 看到的同一个普通文件 */
async function openChecked(t: Target): Promise<fs.promises.FileHandle> {
  let h: fs.promises.FileHandle;
  try {
    h = await fs.promises.open(t.real, O_FLAGS);
  } catch (e) {
    throw mapFsError(e);
  }
  try {
    const info = await h.stat();
    if (!info.isFile() || info.dev !== t.stat.dev || info.ino !== t.stat.ino) throw forbidden('文件已被替换');
    return h;
  } catch (e) {
    await h.close();
    throw e;
  }
}

/** 读完后确认文件没被换掉 / 改动：路径仍解析到同一个文件、仍在 cwd 内，size / mtime 与读前一致 */
async function verifyUnchanged(cwd: string, t: Target, h: fs.promises.FileHandle, before: fs.Stats): Promise<void> {
  const after = await authorize(t.abs, normalizeDir(cwd), t.external);
  if (pathKey(after.real) !== pathKey(t.real) || after.stat.dev !== t.stat.dev || after.stat.ino !== t.stat.ino) {
    throw new HttpError(409, '文件在读取期间发生变化，请重新加载');
  }
  const fin = await h.stat();
  if (fin.size !== before.size || fin.mtimeMs !== before.mtimeMs) throw new HttpError(409, '文件在读取期间发生变化，请重新加载');
}

async function readAll(h: fs.promises.FileHandle, size: number): Promise<Buffer> {
  const buf = Buffer.alloc(size + 1); // 多读一个字节：读到比 stat 大说明期间被追加
  let len = 0;
  while (len < buf.length) {
    const r = await h.read(buf, len, buf.length - len, len);
    if (!r.bytesRead) break;
    len += r.bytesRead;
  }
  if (len !== size) throw new HttpError(409, '文件在读取期间发生变化，请重新加载');
  return buf.subarray(0, len);
}

async function listDir(dir: string): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  let names: fs.Dirent[];
  try {
    names = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    throw mapFsError(e);
  }
  const all: FileEntry[] = names.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
  all.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  return { entries: all.slice(0, LIST_LIMIT), truncated: all.length > LIST_LIMIT };
}

/** 文件预览：返回结构化结果。文本 ≤ 2MB；图片 / PDF 只返回类型，内容走 raw 接口。 */
export function previewFile(cwd: string, input: unknown, outsideOk?: OutsideCheck): Promise<FilePreview> {
  return limited(async () => {
    const t = await resolveTarget(cwd, input, outsideOk);
    const base: FilePreview = {
      name: path.basename(t.abs) || t.abs,
      path: t.abs,
      size: t.stat.size,
      mtime: Math.round(t.stat.mtimeMs),
      kind: 'unsupported',
      ...(t.line ? { line: t.line } : {}),
      ...(t.fragment ? { fragment: t.fragment } : {}),
    };
    if (t.stat.isDirectory()) {
      const { entries, truncated } = await listDir(t.real);
      return { ...base, size: 0, kind: 'directory', entries, ...(truncated ? { truncated } : {}) };
    }
    const ext = path.extname(t.abs).slice(1).toLowerCase();
    if (BINARY_EXT.has(ext)) return { ...base, reason: '此格式暂不支持内嵌预览，请用本地应用打开。' };

    const h = await openChecked(t);
    try {
      const before = await h.stat();
      const head = Buffer.alloc(Math.min(4096, before.size));
      if (head.length) await h.read(head, 0, head.length, 0);
      const media = sniffMedia(head);
      if (media) {
        if (before.size > MAX_RAW_BYTES) return { ...base, reason: '文件超过 20MB，不提供预览。' };
        await verifyUnchanged(cwd, t, h, before);
        return { ...base, kind: media.kind, mimeType: media.type };
      }
      if (ext === 'svg' && looksLikeSvg(head)) {
        if (before.size > MAX_RAW_BYTES) return { ...base, reason: '文件超过 20MB，不提供预览。' };
        await verifyUnchanged(cwd, t, h, before);
        return { ...base, kind: 'image', mimeType: 'image/svg+xml' };
      }
      if (MEDIA_EXT.has(ext)) return { ...base, reason: '文件内容与格式不符，无法预览。' };
      if (before.size > TEXT_LIMIT) return { ...base, reason: `文件超过 ${TEXT_LIMIT / 1024 / 1024}MB，不预览文本。请用本地应用打开。` };
      const bytes = await readAll(h, before.size);
      await verifyUnchanged(cwd, t, h, before);
      const decoded = decodeFileText(bytes);
      if (!decoded) return { ...base, reason: '无法可靠解码此文件，或文件包含二进制内容。请用本地应用查看。' };
      const language = languageOf(t.abs);
      return {
        ...base,
        ...decoded,
        kind: MARKDOWN_EXT.has(ext) ? 'markdown' : language ? 'code' : 'text',
        ...(language ? { language } : {}),
      };
    } finally {
      await h.close();
    }
  });
}

export interface RawFile {
  handle: fs.promises.FileHandle;
  type: string;
  size: number;
  svg: boolean;
}

/**
 * 图片 / PDF 的原始内容：返回已校验的文件句柄（调用方负责 createReadStream 并关闭）。
 * Content-Type 由魔数决定，不信扩展名；超过 20MB 413；不是图片 / PDF 404。
 */
export async function openRaw(cwd: string, input: unknown, outsideOk?: OutsideCheck): Promise<RawFile> {
  if (reading >= MAX_READING) throw new HttpError(429, '文件预览请求过多，请稍后重试');
  const t = await resolveTarget(cwd, input, outsideOk);
  if (!t.stat.isFile()) throw new HttpError(404, '不是文件');
  const h = await openChecked(t);
  try {
    const info = await h.stat();
    const head = Buffer.alloc(Math.min(4096, info.size));
    if (head.length) await h.read(head, 0, head.length, 0);
    let type = sniffMedia(head)?.type ?? null;
    let svg = false;
    if (!type && path.extname(t.abs).toLowerCase() === '.svg' && looksLikeSvg(head)) {
      type = 'image/svg+xml';
      svg = true;
    }
    if (!type) throw new HttpError(404, '该文件不支持预览');
    if (info.size > MAX_RAW_BYTES) throw new HttpError(413, '文件超过 20MB，不提供预览');
    await verifyUnchanged(cwd, t, h, info);
    return { handle: h, type, size: info.size, svg };
  } catch (e) {
    await h.close();
    throw e;
  }
}

/** 供 reveal / terminal 用：授权并返回要操作的路径与类型（文件 → 选中；目录 → 打开）。 */
export async function resolveForAction(cwd: string, input: unknown, outsideOk?: OutsideCheck): Promise<{ abs: string; isDir: boolean }> {
  const t = await resolveTarget(cwd, input, outsideOk);
  return { abs: t.abs, isDir: t.stat.isDirectory() };
}
