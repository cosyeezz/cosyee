// Antigravity CLI（agy）多账号管理：只管在 Cosyee 里登录的账号，不接管本机 agy 自己的登录。
// 每个账号一个独立数据目录（~/.cosyee/agy-accounts/<id>），通过 --gemini-dir <root> --app-data-dir <id>
// 与 AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 隔离，令牌存在该目录的 antigravity-oauth-token 文件里。
// 不起 agy 进程探测登录态：令牌文件在就算已登录；邮箱只从令牌文件的 id_token_email 字段读，不落盘。
// 列表与日志绝不下发 / 记录令牌、授权码；判重只存邮箱的 sha256 哈希。
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AccountDedupeResult, AccountLogin, AgyAccountEntry, AgyAccountList } from '@cosyee/shared';
import { killTree, spawnSpec } from '../claude/bin.js';
import { resolveAgy } from '../delegate/agy.js';
import { agyAccountsRoot, pathKey } from '../paths.js';
import { ACCOUNT_ID_RE, HttpError, type StateStore, type StoredAccount } from '../workspaces.js';
import { agyAccountArgs, agyLoginEnv } from './agy-env.js';
import { hashEmail, lstat, mkdirPrivate, replaceAuthFiles as replaceAuthFilesIn, safeRemoveAccountDir } from './fs.js';
import { stripAnsi } from './index.js';

const LABEL_MAX = 40;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const ORPHAN_MAX_AGE_MS = 60 * 60_000;
const CANCEL_KILL_GRACE_MS = 500;
const OUTPUT_MAX = 16 * 1024;
/** 令牌文件只读这么大，超过就不读邮箱 */
const TOKEN_FILE_MAX = 64 * 1024;
const TOKEN_FILE = 'antigravity-oauth-token';
const AUTH_STATE_FILE = 'acp-auth-state.json';
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export { hashEmail };

export interface AgyAccountRef {
  id: string;
  /** 账号数据目录；null 只用于不接账号管理的场景（测试 / 旧调用），表示 agy 自己的默认目录 */
  dir: string | null;
  label?: string;
}

export interface AgyAccountsDeps {
  store: StateStore;
  /** 某账号正在执行的委派任务数 */
  running?: (accountId: string) => number;
  /** 移除账号前停止该账号的空闲进程；仍有执行中任务返回 false */
  stopAccount?: (accountId: string) => boolean;
  /** 重新登录后丢弃空闲进程、排空忙进程、清模型缓存 */
  resetAccount?: (accountId: string) => void;
  /** 账号列表 / 当前账号变化时回调 */
  onChanged?: () => void;
  /** 测试替换：解析 agy 路径 */
  resolveAgy?: () => string | null;
  /** 测试替换：启动登录进程 */
  spawnLogin?: (agyPath: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** 测试替换：时间源 */
  now?: () => number;
  /** 测试替换：登录超时 */
  loginTimeoutMs?: number;
}

interface LoginJob {
  state: AccountLogin;
  proc: ChildProcess | null;
  /** 本次登录实际写入的目录：添加账号是新账号目录，重新登录是临时目录 <root>/<临时id> */
  loginDir: string;
  /** 给已有账号重新登录时是它的 id；添加新账号时为 null */
  target: string | null;
  label: string;
  output: string;
  /** 已提取的身份哈希（仅内存，绝不进错误文案） */
  identityHash: string | null;
  /** submitCode 只允许调用一次 */
  codeSubmitted: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  finishing: boolean;
  cancelled: boolean;
}

/** 从 agy acp --login 的输出里找 Google OAuth 登录页地址 */
export function findAgyLoginUrl(raw: string): string | null {
  const m = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s"'<>\x07\x1b]+/.exec(raw)
    ?? /https:\/\/[^\s"'<>\x07\x1b]+\/o\/oauth2\/[^\s"'<>\x07\x1b]+/.exec(raw);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** 从认证成功输出中提取邮箱的 sha256 哈希；找不到返回 null */
export function extractIdentityHash(raw: string): string | null {
  const m = /(?:Successfully authenticated|authenticated successfully) as\s+([^\s<>]+)/i.exec(raw);
  if (!m) return null;
  return hashEmail(m[1]);
}

/** 清洗进程退出前的末行，避免泄露邮箱、URL、授权码或令牌 */
function sanitizeErrorTail(raw: string): string {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (!last) return '';
  const cleaned = last
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\b(?:4\/[0-9A-Za-z_-]{10,}|ya29\.[0-9A-Za-z._-]{10,}|1\/\/[0-9A-Za-z._-]{10,})\b/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim();
  return cleaned.slice(0, 160);
}

/** 是否存在令牌文件（只检查存在性） */
function hasTokenFile(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, TOKEN_FILE));
  } catch {
    return false;
  }
}

const emailCache = new Map<string, { mtimeMs: number; size: number; email: string | null }>();

/** 从令牌文件里只取登录邮箱（id_token_email）；读不到返回 null。不跟进链接，绝不记录文件内容 */
export function readTokenEmail(dir: string): string | null {
  const file = path.join(dir, TOKEN_FILE);
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > TOKEN_FILE_MAX) return null;
  const key = pathKey(file);
  const hit = emailCache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.email;
  let email: string | null = null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as { id_token_email?: unknown };
    const v = typeof j?.id_token_email === 'string' ? j.id_token_email.trim() : '';
    if (v.length <= 320 && EMAIL_RE.test(v)) email = v;
  } catch { /* 格式不认识就当没有 */ }
  emailCache.set(key, { mtimeMs: st.mtimeMs, size: st.size, email });
  return email;
}

function newId(): string {
  return crypto.randomBytes(5).toString('hex');
}

function cleanLabel(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, LABEL_MAX) : '';
}

function killProc(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (proc.pid) {
    killTree(proc.pid);
    return;
  }
  try {
    proc.kill();
  } catch { /* 已退出 */ }
}

function defaultSpawnLogin(agyPath: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const spec = spawnSpec(agyPath, args);
  return spawn(spec.command, spec.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim,
  });
}

/** 只把新登录的令牌与认证状态文件原子替换进原目录（不碰 conversations/、brain/ 等），失败回滚 */
async function replaceAuthFiles(tempDir: string, targetDir: string): Promise<void> {
  await replaceAuthFilesIn(tempDir, targetDir, [TOKEN_FILE, AUTH_STATE_FILE], TOKEN_FILE);
}

export class AgyAccounts {
  private login: LoginJob | null = null;
  private switching: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly now: () => number;
  private readonly resolveFn: () => string | null;
  private readonly loginTimeoutMs: number;

  constructor(private readonly deps: AgyAccountsDeps) {
    this.now = deps.now ?? Date.now;
    this.resolveFn = deps.resolveAgy ?? resolveAgy;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
  }

  private get s() {
    return this.deps.store.state.agyAccounts;
  }

  private find(id: string): StoredAccount | undefined {
    return this.s.list.find((a) => a.id === id);
  }

  installed(): boolean {
    return this.resolveFn() !== null;
  }

  /** 新的委派用哪个账号：记下的当前账号，没有（或已移除）就用最早添加的；一个账号都没有返回 null */
  activeId(): string | null {
    const id = this.s.active;
    if (id && this.find(id)) return id;
    return this.s.list[0]?.id ?? null;
  }

  has(id: string): boolean {
    return !!this.find(id);
  }

  dirFor(id: string): string | undefined {
    return this.find(id)?.dir;
  }

  /** 按 id 取账号引用；不存在返回 null */
  accountFor(id: string): AgyAccountRef | null {
    const a = this.find(id);
    if (!a) return null;
    return { id: a.id, dir: a.dir, label: a.label };
  }

  /** 当前账号引用；一个账号都没有返回 null */
  activeAccount(): AgyAccountRef | null {
    const id = this.activeId();
    return id ? this.accountFor(id) : null;
  }

  /** 当前账号是否可用：有账号且令牌文件在（不起进程探测） */
  activeLoggedIn(): boolean {
    if (!this.installed()) return false;
    const a = this.activeAccount();
    return !!a?.dir && hasTokenFile(a.dir);
  }

  /** 把记下的当前账号对齐到 activeId()（旧数据里 active 为 null 表示默认账号，现在改成第一个添加的账号） */
  private syncActive(): boolean {
    const id = this.activeId();
    if (this.s.active === id) return false;
    this.s.active = id;
    return true;
  }

  /** 启动时调用：对齐当前账号，并清理遗留的未登记临时目录 */
  init(): void {
    if (this.syncActive()) this.deps.store.save();
    this.cleanupOrphanDirs();
  }

  /** 清理 agyAccountsRoot 下名字符合 ACCOUNT_ID_RE、不在 list 里、且 1 小时以上未改动的真实目录（不跟进链接） */
  private cleanupOrphanDirs(): void {
    const root = agyAccountsRoot();
    let names: string[];
    try {
      names = fs.readdirSync(root);
    } catch {
      return;
    }
    const cutoff = this.now() - ORPHAN_MAX_AGE_MS;
    for (const name of names) {
      if (!ACCOUNT_ID_RE.test(name)) continue;
      const full = path.join(root, name);
      if (this.s.list.some((a) => a.id === name || pathKey(a.dir) === pathKey(full))) continue;
      if (this.login && pathKey(this.login.loginDir) === pathKey(full)) continue;
      const st = lstat(full);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) continue;
      if (st.mtimeMs >= cutoff) continue;
      void safeRemoveAccountDir(full, root).catch(() => {});
    }
  }

  /** 串行执行修改类操作 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.switching.then(fn);
    this.switching = run.then(() => {}, () => {});
    return run;
  }

  /** 账号的身份哈希：已存哈希优先，其次用令牌文件里的邮箱算 */
  private identityHashOf(a: StoredAccount): string | null {
    return a.identityHash ?? hashEmail(readTokenEmail(a.dir));
  }

  /** 把账号按身份哈希分为「列表保留项」与「去重隐藏项」；优先级 当前账号 > 最早添加；未知身份不去重 */
  private partition(): { kept: AgyAccountEntry[]; hiddenIds: string[] } {
    const active = this.activeId();
    const rows = this.s.list.map((a, idx) => ({
      idx,
      createdAt: a.createdAt,
      hash: this.identityHashOf(a),
      entry: {
        id: a.id,
        label: a.label,
        plan: null,
        loggedIn: hasTokenFile(a.dir),
        active: a.id === active,
        isDefault: false,
        running: this.deps.running?.(a.id) ?? 0,
        email: readTokenEmail(a.dir),
        quota: null,
      } satisfies AgyAccountEntry,
    }));
    const ordered = [...rows].sort((a, b) => Number(b.entry.active) - Number(a.entry.active) || a.createdAt - b.createdAt || a.idx - b.idx);
    const seen = new Set<string>();
    const kept: typeof rows = [];
    const hiddenIds: string[] = [];
    for (const r of ordered) {
      if (r.hash) {
        if (seen.has(r.hash)) {
          hiddenIds.push(r.entry.id);
          continue;
        }
        seen.add(r.hash);
      }
      kept.push(r);
    }
    kept.sort((a, b) => a.idx - b.idx);
    return { kept: kept.map((r) => r.entry), hiddenIds };
  }

  list(): AgyAccountList {
    if (!this.installed()) {
      return { installed: false, list: [], login: null };
    }
    const { kept, hiddenIds } = this.partition();
    return {
      installed: true,
      list: kept,
      login: this.login ? { ...this.login.state } : null,
      ...(hiddenIds.length > 0 ? { duplicates: hiddenIds.length } : {}),
    };
  }

  /** 切换当前账号：只影响新的委派任务，不停任何进程 */
  switchTo(id: string): Promise<void> {
    return this.serial(async () => {
      const a = this.find(id);
      if (!a) throw new HttpError(404, '账号不存在');
      if (!fs.existsSync(a.dir)) throw new HttpError(410, '账号的数据目录不存在了，请移除后重新添加');
      if (!hasTokenFile(a.dir)) throw new HttpError(400, '该账号还没有登录');
      if (id === this.activeId() && this.s.active === id) return;
      this.s.active = id;
      this.deps.store.save();
      this.deps.onChanged?.();
    });
  }

  setLabel(id: string, label: unknown): void {
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    a.label = cleanLabel(label);
    this.deps.store.save();
    this.deps.onChanged?.();
  }

  /** 实际移除单个账号（需在 serial 内调用；不落盘、不发通知）。移除当前账号后改用剩下最早添加的 */
  private async removeOne(id: string): Promise<void> {
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    if (this.login && this.login.target === id && this.busy()) throw new HttpError(409, '该账号正在登录');
    const running = this.deps.running?.(id) ?? 0;
    if (running > 0) throw new HttpError(409, `该账号有 ${running} 个委派任务正在执行，请等它们结束后再移除`);
    if (this.deps.stopAccount && !this.deps.stopAccount(id)) {
      throw new HttpError(409, '该账号还有委派任务正在执行，请等它们结束后再移除');
    }
    await safeRemoveAccountDir(a.dir, agyAccountsRoot());
    this.s.list = this.s.list.filter((x) => x.id !== id);
    this.syncActive();
  }

  /** 移除账号：正在登录、有执行中任务 409；先停空闲进程再安全删目录 */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      await this.removeOne(id);
      this.deps.store.save();
      this.deps.onChanged?.();
    });
  }

  /**
   * 清理 list() 去重时隐藏的重复账号条目：按与 remove() 相同的规则逐条移除，
   * 正在登录 / 有执行中委派任务等不可删的跳过并计入 skipped，不抛错。
   */
  dedupe(): Promise<AccountDedupeResult> {
    return this.serial(async () => {
      if (!this.installed()) return { removed: 0, skipped: 0 };
      const { hiddenIds } = this.partition();
      let removed = 0;
      let skipped = 0;
      for (const id of hiddenIds) {
        try {
          await this.removeOne(id);
          removed++;
        } catch {
          skipped++;
        }
      }
      if (removed > 0) {
        this.deps.store.save();
        this.deps.onChanged?.();
      }
      return { removed, skipped };
    });
  }

  // ───────────── 登录 ─────────────

  private busy(): boolean {
    const st = this.login?.state.status;
    return st === 'starting' || st === 'waiting';
  }

  getLogin(loginId: string): AccountLogin {
    if (!this.login || this.login.state.loginId !== loginId) throw new HttpError(404, '登录已结束或不存在');
    return { ...this.login.state };
  }

  private allocAccountDir(root: string): string {
    let id = newId();
    while (this.find(id) || fs.existsSync(path.join(root, id))) id = newId();
    const dir = path.join(root, id);
    mkdirPrivate(dir);
    return dir;
  }

  /** 添加账号（不传 accountId）或重新登录：后台运行 agy acp --login，不弹浏览器，等待粘贴授权码 */
  startLogin(opts: { label?: unknown; accountId?: unknown }): AccountLogin {
    const agyPath = this.resolveFn();
    if (!agyPath) throw new HttpError(503, '没有安装 Antigravity CLI（agy）');
    if (this.busy()) throw new HttpError(409, '已有一个登录正在进行');

    let target: string | null = null;
    if (opts.accountId !== undefined && opts.accountId !== null) {
      if (typeof opts.accountId !== 'string') throw new HttpError(400, 'accountId 不合法');
      if (!this.find(opts.accountId)) throw new HttpError(404, '账号不存在');
      target = opts.accountId;
    }
    // 重新登录也先登录到临时目录，成功后再只替换令牌文件，失败不破坏原登录与会话记录
    const loginDir = this.allocAccountDir(agyAccountsRoot());

    const state: AccountLogin = { loginId: newId(), status: 'starting', url: null, accountId: target, error: null };
    const job: LoginJob = {
      state,
      proc: null,
      loginDir,
      target,
      label: cleanLabel(opts.label),
      output: '',
      identityHash: null,
      codeSubmitted: false,
      timer: null,
      cancelTimer: null,
      finishing: false,
      cancelled: false,
    };

    const args = ['acp', '--login', ...agyAccountArgs(loginDir)];
    const env = agyLoginEnv(loginDir);
    let proc: ChildProcess;
    try {
      proc = (this.deps.spawnLogin ?? defaultSpawnLogin)(agyPath, args, env);
    } catch (e) {
      void this.discardDir(loginDir);
      throw new HttpError(500, `无法启动 agy：${e instanceof Error ? e.message : String(e)}`);
    }
    job.proc = proc;
    this.login = job;

    const onData = (d: Buffer | string) => {
      const chunk = d.toString('utf8');
      if (job.output.length < OUTPUT_MAX) job.output += chunk;
      const cleanAll = stripAnsi(job.output);
      if (!state.url) {
        const url = findAgyLoginUrl(cleanAll) ?? findAgyLoginUrl(job.output);
        if (url) {
          state.url = url;
          state.status = 'waiting';
        }
      }
      if (!job.identityHash) {
        const h = extractIdentityHash(cleanAll);
        if (h) job.identityHash = h;
      }
    };

    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.stdin?.on('error', () => {});
    proc.on('error', () => void this.finishLogin(job, null, '启动登录进程失败'));
    proc.on('close', (code) => void this.finishLogin(job, code, null));
    job.timer = setTimeout(() => {
      void this.finishLogin(job, null, '登录超时');
      if (job.proc) killProc(job.proc);
    }, this.loginTimeoutMs);
    job.timer.unref?.();
    return { ...state };
  }

  /** 把浏览器页面上的授权码或完整回调 URL 写入 stdin（每次登录只允许提交一次） */
  submitCode(loginId: string, code: unknown): void {
    const job = this.login;
    if (!job || job.state.loginId !== loginId || !this.busy() || job.finishing) {
      throw new HttpError(404, '登录已结束或不存在');
    }
    if (job.codeSubmitted) throw new HttpError(409, '已提交授权码，请等待登录完成');
    const c = typeof code === 'string' ? code.trim() : '';
    if (!c || c.length > 2000 || /[\r\n\x00-\x1f]/.test(c)) throw new HttpError(400, '授权码不合法');
    const stdin = job.proc?.stdin;
    if (!stdin || stdin.destroyed) throw new HttpError(409, '登录进程已退出');
    job.codeSubmitted = true;
    stdin.write(c + '\n');
  }

  cancelLogin(loginId: string): void {
    const job = this.login;
    if (!job || job.state.loginId !== loginId) return;
    if (this.busy()) {
      job.cancelled = true;
      const proc = job.proc;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        try {
          proc.stdin?.end();
        } catch { /* ignore */ }
        job.cancelTimer = setTimeout(() => {
          job.cancelTimer = null;
          killProc(proc);
        }, CANCEL_KILL_GRACE_MS);
        job.cancelTimer.unref?.();
      }
      void this.finishLogin(job, null, '已取消');
    }
  }

  private async finishLogin(job: LoginJob, code: number | null, error: string | null): Promise<void> {
    const st = job.state;
    const isTerminal = (): boolean => job.state.status === 'done' || job.state.status === 'failed';
    if (isTerminal()) return;
    if (job.finishing && error === null) return;
    job.finishing = true;
    if (job.timer) {
      clearTimeout(job.timer);
      job.timer = null;
    }
    if (job.cancelTimer && (job.proc?.exitCode !== null || job.proc?.signalCode !== null)) {
      clearTimeout(job.cancelTimer);
      job.cancelTimer = null;
    }

    const cleanupTemp = () => {
      const p = job.proc;
      if (p && p.exitCode === null && p.signalCode === null) {
        p.once('close', () => {
          if (job.cancelTimer) {
            clearTimeout(job.cancelTimer);
            job.cancelTimer = null;
          }
          void this.discardDir(job.loginDir);
        });
      } else {
        void this.discardDir(job.loginDir);
      }
    };

    const fail = (msg: string) => {
      if (isTerminal()) return;
      st.status = 'failed';
      st.error = msg;
      cleanupTemp();
    };

    if (job.cancelled || error !== null || code !== 0) {
      if (error !== null) return fail(error);
      const cleanOut = stripAnsi(job.output);
      if (/invalid_grant|Malformed auth code|token exchange failed/i.test(cleanOut)) {
        return fail('授权码无效或已过期，请重新登录');
      }
      const tail = sanitizeErrorTail(job.output);
      return fail(tail || '登录进程异常退出');
    }
    if (this.disposed) return fail('服务已关闭');

    // 退出码 0：令牌文件写出来了才算登录成功（agy 没填授权码就回车也会以 0 退出）
    if (!hasTokenFile(job.loginDir)) {
      return fail(/login cancelled/i.test(stripAnsi(job.output)) ? '没有填写授权码，登录已取消' : '登录没有完成');
    }

    // 重复账号判重（基于邮箱 sha256 哈希，不存 / 不暴露邮箱）；优先取登录输出，缺失时用令牌文件里的邮箱
    const hash = job.identityHash ?? hashEmail(readTokenEmail(job.loginDir));
    if (hash && this.s.list.some((a) => a.id !== job.target && this.identityHashOf(a) === hash)) {
      return fail('这个账号已经添加过了');
    }

    if (job.target) {
      const a = this.find(job.target);
      if (!a) return fail('账号不存在');
      // 替换令牌前先停该账号空闲进程 / 排空忙进程 / 清模型缓存
      this.deps.resetAccount?.(a.id);
      try {
        await replaceAuthFiles(job.loginDir, a.dir);
      } catch {
        return fail('更新登录凭据失败，原登录未受影响');
      }
      // 替换成功后再重置一次，防止替换期间新起的进程拿着旧令牌
      this.deps.resetAccount?.(a.id);
      await this.discardDir(job.loginDir);
      if (job.cancelled || this.disposed || isTerminal()) return;
      if (hash) a.identityHash = hash;
      this.deps.store.save();
      st.status = 'done';
      st.error = null;
      this.deps.onChanged?.();
      return;
    }

    // 添加新账号
    const dir = job.loginDir;
    const id = path.basename(dir);
    if (this.s.list.some((x) => x.id === id || pathKey(x.dir) === pathKey(dir))) {
      return fail('账号目录冲突，请重试');
    }
    // 没填备注名就留空：菜单里显示登录的邮箱
    this.s.list.push({
      id,
      label: job.label,
      dir,
      createdAt: this.now(),
      ...(hash ? { identityHash: hash } : {}),
    });
    // 第一个账号自动成为当前账号
    this.syncActive();
    this.deps.store.save();
    st.accountId = id;
    st.status = 'done';
    st.error = null;
    this.deps.onChanged?.();
  }

  /** 丢弃未登记的新账号 / 临时目录（只删 agyAccountsRoot 下、未登记的直接子目录） */
  private async discardDir(dir: string): Promise<void> {
    if (this.s.list.some((a) => pathKey(a.dir) === pathKey(dir))) return;
    try {
      await safeRemoveAccountDir(dir, agyAccountsRoot());
    } catch { /* 留着也无害，下次启动超过 1 小时会被清理 */ }
  }

  /** 服务关闭时：结束进行中的登录 */
  dispose(): void {
    this.disposed = true;
    if (this.login && this.busy()) {
      this.login.cancelled = true;
      if (this.login.cancelTimer) {
        clearTimeout(this.login.cancelTimer);
        this.login.cancelTimer = null;
      }
      void this.finishLogin(this.login, null, '服务已关闭');
      if (this.login.proc) killProc(this.login.proc);
    }
  }
}
