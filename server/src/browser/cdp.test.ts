import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { cdpNavigate } from './manager.js';

type Reply = (msg: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }, ws: WebSocket) => void;

describe('cdpNavigate', () => {
  let wss: WebSocketServer | null = null;
  afterEach(() => {
    wss?.close();
    wss = null;
  });

  /** 假的 CDP 服务：收到的命令记下来，按 reply 回 */
  const serve = async (reply: Reply) => {
    const seen: { method: string; params?: Record<string, unknown>; sessionId?: string }[] = [];
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => wss!.once('listening', r));
    wss.on('connection', (ws) =>
      ws.on('message', (d) => {
        const m = JSON.parse(String(d)) as Parameters<Reply>[0];
        seen.push({ method: m.method, params: m.params, sessionId: m.sessionId });
        reply(m, ws);
      }),
    );
    return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/devtools/browser/x`, seen };
  };
  const ok: Reply = (m, ws) => {
    if (m.method === 'Target.attachToTarget') ws.send(JSON.stringify({ id: m.id, result: { sessionId: 'S1' } }));
    if (m.method === 'Page.navigate') ws.send(JSON.stringify({ id: m.id, result: { frameId: 'F', loaderId: 'L' } }));
  };

  it('接上页面后在同一会话里发 Page.navigate', async () => {
    const s = await serve(ok);
    await expect(cdpNavigate(s.url, 'T1', 'https://example.com/')).resolves.toEqual({ errorText: null });
    expect(s.seen).toEqual([
      { method: 'Target.attachToTarget', params: { targetId: 'T1', flatten: true }, sessionId: undefined },
      { method: 'Page.navigate', params: { url: 'https://example.com/' }, sessionId: 'S1' },
    ]);
  });

  it('Chrome 报的导航错误原样返回', async () => {
    const s = await serve((m, ws) => {
      if (m.method === 'Page.navigate') ws.send(JSON.stringify({ id: m.id, result: { frameId: 'F', errorText: 'net::ERR_NAME_NOT_RESOLVED' } }));
      else ok(m, ws);
    });
    await expect(cdpNavigate(s.url, 'T1', 'https://x.invalid/')).resolves.toEqual({ errorText: 'net::ERR_NAME_NOT_RESOLVED' });
  });

  it('接不上页面、命令被拒、连不上：返回 null（调用方退回 CLI）', async () => {
    const noTarget = await serve((m, ws) => ws.send(JSON.stringify({ id: m.id, error: { message: 'No target with given id' } })));
    await expect(cdpNavigate(noTarget.url, 'T1', 'https://example.com/')).resolves.toBeNull();
    wss!.close();
    const rejected = await serve((m, ws) => {
      if (m.method === 'Page.navigate') ws.send(JSON.stringify({ id: m.id, error: { message: 'nope' } }));
      else ok(m, ws);
    });
    await expect(cdpNavigate(rejected.url, 'T1', 'https://example.com/')).resolves.toBeNull();
    wss!.close();
    wss = null;
    await expect(cdpNavigate('ws://127.0.0.1:1/devtools/browser/x', 'T1', 'https://example.com/')).resolves.toBeNull();
  });

  it('导航发出后服务器迟迟不响应：到时限就当已发出，不报错', async () => {
    const s = await serve((m, ws) => {
      if (m.method === 'Target.attachToTarget') ok(m, ws);
    });
    await expect(cdpNavigate(s.url, 'T1', 'https://slow.example/', { navMs: 50 })).resolves.toEqual({ errorText: null });
  });
});
