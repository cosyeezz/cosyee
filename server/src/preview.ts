// 预览：只有经系统选择窗口选出的路径才有 previewToken，凭 token 才能读信息 / 图片内容。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { PickedItem as ProtoPickedItem, PreviewInfo } from '@cosyee/shared';
import type { PickedItem } from './picker/index.js';
import { HttpError } from './workspaces.js';

const MAX_TOKENS = 500;
export const MAX_RAW_BYTES = 20 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

export function imageType(p: string): string | null {
  return IMAGE_TYPES[path.extname(p).toLowerCase()] ?? null;
}

interface Entry {
  path: string;
  kind: 'file' | 'folder';
  isImage: boolean;
}

export class Previews {
  private map = new Map<string, Entry>();

  /** 为选出的每一项生成令牌（超过上限时淘汰最早的）。 */
  register(items: PickedItem[]): ProtoPickedItem[] {
    return items.map((it) => {
      const isImage = it.kind === 'file' && imageType(it.path) !== null;
      const previewToken = crypto.randomBytes(18).toString('base64url');
      this.map.set(previewToken, { path: it.path, kind: it.kind, isImage });
      while (this.map.size > MAX_TOKENS) {
        const first = this.map.keys().next().value;
        if (first === undefined) break;
        this.map.delete(first);
      }
      return { path: it.path, kind: it.kind, previewToken, isImage };
    });
  }

  private get(token: string): Entry {
    const e = this.map.get(token);
    if (!e) throw new HttpError(404, '预览令牌无效');
    return e;
  }

  async info(token: string): Promise<PreviewInfo> {
    const e = this.get(token);
    let size: number | null = null;
    let mtime: number | null = null;
    let childCount: number | null = null;
    try {
      const st = await fs.promises.stat(e.path);
      mtime = Math.round(st.mtimeMs);
      if (e.kind === 'file') size = st.size;
      else childCount = (await fs.promises.readdir(e.path)).length;
    } catch { /* 文件已被移走：只返回路径 */ }
    return { path: e.path, kind: e.kind, size, mtime, isImage: e.isImage, childCount };
  }

  /** 返回图片的 Content-Type、大小与文件路径；非图片 / 过大抛错。 */
  async rawTarget(token: string): Promise<{ file: string; type: string; size: number; svg: boolean }> {
    const e = this.get(token);
    const type = e.isImage ? imageType(e.path) : null;
    if (!e.isImage || !type) throw new HttpError(404, '该文件不支持预览');
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(e.path);
    } catch {
      throw new HttpError(404, '文件不存在');
    }
    if (!st.isFile()) throw new HttpError(404, '文件不存在');
    if (st.size > MAX_RAW_BYTES) throw new HttpError(413, '文件超过 20MB，不提供预览');
    return { file: e.path, type, size: st.size, svg: type === 'image/svg+xml' };
  }
}
