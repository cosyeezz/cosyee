// 从本设备上传的文件（远程连接的手机等）：存到 <COSYEE_HOME 或 ~/.cosyee>/uploads/<时间戳>-<随机>/<原文件名>，
// 上传超过 UPLOAD_TTL 的子目录由 startUploadSweeper 定时清掉。
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { IncomingMessage } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type PasteKind, sniffImage } from './pastes.js';
import { cosyeeHome } from './paths.js';
import { HttpError } from './workspaces.js';

/** 单个文件的大小上限 */
export const UPLOAD_LIMIT = 100 * 1024 * 1024;
/** 上传多久后清理 */
export const UPLOAD_TTL = 7 * 24 * 3600 * 1000;
/** 每次上传一个子目录：<Date.now()>-<12 位 hex> */
export const UPLOAD_DIR_RE = /^(\d{1,16})-[0-9a-f]{12}$/;
const TOO_BIG = '文件超过 100MB';
const GONE = '文件已清理或不存在';
const NAME_MAX_BYTES = 180;
const SWEEP_EVERY = 3600 * 1000;

export function uploadsDir(): string {
  return path.join(cosyeeHome(), 'uploads');
}

const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** 按 UTF-8 字节截断，不拆开码点 */
function cutBytes(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch);
    if (n + b > max) break;
    out += ch;
    n += b;
  }
  return out;
}

/** 把客户端给的文件名清洗成能安全落盘、各平台通用的名字；清空了就叫 file */
export function safeName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  let s = base.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').replace(/^[.\s]+|[.\s]+$/g, '');
  if (!s) return 'file';
  const dot = s.lastIndexOf('.');
  let stem = dot > 0 ? s.slice(0, dot) : s;
  let ext = dot > 0 ? s.slice(dot) : '';
  if (RESERVED.test(stem)) stem = `_${stem}`;
  if (Buffer.byteLength(ext) > 32) {
    stem += ext;
    ext = '';
  }
  s = cutBytes(stem, NAME_MAX_BYTES - Buffer.byteLength(ext)).replace(/[.\s]+$/g, '') + ext;
  return s.replace(/^[.\s]+|[.\s]+$/g, '') || 'file';
}

/** 边收边写盘；超限或中断时删掉整个子目录。返回写入文件的绝对路径。 */
export async function saveUpload(req: IncomingMessage, rawName: string): Promise<string> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > UPLOAD_LIMIT) throw new HttpError(413, TOO_BIG);
  const root = uploadsDir();
  await fs.promises.mkdir(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`);
  await fs.promises.mkdir(dir, { mode: 0o700 });
  const file = path.join(dir, safeName(rawName));
  let got = 0;
  const count = new Transform({
    transform(chunk: Buffer, _e, cb) {
      got += chunk.length;
      if (got > UPLOAD_LIMIT) cb(new HttpError(413, TOO_BIG));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(req, count, fs.createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  } catch (e) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e instanceof HttpError ? e : new HttpError(400, '上传中断');
  }
  return file;
}

/** 按「子目录 / 文件名」找回上传的文件（历史消息的标签没有预览令牌）。只认格式合规的普通文件，不跟随符号链接。 */
export async function uploadTarget(
  dir: string,
  name: string,
): Promise<{ file: string; size: number; mtime: number; image: PasteKind | null }> {
  if (!UPLOAD_DIR_RE.test(dir) || !name || safeName(name) !== name) throw new HttpError(404, GONE);
  const file = path.join(uploadsDir(), dir, name);
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(file);
  } catch {
    throw new HttpError(404, GONE);
  }
  if (!st.isFile()) throw new HttpError(404, GONE);
  const fh = await fs.promises.open(file, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  return { file, size: st.size, mtime: Math.round(st.mtimeMs), image: sniffImage(head) };
}

/** 删掉上传超过 UPLOAD_TTL 的子目录；不认识的东西不动。返回删了几个。 */
export async function sweepUploads(now = Date.now()): Promise<number> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(uploadsDir(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const e of entries) {
    const m = UPLOAD_DIR_RE.exec(e.name);
    if (!m || !e.isDirectory() || Number(m[1]) >= now - UPLOAD_TTL) continue;
    try {
      await fs.promises.rm(path.join(uploadsDir(), e.name), { recursive: true, force: true });
      removed++;
    } catch (err) {
      console.warn(`[uploads] 清理 ${e.name} 失败：`, err);
    }
  }
  return removed;
}

/** 启动时清一次，之后每小时清一次；返回停止函数 */
export function startUploadSweeper(): () => void {
  const run = () => void sweepUploads().catch(() => {});
  run();
  const timer = setInterval(run, SWEEP_EVERY);
  timer.unref();
  return () => clearInterval(timer);
}
