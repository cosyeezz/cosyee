// 进程内起真实 HTTP + WS 服务（随机端口、临时 state / 配置目录），测鉴权、Origin、路由与静态托管。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { WebSocket } from 'ws';
import { sendJsonMaybeGzip } from './http.js';
import { type Command, revealFileCommand } from './reveal.js';
import { type RunningServer, startServer } from './server.js';

let tmp: string;
let web: string;
let srv: RunningServer;
let base: string;
let prevEnv: string | undefined;
let prevHome: string | undefined;
let prevHost: string | undefined;

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-http-'));
  web = path.join(tmp, 'web');
  fs.mkdirSync(path.join(web, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(web, 'index.html'), '<html>INDEX</html>');
  fs.writeFileSync(path.join(web, 'assets', 'a.js'), 'console.log(1)');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'SECRET');
  prevEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  prevHome = process.env.COSYEE_HOME;
  process.env.COSYEE_HOME = path.join(tmp, 'home');
  prevHost = process.env.COSYEE_HOST;
  delete process.env.COSYEE_HOST;
  srv = await startServer({ port: 0, webDist: web, stateFile: path.join(tmp, 'state.json') });
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(async () => {
  await srv.stop();
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevEnv;
  if (prevHome === undefined) delete process.env.COSYEE_HOME;
  else process.env.COSYEE_HOME = prevHome;
  if (prevHost === undefined) delete process.env.COSYEE_HOST;
  else process.env.COSYEE_HOST = prevHost;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const auth: Record<string, string> = {};

/** fetch 不允许自定义 Host / 原始路径，穿越测试用原生 http。 */
function rawGet(p: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, path: p, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('无 token 访问', () => {
  it('不带任何凭据的 API 请求直接 200', async () => {
    expect((await fetch(`${base}/api/bootstrap`)).status).toBe(200);
  });
  it('预览 raw 未知令牌 404', async () => {
    expect((await fetch(`${base}/api/preview/zzz/raw`)).status).toBe(404);
  });
});

describe('Origin', () => {
  it('白名单外 403，白名单内放行', async () => {
    const bad = await fetch(`${base}/api/bootstrap`, { headers: { ...auth, Origin: 'http://evil.com' } });
    expect(bad.status).toBe(403);
    const ok = await fetch(`${base}/api/bootstrap`, { headers: { ...auth, Origin: 'http://127.0.0.1:5273' } });
    expect(ok.status).toBe(200);
  });
  it('Host 非回环 403', async () => {
    const r = await rawGet('/api/bootstrap', { ...auth, Host: 'evil.com' });
    expect(r.status).toBe(403);
  });
});

describe('REST', () => {
  it('subagents：默认值与状态；整体提交；不合法 400；旧接口 404', async () => {
    const url = `${base}/api/subagents`;
    const post = (b: unknown) => fetch(url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const get = async () => (await fetch(url, { headers: auth })).json() as Promise<any>;
    const init = await get();
    expect(init.config).toEqual({
      mode: 'native',
      native: { model: 'sonnet', effort: 'medium' },
      delegate: { default: null },
    });
    expect(Array.isArray(init.accounts)).toBe(true);
    expect(init.routeFallbacks).toEqual({});
    expect(init.effective).toBe('native');
    const next = {
      mode: 'delegate',
      native: { model: 'opus', effort: 'high' },
      delegate: {
        default: { backend: 'claude', accountId: 'default', model: 'haiku', effort: 'low' },
        agents: {
          Explore: { backend: 'agy', accountId: 'agy1', model: 'gemini-4-neon', effort: 'low' },
        },
      },
    };
    const r = await (await post(next)).json() as any;
    expect(r.ok).toBe(true);
    expect(r.state.config).toEqual(next);
    expect((await get()).config).toEqual(next);
    expect((await post({ ...next, native: { model: 'x', effort: 'high' } })).status).toBe(400);
    expect((await post({ ...next, mode: 'bad' })).status).toBe(400);
    expect((await get()).config).toEqual(next);
    expect((await fetch(`${base}/api/agent-models`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/agent-models`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await fetch(`${base}/api/native-agents`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{"enabled":false}' })).status).toBe(404);
    // 非法方法（PUT / DELETE）、非法 JSON、非对象 JSON、缺字段、错误类型、超大 body
    expect((await fetch(url, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(next) })).status).toBe(404);
    expect((await fetch(url, { method: 'DELETE', headers: auth })).status).toBe(404);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{bad json' })).status).toBe(400);
    expect((await fetch(url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '' })).status).toBe(400);
    for (const bad of [
      null,
      [],
      'claude',
      123,
      { mode: 'native' },
      { ...next, native: null },
      { ...next, delegate: [] },
      { ...next, delegate: { default: { backend: 'bad', accountId: 'default', model: null, effort: null } } },
    ]) {
      expect((await post(bad)).status).toBe(400);
    }
    expect(
      (await fetch(url, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ ...next, delegate: { default: { backend: 'agy', accountId: 'agy1', model: 'x'.repeat(1024 * 1024 + 10), effort: null } } }),
      })).status,
    ).toBe(413);
    // 返回结构与 SubagentState 协议一致，且确实落盘到 state.json
    const after = await get();
    expect(after.config).toEqual(next);
    expect(Array.isArray(after.accounts)).toBe(true);
    expect(typeof after.routeFallbacks).toBe('object');
    expect(['native', 'delegate']).toContain(after.effective);
    await srv.store.idle();
    const persisted = JSON.parse(fs.readFileSync(path.join(tmp, 'state.json'), 'utf8')) as { subagents: unknown };
    expect(persisted.subagents).toEqual(next);
  });
  it('subagents 端到端：老 state.json 自动迁移 + 并发快速切换保持磁盘与内存一致', async () => {
    const sf = path.join(tmp, 'state-subagents-e2e.json');
    const agyDir = path.join(tmp, 'agy-e2e');
    fs.writeFileSync(
      sf,
      JSON.stringify({
        nativeAgents: false,
        agyAccounts: { list: [{ id: 'agy1', label: 'A', dir: agyDir, createdAt: 1 }], active: 'agy1' },
        agentModels: {
          claude: { model: 'opus', effort: 'high' },
          agy: { model: 'gemini-4-neon', effort: 'low' },
        },
      }),
    );
    const s = await startServer({ port: 0, webDist: null, stateFile: sf });
    try {
      const url = `http://127.0.0.1:${s.port}/api/subagents`;
      const init = (await (await fetch(url)).json()) as any;
      expect(init.config).toEqual({
        mode: 'delegate',
        native: { model: 'opus', effort: 'high' },
        delegate: { default: { backend: 'agy', accountId: 'agy1', model: 'gemini-4-neon', effort: 'low' } },
      });
      // 并发连续切换，验证不损坏 state.json 且 GET 与磁盘一致
      const mk = (mode: 'native' | 'delegate', backend: 'claude' | 'agy' = 'claude') => ({
        ...init.config,
        mode,
        delegate: { default: { backend, accountId: backend === 'agy' ? 'agy1' : 'default', model: null, effort: null } },
      });
      const resps = await Promise.all([
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mk('delegate', 'claude')) }),
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mk('native')) }),
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mk('delegate', 'agy')) }),
        fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mk('delegate', 'claude')) }),
      ]);
      expect(resps.every((r) => r.status === 200)).toBe(true);
      await s.store.idle();
      const got = (await (await fetch(url)).json()) as any;
      const onDisk = JSON.parse(fs.readFileSync(sf, 'utf8')) as { subagents: unknown; agentModels?: unknown; nativeAgents?: unknown };
      expect(onDisk.subagents).toEqual(got.config);
      expect(onDisk.agentModels).toBeUndefined();
      expect(onDisk.nativeAgents).toBeUndefined();
    } finally {
      await s.stop();
    }
  });
  it('bootstrap', async () => {
    const j = (await (await fetch(`${base}/api/bootstrap`, { headers: auth })).json()) as any;
    expect(j.version).toBe('0.1.0');
    expect(j.platform).toBe(process.platform);
    expect(j.defaults).toEqual({ model: 'sonnet', effort: 'medium' });
    expect(typeof j.supportsMixedPick).toBe('boolean');
  });
  it('未知接口 404；缺 cwd 400', async () => {
    expect((await fetch(`${base}/api/nope`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/sessions`, { headers: auth })).status).toBe(400);
  });
  it('工作空间：设为当前后可读回；不存在的目录 400', async () => {
    const dir = path.join(tmp, 'ws1');
    fs.mkdirSync(dir);
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post('/api/workspaces/current', { path: dir })).status).toBe(200);
    const j = (await (await fetch(`${base}/api/workspaces`, { headers: auth })).json()) as any;
    expect(j.current).toBe(path.normalize(dir));
    expect(j.list).toHaveLength(1);
    expect((await post('/api/workspaces/current', { path: path.join(tmp, 'missing') })).status).toBe(400);
  });
  it('会话列表：没有记录时为空数组', async () => {
    const r = await fetch(`${base}/api/sessions?cwd=${encodeURIComponent(path.join(tmp, 'ws1'))}`, { headers: auth });
    expect(await r.json()).toEqual([]);
  });
  it('GET /api/pricing 返回价格表（测试里不联网，是内置表）', async () => {
    const t = await (await fetch(`${base}/api/pricing`, { headers: auth })).json();
    expect(t.source).toBe('builtin');
    expect(t.models.some((m: { id: string }) => m.id === 'claude-opus-5-5')).toBe(true);
  });
  it('子代理花费：缺 cwd 400；会话不存在 404', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect((await fetch(`${base}/api/sessions/${id}/subagent-costs`, { headers: auth })).status).toBe(400);
    const cwd = encodeURIComponent(path.join(tmp, 'ws1'));
    expect((await fetch(`${base}/api/sessions/${id}/subagent-costs?cwd=${cwd}`, { headers: auth })).status).toBe(404);
  });
  it('GET /api/sessions/:id/detail：缺 cwd 400；不存在 404；正常返回且文件变更后更新', async () => {
    const id = '11111111-2222-4333-8444-888888888888';
    const ws = path.join(tmp, 'ws1');
    const cwd = encodeURIComponent(ws);
    expect((await fetch(`${base}/api/sessions/${id}/detail`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/sessions/${id}/detail?cwd=${cwd}`, { headers: auth })).status).toBe(404);

    const dir = path.join(tmp, 'claude', 'projects', 'detail-http-test');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'user', uuid: 'u1', parentUuid: null, timestamp: '2026-01-01T00:00:00Z', gitBranch: 'main', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: '2026-01-01T00:00:01Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: '世界' }], usage: { input_tokens: 42 } } }),
    ].join('\n') + '\n');

    const r1 = await fetch(`${base}/api/sessions/${id}/detail?cwd=${cwd}`, { headers: auth });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toMatchObject({ userMessages: 1, firstPrompt: '你好', lastPrompt: null, lastReply: '世界', model: 'claude-sonnet-5-5', branch: 'main', contextTokens: 42 });

    fs.appendFileSync(file, JSON.stringify({ type: 'user', uuid: 'u2', parentUuid: 'a1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'user', content: '再问一句' } }) + '\n');
    const r2 = await fetch(`${base}/api/sessions/${id}/detail?cwd=${cwd}`, { headers: auth });
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ userMessages: 2, firstPrompt: '你好', lastPrompt: '再问一句' });
  });
  it('context 缓存没有时为 null', async () => {
    const r = await fetch(`${base}/api/context/11111111-2222-4333-8444-555555555555`, { headers: auth });
    expect(await r.json()).toBeNull();
  });
  it('新会话草稿刷新上下文：缺 cwd / cwd 不是已打开的工作空间 400；非草稿且没有记录 404', async () => {
    const id = '11111111-2222-4333-8444-666666666666';
    const post = (p: string, body: unknown) =>
      fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const other = path.join(tmp, 'not-a-workspace');
    fs.mkdirSync(other, { recursive: true });
    expect((await post(`/api/context/${id}/refresh`, { draft: true })).status).toBe(400);
    expect((await post(`/api/context/${id}/refresh`, { draft: true, cwd: other })).status).toBe(400);
    expect((await post(`/api/context/${id}/mcp`, { server: 's', enabled: true, draft: true, cwd: other })).status).toBe(400);
    expect((await post(`/api/context/${id}/refresh`, { cwd: path.join(tmp, 'ws1') })).status).toBe(404);
  });
  it('POST /api/exec：会话 id 不合法 400；找不到工作目录 404；在工作空间里运行代码块', async () => {
    const post = (body: unknown) =>
      fetch(`${base}/api/exec`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const id = '11111111-2222-4333-8444-777777777777';
    const ws = path.join(tmp, 'ws1');
    expect((await post({ session: '../x', lang: 'powershell', code: 'echo 1' })).status).toBe(400);
    expect((await post({ session: id, cwd: path.join(tmp, 'not-a-ws-exec'), lang: 'powershell', code: 'echo 1' })).status).toBe(404);
    expect((await post({ session: id, cwd: ws, lang: 'powershell', code: '  ' })).status).toBe(400);
    expect((await post({ session: id, cwd: ws, lang: 'python', code: 'print(1)' })).status).toBe(400);
    const lang = process.platform === 'win32' ? 'cmd' : 'sh';
    const r = await post({ session: id, cwd: ws, lang, code: 'echo exec-ok' });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { stdout: string; exitCode: number };
    expect(j.stdout).toContain('exec-ok');
    expect(j.exitCode).toBe(0);
  }, 30_000);
  it('POST /api/exec stream：按行返回输出和结束结果', async () => {
    const id = '11111111-2222-4333-8444-777777777777';
    const ws = path.join(tmp, 'ws1');
    const lang = process.platform === 'win32' ? 'cmd' : 'sh';
    const post = (body: unknown) =>
      fetch(`${base}/api/exec`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ session: id, cwd: ws, lang: 'python', code: 'print(1)', stream: true })).status).toBe(400);
    const r = await post({ session: id, cwd: ws, lang, code: 'echo stream-ok', stream: true });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('application/x-ndjson');
    const msgs = (await r.text()).trim().split('\n').map((l) => JSON.parse(l));
    expect(msgs.filter((m) => m.t === 'out').map((m) => m.data).join('')).toContain('stream-ok');
    const end = msgs[msgs.length - 1];
    expect(end.t).toBe('end');
    expect(end.result.exitCode).toBe(0);
    expect(end.result.stdout).toBe('');
  }, 30_000);
  it('请求体超过 1MB 返回 413', async () => {
    const r = await fetch(`${base}/api/workspaces/current`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'x'.repeat(1024 * 1024 + 10) }),
    });
    expect(r.status).toBe(413);
  });
  it('非法 JSON 400', async () => {
    const r = await fetch(`${base}/api/workspaces/current`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: '{bad' });
    expect(r.status).toBe(400);
  });
});

describe('粘贴图片 /api/pastes', () => {
  // 最小的合法文件头即可：服务端只按文件头判断类型
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16, 1)]);
  const post = (body: Buffer, type = 'image/png') =>
    fetch(`${base}/api/pastes`, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(body) });

  it('png 存入 pastes 目录，返回带预览令牌的图片项，且能读回', async () => {
    const r = await post(PNG);
    expect(r.status).toBe(200);
    const { item } = (await r.json()) as any;
    expect(item.kind).toBe('file');
    expect(item.isImage).toBe(true);
    expect(path.dirname(item.path)).toBe(path.join(tmp, 'home', 'pastes'));
    expect(item.path).toMatch(/paste-\d+-[0-9a-f]{12}\.png$/);
    expect(fs.readFileSync(item.path).equals(PNG)).toBe(true);
    const raw = await fetch(`${base}/api/preview/${item.previewToken}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
  });
  it('按文件名读回粘贴的图片（信息 + 内容）；名字不合格式 / 不存在 / 内容不是图片 404', async () => {
    const { item } = (await (await post(PNG)).json()) as any;
    const name = path.basename(item.path);
    const info = (await (await fetch(`${base}/api/pastes/${name}/info`)).json()) as any;
    expect(info).toMatchObject({ path: item.path, kind: 'file', size: PNG.length, isImage: true });
    const raw = await fetch(`${base}/api/pastes/${name}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await raw.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await fetch(`${base}/api/pastes/${encodeURIComponent('../state.json')}/raw`)).status).toBe(404);
    expect((await fetch(`${base}/api/pastes/paste-1-000000000000.png/raw`)).status).toBe(404);
    const fake = 'paste-2-000000000000.png';
    fs.writeFileSync(path.join(tmp, 'home', 'pastes', fake), 'not an image');
    expect((await fetch(`${base}/api/pastes/${fake}/info`)).status).toBe(404);
  });
  it('不是图片 / 类型与内容不符 415', async () => {
    expect((await post(Buffer.from('hello world, not an image'), 'text/plain')).status).toBe(415);
    expect((await post(PNG, 'image/jpeg')).status).toBe(415);
  });
  it('超过 20MB 返回 413', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]);
    expect((await post(big)).status).toBe(413);
  });
  it('白名单外的 Origin 403', async () => {
    const r = await fetch(`${base}/api/pastes`, { method: 'POST', headers: { 'content-type': 'image/png', Origin: 'http://evil.com' }, body: new Uint8Array(PNG) });
    expect(r.status).toBe(403);
  });
});

describe('静态托管', () => {
  it('index.html；SPA 回退；资源文件', async () => {
    const a = await fetch(`${base}/`);
    expect(a.status).toBe(200);
    expect(await a.text()).toContain('INDEX');
    const b = await fetch(`${base}/some/route`);
    expect(await b.text()).toContain('INDEX');
    const c = await fetch(`${base}/assets/a.js`);
    expect(c.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404);
  });
  it('路径穿越被拒绝', async () => {
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/assets/../../secret.txt', '/%2e%2e%5csecret.txt']) {
      const r = await rawGet(p);
      expect(r.body).not.toContain('SECRET');
    }
  });
});

describe('WebSocket', () => {
  const open = (url: string, headers: Record<string, string> = {}) =>
    new Promise<{ ok: boolean; ws: WebSocket; code?: number }>((resolve) => {
      const ws = new WebSocket(url, { headers });
      ws.on('open', () => resolve({ ok: true, ws }));
      ws.on('unexpected-response', (_req, res) => resolve({ ok: false, ws, code: res.statusCode }));
      ws.on('error', () => resolve({ ok: false, ws }));
    });

  it('Origin 不对 403；非 /ws 路径 404', async () => {
    const wsBase = `ws://127.0.0.1:${srv.port}`;
    expect((await open(`${wsBase}/ws`, { Origin: 'http://evil.com' })).code).toBe(403);
    expect((await open(`${wsBase}/other`)).code).toBe(404);
  });

  it('连接成功后 subscribe 返回 status idle；非法消息回 error', async () => {
    const { ok, ws } = await open(`ws://127.0.0.1:${srv.port}/ws`);
    expect(ok).toBe(true);
    const msgs: any[] = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
    ws.send(JSON.stringify({ t: 'subscribe', sessionId: '11111111-2222-4333-8444-555555555555' }));
    ws.send('not json');
    ws.send(JSON.stringify({ t: 'send', sessionId: 'bad id', cwd: 'x', text: 'x', config: { model: 'haiku', effort: 'low' }, isNew: true }));
    const start = Date.now();
    while (msgs.length < 3 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    ws.close();
    expect(msgs.find((m) => m.t === 'status')).toMatchObject({ status: 'idle' });
    expect(msgs.filter((m) => m.t === 'error')).toHaveLength(2);
  });
});

describe('桌面版 token（StartOptions.authToken）', () => {
  const TOKEN = 'test-token-0123456789abcdef';
  let s2: RunningServer;
  let b2: string;
  beforeAll(async () => {
    s2 = await startServer({ port: 0, webDist: web, stateFile: path.join(tmp, 'state2.json'), authToken: TOKEN, version: '9.9.9' });
    b2 = `http://127.0.0.1:${s2.port}`;
  });
  afterAll(async () => {
    await s2.stop();
  });
  const h = { 'x-cosyee-token': TOKEN };

  it('不带 / 带错 token：API、静态文件都是 403', async () => {
    expect((await fetch(`${b2}/api/bootstrap`)).status).toBe(403);
    expect((await fetch(`${b2}/api/bootstrap`, { headers: { 'x-cosyee-token': 'wrong' } })).status).toBe(403);
    expect((await fetch(`${b2}/`)).status).toBe(403);
    expect((await fetch(`${b2}/api/running`)).status).toBe(403);
  });
  it('带对 token 放行；version 来自 StartOptions', async () => {
    const r = await fetch(`${b2}/api/bootstrap`, { headers: h });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).version).toBe('9.9.9');
    expect(await (await fetch(`${b2}/`, { headers: h })).text()).toContain('INDEX');
  });
  it('/api/running 返回正在执行的会话数', async () => {
    const r = await fetch(`${b2}/api/running`, { headers: h });
    expect(await r.json()).toEqual({ count: 0 });
  });
  it('token 正确但 Origin 不对仍然 403', async () => {
    expect((await fetch(`${b2}/api/bootstrap`, { headers: { ...h, Origin: 'http://evil.com' } })).status).toBe(403);
  });
  it('WS 升级：无 token 403，有 token 成功', async () => {
    const open = (headers: Record<string, string>) =>
      new Promise<{ ok: boolean; ws: WebSocket; code?: number }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${s2.port}/ws`, { headers });
        ws.on('open', () => resolve({ ok: true, ws }));
        ws.on('unexpected-response', (_q, res) => resolve({ ok: false, ws, code: res.statusCode }));
        ws.on('error', () => resolve({ ok: false, ws }));
      });
    expect((await open({})).code).toBe(403);
    expect((await open({ 'x-cosyee-token': 'nope' })).code).toBe(403);
    const good = await open(h);
    expect(good.ok).toBe(true);
    good.ws.close();
  });
});

// 向指定地址发请求，可以伪造 Host 头（fetch 不允许改 Host）
function rawGet2(opts: { host: string; port: number; headers: Record<string, string>; path?: string }): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: opts.host, port: opts.port, path: opts.path ?? '/', headers: opts.headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('浏览器登录（cookie）与 0.0.0.0 监听', () => {
  const TOKEN = 'cookie-token-0123456789abcdef';
  let s3: RunningServer;
  // 本机一个非回环 IPv4（没有网卡的环境里为 undefined，局域网相关断言跳过）
  const lan = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  beforeAll(async () => {
    s3 = await startServer({ port: 0, host: '0.0.0.0', webDist: web, stateFile: path.join(tmp, 'state3.json'), authToken: TOKEN, version: '1.0.0' });
  });
  afterAll(async () => {
    await s3.stop();
  });
  const ck = () => `cosyee_token_${s3.port}=${TOKEN}`;

  it('GET /?token=正确 -> 302 去掉查询参数 + HttpOnly / SameSite=Strict / Path=/ cookie', async () => {
    const r = await rawGet2({ host: '127.0.0.1', port: s3.port, path: `/?token=${TOKEN}`, headers: {} });
    expect(r.status).toBe(302);
    expect(r.headers.location).toBe('/');
    const sc = String(r.headers['set-cookie']);
    expect(sc).toContain(`cosyee_token_${s3.port}=${TOKEN}`);
    expect(sc).toContain('HttpOnly');
    expect(sc).toContain('SameSite=Strict');
    expect(sc).toContain('Path=/');
  });
  it('/auth?token= 同样可用；token 错误 403 且不下发 cookie', async () => {
    expect((await rawGet2({ host: '127.0.0.1', port: s3.port, path: `/auth?token=${TOKEN}`, headers: {} })).status).toBe(302);
    const bad = await rawGet2({ host: '127.0.0.1', port: s3.port, path: '/?token=wrong', headers: {} });
    expect(bad.status).toBe(403);
    expect(bad.headers['set-cookie']).toBeUndefined();
  });
  it('带 cookie 即可访问页面和 API，无 cookie / 错 cookie 403', async () => {
    const ok = await rawGet2({ host: '127.0.0.1', port: s3.port, headers: { cookie: ck() } });
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('INDEX');
    expect((await rawGet2({ host: '127.0.0.1', port: s3.port, path: '/api/running', headers: { cookie: ck() } })).status).toBe(200);
    expect((await rawGet2({ host: '127.0.0.1', port: s3.port, headers: {} })).status).toBe(403);
    expect((await rawGet2({ host: '127.0.0.1', port: s3.port, headers: { cookie: `cosyee_token_${s3.port}=nope` } })).status).toBe(403);
  });
  it('WS 升级接受 cookie', async () => {
    const open = (headers: Record<string, string>) =>
      new Promise<{ ok: boolean; ws: WebSocket; code?: number }>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${s3.port}/ws`, { headers });
        ws.on('open', () => resolve({ ok: true, ws }));
        ws.on('unexpected-response', (_q, res) => resolve({ ok: false, ws, code: res.statusCode }));
        ws.on('error', () => resolve({ ok: false, ws }));
      });
    expect((await open({})).code).toBe(403);
    const good = await open({ cookie: ck() });
    expect(good.ok).toBe(true);
    good.ws.close();
  });
  it('0.0.0.0：本机局域网 IP 能访问；伪造 Host 被拒', async () => {
    if (lan) {
      const r = await rawGet2({ host: lan, port: s3.port, headers: { cookie: ck() } });
      expect(r.status).toBe(200);
    }
    for (const evil of ['evil.com', `evil.com:${s3.port}`, `10.255.255.254:${s3.port}`]) {
      const r = await rawGet2({ host: '127.0.0.1', port: s3.port, headers: { cookie: ck(), host: evil } });
      expect(r.status).toBe(403);
    }
    // 登录入口也要过 Host 校验
    expect((await rawGet2({ host: '127.0.0.1', port: s3.port, path: `/?token=${TOKEN}`, headers: { host: `evil.com:${s3.port}` } })).status).toBe(403);
  });
  it('默认（127.0.0.1）监听时，局域网 IP 的 Host 被拒', async () => {
    const r = await rawGet2({ host: '127.0.0.1', port: srv.port, headers: { host: `${lan ?? '192.168.1.23'}:${srv.port}` } });
    expect(r.status).toBe(403);
  });
  it('非 IPv4 的监听地址直接报错', async () => {
    await expect(startServer({ port: 0, host: 'evil.com', webDist: web, stateFile: path.join(tmp, 'state4.json') })).rejects.toThrow('IPv4');
  });
});

describe('POST /api/shutdown（客户端停止本地服务）', () => {
  it('没传 onShutdown 时接口不存在', async () => {
    expect((await fetch(`${base}/api/shutdown`, { method: 'POST' })).status).toBe(404);
  });
  it('本机请求触发 onShutdown；GET 不触发', async () => {
    let called = 0;
    const s5 = await startServer({ port: 0, webDist: web, stateFile: path.join(tmp, 'state5.json'), onShutdown: () => called++ });
    try {
      const b5 = `http://127.0.0.1:${s5.port}`;
      expect((await fetch(`${b5}/api/shutdown`)).status).toBe(404);
      // 浏览器里的其它网站不能跨站把服务关掉
      expect((await fetch(`${b5}/api/shutdown`, { method: 'POST', headers: { origin: 'https://evil.com' } })).status).toBe(403);
      expect(called).toBe(0);
      const r = await fetch(`${b5}/api/shutdown`, { method: 'POST' });
      expect(r.status).toBe(200);
      await new Promise((res) => setImmediate(res));
      expect(called).toBe(1);
    } finally {
      await s5.stop();
    }
  });
});

describe('GET /api/skills/content', () => {
  it('读用户级 SKILL.md（去 frontmatter）；找不到 404；名字不合法 400', async () => {
    const dir = path.join(tmp, 'claude', 'skills', 'http-skill');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\ndescription: 测试\n---\n# 正文\n');
    const r = await fetch(`${base}/api/skills/content?name=http-skill`, { headers: auth });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ name: 'http-skill', description: '测试', body: '# 正文\n', dir });
    expect((await fetch(`${base}/api/skills/content?name=nope`, { headers: auth })).status).toBe(404);
    expect((await fetch(`${base}/api/skills/content?name=${encodeURIComponent('a b')}`, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}/api/skills/content`, { headers: auth })).status).toBe(400);
  });
});

describe('POST /api/skills/reveal', () => {
  it('选中磁盘上 skill 的 SKILL.md；未知 404、非法名 400、远程头 403 且均不 spawn', async () => {
    const dir = path.join(tmp, 'claude', 'skills', 'reveal-skill');
    fs.mkdirSync(dir, { recursive: true });
    const skillFile = path.join(dir, 'SKILL.md');
    fs.writeFileSync(skillFile, '# reveal\n');
    const calls: Command[] = [];
    const s = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(tmp, 'state-skill-reveal.json'),
      spawner: (cmd, args, opts) => {
        calls.push(opts ? { cmd, args, opts } : { cmd, args });
      },
    });
    try {
      const url = `http://127.0.0.1:${s.port}/api/skills/reveal`;
      const post = (body: unknown, extraHeaders: Record<string, string> = {}) =>
        fetch(url, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify(body) });

      const ok = await post({ name: 'reveal-skill' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      expect(calls).toEqual([revealFileCommand(skillFile)]);

      calls.length = 0;
      expect((await post({ name: 'nope' })).status).toBe(404);
      expect((await post({ name: 'a b' })).status).toBe(400);
      expect((await post({})).status).toBe(400);
      expect((await post({ name: 'reveal-skill' }, { 'x-forwarded-for': '100.64.0.9' })).status).toBe(403);
      expect((await post({ name: 'reveal-skill' }, { 'tailscale-user-login': 'u@example.com' })).status).toBe(403);
      expect(calls).toEqual([]);
    } finally {
      await s.stop();
    }
  });
});

describe('sendJsonMaybeGzip', () => {
  function fake(remoteAddress: string, acceptEncoding?: string) {
    const req = { headers: acceptEncoding ? { 'accept-encoding': acceptEncoding } : {}, socket: { remoteAddress } } as unknown as http.IncomingMessage;
    const out: { status?: number; headers?: Record<string, unknown>; body?: Buffer } = {};
    const res = {
      writeHead: (s: number, h: Record<string, unknown>) => ((out.status = s), (out.headers = h)),
      end: (b: string | Buffer) => (out.body = Buffer.from(b)),
    } as unknown as http.ServerResponse;
    return { req, res, out };
  }
  const big = { entries: Array.from({ length: 5000 }, (_, i) => ({ type: 'assistant', text: `第 ${i} 条消息` })) };

  it('远程客户端 + 大响应 → gzip，解压后与原 JSON 相同', async () => {
    const { req, res, out } = fake('100.64.0.2', 'gzip, deflate, br');
    await sendJsonMaybeGzip(req, res, 200, big);
    expect(out.headers?.['content-encoding']).toBe('gzip');
    expect(out.headers?.['content-length']).toBe(out.body!.length);
    expect(JSON.parse(zlib.gunzipSync(out.body!).toString('utf8'))).toEqual(big);
  });

  it('本机回环 / 不接受 gzip / 小响应 → 原样', async () => {
    for (const [addr, enc, body] of [
      ['127.0.0.1', 'gzip', big],
      ['::ffff:127.0.0.1', 'gzip', big],
      ['100.64.0.2', undefined, big],
      ['100.64.0.2', 'gzip', { ok: true }],
    ] as const) {
      const { req, res, out } = fake(addr, enc);
      await sendJsonMaybeGzip(req, res, 200, body);
      expect(out.headers?.['content-encoding']).toBeUndefined();
      expect(JSON.parse(out.body!.toString('utf8'))).toEqual(body);
    }
  });
});

describe('GET /api/tools/stats', () => {
  it('返回所有会话的工具累计调用次数', async () => {
    const dir = path.join(tmp, 'claude', 'projects', 'F--x');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: {} }] } });
    fs.writeFileSync(path.join(dir, 'stats-test.jsonl'), `${line}\n`);
    const r = await fetch(`${base}/api/tools/stats`, { headers: auth });
    expect(r.status).toBe(200);
    const j = (await r.json()) as { counts: Record<string, number>; sessions: number };
    expect(j.counts.Bash).toBeGreaterThanOrEqual(1);
    expect(j.sessions).toBeGreaterThanOrEqual(1);
  });
});

describe('语音接口（未下载模型）', () => {
  const post = (p: string, body: BodyInit, type = 'application/json') =>
    fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': type }, body });

  it('状态是 missing，合成 / 识别返回 409，不会触发下载', async () => {
    const s = (await (await fetch(`${base}/api/speech/status`, { headers: auth })).json()) as Record<string, { phase: string }>;
    expect(s.tts!.phase).toBe('missing');
    expect(s.stt!.phase).toBe('missing');
    expect((await post('/api/tts', JSON.stringify({ text: '你好。' }))).status).toBe(409);
    expect((await post('/api/stt?rate=16000', new Uint8Array(32000), 'application/octet-stream')).status).toBe(409);
  });

  it('参数校验', async () => {
    expect((await post('/api/speech/prepare', JSON.stringify({ kind: 'x' }))).status).toBe(400);
    expect((await post('/api/tts', JSON.stringify({}))).status).toBe(400);
    expect((await post('/api/stt?rate=1', new Uint8Array(4), 'application/octet-stream')).status).toBe(400);
    expect((await fetch(`${base}/api/tts/0123456789abcdef/0`, { headers: auth })).status).toBe(404);
  });
});
