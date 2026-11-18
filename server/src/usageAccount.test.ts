// GET /api/usage?account=：按账号取额度，各账号各自缓存；未知账号 404。用假 claude 按 CLAUDE_CONFIG_DIR 区分账号。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RunningServer, startServer } from './server.js';

let tmp: string;
let srv: RunningServer;
let counter: string;
const saved: Record<string, string | undefined> = {};

const FAKE = String.raw`
const fs = require('fs');
const path = require('path');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'control_request' || m.request.subtype !== 'get_usage') continue;
    const dir = process.env.CLAUDE_CONFIG_DIR || 'default';
    fs.appendFileSync(process.env.FAKE_COUNTER, path.basename(dir) + '\n');
    const percent = path.basename(dir) === 'work1' ? 42 : 7;
    const out = { type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: { rate_limits_available: true, rate_limits: { limits: [{ kind: 'session', percent, resets_at: '2030-01-01T00:00:00Z' }] } } } };
    process.stdout.write(JSON.stringify(out) + '\n');
  }
});
`;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-usage-'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_HOME', 'COSYEE_CLAUDE', 'FAKE_COUNTER']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.COSYEE_HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  counter = path.join(tmp, 'counter.txt');
  process.env.FAKE_COUNTER = counter;
  const js = path.join(tmp, 'fake.cjs');
  fs.writeFileSync(js, FAKE);
  if (process.platform === 'win32') {
    const cmd = path.join(tmp, 'fake.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}"\r\n`);
    process.env.COSYEE_CLAUDE = cmd;
  } else {
    const sh = path.join(tmp, 'fake.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}"\n`, { mode: 0o755 });
    process.env.COSYEE_CLAUDE = sh;
  }
  const work = path.join(tmp, 'accounts', 'work1');
  fs.mkdirSync(work, { recursive: true });
  const stateFile = path.join(tmp, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ accounts: { list: [{ id: 'work1', label: '工作', dir: work, createdAt: 1 }], active: null, mode: 'switch', sessions: {} } }));
  srv = await startServer({ port: 0, webDist: null, stateFile });
});

afterAll(async () => {
  await srv.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = (q: string) => fetch(`http://127.0.0.1:${srv.port}/api/usage${q}`);
const runs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').split('\n').filter(Boolean) : []);

describe('GET /api/usage?account=', () => {
  it('未知账号 404', async () => {
    const r = await get('?account=nope1234');
    expect(r.status).toBe(404);
  });

  it('各账号分别取额度并各自缓存', async () => {
    const w = (await (await get('?account=work1')).json()) as { limits: Array<{ percent: number }> };
    expect(w.limits[0]!.percent).toBe(42);
    const d = (await (await get('?account=default')).json()) as { limits: Array<{ percent: number }> };
    expect(d.limits[0]!.percent).toBe(7);
    // 再取一次都走缓存，不再起进程
    await get('?account=work1');
    await get('?account=default');
    expect(runs().sort()).toEqual(['claude', 'work1']);
  }, 30_000);
});
