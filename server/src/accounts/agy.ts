// Antigravity CLI（agy）多账号管理：
// 默认账号 = 本机 agy 自己的登录（系统凭据库）；添加的账号各有一个独立数据目录（~/.cosyee/agy-accounts/<id>），
// 通过 --gemini-dir <root> --app-data-dir <id> 与 AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1 隔离。
// 列表与日志绝不下发 / 记录令牌、授权码；判重只存邮箱的 sha256 哈希。
// 邮箱与额度在探测时从 agy 内置的 language server 读（agy-status.ts），只放在内存缓存里给账号菜单显示，不落盘。
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountDedupeResult, AccountLogin, AgyAccountEntry, AgyAccountList, AgyQuota } from '@cosyee/shared';
import { killTree, spawnSpec } from '../claude/bin.js';
import { resolveAgy } from '../delegate/agy.js';
import { agyAccountsRoot, isSessionUuid, pathKey } from '../paths.js';
import { LineSplitter, type Json } from '../transcript.js';
import { ACCOUNT_ID_RE, HttpError, type StateStore, type StoredAccount } from '../workspaces.js';
import { agyAccountArgs, agyAccountEnv, agyLoginEnv, agyProbeArgs } from './agy-env.js';
import { type AgyStatus, fetchAgyStatus, findLsPort } from './agy-status.js';
import { DEFAULT_ID, stripAnsi } from './index.js';
import { removeLink } from './links.js';

const LABEL_MAX = 40;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_OK_TTL_MS = 30 * 60_000;
const PROBE_FAIL_TTL_MS = 60_000;
/** 账号菜单打开时（list refresh），额度超过这么久没更新就重新探测 */
const QUOTA_REFRESH_MS = 90_000;
/** 探测里读邮箱 / 额度最多等这么久，超时只是少了这两项 */
const STATUS_TIMEOUT_MS = 5_000;
const PROBE_TMP_PREFIX = 'cosyee-agy-probe-';
const PROBE_CLOSE_GRACE_MS = 200;
const PROBE_CLEANUP_FALLBACK_MS = 1500;
const ORPHAN_MAX_AGE_MS = 60 * 60_000;
const CANCEL_KILL_GRACE_MS = 500;
const OUTPUT_MAX = 16 * 1024;
const TOKEN_FILE = 'antigravity-oauth-token';
const AUTH_STATE_FILE = 'acp-auth-state.json';
const RETRY_ERRORS = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

export interface AgyAccountRef {
  id: string;
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
  /** 账号列表 / 当前账号 / 探测状态变化时回调 */
  onChanged?: () => void;
  /** 测试替换：解析 agy 路径 */
  resolveAgy?: () => string | null;
  /** 测试替换：启动登录进程 */
  spawnLogin?: (agyPath: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** 测试替换：启动探测用的 agy acp 进程 */
  spawnProbe?: (agyPath: string, args: string[], env: NodeJS.ProcessEnv, cwd: string) => ChildProcess;
  /** 测试替换：时间源 */
  now?: () => number;
  /** 测试替换：登录超时 */
  loginTimeoutMs?: number;
  /** 测试替换：探测超时 */
  probeTimeoutMs?: number;
  /** 测试替换：运行平台（默认 process.platform） */
  platform?: NodeJS.Platform;
  /** 测试替换：探测进程 session/new 成功后读邮箱与额度（logDir = 该进程的日志目录） */
  probeStatus?: (logDir: string, pid: number | undefined) => Promise<AgyStatus | null>;
}

interface ProbeCache {
  loggedIn: boolean | null;
  plan: string | null;
  email?: string | null;
  quota?: AgyQuota | null;
  at: number;
  /** true = 拿到明确结果（已登录或未登录），缓存 30 分钟；false = 其它错误，缓存 1 分钟 */
  ok: boolean;
}

export type ProbeResult =
  | { kind: 'ok'; plan: string | null; sessionId?: string; email?: string | null; quota?: AgyQuota | null }
  | { kind: 'unauth' }
  | { kind: 'error' };

interface LoginJob {
  state: AccountLogin;
  proc: ChildProcess | null;
  /** 本次登录实际写入的目录；默认账号为 null，重新登录已有账号时为临时目录 <root>/<临时id> */
  loginDir: string | null;
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

/** 邮箱归一化（去首尾空白与标点、转小写）后算 sha256 哈希；无效返回 null */
export function hashEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.replace(/[.,;:!?]+$/, '').trim().toLowerCase();
  if (!email) return null;
  return crypto.createHash('sha256').update(email).digest('hex');
}

/** 从认证成功输出中提取邮箱的 sha256 哈希；找不到返回 null */
export function extractIdentityHash(raw: string): string | null {
  const m = /Successfully authenticated as\s+([^\s<>]+)/i.exec(raw);
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

/** 是否存在令牌文件（只检查存在性，绝不读取内容） */
function hasTokenFile(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, TOKEN_FILE));
  } catch {
    return false;
  }
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

function defaultSpawnProbe(agyPath: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): ChildProcess {
  const spec = spawnSpec(agyPath, args);
  return spawn(spec.command, spec.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim,
  });
}

function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** 递归安全删除目录树：遇到 symlink / junction 只解除链接，绝不跟进删除目标内容 */
function safeRemoveTreeSync(dir: string): void {
  const st = lstat(dir);
  if (!st) return;
  if (st.isSymbolicLink()) {
    removeLink(dir);
    return;
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(dir);
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const cst = lstat(p);
    if (!cst) continue;
    if (cst.isSymbolicLink()) removeLink(p);
    else if (cst.isDirectory()) safeRemoveTreeSync(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

/** 校验 dir 是 root 的直接子目录（含 realpath 校验），通过后安全删除；Windows 占用时重试几次 */
async function safeRemoveAccountDir(dir: string, root: string): Promise<void> {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(dir);
  const rel = path.relative(rootAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || rel.includes('/')) return;
  const st = lstat(abs);
  if (!st) return;
  if (st.isSymbolicLink()) {
    removeLink(abs);
    return;
  }
  let rootReal: string;
  let parentReal: string;
  try {
    rootReal = fs.realpathSync(rootAbs);
    parentReal = fs.realpathSync(path.dirname(abs));
  } catch {
    return;
  }
  if (pathKey(parentReal) !== pathKey(rootReal)) return;

  for (let i = 0; ; i++) {
    try {
      safeRemoveTreeSync(abs);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (i >= 5 || !code || !RETRY_ERRORS.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** 通用文件 / 目录操作占用重试（Windows 句柄释放延迟）；失败静默 */
async function retrySilently(fn: () => void, maxRetries = 8): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fn();
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return;
      if (i >= maxRetries || !code || !RETRY_ERRORS.has(code)) return;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** 安全删除默认账号探测用的一次性临时目录：必须为 os.tmpdir() 直接子目录且前缀匹配，不跟进链接，失败静默 */
async function safeRemoveProbeScratch(scratchDir: string): Promise<void> {
  const tmpRoot = path.resolve(os.tmpdir());
  const abs = path.resolve(scratchDir);
  const rel = path.relative(tmpRoot, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || rel.includes('/')) return;
  if (!path.basename(abs).startsWith(PROBE_TMP_PREFIX)) return;
  const st = lstat(abs);
  if (!st) return;
  if (st.isSymbolicLink()) {
    await retrySilently(() => removeLink(abs));
    return;
  }
  let rootReal: string;
  let parentReal: string;
  try {
    rootReal = fs.realpathSync(tmpRoot);
    parentReal = fs.realpathSync(path.dirname(abs));
  } catch {
    return;
  }
  if (pathKey(parentReal) !== pathKey(rootReal)) return;
  await retrySilently(() => safeRemoveTreeSync(abs));
}

/**
 * 清理添加账号探测时 session/new 留下的空会话：
 * 只删除 accountDir/conversations/<sid>.db*（直接子文件）与 accountDir/brain/<sid>。
 * sid 必须匹配严格 UUID，路径必须落在该账号目录内、绝不跟进符号链接，失败静默。
 */
async function safeCleanupProbeSession(accountDir: string, sid: string): Promise<void> {
  if (!isSessionUuid(sid)) return;
  let accReal: string;
  try {
    accReal = fs.realpathSync(path.resolve(accountDir));
  } catch {
    return;
  }

  // 1) conversations/<sid>.db*（仅直接子文件）
  const convDir = path.join(accountDir, 'conversations');
  const convSt = lstat(convDir);
  if (convSt && !convSt.isSymbolicLink() && convSt.isDirectory()) {
    try {
      const convReal = fs.realpathSync(convDir);
      if (pathKey(convReal) === pathKey(path.join(accReal, 'conversations'))) {
        const prefix = `${sid}.db`;
        for (const name of fs.readdirSync(convDir)) {
          if (!name.startsWith(prefix)) continue;
          const full = path.join(convDir, name);
          const fst = lstat(full);
          if (!fst || fst.isSymbolicLink() || fst.isDirectory()) continue;
          await retrySilently(() => fs.unlinkSync(full));
        }
      }
    } catch { /* 静默 */ }
  }

  // 2) brain/<sid>
  const brainDir = path.join(accountDir, 'brain');
  const brainSt = lstat(brainDir);
  if (brainSt && !brainSt.isSymbolicLink() && brainSt.isDirectory()) {
    try {
      const brainReal = fs.realpathSync(brainDir);
      if (pathKey(brainReal) === pathKey(path.join(accReal, 'brain'))) {
        const target = path.join(brainDir, sid);
        const tst = lstat(target);
        if (tst) {
          if (tst.isSymbolicLink()) await retrySilently(() => removeLink(target));
          else await retrySilently(() => safeRemoveTreeSync(target));
        }
      }
    } catch { /* 静默 */ }
  }
}

/** Windows 偶发占用时带重试的 rename */
async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (i >= 5 || !code || !RETRY_ERRORS.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** 创建 0700 权限的账号目录 */
function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch { /* Windows 忽略 */ }
}

/** 只把新登录的令牌与认证状态文件原子替换进原目录（不碰 conversations/、brain/ 等），失败回滚 */
async function replaceAuthFiles(tempDir: string, targetDir: string): Promise<void> {
  mkdirPrivate(targetDir);
  const names = [TOKEN_FILE, AUTH_STATE_FILE].filter((n) => fs.existsSync(path.join(tempDir, n)));
  if (!names.includes(TOKEN_FILE)) throw new Error('未找到新的令牌文件');

  const stamp = newId();
  const backups: { name: string; target: string; bak: string | null }[] = [];
  try {
    for (const name of names) {
      const src = path.join(tempDir, name);
      const dst = path.join(targetDir, name);
      let bak: string | null = null;
      if (fs.existsSync(dst)) {
        bak = path.join(targetDir, `.${name}.bak-${stamp}`);
        await renameRetry(dst, bak);
      }
      backups.push({ name, target: dst, bak });
      await renameRetry(src, dst);
    }
  } catch (e) {
    // 反向回滚：恢复原文件，不破坏原登录
    for (const b of [...backups].reverse()) {
      await fs.promises.unlink(b.target).catch(() => {});
      if (b.bak) await renameRetry(b.bak, b.target).catch(() => {});
    }
    throw e;
  }
  // 全部替换成功后删除备份文件
  for (const b of backups) {
    if (b.bak) await fs.promises.unlink(b.bak).catch(() => {});
  }
}

export class AgyAccounts {
  private login: LoginJob | null = null;
  private switching: Promise<void> = Promise.resolve();
  private readonly cache = new Map<string, ProbeCache>();
  /** 每个账号的缓存代数：登录成功 / 移除时递增，早于它启动的探测返回时按代数丢弃 */
  private readonly gen = new Map<string, number>();
  private readonly probing = new Map<string, Promise<void>>();
  private readonly activeProbes = new Set<ChildProcess>();
  /** 正在运行或挂起的探测清理任务（用于 dispose 与删目录前避让，不阻塞探测结果返回） */
  private readonly pendingCleanups = new Set<Promise<void>>();
  private readonly dirCleanups = new Map<string, Set<Promise<void>>>();
  private readonly pendingProbeCleanups = new Set<() => void>();
  private defaultIdentityHash: string | null = null;
  private disposed = false;
  private readonly now: () => number;
  private readonly resolveFn: () => string | null;
  private readonly loginTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly platform: NodeJS.Platform;

  constructor(private readonly deps: AgyAccountsDeps) {
    this.now = deps.now ?? Date.now;
    this.resolveFn = deps.resolveAgy ?? resolveAgy;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.platform = deps.platform ?? process.platform;
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

  activeId(): string {
    return this.s.active ?? DEFAULT_ID;
  }

  activeDir(): string | null {
    const id = this.s.active;
    return id ? (this.find(id)?.dir ?? null) : null;
  }

  has(id: string): boolean {
    return id === DEFAULT_ID || !!this.find(id);
  }

  dirFor(id: string): string | null | undefined {
    if (id === DEFAULT_ID) return null;
    return this.find(id)?.dir;
  }

  /** 按 id 取账号引用（默认账号或已添加账号）；不存在返回 null */
  accountFor(id: string): AgyAccountRef | null {
    if (id === DEFAULT_ID) return { id: DEFAULT_ID, dir: null };
    const a = this.find(id);
    if (!a) return null;
    return { id: a.id, dir: a.dir, label: a.label };
  }

  /** 当前活跃的账号引用 */
  activeAccount(): AgyAccountRef {
    const id = this.activeId();
    return this.accountFor(id) ?? { id: DEFAULT_ID, dir: null };
  }

  /** 启动时调用：恢复上次的当前账号（目录没了就回到默认账号），并清理遗留的未登记临时目录 */
  init(): void {
    const dir = this.activeDir();
    if (dir && !fs.existsSync(dir)) {
      this.s.active = null;
      this.deps.store.save();
    }
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

  /** 取得账号当前已知的身份哈希（已存哈希优先，其次用探测缓存里的邮箱算） */
  private identityHashOf(id: string, storedHash?: string): string | null {
    const emailHash = hashEmail(this.cache.get(id)?.email);
    if (id === DEFAULT_ID) return this.defaultIdentityHash ?? emailHash;
    return storedHash ?? emailHash;
  }

  /** 把所有账号按身份哈希分为「列表保留项」与「去重隐藏项」；优先级 当前账号 > 默认账号 > 最早添加 */
  private partition(opts: { probe?: boolean; refresh?: boolean } = {}): { kept: AgyAccountEntry[]; hiddenIds: string[] } {
    const active = this.activeId();
    type Row = {
      idx: number;
      createdAt: number;
      hash: string | null;
      entry: AgyAccountEntry;
    };
    const rows: Row[] = [];
    const items: { id: string; label: string; dir: string | null; isDefault: boolean; createdAt: number; storedHash?: string }[] = [
      { id: DEFAULT_ID, label: '', dir: null, isDefault: true, createdAt: -1 },
      ...this.s.list.map((a) => ({ id: a.id, label: a.label, dir: a.dir, isDefault: false, createdAt: a.createdAt, storedHash: a.identityHash })),
    ];
    for (let k = 0; k < items.length; k++) {
      const item = items[k]!;
      const c = this.cache.get(item.id);
      if (opts.probe && (this.shouldProbe(c) || (opts.refresh && this.quotaStale(c)))) void this.triggerProbe(item.id, item.dir);
      // 还没探测过时：添加的账号凭令牌文件是否存在给初值，默认账号为 null
      const initialLoggedIn = item.dir ? hasTokenFile(item.dir) : null;
      rows.push({
        idx: k,
        createdAt: item.createdAt,
        hash: this.identityHashOf(item.id, item.storedHash),
        entry: {
          id: item.id,
          label: item.label,
          plan: c?.plan ?? null,
          loggedIn: c ? c.loggedIn : initialLoggedIn,
          active: active === item.id,
          isDefault: item.isDefault,
          running: this.deps.running?.(item.id) ?? 0,
          email: c?.email ?? null,
          quota: c?.quota ?? null,
        },
      });
    }

    // 同账号去重显示（不静默删目录）：优先级 当前账号 > 默认账号 > 最早添加；未知身份（hash=null）不去重
    const rank = (r: Row): number => (r.entry.active ? 0 : r.entry.isDefault ? 1 : 2);
    const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.idx - b.idx);
    const seenHashes = new Set<string>();
    const kept: Row[] = [];
    const hiddenIds: string[] = [];
    for (const r of ordered) {
      if (r.hash) {
        if (seenHashes.has(r.hash)) {
          hiddenIds.push(r.entry.id);
          continue;
        }
        seenHashes.add(r.hash);
      }
      kept.push(r);
    }
    kept.sort((a, b) => a.idx - b.idx);
    return { kept: kept.map((r) => r.entry), hiddenIds };
  }

  list(opts: { refresh?: boolean } = {}): AgyAccountList {
    if (!this.installed()) {
      return { installed: false, list: [], login: null };
    }
    const { kept, hiddenIds } = this.partition({ probe: true, refresh: opts.refresh });
    return {
      installed: true,
      list: kept,
      login: this.login ? { ...this.login.state } : null,
      ...(hiddenIds.length > 0 ? { duplicates: hiddenIds.length } : {}),
    };
  }

  /** 已登录（或还不确定）且额度超过 QUOTA_REFRESH_MS 没更新 */
  private quotaStale(c: ProbeCache | undefined): boolean {
    if (!c || c.loggedIn === false) return false;
    return this.now() - c.at >= QUOTA_REFRESH_MS;
  }

  private shouldProbe(c: ProbeCache | undefined): boolean {
    if (!c) return true;
    const ttl = c.ok ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS;
    return this.now() - c.at >= ttl;
  }

  private bumpGen(id: string): void {
    this.gen.set(id, (this.gen.get(id) ?? 0) + 1);
  }

  /** 触发后台探测（同账号并发去重）；结果变化时通知 onChanged */
  triggerProbe(id: string, dir: string | null): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.probing.get(id);
    if (existing) return existing;
    const g = this.gen.get(id) ?? 0;
    const p = (async () => {
      const prev = this.cache.get(id);
      const prevLoggedIn = prev ? prev.loggedIn : (dir ? hasTokenFile(dir) : null);
      const prevPlan = prev?.plan ?? null;
      const res = await this.probeDir(dir);
      if (this.disposed || (this.gen.get(id) ?? 0) !== g) return;
      if (id !== DEFAULT_ID && !this.find(id)) return;
      const now = this.now();
      let next: ProbeCache;
      if (res.kind === 'ok') {
        // 这次没读到邮箱 / 额度（接口超时等）时沿用上次的，不让菜单里的信息闪没
        next = { loggedIn: true, plan: res.plan, email: res.email ?? prev?.email ?? null, quota: res.quota ?? prev?.quota ?? null, at: now, ok: true };
      } else if (res.kind === 'unauth') {
        next = { loggedIn: false, plan: null, at: now, ok: true };
      } else {
        // 其它错误（网络 / 地区不支持 / 超时等）不误判：有旧缓存沿用旧值（含 false），无缓存按本地状态判断
        const fallbackLoggedIn = prev ? prev.loggedIn : (dir ? hasTokenFile(dir) : null);
        next = { loggedIn: fallbackLoggedIn, plan: prevPlan, email: prev?.email ?? null, quota: prev?.quota ?? null, at: now, ok: false };
      }
      this.cache.set(id, next);
      let identityChanged = false;
      if (res.kind === 'ok' && next.email) {
        const h = hashEmail(next.email);
        if (h) {
          if (id === DEFAULT_ID) {
            if (this.defaultIdentityHash !== h) {
              this.defaultIdentityHash = h;
              identityChanged = true;
            }
          } else {
            const acc = this.find(id);
            if (acc && acc.identityHash !== h) {
              acc.identityHash = h;
              this.deps.store.save();
              identityChanged = true;
            }
          }
        }
      }
      const changed = identityChanged || prevLoggedIn !== next.loggedIn || prevPlan !== next.plan
        || (prev?.email ?? null) !== (next.email ?? null)
        || JSON.stringify(prev?.quota?.groups ?? null) !== JSON.stringify(next.quota?.groups ?? null);
      if (changed) this.deps.onChanged?.();
    })().finally(() => {
      if (this.probing.get(id) === p) this.probing.delete(id);
    });
    this.probing.set(id, p);
    return p;
  }

  private trackCleanup(dir: string | null, fn: () => Promise<void>): Promise<void> {
    const key = dir ? pathKey(dir) : null;
    const p = fn().catch(() => {});
    this.pendingCleanups.add(p);
    let set: Set<Promise<void>> | undefined;
    if (key) {
      set = this.dirCleanups.get(key);
      if (!set) this.dirCleanups.set(key, (set = new Set()));
      set.add(p);
    }
    void p.finally(() => {
      this.pendingCleanups.delete(p);
      if (key && set) {
        set.delete(p);
        if (set.size === 0) this.dirCleanups.delete(key);
      }
    });
    return p;
  }

  /** 等待某账号目录上正在执行的探测会话清理完成，避免与目录删除冲突 */
  private async waitDirCleanups(dir: string): Promise<void> {
    const set = this.dirCleanups.get(pathKey(dir));
    if (!set || set.size === 0) return;
    await Promise.allSettled([...set]);
  }

  /** 等待所有已调度的探测后台清理完成（测试 / 验证用） */
  async waitCleanups(): Promise<void> {
    while (this.pendingCleanups.size > 0) {
      await Promise.allSettled([...this.pendingCleanups]);
    }
  }

  /**
   * 一次性起 agy acp 做 initialize + session/new，读取登录状态与套餐后立刻结束进程：
   * - Windows 默认账号：使用一次性临时目录（不设 FORCE_FILE），退出后删除临时目录，不污染 ~/.gemini/antigravity-cli
   * - 非 Windows 默认账号：保持原目录，结束前发 session/close
   * - 添加的账号：退出后清理本次探测留下的 conversations/<sid>.db* 与 brain/<sid>
   */
  probeDir(dir: string | null): Promise<ProbeResult> {
    const agyPath = this.resolveFn();
    if (!agyPath) return Promise.resolve({ kind: 'error' });
    const cwd = os.tmpdir();
    const useScratch = dir === null && this.platform === 'win32';
    let scratchDir: string | undefined;
    if (useScratch) {
      try {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), PROBE_TMP_PREFIX));
      } catch {
        return Promise.resolve({ kind: 'error' });
      }
    }
    const args = ['acp', ...agyProbeArgs(dir, scratchDir)];
    // 该探测进程写日志的目录（--gemini-dir/--app-data-dir/log），从里面读 language server 端口
    const logDir = scratchDir
      ? path.join(scratchDir, 'p', 'log')
      : dir !== null
        ? path.join(dir, 'log')
        : path.join(os.homedir(), '.gemini', 'antigravity-cli', 'log');
    const env = agyAccountEnv(dir);
    let proc: ChildProcess;
    try {
      proc = (this.deps.spawnProbe ?? defaultSpawnProbe)(agyPath, args, env, cwd);
    } catch {
      if (scratchDir) void this.trackCleanup(null, () => safeRemoveProbeScratch(scratchDir!));
      return Promise.resolve({ kind: 'error' });
    }
    this.activeProbes.add(proc);

    return new Promise<ProbeResult>((resolve) => {
      let settled = false;
      let closed = false;
      let cleanupStarted = false;
      let probedSid: string | null = null;
      let closeGraceTimer: ReturnType<typeof setTimeout> | null = null;
      let cleanupFallbackTimer: ReturnType<typeof setTimeout> | null = null;
      const splitter = new LineSplitter();
      let stderrTail = '';

      const runCleanup = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        if (cleanupFallbackTimer) {
          clearTimeout(cleanupFallbackTimer);
          cleanupFallbackTimer = null;
        }
        this.pendingProbeCleanups.delete(forceCleanup);
        if (scratchDir) {
          const target = scratchDir;
          void this.trackCleanup(null, () => safeRemoveProbeScratch(target));
        } else if (dir !== null && probedSid && isSessionUuid(probedSid)) {
          const sid = probedSid;
          void this.trackCleanup(dir, () => safeCleanupProbeSession(dir, sid));
        }
      };

      const scheduleCleanupAfterExit = () => {
        if (!scratchDir && !(dir !== null && probedSid && isSessionUuid(probedSid))) {
          this.pendingProbeCleanups.delete(forceCleanup);
          return;
        }
        if (closed || proc.exitCode !== null || proc.signalCode !== null) {
          runCleanup();
          return;
        }
        proc.once('close', () => runCleanup());
        cleanupFallbackTimer = setTimeout(() => runCleanup(), PROBE_CLEANUP_FALLBACK_MS);
        cleanupFallbackTimer.unref?.();
      };

      const forceCleanup = () => {
        if (closeGraceTimer) {
          clearTimeout(closeGraceTimer);
          closeGraceTimer = null;
        }
        this.activeProbes.delete(proc);
        killProc(proc);
        scheduleCleanupAfterExit();
      };
      this.pendingProbeCleanups.add(forceCleanup);

      proc.once('close', () => {
        closed = true;
        if (closeGraceTimer) {
          clearTimeout(closeGraceTimer);
          closeGraceTimer = null;
        }
        this.activeProbes.delete(proc);
      });

      const writeMsg = (msg: Json) => {
        try {
          proc.stdin?.write(JSON.stringify(msg) + '\n');
        } catch { /* 由 close 处理 */ }
      };

      const finish = (r: ProbeResult, sendClose = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (sendClose && probedSid) {
          writeMsg({ jsonrpc: '2.0', id: 3, method: 'session/close', params: { sessionId: probedSid } });
          closeGraceTimer = setTimeout(() => {
            closeGraceTimer = null;
            this.activeProbes.delete(proc);
            killProc(proc);
            scheduleCleanupAfterExit();
          }, PROBE_CLOSE_GRACE_MS);
          closeGraceTimer.unref?.();
          resolve(r);
          return;
        }
        this.activeProbes.delete(proc);
        killProc(proc);
        scheduleCleanupAfterExit();
        resolve(r);
      };

      const timer = setTimeout(() => finish({ kind: 'error' }), this.probeTimeoutMs);
      timer.unref?.();

      proc.stdin?.on('error', () => {});
      proc.stderr?.on('data', (d: Buffer | string) => {
        stderrTail = (stderrTail + d.toString()).slice(-4096);
        if (/Authentication required/i.test(stderrTail)) finish({ kind: 'unauth' });
      });
      proc.stdout?.on('data', (d: Buffer | string) => {
        for (const line of splitter.push(d)) {
          let m: Json;
          try {
            m = JSON.parse(line);
          } catch {
            continue;
          }
          if (!m || typeof m !== 'object') continue;
          if (m.id === 1) {
            if (m.error) return finish({ kind: 'error' });
            writeMsg({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } });
          } else if (m.id === 2) {
            if (m.error) {
              const code = m.error?.code;
              const msg = String(m.error?.message ?? '');
              if (code === -32000 || /Authentication required/i.test(msg)) return finish({ kind: 'unauth' });
              return finish({ kind: 'error' });
            }
            const sid = typeof m.result?.sessionId === 'string' && m.result.sessionId ? m.result.sessionId : undefined;
            if (sid) probedSid = sid;
            const tier = m.result?._meta?.antigravity?.tier;
            const plan = typeof tier?.name === 'string' && tier.name.trim() ? tier.name.trim() : null;
            // 非 Windows 默认账号：沿用原目录，结束前发 session/close
            const sendClose = dir === null && !useScratch && !!probedSid;
            // 进程还活着：顺带读邮箱与额度（读不到就只缺这两项），再结束
            void this.readStatus(logDir, proc.pid).then((st) => {
              finish({ kind: 'ok', plan, ...(sid ? { sessionId: sid } : {}), ...(st?.email ? { email: st.email } : {}), ...(st?.quota ? { quota: st.quota } : {}) }, sendClose);
            });
            return;
          } else if (m.id === 3 && settled) {
            if (closeGraceTimer) {
              clearTimeout(closeGraceTimer);
              closeGraceTimer = null;
            }
            this.activeProbes.delete(proc);
            killProc(proc);
            scheduleCleanupAfterExit();
          }
        }
      });
      proc.on('error', () => finish({ kind: 'error' }));
      proc.on('close', () => finish({ kind: 'error' }));

      writeMsg({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'cosyee', version: '1' },
        },
      });
    });
  }

  /** 探测进程的 language server 里读邮箱与额度；任何失败返回 null */
  private async readStatus(logDir: string, pid: number | undefined): Promise<AgyStatus | null> {
    if (this.deps.probeStatus) return this.deps.probeStatus(logDir, pid).catch(() => null);
    const port = findLsPort(logDir, pid);
    if (port === null) return null;
    return fetchAgyStatus(port, STATUS_TIMEOUT_MS, this.now()).catch(() => null);
  }

  /** 切换当前账号：只影响新的委派任务，不停任何进程 */
  switchTo(id: string): Promise<void> {
    return this.serial(async () => {
      if (id !== DEFAULT_ID) {
        const a = this.find(id);
        if (!a) throw new HttpError(404, '账号不存在');
        if (!fs.existsSync(a.dir)) throw new HttpError(410, '账号的数据目录不存在了，请移除后重新添加');
      }
      const c = this.cache.get(id);
      if (c && c.loggedIn === false) throw new HttpError(400, '该账号还没有登录');
      if (id === this.activeId()) return;
      this.s.active = id === DEFAULT_ID ? null : id;
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

  /** 实际移除单个账号（需在 serial 内调用；不落盘、不发通知） */
  private async removeOne(id: string): Promise<void> {
    if (id === DEFAULT_ID) throw new HttpError(409, '默认账号不能移除');
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    if (id === this.activeId()) throw new HttpError(409, '不能移除当前账号，请先切换到其它账号');
    if (this.login && this.login.target === id && this.busy()) throw new HttpError(409, '该账号正在登录');
    const running = this.deps.running?.(id) ?? 0;
    if (running > 0) throw new HttpError(409, `该账号有 ${running} 个委派任务正在执行，请等它们结束后再移除`);
    if (this.deps.stopAccount && !this.deps.stopAccount(id)) {
      throw new HttpError(409, '该账号还有委派任务正在执行，请等它们结束后再移除');
    }
    await this.waitDirCleanups(a.dir);
    await safeRemoveAccountDir(a.dir, agyAccountsRoot());
    this.s.list = this.s.list.filter((x) => x.id !== id);
    this.bumpGen(id);
    this.cache.delete(id);
  }

  /** 移除添加的账号：默认、当前、正在登录、有执行中任务一律 409；先停空闲进程再安全删目录 */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      await this.removeOne(id);
      this.deps.store.save();
      this.deps.onChanged?.();
    });
  }

  /**
   * 清理 list() 去重时隐藏的重复账号条目：按与 remove() 相同的规则逐条移除，
   * 默认账号 / 当前账号 / 正在登录 / 有执行中委派任务等不可删的跳过并计入 skipped，不抛错。
   */
  dedupe(): Promise<AccountDedupeResult> {
    return this.serial(async () => {
      if (!this.installed()) return { removed: 0, skipped: 0 };
      const { hiddenIds } = this.partition({ probe: false });
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
    let loginDir: string | null;
    const root = agyAccountsRoot();

    if (opts.accountId !== undefined && opts.accountId !== null) {
      if (typeof opts.accountId !== 'string') throw new HttpError(400, 'accountId 不合法');
      target = opts.accountId;
      if (target === DEFAULT_ID) {
        const c = this.cache.get(DEFAULT_ID);
        if (c?.loggedIn === true) throw new HttpError(409, '默认账号已登录');
        if (c?.loggedIn !== false) {
          void this.triggerProbe(DEFAULT_ID, null);
          throw new HttpError(409, '正在检测默认账号状态，请稍后再试');
        }
        loginDir = null;
      } else {
        const a = this.find(target);
        if (!a) throw new HttpError(404, '账号不存在');
        // 重新登录先登录到临时目录 <root>/<临时id>，成功后再只替换令牌文件，失败不破坏原登录与会话记录
        loginDir = this.allocAccountDir(root);
      }
    } else {
      loginDir = this.allocAccountDir(root);
    }

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
      if (loginDir) void this.discardDir(loginDir);
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
    const clearTimer = () => {
      if (job.timer) {
        clearTimeout(job.timer);
        job.timer = null;
      }
    };
    if (job.cancelTimer && (job.proc?.exitCode !== null || job.proc?.signalCode !== null)) {
      clearTimeout(job.cancelTimer);
      job.cancelTimer = null;
    }

    const cleanupTemp = () => {
      if (!job.loginDir) return;
      const p = job.proc;
      if (p && p.exitCode === null && p.signalCode === null) {
        p.once('close', () => {
          if (job.cancelTimer) {
            clearTimeout(job.cancelTimer);
            job.cancelTimer = null;
          }
          void this.discardDir(job.loginDir!);
        });
      } else {
        void this.discardDir(job.loginDir);
      }
    };

    const fail = (msg: string) => {
      clearTimer();
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

    // 退出码 0 后用 session/new 探测确认已登录才登记（探测期间保留超时定时器，超时 / 取消 / error 后不得再登记）
    const probe = await this.probeDir(job.loginDir);
    if (job.cancelled || this.disposed || isTerminal()) {
      clearTimer();
      cleanupTemp();
      return;
    }
    if (probe.kind !== 'ok') {
      return fail('登录没有完成');
    }

    // 重复账号判重（基于邮箱 sha256 哈希，不存 / 不暴露邮箱）；优先取登录输出哈希，缺失时用探测邮箱兜底
    // 默认账号凭据已写入系统凭据库无法回滚，跳过判重（列表显示时会自动去重）
    const hash = job.identityHash ?? hashEmail(probe.email);
    if (hash && job.target !== DEFAULT_ID) {
      const dupInList = this.s.list.some((a) => a.id !== job.target && this.identityHashOf(a.id, a.identityHash) === hash);
      const dupDefault = this.identityHashOf(DEFAULT_ID) === hash;
      if (dupInList || dupDefault) {
        return fail('这个账号已经添加过了');
      }
    }

    if (job.target === DEFAULT_ID) {
      clearTimer();
      if (hash) this.defaultIdentityHash = hash;
      this.deps.resetAccount?.(DEFAULT_ID);
      this.bumpGen(DEFAULT_ID);
      this.cache.set(DEFAULT_ID, { loggedIn: true, plan: probe.plan, email: probe.email ?? null, quota: probe.quota ?? null, at: this.now(), ok: true });
      st.status = 'done';
      st.error = null;
      this.deps.onChanged?.();
      return;
    }

    if (job.target) {
      const a = this.find(job.target);
      if (!a) return fail('账号不存在');
      // 替换令牌前先停该账号空闲进程 / 排空忙进程 / 清模型缓存
      this.deps.resetAccount?.(a.id);
      try {
        await replaceAuthFiles(job.loginDir!, a.dir);
      } catch {
        return fail('更新登录凭据失败，原登录未受影响');
      }
      // 替换成功后再重置一次，防止替换期间新起的进程拿着旧令牌
      this.deps.resetAccount?.(a.id);
      await this.discardDir(job.loginDir!);
      clearTimer();
      if (job.cancelled || this.disposed || isTerminal()) return;
      if (hash) a.identityHash = hash;
      this.deps.store.save();
      this.bumpGen(a.id);
      this.cache.set(a.id, { loggedIn: true, plan: probe.plan, email: probe.email ?? null, quota: probe.quota ?? null, at: this.now(), ok: true });
      st.status = 'done';
      st.error = null;
      this.deps.onChanged?.();
      return;
    }

    // 添加新账号
    const dir = job.loginDir!;
    const id = path.basename(dir);
    if (this.s.list.some((x) => x.id === id || pathKey(x.dir) === pathKey(dir))) {
      return fail('账号目录冲突，请重试');
    }
    clearTimer();
    // 没填备注名就留空：菜单里显示登录的邮箱
    const label = job.label;
    this.s.list.push({
      id,
      label,
      dir,
      createdAt: this.now(),
      ...(hash ? { identityHash: hash } : {}),
    });
    this.deps.store.save();
    st.accountId = id;
    this.bumpGen(id);
    this.cache.set(id, { loggedIn: true, plan: probe.plan, email: probe.email ?? null, quota: probe.quota ?? null, at: this.now(), ok: true });
    st.status = 'done';
    st.error = null;
    this.deps.onChanged?.();
  }

  /** 丢弃未登记的新账号 / 临时目录（只删 agyAccountsRoot 下、未登记的直接子目录） */
  private async discardDir(dir: string): Promise<void> {
    if (this.s.list.some((a) => pathKey(a.dir) === pathKey(dir))) return;
    await this.waitDirCleanups(dir);
    try {
      await safeRemoveAccountDir(dir, agyAccountsRoot());
    } catch { /* 留着也无害 */ }
  }

  /** 服务关闭时：结束进行中的登录与探测进程，并触发探测残留清理 */
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
    for (const fn of [...this.pendingProbeCleanups]) fn();
    this.pendingProbeCleanups.clear();
    for (const p of [...this.activeProbes]) killProc(p);
    this.activeProbes.clear();
  }
}
