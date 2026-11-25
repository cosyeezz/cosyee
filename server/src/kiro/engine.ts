// kiro.rs 引擎管理：定位（COSYEE_KIRO_RS > managed）、查询 ZyphrZero/kiro.rs 最新 GitHub Release、
// 下载预编译包并校验 SHA256 后安装、持久化引擎版本与总开关 enabled、保留下载日志。
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { KiroEngineStatus, KiroEngineVersion } from '@cosyee/shared';
import { isFile, killTree, spawnSpec } from '../claude/bin.js';
import { cosyeeHome } from '../paths.js';
import { HttpError } from '../workspaces.js';
import { sanitizeKiroError, writeFileAtomic } from './sanitize.js';

const RELEASE_API = 'https://api.github.com/repos/ZyphrZero/kiro.rs/releases/latest';
const CHECK_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 15 * 60_000;
const LOG_MAX_LINES = 2000;
const OUTPUT_CAPTURE_MAX = 64 * 1024;
/** 压缩包大小上限 */
const ARCHIVE_MAX_BYTES = 200 * 1024 * 1024;
/** SHA256SUMS.txt 大小上限 */
const SUMS_MAX_BYTES = 1024 * 1024;
const SUMS_ASSET = 'SHA256SUMS.txt';
/** release tag（同时用作 bin/ 下的目录名，所以必须严格校验） */
const TAG_RE = /^v\d+(?:\.\d+){1,3}$/;
/** bin/ 下的目录名：tag，同版本重装时可带毫秒时间戳后缀 */
const BIN_DIR_RE = /^v\d+(?:\.\d+){1,3}(?:-\d{1,20})?$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

export type KiroToolName = 'git' | 'cargo' | 'pnpm' | 'npx';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLine?: (line: string) => void;
}

export type CommandRunner = (cmd: string, args: string[], opts: RunCommandOpts) => Promise<CommandResult>;

export interface KiroEngineOptions {
  /** 引擎数据目录；默认 cosyeeHome()/kiro-rs */
  rootDir?: () => string;
  /** 环境变量（测试可注入） */
  env?: () => NodeJS.ProcessEnv;
  /** HTTP 请求（测试可注入） */
  fetch?: typeof globalThis.fetch;
  /** 执行外部命令（解压用 tar；测试可注入） */
  runCommand?: CommandRunner;
  /** 已不再使用（原编译工具查找），保留仅为兼容调用方 */
  findTool?: (name: KiroToolName) => string | null;
  /** 时间源（测试可注入） */
  now?: () => number;
  /** 是否有 Kiro 账号（自动检查仅在已有 Kiro 账号时触发） */
  hasKiroAccounts?: () => boolean;
  /** 安装新版成功后回调（用于自动重启空闲代理） */
  onUpgraded?: () => void;
  /** 日志缓冲区最大行数（测试可注入） */
  logMaxLines?: number;
  /** 操作系统（测试可注入，默认 process.platform） */
  platform?: NodeJS.Platform;
  /** CPU 架构（测试可注入，默认 process.arch） */
  arch?: string;
  /** Linux 下是否为 musl libc（测试可注入） */
  isMusl?: () => boolean;
}

interface EngineMeta {
  current?: KiroEngineVersion | null;
  /** 当前版本在 bin/ 下的子目录名（通常等于 tag） */
  currentBinDir?: string | null;
  /** 上一个版本的 tag（字段名沿用旧版） */
  previousSha?: string | null;
  previousBinDir?: string | null;
  latest?: KiroEngineVersion | null;
  checkedAt?: number | null;
  /** kiro.rs 服务总开关，缺省 true */
  enabled?: boolean;
}

interface ReleaseAsset {
  name: string;
  url: string;
  size: number | null;
}

interface ReleaseInfo {
  version: KiroEngineVersion;
  assets: ReleaseAsset[];
}

interface PlatformPick {
  /** 资产名里的平台后缀，如 macOS-arm64 */
  suffix: string;
  ext: 'tar.gz' | 'zip';
  exe: string;
}

function defaultRunCommand(cmd: string, args: string[], opts: RunCommandOpts): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new Error('操作已取消'));
      return;
    }
    const spec = spawnSpec(cmd, args);
    let proc: ChildProcess;
    try {
      proc = spawn(spec.command, spec.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: spec.verbatim,
        shell: false,
      });
    } catch (e) {
      reject(e);
      return;
    }

    let stdout = '';
    let stderr = '';
    let outBuf = '';
    let errBuf = '';
    const pushLines = (chunk: string, isErr: boolean) => {
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

    proc.stdout?.on('data', (d: Buffer) => pushLines(d.toString('utf8'), false));
    proc.stderr?.on('data', (d: Buffer) => pushLines(d.toString('utf8'), true));

    const onAbort = () => {
      if (proc.pid) killTree(proc.pid);
      else try { proc.kill(); } catch { /* ignore */ }
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
        reject(new Error('操作已取消'));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** 与 delegate/agyCli.ts 同样的 musl 判断（那边没有导出） */
function defaultIsMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    if (fs.existsSync('/lib/libc.musl-x86_64.so.1') || fs.existsSync('/lib/libc.musl-aarch64.so.1')) return true;
  } catch { /* 忽略 */ }
  return false;
}

/** 映射到上游资产名里的平台后缀；没有预编译包的平台返回 null */
function pickPlatform(platform: NodeJS.Platform, arch: string, musl: boolean): PlatformPick | null {
  if (arch !== 'x64' && arch !== 'arm64') return null;
  if (platform === 'darwin') return { suffix: `macOS-${arch}`, ext: 'tar.gz', exe: 'kiro-rs' };
  if (platform === 'linux') return { suffix: `${musl ? 'Linux-musl' : 'Linux'}-${arch}`, ext: 'tar.gz', exe: 'kiro-rs' };
  if (platform === 'win32' && arch === 'x64') return { suffix: 'Windows-x64', ext: 'zip', exe: 'kiro-rs.exe' };
  return null;
}

function parseBinDir(v: unknown): string | null {
  return typeof v === 'string' && BIN_DIR_RE.test(v) ? v : null;
}

/** 只认 release tag；旧版（hank9999 源码编译）留下的 40 位 sha 一律视为无效 */
function parseVersion(v: unknown): KiroEngineVersion | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.commit !== 'string' || !TAG_RE.test(o.commit)) return null;
  const date = typeof o.date === 'number' && Number.isFinite(o.date) && o.date > 0 ? o.date : null;
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 120) : null;
  return { commit: o.commit, date, title };
}

/** 按数字段比较两个 tag（v0.9.10 > v0.9.9）；返回正数表示 a 更新 */
function compareTags(a: string, b: string): number {
  const pa = a.slice(1).split('.').map(Number);
  const pb = b.slice(1).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 解析 SHA256SUMS.txt（`<64 位 hex>  <文件名>`，文件名前可能带 `*`），找指定文件的摘要 */
function findSha256(sums: string, fileName: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line.trim());
    if (m && path.basename(m[2]!) === fileName) return m[1]!.toLowerCase();
  }
  return null;
}

/** 在解压目录里递归找可执行文件（不假定层级；不跟随符号链接），最多 6 层 */
function findBinary(dir: string, exe: string): string | null {
  let level = [dir];
  for (let depth = 0; depth < 6 && level.length > 0; depth++) {
    const next: string[] = [];
    for (const d of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name === exe) return path.join(d, e.name);
        if (e.isDirectory()) next.push(path.join(d, e.name));
      }
    }
    level = next;
  }
  return null;
}

function fmtMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export class KiroEngine {
  private buildState: KiroEngineStatus['build'] = { state: 'idle', step: null, error: null };
  private buildAbort: AbortController | null = null;
  private buildPromise: Promise<void> | null = null;
  private checkingPromise: Promise<ReleaseInfo> | null = null;
  private logLines: string[] = [];
  private logBase = 0;
  private readonly logMax: number;

  constructor(private readonly opts: KiroEngineOptions = {}) {
    this.logMax = opts.logMaxLines ?? LOG_MAX_LINES;
  }

  private root(): string {
    return this.opts.rootDir ? this.opts.rootDir() : path.join(cosyeeHome(), 'kiro-rs');
  }

  private env(): NodeJS.ProcessEnv {
    return this.opts.env ? this.opts.env() : process.env;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private metaPath(): string {
    return path.join(this.root(), 'engine.json');
  }

  private platformPick(): PlatformPick | null {
    const platform = this.opts.platform ?? process.platform;
    const arch = this.opts.arch ?? process.arch;
    const musl = platform === 'linux' && (this.opts.isMusl ?? defaultIsMusl)();
    return pickPlatform(platform, arch, musl);
  }

  private exeName(): string {
    return (this.opts.platform ?? process.platform) === 'win32' ? 'kiro-rs.exe' : 'kiro-rs';
  }

  private readMeta(): EngineMeta {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath(), 'utf8')) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') return { enabled: true };
      // 旧版 hank9999 产物的 current / previous 是 40 位 sha，解析为 null = 没有可用引擎；旧的 adminUi 字段忽略
      const current = parseVersion(raw.current);
      const previousSha = typeof raw.previousSha === 'string' && TAG_RE.test(raw.previousSha) ? raw.previousSha : null;
      return {
        current,
        currentBinDir: current ? (parseBinDir(raw.currentBinDir) ?? current.commit) : null,
        previousSha,
        previousBinDir: previousSha ? (parseBinDir(raw.previousBinDir) ?? previousSha) : null,
        latest: parseVersion(raw.latest),
        checkedAt: typeof raw.checkedAt === 'number' && Number.isFinite(raw.checkedAt) ? raw.checkedAt : null,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      };
    } catch {
      return { enabled: true };
    }
  }

  private writeMeta(patch: Partial<EngineMeta>): EngineMeta {
    const prev = this.readMeta();
    const next: EngineMeta = { ...prev, ...patch };
    writeFileAtomic(this.metaPath(), JSON.stringify(next, null, 2) + '\n');
    return next;
  }

  /** 服务总开关（持久化，默认 true） */
  isEnabled(): boolean {
    return this.readMeta().enabled !== false;
  }

  setEnabled(enabled: boolean): void {
    this.writeMeta({ enabled });
  }

  /** 已安装且文件存在的 managed 版本 */
  private managedCurrent(meta: EngineMeta): { version: KiroEngineVersion; bin: string } | null {
    if (!meta.current || !meta.currentBinDir) return null;
    const bin = path.join(this.root(), 'bin', meta.currentBinDir, this.exeName());
    return isFile(bin) ? { version: meta.current, bin } : null;
  }

  /** 按优先级查找可用二进制：COSYEE_KIRO_RS > managed */
  binaryPath(): string | null {
    const envBin = this.env().COSYEE_KIRO_RS?.trim();
    if (envBin && isFile(envBin)) return envBin;
    return this.managedCurrent(this.readMeta())?.bin ?? null;
  }

  status(): KiroEngineStatus {
    const envBin = this.env().COSYEE_KIRO_RS?.trim();
    const meta = this.readMeta();
    const managed = this.managedCurrent(meta);
    let source: KiroEngineStatus['source'] = 'none';
    let current: KiroEngineVersion | null = null;
    if (envBin && isFile(envBin)) {
      source = 'env';
    } else if (managed) {
      source = 'managed';
      current = managed.version;
    }
    const latest = meta.latest ?? null;
    const updateAvailable = !!current && !!latest && compareTags(latest.commit, current.commit) > 0;
    return {
      source,
      current,
      latest,
      updateAvailable,
      checkedAt: meta.checkedAt ?? null,
      build: { ...this.buildState },
    };
  }

  /** 本次下载的增量日志（超出上限截断头部，next 单调递增） */
  getLog(from = 0): { lines: string[]; next: number } {
    const start = Number.isInteger(from) && from > 0 ? from : 0;
    const next = this.logBase + this.logLines.length;
    if (start >= next) return { lines: [], next };
    const idx = Math.max(0, start - this.logBase);
    return { lines: this.logLines.slice(idx), next };
  }

  private appendLog(line: string): void {
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

  /**
   * 服务启动时可调用：已有 Kiro 账号但没有可用引擎（含旧版源码编译留下的引擎）时，后台直接下载安装最新版。
   * 已有引擎的定期检查与更新由 components/updater.ts 统一调度。
   */
  maybeAutoInstall(): void {
    if (!this.opts.hasKiroAccounts?.()) return;
    if (this.binaryPath()) return;
    try {
      this.startBuild();
    } catch { /* 平台不支持等：静默，界面上手动安装时会看到原因 */ }
  }

  /** 查询 GitHub 最新 release 并写入 engine.json 的 latest / checkedAt */
  private fetchRelease(): Promise<ReleaseInfo> {
    if (this.checkingPromise) return this.checkingPromise;
    const p = (async (): Promise<ReleaseInfo> => {
      const fetchFn = this.opts.fetch ?? globalThis.fetch;
      const res = await fetchFn(RELEASE_API, {
        headers: { 'user-agent': 'cosyee', accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
      const j = (await res.json()) as {
        tag_name?: unknown;
        name?: unknown;
        published_at?: unknown;
        assets?: unknown;
      };
      if (typeof j?.tag_name !== 'string' || !TAG_RE.test(j.tag_name)) {
        throw new Error('上游返回的版本号格式异常');
      }
      const published = typeof j.published_at === 'string' ? Date.parse(j.published_at) : NaN;
      const title = typeof j.name === 'string' && j.name.trim() ? j.name.trim().slice(0, 120) : null;
      const version: KiroEngineVersion = {
        commit: j.tag_name,
        date: Number.isFinite(published) && published > 0 ? published : null,
        title,
      };
      const assets: ReleaseAsset[] = [];
      if (Array.isArray(j.assets)) {
        for (const a of j.assets as Array<Record<string, unknown>>) {
          if (typeof a?.name !== 'string' || typeof a.browser_download_url !== 'string') continue;
          assets.push({ name: a.name, url: a.browser_download_url, size: typeof a.size === 'number' ? a.size : null });
        }
      }
      this.writeMeta({ latest: version, checkedAt: this.now() });
      return { version, assets };
    })();
    this.checkingPromise = p;
    const clear = () => {
      if (this.checkingPromise === p) this.checkingPromise = null;
    };
    p.then(clear, clear);
    return p;
  }

  /** 手动检查最新 release */
  async check(): Promise<KiroEngineStatus> {
    if (!this.platformPick()) throw new HttpError(400, '当前平台没有预编译包');
    try {
      await this.fetchRelease();
    } catch (e) {
      throw new HttpError(502, `检查更新失败：${sanitizeKiroError(e)}`);
    }
    return this.status();
  }

  /** 触发后台下载安装最新版（同一时间只允许一个）；平台没有预编译包时直接返回 400 */
  startBuild(): KiroEngineStatus {
    if (this.buildState.state === 'running') return this.status();
    const pick = this.platformPick();
    if (!pick) throw new HttpError(400, '当前平台没有预编译包');
    const ac = new AbortController();
    this.buildAbort = ac;
    this.resetLog();
    this.buildState = { state: 'running', step: '查询最新版本', error: null };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, BUILD_TIMEOUT_MS);
    timer.unref?.();
    const run = this.runInstall(pick, ac.signal).finally(() => {
      clearTimeout(timer);
      if (timedOut && this.buildState.state === 'failed') this.buildState.error = '下载超时，已终止';
      if (this.buildAbort === ac) this.buildAbort = null;
      if (this.buildPromise === run) this.buildPromise = null;
    });
    this.buildPromise = run;
    return this.status();
  }

  /** 等待当前下载结束（测试用） */
  waitForBuild(): Promise<void> {
    return this.buildPromise ?? Promise.resolve();
  }

  private setStep(step: string): void {
    this.buildState = { state: 'running', step, error: null };
    this.appendLog(`[cosyee] ${step}`);
  }

  /** 下载 url 到文件，边写边算 SHA256；超过 maxBytes 立即中止 */
  private async downloadFile(
    url: string,
    dest: string,
    maxBytes: number,
    signal: AbortSignal,
    label: string,
    hintSize: number | null,
  ): Promise<{ bytes: number; sha256: string }> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error('下载地址无效');
    }
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') throw new Error('下载地址不是 github.com 的 https 链接');
    const fetchFn = this.opts.fetch ?? globalThis.fetch;
    const res = await fetchFn(url, { headers: { 'user-agent': 'cosyee' }, signal });
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
    const len = Number(res.headers.get('content-length'));
    const size = Number.isFinite(len) && len > 0 ? len : hintSize;
    if ((size ?? 0) > maxBytes) throw new Error('文件过大，已放弃下载');
    if (!res.body) throw new Error('下载失败（响应没有内容）');
    this.appendLog(`[cosyee] 下载 ${label}${size ? `（${fmtMB(size)}）` : ''}`);
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(dest, 'w');
    let bytes = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > maxBytes) {
          await reader.cancel().catch(() => { /* ignore */ });
          throw new Error('文件过大，已放弃下载');
        }
        hash.update(value);
        let off = 0;
        while (off < value.length) off += fs.writeSync(fd, value, off, value.length - off);
      }
    } catch (e) {
      if (signal.aborted) throw new Error('下载已取消');
      throw e;
    } finally {
      fs.closeSync(fd);
    }
    return { bytes, sha256: hash.digest('hex') };
  }

  private async extract(archive: string, outDir: string, pick: PlatformPick, signal: AbortSignal): Promise<void> {
    const platform = this.opts.platform ?? process.platform;
    const env = this.env();
    // Windows 用系统自带的 bsdtar（能解 zip），避免 PATH 里 Git 的 GNU tar 不认盘符路径
    const tarCmd = platform === 'win32'
      ? path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar';
    const args = [pick.ext === 'zip' ? '-xf' : '-xzf', archive, '-C', outDir];
    const runner = this.opts.runCommand ?? defaultRunCommand;
    let r: CommandResult;
    try {
      r = await runner(tarCmd, args, { env: { ...env }, signal, onLine: (line) => this.appendLog(line) });
    } catch (e) {
      if (signal.aborted) throw new Error('操作已取消');
      throw new Error(`解压失败：${sanitizeKiroError(e)}`);
    }
    if (r.code !== 0) throw new Error('解压失败（tar 返回非零）');
  }

  private async runInstall(pick: PlatformPick, signal: AbortSignal): Promise<void> {
    const root = this.root();
    const binRoot = path.join(root, 'bin');
    const tmpDir = path.join(root, `tmp-${crypto.randomBytes(6).toString('hex')}`);
    const oldMeta = this.readMeta();
    const oldCurrent = this.managedCurrent(oldMeta);
    let destDir: string | null = null;

    try {
      fs.mkdirSync(root, { recursive: true });
      this.sweepTmp(root);
      this.setStep('查询最新版本');
      const { version, assets } = await this.fetchRelease();
      if (signal.aborted) throw new Error('操作已取消');
      const tag = version.commit;

      if (oldCurrent && oldCurrent.version.commit === tag) {
        this.appendLog(`[cosyee] 已是最新版 ${tag}，无需下载`);
        this.buildState = { state: 'idle', step: null, error: null };
        return;
      }

      const archiveName = `kiro-rs-${tag.slice(1)}-${pick.suffix}.${pick.ext}`;
      const archiveAsset = assets.find((a) => a.name === archiveName);
      if (!archiveAsset) throw new Error(`该版本没有适用于当前平台的预编译包（${archiveName}）`);
      const sumsAsset = assets.find((a) => a.name === SUMS_ASSET);
      if (!sumsAsset) throw new Error('该版本缺少 SHA256SUMS.txt，无法校验');

      fs.mkdirSync(tmpDir, { recursive: true });
      const sumsFile = path.join(tmpDir, SUMS_ASSET);
      this.setStep(`下载 ${tag}`);
      await this.downloadFile(sumsAsset.url, sumsFile, SUMS_MAX_BYTES, signal, SUMS_ASSET, sumsAsset.size);
      const expected = findSha256(fs.readFileSync(sumsFile, 'utf8'), archiveName);
      if (!expected || !SHA256_RE.test(expected)) throw new Error(`SHA256SUMS.txt 里没有 ${archiveName} 的校验值`);

      const archiveFile = path.join(tmpDir, archiveName);
      const dl = await this.downloadFile(archiveAsset.url, archiveFile, ARCHIVE_MAX_BYTES, signal, archiveName, archiveAsset.size);
      this.appendLog(`[cosyee] 下载完成 ${fmtMB(dl.bytes)}`);

      this.setStep('校验 SHA256');
      if (dl.sha256 !== expected) throw new Error('SHA256 校验失败，文件可能损坏或被篡改');
      this.appendLog('[cosyee] SHA256 校验通过');

      this.setStep('解压');
      const extractDir = path.join(tmpDir, 'extract');
      fs.mkdirSync(extractDir, { recursive: true });
      await this.extract(archiveFile, extractDir, pick, signal);
      const found = findBinary(extractDir, pick.exe);
      if (!found) throw new Error(`压缩包里没有找到 ${pick.exe}`);

      this.setStep('安装');
      const stageDir = path.join(tmpDir, 'out');
      fs.mkdirSync(stageDir, { recursive: true });
      const stagedBin = path.join(stageDir, pick.exe);
      fs.renameSync(found, stagedBin);
      if (pick.exe === 'kiro-rs') fs.chmodSync(stagedBin, 0o755);

      let destName = tag;
      if (fs.existsSync(path.join(binRoot, destName))) {
        // 同版本目录残留（如之前的上一版）：先删；被占用删不掉就换个带时间戳的目录名
        try { fs.rmSync(path.join(binRoot, destName), { recursive: true, force: true }); } catch { /* 占用时忽略 */ }
        if (fs.existsSync(path.join(binRoot, destName))) destName = `${tag}-${this.now()}`;
      }
      fs.mkdirSync(binRoot, { recursive: true });
      destDir = path.join(binRoot, destName);
      fs.renameSync(stageDir, destDir);

      const previousBinDir = oldCurrent ? oldMeta.currentBinDir ?? null : (oldMeta.previousBinDir ?? null);
      const previousSha = oldCurrent ? oldCurrent.version.commit : (oldMeta.previousSha ?? null);
      const samePrev = previousBinDir === destName;
      this.writeMeta({
        current: version,
        currentBinDir: destName,
        previousSha: samePrev ? null : previousSha,
        previousBinDir: samePrev ? null : previousBinDir,
        latest: version,
        checkedAt: this.now(),
      });

      // 只留当前 + 上一版；旧版（hank9999 按 commit sha 命名）的 bin 目录和 src/ 源码一并清掉
      this.cleanupOldBins(binRoot, new Set([destName, ...(samePrev || !previousBinDir ? [] : [previousBinDir])]));
      try { fs.rmSync(path.join(root, 'src'), { recursive: true, force: true }); } catch { /* ignore */ }

      this.appendLog(`[cosyee] 安装完成：${tag}`);
      this.buildState = { state: 'idle', step: null, error: null };
      this.opts.onUpgraded?.();
    } catch (e) {
      if (destDir) {
        try { fs.rmSync(destDir, { recursive: true, force: true }); } catch { /* 占用时忽略 */ }
      }
      const msg = sanitizeKiroError(e);
      this.appendLog(`[cosyee] 安装失败：${msg}`);
      this.buildState = { state: 'failed', step: null, error: msg };
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  /** 清掉上次中断遗留的 tmp-* 目录 */
  private sweepTmp(root: string): void {
    try {
      for (const name of fs.readdirSync(root)) {
        if (!name.startsWith('tmp-')) continue;
        try { fs.rmSync(path.join(root, name), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  private cleanupOldBins(binRoot: string, keep: Set<string>): void {
    try {
      for (const name of fs.readdirSync(binRoot)) {
        if (keep.has(name)) continue;
        try {
          fs.rmSync(path.join(binRoot, name), { recursive: true, force: true });
        } catch { /* 旧版本可能仍被运行中的代理占用，忽略 */ }
      }
    } catch { /* ignore */ }
  }

  dispose(): void {
    this.buildAbort?.abort();
  }
}
