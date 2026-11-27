// 从本设备上传的文件：存在宿主机 <cosyee 目录>/uploads/<时间戳>-<12 位 hex>/<文件名>，上传 7 天后被服务端清理。

/** 与服务端 UPLOAD_TTL 一致 */
export const UPLOAD_TTL_MS = 7 * 24 * 3600 * 1000;

export interface UploadRef {
  /** 子目录名：<时间戳>-<hex> */
  dir: string;
  name: string;
  /** 上传时间（毫秒） */
  ts: number;
}

/** 上传文件的路径 → 子目录 / 文件名 / 上传时间；其它路径返回 null */
export function uploadRef(path: string): UploadRef | null {
  const m = /[\\/]uploads[\\/]((\d{1,16})-[0-9a-f]{12})[\\/]([^\\/]+)$/.exec(path);
  return m ? { dir: m[1]!, ts: Number(m[2]), name: m[3]! } : null;
}

/** 按上传时间判断是否已被清理（不发请求） */
export function uploadExpired(ref: UploadRef, now = Date.now()): boolean {
  return now - ref.ts > UPLOAD_TTL_MS;
}
