// 系统选择窗口的锁：客户端中途断开要关掉窗口并放开锁，否则之后「打开文件夹」一直 409
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const calls: { mode?: string; signal?: AbortSignal }[] = [];
vi.mock('./picker/index.js', () => ({
  supportsMixed: true,
  // 模拟一直开着的选择窗口：只有 abort 才结束
  pick: (o: { mode?: string; signal?: AbortSignal }) => {
    calls.push(o);
    return new Promise((_resolve, reject) => {
      o.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  },
}));

const { startServer } = await import('./server.js');
type RunningServer = Awaited<ReturnType<typeof startServer>>;

let tmp: string;
let srv: RunningServer;
let port: number;
let prevClaude: string | undefined;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-picklock-'));
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  srv = await startServer({ port: 0, webDist: null, stateFile: path.join(tmp, 'state.json') });
  port = srv.port;
});
afterAll(async () => {
  await srv.stop();
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 发出 POST 但不等响应；返回用来中途断开的 destroy */
function postAndHang(route: string, body: unknown): () => void {
  const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: route, headers: { 'content-type': 'application/json' } });
  r.on('error', () => {});
  r.end(JSON.stringify(body));
  return () => r.destroy();
}

const postJson = (route: string, body: unknown) =>
  fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('选择窗口锁', () => {
  it('附件选择窗口开着时打开文件夹 409；客户端断开后窗口被关掉、锁放开', async () => {
    const hang = postAndHang('/api/pick', { mode: 'mixed' });
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect((await postJson('/api/workspaces/pick', {})).status).toBe(409);

    hang();
    await vi.waitFor(() => expect(calls[0]!.signal!.aborted).toBe(true));

    // 锁已放开：工作空间选择窗口能打开（模拟窗口照样挂着，这里也中途断开收尾）
    const hang2 = postAndHang('/api/workspaces/pick', {});
    await vi.waitFor(() => expect(calls.length).toBe(2));
    expect(calls[1]!.mode).toBe('folders');
    hang2();
    await vi.waitFor(() => expect(calls[1]!.signal!.aborted).toBe(true));
  });
});
