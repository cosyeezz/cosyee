// OpenAI Codex CLI（codex）本体的版本检查、升级 / 安装、日志与常驻进程管理。
// 对标 agyCli.ts：版本缓存按路径 + stat 失效、超时、409 冲突、日志增量游标与脱敏、restart/dispose。
import fs from 'node:fs';
import path from 'node:path';
import type { CodexCliStatus } from '@cosyee/shared';
import { RunningError } from '../accounts/index.js';
import { isFile } from '../claude/bin.js';
import { fetchJsonLimited, pickString } from '../components/common.js';
import { HttpError } from '../workspaces.js';
import {
  type AgyCommandOpts,
  type AgyCommandResult,
  type AgyCommandRunner,
  compareSemver,
  defaultRunCommand,
  isStrictSemver,
  lastNonEmptyLine,
  sanitizeLogLine,
} from './agyCli.js';
import { type CodexInfo, resolveCodexInfo } from './codex.js';
import { parseCodexVersion } from './codexProtocol.js';

/** npm 官方 latest tag（稳定版） */
export const CODEX_NPM_LATEST_URL = 'https://registry.npmjs.org/@openai/codex/latest';
/** 官方独立安装脚本地址（写死常量，绝不拼接外部输入） */
export const CODEX_INSTALL_PS1_URL = 'https://chatgpt.com/codex/install.ps1';
export const CODEX_INSTALL_SH_URL = 'https://chatgpt.com/codex/install.sh';

const VERSION_TIMEOUT_MS = 8_000;
const CHECK_TIMEOUT_MS = 15_000;
const JOB_TIMEOUT_MS = 10 * 60_000;
const MANIFEST_MAX_BYTES = 256 * 1024;
const LOG_MAX_LINES = 2000;

export type CodexCommandOpts = AgyCommandOpts;
export type CodexCommandResult = AgyCommandResult;
export type CodexCommandRunner = AgyCommandRunner;

export interface CodexCliPool {
  stats(): { processes: number; sessions: number; busy: number };
  runningCount(accountId?: string): number;
  retireAll(): void;
  stopAll(force?: boolean): { stopped: boolean; running: number };
}

export interface CodexCliOptions {
  /** 常驻 app-server 进程池；不传则视为无常驻进程 */
  pool?: CodexCliPool;
  /** 定位 codex；默认 resolveCodexInfo */
  resolveCodex?: (env?: NodeJS.ProcessEnv) => CodexInfo | null;
  /** 环境变量；默认 () => process.env */
  env?: () => NodeJS.ProcessEnv;
  /** 读取文件元信息（判断二进制 mtime / size 是否变化）；默认 fs.statSync */
  statFile?: (filePath: string) => { mtimeMs: number; size: number } | null;
  /** 执行外部命令（--version / npm install / 官方安装脚本） */
  runCommand?: CodexCommandRunner;
  /** HTTP 请求（查 npm registry） */
  fetch?: typeof globalThis.fetch;
  /** 检测本机是否有 npm（未安装 codex 时优先用 npm 安装，更可预期）；默认查 PATH */
  hasNpm?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => boolean;
  /** 系统平台（测试可注入） */
  platform?: NodeJS.Platform;
  /** 时钟（测试可注入） */
  now?: () => number;
  /** 读取版本超时（ms），默认 8000 */
  versionTimeoutMs?: number;
  /** 检查最新版超时（ms），默认 15000 */
  checkTimeoutMs?: number;
  /** 安装 / 升级总超时（ms），默认 10 分钟 */
  jobTimeoutMs?: number;
  /** 日志缓冲区最大行数，默认 2000 */
  logMaxLines?: number;
  /** 安装 / 升级成功后的钩子（用于调用 backend.clearIncompatible() 等） */
  onUpdated?: () => void;
  /** 状态变化回调（安装 / 升级开始或结束时触发） */
  onChanged?: () => void;
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

/** 检查 PATH 里是否存在 npm 可执行文件 */
export function defaultHasNpm(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((d) => (platform === 'win32' ? d.trim().replace(/^"|"$/g, '') : d.trim()))
    .filter(Boolean);
  const names = platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  for (const d of dirs) {
    for (const n of names) {
      if (isFile(path.join(d, n))) return true;
    }
  }
  return false;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface VersionCache {
  path: string;
  mtimeMs: number;
  size: number;
  version: string;
}

export class CodexCli {
  private readonly pool?: CodexCliPool;
  private readonly resolveCodexFn: (env?: NodeJS.ProcessEnv) => CodexInfo | null;
  private readonly envFn: () => NodeJS.ProcessEnv;
  private readonly statFileFn: (filePath: string) => { mtimeMs: number; size: number } | null;
  private readonly runCmd: CodexCommandRunner;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly hasNpmFn: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => boolean;
  private readonly platform: NodeJS.Platform;
  private readonly nowFn: () => number;
  private readonly versionTimeoutMs: number;
  private readonly checkTimeoutMs: number;
  private readonly jobTimeoutMs: number;
  private readonly logMax: number;
  private readonly onUpdated?: () => void;
  private readonly onChanged?: () => void;

  private versionCache: VersionCache | null = null;
  private versionInflight: Promise<string | null> | null = null;
  private versionSeq = 0;
  private versionAbort: AbortController | null = null;

  private latest: string | null = null;
  private checkedAt: number | null = null;
  private checkError: string | null = null;
  private checkInflight: Promise<void> | null = null;

  private job: CodexCliStatus['job'] = null;
  private jobPromise: Promise<void> | null = null;
  private jobTimer: ReturnType<typeof setTimeout> | null = null;

  private logLines: string[] = [];
  private logBase = 0;
  private disposed = false;

  constructor(opts: CodexCliOptions = {}) {
    this.pool = opts.pool;
    this.resolveCodexFn = opts.resolveCodex ?? resolveCodexInfo;
    this.envFn = opts.env ?? (() => process.env);
    this.statFileFn = opts.statFile ?? defaultStatFile;
    this.runCmd = opts.runCommand ?? defaultRunCommand;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.hasNpmFn = opts.hasNpm ?? defaultHasNpm;
    this.platform = opts.platform ?? process.platform;
    this.nowFn = opts.now ?? Date.now;
    this.versionTimeoutMs = opts.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
    this.checkTimeoutMs = opts.checkTimeoutMs ?? CHECK_TIMEOUT_MS;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? JOB_TIMEOUT_MS;
    this.logMax = opts.logMaxLines ?? LOG_MAX_LINES;
    this.onUpdated = opts.onUpdated;
    this.onChanged = opts.onChanged;
  }

  private isCustom(env: NodeJS.ProcessEnv, info?: CodexInfo | null): boolean {
    return info?.installKind === 'custom' || Boolean(env.COSYEE_CODEX?.trim());
  }

  private notify(): void {
    if (this.disposed) return;
    try {
      this.onChanged?.();
    } catch { /* 回调异常不影响主流程 */ }
  }

  /**
   * 同步返回已缓存的版本号（供 CodexBackend.availability 使用，不阻塞事件循环）。
   * 缓存缺失或二进制文件变更时返回 null，并在后台触发一次异步预读。
   */
  cachedVersion(): string | null {
    const env = this.envFn();
    const info = this.resolveCodexFn(env);
    if (!info) return null;
    const st = this.statFileFn(info.execPath);
    if (this.versionCache && this.versionCache.path === info.execPath) {
      if (st && this.versionCache.mtimeMs === st.mtimeMs && this.versionCache.size === st.size) {
        return this.versionCache.version;
      }
      if (!st && this.versionCache.mtimeMs === -1 && this.versionCache.size === -1) {
        return this.versionCache.version;
      }
    }
    if (!this.disposed && !this.versionInflight) {
      void this.readVersion(info.execPath).then((v) => {
        if (v) this.notify();
      });
    }
    return null;
  }

  /** 启动时后台预读一次版本（不抛错、不阻塞） */
  prefetchVersion(): void {
    if (this.disposed) return;
    const info = this.resolveCodexFn(this.envFn());
    if (!info) return;
    void this.readVersion(info.execPath).then((v) => {
      if (v) this.notify();
    });
  }

  /** 读取本机 codex 版本，按路径 + mtime + size 缓存；失败返回 null */
  private async readVersion(execPath: string, force = false): Promise<string | null> {
    const st = this.statFileFn(execPath);
    if (!force && this.versionCache && this.versionCache.path === execPath) {
      if (st && this.versionCache.mtimeMs === st.mtimeMs && this.versionCache.size === st.size) {
        return this.versionCache.version;
      }
      if (!st && this.versionCache.mtimeMs === -1 && this.versionCache.size === -1) {
        return this.versionCache.version;
      }
    }
    if (!force && this.versionInflight) return this.versionInflight;

    const seq = ++this.versionSeq;
    const p = (async (): Promise<string | null> => {
      const ac = new AbortController();
      this.versionAbort = ac;
      const timer = setTimeout(() => ac.abort(), this.versionTimeoutMs);
      timer.unref?.();
      try {
        const res = await this.runCmd(execPath, ['--version'], {
          env: this.envFn(),
          signal: ac.signal,
        });
        if (res.code !== 0) return null;
        const parsed = parseCodexVersion(res.stdout) ?? parseCodexVersion(res.stderr);
        if (parsed && this.versionSeq === seq) {
          this.versionCache = {
            path: execPath,
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

  /** 恢复上次检查到的最新版（组件调度器持久化的）；本进程已检查过就不覆盖 */
  restoreCheck(latest: string, at: number): void {
    if (this.checkedAt !== null || !isStrictSemver(latest)) return;
    this.latest = latest;
    this.checkedAt = at;
    this.checkError = null;
  }

  /** 读取当前状态（不访问网络） */
  async status(): Promise<CodexCliStatus> {
    const env = this.envFn();
    const info = this.resolveCodexFn(env);
    const custom = this.isCustom(env, info);
    const installed = info !== null;
    const version = info ? await this.readVersion(info.execPath) : null;
    // compareSemver 要求严格 x.y.z；若本机是预发布版如 0.144.6-alpha.1，去掉后缀后比较或仅在严格 semver 下比较
    const baseVer = version ? version.split(/[-+]/)[0]! : null;
    const updateAvailable = Boolean(
      installed && baseVer && this.latest && isStrictSemver(baseVer) && compareSemver(this.latest, baseVer) > 0,
    );
    const stats = this.pool ? this.pool.stats() : { processes: 0, sessions: 0, busy: 0 };
    const busy = this.pool ? this.pool.runningCount() : 0;
    return {
      installed,
      custom,
      ...(info ? { installKind: info.installKind } : {}),
      version,
      latest: this.latest,
      updateAvailable,
      checkedAt: this.checkedAt,
      checkError: this.checkError,
      processes: stats.processes,
      busy,
      job: this.job ? { ...this.job } : null,
    };
  }

  /** 查询 npm registry 上的最新稳定版；失败记入 checkError，绝不抛错崩溃 */
  async check(): Promise<CodexCliStatus> {
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
    try {
      const data = await fetchJsonLimited(this.fetchFn, CODEX_NPM_LATEST_URL, {
        timeoutMs: this.checkTimeoutMs,
        maxBytes: MANIFEST_MAX_BYTES,
      });
      const rawVer = pickString(data, 'version');
      // 严格 semver 校验：只接受稳定版 x.y.z，排除 alpha / beta 等预发布 tag
      if (!isStrictSemver(rawVer)) {
        this.checkedAt = this.nowFn();
        this.checkError = '官方版本信息版本号格式无效';
        return;
      }
      this.latest = rawVer;
      this.checkedAt = this.nowFn();
      this.checkError = null;
    } catch (e) {
      this.checkedAt = this.nowFn();
      const msg = sanitizeLogLine(errMsg(e));
      this.checkError = msg.startsWith('检查最新版本') ? msg : `检查最新版本失败: ${msg}`;
    }
  }

  /** 启动后台升级（已安装）或安装（未安装）；custom 或进行中抛 409 */
  async update(): Promise<CodexCliStatus> {
    const env = this.envFn();
    const info = this.resolveCodexFn(env);
    if (this.isCustom(env, info)) {
      throw new HttpError(409, '已通过 COSYEE_CODEX 指定自定义程序，不支持自动安装或升级');
    }
    if (this.job?.state === 'running') {
      throw new HttpError(409, this.job.kind === 'install' ? '正在安装中，请稍候' : '正在升级中，请稍候');
    }

    const kind: 'install' | 'update' = info ? 'update' : 'install';
    this.job = { kind, state: 'running', error: null };
    this.resetLog();
    this.appendLog(kind === 'install' ? '开始安装 Codex CLI…' : '开始升级 Codex CLI…');
    this.notify();

    this.jobPromise = this.runJob(kind, info, env);
    return this.status();
  }

  private async runJob(kind: 'install' | 'update', info: CodexInfo | null, env: NodeJS.ProcessEnv): Promise<void> {
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
      // 升级：按当前 installKind 决定渠道；
      // 未安装：若本机已有 npm，优先走 npm install -g @openai/codex@latest（相比远程 curl/irm 脚本，npm 渠道路径固定、退出码与日志更可预期且跨平台一致）；无 npm 时回退官方安装脚本。
      const useNpm = info ? info.installKind === 'npm' : this.hasNpmFn(env, this.platform);
      if (useNpm) {
        cmd = this.platform === 'win32' ? 'npm.cmd' : 'npm';
        args = ['install', '-g', '@openai/codex@latest'];
      } else if (this.platform === 'win32') {
        cmd = 'powershell.exe';
        args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${CODEX_INSTALL_PS1_URL} | iex`];
      } else {
        cmd = 'sh';
        args = ['-c', `curl -fsSL ${CODEX_INSTALL_SH_URL} | sh`];
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
      const nextInfo = this.resolveCodexFn(this.envFn());
      if (!nextInfo) {
        const error = kind === 'install' ? '安装命令已完成，但未找到 codex 可执行文件' : '升级后未找到 codex 可执行文件';
        this.appendLog(error);
        this.job = { kind, state: 'failed', error };
        return;
      }
      const nextVer = await this.readVersion(nextInfo.execPath, true);
      this.appendLog(nextVer ? `完成，当前版本：${nextVer}` : '完成');
      this.job = null;
      // 回收空闲常驻进程，清除协议不兼容标记，执行中的任务不打断
      this.pool?.retireAll();
      try {
        this.onUpdated?.();
      } catch { /* 回调异常不影响主流程 */ }
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

  /** 回收常驻 codex app-server 进程；有执行中任务且未 force 时抛 409 RunningError */
  async restart(opts?: { force?: boolean }): Promise<CodexCliStatus> {
    const force = Boolean(opts?.force);
    if (this.pool) {
      const res = this.pool.stopAll(force);
      if (!res.stopped) {
        throw new RunningError(res.running, `有 ${res.running} 个委派任务正在执行，重启会中断它们`);
      }
    }
    return this.status();
  }

  /** 服务端退出清理：中止只读版本探测，不强杀正在写二进制的安装/升级子进程 */
  dispose(): void {
    this.disposed = true;
    this.versionAbort?.abort();
    if (this.jobTimer) {
      clearTimeout(this.jobTimer);
      this.jobTimer = null;
    }
  }
}
