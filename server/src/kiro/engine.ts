// kiro.rs 引擎管理：定位（COSYEE_KIRO_RS > managed）、检查上游 master 最新 commit、
// 拉取未修改的上游源码并在本机用 cargo 编译、持久化引擎版本与总开关 enabled、保留实时编译日志。
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { KiroEngineStatus, KiroEngineVersion } from '@cosyee/shared';
import { isFile, killTree, spawnSpec } from '../claude/bin.js';
import { cosyeeHome } from '../paths.js';
import { HttpError } from '../workspaces.js';
import { HEX40_RE, sanitizeKiroError, writeFileAtomic } from './sanitize.js';

const UPSTREAM_REPO = 'https://github.com/hank9999/kiro.rs.git';
const UPSTREAM_COMMIT_API = 'https://api.github.com/repos/hank9999/kiro.rs/commits/master';
const CHECK_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 45 * 60_000;
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60_000;
const LOG_MAX_LINES = 2000;
const OUTPUT_CAPTURE_MAX = 64 * 1024;
/** 上游 admin-ui 使用 lockfileVersion 9.0 + pnpm-workspace.yaml 的 allowBuilds（pnpm v11 语法），固定 pnpm v11 */
const PNPM_NPX_SPEC = 'pnpm@11';
const isWin = process.platform === 'win32';
const EXE_NAME = isWin ? 'kiro-rs.exe' : 'kiro-rs';

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
  /** 执行外部命令（git / cargo / kiro-rs --version；测试可注入） */
  runCommand?: CommandRunner;
  /** 查找工具路径（测试可注入） */
  findTool?: (name: KiroToolName) => string | null;
  /** 时间源（测试可注入） */
  now?: () => number;
  /** 是否有 Kiro 账号（自动检查仅在已有 Kiro 账号时触发） */
  hasKiroAccounts?: () => boolean;
  /** 编译升级成功后回调（用于自动重启空闲代理） */
  onUpgraded?: () => void;
  /** 日志缓冲区最大行数（测试可注入） */
  logMaxLines?: number;
}

interface EngineMeta {
  current?: KiroEngineVersion | null;
  /** 当前版本在 bin/ 下的子目录名（同 commit 重建时可能带时间戳后缀，避免 Windows 覆盖运行中的 exe） */
  currentBinDir?: string | null;
  previousSha?: string | null;
  previousBinDir?: string | null;
  latest?: KiroEngineVersion | null;
  checkedAt?: number | null;
  /** kiro.rs 服务总开关，缺省 true */
  enabled?: boolean;
  /** 当前引擎是否带上游管理页面 */
  adminUi?: boolean;
  /** 管理页面未构建成功的原因 */
  adminUiError?: string | null;
}

function augmentedPath(baseEnv: NodeJS.ProcessEnv): string {
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
  const cur = baseEnv.PATH ?? baseEnv.Path ?? '';
  const parts = cur.split(path.delimiter).filter(Boolean);
  if (!parts.some((p) => p.toLowerCase() === cargoBin.toLowerCase())) parts.push(cargoBin);
  return parts.join(path.delimiter);
}

function withCargoPath(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  const nextPath = augmentedPath(baseEnv);
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === 'PATH') delete env[k];
  }
  env.PATH = nextPath;
  return env;
}

function defaultFindTool(name: KiroToolName, baseEnv: NodeJS.ProcessEnv): string | null {
  const names = isWin ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  const dirs = augmentedPath(baseEnv).split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (isFile(p)) return p;
    }
  }
  return null;
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

const BIN_DIR_RE = /^[0-9a-f]{40}(?:-[0-9]{1,20})?$/i;

function parseBinDir(v: unknown): string | null {
  return typeof v === 'string' && BIN_DIR_RE.test(v) ? v.toLowerCase() : null;
}

function parseVersion(v: unknown): KiroEngineVersion | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.commit !== 'string' || !HEX40_RE.test(o.commit)) return null;
  const date = typeof o.date === 'number' && Number.isFinite(o.date) && o.date > 0 ? o.date : null;
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 120) : null;
  return { commit: o.commit.toLowerCase(), date, title };
}

export class KiroEngine {
  private buildState: KiroEngineStatus['build'] = { state: 'idle', step: null, error: null };
  private buildAbort: AbortController | null = null;
  private buildPromise: Promise<void> | null = null;
  private checkingPromise: Promise<KiroEngineVersion> | null = null;
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

  private readMeta(): EngineMeta {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath(), 'utf8')) as Record<string, unknown>;
      if (!raw || typeof raw !== 'object') return {};
      const current = parseVersion(raw.current);
      const previousSha = typeof raw.previousSha === 'string' && HEX40_RE.test(raw.previousSha) ? raw.previousSha.toLowerCase() : null;
      return {
        current,
        currentBinDir: parseBinDir(raw.currentBinDir) ?? current?.commit ?? null,
        previousSha,
        previousBinDir: parseBinDir(raw.previousBinDir) ?? previousSha,
        latest: parseVersion(raw.latest),
        checkedAt: typeof raw.checkedAt === 'number' && Number.isFinite(raw.checkedAt) ? raw.checkedAt : null,
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
        adminUi: raw.adminUi === true,
        adminUiError: typeof raw.adminUiError === 'string' && raw.adminUiError ? raw.adminUiError : null,
      };
    } catch {
      return { enabled: true, adminUi: false, adminUiError: null };
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

  /** 按优先级查找可用二进制：COSYEE_KIRO_RS > managed */
  binaryPath(): string | null {
    const envBin = this.env().COSYEE_KIRO_RS?.trim();
    if (envBin && isFile(envBin)) return envBin;
    const meta = this.readMeta();
    const binDir = meta.currentBinDir ?? meta.current?.commit ?? null;
    if (meta.current && binDir) {
      const p = path.join(this.root(), 'bin', binDir, EXE_NAME);
      if (isFile(p)) return p;
    }
    return null;
  }

  private resolveTool(name: KiroToolName): string | null {
    return this.opts.findTool ? this.opts.findTool(name) : defaultFindTool(name, this.env());
  }

  missingTools(): string[] {
    const missing: string[] = [];
    if (!this.resolveTool('git')) missing.push('git');
    if (!this.resolveTool('cargo')) missing.push('cargo');
    return missing;
  }

  status(): KiroEngineStatus {
    const envBin = this.env().COSYEE_KIRO_RS?.trim();
    const meta = this.readMeta();
    let source: KiroEngineStatus['source'] = 'none';
    let current: KiroEngineVersion | null = null;
    const binDir = meta.currentBinDir ?? meta.current?.commit ?? null;
    if (envBin && isFile(envBin)) {
      source = 'env';
    } else if (meta.current && binDir && isFile(path.join(this.root(), 'bin', binDir, EXE_NAME))) {
      source = 'managed';
      current = meta.current;
    }
    const latest = meta.latest ?? null;
    const updateAvailable = source === 'managed' && !!current && !!latest && current.commit.toLowerCase() !== latest.commit.toLowerCase();
    return {
      source,
      current,
      latest,
      updateAvailable,
      checkedAt: meta.checkedAt ?? null,
      missingTools: this.missingTools(),
      build: { ...this.buildState },
      // COSYEE_KIRO_RS 来源无法得知是否内置管理页面，按 true 处理
      adminUi: source === 'env' ? true : source === 'managed' && meta.adminUi === true,
      adminUiError: source === 'managed' ? (meta.adminUiError ?? null) : null,
    };
  }

  /** 本次编译的增量日志（超出上限截断头部，next 单调递增） */
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

  /** 服务启动时可调用：仅在已有 Kiro 账号且距上次检查超过 24 小时时后台检查一次，绝不静默编译 */
  maybeAutoCheck(): void {
    if (!this.opts.hasKiroAccounts?.()) return;
    const meta = this.readMeta();
    if (meta.checkedAt && this.now() - meta.checkedAt < AUTO_CHECK_INTERVAL_MS) return;
    void this.fetchLatest().catch(() => { /* 自动检查失败静默忽略 */ });
  }

  private async fetchLatest(): Promise<KiroEngineVersion> {
    if (this.checkingPromise) return this.checkingPromise;
    const p = (async (): Promise<KiroEngineVersion> => {
      const fetchFn = this.opts.fetch ?? globalThis.fetch;
      const res = await fetchFn(UPSTREAM_COMMIT_API, {
        headers: {
          'user-agent': 'kiro-engine-check/1.0',
          accept: 'application/vnd.github+json',
        },
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`);
      const j = (await res.json()) as {
        sha?: unknown;
        commit?: {
          committer?: { date?: unknown };
          author?: { date?: unknown };
          message?: unknown;
        };
      };
      if (typeof j?.sha !== 'string' || !HEX40_RE.test(j.sha)) {
        throw new Error('上游返回的 commit sha 格式异常');
      }
      const rawDate = j.commit?.committer?.date ?? j.commit?.author?.date;
      const parsedDate = typeof rawDate === 'string' ? Date.parse(rawDate) : NaN;
      const rawMsg = typeof j.commit?.message === 'string' ? j.commit.message : '';
      const title = rawMsg.split(/\r?\n/)[0]?.trim().slice(0, 120) || null;
      const ver: KiroEngineVersion = {
        commit: j.sha.toLowerCase(),
        date: Number.isFinite(parsedDate) && parsedDate > 0 ? parsedDate : null,
        title,
      };
      this.writeMeta({ latest: ver, checkedAt: this.now() });
      return ver;
    })();
    this.checkingPromise = p;
    try {
      return await p;
    } finally {
      if (this.checkingPromise === p) this.checkingPromise = null;
    }
  }

  /** 手动检查上游 master 最新 commit */
  async check(): Promise<KiroEngineStatus> {
    try {
      await this.fetchLatest();
    } catch (e) {
      throw new HttpError(502, `检查更新失败：${sanitizeKiroError(e)}`);
    }
    return this.status();
  }

  /** 触发后台编译（同一时间只允许一个）；缺少工具时直接返回 400 */
  startBuild(): KiroEngineStatus {
    if (this.buildState.state === 'running') return this.status();
    const missing = this.missingTools();
    if (missing.length > 0) {
      throw new HttpError(400, `缺少编译工具：${missing.join('、')}`);
    }
    const git = this.resolveTool('git')!;
    const cargo = this.resolveTool('cargo')!;
    const ac = new AbortController();
    this.buildAbort = ac;
    this.resetLog();
    this.buildState = { state: 'running', step: '检查上游最新版本', error: null };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, BUILD_TIMEOUT_MS);
    timer.unref?.();
    const run = this.runBuild(git, cargo, ac.signal).finally(() => {
      clearTimeout(timer);
      if (timedOut && this.buildState.state === 'failed') this.buildState.error = '编译超时，已终止';
      if (this.buildAbort === ac) this.buildAbort = null;
      if (this.buildPromise === run) this.buildPromise = null;
    });
    this.buildPromise = run;
    return this.status();
  }

  /** 等待当前编译结束（测试用） */
  waitForBuild(): Promise<void> {
    return this.buildPromise ?? Promise.resolve();
  }

  private async exec(cmd: string, args: string[], cwd: string | undefined, signal: AbortSignal): Promise<CommandResult> {
    const runner = this.opts.runCommand ?? defaultRunCommand;
    const env = withCargoPath(this.env());
    env.GIT_TERMINAL_PROMPT = '0';
    // 没有终端时 pnpm 重装 node_modules 会要求确认并中止，CI=true 跳过
    env.CI = 'true';
    return runner(cmd, args, {
      cwd,
      env,
      signal,
      onLine: (line) => this.appendLog(line),
    });
  }

  /**
   * 尝试按上游 Dockerfile 构建 admin-ui：先删旧 dist，再用 pnpm（或 npx --yes pnpm@11）执行
   * `install --frozen-lockfile` 与 `build`（依赖安装脚本仅放行上游 pnpm-workspace.yaml 的 allowBuilds）。
   * 任何失败都不挡住引擎：清掉 dist 并写入占位 index.html，返回 { ok: false, error }。
   */
  private async buildAdminUi(srcDir: string, signal: AbortSignal): Promise<{ ok: boolean; error: string | null }> {
    const adminUiDir = path.join(srcDir, 'admin-ui');
    const distDir = path.join(adminUiDir, 'dist');
    const writePlaceholder = () => {
      try { fs.rmSync(distDir, { recursive: true, force: true }); } catch { /* ignore */ }
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html><html><body></body></html>\n', 'utf8');
    };

    // 先清掉上一次编译残留的 dist，绝不把旧产物当成本次成功
    try { fs.rmSync(distDir, { recursive: true, force: true }); } catch { /* ignore */ }

    if (!isFile(path.join(adminUiDir, 'package.json'))) {
      writePlaceholder();
      return { ok: false, error: '上游源码缺少 admin-ui/package.json' };
    }

    const pnpmBin = this.resolveTool('pnpm');
    const npxBin = pnpmBin ? null : this.resolveTool('npx');
    if (!pnpmBin && !npxBin) {
      writePlaceholder();
      return { ok: false, error: '未找到 pnpm 或 npx，无法构建管理页面' };
    }

    const toolCmd = pnpmBin ?? npxBin!;
    const prefix = pnpmBin ? [] : ['--yes', PNPM_NPX_SPEC];

    try {
      this.appendLog(`[cosyee] ${pnpmBin ? 'pnpm' : `npx --yes ${PNPM_NPX_SPEC}`} install --frozen-lockfile`);
      const instRes = await this.exec(toolCmd, [...prefix, 'install', '--frozen-lockfile'], adminUiDir, signal);
      if (instRes.code !== 0) throw new Error('管理页面依赖安装失败（pnpm install 返回非零）');

      this.appendLog(`[cosyee] ${pnpmBin ? 'pnpm' : `npx --yes ${PNPM_NPX_SPEC}`} build`);
      const buildRes = await this.exec(toolCmd, [...prefix, 'build'], adminUiDir, signal);
      if (buildRes.code !== 0) throw new Error('管理页面构建失败（pnpm build 返回非零）');

      const indexFile = path.join(distDir, 'index.html');
      if (!isFile(indexFile) || fs.statSync(indexFile).size === 0) {
        throw new Error('管理页面构建未生成有效的 dist/index.html');
      }
      return { ok: true, error: null };
    } catch (e) {
      if (signal.aborted) throw e;
      const msg = sanitizeKiroError(e);
      this.appendLog(`[cosyee] 管理页面构建失败（将退回占位页继续编译引擎）：${msg}`);
      writePlaceholder();
      return { ok: false, error: msg };
    }
  }

  private async runBuild(git: string, cargo: string, signal: AbortSignal): Promise<void> {
    const root = this.root();
    const srcDir = path.join(root, 'src');
    const binRoot = path.join(root, 'bin');
    const oldMeta = this.readMeta();
    const oldSha = oldMeta.current?.commit ?? null;
    const oldBinDir = oldMeta.currentBinDir ?? oldSha;
    let targetSha: string | null = null;
    let destBinDirName: string | null = null;

    try {
      this.appendLog('[cosyee] 正在检查上游最新 commit...');
      const latest = await this.fetchLatest();
      targetSha = latest.commit;
      if (signal.aborted) throw new Error('编译已取消');

      this.buildState = { state: 'running', step: '拉取源码', error: null };
      fs.mkdirSync(root, { recursive: true });
      if (!fs.existsSync(path.join(srcDir, '.git'))) {
        if (fs.existsSync(srcDir)) fs.rmSync(srcDir, { recursive: true, force: true });
        this.appendLog(`[cosyee] git clone ${UPSTREAM_REPO}`);
        const cloneRes = await this.exec(git, ['clone', '--depth', '1', '--branch', 'master', UPSTREAM_REPO, srcDir], root, signal);
        if (cloneRes.code !== 0) throw new Error('拉取源码失败（git clone 返回非零）');
      } else {
        this.appendLog(`[cosyee] git fetch origin ${targetSha}`);
        let fetchRes = await this.exec(git, ['fetch', '--depth', '1', 'origin', targetSha], srcDir, signal);
        if (fetchRes.code !== 0) {
          fetchRes = await this.exec(git, ['fetch', 'origin', 'master'], srcDir, signal);
        }
        if (fetchRes.code !== 0) throw new Error('更新源码失败（git fetch 返回非零）');
      }

      const coRes = await this.exec(git, ['checkout', '--detach', '--force', targetSha], srcDir, signal);
      if (coRes.code !== 0) throw new Error('切换目标版本失败（git checkout 返回非零）');

      // 清掉上次中断留下的未跟踪文件（保留 .gitignore 里的 target / node_modules 缓存）
      await this.exec(git, ['clean', '-fd'], srcDir, signal);

      const headRes = await this.exec(git, ['rev-parse', 'HEAD'], srcDir, signal);
      if (headRes.code !== 0 || headRes.stdout.trim().toLowerCase() !== targetSha) {
        throw new Error('源码 HEAD 与目标 commit 不一致');
      }

      const cleanBefore = await this.exec(git, ['status', '--porcelain'], srcDir, signal);
      if (cleanBefore.code !== 0 || cleanBefore.stdout.trim() !== '') {
        throw new Error('源码目录存在未跟踪或已修改文件，拒绝编译');
      }

      this.buildState = { state: 'running', step: '构建管理页面', error: null };
      const uiRes = await this.buildAdminUi(srcDir, signal);

      const cleanAfter = await this.exec(git, ['status', '--porcelain'], srcDir, signal);
      if (cleanAfter.code !== 0 || cleanAfter.stdout.trim() !== '') {
        throw new Error('构建管理页面后源码树不干净，拒绝编译');
      }

      this.buildState = { state: 'running', step: '编译 kiro-rs', error: null };
      this.appendLog('[cosyee] cargo build --release --locked');
      const cargoRes = await this.exec(cargo, ['build', '--release', '--locked'], srcDir, signal);
      if (cargoRes.code !== 0) throw new Error('cargo 编译失败');

      const builtBin = path.join(srcDir, 'target', 'release', EXE_NAME);
      if (!isFile(builtBin)) throw new Error('编译产物不存在');

      this.buildState = { state: 'running', step: '验证产物', error: null };
      // 同 commit 重新编译（如补建管理页面）时换新目录名，避免 Windows 上覆盖运行中的 exe 报错
      destBinDirName = targetSha;
      if (destBinDirName === oldBinDir || fs.existsSync(path.join(binRoot, destBinDirName))) {
        destBinDirName = `${targetSha}-${this.now()}`;
      }
      const destDir = path.join(binRoot, destBinDirName);
      const destBin = path.join(destDir, EXE_NAME);
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(builtBin, destBin);
      if (!isWin) {
        try { fs.chmodSync(destBin, 0o755); } catch { /* ignore */ }
      }

      const verRes = await this.exec(destBin, ['--version'], destDir, signal);
      if (verRes.code !== 0) throw new Error('新产物 --version 试跑失败');

      const previousSha = oldSha && oldSha !== targetSha ? oldSha : (oldMeta.previousSha ?? null);
      const previousBinDir = oldBinDir && oldBinDir !== destBinDirName ? oldBinDir : (oldMeta.previousBinDir ?? null);
      this.writeMeta({
        current: latest,
        currentBinDir: destBinDirName,
        previousSha: previousSha === targetSha ? null : previousSha,
        previousBinDir: previousBinDir === destBinDirName ? null : previousBinDir,
        latest,
        checkedAt: this.now(),
        adminUi: uiRes.ok,
        adminUiError: uiRes.error,
      });

      this.cleanupOldBins(binRoot, new Set([destBinDirName, ...(previousBinDir ? [previousBinDir] : [])]));

      this.appendLog(`[cosyee] 编译完成：${targetSha.slice(0, 8)}${uiRes.ok ? '（含管理页面）' : '（无管理页面）'}`);
      this.buildState = { state: 'idle', step: null, error: null };
      this.opts.onUpgraded?.();
    } catch (e) {
      // 保留旧版本不动；若新目录是本次刚建的，尽量清掉
      if (destBinDirName && destBinDirName !== oldBinDir) {
        try {
          fs.rmSync(path.join(binRoot, destBinDirName), { recursive: true, force: true });
        } catch { /* 占用时忽略 */ }
      }
      const msg = sanitizeKiroError(e);
      this.appendLog(`[cosyee] 编译失败：${msg}`);
      this.buildState = { state: 'failed', step: null, error: msg };
    }
  }

  private cleanupOldBins(binRoot: string, keep: Set<string>): void {
    try {
      for (const name of fs.readdirSync(binRoot)) {
        if (keep.has(name.toLowerCase())) continue;
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
