// 粘贴的图片：存到 <COSYEE_HOME 或 ~/.cosyee>/pastes/。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cosyeeHome } from './paths.js';
import { HttpError } from './workspaces.js';

/** 单张粘贴图片的大小上限 */
export const PASTE_LIMIT = 20 * 1024 * 1024;

export interface PasteKind {
  mime: string;
  ext: string;
}

/** 只接受这四种；扩展名与类型一一对应 */
const KINDS: PasteKind[] = [
  { mime: 'image/png', ext: '.png' },
  { mime: 'image/jpeg', ext: '.jpg' },
  { mime: 'image/gif', ext: '.gif' },
  { mime: 'image/webp', ext: '.webp' },
];

export function pastesDir(): string {
  return path.join(cosyeeHome(), 'pastes');
}

/** 按文件头判断图片类型；不是四种之一返回 null。 */
export function sniffImage(b: Buffer): PasteKind | null {
  const starts = (...bytes: number[]) => b.length >= bytes.length && bytes.every((v, i) => b[i] === v);
  let mime: string | null = null;
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) mime = 'image/png';
  else if (starts(0xff, 0xd8, 0xff)) mime = 'image/jpeg';
  else if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) mime = 'image/gif';
  else if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp';
  return KINDS.find((k) => k.mime === mime) ?? null;
}

/** savePaste 生成的文件名；按名读取时只认这个格式，名字里不可能带路径分隔符 */
export const PASTE_NAME_RE = /^paste-\d{1,16}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/;

/**
 * 按文件名找回粘贴的图片（会话流里的历史图片标签没有预览令牌，靠它显示缩略图）。
 * 只服务 pastes 目录下、名字符合格式的普通文件（不跟随符号链接）；类型以文件头为准。
 */
export async function pasteTarget(name: string): Promise<{ file: string; type: string; size: number; mtime: number }> {
  if (!PASTE_NAME_RE.test(name)) throw new HttpError(404, '图片不存在');
  const file = path.join(pastesDir(), name);
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(file);
  } catch {
    throw new HttpError(404, '图片不存在');
  }
  if (!st.isFile() || st.size > PASTE_LIMIT) throw new HttpError(404, '图片不存在');
  const fh = await fs.promises.open(file, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const kind = sniffImage(head);
  if (!kind) throw new HttpError(404, '图片不存在');
  return { file, type: kind.mime, size: st.size, mtime: Math.round(st.mtimeMs) };
}

/** 类型不被接受（http.ts 转成 415） */
export class PasteTypeError extends Error {}

/** 校验并保存。类型以文件头为准；请求头声明了具体图片类型时必须与文件头一致。返回写入文件的绝对路径。 */
export async function savePaste(data: Buffer, declared?: string): Promise<string> {
  const kind = sniffImage(data);
  if (!kind) throw new PasteTypeError('只支持 png / jpeg / gif / webp 图片');
  const d = declared?.split(';')[0]?.trim().toLowerCase();
  if (d && d !== 'application/octet-stream' && d !== kind.mime) throw new PasteTypeError('图片类型与内容不一致');
  const dir = pastesDir();
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `paste-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${kind.ext}`;
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, data, { flag: 'wx', mode: 0o600 });
  return file;
}
