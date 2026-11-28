// 二维码解码（基于 jsqr）：图片 / 画布 / 截屏帧 / 框选区域统一入口。
// 纯 JS 做缩放与二值化（不依赖 canvas），所以 jsdom 单测也能跑；只有 Blob / 元素读取才用到浏览器 API。
import jsQR from 'jsqr';

export interface QrPoint {
  x: number;
  y: number;
}

export interface QrLocation {
  topLeft: QrPoint;
  topRight: QrPoint;
  bottomRight: QrPoint;
  bottomLeft: QrPoint;
  /** 四角点外接矩形（源图像素坐标） */
  bounds: QrRect;
}

export interface QrRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QrHit {
  text: string;
  location: QrLocation;
}

/** 与 ImageData 结构兼容的最小像素缓冲（测试里可直接构造） */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type QrSource =
  | RgbaImage
  | HTMLCanvasElement
  | OffscreenCanvas
  | ImageBitmap
  | HTMLImageElement
  | HTMLVideoElement;

/** 超过该边长先缩小，jsqr 在超大图上又慢又容易漏 */
const MAX_SIDE = 2000;
/** 小图 / 紧裁区域低于该边长时尝试放大 */
const SMALL_SIDE = 520;
/** 读取 Blob 时的最大边长，避免极端大图吃光内存 */
const BLOB_MAX_SIDE = 4096;

// ───────────────────────── 像素工具 ─────────────────────────

function makeImage(width: number, height: number): RgbaImage {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

/** 盒式平均缩小（factor < 1），保留细线条对比度 */
function downscale(img: RgbaImage, factor: number): RgbaImage {
  const w = Math.max(1, Math.round(img.width * factor));
  const h = Math.max(1, Math.round(img.height * factor));
  const out = makeImage(w, h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * img.width + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          r += img.data[i];
          g += img.data[i + 1];
          b += img.data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 最近邻整数倍放大：模块边缘保持锐利 */
function upscale(img: RgbaImage, k: number): RgbaImage {
  const w = img.width * k;
  const h = img.height * k;
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / k);
    for (let x = 0; x < w; x++) {
      const si = (sy * img.width + Math.floor(x / k)) * 4;
      const o = (y * w + x) * 4;
      out.data[o] = img.data[si];
      out.data[o + 1] = img.data[si + 1];
      out.data[o + 2] = img.data[si + 2];
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** 大津法全局二值化：低对比度 / 彩色二维码的最后兜底 */
function binarize(img: RgbaImage): RgbaImage {
  const n = img.width * img.height;
  const gray = new Uint8Array(n);
  const hist = new Array<number>(256).fill(0);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = (img.data[p] * 299 + img.data[p + 1] * 587 + img.data[p + 2] * 114) / 1000;
    gray[i] = v;
    hist[gray[i]]++;
  }
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  const out = makeImage(img.width, img.height);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = gray[i] > threshold ? 255 : 0;
    out.data[p] = v;
    out.data[p + 1] = v;
    out.data[p + 2] = v;
    out.data[p + 3] = 255;
  }
  return out;
}

/** 给图像四周补边（quiet zone），颜色取四角平均；紧裁出来的二维码没有静区时 jsqr 找不到 */
function pad(img: RgbaImage, margin: number, fill: [number, number, number]): RgbaImage {
  const w = img.width + margin * 2;
  const h = img.height + margin * 2;
  const out = makeImage(w, h);
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = fill[0];
    out.data[i + 1] = fill[1];
    out.data[i + 2] = fill[2];
    out.data[i + 3] = 255;
  }
  for (let y = 0; y < img.height; y++) {
    const si = y * img.width * 4;
    const di = ((y + margin) * w + margin) * 4;
    out.data.set(img.data.subarray(si, si + img.width * 4), di);
  }
  return out;
}

function cornerColor(img: RgbaImage): [number, number, number] {
  const pts = [
    [0, 0],
    [img.width - 1, 0],
    [0, img.height - 1],
    [img.width - 1, img.height - 1],
  ];
  let r = 0;
  let g = 0;
  let b = 0;
  for (const [x, y] of pts) {
    const i = (y * img.width + x) * 4;
    r += img.data[i];
    g += img.data[i + 1];
    b += img.data[i + 2];
  }
  return [r / 4, g / 4, b / 4];
}

function crop(img: RgbaImage, rect: QrRect): RgbaImage | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(img.height, Math.ceil(rect.y + rect.height));
  const w = x1 - x0;
  const h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const si = ((y0 + y) * img.width + x0) * 4;
    out.data.set(img.data.subarray(si, si + w * 4), y * w * 4);
  }
  return out;
}

// ───────────────────────── 核心解码 ─────────────────────────

function runJsQr(img: RgbaImage): QrHit | null {
  const buf = img.data instanceof Uint8ClampedArray ? img.data : new Uint8ClampedArray(img.data);
  const r = jsQR(buf, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  if (!r || !r.data) return null;
  const pts = [r.location.topLeftCorner, r.location.topRightCorner, r.location.bottomRightCorner, r.location.bottomLeftCorner];
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    text: r.data,
    location: {
      topLeft: { ...r.location.topLeftCorner },
      topRight: { ...r.location.topRightCorner },
      bottomRight: { ...r.location.bottomRightCorner },
      bottomLeft: { ...r.location.bottomLeftCorner },
      bounds: { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY },
    },
  };
}

function scaleLocation(loc: QrLocation, sx: number, sy: number, ox = 0, oy = 0): QrLocation {
  const m = (p: QrPoint): QrPoint => ({ x: p.x / sx + ox, y: p.y / sy + oy });
  const tl = m(loc.topLeft);
  const tr = m(loc.topRight);
  const br = m(loc.bottomRight);
  const bl = m(loc.bottomLeft);
  const xs = [tl.x, tr.x, br.x, bl.x];
  const ys = [tl.y, tr.y, br.y, bl.y];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return {
    topLeft: tl,
    topRight: tr,
    bottomRight: br,
    bottomLeft: bl,
    bounds: { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY },
  };
}

/**
 * 在一张像素图里找一个二维码（返回内容 + 角点，坐标为传入图像的像素坐标）。
 * 依次尝试：原图（超大先缩到 2000）→ 缩小重试 → 小图放大 → 全局二值化；每一步 jsqr 自带正反色两种尝试。
 */
export function findQrInImageData(img: RgbaImage): QrHit | null {
  if (img.width < 21 || img.height < 21) return null;
  const maxSide = Math.max(img.width, img.height);

  // [缩放系数, 是否二值化]，系数 > 1 为放大
  const plans: Array<[number, boolean]> = [];
  if (maxSide > MAX_SIDE) plans.push([MAX_SIDE / maxSide, false]);
  else plans.push([1, false]);
  if (maxSide > 1200) plans.push([1000 / maxSide, false]);
  if (maxSide > 2600) plans.push([1400 / maxSide, false]);
  if (maxSide < SMALL_SIDE) {
    for (const k of [2, 3, 4]) if (maxSide * k <= MAX_SIDE) plans.push([k, false]);
  }
  plans.push([plans[0][0], true]);
  if (maxSide < SMALL_SIDE && maxSide * 2 <= MAX_SIDE) plans.push([2, true]);

  for (const [factor, bin] of plans) {
    let work: RgbaImage = img;
    if (factor < 1) work = downscale(img, factor);
    else if (factor > 1) work = upscale(img, factor);
    if (bin) work = binarize(work);
    const hit = runJsQr(work);
    if (hit) {
      const sx = work.width / img.width;
      const sy = work.height / img.height;
      return { text: hit.text, location: scaleLocation(hit.location, sx, sy) };
    }
  }
  return null;
}

/** 解出一张像素图里的二维码文本，找不到返回 null */
export function decodeQrFromImageData(img: RgbaImage): string | null {
  return findQrInImageData(img)?.text ?? null;
}

/** 整图找不到时（常见于多个二维码互相干扰定位点）按重叠的半幅分块再找，坐标回到整图 */
function findQrInTiles(img: RgbaImage, found: QrHit[]): QrHit | null {
  const W = img.width;
  const H = img.height;
  const ox = Math.round(W * 0.08);
  const oy = Math.round(H * 0.08);
  const tiles: QrRect[] = [
    { x: 0, y: 0, width: Math.ceil(W / 2) + ox, height: H },
    { x: Math.floor(W / 2) - ox, y: 0, width: W - Math.floor(W / 2) + ox, height: H },
    { x: 0, y: 0, width: W, height: Math.ceil(H / 2) + oy },
    { x: 0, y: Math.floor(H / 2) - oy, width: W, height: H - Math.floor(H / 2) + oy },
  ];
  for (const t of tiles) {
    const cut = crop(img, t);
    if (!cut) continue;
    const hit = findQrInImageData(cut);
    if (!hit) continue;
    if (found.some((f) => f.text === hit.text)) continue;
    return { text: hit.text, location: scaleLocation(hit.location, 1, 1, t.x, t.y) };
  }
  return null;
}

/** 找出图中所有二维码（找到一个后把它抹白再找下一个，最多 max 个） */
export function findAllQrInImageData(img: RgbaImage, max = 6): QrHit[] {
  const hits: QrHit[] = [];
  let work: RgbaImage = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let n = 0; n < max; n++) {
    const hit = findQrInImageData(work) ?? findQrInTiles(work, hits);
    if (!hit) break;
    hits.push(hit);
    const b = hit.location.bounds;
    const m = Math.max(4, Math.min(b.width, b.height) * 0.06);
    const x0 = Math.max(0, Math.floor(b.x - m));
    const y0 = Math.max(0, Math.floor(b.y - m));
    const x1 = Math.min(work.width, Math.ceil(b.x + b.width + m));
    const y1 = Math.min(work.height, Math.ceil(b.y + b.height + m));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * work.width + x) * 4;
        work.data[i] = 255;
        work.data[i + 1] = 255;
        work.data[i + 2] = 255;
        work.data[i + 3] = 255;
      }
    }
  }
  return hits;
}

// ───────────────────────── 浏览器来源适配 ─────────────────────────

function sourceSize(src: QrSource): { width: number; height: number } {
  const s = src as unknown as Record<string, number>;
  if ('videoWidth' in s && s.videoWidth) return { width: s.videoWidth, height: s.videoHeight };
  if ('naturalWidth' in s && s.naturalWidth) return { width: s.naturalWidth, height: s.naturalHeight };
  return { width: s.width, height: s.height };
}

function isRgba(src: QrSource): src is RgbaImage {
  return !!src && typeof (src as RgbaImage).width === 'number' && (src as RgbaImage).data instanceof Uint8ClampedArray;
}

/** 任意来源 → 像素缓冲（必要时按 maxSide 缩小绘制） */
export function toRgbaImage(src: QrSource, maxSide = BLOB_MAX_SIDE): RgbaImage | null {
  if (isRgba(src)) return src;
  const { width, height } = sourceSize(src);
  if (!width || !height) return null;
  const k = Math.min(1, maxSide / Math.max(width, height));
  const w = Math.max(1, Math.round(width * k));
  const h = Math.max(1, Math.round(height * k));
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) return null;
  ctx.drawImage(src as CanvasImageSource, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/** Blob / File → 像素缓冲 */
export async function blobToRgbaImage(blob: Blob): Promise<RgbaImage | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob);
      try {
        return toRgbaImage(bmp);
      } finally {
        bmp.close?.();
      }
    } catch {
      /* 落到 <img> 兜底 */
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return toRgbaImage(img);
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** 在任意来源里找二维码（含位置，坐标为来源像素坐标；超过 4096px 的图按缩放后坐标返回） */
export function findQrInImage(source: QrSource): QrHit | null {
  const img = toRgbaImage(source);
  return img ? findQrInImageData(img) : null;
}

export function findAllQrInImage(source: QrSource, max = 6): QrHit[] {
  const img = toRgbaImage(source);
  return img ? findAllQrInImageData(img, max) : [];
}

export async function decodeQrFromBlob(blob: Blob): Promise<string | null> {
  const img = await blobToRgbaImage(blob);
  return img ? decodeQrFromImageData(img) : null;
}

export const decodeQrFromFile = decodeQrFromBlob;

export function decodeQrFromCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): string | null {
  return findQrInImage(canvas)?.text ?? null;
}

/**
 * 解码来源中的一块区域（源像素坐标）。
 * 紧裁的区域通常没有静区：补一圈与四角同色的边，再走完整的缩放 / 反色 / 二值化尝试；
 * 补白失败再补反色（深色背景上的浅色码）。
 */
export function decodeQrRegion(source: QrSource, rect: QrRect): string | null {
  return findQrInRegion(source, rect)?.text ?? null;
}

export function findQrInRegion(source: QrSource, rect: QrRect): QrHit | null {
  const full = toRgbaImage(source, 16384);
  if (!full) return null;
  const cut = crop(full, rect);
  if (!cut) return null;
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const margin = Math.max(12, Math.round(Math.min(cut.width, cut.height) * 0.12));

  const bg = cornerColor(cut);
  const luma = (bg[0] * 299 + bg[1] * 587 + bg[2] * 114) / 1000;
  const fills: Array<[number, number, number]> = [
    [255, 255, 255],
    [Math.round(bg[0]), Math.round(bg[1]), Math.round(bg[2])],
    [luma > 128 ? 0 : 255, luma > 128 ? 0 : 255, luma > 128 ? 0 : 255],
  ];
  // 先直接试裁切（区域本身已含静区时最准），再逐个补边
  const direct = findQrInImageData(cut);
  if (direct) return { text: direct.text, location: scaleLocation(direct.location, 1, 1, x0, y0) };
  for (const fill of fills) {
    const padded = pad(cut, margin, fill);
    const hit = findQrInImageData(padded);
    if (hit) return { text: hit.text, location: scaleLocation(hit.location, 1, 1, x0 - margin, y0 - margin) };
  }
  return null;
}
