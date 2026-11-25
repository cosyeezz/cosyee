// Antigravity CLI（agy）本体的版本检查、升级 / 安装、日志与常驻进程管理。
// 安装与升级都走官方渠道（已安装运行 agy update，未安装执行官方安装脚本），绝不修改 agy 自身文件。
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { AgyCliStatus } from '@cosyee/shared';
import { RunningError } from '../accounts/index.js';
import { killTree, spawnSpec } from '../claude/bin.js';
import { HttpError } from '../workspaces.js';
import { resolveAgy } from './agy.js';

/** 官方版本清单基准地址（来自 https://antigravity.google/cli/install.ps1 与 install.sh） */
export const MANIFEST_BASE_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';
/** 官方安装脚本地址（写死常量，绝不拼接外部输入） */
export const INSTALL_PS1_URL = 'https://antigravity.google/cli/install.ps1';
export const INSTALL_SH_URL = 'https://antigravity.google/cli/install.sh';

const GENERIC_USER_AGENT = 'antigravity-cli-check/1.0';
const VERSION_TIMEOUT_MS = 5_000;
const CHECK_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 10 * 60_000;
const MANIFEST_MAX_BYTES = 64 * 1024;
const LOG_MAX_LINES = 2000;
const LOG_LINE_MAX_CHARS = 2000;
const OUTPUT_CAPTURE_MAX = 64 * 1024;

const STRICT_SEMVER_RE = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/;
const EMBEDDED_SEMVER_RE = /(?:^|[\svV])(\d{1,9}\.\d{1,9}\.\d{1,9})(?=$|[\s+-])/;

export interface AgyCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface AgyCommandOpts {
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export type AgyCommandRunner = (cmd: string, args: string[], opts: AgyCommandOpts) => Promise<AgyCommandResult>;

export interface AgyCliPool {
  stats(): { processes: number; sessions: number; busy: number };
  runningCount(accountId?: string): number;
  retireAll(): void;
  stopAll(force?: boolean): { stopped: boolean; running: number };
}

export interface AgyCliOptions {
  /** 常驻 ACP 进程池；不传则视为无常驻进程 */
  pool?: AgyCliPool;
  /** 定位 agy 可执行文件；默认 resolveAgy */
  resolveAgy?: (env?: NodeJS.ProcessEnv) => string | null;
  /** 环境变量；默认 () => process.env */
  env?: () => NodeJS.ProcessEnv;
  /** 读取文件元信息（判断二进制 mtime / size 是否变化）；默认 fs.statSync */
  statFile?: (filePath: string) => { mtimeMs: number; size: number } | null;
  /** 执行外部命令（--version / update / install） */
  runCommand?: AgyCommandRunner;
  /** HTTP 请求（查官方 manifest） */
  fetch?: typeof globalThis.fetch;
  /** 系统平台（测试可注入） */
  platform?: NodeJS.Platform;
  /** CPU 架构（测试可注入） */
  arch?: string;
  /** Linux 下是否为 musl libc（测试可注入） */
  isMusl?: () => boolean;
  /** 时钟（测试可注入） */
  now?: () => number;
  /** 读取版本超时（ms），默认 5000 */
  versionTimeoutMs?: number;
  /** 检查最新版超时（ms），默认 15000 */
  checkTimeoutMs?: number;
  /** 安装 / 升级总超时（ms），默认 10 分钟 */
  jobTimeoutMs?: number;
  /** 日志缓冲区最大行数，默认 2000 */
  logMaxLines?: number;
  /** 状态变化回调（安装 / 升级开始或结束时触发） */
  onChanged?: () => void;
}

export interface AgyCliRouteRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  fromLocal: boolean;
}

export interface AgyCliRouteResponse {
  status: number;
  body: unknown;
}

/** 严格校验版本号形如 x.y.z */
export function isStrictSemver(v: string): boolean {
  return STRICT_SEMVER_RE.test(v);
}

/** 从 agy --version 等输出中提取 x.y.z 版本号 */
export function parseAgyVersion(raw: string): string | null {
  const cleaned = stripAnsi(raw).trim();
  if (!cleaned) return null;
  if (STRICT_SEMVER_RE.test(cleaned)) return cleaned;
  const m = EMBEDDED_SEMVER_RE.exec(cleaned);
  return m ? m[1]! : null;
}

/** 语义化版本比较（a > b 返回 1，相等返回 0，a < b 返回 -1）；非法输入按 0 处理 */
export function compareSemver(a: string, b: string): number {
  const ma = STRICT_SEMVER_RE.exec(a.trim());
  const mb = STRICT_SEMVER_RE.exec(b.trim());
  if (!ma || !mb) return 0;
  for (let i = 1; i <= 3; i++) {
    const na = Number(ma[i]);
    const nb = Number(mb[i]);
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

/** 去掉 ANSI / OSC 转义序列与回车符 */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r/g, '');
}

/** 清理单行日志：去 ANSI、遮掉令牌 / Bearer / 密钥 / 邮箱，限制长度 */
export function sanitizeLogLine(raw: string): string {
  let s = stripAnsi(raw);
  // Bearer 令牌
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]');
  // JWT
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]');
  // Google OAuth access / refresh token
  s = s.replace(/\bya29\.[A-Za-z0-9._-]{10,}/g, '[REDACTED]');
  s = s.replace(/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[REDACTED]');
  // URL 查询参数中的敏感字段
  s = s.replace(/([?&](?:access_token|refresh_token|id_token|token|api_key|key|secret|code)=)[^&\s"'<>]+/gi, '$1[REDACTED]');
  // 键值对形式的 token / secret / key / authorization
  s = s.replace(
    /\b((?:access|refresh|id|auth|api|session|oauth)?[_-]?(?:token|secret|key|password|authorization))\s*([=:])\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    '$1$2[REDACTED]',
  );
  // 邮箱
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
  if (s.length > LOG_LINE_MAX_CHARS) s = s.slice(0, LOG_LINE_MAX_CHARS) + '…';
  return s;
}

function defaultIsMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    if (fs.existsSync('/lib/libc.musl-x86_64.so.1') || fs.existsSync('/lib/libc.musl-aarch64.so.1')) return true;
  } catch { /* 忽略 */ }
  return false;
}

/** 映射为官方 manifest 文件名（不含 .json）；不支持的平台返回 null */
export function manifestPlatform(platform: NodeJS.Platform, arch: string, isMusl = false): string | null {
  const normArch = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  if (!normArch) return null;
  if (platform === 'win32') return `windows_${normArch}`;
  if (platform === 'darwin') return `darwin_${normArch}`;
  if (platform === 'linux') return isMusl ? `linux_${normArch}_musl` : `linux_${normArch}`;
  return null;
}

function defaultStatFile(filePath: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return null;
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/** 执行外部命令（关闭 stdin、隐藏窗口、不启用 shell，Windows 下自动处理 .cmd/.bat） */
function defaultRunCommand(cmd: string, args: string[], opts: AgyCommandOpts): Promise<AgyCommandResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('操作已取消'));
      return;
    }
    const spec = spawnSpec(cmd, args);
    let proc: ChildProcess;
    try {
      proc = spawn(spec.command, spec.args, {
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: spec.verbatim,
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    let outBuf = '';
    let errBuf = '';

    const pushChunk = (chunk: string, isErr: boolean) => {
      if (isErr) {
        if (stderr.length < OUTPUT_CAPTURE_MAX) stderr += chunk;
        errBuf += chunk;
        const parts = errBuf.split(/\r?\n/);
        errBuf = parts.pop() ?? '';
        for (const l of parts) opts.onLine?.(l);
      } else {
        if (stdout.length < OUTPUT_CAPTURE_MAX) stdout += chunk;
        outBuf += chunk;
        const parts = outBuf.split(/\r?\n/);
        outBuf = parts.pop() ?? '';
        for (const l of parts) opts.onLine?.(l);
      }
    };

    proc.stdout?.on('data', (d: Buffer | string) => pushChunk(d.toString('utf8'), false));
    proc.stderr?.on('data', (d: Buffer | string) => pushChunk(d.toString('utf8'), true));

    const onAbort = () => {
      if (proc.pid) killTree(proc.pid);
      else try { proc.kill(); } catch { /* 忽略 */ }
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    proc.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    proc.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (outBuf) opts.onLine?.(outBuf);
      if (errBuf) opts.onLine?.(errBuf);
      if (opts.signal?.aborted) {
        reject(new Error('操作已超时或取消'));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  const lenHeader = res.headers?.get?.('content-length');
  if (lenHeader) {
    const n = Number(lenHeader);
    if (Number.isFinite(n) && n > maxBytes) throw new Error('响应体积超出限制');
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error('响应体积超出限制');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('响应体积超出限制');
  return text;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const cleaned = sanitizeLogLine(lines[i]!).trim();
    if (cleaned) return cleaned;
  }
  return null;
}

interface VersionCache {
  path: string;
  mtimeMs: number;
  size: number;
  version: string;
}

export class AgyCli {
  private readonly pool?: AgyCliPool;
  private readonly resolveAgyFn: (env?: NodeJS.ProcessEnv) => string | null;
  private readonly envFn: () => NodeJS.ProcessEnv;
  private readonly statFileFn: (filePath: string) => { mtimeMs: number; size: number } | null;
  private readonly runCmd: AgyCommandRunner;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly isMuslFn: () => boolean;
  private readonly nowFn: () => number;
  private readonly versionTimeoutMs: number;
  private readonly checkTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly logMax: number;
  private readonly onChanged?: () => void;

  private versionCache: VersionCache | null = null;
  private versionInflight: Promise<string | null> | null = null;
  private versionSeq = 0;
  private versionAbort: AbortController | null = null;

  private latest: string | null = null;
  private checkedAt: number | null = null;
  private checkError: string | null = null;
  private checkInflight: Promise<void> | null = null;
  private checkAbort: AbortController | null = null;

  private job: AgyCliStatus['job'] = null;
  private jobPromise: Promise<void> | null = null;
  private jobTimer: ReturnType<typeof setTimeout> | null = null;

  private logLines: string[] = [];
  private logBase = 0;
  private disposed = false;

  constructor(opts: AgyCliOptions = {}) {
    this.pool = opts.pool;
    this.resolveAgyFn = opts.resolveAgy ?? resolveAgy;
    this.envFn = opts.env ?? (() => process.env);
    this.statFileFn = opts.statFile ?? defaultStatFile;
    this.runCmd = opts.runCommand ?? defaultRunCommand;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.platform = opts.platform ?? process.platform;
    this.arch = opts.arch ?? process.arch;
    this.isMuslFn = opts.isMusl ?? defaultIsMusl;
    this.nowFn = opts.now ?? Date.now;
    this.versionTimeoutMs = opts.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
    this.checkTimeoutMs = opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? JOB_TIMEOUT_MS;
    this.logMax = opts.logMaxLines ?? LOG_MAX_LINES;
    this.onChanged = opts.onChanged;
  }

  private isCustom(env: NodeJS.ProcessEnv): boolean {
    return Boolean(env.COSYEE_AGY?.trim());
  }

  private notify(): void {
    if (this.disposed) return;
    try {
      this.onChanged?.();
    } catch { /* 回调异常不影响主流程 */ }
  }

  /** 读取本机 agy 版本，按路径 + mtime + size 缓存；失败返回 null */
  private async readVersion(agyPath: string, force = false): Promise<string | null> {
    const st = this.statFileFn(agyPath);
    if (!force && this.versionCache && this.versionCache.path === agyPath) {
      if (st && this.versionCache.mtimeMs === st.mtimeMs && this.versionCache.size === st.size) {
        return this.versionCache.version;
      }
      if (!st && this.versionCache.mtimeMs === -1 && this.versionCache.size === -1) {
        return this.versionCache.version;
      }
    }
    // force（升级刚结束）不复用升级前发起的探测，否则会拿到旧版本号
    if (!force && this.versionInflight) return this.versionInflight;

    const seq = ++this.versionSeq;
    const p = (async (): Promise<string | null> => {
      const ac = new AbortController();
      this.versionAbort = ac;
      const timer = setTimeout(() => ac.abort(), this.versionTimeoutMs);
      timer.unref?.();
      try {
        const res = await this.runCmd(agyPath, ['--version'], {
          env: this.envFn(),
          signal: ac.signal,
        });
        if (res.code !== 0) return null;
        const parsed = parseAgyVersion(res.stdout) ?? parseAgyVersion(res.stderr);
        // 缓存键用探测前的文件信息：探测期间文件被换掉时，下次会因不匹配而重读
        if (parsed && this.versionSeq === seq) {
          this.versionCache = {
            path: agyPath,
            mtimeMs: st ? st.mtimeMs : -1,
            size: st ? st.size : -1,
            version: parsed,
          };
        }
        return parsed;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
        if (this.versionAbort === ac) this.versionAbort = null;
      }
    })();

    this.versionInflight = p;
    try {
      return await p;
    } finally {
      if (this.versionInflight === p) this.versionInflight = null;
    }
  }

  /** 读取当前状态（不访问网络） */
  async status(): Promise<AgyCliStatus> {
    const env = this.envFn();
    const custom = this.isCustom(env);
    const agyPath = this.resolveAgyFn(env);
    const installed = agyPath !== null;
    const version = agyPath ? await this.readVersion(agyPath) : null;
    const updateAvailable = Boolean(
      installed && version && this.latest && compareSemver(this.latest, version) > 0,
    );
    const processes = this.pool ? this.pool.stats().processes : 0;
    const busy = this.pool ? this.pool.runningCount() : 0;
    return {
      installed,
      custom,
      version,
      latest: this.latest,
      updateAvailable,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      processes,
      busy,
      job: this.job ? { ...this.job } : null,
    };
  }

  /** 查询官方最新版本清单；失败记入 checkError，绝不抛错崩溃 */
  async check(): Promise<AgyCliStatus> {
    if (!this.checkInflight) {
      const p = this.doCheck();
      this.checkInflight = p;
      try {
        await p;
      } finally {
        if (this.checkInflight === p) this.checkInflight = null;
      }
    } else {
      await this.checkInflight;
    }
    return this.status();
  }

  private async doCheck(): Promise<void> {
    const plat = manifestPlatform(this.platform, this.arch, this.isMuslFn());
    if (!plat) {
      this.checkedAt = this.nowFn();
      this.checkError = '当前系统平台不支持自动检查版本';
      return;
    }
    const url = `${MANIFEST_BASE_URL}/${plat}.json`;
    const ac = new AbortController();
    this.checkAbort = ac;
    const timer = setTimeout(() => ac.abort(), this.checkTimeoutMs);
    timer.unref?.();
    try {
      const res = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          'User-Agent': GENERIC_USER_AGENT,
          Accept: 'application/json',
        },
        signal: ac.signal,
      });
      if (!res.ok) {
        this.checkedAt = this.nowFn();
        this.checkError = `检查最新版本失败（HTTP ${res.status}）`;
        return;
      }
      const text = await readTextLimited(res, MANIFEST_MAX_BYTES);
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        this.checkedAt = this.nowFn();
        this.checkError = '官方版本清单 JSON 解析失败';
        return;
      }
      const rawVer =
        data && typeof data === 'object' && typeof (data as Record<string, unknown>).version === 'string'
          ? ((data as Record<string, unknown>).version as string).trim()
          : '';
      if (!isStrictSemver(rawVer)) {
        this.checkedAt = this.nowFn();
        this.checkError = '官方版本清单版本号格式无效';
        return;
      }
      this.latest = rawVer;
      this.checkedAt = this.nowFn();
      this.checkError = null;
    } catch (e) {
      this.checkedAt = this.nowFn();
      const msg = ac.signal.aborted ? '检查最新版本超时' : `检查最新版本失败: ${sanitizeLogLine(errMsg(e))}`;
      this.checkError = msg;
    } finally {
      clearTimeout(timer);
      if (this.checkAbort === ac) this.checkAbort = null;
    }
  }

  /** 启动后台升级（已安装）或安装（未安装）；custom 或进行中抛 409 */
  async update(): Promise<AgyCliStatus> {
    const env = this.envFn();
    if (this.isCustom(env)) {
      throw new HttpError(409, '已通过 COSYEE_AGY 指定自定义程序，不支持自动安装或升级');
    }
    if (this.job?.state === 'running') {
      throw new HttpError(409, this.job.kind === 'install' ? '正在安装中，请稍候' : '正在升级中，请稍候');
    }

    const agyPath = this.resolveAgyFn(env);
    const kind: 'install' | 'update' = agyPath ? 'update' : 'install';
    this.job = { kind, state: 'running', error: null };
    this.resetLog();
    this.appendLog(kind === 'install' ? '开始安装 Antigravity CLI…' : '开始升级 Antigravity CLI…');
    this.notify();

    this.jobPromise = this.runJob(kind, agyPath, env);
    return this.status();
  }

  private async runJob(kind: 'install' | 'update', agyPath: string | null, env: NodeJS.ProcessEnv): Promise<void> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.jobTimeoutMs);
    timer.unref?.();
    this.jobTimer = timer;

    try {
      let cmd: string;
      let args: string[];
      if (kind === 'update' && agyPath) {
        cmd = agyPath;
        args = ['update'];
      } else if (this.platform === 'win32') {
        cmd = 'powershell.exe';
        args = [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `& ([scriptblock]::Create((Invoke-RestMethod -UseBasicParsing -Uri '${INSTALL_PS1_URL}')))`,
        ];
      } else {
        cmd = 'bash';
        args = ['-c', `set -o pipefail; curl -fsSL '${INSTALL_SH_URL}' | bash`];
      }

      const res = await this.runCmd(cmd, args, {
        env,
        signal: ac.signal,
        onLine: (line) => this.appendLog(line),
      });

      if (res.code !== 0) {
        const detail = lastNonEmptyLine(res.stderr) ?? lastNonEmptyLine(res.stdout);
        const prefix = kind === 'install' ? '安装失败' : '升级失败';
        const error = detail ? `${prefix}（退出码 ${res.code}）: ${detail}` : `${prefix}（退出码 ${res.code}）`;
        this.appendLog(error);
        this.job = { kind, state: 'failed', error };
        return;
      }

      // 成功后清理版本缓存并重新定位 / 读取版本
      this.versionCache = null;
      const nextPath = this.resolveAgyFn(this.envFn());
      if (!nextPath) {
        const error = kind === 'install' ? '安装命令已完成，但未找到 agy 可执行文件' : '升级后未找到 agy 可执行文件';
        this.appendLog(error);
        this.job = { kind, state: 'failed', error };
        return;
      }
      const nextVer = await this.readVersion(nextPath, true);
      this.appendLog(nextVer ? `完成，当前版本：${nextVer}` : '完成');
      this.job = null;
      // 回收空闲常驻进程，执行中的任务不打断（结束后不再复用并自动退出）
      this.pool?.retireAll();
    } catch (e) {
      const prefix = kind === 'install' ? '安装' : '升级';
      const error = timedOut ? `${prefix}超时，已终止子进程` : `${prefix}失败: ${sanitizeLogLine(errMsg(e))}`;
      this.appendLog(error);
      this.job = { kind, state: 'failed', error };
    } finally {
      clearTimeout(timer);
      if (this.jobTimer === timer) this.jobTimer = null;
      this.notify();
    }
  }

  /** 等待当前后台安装 / 升级任务结束（测试用） */
  waitForJob(): Promise<void> {
    return this.jobPromise ?? Promise.resolve();
  }

  /** 读取增量日志；超过上限截断头部后 next 仍单调递增 */
  log(from = 0): { lines: string[]; next: number } {
    const start = Number.isInteger(from) && from > 0 ? from : 0;
    const next = this.logBase + this.logLines.length;
    if (start >= next) return { lines: [], next };
    const idx = Math.max(0, start - this.logBase);
    return { lines: this.logLines.slice(idx), next };
  }

  private appendLog(rawLine: string): void {
    const line = sanitizeLogLine(rawLine);
    this.logLines.push(line);
    if (this.logLines.length > this.logMax) {
      const drop = this.logLines.length - this.logMax;
      this.logLines.splice(0, drop);
      this.logBase += drop;
    }
  }

  private resetLog(): void {
    this.logLines = [];
    this.logBase = 0;
  }

  /** 回收常驻 agy acp 进程；有执行中任务且未 force 时抛 409 RunningError */
  async restart(opts?: { force?: boolean }): Promise<AgyCliStatus> {
    const force = Boolean(opts?.force);
    if (this.pool) {
      const res = this.pool.stopAll(force);
      if (!res.stopped) {
        throw new RunningError(res.running, `有 ${res.running} 个委派任务正在执行，重启会中断它们`);
      }
    }
    return this.status();
  }

  /**
   * 服务端退出清理：
   * - 主动中止只读的版本检查网络请求与 --version 探测；
   * - 不杀正在进行的 agy update / 官方安装子进程树：安装 / 升级正在下载并替换磁盘上的二进制，
   *   中途强杀可能导致 agy 可执行文件半写损坏，影响用户在 Cosyee 之外使用 agy；
   *   只清理超时定时器并停止向外触发回调，让更新进程自行原子收尾。
   */
  dispose(): void {
    this.disposed = true;
    this.checkAbort?.abort();
    this.versionAbort?.abort();
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = null;
    }
  }
}

/** 独立路由处理器，供 http.ts 接线；未命中返回 null */
export async function agyCliRoutes(
  cli: AgyCli,
  req: AgyCliRouteRequest,
): Promise<AgyCliRouteResponse | null> {
  const { method, pathname, query, fromLocal } = req;
  if (pathname !== '/api/agy/cli' && !pathname.startsWith('/api/agy/cli/')) return null;

  if (method === 'GET' && pathname === '/api/agy/cli') {
    return { status: 200, body: await cli.status() };
  }

  if (method === 'GET' && pathname === '/api/agy/cli/log') {
    const rawFrom = query.get('from');
    let from = 0;
    if (rawFrom !== null && rawFrom !== '') {
      if (!/^\d+$/.test(rawFrom)) {
        return { status: 400, body: { error: 'from 参数必须为非负整数' } };
      }
      const n = Number(rawFrom);
      if (!Number.isSafeInteger(n)) {
        return { status: 400, body: { error: 'from 参数超出范围' } };
      }
      from = n;
    }
    return { status: 200, body: cli.log(from) };
  }

  if (method === 'POST' && pathname === '/api/agy/cli/check') {
    if (!fromLocal) return { status: 403, body: { error: '该操作仅允许本机连接' } };
    return { status: 200, body: await cli.check() };
  }

  if (method === 'POST' && pathname === '/api/agy/cli/update') {
    if (!fromLocal) return { status: 403, body: { error: '该操作仅允许本机连接' } };
    try {
      return { status: 200, body: await cli.update() };
    } catch (e) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      throw e;
    }
  }

  if (method === 'POST' && pathname === '/api/agy/cli/restart') {
    if (!fromLocal) return { status: 403, body: { error: '该操作仅允许本机连接' } };
    const force = query.get('force') === '1' || query.get('force') === 'true';
    try {
      return { status: 200, body: await cli.restart({ force }) };
    } catch (e) {
      if (e instanceof RunningError) return { status: e.status, body: { error: e.message, running: e.running } };
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      throw e;
    }
  }

  return null;
}
