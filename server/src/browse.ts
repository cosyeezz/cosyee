// 网页版选择窗口的后端：远程连接时，「添加文件」「打开文件夹」不在服务端桌面上弹系统对话框（远程设备看不到），
// 而是由网页列出服务端的目录让用户在远端选择。能访问到的范围与系统对话框一致（整个文件系统），
// 连接本身已经过 Tailscale / 访问令牌的校验。
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowseDir, FileEntry } from '@cosyee/shared';
import type { PickedItem } from './picker/index.js';
import { HttpError } from './workspaces.js';

const MAX_ENTRIES = 2000;
const MAX_PICK = 200;

/** Windows：现有的盘符；其它系统：`/` */
export async function listRoots(platform: NodeJS.Platform = process.platform): Promise<string[]> {
  if (platform !== 'win32') return ['/'];
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZAB'.split('');
  const ok = await Promise.all(letters.map((l) => fs.stat(`${l}:\\`).then(() => true, () => false)));
  return letters.filter((_, i) => ok[i]).map((l) => `${l}:\\`).sort();
}

function absOf(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new HttpError(400, '路径不合法');
  const p = input.trim();
  if (!path.isAbsolute(p)) throw new HttpError(400, '需要绝对路径');
  return path.resolve(p);
}

function fsError(e: unknown, what: string): HttpError {
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return new HttpError(404, `${what}不存在`);
  if (code === 'EACCES' || code === 'EPERM') return new HttpError(403, `没有权限访问该${what}`);
  return new HttpError(500, `无法读取${what}: ${e instanceof Error ? e.message : e}`);
}

/** 列出目录。input 为空时用 fallback（当前工作空间 / 主目录）。 */
export async function browseDir(input: unknown, fallback: string): Promise<BrowseDir> {
  const dir = input == null || input === '' ? path.resolve(fallback) : absOf(input);
  let names: Dirent[];
  try {
    if (!(await fs.stat(dir)).isDirectory()) throw new HttpError(404, '不是文件夹');
    names = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw fsError(e, '文件夹');
  }
  const entries: FileEntry[] = await Promise.all(
    names.map(async (d) => {
      let isDir = d.isDirectory();
      // 符号链接 / 目录联接：跟随到目标判断（断链当文件）
      if (d.isSymbolicLink()) isDir = await fs.stat(path.join(dir, d.name)).then((s) => s.isDirectory(), () => false);
      return { name: d.name, isDir };
    }),
  );
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' }) : a.isDir ? -1 : 1));
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    entries: entries.slice(0, MAX_ENTRIES),
    ...(entries.length > MAX_ENTRIES ? { truncated: true } : {}),
    roots: await listRoots(),
  };
}

/** 网页里选好的路径：校验存在、判断文件 / 文件夹、去重 */
export async function statPicked(input: unknown): Promise<PickedItem[]> {
  if (!Array.isArray(input) || input.length > MAX_PICK) throw new HttpError(400, 'paths 不合法');
  const seen = new Set<string>();
  const out: PickedItem[] = [];
  for (const raw of input) {
    const p = absOf(raw);
    if (seen.has(p)) continue;
    seen.add(p);
    try {
      out.push({ path: p, kind: (await fs.stat(p)).isDirectory() ? 'folder' : 'file' });
    } catch (e) {
      throw fsError(e, '文件');
    }
  }
  return out;
}

/** 网页里选的工作空间文件夹：必须是现存目录 */
export async function statFolder(input: unknown): Promise<string> {
  const p = absOf(input);
  let isDir = false;
  try {
    isDir = (await fs.stat(p)).isDirectory();
  } catch (e) {
    throw fsError(e, '文件夹');
  }
  if (!isDir) throw new HttpError(400, '不是文件夹');
  return p;
}
