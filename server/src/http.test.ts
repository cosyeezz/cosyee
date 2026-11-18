// 进程内起真实 HTTP + WS 服务（随机端口、临时 state / 配置目录），测鉴权、Origin、路由与静态托管。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { type RunningServer, startServer } from './server.js';

let tmp: string;
let web: string;
let srv: RunningServer;
let base: string;
let prevEnv: string | undefined;
let prevHome: string | undefined;

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
  srv = await startServer({ port: 0, webDist: web, stateFile: path.join(tmp, 'state.json') });
  base = `http://127.0.0.1:${srv.port}`;
});

afterAll(async () => {
  await srv.stop();
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevEnv;
  if (prevHome === undefined) delete process.env.COSYEE_HOME;
  else process.env.COSYEE_HOME = prevHome;
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
