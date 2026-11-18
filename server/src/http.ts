// HTTP 路由：REST + 静态托管。鉴权 / Origin / Host 校验在这里统一做。
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SKILL_MODES, type Account, type Bootstrap, type SessionSummary, type SkillMode, type UsageInfo } from '@cosyee/shared';
import { type Accounts, RunningError } from './accounts/index.js';
import { validateConfig } from './claude/runner.js';
import type { Manager } from './claude/manager.js';
import { gitBranch } from './git.js';
import { normalizeDir, pathKey } from './paths.js';
import { PASTE_LIMIT, PasteTypeError, savePaste } from './pastes.js';
import { type PickMode, pick, supportsMixed } from './picker/index.js';
import type { Pins } from './pins.js';
import type { Previews } from './preview.js';
import { type Spawner, defaultSpawner, revealFolder } from './reveal.js';
import { cookieName, hostAllowedFor, originAllowed, requestAuthorized, tokenOk } from './security.js';
import type { Sessions } from './sessions.js';
import type { Trash } from './trash.js';
import type { StateStore, Workspaces } from './workspaces.js';
import { HttpError, SKILL_NAME_RE } from './workspaces.js';

export const BODY_LIMIT = 1024 * 1024;

export interface HttpDeps {
  /** 实际监听端口（listen 之后才知道，所以用函数） */
  port: () => number;
  version: string;
  webDist: string | null;
  workspaces: Workspaces;
  sessions: Sessions;
  manager: Manager;
  /** 当前账号（并行模式下 = 新会话用的账号）的信息 */
  account: { get(): Promise<Account | null> };
  /** 多账号；不传则账号相关接口返回 404（旧测试） */
  accounts?: Accounts;
  /** 额度：传 session 时取该会话所用账号的额度，否则取当前账号的 */
  usage: { get(refresh: boolean, session?: string | null): Promise<UsageInfo | null> };
  store: StateStore;
  previews: Previews;
  pins: Pins;
  trash: Trash;
  /** 在文件管理器里打开文件夹用的 spawn（测试可替换，默认 explorer.exe / open / xdg-open） */
  spawner?: Spawner;
  /** 桌面版访问令牌（见 security.ts）；不设置则不校验 */
  authToken?: string;
  /** 监听地址（决定 Host / Origin 白名单），默认 127.0.0.1 */
  host?: string;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(s);
}

/** Host 头必须是允许的主机名 + 本端口，防 DNS rebinding（监听非本机地址时见 security.allowedHostnames）。 */
export function hostAllowed(host: string | undefined, port: number, bindHost: string = '127.0.0.1'): boolean {
  return hostAllowedFor(host, port, bindHost);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > BODY_LIMIT) throw new HttpError(413, '请求体超过 1MB');
    chunks.push(b);
  }
  if (size === 0) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return v && typeof v === 'object' ? (v as Json) : {};
  } catch {
    throw new HttpError(400, '请求体不是合法 JSON');
  }
}

/** 读原始请求体（二进制），超过 limit 返回 413。先看 Content-Length，免得白读一大堆。 */
async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, '图片超过 20MB');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > limit) throw new HttpError(413, '图片超过 20MB');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function needCwd(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, '缺少 cwd');
  return normalizeDir(v);
}

function needPath(body: Json): string {
  if (typeof body.path !== 'string' || !body.path) throw new HttpError(400, '缺少 path');
  return body.path;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

/** 选择窗口同一时间只允许一个。 */
class PickLock {
  busy = false;
}

export function createHandler(deps: HttpDeps) {
  const lock = new PickLock();

  async function accountRoutes(req: IncomingMessage, res: ServerResponse, method: string, p: string): Promise<void> {
    const accounts = deps.accounts;
    if (!accounts) throw new HttpError(404, '未找到');
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/api/accounts') return sendJson(res, 200, accounts.list());
    if (method === 'POST' && p === '/api/accounts/switch') {
      const body = await readJson(req);
      if (typeof body.id !== 'string') throw new HttpError(400, '缺少 id');
      try {
        await accounts.switchTo(body.id, body.force === true);
      } catch (e) {
        if (e instanceof RunningError) return sendJson(res, 409, { error: e.message, running: e.running });
        throw e;
      }
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/accounts/login') {
      const body = await readJson(req);
      return sendJson(res, 200, accounts.startLogin({ label: body.label, accountId: body.accountId }));
    }
    if (method === 'GET' && (m = /^\/api\/accounts\/login\/([a-z0-9]{1,32})$/.exec(p))) return sendJson(res, 200, accounts.getLogin(m[1]!));
    if (method === 'POST' && (m = /^\/api\/accounts\/login\/([a-z0-9]{1,32})\/code$/.exec(p))) {
      const body = await readJson(req);
      accounts.submitCode(m[1]!, body.code);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && (m = /^\/api\/accounts\/login\/([a-z0-9]{1,32})\/cancel$/.exec(p))) {
      accounts.cancelLogin(m[1]!);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/accounts/remove') {
      const body = await readJson(req);
      if (typeof body.id !== 'string') throw new HttpError(400, '缺少 id');
      await accounts.remove(body.id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/accounts/mode') {
      const body = await readJson(req);
      try {
        await accounts.setMode(body.mode, body.force === true);
      } catch (e) {
        if (e instanceof RunningError) return sendJson(res, 409, { error: e.message, running: e.running });
        throw e;
      }
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/accounts/label') {
      const body = await readJson(req);
      if (typeof body.id !== 'string') throw new HttpError(400, '缺少 id');
      accounts.setLabel(body.id, body.label);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, '未找到');
  }

  async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const p = url.pathname;
    const q = url.searchParams;
    let m: RegExpExecArray | null;

    if (method === 'GET' && p === '/api/bootstrap') {
      const b: Bootstrap = {
        version: deps.version,
        platform: process.platform,
        homeDir: os.homedir(),
        supportsMixedPick: supportsMixed,
        defaults: deps.store.state.defaults ?? { model: 'sonnet', effort: 'medium' },
      };
      return sendJson(res, 200, b);
    }

    // 桌面版退出前询问：有几个会话正在执行
    if (method === 'GET' && p === '/api/running') return sendJson(res, 200, { count: deps.manager.runningCount() });

    if (method === 'GET' && p === '/api/workspaces') return sendJson(res, 200, deps.workspaces.list());

    if (method === 'POST' && p === '/api/workspaces/pick') {
      const items = await runPick(req, lock, { mode: 'folders', title: '选择工作空间文件夹' });
      const first = items.find((i) => i.kind === 'folder');
      if (!first) return sendJson(res, 200, { workspace: null });
      const ws = deps.workspaces.add(first.path);
      deps.workspaces.setCurrent(ws.path);
      return sendJson(res, 200, { workspace: ws });
    }

    if (method === 'POST' && p === '/api/workspaces/current') {
      const body = await readJson(req);
      if (typeof body.path !== 'string' || !body.path) throw new HttpError(400, '缺少 path');
      deps.workspaces.setCurrent(body.path);
      return sendJson(res, 200, { ok: true });
    }

    // 以下三个只接受已在工作空间列表里的路径；整个操作只改 Cosyee 自己的列表，不会动磁盘上的文件
    if (method === 'POST' && p === '/api/workspaces/top') {
      deps.workspaces.moveToTop(needPath(await readJson(req)));
      return sendJson(res, 200, deps.workspaces.list());
    }

    if (method === 'POST' && p === '/api/workspaces/remove') {
      deps.workspaces.remove(needPath(await readJson(req)));
      return sendJson(res, 200, deps.workspaces.list());
    }

    if (method === 'POST' && p === '/api/workspaces/reveal') {
      const ws = deps.workspaces.find(needPath(await readJson(req)));
      if (!ws) throw new HttpError(404, '工作空间不在列表里');
      if (!revealFolder(ws.path, deps.spawner ?? defaultSpawner)) throw new HttpError(404, '文件夹不存在');
      return sendJson(res, 200, { ok: true });
    }

    // 置顶：所有工作空间的置顶会话（手动在前，自动在后）；文件已不存在 / 没有消息的置顶项不返回。
    // 例外：正在执行的会话即使记录文件还没写出来（新会话的第一轮）也返回占位行，否则自动置顶后要等这一轮结束才出现
    if (method === 'GET' && p === '/api/pins') {
      const rows = await Promise.all(deps.pins.list().map(async (e) =>
        (await deps.sessions.get(e.id, e.cwd)) ?? (deps.pins.isRunning(e.id) ? deps.sessions.placeholder(e.id, e.cwd) : null)));
      return sendJson(res, 200, rows.filter((r): r is SessionSummary => r !== null));
    }

    if (method === 'GET' && p === '/api/deleted') return sendJson(res, 200, deps.trash.list());

    if (method === 'POST' && (m = /^\/api\/sessions\/([^/]+)\/(pin|unpin|delete|restore|purge)$/.exec(p))) {
      const id = decodeURIComponent(m[1]!);
      const action = m[2]!;
      if (!isSafe(id)) throw new HttpError(400, '会话 id 不合法');
      const body = await readJson(req);
      if (action === 'unpin') {
        deps.pins.unpin(id);
      } else if (action === 'restore') {
        deps.trash.restore(id);
      } else if (action === 'purge') {
        await deps.trash.purge(id, (sid, cwd) => deps.sessions.locate(sid, cwd));
      } else {
        const cwd = needCwd(body.cwd);
        const row = await deps.sessions.get(id, cwd);
        if (!row) throw new HttpError(404, '会话不存在');
        if (action === 'pin') deps.pins.pin(id, cwd);
        else deps.trash.softDelete(id, cwd, row.title);
      }
      deps.manager.notifySidebar();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && p === '/api/sessions') return sendJson(res, 200, await deps.sessions.list(needCwd(q.get('cwd'))));

    if (method === 'GET' && (m = /^\/api\/sessions\/([^/]+)\/history$/.exec(p))) {
      return sendJson(res, 200, { entries: await deps.sessions.history(decodeURIComponent(m[1]!), needCwd(q.get('cwd'))) });
    }

    if (method === 'GET' && (m = /^\/api\/sessions\/([^/]+)\/subagent\/([^/]+)$/.exec(p))) {
      const entries = await deps.sessions.subagent(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), needCwd(q.get('cwd')));
      return sendJson(res, 200, { entries });
    }

    if (method === 'POST' && (m = /^\/api\/sessions\/([^/]+)\/rename$/.exec(p))) {
      const body = await readJson(req);
      const id = decodeURIComponent(m[1]!);
      if (!isSafe(id)) throw new HttpError(400, '会话 id 不合法');
      await deps.manager.rename(id, needCwd(body.cwd), body.title as string);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && (m = /^\/api\/sessions\/([^/]+)\/viewed$/.exec(p))) {
      const body = await readJson(req);
      const id = decodeURIComponent(m[1]!);
      if (!isSafe(id)) throw new HttpError(400, '会话 id 不合法');
      deps.manager.viewed(id, needCwd(body.cwd));
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && p === '/api/git') return sendJson(res, 200, { branch: await gitBranch(needCwd(q.get('cwd'))) });

    if (method === 'GET' && p === '/api/account') return sendJson(res, 200, await deps.account.get());

    if (p === '/api/accounts' || p.startsWith('/api/accounts/')) return accountRoutes(req, res, method, p);

    if (method === 'GET' && p === '/api/usage') return sendJson(res, 200, await deps.usage.get(q.get('refresh') === '1', q.get('session')));

    if (method === 'POST' && p === '/api/defaults') {
      const body = await readJson(req);
      const c = { model: body.model, effort: body.effort };
      try {
        validateConfig(c);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      deps.store.state.defaults = c;
      deps.store.save();
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && p === '/api/skills') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !SKILL_NAME_RE.test(body.name)) throw new HttpError(400, 'skill 名不合法');
      if (!SKILL_MODES.includes(body.mode as SkillMode)) throw new HttpError(400, 'mode 不合法');
      await deps.manager.setSkillMode(body.name, body.mode as SkillMode);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && p === '/api/pick') {
      const body = await readJson(req);
      const mode = parseMode(body.mode);
      const start = deps.workspaces.list().current ?? undefined;
      const items = await runPick(req, lock, { mode, title: '选择文件或文件夹', startDir: start });
      return sendJson(res, 200, { items: deps.previews.register(items), supportsMixed });
    }

    // 粘贴图片：请求体就是图片原始字节（Content-Type: image/*），存盘后按「选出的文件」登记，前端当普通图片标签用
    if (method === 'POST' && p === '/api/pastes') {
      const data = await readRaw(req, PASTE_LIMIT);
      let file: string;
      try {
        file = await savePaste(data, req.headers['content-type']);
      } catch (e) {
        if (e instanceof PasteTypeError) throw new HttpError(415, e.message);
        throw e;
      }
      const [item] = deps.previews.register([{ path: file, kind: 'file' }]);
      return sendJson(res, 200, { item });
    }

    if (method === 'GET' && (m = /^\/api\/preview\/([^/]+)\/info$/.exec(p))) {
      return sendJson(res, 200, await deps.previews.info(decodeURIComponent(m[1]!)));
    }

    if (method === 'GET' && (m = /^\/api\/preview\/([^/]+)\/raw$/.exec(p))) {
      const t = await deps.previews.rawTarget(decodeURIComponent(m[1]!));
      const headers: Record<string, string | number> = {
        'content-type': t.type,
        'content-length': t.size,
        'cache-control': 'private, max-age=60',
        'x-content-type-options': 'nosniff',
      };
      if (t.svg) headers['content-security-policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
      res.writeHead(200, headers);
      const stream = fs.createReadStream(t.file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
    }

    if (method === 'GET' && (m = /^\/api\/context\/([^/]+)$/.exec(p))) {
      const id = decodeURIComponent(m[1]!);
      if (!isSafe(id)) throw new HttpError(400, '会话 id 不合法');
      return sendJson(res, 200, deps.manager.getContext(id));
    }

    if (method === 'POST' && (m = /^\/api\/context\/([^/]+)\/refresh$/.exec(p))) {
      const id = decodeURIComponent(m[1]!);
      if (!isSafe(id)) throw new HttpError(400, '会话 id 不合法');
      const body = await readJson(req);
      const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : (q.get('cwd') ?? undefined);
      const draft = draftCwd(body.draft, cwd);
      return sendJson(res, 200, await deps.manager.refreshContext(id, cwd || undefined, draft));
    }

    if (method === 'POST' && (m = /^\/api\/context\/([^/]+)\/mcp$/.exec(p))) {
      const id = decodeURIComponent(m[1]!);
      if (!isSafe(id)) throw new HttpError(400, '会话 id 不合法');
      const body = await readJson(req);
      const server = body.server;
      if (typeof server !== 'string' || !server || server.length > 200 || /[\u0000-\u001f\u007f]/.test(server)) {
        throw new HttpError(400, 'MCP 服务器名不合法');
      }
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 必须是布尔值');
      const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : undefined;
      const draft = draftCwd(body.draft, cwd);
      return sendJson(res, 200, await deps.manager.toggleMcp(id, server, body.enabled, cwd, draft));
    }

    throw new HttpError(404, '接口不存在');
  }

  /**
   * 新会话草稿（还没有记录）的探测进程会在 cwd 里新起一个 claude：只允许 Cosyee 已知的工作空间。
   * 返回是否按草稿处理；draft 为真但 cwd 不在工作空间列表里时 400。
   */
  function draftCwd(draft: unknown, cwd: string | undefined): boolean {
    if (draft !== true) return false;
    if (!cwd) throw new HttpError(400, '新会话需要 cwd');
    const key = pathKey(normalizeDir(cwd));
    if (!deps.workspaces.list().list.some((w) => pathKey(normalizeDir(w.path)) === key)) {
      throw new HttpError(400, 'cwd 不是已打开的工作空间');
    }
    return true;
  }

  async function runPick(
    req: IncomingMessage,
    l: PickLock,
    o: { mode: PickMode; title: string; startDir?: string },
  ) {
    if (l.busy) throw new HttpError(409, '已有选择窗口打开');
    l.busy = true;
    const ac = new AbortController();
    // 客户端中途断开：关掉选择窗口
    const onClose = () => ac.abort();
    req.on('close', onClose);
    try {
      return await pick({ ...o, signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) throw new HttpError(499, '请求已取消');
      throw new HttpError(500, `无法打开选择窗口: ${e instanceof Error ? e.message : e}`);
    } finally {
      req.off('close', onClose);
      l.busy = false;
    }
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const root = deps.webDist!;
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: '不支持的方法' });
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return sendJson(res, 400, { error: '路径不合法' });
    }
    if (rel.includes('\0')) return sendJson(res, 400, { error: '路径不合法' });
    let file = path.resolve(root, '.' + path.sep + rel.replace(/^[\\/]+/, ''));
    const rootResolved = path.resolve(root);
    // 防路径穿越：解析后必须仍在根目录内
    if (file !== rootResolved && !file.startsWith(rootResolved + path.sep)) return sendJson(res, 403, { error: '禁止访问' });
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(file);
    } catch { /* 不存在 */ }
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      try {
        st = fs.statSync(file);
      } catch {
        st = null;
      }
    }
    // SPA 回退：没有扩展名（或文件不存在）的路径给 index.html；带扩展名且不存在的资源返回 404
    if (!st || !st.isFile()) {
      if (path.extname(rel)) return sendJson(res, 404, { error: '文件不存在' });
      file = path.join(rootResolved, 'index.html');
      try {
        st = fs.statSync(file);
      } catch {
        return sendJson(res, 404, { error: '文件不存在' });
      }
    }
    const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const isIndex = path.basename(file) === 'index.html';
    res.writeHead(200, {
      'content-type': type,
      'content-length': st.size,
      'cache-control': isIndex ? 'no-cache' : 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') return void res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const port = deps.port();
      const bindHost = deps.host ?? '127.0.0.1';
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      // 浏览器登录：GET /?token=<t>（或 /auth?token=<t>）校验通过后写 cookie 并 302 到去掉查询参数的地址。
      // Host 校验仍然先做；令牌错误一律 403，不区分原因。
      if (deps.authToken && req.method === 'GET' && (url.pathname === '/' || url.pathname === '/auth') && url.searchParams.has('token')) {
        if (!hostAllowed(req.headers.host, port, bindHost)) throw new HttpError(403, 'Host 不允许');
        if (!tokenOk(url.searchParams.get('token') ?? undefined, deps.authToken)) throw new HttpError(403, '缺少或错误的访问令牌');
        res.writeHead(302, {
          location: '/',
          // 不加 Secure（本机 / 局域网是 http）；HttpOnly 让页面脚本读不到，SameSite=Strict 挡跨站请求
          'set-cookie': `${cookieName(port)}=${deps.authToken}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          'cache-control': 'no-store',
          'content-length': 0,
        });
        res.end();
        return;
      }
      // 令牌放最前面：没带令牌的请求不暴露任何其它信息（请求头或 cookie 任一匹配即可）
      if (deps.authToken && !requestAuthorized(req.headers, port, deps.authToken)) throw new HttpError(403, '缺少或错误的访问令牌');
      if (!hostAllowed(req.headers.host, port, bindHost)) throw new HttpError(403, 'Host 不允许');
      const origin = req.headers.origin;
      if (!originAllowed(typeof origin === 'string' ? origin : undefined, port, bindHost)) throw new HttpError(403, 'Origin 不允许');

      if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
        await route(req, res, url);
        return;
      }
      if (url.pathname === '/ws') throw new HttpError(426, '需要 WebSocket 升级');
      if (deps.webDist) return serveStatic(req, res, url);
      throw new HttpError(404, '未找到');
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.destroy();
    }
  };
}

function isSafe(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

function parseMode(v: unknown): PickMode {
  if (v === 'mixed' || v === 'files' || v === 'folders') return v;
  if (v === undefined || v === null) return supportsMixed ? 'mixed' : 'files';
  throw new HttpError(400, 'mode 不合法');
}
