// GET /api/models：按账号（account= / session= / 当前账号）取 CLI 报告的模型列表，各账号各自缓存、落盘；未知账号 404。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CliModelList } from '@cosyee/shared';
import { type RunningServer, startServer } from './server.js';

let tmp: string;
let srv: RunningServer;
const calls: (string | null)[] = [];
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-models-'));
  for (const k of ['CLAUDE_CONFIG_DIR', 'COSYEE_HOME']) saved[k] = process.env[k];
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.COSYEE_HOME = path.join(tmp, 'home');
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  const work = path.join(tmp, 'accounts', 'work1');
  fs.mkdirSync(work, { recursive: true });
  const stateFile = path.join(tmp, 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ accounts: { list: [{ id: 'work1', label: '工作', dir: work, createdAt: 1 }], active: null, mode: 'switch', sessions: {} } }));
  srv = await startServer({
    port: 0,
    webDist: null,
    stateFile,
    fetchCliModels: async (dir) => {
      calls.push(dir && path.basename(dir));
      const v = dir ? 'haiku' : 'opus';
      return { models: [{ value: v, displayName: v }], cli: 'test' };
    },
  });
});

afterAll(async () => {
  await srv.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async (q: string) => {
  const r = await fetch(`http://127.0.0.1:${srv.port}/api/models${q}`);
  return { status: r.status, body: (await r.json()) as CliModelList | null };
};

describe('GET /api/models', () => {
  it('未知账号 404', async () => {
    expect((await get('?account=nope1234')).status).toBe(404);
  });

  it('各账号分别拉取、各自缓存；不带参数 = 当前账号', async () => {
    expect((await get('?account=work1')).body?.models[0]!.value).toBe('haiku');
    expect((await get('?account=default')).body?.models[0]!.value).toBe('opus');
    expect((await get('')).body?.models[0]!.value).toBe('opus');
    await get('?account=work1');
    expect(calls).toEqual(['work1', null]);
  });

  it('落盘到 state.json 同目录的 cli-models.json，只有模型字段', () => {
    const disk = JSON.parse(fs.readFileSync(path.join(tmp, 'cli-models.json'), 'utf8'));
    expect(Object.keys(disk).sort()).toEqual(['default', 'work1']);
    expect(disk.work1.models).toEqual([{ value: 'haiku', displayName: 'haiku' }]);
  });
});
