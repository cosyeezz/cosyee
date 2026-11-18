// 粘贴的图片：存到 <COSYEE_HOME 或 ~/.cosyee>/pastes/。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cosyeeHome } from './paths.js';

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
