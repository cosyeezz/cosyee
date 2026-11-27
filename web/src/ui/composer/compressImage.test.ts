import { describe, expect, it } from 'vitest';
import { isCompressible, isHeic, MAX_EDGE, planCompress, renameFor, SMALL_BYTES } from './compressImage';

describe('isCompressible / isHeic', () => {
  it('只压 jpeg / png / webp / heic；gif、svg 和其它文件原样上传', () => {
    expect(isCompressible('image/jpeg', 'a.jpg')).toBe(true);
    expect(isCompressible('image/png', 'a.png')).toBe(true);
    expect(isCompressible('image/heic', 'IMG_1.HEIC')).toBe(true);
    expect(isCompressible('image/gif', 'a.gif')).toBe(false);
    expect(isCompressible('image/svg+xml', 'a.svg')).toBe(false);
    expect(isCompressible('application/pdf', 'a.pdf')).toBe(false);
    // 没有 MIME（部分安卓文件管理器）就看扩展名
    expect(isCompressible('', 'IMG_1.heif')).toBe(true);
    expect(isCompressible('', 'a.txt')).toBe(false);
  });

  it('HEIC 按 MIME 或扩展名认', () => {
    expect(isHeic('image/heif', 'x')).toBe(true);
    expect(isHeic('', 'IMG_1.HEIC')).toBe(true);
    expect(isHeic('image/jpeg', 'a.jpg')).toBe(false);
  });
});

describe('planCompress', () => {
  it('尺寸在上限内且小于 1MB：不压', () => {
    expect(planCompress({ type: 'image/jpeg', size: SMALL_BYTES - 1, width: 1200, height: 800 })).toBeNull();
  });

  it('长边超过 2048：等比缩到 2048，jpeg 仍出 jpeg', () => {
    expect(planCompress({ type: 'image/jpeg', size: 100, width: 4032, height: 3024 }))
      .toEqual({ width: MAX_EDGE, height: 1536, type: 'image/jpeg' });
    expect(planCompress({ type: 'image/jpeg', size: 100, width: 1170, height: 2532 }))
      .toEqual({ width: 946, height: MAX_EDGE, type: 'image/jpeg' });
  });

  it('尺寸不大但体积超过 1MB：保持尺寸重新编码；png 改用 webp 保留透明', () => {
    expect(planCompress({ type: 'image/png', size: SMALL_BYTES, width: 1600, height: 900 }))
      .toEqual({ width: 1600, height: 900, type: 'image/webp' });
  });

  it('HEIC 即使很小也转码成 jpeg', () => {
    expect(planCompress({ type: 'image/heic', size: 10, width: 100, height: 100, heic: true }))
      .toEqual({ width: 100, height: 100, type: 'image/jpeg' });
  });

  it('尺寸拿不到时不压', () => {
    expect(planCompress({ type: 'image/jpeg', size: 1e8, width: 0, height: 0 })).toBeNull();
  });
});

describe('renameFor', () => {
  it('按输出格式换扩展名', () => {
    expect(renameFor('IMG_1234.HEIC', 'image/jpeg')).toBe('IMG_1234.jpg');
    expect(renameFor('截图.png', 'image/webp')).toBe('截图.webp');
    expect(renameFor('a.b.png', 'image/png')).toBe('a.b.png');
  });

  it('没有扩展名补上；隐藏文件名不当扩展名', () => {
    expect(renameFor('photo', 'image/jpeg')).toBe('photo.jpg');
    expect(renameFor('.hidden', 'image/jpeg')).toBe('.hidden.jpg');
    expect(renameFor('', 'image/jpeg')).toBe('image.jpg');
  });
});
