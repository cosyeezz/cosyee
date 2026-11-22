// @vitest-environment jsdom
// 历史缓存：切回刚看过、没变化的会话时带上版本号，后端回 unchanged 就复用上次构建好的状态。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ServerMsg } from '@cosyee/shared';

const h = vi.hoisted(() => ({
  history: vi.fn(),
  listeners: new Set<(m: ServerMsg) => void>(),
}));
vi.mock('../core/api', () => ({
  api: { history: h.history, context: vi.fn(async () => null) },
  socket: {
    on: (fn: (m: ServerMsg) => void) => {
      h.listeners.add(fn);
      return () => h.listeners.delete(fn);
    },
    send: vi.fn(),
  },
}));

import { clearHistoryCache } from '../core/historyCache';
import { useSessionStream, type SessionView } from './useSessionStream';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SID = 's1';
const CWD = 'F:\\w';
const entries = [
  { type: 'user', uuid: 'u1', message: { role: 'user', content: '你好' } },
  { type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '在' }] } },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
let last: SessionView | null = null;

function Probe({ id }: { id: string | null }) {
  last = useSessionStream(id, CWD, false).view;
  return null;
}

async function show(id: string | null) {
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  await act(async () => root!.render(<Probe id={id} />));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function emit(m: ServerMsg) {
  act(() => { for (const fn of h.listeners) fn(m); });
}

beforeEach(() => {
  clearHistoryCache();
  h.history.mockReset();
  last = null;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('useSessionStream 历史缓存', () => {
  it('第二次打开带上版本号；unchanged 时复用同一份状态', async () => {
    h.history.mockResolvedValueOnce({ version: 'v1', entries });
    await show(SID);
    expect(h.history).toHaveBeenLastCalledWith(SID, CWD, undefined);
    const first = last!.conv;
    expect(first.turns).toHaveLength(1);

    await show(null);
    h.history.mockResolvedValueOnce({ version: 'v1', unchanged: true });
    await show(SID);
    expect(h.history).toHaveBeenLastCalledWith(SID, CWD, 'v1');
    expect(last!.loading).toBe(false);
    expect(last!.conv).toBe(first);
  });

  it('版本变了：用新条目重建并更新缓存', async () => {
    h.history.mockResolvedValueOnce({ version: 'v1', entries });
    await show(SID);
    await show(null);
    const more = [...entries, { type: 'user', uuid: 'u2', parentUuid: 'a1', message: { role: 'user', content: '再来' } }];
    h.history.mockResolvedValueOnce({ version: 'v2', entries: more });
    await show(SID);
    expect(last!.conv.turns).toHaveLength(2);
    await show(null);
    h.history.mockResolvedValueOnce({ version: 'v2', unchanged: true });
    await show(SID);
    expect(h.history).toHaveBeenLastCalledWith(SID, CWD, 'v2');
    expect(last!.conv.turns).toHaveLength(2);
  });

  it('unchanged 但进程在跑：不用缓存（最后一轮要保持未结束），重新拉完整历史', async () => {
    h.history.mockResolvedValueOnce({ version: 'v1', entries });
    await show(SID);
    await show(null);
    let resolveFirst!: (v: unknown) => void;
    h.history.mockReturnValueOnce(new Promise((r) => (resolveFirst = r)));
    h.history.mockResolvedValueOnce({ version: 'v1', entries });
    await show(SID);
    emit({ t: 'status', sessionId: SID, status: 'running' } as ServerMsg);
    await act(async () => { resolveFirst({ version: 'v1', unchanged: true }); await new Promise((r) => setTimeout(r, 0)); });
    expect(h.history).toHaveBeenCalledTimes(3);
    expect(h.history).toHaveBeenLastCalledWith(SID, CWD);
    expect(last!.conv.turns[0]!.status).toBe('running');
  });

  it('旧版后端（没有 version）照常加载，不缓存', async () => {
    h.history.mockResolvedValueOnce({ entries });
    await show(SID);
    expect(last!.conv.turns).toHaveLength(1);
    await show(null);
    h.history.mockResolvedValueOnce({ entries });
    await show(SID);
    expect(h.history).toHaveBeenLastCalledWith(SID, CWD, undefined);
  });
});
