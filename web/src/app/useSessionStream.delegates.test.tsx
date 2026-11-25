// @vitest-environment jsdom
// 委派快照：到达早于历史时在历史载入后重放；没收到快照时不判「丢失」。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DELEGATE_BG_MARKER, type DelegateJobInfo, type ServerMsg } from '@cosyee/shared';

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
const D = 'toolu_D';
const bgEntries = [
  { type: 'user', message: { role: 'user', content: '后台做' } },
  { type: 'assistant', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: D, name: 'mcp__cosyee__delegate', input: { description: '重构', prompt: 'p' } }] } },
  { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: D, content: [{ type: 'text', text: DELEGATE_BG_MARKER }] }] } },
  { type: 'system', subtype: 'turn_duration', durationMs: 10 },
];
const job = (over: Partial<DelegateJobInfo> = {}): DelegateJobInfo => ({
  toolUseId: D, conversationId: 'c1', description: '重构', background: true, state: 'running', startedAt: 1, pending: 0, tail: '', ...over,
});
const msg = (jobs: DelegateJobInfo[]) => ({ t: 'delegates', sessionId: SID, jobs }) as ServerMsg;

let root: Root | null = null;
let host: HTMLElement | null = null;
let last: SessionView | null = null;
const run = () => last!.conv.turns[0]!.subagents[0]!;

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

describe('useSessionStream 委派快照', () => {
  it('快照早于历史到达：历史载入后重放，按快照落定', async () => {
    let resolveHist!: (v: unknown) => void;
    h.history.mockReturnValueOnce(new Promise((r) => (resolveHist = r)));
    await show(SID);
    emit(msg([job({ state: 'done', tail: '最终回答' })]));
    expect(last!.delegates).toHaveLength(1);
    await act(async () => { resolveHist({ version: 'v1', entries: bgEntries }); await new Promise((r) => setTimeout(r, 0)); });
    expect(run()).toMatchObject({ status: 'done', background: true });
    expect(run().turn.answer).toBe('最终回答');
  });

  it('历史载入后还没收到快照：后台委派保持运行；收到空快照 → 丢失', async () => {
    h.history.mockResolvedValueOnce({ version: 'v1', entries: bgEntries });
    await show(SID);
    expect(last!.delegatesKnown).toBe(false);
    expect(run().status).toBe('running');
    emit(msg([]));
    expect(last!.delegatesKnown).toBe(true);
    expect(run().status).toBe('error');
  });

  it('快照里仍在运行：保持运行，之后结束的快照落定', async () => {
    h.history.mockResolvedValueOnce({ version: 'v1', entries: bgEntries });
    await show(SID);
    emit(msg([job()]));
    expect(run().status).toBe('running');
    emit(msg([job({ state: 'done', tail: 'ok' })]));
    expect(run().status).toBe('done');
  });
});
