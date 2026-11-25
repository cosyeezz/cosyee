import { describe, expect, it } from 'vitest';
import { needsHttps } from './https';

describe('needsHttps', () => {
  const url = 'https://pc.tail1.ts.net';
  it('非安全上下文、不在 HTTPS 地址上时需要跳转', () => {
    expect(needsHttps(url, { origin: 'http://100.1.2.3:7878' }, false)).toBe(true);
  });
  it('已是安全上下文、已在该地址、地址无效时不跳', () => {
    expect(needsHttps(url, { origin: 'http://127.0.0.1:7878' }, true)).toBe(false);
    expect(needsHttps(url, { origin: 'https://pc.tail1.ts.net' }, false)).toBe(false);
    expect(needsHttps('not a url', { origin: 'http://100.1.2.3:7878' }, false)).toBe(false);
  });
});
