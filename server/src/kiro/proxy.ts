// 内置 kiro.rs 服务：全部 Kiro 账号共用一个 kiro-rs 进程，数据在 <引擎目录>/service/。
// - ensure() 同步启动并返回（幂等；崩溃后带退避重启；启动前同步检测端口冲突并改写配置与各账号的 cosyee-api.json）
// - ready() 等待端口可用并用管理密钥调 /api/admin/credentials 确认是自己的进程
// - stop() / stopAll(sync?) / restartIdle()
// - request() 调 Admin API（按需启动并等就绪）
// - 日志不落盘、不下发，只在内存里留少量尾部用于判断失败原因，对外错误脱敏
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { AccountKiroInfo } from '@cosyee/shared';
import { isLegacyKiro, readApiConfig, writeApiConfig } from '../accounts/api-config.js';
import { killTree, killTreeSync } from '../claude/bin.js';
import { pathKey } from '../paths.js';
import { HttpError } from '../workspaces.js';
import type { KiroEngine } from './engine.js';
import { KIRO_ENGINE_MISSING, KIRO_SERVICE_STOPPED, sanitizeKiroError, writeFileAtomic } from './sanitize.js';

export const KIRO_CONFIG_FILE = 'config.json';
export const KIRO_CREDS_FILE = 'credentials.json';

const TAIL_MAX = 4096;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 120;
const READY_REQ_TIMEOUT_MS = 1500;
/** 添加凭据时服务会真刷新一次 token，给足时间 */
const ADMIN_REQ_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_RESET_MS = 15_000;
/** 连续崩溃超过这个次数就不再自动拉起（下次会话启动或手动启动时再试） */
const AUTO_RESTART_MAX = 5;

export interface KiroServiceConfig {
  host: '127.0.0.1';
  port: number;
  /** 系统 Key：每次启动同步成 id=0 的客户端 Key（无分组、能用所有凭据）。只给 cosyee 内部用，绝不下发给账号 */
  apiKey: string;
  adminApiKey: string;
}

export interface KiroProxyOptions {
  engine: Pick<KiroEngine, 'binaryPath' | 'isEnabled'>;
  /** 服务数据目录（config.json、credentials.json 与服务自己的数据库都在这里） */
  dataDir: () => string;
  /** 全部 Kiro 账号：端口变化时据此改写各账号的 baseUrl */
  listKiroAccounts: () => Array<{ id: string; dir: string; label: string }>;
  /** 测试替换：启动 kiro-rs 进程 */
  spawnProxy?: (bin: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** 测试替换：HTTP 请求 */
  fetch?: typeof globalThis.fetch;
  /** 测试替换：同步检测端口是否空闲；若被占用返回一个新的空闲端口 */
  findFreePortSync?: (preferredPort: number) => number;
  /** 测试替换：异步分配空闲端口 */
  pickFreePort?: () => Promise<number>;
  /** 测试替换：时间源 */
  now?: () => number;
  /** 测试替换：ready 超时（ms） */
  readyTimeoutMs?: number;
  /** 测试替换：ready 轮询间隔（ms） */
  readyPollMs?: number;
}

interface ProxyEntry {
  proc: ChildProcess | null;
  state: AccountKiroInfo['proxy'];
  error: string | null;
  port: number;
  adminApiKey: string;
  /** 启动该进程时使用的二进制路径（用于判断引擎升级后是否 outdated） */
  startedBin: string;
  startedAt: number;
  stderrTail: string;
  stopping: boolean;
  failures: number;
  nextAllowedAt: number;
}

export function kiroConfigPath(dataDir: string): string {
  return path.join(dataDir, KIRO_CONFIG_FILE);
}

export function kiroCredsPath(dataDir: string): string {
  return path.join(dataDir, KIRO_CREDS_FILE);
}

export function readKiroServiceConfig(dataDir: string): KiroServiceConfig | null {
  try {
    const j = JSON.parse(fs.readFileSync(kiroConfigPath(dataDir), 'utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    if (typeof j.port !== 'number' || !Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return null;
    if (typeof j.apiKey !== 'string' || !j.apiKey) return null;
    if (typeof j.adminApiKey !== 'string' || !j.adminApiKey) return null;
    return { host: '127.0.0.1', port: j.port, apiKey: j.apiKey, adminApiKey: j.adminApiKey };
  } catch {
    return null;
  }
}

/** 写 config.json：服务不会改写它；updateAutoApply 固定 false，升级只走 cosyee 的引擎更新 */
export function writeKiroServiceConfig(dataDir: string, cfg: KiroServiceConfig): void {
  const clean = {
    host: '127.0.0.1',
    port: cfg.port,
    apiKey: cfg.apiKey,
    adminApiKey: cfg.adminApiKey,
    updateAutoApply: false,
  };
  writeFileAtomic(kiroConfigPath(dataDir), JSON.stringify(clean, null, 2) + '\n', 0o600);
}

/** 生成新的服务配置（127.0.0.1 + 两个互不相同的随机密钥） */
export function createServiceConfig(port: number): KiroServiceConfig {
  const apiKey = crypto.randomBytes(24).toString('hex');
  let adminApiKey = crypto.randomBytes(24).toString('hex');
  while (adminApiKey === apiKey) adminApiKey = crypto.randomBytes(24).toString('hex');
  return { host: '127.0.0.1', port, apiKey, adminApiKey };
}

/** 异步找一个本机 127.0.0.1 空闲端口 */
export function defaultPickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error('无法分配空闲端口'));
      });
    });
  });
}

/**
 * 同步检测 preferredPort 在 127.0.0.1 上是否可监听；若被占用则分配一个新的空闲端口。
 * 只在服务冷启动前调用一次，保证 claudeEnv() 读取配置前就完成端口更新。
 */
export function defaultFindFreePortSync(preferredPort: number): number {
  const script = `
    const net = require('node:net');
    const tryPort = (p, fb) => {
      const s = net.createServer();
      s.once('error', () => {
        if (fb) tryPort(0, false);
        else process.exit(1);
      });
      s.listen(p, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => { process.stdout.write(String(port)); });
      });
    };
    tryPort(${Number.isInteger(preferredPort) && preferredPort > 0 && preferredPort < 65536 ? preferredPort : 0}, true);
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 4000,
    // 桌面版里 execPath 是 Electron，要让它按 Node 运行
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const port = Number(r.stdout?.trim());
  if (r.status === 0 && Number.isInteger(port) && port > 0 && port < 65536) return port;
  return preferredPort;
}

/** 构造给 kiro-rs 子进程的环境：必须删掉 KIRO_API_KEY（避免它自动把环境变量当成凭据） */
export function kiroChildEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (k.toUpperCase() === 'KIRO_API_KEY') continue;
    env[k] = v;
  }
  return env;
}

function defaultSpawnProxy(bin: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(bin, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
}

function isAddrInUse(tail: string): boolean {
  return /address already in use|eaddrinuse|os error 10048|os error 98|os error 48/i.test(tail);
}

/** 从 kiro-rs 内存尾部日志中推断脱敏后的错误原因（绝不透传原始日志） */
function classifyExitError(code: number | null, signal: NodeJS.Signals | null, tail: string): string {
  if (isAddrInUse(tail)) return '本地代理端口被占用';
  if (/加载配置失败|config/i.test(tail) && /failed|失败/i.test(tail)) return '代理配置文件无效';
  if (/加载凭证失败|credentials/i.test(tail) && /failed|失败/i.test(tail)) return '凭据文件无效，请在管理页面检查';
  if (signal) return `代理进程被信号 ${signal} 终止`;
  return code !== null ? `代理进程异常退出（退出码 ${code}）` : '代理进程异常退出';
}

export interface AdminResponse {
  status: number;
  ok: boolean;
  /** 响应体 JSON；不是 JSON 时为 null */
  json: unknown;
}

/** 取 Admin API 错误响应里的 error.message（已脱敏）；没有就用 fallback */
export function adminErrorMessage(r: AdminResponse, fallback: string): string {
  const m = (r.json as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof m === 'string' && m.trim() ? sanitizeKiroError(m) : fallback;
}

export class KiroProxyManager {
  private entry: ProxyEntry | null = null;
  /** 账号自己的错误（如迁移失败），key = pathKey(账号目录) */
  private accountErrors = new Map<string, string>();

  constructor(private readonly opts: KiroProxyOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  fetchFn(): typeof globalThis.fetch {
    return this.opts.fetch ?? globalThis.fetch;
  }

  async pickFreePort(): Promise<number> {
    return this.opts.pickFreePort ? this.opts.pickFreePort() : defaultPickFreePort();
  }

  dataDir(): string {
    return this.opts.dataDir();
  }

  /** 服务当前使用的端口（读配置；还没创建过配置为 null） */
  port(): number | null {
    return readKiroServiceConfig(this.dataDir())?.port ?? null;
  }

  /** 账号客户端该用的 Base URL；服务配置还没创建时为空串 */
  baseUrl(): string {
    const p = this.port();
    return p ? `http://127.0.0.1:${p}` : '';
  }

  /** 读服务配置；没有就新建（同步：端口、两个随机密钥、空的 credentials.json） */
  private loadConfig(): KiroServiceConfig {
    const dir = this.dataDir();
    let cfg = readKiroServiceConfig(dir);
    // 目录里有凭据和 Key，只给当前用户（服务自己写的文件是 0644，靠目录权限挡住）
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    if (!cfg) {
      const findPort = this.opts.findFreePortSync ?? defaultFindFreePortSync;
      cfg = createServiceConfig(findPort(20000 + crypto.randomInt(0, 20000)));
      writeKiroServiceConfig(dir, cfg);
    }
    if (!fs.existsSync(kiroCredsPath(dir))) writeFileAtomic(kiroCredsPath(dir), '[]\n', 0o600);
    return cfg;
  }

  /** 把全部（已迁移的）Kiro 账号的 baseUrl 对齐到服务端口 */
  private syncBaseUrls(port: number): void {
    const baseUrl = `http://127.0.0.1:${port}`;
    for (const a of this.opts.listKiroAccounts()) {
      const api = readApiConfig(a.dir);
      if (!api?.kiro || isLegacyKiro(api.kiro) || api.baseUrl === baseUrl) continue;
      try {
        writeApiConfig(a.dir, { ...api, baseUrl });
      } catch { /* 单个账号写失败不影响服务启动 */ }
    }
  }

  /** 同步换端口：先写 config.json，再改写全部账号的 baseUrl，保证两者一致 */
  private updatePortSync(cfg: KiroServiceConfig, newPort: number): KiroServiceConfig {
    const next: KiroServiceConfig = { ...cfg, port: newPort };
    writeKiroServiceConfig(this.dataDir(), next);
    this.syncBaseUrls(newPort);
    return next;
  }

  private alive(e: ProxyEntry | null): e is ProxyEntry & { proc: ChildProcess } {
    return !!e && !!e.proc && e.proc.exitCode === null && e.proc.signalCode === null && !e.stopping;
  }

  private failedEntry(prev: ProxyEntry | null, bin: string, cfg: KiroServiceConfig | null, error: string): ProxyEntry {
    return {
      proc: null,
      state: 'failed',
      error,
      port: cfg?.port ?? prev?.port ?? 0,
      adminApiKey: cfg?.adminApiKey ?? prev?.adminApiKey ?? '',
      startedBin: bin,
      startedAt: this.now(),
      stderrTail: '',
      stopping: false,
      failures: prev?.failures ?? 0,
      nextAllowedAt: prev?.nextAllowedAt ?? 0,
    };
  }

  /**
   * 同步确保服务已启动（幂等）。必须同步：它在 claudeEnv 的前置钩子里调用，
   * 端口变化要在返回前就写进配置与各账号的 cosyee-api.json。
   * force=true 忽略崩溃退避（用户手动启动 / 管理操作）。
   */
  ensure(opts: { force?: boolean } = {}): void {
    if (!this.opts.engine.isEnabled()) throw new HttpError(409, KIRO_SERVICE_STOPPED);
    const bin = this.opts.engine.binaryPath();
    if (!bin) throw new HttpError(409, KIRO_ENGINE_MISSING);

    const existing = this.entry;
    if (this.alive(existing)) return;
    if (existing && !opts.force && existing.nextAllowedAt > this.now()) return;

    let cfg: KiroServiceConfig;
    try {
      cfg = this.loadConfig();
      const port = (this.opts.findFreePortSync ?? defaultFindFreePortSync)(cfg.port);
      if (port !== cfg.port) cfg = this.updatePortSync(cfg, port);
      else this.syncBaseUrls(cfg.port);
    } catch (e) {
      this.entry = this.failedEntry(existing, bin, null, `无法准备 kiro.rs 服务配置：${sanitizeKiroError(e)}`);
      return;
    }

    const dir = this.dataDir();
    const entry: ProxyEntry = {
      proc: null,
      state: 'starting',
      error: null,
      port: cfg.port,
      adminApiKey: cfg.adminApiKey,
      startedBin: bin,
      startedAt: this.now(),
      stderrTail: '',
      stopping: false,
      failures: existing?.failures ?? 0,
      nextAllowedAt: existing?.nextAllowedAt ?? 0,
    };
    this.entry = entry;

    let proc: ChildProcess;
    try {
      proc = (this.opts.spawnProxy ?? defaultSpawnProxy)(
        bin,
        ['--config', kiroConfigPath(dir), '--credentials', kiroCredsPath(dir)],
        kiroChildEnv(),
      );
    } catch (e) {
      entry.state = 'failed';
      entry.error = `无法启动代理进程：${sanitizeKiroError(e)}`;
      return;
    }
    entry.proc = proc;

    const collect = (buf: Buffer | string): void => {
      entry.stderrTail = (entry.stderrTail + String(buf)).slice(-TAIL_MAX);
    };
    proc.stdout?.on('data', collect);
    proc.stderr?.on('data', collect);
    proc.on('error', (e) => {
      if (this.entry !== entry) return;
      entry.state = 'failed';
      entry.error = `无法启动代理进程：${sanitizeKiroError(e)}`;
      entry.proc = null;
    });
    proc.on('close', (code, signal) => this.onClose(entry, code, signal));
    void this.ready().catch(() => undefined);
  }

  private onClose(entry: ProxyEntry, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.entry !== entry) return;
    entry.proc = null;
    if (entry.stopping) {
      entry.state = 'stopped';
      entry.error = null;
      return;
    }
    const wasReady = entry.state === 'ready';
    const lived = this.now() - entry.startedAt;
    entry.state = 'failed';
    entry.error = classifyExitError(code, signal, entry.stderrTail);
    entry.failures = lived >= STABLE_RESET_MS ? 1 : entry.failures + 1;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, entry.failures - 1));
    entry.nextAllowedAt = this.now() + delay;
    // 运行中崩溃：带退避自动拉起，最多 AUTO_RESTART_MAX 次；刚启动就失败（端口占用等）交给 ready() 处理
    if (wasReady && entry.failures <= AUTO_RESTART_MAX) {
      const t = setTimeout(() => {
        if (this.entry !== entry || entry.proc || entry.stopping) return;
        try {
          this.ensure({ force: true });
        } catch { /* 状态记在 entry 里 */ }
      }, delay);
      t.unref?.();
    }
  }

  private async probe(e: ProxyEntry): Promise<boolean> {
    try {
      const res = await this.fetchFn()(`http://127.0.0.1:${e.port}/api/admin/credentials`, {
        headers: { 'x-api-key': e.adminApiKey, accept: 'application/json' },
        signal: AbortSignal.timeout(READY_REQ_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * 等服务就绪：用管理密钥调 /api/admin/credentials，确认响应的是自己的进程而不是占用端口的别人。
   * 没在运行时会先尝试启动；启动时端口被占用则换端口重试一次。
   */
  async ready(opts: { force?: boolean } = {}): Promise<void> {
    if (!this.alive(this.entry)) this.ensure(opts);
    const timeout = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const poll = this.opts.readyPollMs ?? READY_POLL_MS;
    const deadline = Date.now() + timeout;
    let portRetried = false;
    for (;;) {
      const e = this.entry;
      if (!e) throw new HttpError(502, 'kiro.rs 服务未运行');
      if (e.state === 'ready' && this.alive(e)) return;
      if (e.state === 'failed' || e.state === 'stopped' || !e.proc) {
        if (e.state === 'failed' && !portRetried && isAddrInUse(e.stderrTail)) {
          portRetried = true;
          const cfg = readKiroServiceConfig(this.dataDir());
          if (cfg) {
            const newPort = await this.pickFreePort();
            // 并发的 ready() 只让第一个换端口；别的调用醒来时 entry 已换成新进程，不能再改配置
            if (this.entry === e) {
              this.updatePortSync(cfg, newPort);
              this.ensure({ force: true });
            }
            continue;
          }
        }
        throw new HttpError(502, e.error ?? 'kiro.rs 服务未运行');
      }
      if (await this.probe(e)) {
        if (this.entry === e && this.alive(e)) {
          e.state = 'ready';
          e.error = null;
          return;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new HttpError(504, '等待 kiro.rs 服务就绪超时');
      await new Promise<void>((r) => setTimeout(r, poll));
    }
  }

  /** 停止服务 */
  async stop(): Promise<void> {
    const entry = this.entry;
    if (!entry) return;
    entry.stopping = true;
    const proc = entry.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const done = new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        t.unref?.();
        proc.once('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
      if (proc.pid) killTree(proc.pid);
      else try { proc.kill(); } catch { /* ignore */ }
      await done;
    }
    entry.proc = null;
    entry.state = 'stopped';
    entry.error = null;
    entry.failures = 0;
    entry.nextAllowedAt = 0;
  }

  /** 停止服务；sync=true 用于 process.once('exit') 同步强杀 */
  stopAll(sync: true): void;
  stopAll(sync?: false): Promise<void>;
  stopAll(sync = false): void | Promise<void> {
    if (!sync) return this.stop();
    const entry = this.entry;
    if (!entry) return;
    entry.stopping = true;
    const proc = entry.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      if (proc.pid) killTreeSync(proc.pid);
      else try { proc.kill(); } catch { /* ignore */ }
    }
    entry.proc = null;
    entry.state = 'stopped';
  }

  /** 引擎升级后调用：没有执行中 Kiro 会话时重启服务换新版本；有会话在跑就保持 outdated 等下次 */
  async restartIdle(isBusy: () => boolean): Promise<void> {
    const curBin = this.opts.engine.binaryPath();
    const e = this.entry;
    if (!curBin || !this.opts.engine.isEnabled() || !e || !this.alive(e)) return;
    if (e.startedBin === curBin || isBusy()) return;
    await this.stop();
    if (this.opts.engine.isEnabled()) {
      try {
        this.ensure({ force: true });
      } catch { /* 状态记在 entry 里 */ }
    }
  }

  /** 服务是否在用旧版本引擎启动 */
  isOutdated(): boolean {
    const e = this.entry;
    if (!e || !this.alive(e) || (e.state !== 'starting' && e.state !== 'ready')) return false;
    const cur = this.opts.engine.binaryPath();
    return !!cur && e.startedBin !== cur;
  }

  /** 服务自身状态 */
  serviceState(): { proxy: AccountKiroInfo['proxy']; error: string | null } {
    const e = this.entry;
    if (!e) return { proxy: 'stopped', error: null };
    return { proxy: e.state, error: e.error };
  }

  setAccountError(dir: string, message: string | null): void {
    const k = pathKey(dir);
    if (message) this.accountErrors.set(k, message);
    else this.accountErrors.delete(k);
  }

  /** 某个账号的状态：账号自己有错（迁移失败）时报 failed，否则是服务状态 */
  stateOf(dir: string): { proxy: AccountKiroInfo['proxy']; error: string | null } {
    const own = this.accountErrors.get(pathKey(dir));
    if (own) return { proxy: 'failed', error: own };
    return this.serviceState();
  }

  /** 管理页面地址与管理密钥（只给本机桌面客户端用） */
  async adminEndpoint(): Promise<{ url: string; key: string }> {
    await this.ready();
    const e = this.entry;
    if (!e) throw new HttpError(502, 'kiro.rs 服务未运行');
    return { url: `http://127.0.0.1:${e.port}/admin`, key: e.adminApiKey };
  }

  /** 调 Admin API（按需启动并等就绪）。网络错误抛 502，HTTP 错误状态在返回值里 */
  async request(method: string, pathname: string, body?: unknown, opts: { force?: boolean } = {}): Promise<AdminResponse> {
    await this.ready(opts);
    const e = this.entry;
    if (!e) throw new HttpError(502, 'kiro.rs 服务未运行');
    const headers: Record<string, string> = { 'x-api-key': e.adminApiKey, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchFn()(`http://127.0.0.1:${e.port}/api/admin${pathname}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(ADMIN_REQ_TIMEOUT_MS),
      });
    } catch (err) {
      throw new HttpError(502, `请求 kiro.rs 服务失败：${sanitizeKiroError(err)}`);
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch { /* 响应体不是 JSON */ }
    return { status: res.status, ok: res.ok, json };
  }
}
