import { describe, expect, it } from 'vitest';
import { UPLOAD_TTL_MS, uploadExpired, uploadRef } from './uploads';

describe('uploadRef', () => {
  it('认出 uploads/<时间戳>-<hex>/<文件名>（Windows / POSIX 分隔符）', () => {
    expect(uploadRef('C:\\Users\\u\\.cosyee\\uploads\\1795354327668-0123456789ab\\截图 1.png'))
      .toEqual({ dir: '1795354327668-0123456789ab', name: '截图 1.png', ts: 1795354327668 });
    expect(uploadRef('/home/u/.cosyee/uploads/12-abcdefabcdef/a.pdf')?.name).toBe('a.pdf');
  });

  it('其它路径不认', () => {
    expect(uploadRef('/w/uploads/a.pdf')).toBeNull();
    expect(uploadRef('/w/uploads/12-ABCDEFABCDEF/a.pdf')).toBeNull();
    expect(uploadRef('/w/uploads/12-abcdefabcdef/sub/a.pdf')).toBeNull(); // 文件必须直接在子目录里
    expect(uploadRef('/w/uploads/12-abcdefabcdef/')).toBeNull();
    expect(uploadRef('/home/u/.cosyee/pastes/paste-1-0123456789ab.png')).toBeNull();
  });
});

describe('uploadExpired', () => {
  it('超过 7 天算已清理', () => {
    const now = 1_800_000_000_000;
    const ref = (ts: number) => ({ dir: `${ts}-0123456789ab`, name: 'a', ts });
    expect(uploadExpired(ref(now - UPLOAD_TTL_MS), now)).toBe(false);
    expect(uploadExpired(ref(now - UPLOAD_TTL_MS - 1), now)).toBe(true);
  });
});
