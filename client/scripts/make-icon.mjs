// 生成 1024×1024 的源图标 app-icon.png（纯 Node + zlib，不依赖图像库），
// 再由 `tauri icon` 生成各平台尺寸。图案：深色圆角方块 + 蓝色 "C" 形圆环。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const N = 1024;
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'app-icon.png');

const clamp = (x) => Math.max(0, Math.min(1, x));
// 有符号距离 -> 覆盖率（1px 抗锯齿）
const cover = (d) => clamp(0.5 - d);

function roundedRectSD(x, y, cx, cy, half, r) {
  const qx = Math.abs(x - cx) - (half - r);
  const qy = Math.abs(y - cy) - (half - r);
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r;
}

const px = Buffer.alloc(N * N * 4);
const c = N / 2;
const ringR = 250, ringW = 96;
const gapHalf = Math.PI / 5; // 右侧开口
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const sx = x + 0.5, sy = y + 0.5;
    // 背景：圆角方块（留 6% 边距，macOS 风格），竖向渐变 #2a2f38 -> #15171b
    const bg = cover(roundedRectSD(sx, sy, c, c, N * 0.44, N * 0.2));
    const t = y / N;
    let r = 42 + (21 - 42) * t, g = 47 + (23 - 47) * t, b = 56 + (27 - 56) * t;
    // 圆环 + 开口（端点为圆头）
    const dx = sx - c, dy = sy - c;
    const dist = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    let ringD;
    if (Math.abs(ang) > gapHalf) {
      ringD = Math.abs(dist - ringR) - ringW / 2;
    } else {
      // 开口两端的圆头
      const ex = c + ringR * Math.cos(gapHalf), ey1 = c + ringR * Math.sin(gapHalf), ey2 = c - ringR * Math.sin(gapHalf);
      ringD = Math.min(Math.hypot(sx - ex, sy - ey1), Math.hypot(sx - ex, sy - ey2)) - ringW / 2;
    }
    const ring = cover(ringD);
    // 圆点（光标）
    const dot = cover(Math.hypot(sx - (c + ringR + 10), sy - c) - ringW * 0.42);
    const fg = Math.max(ring, dot);
    // 蓝色 #4a90e2 -> #6aa8f0 斜向渐变
    const u = (x + y) / (2 * N);
    const fr = 74 + (106 - 74) * (1 - u), fgc = 144 + (168 - 144) * (1 - u), fb = 226 + (240 - 226) * (1 - u);
    r = r + (fr - r) * fg; g = g + (fgc - g) * fg; b = b + (fb - b) * fg;
    const i = (y * N + x) * 4;
    px[i] = Math.round(r); px[i + 1] = Math.round(g); px[i + 2] = Math.round(b); px[i + 3] = Math.round(255 * bg);
  }
}

// PNG 编码
const crcTable = new Uint32Array(256).map((_, n) => {
  let k = n;
  for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
  return k >>> 0;
});
const crc32 = (buf) => {
  let k = 0xffffffff;
  for (const byte of buf) k = crcTable[(k ^ byte) & 0xff] ^ (k >>> 8);
  return (k ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const raw = Buffer.alloc(N * (N * 4 + 1));
for (let y = 0; y < N; y++) px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(out, png);
console.log(`图标: ${out}（${(png.length / 1024).toFixed(0)} KB）`);
