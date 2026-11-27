import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodexPool } from './delegate/codexAppServer.js';

// 真子进程集成：fake-codex.cjs 讲 app-server 协议，由 .cmd / .sh 包装，覆盖 spawnSpec、按行读取（含 UTF-8 被拆成两段）、interrupt、退出处理。
const FAKE = String.raw`
const rl = require('readline').createInterface({ input: process.stdin });
let n = 0;
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
rl.on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined || m.id === undefined) return;
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: {} });
  if (m.method === 'thread/start') return out({ jsonrpc: '2.0', id: m.id, result: { thread: { id: 'real-' + (++n) }, model: 'fake', reasoningEffort: 'low' } });
  if (m.method === 'thread/resume') return out({ jsonrpc: '2.0', id: m.id, result: { thread: { id: m.params.threadId }, model: 'fake', reasoningEffort: 'low' } });
  if (m.method === 'turn/start') {
    const th = m.params.threadId;
    const text = m.params.input[0].text;
    out({ jsonrpc: '2.0', id: m.id, result: { turn: { id: 'tu', status: 'inProgress' } } });
    if (text.includes('挂起')) return;
    if (text.includes('退出')) process.exit(7);
    // 把一行 JSON 里的多字节字符拆成两个 chunk 写出
    const buf = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { threadId: th, turnId: 'tu', itemId: 'a', delta: '你好，世界' } }) + '\n');
    const cut = buf.indexOf(Buffer.from('好')) + 1;
    process.stdout.write(buf.subarray(0, cut));
    setTimeout(() => {
      process.stdout.write(buf.subarray(cut));
      out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: th, turn: { id: 'tu', status: 'completed' } } });
    }, 20);
    return;
  }
  if (m.method === 'turn/interrupt') {
    out({ jsonrpc: '2.0', id: m.id, result: {} });
    return out({ jsonrpc: '2.0', method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'tu', status: 'interrupted' } } });
  }
  out({ jsonrpc: '2.0', id: m.id, result: {} });
});
`;

let dir = '';
let exe = '';
const pools: CodexPool[] = [];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cosyee-fake-codex-'));
  writeFileSync(join(dir, 'fake-codex.cjs'), FAKE);
  if (process.platform === 'win32') {
    exe = join(dir, 'codex.cmd');
    writeFileSync(exe, `@echo off\r\n"${process.execPath}" "%~dp0fake-codex.cjs" %*\r\n`);
  } else {
    exe = join(dir, 'codex');
    writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-codex.cjs" "$@"\n`);
    chmodSync(exe, 0o755);
  }
});
afterAll(() => {
  for (const p of pools) p.dispose(true);
  rmSync(dir, { recursive: true, force: true });
});

function mk(opts: ConstructorParameters<typeof CodexPool>[0] = {}) {
  const p = new CodexPool({ firstUpdateMs: 15_000, cancelGraceMs: 3000, ...opts });
  pools.push(p);
  return p;
}
const run = (pool: CodexPool, prompt: string, signal = new AbortController().signal, extra: object = {}) =>
  pool.run({ execPath: exe, cwd: dir, prompt, signal, ...extra } as any);

describe('Codex app-server 真子进程', () => {
  it('完整一轮：UTF-8 多字节被拆成两个 chunk 也不乱码', async () => {
    const pool = mk();
    const r = await run(pool, '说话');
    expect(r.response).toBe('你好，世界');
    expect(r.stopReason).toBe('end_turn');
    expect(r.sessionId).toBe('real-1');
    const r2 = await run(pool, '再说', undefined, { sessionId: r.sessionId });
    expect(r2.sessionId).toBe('real-1');
  }, 30_000);

  it('取消：interrupt 后收到 interrupted，抛已取消', async () => {
    const pool = mk();
    const ac = new AbortController();
    const p = run(pool, '挂起', ac.signal);
    await new Promise((r) => setTimeout(r, 800));
    ac.abort();
    await expect(p).rejects.toThrow('已取消');
    expect(pool.runningCount()).toBe(0);
  }, 30_000);

  it('子进程中途退出：重试一次后仍退出 → 报错且不挂起', async () => {
    const pool = mk();
    const e = await run(pool, '退出').catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(String(e.message)).toContain('意外退出');
    expect(pool.stats().processes).toBe(0);
  }, 30_000);

  it('dispose 杀掉子进程树', async () => {
    const pool = mk();
    await run(pool, '说话');
    expect(pool.stats().processes).toBe(1);
    pool.dispose(true);
    expect(pool.stats().processes).toBe(0);
  }, 30_000);
});
