import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlTracker } from './claude/control.js';

type Json = Record<string, any>;

function setup(timeout = 30_000) {
  const written: Json[] = [];
  const t = new ControlTracker((o) => written.push(o), 'tt', timeout);
  return { t, written };
}
const ok = (id: string, response: Json) => ({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });

describe('ControlTracker', () => {
  afterEach(() => vi.useRealTimers());

  it('请求格式与自增 id', () => {
    const { t, written } = setup();
    void t.request('get_settings').catch(() => {});
    void t.request('set_model', { model: 'haiku' }).catch(() => {});
    expect(written[0]).toEqual({ type: 'control_request', request_id: 'tt-1', request: { subtype: 'get_settings' } });
    expect(written[1]).toEqual({ type: 'control_request', request_id: 'tt-2', request: { subtype: 'set_model', model: 'haiku' } });
    t.rejectAll('x');
  });

  it('响应乱序也能按 id 匹配', async () => {
    const { t } = setup();
    const a = t.request('a');
    const b = t.request('b');
    const c = t.request('c');
    expect(t.handleResponse(ok('tt-3', { v: 'c' }))).toBe(true);
    expect(t.handleResponse(ok('tt-1', { v: 'a' }))).toBe(true);
    expect(t.handleResponse(ok('tt-2', { v: 'b' }))).toBe(true);
    expect(await a).toEqual({ v: 'a' });
    expect(await b).toEqual({ v: 'b' });
    expect(await c).toEqual({ v: 'c' });
    expect(t.pendingCount).toBe(0);
  });

  it('error 响应 reject；未知 id 返回 false', async () => {
    const { t } = setup();
    const p = t.request('x');
    const assertion = expect(p).rejects.toThrow(/boom/);
    t.handleResponse({ type: 'control_response', response: { subtype: 'error', request_id: 'tt-1', error: 'boom' } });
    await assertion;
    expect(t.handleResponse(ok('nope', {}))).toBe(false);
    expect(t.handleResponse({} as Json)).toBe(false);
  });

  it('超时 reject 并清理', async () => {
    vi.useFakeTimers();
    const { t } = setup(1000);
    const p = t.request('slow');
    const assertion = expect(p).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(t.pendingCount).toBe(0);
  });

  it('rejectAll 让所有未决请求失败；写入失败立即 reject', async () => {
    const { t } = setup();
    const p1 = t.request('a');
    const p2 = t.request('b');
    const a1 = expect(p1).rejects.toThrow('closed');
    const a2 = expect(p2).rejects.toThrow('closed');
    t.rejectAll('closed');
    await a1;
    await a2;
    const bad = new ControlTracker(() => {
      throw new Error('stdin closed');
    });
    await expect(bad.request('x')).rejects.toThrow('stdin closed');
    expect(bad.pendingCount).toBe(0);
  });
});
