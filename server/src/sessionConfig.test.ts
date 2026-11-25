// 每个会话的配置（模型 / 强度）：持久化到 state.json、随会话列表下发、旧会话从记录里推断模型。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { encodeCwd } from './paths.js';
import { type RunningServer, startServer } from './server.js';
import { scanLines } from './transcript.js';
import { StateStore } from './workspaces.js';

const A = '356bef19-b6ff-4428-a37c-12134e4e2bfd';
const B = '11111111-2222-4333-8444-555555555555';

let tmp: string;
let wsDir: string;
let prevClaude: string | undefined;
let prevHome: string | undefined;
let srv: RunningServer;
let stateFile: string;

const line = (o: unknown) => JSON.stringify(o) + '\n';
const user = (text: string) => line({ type: 'user', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text } });
const asst = (model: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'assistant', timestamp: '2026-01-01T00:00:01Z', ...extra, message: { id: 'm', model, role: 'assistant', content: [{ type: 'text', text: 'hi' }] } });

function putSession(id: string, body: string): void {
  const dir = path.join(tmp, 'claude', 'projects', encodeCwd(wsDir));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), body);
}

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-cfg-'));
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  prevHome = process.env.COSYEE_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.COSYEE_HOME = path.join(tmp, 'home');
  wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  // A：旧会话，没有配置记录；主线程最后一条 assistant 是 sonnet，子代理（sidechain）与 synthetic 不算
  putSession(A, user('hello') + asst('claude-opus-5-5') + user('again') + asst('claude-sonnet-5-5-20260101') + asst('claude-haiku-5-5', { isSidechain: true }) + asst('<synthetic>'));
  putSession(B, user('hello b') + asst('claude-opus-5-5'));
  stateFile = path.join(tmp, 'state.json');
  srv = await startServer({ port: 0, webDist: null, stateFile });
  srv.workspaces.add(wsDir);
});

afterAll(async () => {
  await srv.stop();
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  if (prevHome === undefined) delete process.env.COSYEE_HOME;
  else process.env.COSYEE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const list = async (): Promise<Array<{ id: string; config?: unknown; lastModel?: string }>> =>
  (await fetch(`http://127.0.0.1:${srv.port}/api/sessions?cwd=${encodeURIComponent(wsDir)}`)).json() as never;

describe('transcript 扫描：最后一条主线程 assistant 的模型', () => {
  it('跳过 sidechain 与 synthetic', () => {
    const s = scanLines([
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5' } }),
      JSON.stringify({ type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } }),
      JSON.stringify({ type: 'assistant', message: { model: '<synthetic>' } }),
    ]);
    expect(s.model).toBe('claude-opus-5-5');
  });
});

describe('会话配置持久化与下发', () => {
  it('没有记录的旧会话带 lastModel（最后一条主线程 assistant 的模型），不带 config', async () => {
    const rows = await list();
    const a = rows.find((r) => r.id === A)!;
    expect(a.config).toBeUndefined();
    expect(a.lastModel).toBe('claude-sonnet-5-5-20260101');
  });

  it('WS config 消息：没有进程也记下；列表带 config，且优先于推断；落盘；其它会话不受影响', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await new Promise((r) => ws.on('open', r));
    const errs: unknown[] = [];
    ws.on('message', (d) => { const m = JSON.parse(d.toString()); if (m.t === 'error') errs.push(m); });
    ws.send(JSON.stringify({ t: 'config', sessionId: A, config: { model: 'opus', effort: 'xhigh', ultracode: true } }));
    ws.send(JSON.stringify({ t: 'config', sessionId: B, config: { model: 'haiku', effort: 'low' } }));
    const start = Date.now();
    while (!srv.store.state.sessionConfigs[B] && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    expect(errs).toEqual([]);
    const rows = await list();
    expect(rows.find((r) => r.id === A)).toMatchObject({ config: { model: 'opus', effort: 'xhigh', ultracode: true } });
    expect(rows.find((r) => r.id === A)!.lastModel).toBeUndefined();
    expect(rows.find((r) => r.id === B)).toMatchObject({ config: { model: 'haiku', effort: 'low' } });
    await srv.store.idle();
    const reloaded = new StateStore(stateFile);
    expect(reloaded.state.sessionConfigs[A]).toEqual({ model: 'opus', effort: 'xhigh', ultracode: true });
    expect(reloaded.state.sessionConfigs[B]).toEqual({ model: 'haiku', effort: 'low' });
  });

  it('非法配置被拒绝，不写入', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    await new Promise((r) => ws.on('open', r));
    const msgs: Array<{ t: string }> = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ t: 'config', sessionId: A, config: { model: 'bad model!', effort: 'low' } }));
    const start = Date.now();
    while (!msgs.some((m) => m.t === 'error') && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    expect(msgs.some((m) => m.t === 'error')).toBe(true);
    expect(srv.store.state.sessionConfigs[A]!.model).toBe('opus');
  });
});

describe('state.json 清洗', () => {
  it('丢弃不合法的 sessionConfigs / disabledTools 条目', async () => {
    const f = path.join(tmp, 'dirty.json');
    fs.writeFileSync(f, JSON.stringify({
      sessionConfigs: {
        [A]: { model: 'opus', effort: 'high' },
        '../x': { model: 'opus', effort: 'high' },
        [B]: { model: 'opus', effort: 'bogus' },
      },
      disabledTools: ['WebFetch', 'mcp__a__b', 'bad name', 'WebFetch', 3, 'mcp__cosyee__delegate'],
      knownTools: ['Bash', 'mcp__a__b', 'Read', 'Bash', null, 'mcp__cosyee__delegate'],
    }));
    const s = new StateStore(f).state;
    expect(Object.keys(s.sessionConfigs)).toEqual([A]);
    // Cosyee 自带的 mcp__cosyee__* 归工具面板管，其它 mcp__ 不收
    expect(s.disabledTools).toEqual(['WebFetch', 'mcp__cosyee__delegate']);
    expect(s.knownTools).toEqual(['Bash', 'Read', 'mcp__cosyee__delegate']);
  });
});
