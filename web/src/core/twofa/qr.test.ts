import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import {
  decodeQrFromImageData,
  decodeQrRegion,
  findAllQrInImageData,
  findQrInImageData,
  type RgbaImage,
} from './qr';

/** 把文本渲染成 RGBA 像素：scale = 每个模块的像素数，margin = 静区模块数，可反色 */
function renderQr(
  text: string,
  opts: { scale?: number; margin?: number; invert?: boolean; width?: number; height?: number; at?: [number, number] } = {},
): { img: RgbaImage; box: { x: number; y: number; size: number } } {
  const { scale = 6, margin = 4, invert = false } = opts;
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const size = (n + margin * 2) * scale;
  const width = opts.width ?? size;
  const height = opts.height ?? size;
  const [ox, oy] = opts.at ?? [0, 0];
  const data = new Uint8ClampedArray(width * height * 4);
  const light = invert ? 0 : 255;
  const dark = invert ? 255 : 0;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = invert ? 0 : 255;
    data[i + 3] = 255;
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - margin;
      const my = Math.floor(y / scale) - margin;
      const on = mx >= 0 && my >= 0 && mx < n && my < n && qr.modules.get(mx, my);
      const v = on ? dark : light;
      const p = ((y + oy) * width + x + ox) * 4;
      if (p < 0 || p >= data.length) continue;
      data[p] = data[p + 1] = data[p + 2] = v;
    }
  }
  return { img: { data, width, height }, box: { x: ox + margin * scale, y: oy + margin * scale, size: n * scale } };
}

const URI = 'otpauth://totp/GitHub:dev@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub';

describe('二维码解码', () => {
  it('解码标准图', () => {
    expect(decodeQrFromImageData(renderQr(URI).img)).toBe(URI);
  });

  it('反色（深底浅码）也能解', () => {
    expect(decodeQrFromImageData(renderQr(URI, { invert: true }).img)).toBe(URI);
  });

  it('很小的图会被放大后解码', () => {
    expect(decodeQrFromImageData(renderQr(URI, { scale: 2, margin: 2 }).img)).toBe(URI);
  });

  it('超大图先缩小再解码，位置回到原图坐标', () => {
    const { img, box } = renderQr(URI, { scale: 4, width: 3600, height: 2400, at: [1200, 600] });
    const hit = findQrInImageData(img);
    expect(hit?.text).toBe(URI);
    const b = hit!.location.bounds;
    expect(b.x).toBeGreaterThan(box.x - 40);
    expect(b.x).toBeLessThan(box.x + 40);
    expect(b.y).toBeGreaterThan(box.y - 40);
    expect(b.width).toBeGreaterThan(box.size * 0.8);
    expect(b.width).toBeLessThan(box.size * 1.2);
  });

  it('没有二维码返回 null', () => {
    const data = new Uint8ClampedArray(200 * 200 * 4).fill(255);
    expect(decodeQrFromImageData({ data, width: 200, height: 200 })).toBeNull();
  });

  it('框选区域：紧裁（无静区）也能解', () => {
    const { img, box } = renderQr(URI, { scale: 5, width: 800, height: 600, at: [120, 80] });
    expect(decodeQrRegion(img, { x: box.x, y: box.y, width: box.size, height: box.size })).toBe(URI);
  });

  it('框选区域：选区略大或略偏也能解', () => {
    const { img, box } = renderQr(URI, { scale: 5, width: 800, height: 600, at: [120, 80] });
    expect(decodeQrRegion(img, { x: box.x - 30, y: box.y - 10, width: box.size + 80, height: box.size + 50 })).toBe(URI);
  });

  it('框选到没有二维码的区域返回 null', () => {
    const { img } = renderQr(URI, { scale: 5, width: 800, height: 600, at: [120, 80] });
    expect(decodeQrRegion(img, { x: 600, y: 400, width: 150, height: 150 })).toBeNull();
  });

  it('一张图里多个二维码都能找到', () => {
    const a = renderQr('otpauth://totp/A?secret=JBSWY3DPEHPK3PXP', { scale: 4, width: 900, height: 400, at: [20, 20] }).img;
    const b = renderQr('otpauth://totp/B?secret=JBSWY3DPEHPK3PXP', { scale: 4, width: 900, height: 400, at: [480, 40] }).img;
    // 合成：取较暗的像素（两张都是白底黑码）
    const data = new Uint8ClampedArray(a.data.length);
    for (let i = 0; i < data.length; i++) data[i] = Math.min(a.data[i], b.data[i]);
    const hits = findAllQrInImageData({ data, width: 900, height: 400 });
    expect(hits.map((h) => h.text).sort()).toEqual(['otpauth://totp/A?secret=JBSWY3DPEHPK3PXP', 'otpauth://totp/B?secret=JBSWY3DPEHPK3PXP']);
  });
});
