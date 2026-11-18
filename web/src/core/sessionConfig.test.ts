import { describe, expect, it } from 'vitest';
import { canonicalModel } from '@cosyee/shared';
import { resolveSessionConfig } from './sessionConfig';

const DEF = { model: 'opus', effort: 'high' as const };

describe('canonicalModel', () => {
  it('完整 id 归一成菜单 id', () => {
    expect(canonicalModel('claude-sonnet-5-5-20260101')).toBe('sonnet');
    expect(canonicalModel('claude-opus-5-5')).toBe('opus');
    expect(canonicalModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(canonicalModel('claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(canonicalModel('sonnet')).toBe('sonnet');
  });
  it('带 [1m] 后缀 / 未知 / synthetic', () => {
    expect(canonicalModel('claude-opus-5-5[1m]')).toBe('opus');
    expect(canonicalModel('<synthetic>')).toBeUndefined();
    expect(canonicalModel('gpt-4')).toBeUndefined();
    expect(canonicalModel(undefined)).toBeUndefined();
  });
});

describe('resolveSessionConfig', () => {
  it('服务端记录优先', () => {
    expect(resolveSessionConfig({ config: { model: 'haiku', effort: 'low' }, lastModel: 'claude-opus-5-5' }, DEF)).toEqual({ model: 'haiku', effort: 'low' });
  });
  it('没有记录：用历史推断的模型 + 全局默认的强度', () => {
    expect(resolveSessionConfig({ lastModel: 'claude-sonnet-5-5-20260101' }, DEF)).toEqual({ model: 'sonnet', effort: 'high' });
  });
  it('什么都没有：全局默认', () => {
    expect(resolveSessionConfig(undefined, DEF)).toEqual(DEF);
    expect(resolveSessionConfig({ lastModel: '<synthetic>' }, DEF)).toEqual(DEF);
  });
});
