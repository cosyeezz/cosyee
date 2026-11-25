import { describe, expect, it } from 'vitest';
import type { AccountKiroInfo } from '@cosyee/shared';
import { kiroStateFact } from './AccountCard';

const k = (over: Partial<AccountKiroInfo>): AccountKiroInfo => ({ method: 'builderId', proxy: 'ready', error: null, credential: 'ok', ...over });

describe('kiroStateFact：Kiro 账号详情卡的「状态」', () => {
  it('服务没在跑时说服务，在跑时说凭据', () => {
    expect(kiroStateFact(k({ proxy: 'stopped', credential: 'unknown' }), undefined).value).toBe('kiro.rs 未运行');
    expect(kiroStateFact(k({ proxy: 'failed', error: '端口占用', credential: 'unknown' }), undefined)).toMatchObject({ value: 'kiro.rs 启动失败：端口占用', tone: 'danger' });
    expect(kiroStateFact(k({}), undefined)).toEqual({ label: '状态', value: '可用' });
    expect(kiroStateFact(k({ credential: 'missing' }), undefined).value).toBe('服务里找不到凭据，请重新登录');
    expect(kiroStateFact(k({ credential: 'disabled', credentialReason: 'TooManyFailures' }), undefined).value).toBe('已被 kiro.rs 停用：TooManyFailures');
  });

  it('额度用完时带上重置日期（来自 balance）', () => {
    const resetsAt = new Date(2026, 11, 1, 8, 0).getTime();
    const balance = { status: 'ok' as const, info: { subscription: 'Kiro Pro', used: 500, limit: 500, resetsAt } };
    expect(kiroStateFact(k({ credential: 'quota' }), balance).value).toBe('额度已用完，12-01 重置');
    expect(kiroStateFact(k({ credential: 'quota' }), undefined).value).toBe('额度已用完');
  });
});
