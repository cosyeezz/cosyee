// 内置工具的启用 / 停用：POST /api/tools 校验、落盘、启动时经 --settings 的 permissions.deny 下发、
// 运行中经 apply_flag_settings 整体替换，并随上下文用量带给前端。用假 claude 记录收到的参数与控制请求。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type RunningServer, startServer } from './server.js';

let tmp: string;
let srv: RunningServer;
let stateFile: string;
let logFile: string;
let cwd: string;
const saved: Record<string, string | undefined> = {};

const FAKE = String.raw`
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_LOG, 'ARGS ' + JSON.stringify(process.argv.slice(2)) + '\n');
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.type !== 'control_request') continue;
    const sub = m.request.subtype;
    fs.appendFileSync(process.env.FAKE_LOG, 'CTRL ' + sub + ' ' + JSON.stringify(m.request.settings || null) + '\n');
    let body = {};
    if (sub === 'get_context_usage') body = { categories: [], totalTokens: 10, maxTokens: 100, percentage: 10 };
    process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: body } }) + '\n');
  }
});
`;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-tools-'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_HOME', 'COSYEE_CLAUDE', 'FAKE_LOG']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.COSYEE_HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  logFile = path.join(tmp, 'log.txt');
  process.env.FAKE_LOG = logFile;
  cwd = path.join(tmp, 'ws');
  fs.mkdirSync(cwd, { recursive: true });
  const js = path.join(tmp, 'fake.cjs');
  fs.writeFileSync(js, FAKE);
  if (process.platform === 'win32') {
    const cmd = path.join(tmp, 'fake.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "${js}" %*\r\n`);
    process.env.COSYEE_CLAUDE = cmd;
  } else {
    const sh = path.join(tmp, 'fake.sh');
    fs.writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${js}" "$@"\n`, { mode: 0o755 });
    process.env.COSYEE_CLAUDE = sh;
  }
  stateFile = path.join(tmp, 'state.json');
  srv = await startServer({ port: 0, webDist: null, stateFile });
  srv.workspaces.add(cwd);
});

afterAll(async () => {
  await srv.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = (p: string, body: unknown) =>
  fetch(`http://127.0.0.1:${srv.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const log = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : []);
/** 状态文件是异步落盘的：等到内容满足条件 */
const savedTools = (want: string[]) =>
  vi.waitFor(() => {
    const o = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { disabledTools?: string[] };
    expect(o.disabledTools ?? []).toEqual(want);
  });
const SID = '0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a11';

describe('POST /api/tools', () => {
  it('校验：非法工具名（含 mcp__ 前缀）与非布尔 enabled 返回 400，不落盘', async () => {
    expect((await post('/api/tools', { name: 'mcp__github__search', enabled: false })).status).toBe(400);
    expect((await post('/api/tools', { name: 'a b', enabled: false })).status).toBe(400);
    expect((await post('/api/tools', { name: 'WebFetch', enabled: 'no' })).status).toBe(400);
    expect((await post('/api/tools', {})).status).toBe(400);
    expect(fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')).disabledTools ?? [] : []).toEqual([]);
  });

  it('停用后落盘；重复停用不重复；启动的进程经 --settings 带上 permissions.deny，并随上下文下发', async () => {
    const r = await post('/api/tools', { name: 'WebFetch', enabled: false });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { disabledTools: string[] }).disabledTools).toEqual(['WebFetch']);
    await post('/api/tools', { name: 'WebFetch', enabled: false });
    await savedTools(['WebFetch']);

    const ctx = (await (await post(`/api/context/${SID}/refresh`, { cwd, draft: true })).json()) as { disabledTools?: string[] };
    expect(ctx.disabledTools).toEqual(['WebFetch']);
    const args = log().find((l) => l.startsWith('ARGS '))!;
    const argv = JSON.parse(args.slice(5)) as string[];
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1]!) as { permissions?: { deny?: string[] } };
    expect(settings.permissions?.deny).toEqual(['WebFetch']);
  }, 30_000);

  it('运行中的进程立即收到完整名单（整体替换）；重新启用后名单收缩，清空时下发空数组', async () => {
    const applies = () =>
      log().filter((l) => l.startsWith('CTRL apply_flag_settings ')).map((l) => JSON.parse(l.slice('CTRL apply_flag_settings '.length)) as { permissions: { deny: string[] } });
    const before = applies().length;
    await post('/api/tools', { name: 'Glob', enabled: false });
    expect(applies().slice(before).pop()?.permissions.deny).toEqual(['WebFetch', 'Glob']);
    await post('/api/tools', { name: 'WebFetch', enabled: true });
    expect(applies().pop()?.permissions.deny).toEqual(['Glob']);
    await post('/api/tools', { name: 'Glob', enabled: true });
    expect(applies().pop()?.permissions.deny).toEqual([]);
    await savedTools([]);
    // 本来就是启用状态：不再下发
    const n = applies().length;
    await post('/api/tools', { name: 'Glob', enabled: true });
    expect(applies().length).toBe(n);
  }, 30_000);

  it('探测进程收不到 init：上下文带上落盘的 knownTools', async () => {
    srv.store.state.knownTools = ['Bash', 'Read'];
    const sid = '0b7f5d0e-1c1e-4e0a-9d49-6b1f3a0c9a12';
    const ctx = (await (await post(`/api/context/${sid}/refresh`, { cwd, draft: true })).json()) as { tools?: string[] };
    expect(ctx.tools).toEqual(['Bash', 'Read']);
  }, 30_000);
});
