// HTTP 路由：REST + 静态托管。鉴权 / Origin / Host 校验在这里统一做。
import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { EXEC_CODE_LIMIT, SKILL_MODES, type Account, type Bootstrap, type SessionSummary, type SkillMode, type ToolStats, type CompactStats, type PreviewInfo, type PriceTable, type UsageInfo, type CliModelList, type DelegateModelList } from '@cosyee/shared';
import type { AgyAccounts } from './accounts/agy.js';
import { type Accounts, RunningError } from './accounts/index.js';
import type { KiroService } from './kiro/index.js';
import { browseDir, statFolder, statPicked } from './browse.js';
import { validateConfig } from './claude/runner.js';
import type { Manager } from './claude/manager.js';
import { runSnippet } from './exec.js';
import { mentionForms, openRaw, previewFile, resolveForAction, type OutsideCheck } from './files.js';
import { gitBranch } from './git.js';
import { baseClaudeHome, isSafeId, normalizeDir, pathKey } from './paths.js';
import { readSkillContent } from './skillsDisk.js';
import { PASTE_LIMIT, PasteTypeError, pasteTarget, savePaste } from './pastes.js';
import { type PickMode, pick, supportsMixed } from './picker/index.js';
import type { Pins } from './pins.js';
import type { Previews } from './preview.js';
import { type Spawner, defaultSpawner, openTerminal, revealFolder, revealPath } from './reveal.js';
import { cookieName, hostAllowedFor, isLoopbackAddr, originAllowed, requestAuthorized, tokenOk } from './security.js';
import type { Sessions } from './sessions.js';
import { MAX_STT_SECONDS, type Speech, SpeechNotReady } from './speech/index.js';
import type { Trash } from './trash.js';
import type { StateStore, Workspaces } from './workspaces.js';
import { type ComponentUpdater, componentRoutes } from './components/updater.js';
import { type AgyCli, agyCliRoutes } from './delegate/agyCli.js';
import { COMPACT_WINDOW_MAX, COMPACT_WINDOW_MIN, HttpError, SKILL_NAME_RE, TOOL_NAME_RE, AGENT_NAME_RE, parseAgentModels, sanitizeCompactWindow } from './workspaces.js';

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
  /** Antigravity（agy）多账号；不传则 agy 账号相关接口返回 404（旧测试） */
  agyAccounts?: AgyAccounts;
  /** Antigravity CLI（agy）版本与升级；不传则 /api/agy/cli 返回 404（旧测试） */
  agyCli?: AgyCli;
  /** 本机组件版本与自动更新；不传则 /api/components 返回 404（旧测试） */
  components?: ComponentUpdater;
  /** Kiro 账号与 kiro.rs 引擎 / 代理；不传则 /api/kiro 接口返回 404（旧测试） */
  kiro?: KiroService;
  /** 额度：传 session 时取该会话所用账号的额度，否则取当前账号的 */
  usage: { get(refresh: boolean, session?: string | null, account?: string | null): Promise<UsageInfo | null> };
  /** CLI 报告的可用模型（模型菜单用）；账号解析同 usage。不传 = 返回 null（旧测试） */
  cliModels?: { get(refresh: boolean, session?: string | null, account?: string | null): Promise<CliModelList | null> };
  /** Antigravity 的可用模型；不传则 GET /api/delegate/models 返回 404（旧测试） */
  delegateModels?: (cwd: string, refresh: boolean) => Promise<DelegateModelList>;
  store: StateStore;
  previews: Previews;
  pins: Pins;
  trash: Trash;
  /** 价格表（GET /api/pricing、子代理花费用） */
  pricing: { table(): PriceTable };
  /** 在文件管理器里打开文件夹用的 spawn（测试可替换，默认 explorer.exe / open / xdg-open） */
  spawner?: Spawner;
  /** 桌面版访问令牌（见 security.ts）；不设置则不校验 */
  authToken?: string;
  /** 监听地址（决定 Host / Origin 白名单），默认 127.0.0.1 */
  host?: string;
  /** 跨会话的工具累计调用次数；不传则 GET /api/tools/stats 返回 404 */
  toolStats?: { get(): Promise<ToolStats> };
  /** 跨会话的压缩效果统计；不传则 GET /api/compact/stats 返回 404 */
  compactStats?: { get(): Promise<CompactStats> };
  /** POST /api/shutdown（只接受本机回环连接）时调用；不传则该接口 404。客户端用它停止后台运行的本地服务。 */
  onShutdown?: () => void;
  /** 朗读 / 语音输入（见 speech/）；不传则语音接口 404 */
  speech?: Speech;
  /** Tailscale HTTPS 入口（https://<机器名>.<tailnet>.ts.net），没有时 null */
  httpsUrl?: () => string | null;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  writeJson(res, status, JSON.stringify(body ?? null));
}

function writeJson(res: ServerResponse, status: number, s: string): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(s);
}

const gzip = promisify(zlib.gzip);
/** 超过这个大小、且客户端不在本机时才压缩（本机回环压缩只会更慢） */
const GZIP_MIN = 64 * 1024;

/** 大响应（会话历史等）对远程客户端 gzip：几十 MB 的 JSON 走 Tailscale / 局域网时差别很大 */
export async function sendJsonMaybeGzip(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): Promise<void> {
  const s = JSON.stringify(body ?? null);
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  if (s.length < GZIP_MIN || !accepts || fromLocal(req)) return writeJson(res, status, s);
  const z = await gzip(s, { level: 4 });
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-encoding': 'gzip',
    'content-length': z.length,
    vary: 'accept-encoding',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(z);
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
async function readRaw(req: IncomingMessage, limit: number, tooBig = '图片超过 20MB'): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, tooBig);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    const b = c as Buffer;
    size += b.length;
    if (size > limit) throw new HttpError(413, tooBig);
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function needCwd(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, '缺少 cwd');
  return normalizeDir(v);
}

/** 批量操作的会话 id 列表：非空字符串数组，每个都要合法，去重；上限防止误传超大数组 */
function needIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, '缺少 ids');
  if (v.length > 10000) throw new HttpError(400, 'ids 太多');
  for (const id of v) if (typeof id !== 'string' || !isSafe(id)) throw new HttpError(400, '会话 id 不合法');
  return [...new Set(v as string[])];
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

/**
 * 请求是否来自服务端本机。tailscale serve 反代过来的请求 TCP 层也是 127.0.0.1，但带着它加的
 * Tailscale-User-Login / X-Forwarded-For 头——那其实是 tailnet 里的别的设备，按远程处理
 * （不能关服务、不能在服务器桌面上开窗口）。本机程序伪造这些头只会把自己降成远程，没有风险。
 */
export function fromLocal(req: IncomingMessage): boolean {
  if (!isLoopbackAddr(req.socket.remoteAddress)) return false;
  const h = req.headers;
  if (h['tailscale-user-login']) return false;
  const xff = String(h['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return !xff || isLoopbackAddr(xff);
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
    if (method === 'POST' && p === '/api/accounts/dedupe') {
      return sendJson(res, 200, await accounts.dedupe());
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
    if (method === 'POST' && p === '/api/accounts/api') {
      const body = await readJson(req);
      const id = await accounts.saveApi({
        id: body.id, label: body.label, baseUrl: body.baseUrl, apiKey: body.apiKey, authType: body.authType, models: body.models,
      });
      return sendJson(res, 200, { ok: true, id });
    }
    if (method === 'POST' && p === '/api/accounts/api/models') {
      const body = await readJson(req);
      const r = await accounts.modelList({ id: body.id, baseUrl: body.baseUrl, apiKey: body.apiKey, authType: body.authType });
      return sendJson(res, 200, r);
    }
    throw new HttpError(404, '未找到');
  }

  async function agyAccountRoutes(req: IncomingMessage, res: ServerResponse, method: string, p: string): Promise<void> {
    const agy = deps.agyAccounts;
    if (!agy) throw new HttpError(404, '未找到');
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/api/agy-accounts') {
      const refresh = new URL(req.url ?? '/', 'http://x').searchParams.get('refresh') === '1';
      return sendJson(res, 200, agy.list({ refresh }));
    }
    if (method === 'POST' && p === '/api/agy-accounts/switch') {
      const body = await readJson(req);
      if (typeof body.id !== 'string') throw new HttpError(400, '缺少 id');
      await agy.switchTo(body.id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/agy-accounts/login') {
      const body = await readJson(req);
      return sendJson(res, 200, agy.startLogin({ label: body.label, accountId: body.accountId }));
    }
    if (method === 'GET' && (m = /^\/api\/agy-accounts\/login\/([a-z0-9]{1,32})$/.exec(p))) return sendJson(res, 200, agy.getLogin(m[1]!));
    if (method === 'POST' && (m = /^\/api\/agy-accounts\/login\/([a-z0-9]{1,32})\/code$/.exec(p))) {
      const body = await readJson(req);
      agy.submitCode(m[1]!, body.code);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && (m = /^\/api\/agy-accounts\/login\/([a-z0-9]{1,32})\/cancel$/.exec(p))) {
      agy.cancelLogin(m[1]!);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/agy-accounts/remove') {
      const body = await readJson(req);
      if (typeof body.id !== 'string') throw new HttpError(400, '缺少 id');
      await agy.remove(body.id);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && p === '/api/agy-accounts/dedupe') {
      return sendJson(res, 200, await agy.dedupe());
    }
    if (method === 'POST' && p === '/api/agy-accounts/label') {
      const body = await readJson(req);
      if (typeof body.id !== 'string') throw new HttpError(400, '缺少 id');
      agy.setLabel(body.id, body.label);
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, '未找到');
  }

  async function kiroRoutes(req: IncomingMessage, res: ServerResponse, method: string, p: string, q: URLSearchParams): Promise<void> {
    const kiro = deps.kiro;
    if (!kiro) throw new HttpError(404, '未找到');
    let m: RegExpExecArray | null;
    if (method === 'GET' && p === '/api/kiro') return sendJson(res, 200, kiro.status());
    // engine/* 与 service/* 的 POST 都不读请求体（客户端用 Content-Length: 0 的 HTTP/1.0 请求调用）
    if (method === 'POST' && p === '/api/kiro/engine/check') return sendJson(res, 200, await kiro.checkEngine());
    if (method === 'POST' && p === '/api/kiro/engine/build') {
      if (!fromLocal(req)) throw new HttpError(403, '只能从本机编译 kiro.rs 引擎');
      return sendJson(res, 200, kiro.buildEngine());
    }
    if (method === 'GET' && p === '/api/kiro/engine/log') {
      const raw = q.get('from');
      const from = raw !== null && /^\d+$/.test(raw) ? Number(raw) : 0;
      return sendJson(res, 200, kiro.engineLog(from));
    }
    if (method === 'POST' && p === '/api/kiro/service/start') {
      if (!fromLocal(req)) throw new HttpError(403, '只能从本机启动 kiro.rs 服务');
      return sendJson(res, 200, kiro.startService());
    }
    if (method === 'POST' && p === '/api/kiro/service/stop') {
      if (!fromLocal(req)) throw new HttpError(403, '只能从本机停止 kiro.rs 服务');
      try {
        return sendJson(res, 200, await kiro.stopService(q.get('force') === '1'));
      } catch (e) {
        if (e instanceof RunningError) return sendJson(res, 409, { error: e.message, running: e.running });
        throw e;
      }
    }
    if (method === 'POST' && p === '/api/kiro/service/restart') {
      if (!fromLocal(req)) throw new HttpError(403, '只能从本机重启 kiro.rs 服务');
      try {
        return sendJson(res, 200, await kiro.restartService(q.get('force') === '1'));
      } catch (e) {
        if (e instanceof RunningError) return sendJson(res, 409, { error: e.message, running: e.running });
        throw e;
      }
    }
    if (method === 'POST' && p === '/api/kiro/service/admin') {
      if (!fromLocal(req)) throw new HttpError(403, '只能从本机获取 kiro.rs 管理页面信息');
      // 管理密钥只允许本机原生客户端读取：浏览器请求必带 Origin 或 Sec-Fetch-Site / Sec-Fetch-Mode，一律拒绝
      const h = req.headers;
      if (h.origin || h['sec-fetch-site'] || h['sec-fetch-mode']) {
        throw new HttpError(403, '浏览器网页不能读取 kiro.rs 管理密钥');
      }
      const id = q.get('account');
      if (!id) throw new HttpError(400, '缺少 account');
      return sendJson(res, 200, await kiro.adminAccess(id));
    }
    if (method === 'POST' && p === '/api/kiro/login') {
      const body = await readJson(req);
      return sendJson(res, 200, kiro.startLogin({
        method: body.method,
        label: body.label,
        accountId: body.accountId,
        startUrl: body.startUrl,
        region: body.region,
        apiKey: body.apiKey,
      }));
    }
    if (method === 'GET' && (m = /^\/api\/kiro\/login\/([a-z0-9]{1,32})$/.exec(p))) {
      return sendJson(res, 200, kiro.getLogin(m[1]!));
    }
    if (method === 'POST' && (m = /^\/api\/kiro\/login\/([a-z0-9]{1,32})\/cancel$/.exec(p))) {
      kiro.cancelLogin(m[1]!);
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'GET' && p === '/api/kiro/balance') {
      const id = q.get('account');
      if (!id) throw new HttpError(400, '缺少 account');
      return sendJson(res, 200, await kiro.balance(id));
    }
    throw new HttpError(404, '未找到');
  }

  async function speechRoutes(req: IncomingMessage, res: ServerResponse, method: string, p: string, q: URLSearchParams): Promise<void> {
    const speech = deps.speech;
    if (!speech) throw new HttpError(404, '未找到');
    try {
      if (method === 'GET' && p === '/api/speech/status') return sendJson(res, 200, speech.status());
      if (method === 'POST' && p === '/api/speech/prepare') {
        const kind = (await readJson(req)).kind;
        if (kind !== 'tts' && kind !== 'stt') throw new HttpError(400, 'kind 只能是 tts 或 stt');
        return sendJson(res, 200, speech.prepare(kind));
      }
      if (method === 'POST' && p === '/api/tts') {
        const text = (await readJson(req)).text;
        if (typeof text !== 'string') throw new HttpError(400, '缺少 text');
        return sendJson(res, 200, speech.ttsPrepare(text));
      }
      const m = /^\/api\/tts\/([0-9a-f]{16})\/(\d+)$/.exec(p);
      if (method === 'GET' && m) {
        const job = speech.ttsAudio(m[1]!, Number(m[2]));
        if (!job) throw new HttpError(404, '朗读内容已过期，请重新点击朗读');
        const wav = await job;
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': wav.length, 'cache-control': 'private, max-age=3600' });
        res.end(wav);
        return;
      }
      if (method === 'POST' && p === '/api/stt') {
        const rate = Number(q.get('rate') ?? 16000);
        if (!Number.isInteger(rate) || rate < 8000 || rate > 48000) throw new HttpError(400, 'rate 不合法');
        const pcm = await readRaw(req, rate * 2 * MAX_STT_SECONDS + 4096, `录音超过 ${MAX_STT_SECONDS / 60} 分钟`);
        return sendJson(res, 200, { text: await speech.transcribe(pcm, rate) });
      }
    } catch (e) {
      if (e instanceof SpeechNotReady) throw new HttpError(409, e.message);
      throw e;
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
        remote: !fromLocal(req),
        httpsUrl: deps.httpsUrl?.() ?? null,
      };
      if (b.remote) b.supportsMixedPick = true; // 远程用网页版选择窗口，文件和文件夹可以一起选
      return sendJson(res, 200, b);
    }

    // 桌面版退出前询问：有几个会话正在执行
    if (method === 'GET' && p === '/api/running') return sendJson(res, 200, { count: deps.manager.runningCount() });

    if (p.startsWith('/api/speech/') || p === '/api/tts' || p.startsWith('/api/tts/') || p === '/api/stt') {
      return speechRoutes(req, res, method, p, q);
    }

    // 客户端「停止本地服务」：只认本机回环来的请求（Tailscale 模式下 tailnet 设备不能关掉服务）
    if (method === 'POST' && p === '/api/shutdown' && deps.onShutdown) {
      if (!fromLocal(req)) return sendJson(res, 403, { error: '只能从本机停止服务' });
      sendJson(res, 200, { ok: true });
      setImmediate(deps.onShutdown);
      return;
    }

    if (method === 'GET' && p === '/api/workspaces') return sendJson(res, 200, deps.workspaces.list());

    if (method === 'POST' && p === '/api/workspaces/pick') {
      onlyLocal(req);
      const items = await runPick(res, lock, { mode: 'folders', title: '选择工作空间文件夹' });
      const first = items.find((i) => i.kind === 'folder');
      if (!first) return sendJson(res, 200, { workspace: null });
      const ws = deps.workspaces.add(first.path);
      deps.workspaces.setCurrent(ws.path);
      return sendJson(res, 200, { workspace: ws });
    }

    // 网页版选择窗口选出的工作空间文件夹（远程连接）
    if (method === 'POST' && p === '/api/workspaces/open') {
      const dir = await statFolder((await readJson(req)).path);
      const ws = deps.workspaces.add(dir);
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
      onlyLocal(req);
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

    // 批量操作都由前端给出明确的 id 列表（界面上看到的那些），服务端不自己扩大范围
    // 工作空间分组的「删除全部会话」：只删该工作空间列表里确实存在、且未删除的会话；执行中的跳过
    if (method === 'POST' && p === '/api/sessions/delete-many') {
      const body = await readJson(req);
      const cwd = needCwd(body.cwd);
      const ids = new Set(needIds(body.ids));
      const rows = (await deps.sessions.list(cwd)).filter((r) => ids.has(r.id));
      const r = deps.trash.softDeleteMany(rows.map((s) => ({ id: s.id, cwd, title: s.title })));
      if (r.deleted.length) deps.manager.notifySidebar();
      return sendJson(res, 200, { deleted: r.deleted.length, skipped: r.skipped.length });
    }

    if (method === 'POST' && p === '/api/deleted/restore') {
      const restored = deps.trash.restoreMany(needIds((await readJson(req)).ids));
      if (restored.length) deps.manager.notifySidebar();
      return sendJson(res, 200, { restored: restored.length });
    }

    if (method === 'POST' && p === '/api/deleted/purge') {
      const r = await deps.trash.purgeMany(needIds((await readJson(req)).ids), (sid, cwd) => deps.sessions.locate(sid, cwd));
      for (const sid of r.purged) deps.manager.forgetSession?.(sid);
      if (r.purged.length) deps.manager.notifySidebar();
      return sendJson(res, 200, { purged: r.purged.length, failed: r.failed.length, error: r.failed[0]?.error ?? null });
    }

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
        deps.manager.forgetSession?.(id);
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
      return sendJsonMaybeGzip(req, res, 200, await deps.sessions.historyVersioned(decodeURIComponent(m[1]!), needCwd(q.get('cwd')), q.get('since')));
    }

    if (method === 'GET' && (m = /^\/api\/sessions\/([^/]+)\/detail$/.exec(p))) {
      return sendJson(res, 200, await deps.sessions.detail(decodeURIComponent(m[1]!), needCwd(q.get('cwd'))));
    }

    if (method === 'GET' && (m = /^\/api\/sessions\/([^/]+)\/subagent\/([^/]+)$/.exec(p))) {
      const entries = await deps.sessions.subagent(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!), needCwd(q.get('cwd')));
      return sendJsonMaybeGzip(req, res, 200, { entries });
    }

    if (method === 'GET' && (m = /^\/api\/sessions\/([^/]+)\/subagent-costs$/.exec(p))) {
      const items = await deps.sessions.subagentCosts(decodeURIComponent(m[1]!), needCwd(q.get('cwd')), deps.pricing.table());
      return sendJsonMaybeGzip(req, res, 200, { items });
    }

    if (method === 'GET' && p === '/api/pricing') return sendJson(res, 200, deps.pricing.table());

    if (method === 'POST' && (m = /^\/api\/sessions\/([^/]+)\/rename$/.exec(p))) {
      const body = await readJson(req);
      const id = decodeURIComponent(m[1]!);
      if (!isSafe(id)) throw new HttpError(400, '会话 id 不合法');
      await deps.manager.rename(id, needCwd(body.cwd), body.title as string);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'POST' && (m = /^\/api\/sessions\/([^/]+)\/fork$/.exec(p))) {
      const body = await readJson(req);
      const id = decodeURIComponent(m[1]!);
      if (!isSafe(id)) throw new HttpError(400, '会话 id 不合法');
      if (typeof body.targetId !== 'string') throw new HttpError(400, 'targetId 不合法');
      return sendJson(res, 200, await deps.manager.fork(id, needCwd(body.cwd), body.targetId));
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
    if (p === '/api/agy-accounts' || p.startsWith('/api/agy-accounts/')) return agyAccountRoutes(req, res, method, p);
    if (deps.agyCli && (p === '/api/agy/cli' || p.startsWith('/api/agy/cli/'))) {
      const r = await agyCliRoutes(deps.agyCli, { method, pathname: p, query: q, fromLocal: fromLocal(req) });
      if (!r) throw new HttpError(404, '未找到');
      return sendJson(res, r.status, r.body);
    }
    if (deps.components && (p === '/api/components' || p.startsWith('/api/components/'))) {
      const r = await componentRoutes(deps.components, { method, pathname: p, query: q, fromLocal: fromLocal(req) });
      if (!r) throw new HttpError(404, '未找到');
      return sendJson(res, r.status, r.body);
    }
    if (p === '/api/kiro' || p.startsWith('/api/kiro/')) return kiroRoutes(req, res, method, p, q);

    if (method === 'GET' && p === '/api/usage') return sendJson(res, 200, await deps.usage.get(q.get('refresh') === '1', q.get('session'), q.get('account')));
    if (method === 'GET' && p === '/api/models') {
      return sendJson(res, 200, (await deps.cliModels?.get(q.get('refresh') === '1', q.get('session'), q.get('account'))) ?? null);
    }

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
      // 批量：{ modes: { 名字: mode } }；单个：{ name, mode }
      if (body.modes !== undefined) {
        const m = body.modes;
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new HttpError(400, 'modes 不合法');
        const out: Record<string, SkillMode> = {};
        const entries = Object.entries(m as Record<string, unknown>);
        if (entries.length > 500) throw new HttpError(400, 'modes 太多');
        for (const [k, v] of entries) {
          if (!SKILL_NAME_RE.test(k)) throw new HttpError(400, 'skill 名不合法');
          if (!SKILL_MODES.includes(v as SkillMode)) throw new HttpError(400, 'mode 不合法');
          out[k] = v as SkillMode;
        }
        await deps.manager.setSkillModes(out);
        return sendJson(res, 200, { ok: true });
      }
      if (typeof body.name !== 'string' || !SKILL_NAME_RE.test(body.name)) throw new HttpError(400, 'skill 名不合法');
      if (!SKILL_MODES.includes(body.mode as SkillMode)) throw new HttpError(400, 'mode 不合法');
      await deps.manager.setSkillMode(body.name, body.mode as SkillMode);
      return sendJson(res, 200, { ok: true });
    }

    // 启用 / 停用一个内置工具（全局保存；运行中的会话立即拦截，新启动的会话直接看不到）
    if (method === 'POST' && p === '/api/tools') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !TOOL_NAME_RE.test(body.name)) throw new HttpError(400, '工具名不合法');
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 不合法');
      const disabledTools = await deps.manager.setToolEnabled(body.name, body.enabled);
      return sendJson(res, 200, { ok: true, disabledTools });
    }

    // 开启 / 关闭一个智能体（全局保存；经 permissions.deny 的 Agent(名字) 下发）
    if (method === 'POST' && p === '/api/agents') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !AGENT_NAME_RE.test(body.name)) throw new HttpError(400, '智能体名不合法');
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 不合法');
      const disabledAgents = await deps.manager.setAgentEnabled(body.name, body.enabled);
      return sendJson(res, 200, { ok: true, disabledAgents });
    }

    // 开启 / 关闭原生子代理（全局保存；关闭时有可用委派的会话停用整个 Agent 工具）
    if (method === 'POST' && p === '/api/native-agents') {
      const body = await readJson(req);
      if (typeof body.enabled !== 'boolean') throw new HttpError(400, 'enabled 不合法');
      const enabled = await deps.manager.setNativeAgents(body.enabled);
      return sendJson(res, 200, { ok: true, enabled });
    }

    // 自动压缩窗口（全局；null = 不覆盖）。运行中的会话立即生效，新启动的会话经 --settings 带上
    if (method === 'POST' && p === '/api/compact-window') {
      const body = await readJson(req);
      const w = body.window === null ? null : sanitizeCompactWindow(body.window);
      if (body.window !== null && w === null) throw new HttpError(400, `窗口需在 ${COMPACT_WINDOW_MIN}–${COMPACT_WINDOW_MAX} token 之间`);
      const window = await deps.manager.setCompactWindow(w);
      return sendJson(res, 200, { ok: true, window });
    }

    // 子代理的模型 / 强度（全局）。Claude 子代理经 PreToolUse hook 生效，对运行中的会话也立即起作用
    if (p === '/api/agent-models') {
      if (method === 'GET') return sendJson(res, 200, deps.store.state.agentModels);
      if (method === 'POST') {
        const config = parseAgentModels(await readJson(req));
        if (!config) throw new HttpError(400, '子代理模型配置不合法');
        deps.store.state.agentModels = config;
        deps.store.save();
        return sendJson(res, 200, { ok: true, config });
      }
    }
    if (method === 'GET' && p === '/api/delegate/models' && deps.delegateModels) {
      const raw = q.get('cwd');
      const cwd = raw && raw.trim() ? needCwd(raw) : os.homedir();
      try {
        return sendJson(res, 200, await deps.delegateModels(cwd, q.get('refresh') === '1'));
      } catch (e) {
        throw new HttpError(503, e instanceof Error ? e.message : String(e));
      }
    }

    // 跨会话的压缩效果统计（扫描主会话记录，文件没变的走缓存）
    if (method === 'GET' && p === '/api/compact/stats' && deps.compactStats) {
      return sendJson(res, 200, await deps.compactStats.get());
    }

    // 所有会话的工具累计调用次数（增量扫描会话记录）
    if (method === 'GET' && p === '/api/tools/stats' && deps.toolStats) {
      return sendJson(res, 200, await deps.toolStats.get());
    }

    // 读磁盘上的 SKILL.md（技能面板兜底）：只服务磁盘扫描到的 skill，名字不拼进路径
    if (method === 'GET' && p === '/api/skills/content') {
      const name = q.get('name') ?? '';
      if (!SKILL_NAME_RE.test(name)) throw new HttpError(400, 'skill 名不合法');
      const rawCwd = q.get('cwd');
      const cwd = rawCwd && rawCwd.trim() ? normalizeDir(rawCwd) : null;
      const content = readSkillContent(name, baseClaudeHome(), cwd);
      if (!content) throw new HttpError(404, '找不到这个 skill');
      return sendJson(res, 200, content);
    }

    // 移除用户级 / 项目级 skill（目录移到 ~/.cosyee/removed-skills 备份，不直接删除）
    if (method === 'POST' && p === '/api/skills/remove') {
      const body = await readJson(req);
      if (typeof body.name !== 'string' || !SKILL_NAME_RE.test(body.name)) throw new HttpError(400, 'skill 名不合法');
      const session = typeof body.session === 'string' && isSafeId(body.session) ? body.session : null;
      // cwd 只用来定位 <cwd>/.claude/skills 的扫描范围，真正移动的目录来自扫描结果
      const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? normalizeDir(body.cwd) : null;
      const r = await deps.manager.removeSkill(session, body.name, cwd);
      return sendJson(res, 200, { ok: true, backup: r.backup });
    }

    if (method === 'POST' && p === '/api/pick') {
      onlyLocal(req);
      const body = await readJson(req);
      const mode = parseMode(body.mode);
      const start = deps.workspaces.list().current ?? undefined;
      const items = await runPick(res, lock, { mode, title: '选择文件或文件夹', startDir: start });
      return sendJson(res, 200, { items: deps.previews.register(items), supportsMixed });
    }

    // 网页版选择窗口（远程连接时代替系统对话框）：列目录 / 登记选好的路径
    if (method === 'GET' && p === '/api/browse') {
      return sendJson(res, 200, await browseDir(q.get('path'), deps.workspaces.list().current ?? os.homedir()));
    }
    if (method === 'POST' && p === '/api/pick/paths') {
      const items = await statPicked((await readJson(req)).paths);
      return sendJson(res, 200, { items: deps.previews.register(items), supportsMixed: true });
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

    // 按文件名读粘贴的图片（会话流里历史消息的图片标签没有预览令牌）：只认 savePaste 生成的文件名
    if (method === 'GET' && (m = /^\/api\/pastes\/([^/]+)\/(info|raw)$/.exec(p))) {
      const t = await pasteTarget(decodeURIComponent(m[1]!));
      if (m[2] === 'info') {
        const info: PreviewInfo = { path: t.file, kind: 'file', size: t.size, mtime: t.mtime, isImage: true, childCount: null };
        return sendJson(res, 200, info);
      }
      res.writeHead(200, {
        'content-type': t.type,
        'content-length': t.size,
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      });
      const stream = fs.createReadStream(t.file);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
      return;
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

    // 会话工作目录内（或会话记录里提到过）的文件预览。cwd 由服务端按会话 id 解析（运行中的会话 → 会话记录头部），
    // 客户端传的 cwd 只在它是已打开的工作空间时才当作兜底（新会话还没有记录时）；授权规则见 files.ts。
    if (method === 'GET' && p === '/api/files/preview') {
      const cwd = await sessionCwd(q.get('session'), q.get('cwd'));
      return sendJson(res, 200, await previewFile(cwd, q.get('path'), mentionedIn(q.get('session')!)));
    }

    if (method === 'GET' && p === '/api/files/raw') {
      const cwd = await sessionCwd(q.get('session'), q.get('cwd'));
      const t = await openRaw(cwd, q.get('path'), mentionedIn(q.get('session')!));
      const headers: Record<string, string | number> = {
        'content-type': t.type,
        'content-length': t.size,
        'cache-control': 'private, no-cache',
        'x-content-type-options': 'nosniff',
      };
      if (t.svg) headers['content-security-policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:";
      res.writeHead(200, headers);
      // 句柄已按 O_NOFOLLOW + dev/ino 校验过；流结束 / 出错 / 客户端断开时由 autoClose 关闭
      const stream = t.handle.createReadStream({ start: 0, end: Math.max(0, t.size - 1), autoClose: true });
      if (t.size === 0) {
        void t.handle.close();
        res.end();
        return;
      }
      stream.on('error', () => res.destroy());
      res.on('close', () => stream.destroy());
      stream.pipe(res);
      return;
    }

    if (method === 'POST' && (p === '/api/files/reveal' || p === '/api/files/terminal')) {
      onlyLocal(req);
      const body = await readJson(req);
      const cwd = await sessionCwd(body.session, body.cwd);
      const target = await resolveForAction(cwd, body.path, mentionedIn(body.session as string));
      const spawner = deps.spawner ?? defaultSpawner;
      if (p === '/api/files/reveal') {
        if (!revealPath(target.abs, spawner)) throw new HttpError(404, '文件不存在');
      } else if (!(await openTerminal(target.isDir ? target.abs : path.dirname(target.abs), spawner))) {
        throw new HttpError(500, '无法打开终端');
      }
      return sendJson(res, 200, { ok: true });
    }

    // 会话里代码块的「运行」：远程连接也允许（远程本来就能让 Claude 跑 Bash，输出回显在页面上）
    if (method === 'POST' && p === '/api/exec') {
      const body = await readJson(req);
      const cwd = await sessionCwd(body.session, body.cwd);
      const lang = typeof body.lang === 'string' ? body.lang : '';
      const code = typeof body.code === 'string' ? body.code : '';
      if (!code.trim()) throw new HttpError(400, '代码为空');
      if (code.length > EXEC_CODE_LIMIT) throw new HttpError(400, '代码过长');
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); }; // 客户端点「停止」或断开：杀掉进程
      res.on('close', onClose);
      try {
        return sendJson(res, 200, await runSnippet({ lang, code, cwd, signal: ac.signal }));
      } finally {
        res.off('close', onClose);
      }
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
   * 文件接口用的会话工作目录：只信服务端知道的（运行中的会话 → 会话记录头部里的 cwd）；
   * 都没有时（新会话还没产生记录）才接受客户端给的 cwd，且它必须是已打开的工作空间。
   */
  async function sessionCwd(session: unknown, hint: unknown): Promise<string> {
    if (typeof session !== 'string' || !isSafe(session)) throw new HttpError(400, '会话 id 不合法');
    const known = deps.manager.knownCwd(session) ?? (await deps.sessions.findCwd(session));
    if (known) return normalizeDir(known);
    if (typeof hint === 'string' && hint.trim()) {
      const key = pathKey(normalizeDir(hint));
      const ws = deps.workspaces.list().list.find((w) => pathKey(normalizeDir(w.path)) === key);
      if (ws) return normalizeDir(ws.path);
    }
    throw new HttpError(404, '找不到该会话的工作目录');
  }

  /** cwd 之外的路径：会话记录里原样提到过才放行（session 已由 sessionCwd 校验过） */
  function mentionedIn(session: string): OutsideCheck {
    return (abs) => deps.sessions.mentions(session, mentionForms(abs), process.platform === 'win32');
  }

  /** 在服务端桌面上弹窗口的操作只接受本机连接：远程设备看不到这些窗口（前端远程时也不显示这些按钮） */
  function onlyLocal(req: IncomingMessage): void {
    if (!fromLocal(req)) throw new HttpError(403, '远程连接不能在服务器桌面上打开窗口');
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
    res: ServerResponse,
    l: PickLock,
    o: { mode: PickMode; title: string; startDir?: string },
  ) {
    if (l.busy) throw new HttpError(409, '已有选择窗口打开');
    const ac = new AbortController();
    // 客户端中途断开（刷新页面、关标签）：关掉选择窗口，否则它一直占着锁，之后的选择都 409。
    // 要听 res 的 close：读完请求体后 req 的 close 早就发过了，挂在 req 上永远等不到。
    const onClose = () => { if (!res.writableFinished) ac.abort(); };
    if (res.destroyed) throw new HttpError(499, '请求已取消');
    res.on('close', onClose);
    l.busy = true;
    try {
      return await pick({ ...o, signal: ac.signal });
    } catch (e) {
      if (ac.signal.aborted) throw new HttpError(499, '请求已取消');
      throw new HttpError(500, `无法打开选择窗口: ${e instanceof Error ? e.message : e}`);
    } finally {
      res.off('close', onClose);
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
