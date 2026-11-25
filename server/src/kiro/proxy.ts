// Kiro 代理进程池：每个 Kiro 账号一个独立的 kiro-rs sidecar 进程，数据隔离在 <账号目录>/kiro/。
// - ensure(dir) 同步启动并返回（幂等；崩溃后带退避重启；启动前同步检测端口冲突并更新 cosyee-api.json + config.json）
// - ready(dir) 等待端口可用并用自己的 adminApiKey 调 /api/admin/credentials 确认是自己的进程
// - stop(dir) / stopAll(sync?) / restartIdle()
// - 日志不落盘、不下发，只在内存里留少量尾部用于判断失败原因，对外错误脱敏
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { AccountKiroInfo, KiroBalance, KiroLoginMethod } from '@cosyee/shared';
import { readApiConfig, writeApiConfig } from '../accounts/api-config.js';
import { killTree, killTreeSync } from '../claude/bin.js';
import { pathKey } from '../paths.js';
import { HttpError } from '../workspaces.js';
import type { KiroEngine } from './engine.js';
import { KIRO_ENGINE_MISSING, KIRO_SERVICE_STOPPED, sanitizeKiroError, writeFileAtomic } from './sanitize.js';

export const KIRO_SUBDIR = 'kiro';
export const KIRO_CONFIG_FILE = 'config.json';
export const KIRO_CREDS_FILE = 'credentials.json';

const TAIL_MAX = 4096;
const READY_TIMEOUT_MS = 10_000;
const READY_POLL_MS = 120;
const READY_REQ_TIMEOUT_MS = 1500;
const ADMIN_REQ_TIMEOUT_MS = 15_000;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const STABLE_RESET_MS = 15_000;
/** 连续崩溃超过这个次数就不再自动拉起（下次会话启动或手动启动时再试） */
const AUTO_RESTART_MAX = 5;

export interface KiroProxyConfig {
  host: '127.0.0.1';
  port: number;
  region: string;
  apiKey: string;
  adminApiKey: string;
}

export interface KiroProxyOptions {
  engine: Pick<KiroEngine, 'binaryPath' | 'isEnabled'>;
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
  dir: string;
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

export function kiroDir(accountDir: string): string {
  return path.join(accountDir, KIRO_SUBDIR);
}

export function kiroConfigPath(accountDir: string): string {
  return path.join(accountDir, KIRO_SUBDIR, KIRO_CONFIG_FILE);
}

export function kiroCredsPath(accountDir: string): string {
  return path.join(accountDir, KIRO_SUBDIR, KIRO_CREDS_FILE);
}

export function readKiroProxyConfig(accountDir: string): KiroProxyConfig | null {
  try {
    const j = JSON.parse(fs.readFileSync(kiroConfigPath(accountDir), 'utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    if (typeof j.port !== 'number' || !Number.isInteger(j.port) || j.port < 1 || j.port > 65535) return null;
    if (typeof j.apiKey !== 'string' || !j.apiKey) return null;
    if (typeof j.adminApiKey !== 'string' || !j.adminApiKey) return null;
    return {
      host: '127.0.0.1',
      port: j.port,
      region: typeof j.region === 'string' && j.region ? j.region : 'us-east-1',
      apiKey: j.apiKey,
      adminApiKey: j.adminApiKey,
    };
  } catch {
    return null;
  }
}

export function writeKiroProxyConfig(accountDir: string, cfg: KiroProxyConfig): void {
  const clean: KiroProxyConfig = {
    host: '127.0.0.1',
    port: cfg.port,
    region: cfg.region || 'us-east-1',
    apiKey: cfg.apiKey,
    adminApiKey: cfg.adminApiKey,
  };
  writeFileAtomic(kiroConfigPath(accountDir), JSON.stringify(clean, null, 2) + '\n', 0o600);
}

/** 生成新的代理配置（127.0.0.1 + 两个互不相同的随机密钥） */
export function createProxyConfig(port: number, region = 'us-east-1'): KiroProxyConfig {
  const apiKey = crypto.randomBytes(24).toString('hex');
  let adminApiKey = crypto.randomBytes(24).toString('hex');
  while (adminApiKey === apiKey) adminApiKey = crypto.randomBytes(24).toString('hex');
  return { host: '127.0.0.1', port, region, apiKey, adminApiKey };
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
 * 只在代理冷启动前调用一次，保证 claudeEnv() 读取配置前就完成端口更新。
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
  if (/加载凭证失败|credentials/i.test(tail) && /failed|失败/i.test(tail)) return '凭据文件无效，请重新登录';
  if (signal) return `代理进程被信号 ${signal} 终止`;
  return code !== null ? `代理进程异常退出（退出码 ${code}）` : '代理进程异常退出';
}

export class KiroProxyManager {
  private entries = new Map<string, ProxyEntry>();

  constructor(private readonly opts: KiroProxyOptions) {}

  private key(dir: string): string {
    return pathKey(path.resolve(dir));
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private fetchFn(): typeof globalThis.fetch {
    return this.opts.fetch ?? globalThis.fetch;
  }

  async pickFreePort(): Promise<number> {
    return this.opts.pickFreePort ? this.opts.pickFreePort() : defaultPickFreePort();
  }

  /** 同步更新端口（同时写 kiro/config.json 与 cosyee-api.json，保证两者一致） */
  private updatePortSync(dir: string, cfg: KiroProxyConfig, newPort: number): KiroProxyConfig {
    const next: KiroProxyConfig = { ...cfg, port: newPort };
    writeKiroProxyConfig(dir, next);
    const api = readApiConfig(dir);
    if (api) {
      writeApiConfig(dir, {
        ...api,
        baseUrl: `http://127.0.0.1:${newPort}`,
        ...(api.kiro ? { kiro: { ...api.kiro, port: newPort } } : {}),
      });
    }
    return next;
  }

  /** 写入账号的 Kiro 代理配置与 cosyee-api.json（创建或重新登录时使用） */
  writeAccountConfigs(dir: string, method: KiroLoginMethod, cfg: KiroProxyConfig): void {
    writeKiroProxyConfig(dir, cfg);
    const existing = readApiConfig(dir);
    writeApiConfig(dir, {
      baseUrl: `http://127.0.0.1:${cfg.port}`,
      apiKey: cfg.apiKey,
      authType: 'apiKey',
      ...(existing?.models ? { models: existing.models } : {}),
      kiro: { method, port: cfg.port },
    });
  }

  /**
   * 同步启动账号的 kiro-rs 代理（幂等）。
   * - 总开关关闭时抛 409（绝不启动进程）
   * - 崩溃后在退避窗口内不疯狂重启（force=true 时跳过退避，如登录验证 / 主动启动）
   * - 启动前同步检测端口冲突，冲突时自动换端口并更新 config.json 与 cosyee-api.json
   */
  ensure(dir: string, opts?: { force?: boolean }): void {
    if (!this.opts.engine.isEnabled()) {
      throw new HttpError(409, KIRO_SERVICE_STOPPED);
    }
    const bin = this.opts.engine.binaryPath();
    if (!bin) {
      throw new HttpError(409, KIRO_ENGINE_MISSING);
    }

    const k = this.key(dir);
    const existing = this.entries.get(k);
    if (existing && existing.proc && existing.proc.exitCode === null && existing.proc.signalCode === null && !existing.stopping) {
      return;
    }

    const now = this.now();
    if (existing && !opts?.force && existing.nextAllowedAt > now) {
      return;
    }

    let cfg = readKiroProxyConfig(dir);
    if (!cfg) {
      this.entries.set(k, {
        dir,
        proc: null,
        state: 'failed',
        error: '缺少 Kiro 代理配置',
        port: 0,
        adminApiKey: '',
        startedBin: bin,
        startedAt: now,
        stderrTail: '',
        stopping: false,
        failures: (existing?.failures ?? 0) + 1,
        nextAllowedAt: now + BACKOFF_BASE_MS,
      });
      return;
    }

    // 启动前同步检查端口是否被其它程序占用；占用则立即换新端口并同步写回两个配置文件
    const findPort = this.opts.findFreePortSync ?? defaultFindFreePortSync;
    const chosenPort = findPort(cfg.port);
    if (chosenPort !== cfg.port) {
      cfg = this.updatePortSync(dir, cfg, chosenPort);
    }

    const args = ['--config', kiroConfigPath(dir), '--credentials', kiroCredsPath(dir)];
    const env = kiroChildEnv();
    const spawner = this.opts.spawnProxy ?? defaultSpawnProxy;
    let proc: ChildProcess;
    try {
      proc = spawner(bin, args, env);
    } catch (e) {
      const failures = (existing?.failures ?? 0) + 1;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, failures - 1));
      this.entries.set(k, {
        dir,
        proc: null,
        state: 'failed',
        error: `无法启动 kiro.rs：${sanitizeKiroError(e)}`,
        port: cfg.port,
        adminApiKey: cfg.adminApiKey,
        startedBin: bin,
        startedAt: now,
        stderrTail: '',
        stopping: false,
        failures,
        nextAllowedAt: now + delay,
      });
      return;
    }

    const entry: ProxyEntry = {
      dir,
      proc,
      state: 'starting',
      error: null,
      port: cfg.port,
      adminApiKey: cfg.adminApiKey,
      startedBin: bin,
      startedAt: now,
      stderrTail: '',
      stopping: false,
      failures: existing?.failures ?? 0,
      nextAllowedAt: 0,
    };
    this.entries.set(k, entry);

    const onLog = (d: Buffer) => {
      entry.stderrTail = (entry.stderrTail + d.toString('utf8')).slice(-TAIL_MAX);
    };
    proc.stdout?.on('data', onLog);
    proc.stderr?.on('data', onLog);

    proc.on('error', (err) => {
      if (this.entries.get(k) !== entry) return;
      entry.proc = null;
      if (entry.stopping) {
        entry.state = 'stopped';
        entry.error = null;
        return;
      }
      entry.failures++;
      entry.nextAllowedAt = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, entry.failures - 1));
      entry.state = 'failed';
      entry.error = `代理启动失败：${sanitizeKiroError(err)}`;
    });

    proc.on('close', (code, signal) => {
      if (this.entries.get(k) !== entry) return;
      entry.proc = null;
      if (entry.stopping) {
        entry.state = 'stopped';
        entry.error = null;
        return;
      }
      const wasReady = entry.state === 'ready';
      if (this.now() - entry.startedAt >= STABLE_RESET_MS) entry.failures = 0;
      entry.failures++;
      entry.nextAllowedAt = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, entry.failures - 1));
      entry.state = 'failed';
      entry.error = classifyExitError(code, signal, entry.stderrTail);
      // 常驻的 claude 进程还连着这个端口，没人会再调 ensure：运行中崩溃的由这里按退避自动拉起
      if (wasReady && entry.failures <= AUTO_RESTART_MAX) {
        const t = setTimeout(() => {
          if (this.entries.get(k) !== entry || entry.stopping) return;
          try { this.ensure(dir, { force: true }); } catch { /* 总开关已关或引擎没了 */ }
        }, Math.max(0, entry.nextAllowedAt - this.now()));
        t.unref?.();
      }
    });

    // 后台等就绪：claudeEnv / 手动启动只调 ensure，状态要能从「启动中」变成「运行中」
    void this.ready(dir).catch(() => { /* 失败原因记在 entry 里 */ });
  }

  /** 用自己的 adminApiKey 探测 /api/admin/credentials，确认监听者是我们自己的 kiro-rs 进程 */
  private async probeOwnAdmin(port: number, adminApiKey: string): Promise<boolean> {
    try {
      const res = await this.fetchFn()(`http://127.0.0.1:${port}/api/admin/credentials`, {
        headers: { 'x-api-key': adminApiKey },
        signal: AbortSignal.timeout(READY_REQ_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const j = (await res.json()) as { credentials?: unknown };
      return Array.isArray(j?.credentials);
    } catch {
      return false;
    }
  }

  /** 等待代理就绪（用自己的 adminApiKey 认证通过）；若遇端口竞态冲突自动换端口重试一次 */
  async ready(dir: string, opts?: { force?: boolean }): Promise<void> {
    this.ensure(dir, opts);
    const k = this.key(dir);
    let entry = this.entries.get(k);
    if (!entry) throw new HttpError(500, '代理未启动');
    if (entry.state === 'ready' && entry.proc && entry.proc.exitCode === null) return;

    const timeout = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    const poll = this.opts.readyPollMs ?? READY_POLL_MS;
    const deadline = this.now() + timeout;
    let retriedPort = false;

    while (this.now() < deadline) {
      entry = this.entries.get(k);
      if (!entry) throw new HttpError(500, '代理已停止');
      if (entry.state === 'ready' && entry.proc && entry.proc.exitCode === null) return;

      if (!entry.proc || entry.proc.exitCode !== null || entry.proc.signalCode !== null) {
        // 端口竞态冲突：换端口重试一次
        if (!retriedPort && !entry.stopping && isAddrInUse(entry.stderrTail)) {
          retriedPort = true;
          const cfg = readKiroProxyConfig(dir);
          if (cfg) {
            const nextPort = await this.pickFreePort();
            // 等待期间被停止、或另一处已经换端口重启：不能再改配置，否则端口与进程对不上
            if (this.entries.get(k) !== entry || entry.stopping) continue;
            this.updatePortSync(dir, cfg, nextPort);
            entry.failures = 0;
            entry.nextAllowedAt = 0;
            this.ensure(dir, { force: true });
            continue;
          }
        }
        throw new HttpError(502, entry.error ?? 'kiro.rs 代理启动失败');
      }

      if (await this.probeOwnAdmin(entry.port, entry.adminApiKey)) {
        if (this.entries.get(k) === entry && entry.proc && entry.proc.exitCode === null) {
          entry.state = 'ready';
          entry.error = null;
          entry.failures = 0;
          entry.nextAllowedAt = 0;
          return;
        }
      }

      await new Promise((r) => setTimeout(r, poll));
    }

    entry = this.entries.get(k);
    if (entry && entry.state === 'starting') {
      entry.state = 'failed';
      entry.error = 'kiro.rs 代理启动超时';
    }
    throw new HttpError(504, 'kiro.rs 代理启动超时');
  }

  /** 停止单个账号的代理进程 */
  async stop(dir: string): Promise<void> {
    const k = this.key(dir);
    const entry = this.entries.get(k);
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

  /** 停止全部代理；sync=true 用于 process.once('exit') 同步强杀 */
  stopAll(sync: true): void;
  stopAll(sync?: false): Promise<void>;
  stopAll(sync = false): void | Promise<void> {
    if (sync) {
      for (const entry of this.entries.values()) {
        entry.stopping = true;
        const proc = entry.proc;
        if (proc && proc.exitCode === null && proc.signalCode === null) {
          if (proc.pid) killTreeSync(proc.pid);
          else try { proc.kill(); } catch { /* ignore */ }
        }
        entry.proc = null;
        entry.state = 'stopped';
      }
      return;
    }
    return Promise.all([...this.entries.values()].map((e) => this.stop(e.dir))).then(() => undefined);
  }

  /** 引擎升级后调用：没有执行中会话的运行中代理自动重启换新版本 */
  async restartIdle(isBusy: (dir: string) => boolean): Promise<void> {
    const curBin = this.opts.engine.binaryPath();
    if (!curBin || !this.opts.engine.isEnabled()) return;
    const targets = [...this.entries.values()].filter(
      (e) =>
        (e.state === 'starting' || e.state === 'ready') &&
        e.proc &&
        e.proc.exitCode === null &&
        e.startedBin !== curBin &&
        !isBusy(e.dir),
    );
    for (const e of targets) {
      await this.stop(e.dir);
      if (this.opts.engine.isEnabled()) {
        try {
          this.ensure(e.dir, { force: true });
        } catch { /* 状态记在 entry 里 */ }
      }
    }
  }

  /** 查询单个账号的代理状态（供 Accounts.list() 使用） */
  stateOf(dir: string): Pick<AccountKiroInfo, 'proxy' | 'error'> {
    const entry = this.entries.get(this.key(dir));
    if (!entry) return { proxy: 'stopped', error: null };
    return { proxy: entry.state, error: entry.error };
  }

  /** 该账号的代理是否在运行且仍在使用旧版引擎 */
  isOutdated(dir: string): boolean {
    const curBin = this.opts.engine.binaryPath();
    if (!curBin) return false;
    const entry = this.entries.get(this.key(dir));
    if (!entry || !entry.proc || entry.proc.exitCode !== null) return false;
    if (entry.state !== 'starting' && entry.state !== 'ready') return false;
    return entry.startedBin !== curBin;
  }

  /** 内部：取当前账号活跃凭据 id；若用户在管理页面把凭据全删空，给出明确提示而非 404/崩溃 */
  private async credentialId(entry: ProxyEntry): Promise<number> {
    const res = await this.fetchFn()(`http://127.0.0.1:${entry.port}/api/admin/credentials`, {
      headers: { 'x-api-key': entry.adminApiKey },
      signal: AbortSignal.timeout(ADMIN_REQ_TIMEOUT_MS),
    });
    if (!res.ok) throw new HttpError(502, `查询凭据状态失败（HTTP ${res.status}）`);
    const j = (await res.json()) as {
      currentId?: unknown;
      credentials?: Array<{ id?: unknown; isCurrent?: unknown }>;
    };
    const list = Array.isArray(j?.credentials) ? j.credentials : null;
    if (list && list.length === 0) {
      throw new HttpError(409, '该 Kiro 账号当前没有可用凭据，请在管理页面添加或重新登录');
    }
    const cur = list?.find((c) => c?.isCurrent === true && typeof c.id === 'number' && Number.isInteger(c.id))?.id;
    if (typeof cur === 'number') return cur;
    const first = list?.[0]?.id;
    if (typeof first === 'number' && Number.isInteger(first)) return first;
    if (typeof j?.currentId === 'number' && Number.isInteger(j.currentId)) return j.currentId;
    return 1;
  }

  /** 确保代理就绪并返回管理页面地址与密钥（仅限 POST /api/kiro/service/admin 使用） */
  async adminEndpoint(dir: string): Promise<{ url: string; key: string }> {
    await this.ready(dir);
    const entry = this.entries.get(this.key(dir));
    if (!entry || !entry.port || !entry.adminApiKey) {
      throw new HttpError(502, '代理未运行或缺少管理配置');
    }
    return {
      url: `http://127.0.0.1:${entry.port}/admin`,
      key: entry.adminApiKey,
    };
  }

  /** 调用 Admin API 强制刷新凭据（用于 OAuth 登录验证） */
  async refreshToken(dir: string): Promise<void> {
    await this.ready(dir, { force: true });
    const entry = this.entries.get(this.key(dir));
    if (!entry) throw new HttpError(502, '代理未运行');
    const id = await this.credentialId(entry);
    const res = await this.fetchFn()(`http://127.0.0.1:${entry.port}/api/admin/credentials/${id}/refresh`, {
      method: 'POST',
      headers: { 'x-api-key': entry.adminApiKey },
      signal: AbortSignal.timeout(ADMIN_REQ_TIMEOUT_MS),
    });
    if (!res.ok) {
      let msg = `凭据验证失败（HTTP ${res.status}）`;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j?.error?.message) msg = sanitizeKiroError(j.error.message);
      } catch { /* ignore */ }
      throw new HttpError(502, msg);
    }
  }

  /** 调用 Admin API 查询余额（按需启动代理） */
  async getBalance(dir: string): Promise<KiroBalance> {
    await this.ready(dir);
    const entry = this.entries.get(this.key(dir));
    if (!entry) throw new HttpError(502, '代理未运行');
    const id = await this.credentialId(entry);
    const res = await this.fetchFn()(`http://127.0.0.1:${entry.port}/api/admin/credentials/${id}/balance`, {
      headers: { 'x-api-key': entry.adminApiKey },
      signal: AbortSignal.timeout(ADMIN_REQ_TIMEOUT_MS),
    });
    if (!res.ok) {
      let msg = `查询额度失败（HTTP ${res.status}）`;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j?.error?.message) msg = sanitizeKiroError(j.error.message);
      } catch { /* ignore */ }
      throw new HttpError(502, msg);
    }
    const j = (await res.json()) as {
      subscriptionTitle?: unknown;
      currentUsage?: unknown;
      usageLimit?: unknown;
      nextResetAt?: unknown;
    };
    const nextResetAt = typeof j?.nextResetAt === 'number' && Number.isFinite(j.nextResetAt) && j.nextResetAt > 0
      ? Math.round(j.nextResetAt * 1000)
      : null;
    return {
      subscription: typeof j?.subscriptionTitle === 'string' && j.subscriptionTitle.trim() ? j.subscriptionTitle.trim() : null,
      used: typeof j?.currentUsage === 'number' && Number.isFinite(j.currentUsage) ? j.currentUsage : 0,
      limit: typeof j?.usageLimit === 'number' && Number.isFinite(j.usageLimit) ? j.usageLimit : 0,
      resetsAt: nextResetAt,
    };
  }
}
