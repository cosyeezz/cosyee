// 从本设备上传前压缩图片：手机原图动辄 5–15MB，长边缩到 2048px 再转 JPEG / WebP，上传快、也省模型的图片 token。
// 判断逻辑是纯函数（planCompress），真正的解码 / 编码在 prepareUpload 里，浏览器不支持时一律退回原文件。

/** 长边上限 */
export const MAX_EDGE = 2048;
/** 尺寸已在上限内且小于这个体积就不动 */
export const SMALL_BYTES = 1024 * 1024;
const JPEG_QUALITY = 0.88;

const CANDIDATE = /^image\/(?:jpeg|png|webp|heic|heif)$/i;
const BY_EXT = /\.(?:jpe?g|png|webp|heic|heif)$/i;

/** 是否值得尝试压缩（gif 可能是动图、svg 是矢量，其余文件原样上传） */
export function isCompressible(type: string, name: string): boolean {
  if (type) return CANDIDATE.test(type);
  return BY_EXT.test(name);
}

export interface CompressPlan {
  /** 输出尺寸 */
  width: number;
  height: number;
  /** 输出格式：可能带透明通道的 png 用 webp（不支持再退回 png），其余用 jpeg */
  type: 'image/jpeg' | 'image/webp';
}

/** HEIC / HEIF：模型读不了，能解码就一律转码 */
export function isHeic(type: string, name: string): boolean {
  return /hei[cf]/i.test(type) || /\.hei[cf]$/i.test(name);
}

/** 给定原图信息，返回怎么压；null = 原样上传 */
export function planCompress(o: { type: string; size: number; width: number; height: number; heic?: boolean }): CompressPlan | null {
  if (!(o.width > 0 && o.height > 0)) return null;
  const edge = Math.max(o.width, o.height);
  if (!o.heic && edge <= MAX_EDGE && o.size < SMALL_BYTES) return null;
  const scale = Math.min(1, MAX_EDGE / edge);
  return {
    width: Math.max(1, Math.round(o.width * scale)),
    height: Math.max(1, Math.round(o.height * scale)),
    type: /png/i.test(o.type) ? 'image/webp' : 'image/jpeg',
  };
}

/** 换扩展名：IMG_1.HEIC → IMG_1.jpg；没有扩展名就补上 */
export function renameFor(name: string, type: string): string {
  const ext = type === 'image/webp' ? '.webp' : type === 'image/png' ? '.png' : '.jpg';
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(0, dot) : name || 'image') + ext;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch {
      resolve(null);
    }
  });
}

/** 准备要上传的内容：能压就压，压不了 / 压完反而更大就用原文件 */
export async function prepareUpload(file: File): Promise<{ blob: Blob; name: string }> {
  const original = { blob: file as Blob, name: file.name || 'file' };
  if (!isCompressible(file.type, file.name) || typeof createImageBitmap !== 'function') return original;
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return original; // 浏览器解不了（比如桌面 Chrome 的 HEIC）：原样当文件传
  }
  try {
    const heic = isHeic(file.type, file.name);
    const plan = planCompress({ type: file.type, size: file.size, width: bmp.width, height: bmp.height, heic });
    if (!plan) return original;
    const canvas = document.createElement('canvas');
    canvas.width = plan.width;
    canvas.height = plan.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return original;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, plan.width, plan.height);
    let out = await toBlob(canvas, plan.type, JPEG_QUALITY);
    // 不支持 webp 的浏览器会悄悄给 png：那就保留 png
    if (out && out.type !== plan.type) out = out.type === 'image/png' ? out : null;
    if (!out || (out.size >= file.size && !heic)) return original;
    return { blob: out, name: renameFor(file.name, out.type) };
  } finally {
    bmp.close();
  }
}
