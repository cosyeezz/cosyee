import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from './browser';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('有 crypto.randomUUID 时直接用', () => {
    expect(uuid()).toMatch(V4);
  });

  it('非安全上下文（没有 randomUUID）时用 getRandomValues 生成 v4 UUID', () => {
    const real = globalThis.crypto;
    const getRandomValues = vi.fn(<T extends ArrayBufferView>(a: T) => real.getRandomValues(a as never) as T);
    vi.stubGlobal('crypto', { getRandomValues });
    const a = uuid();
    const b = uuid();
    expect(a).toMatch(V4);
    expect(b).toMatch(V4);
    expect(a).not.toBe(b);
    expect(getRandomValues).toHaveBeenCalledTimes(2);
  });
});
