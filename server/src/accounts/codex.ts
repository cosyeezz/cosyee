// OpenAI Codex CLI 多账号管理：默认账号（宿主 CODEX_HOME 或 ~/.codex）+ 在 Cosyee 里添加的独立账号。
// 每个额外账号有独立的 CODEX_HOME（~/.cosyee/codex-accounts/<id>），登录凭据用 `-c cli_auth_credentials_store="file"` 落在 auth.json。
// 支持三种登录：deviceAuth（设备码）、chatgpt（浏览器 OAuth via app-server）、apiKey（stdin 传给 --with-api-key）。
// 绝不对外返回或记录 token / apiKey；判重只存哈希。
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AccountDedupeResult, AccountLogin, CodexAccountEntry, CodexAccountList, CodexLoginMethod, CodexQuota } from '@cosyee/shared';
import { killTree, spawnSpec } from '../claude/bin.js';
import { sanitizeLogLine } from '../delegate/agyCli.js';
import { type CodexInfo, resolveCodexInfo } from '../delegate/codex.js';
import type { CodexAccountRef, CodexAccountSource } from '../delegate/codexAppServer.js';
import { type CodexAccountInfo, N } from '../delegate/codexProtocol.js';
import { JsonRpcConnection } from '../delegate/jsonRpc.js';
import { baseCodexHome, codexAccountsRoot, pathKey } from '../paths.js';
import { ACCOUNT_ID_RE, HttpError, type StateStore, type StoredAccount } from '../workspaces.js';
import { codexAccountArgs, codexAccountEnv, ensureCodexHome } from './codex-env.js';
import {
  CODEX_AUTH_FILE,
  type CodexAuthMeta,
  computeCodexIdentityHash,
  hasCodexAuthFile,
  hashApiKey,
  mergeCodexQuota,
  parseCodexRateLimits,
  readAuthJsonMeta,
} from './codex-status.js';
import { lstat, mkdirPrivate, replaceAuthFiles as replaceAuthFilesIn, safeRemoveAccountDir } from './fs.js';
import { DEFAULT_ID, stripAnsi } from './index.js';

const LABEL_MAX = 40;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const ORPHAN_MAX_AGE_MS = 60 * 60_000;
const CANCEL_KILL_GRACE_MS = 500;
const OUTPUT_MAX = 16 * 1024;
const PROBE_OK_TTL_MS = 30 * 60_000;
const PROBE_FAIL_TTL_MS = 60_000;
const QUOTA_TTL_MS = 90_000;
const CHATGPT_RPC_TIMEOUT_MS = 30_000;

const CLIENT_INFO = { name: 'cosyee', title: 'Cosyee', version: '1' };
const LOGIN_METHODS: readonly CodexLoginMethod[] = ['chatgpt', 'deviceAuth', 'apiKey'];

export interface CodexAccountsDeps {
  store: StateStore;
  /** 某账号正在执行的委派任务数 */
  running?: (accountId: string) => number;
  /** 移除账号前停止该账号的空闲进程；仍有执行中任务返回 false */
  stopAccount?: (accountId: string) => boolean;
  /** 重新登录后丢弃空闲进程、排空忙进程、清模型缓存 */
  resetAccount?: (accountId: string) => void;
  /** 探测登录态（通常接 pool.readAccount） */
  readAccount?: (o: { execPath: string; cwd: string; account: CodexAccountRef }) => Promise<CodexAccountInfo>;
  /** 探测限额（通常接 pool.readRateLimitsRaw，返回原始 GetAccountRateLimitsResponse） */
  readRateLimits?: (o: { execPath: string; cwd: string; account: CodexAccountRef }) => Promise<unknown>;
  /** 账号列表 / 当前账号 / 探测结果变化时回调 */
  onChanged?: () => void;
  /** 测试替换：解析 codex */
  resolveCodex?: () => CodexInfo | null;
  /** 测试替换：默认账号目录（默认 baseCodexHome） */
  baseHome?: () => string;
  /** 测试替换：额外账号根目录（默认 codexAccountsRoot） */
  accountsRoot?: () => string;
  /** 测试替换：启动登录子进程 */
  spawnLogin?: (execPath: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess;
  /** 测试替换：时间源 */
  now?: () => number;
  /** 测试替换：登录超时 */
  loginTimeoutMs?: number;
  /** 测试替换：进程环境基底 */
  baseEnv?: NodeJS.ProcessEnv;
}

interface ProbeCache {
  loggedIn: boolean;
  email: string | null;
  authMode: 'chatgpt' | 'apiKey' | null;
  planType: string | null;
  accountId: string | null;
  quota: CodexQuota | null;
  probedAt: number;
  quotaAt: number;
  identityHash: string | null;
}

interface LoginJob {
  state: AccountLogin;
  method: CodexLoginMethod;
  proc: ChildProcess | null;
  conn: JsonRpcConnection | null;
  rpcLoginId: string | null;
  loginDir: string;
  /** 给已有账号（含 'default'）重新登录时是它的 id；添加新账号时为 null */
  target: string | null;
  label: string;
  output: string;
  /** apiKey 登录时只保存哈希，不保存原文 */
  apiKeyHash: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  cancelTimer: ReturnType<typeof setTimeout> | null;
  finishing: boolean;
  cancelled: boolean;
}

/** 从 `codex login --device-auth` 输出中提取验证链接与一次性设备码 */
export function findCodexDeviceAuth(raw: string): { url: string | null; userCode: string | null } {
  const clean = stripAnsi(raw);
  const urlMatch =
    /https:\/\/[^\s"'<>\x07\x1b]*\/device[^\s"'<>\x07\x1b]*/i.exec(clean) ??
    /https:\/\/auth\.openai\.com\/[^\s"'<>\x07\x1b]+/i.exec(clean) ??
    /https:\/\/[^\s"'<>\x07\x1b]+/i.exec(clean);
  let url: string | null = null;
  if (urlMatch) {
    try {
      const u = new URL(urlMatch[0]);
      if (u.protocol === 'https:') url = u.toString();
    } catch { /* ignore */ }
  }

  let userCode: string | null = null;
  // 优先在 "one-time code" / "code" 提示语之后匹配形如 XXXX-XXXXX 的设备码
  const afterPrompt = /(?:one-time code|enter(?:\s+this)?\s+(?:one-time\s+)?code|user code)[^\n]*\r?\n\s*([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\b/i.exec(clean);
  if (afterPrompt) {
    userCode = afterPrompt[1]!.toUpperCase();
  } else {
    // 兜底：独立一行的大写字母数字连字符码（排除日期/版本号）
    const lineMatch = /^\s*([A-Z0-9]{4,6}-[A-Z0-9]{4,6})\s*$/m.exec(clean);
    if (lineMatch) userCode = lineMatch[1]!.toUpperCase();
  }
  return { url, userCode };
}

function sanitizeErrorTail(raw: string): string {
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const last = lines[lines.length - 1] ?? '';
  if (!last) return '';
  return sanitizeLogLine(last).replace(/https?:\/\/\S+/gi, '[url]').slice(0, 160);
}

function describeDeviceAuthError(raw: string): string | null {
  const clean = stripAnsi(raw);
  if (/(?:device[\s_-]*(?:auth|code)|device_auth).*(?:not enabled|disabled|not allowed|not supported|forbidden|403|unauthorized_client)/i.test(clean)
    || /(?:enable|turn on)\s+device\s+code/i.test(clean)) {
    return '该账号或工作区未开启设备码登录：请在 ChatGPT 安全设置中开启「设备代码登录」，或改用浏览器登录 / API Key';
  }
  return null;
}

function describePort1455Error(msg: string): string | null {
  if (/1455|EADDRINUSE|address already in use|os error (?:10048|48|98)/i.test(msg)) {
    return '本地回调端口 1455 已被占用：请关闭其它正在登录的 Codex 进程后重试，或改用设备码登录';
  }
  return null;
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
  } catch { /* ignore */ }
}

function defaultSpawnLogin(execPath: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const spec = spawnSpec(execPath, args);
  return spawn(spec.command, spec.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim,
  });
}

async function replaceAuthJson(tempDir: string, targetDir: string): Promise<void> {
  await replaceAuthFilesIn(tempDir, targetDir, [CODEX_AUTH_FILE], CODEX_AUTH_FILE);
}

export class CodexAccounts implements CodexAccountSource {
  private login: LoginJob | null = null;
  private switching: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly cache = new Map<string, ProbeCache>();
  private readonly probing = new Map<string, Promise<void>>();
  private readonly now: () => number;
  private readonly resolveFn: () => CodexInfo | null;
  private readonly baseHomeFn: () => string;
  private readonly accountsRootFn: () => string;
  private readonly loginTimeoutMs: number;
  private readonly baseEnv: NodeJS.ProcessEnv;

  constructor(private readonly deps: CodexAccountsDeps) {
    this.now = deps.now ?? Date.now;
    this.resolveFn = deps.resolveCodex ?? (() => resolveCodexInfo());
    this.baseHomeFn = deps.baseHome ?? baseCodexHome;
    this.accountsRootFn = deps.accountsRoot ?? codexAccountsRoot;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    this.baseEnv = deps.baseEnv ?? process.env;
  }

  private get s() {
    return this.deps.store.state.codexAccounts;
  }

  private find(id: string): StoredAccount | undefined {
    return this.s.list.find((a) => a.id === id);
  }

  installed(): boolean {
    return this.resolveFn() !== null;
  }

  /** 当前活跃账号 id（null = 默认账号 'default'） */
  activeId(): string {
    const id = this.s.active;
    if (id && this.find(id)) return id;
    return DEFAULT_ID;
  }

  /** CodexAccountSource.active() */
  active(): CodexAccountRef {
    const id = this.activeId();
    return this.accountFor(id) ?? { id: DEFAULT_ID, dir: null };
  }

  /** CodexAccountSource.accountFor(id) */
  accountFor(id: string): CodexAccountRef | null {
    if (id === DEFAULT_ID) return { id: DEFAULT_ID, dir: null };
    const a = this.find(id);
    if (!a) return null;
    return { id: a.id, dir: a.dir, label: a.label };
  }

  private dirForMeta(id: string): string | null {
    if (id === DEFAULT_ID) return this.baseHomeFn();
    return this.find(id)?.dir ?? null;
  }

  private cacheValid(c: ProbeCache): boolean {
    const ttl = c.loggedIn ? PROBE_OK_TTL_MS : PROBE_FAIL_TTL_MS;
    return this.now() - c.probedAt < ttl;
  }

  private quotaValid(c: ProbeCache): boolean {
    return c.quotaAt > 0 && this.now() - c.quotaAt < QUOTA_TTL_MS;
  }

  /** 指定账号是否已登录（同步、不阻塞）：true / false / 'unknown'；账号不存在返回 null */
  loggedIn(id: string): boolean | 'unknown' | null {
    const acc = this.accountFor(id);
    if (!acc) return null;
    const hit = this.cache.get(id);
    if (hit && this.cacheValid(hit)) return hit.loggedIn;
    if (id !== DEFAULT_ID) {
      if (!acc.dir || !hasCodexAuthFile(acc.dir)) return false;
    } else {
      // 默认账号未缓存时触发后台探测，不阻塞当前调用
      if (this.installed()) void this.triggerProbe(acc, false);
    }
    const dir = this.dirForMeta(id);
    if (dir && hasCodexAuthFile(dir)) {
      const meta = readAuthJsonMeta(dir);
      if (meta?.authMode) return true;
    }
    return 'unknown';
  }

  /** CodexAccountSource.activeLoggedIn() */
  activeLoggedIn(): boolean | 'unknown' {
    if (!this.installed()) return false;
    const res = this.loggedIn(this.activeId());
    return res === null ? false : res;
  }

  /** 启动时调用：校验活跃账号目录，并清理遗留的未登记临时目录 */
  init(): void {
    let dirty = false;
    if (this.s.active) {
      const a = this.find(this.s.active);
      if (!a || !fs.existsSync(a.dir)) {
        this.s.active = null;
        dirty = true;
      }
    }
    if (dirty) this.deps.store.save();
    this.cleanupOrphanDirs();
  }

  private cleanupOrphanDirs(): void {
    const root = this.accountsRootFn();
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

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.switching.then(fn);
    this.switching = run.then(() => {}, () => {});
    return run;
  }

  private notify(): void {
    if (this.disposed) return;
    try {
      this.deps.onChanged?.();
    } catch { /* ignore */ }
  }

  /** 收到 app-server 的 account/rateLimits/updated 推送时更新缓存 */
  noteRateLimits(accountId: string, raw: unknown): void {
    if (this.disposed) return;
    const at = this.now();
    const prev = this.cache.get(accountId);
    const merged = mergeCodexQuota(prev?.quota ?? null, raw, at);
    if (!merged) return;
    if (prev) {
      prev.quota = merged;
      prev.quotaAt = at;
      if (merged.planType && !prev.planType) prev.planType = merged.planType;
    } else {
      const meta = this.readLocalMeta(accountId);
      this.cache.set(accountId, {
        loggedIn: true,
        email: meta?.email ?? null,
        authMode: meta?.authMode ?? 'chatgpt',
        planType: merged.planType ?? meta?.planType ?? null,
        accountId: meta?.accountId ?? null,
        quota: merged,
        probedAt: at,
        quotaAt: at,
        identityHash: meta ? computeCodexIdentityHash(meta) : null,
      });
    }
    this.notify();
  }

  private readLocalMeta(id: string): CodexAuthMeta | null {
    const dir = this.dirForMeta(id);
    return dir ? readAuthJsonMeta(dir) : null;
  }

  private identityHashOf(id: string, stored?: StoredAccount): string | null {
    if (stored?.identityHash) return stored.identityHash;
    const cached = this.cache.get(id)?.identityHash;
    if (cached) return cached;
    const meta = this.readLocalMeta(id);
    return meta ? computeCodexIdentityHash(meta) : null;
  }

  /** 后台探测单个账号（单飞，不阻塞 list()） */
  private triggerProbe(acc: CodexAccountRef, force: boolean): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.probing.get(acc.id);
    if (existing) return existing;
    const info = this.resolveFn();
    if (!info) return Promise.resolve();
    const hit = this.cache.get(acc.id);
    const needAccount = force || !hit || !this.cacheValid(hit);
    const needQuota = force || !hit || (hit.loggedIn && hit.authMode !== 'apiKey' && !this.quotaValid(hit));
    if (!needAccount && !needQuota) return Promise.resolve();

    const p = this.doProbe(info, acc, needAccount, needQuota)
      .catch(() => {})
      .finally(() => {
        if (this.probing.get(acc.id) === p) this.probing.delete(acc.id);
      });
    this.probing.set(acc.id, p);
    return p;
  }

  private async doProbe(info: CodexInfo, acc: CodexAccountRef, needAccount: boolean, needQuota: boolean): Promise<void> {
    if (!this.deps.readAccount && !this.deps.readRateLimits) return;
    const cwd = os.homedir();
    const prev = this.cache.get(acc.id);
    const meta = this.readLocalMeta(acc.id);
    const at = this.now();

    let loggedIn = prev?.loggedIn ?? false;
    let email = meta?.email ?? prev?.email ?? null;
    let authMode = meta?.authMode ?? prev?.authMode ?? null;
    let planType = meta?.planType ?? prev?.planType ?? null;
    const chatgptAccountId = meta?.accountId ?? prev?.accountId ?? null;
    let probedAt = prev?.probedAt ?? at;

    if (needAccount && this.deps.readAccount) {
      try {
        const res = await this.deps.readAccount({ execPath: info.execPath, cwd, account: acc });
        probedAt = this.now();
        if (res.account) {
          loggedIn = true;
          if (res.account.type === 'chatgpt') {
            authMode = 'chatgpt';
            if ('email' in res.account && res.account.email) email = res.account.email;
            if ('planType' in res.account && res.account.planType) planType = res.account.planType;
          } else if (res.account.type === 'apiKey') {
            authMode = 'apiKey';
          }
        } else {
          loggedIn = false;
        }
      } catch {
        probedAt = this.now();
        // 探测出错时：若本地 auth.json 存在则保留已有/本地判断，否则记为未登录（短 TTL 60s）
        loggedIn = prev ? prev.loggedIn : Boolean(meta?.authMode);
      }
    }

    let quota = prev?.quota ?? null;
    let quotaAt = prev?.quotaAt ?? 0;
    if (loggedIn && authMode !== 'apiKey' && needQuota && this.deps.readRateLimits) {
      try {
        const raw = await this.deps.readRateLimits({ execPath: info.execPath, cwd, account: acc });
        quotaAt = this.now();
        const parsed = parseCodexRateLimits(raw, quotaAt);
        if (parsed) {
          quota = parsed;
          if (parsed.planType) planType = parsed.planType;
        }
      } catch {
        quotaAt = this.now();
      }
    } else if (!loggedIn || authMode === 'apiKey') {
      quota = null;
    }

    const identityHash = computeCodexIdentityHash({
      authMode,
      email,
      accountId: chatgptAccountId,
      apiKeyHash: meta?.apiKeyHash ?? null,
    });

    this.cache.set(acc.id, {
      loggedIn,
      email,
      authMode,
      planType,
      accountId: chatgptAccountId,
      quota,
      probedAt,
      quotaAt,
      identityHash,
    });

    if (acc.id !== DEFAULT_ID && identityHash) {
      const stored = this.find(acc.id);
      if (stored && !stored.identityHash) {
        stored.identityHash = identityHash;
        this.deps.store.save();
      }
    }
    this.notify();
  }

  /** 等待所有正在进行的后台探测完成（测试用） */
  async waitForProbes(): Promise<void> {
    while (this.probing.size > 0) await Promise.all([...this.probing.values()]);
  }

  /** 把账号分为「保留项」与「去重隐藏项」；优先级 当前账号 > 默认账号 > 最早添加；未知身份不去重 */
  private partition(): { kept: CodexAccountEntry[]; hiddenIds: string[] } {
    const active = this.activeId();

    const buildEntry = (id: string, isDefault: boolean, label: string, stored?: StoredAccount): {
      idx: number;
      createdAt: number;
      hash: string | null;
      entry: CodexAccountEntry;
    } => {
      const c = this.cache.get(id);
      const meta = this.readLocalMeta(id);
      let loggedIn: boolean | null;
      if (c && this.cacheValid(c)) {
        loggedIn = c.loggedIn;
      } else if (!isDefault && stored && !hasCodexAuthFile(stored.dir)) {
        loggedIn = false;
      } else if (meta?.authMode) {
        loggedIn = true;
      } else {
        loggedIn = null;
      }
      const planType = c?.planType ?? meta?.planType ?? null;
      const authMode = c?.authMode ?? meta?.authMode ?? null;
      const email = c?.email ?? meta?.email ?? null;
      const quota = authMode === 'apiKey' || loggedIn === false ? null : (c?.quota ?? null);
      return {
        idx: 0,
        createdAt: stored?.createdAt ?? 0,
        hash: this.identityHashOf(id, stored),
        entry: {
          id,
          label: isDefault ? '' : label,
          plan: planType,
          loggedIn,
          active: id === active,
          isDefault,
          running: this.deps.running?.(id) ?? 0,
          email,
          authMode,
          planType,
          quota,
        },
      };
    };

    const rows = [
      buildEntry(DEFAULT_ID, true, ''),
      ...this.s.list.map((a) => buildEntry(a.id, false, a.label, a)),
    ].map((r, idx) => ({ ...r, idx }));

    const ordered = [...rows].sort(
      (a, b) =>
        Number(b.entry.active) - Number(a.entry.active) ||
        Number(b.entry.isDefault) - Number(a.entry.isDefault) ||
        a.createdAt - b.createdAt ||
        a.idx - b.idx,
    );

    const seen = new Set<string>();
    const kept: typeof rows = [];
    const hiddenIds: string[] = [];
    for (const r of ordered) {
      if (r.hash) {
        if (seen.has(r.hash)) {
          // 默认账号绝不隐藏（如果与非默认当前账号重复，非默认已排在前面；默认账号保留在列表或仅非默认被隐藏）
          if (!r.entry.isDefault) {
            hiddenIds.push(r.entry.id);
            continue;
          }
        }
        seen.add(r.hash);
      }
      kept.push(r);
    }
    kept.sort((a, b) => a.idx - b.idx);
    return { kept: kept.map((r) => r.entry), hiddenIds };
  }

  /** 返回账号列表（不阻塞）；按需在后台触发探测 */
  list(opts: { refresh?: boolean } = {}): CodexAccountList {
    if (!this.installed()) {
      return { installed: false, list: [], login: null };
    }
    const refresh = Boolean(opts.refresh);
    // 后台触发探测（单飞，不阻塞返回）
    void this.triggerProbe({ id: DEFAULT_ID, dir: null }, refresh);
    for (const a of this.s.list) {
      if (hasCodexAuthFile(a.dir) || refresh) {
        void this.triggerProbe({ id: a.id, dir: a.dir, label: a.label }, refresh);
      }
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
      if (id === DEFAULT_ID) {
        if (this.s.active === null) return;
        this.s.active = null;
        this.deps.store.save();
        this.notify();
        return;
      }
      const a = this.find(id);
      if (!a) throw new HttpError(404, '账号不存在');
      if (!fs.existsSync(a.dir)) throw new HttpError(410, '账号的数据目录不存在了，请移除后重新添加');
      if (!hasCodexAuthFile(a.dir)) throw new HttpError(400, '该账号还没有登录');
      if (this.s.active === id) return;
      this.s.active = id;
      this.deps.store.save();
      this.notify();
    });
  }

  setLabel(id: string, label: unknown): void {
    if (id === DEFAULT_ID) throw new HttpError(400, '默认账号不能修改备注名');
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    a.label = cleanLabel(label);
    this.deps.store.save();
    this.notify();
  }

  private async removeOne(id: string): Promise<void> {
    if (id === DEFAULT_ID) throw new HttpError(400, '默认账号不能移除');
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    if (this.login && this.login.target === id && this.busy()) throw new HttpError(409, '该账号正在登录');
    const running = this.deps.running?.(id) ?? 0;
    if (running > 0) throw new HttpError(409, `该账号有 ${running} 个委派任务正在执行，请等它们结束后再移除`);
    if (this.deps.stopAccount && !this.deps.stopAccount(id)) {
      throw new HttpError(409, '该账号还有委派任务正在执行，请等它们结束后再移除');
    }
    await safeRemoveAccountDir(a.dir, this.accountsRootFn());
    this.cache.delete(id);
    this.s.list = this.s.list.filter((x) => x.id !== id);
    if (this.s.active === id) this.s.active = null;
  }

  remove(id: string): Promise<void> {
    return this.serial(async () => {
      await this.removeOne(id);
      this.deps.store.save();
      this.notify();
    });
  }

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
        this.notify();
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

  private allocTempDir(): string {
    const root = this.accountsRootFn();
    let id = newId();
    while (this.find(id) || fs.existsSync(path.join(root, id))) id = newId();
    const dir = path.join(root, id);
    mkdirPrivate(dir);
    return dir;
  }

  private defaultAccountLabel(): string {
    const used = new Set(this.s.list.map((a) => a.label));
    for (let n = this.s.list.length + 2; ; n++) {
      const cand = `账号 ${n}`;
      if (!used.has(cand)) return cand;
    }
  }

  /** 启动登录：支持 deviceAuth / chatgpt / apiKey；不传 accountId 添加新账号，传了则重新登录 */
  startLogin(opts: { method?: unknown; label?: unknown; accountId?: unknown; apiKey?: unknown }): AccountLogin {
    const info = this.resolveFn();
    if (!info) throw new HttpError(503, '没有安装 Codex CLI');
    if (this.busy()) throw new HttpError(409, '已有一个登录正在进行');

    const method = opts.method;
    if (typeof method !== 'string' || !(LOGIN_METHODS as readonly string[]).includes(method)) {
      throw new HttpError(400, '登录方式必须是 chatgpt、deviceAuth 或 apiKey');
    }

    let target: string | null = null;
    if (opts.accountId !== undefined && opts.accountId !== null) {
      if (typeof opts.accountId !== 'string') throw new HttpError(400, 'accountId 不合法');
      if (opts.accountId !== DEFAULT_ID && !this.find(opts.accountId)) throw new HttpError(404, '账号不存在');
      target = opts.accountId;
    }

    let apiKey: string | null = null;
    if (method === 'apiKey') {
      if (typeof opts.apiKey !== 'string') throw new HttpError(400, '缺少 API Key');
      const k = opts.apiKey.trim();
      if (!k || k.length > 512 || /[\r\n\x00-\x1f]/.test(k)) throw new HttpError(400, 'API Key 格式不合法');
      apiKey = k;
    }

    const loginDir = this.allocTempDir();
    ensureCodexHome(loginDir);

    const state: AccountLogin = {
      loginId: newId(),
      status: 'starting',
      url: null,
      userCode: null,
      method: method as CodexLoginMethod,
      accountId: target,
      error: null,
    };
    const job: LoginJob = {
      state,
      method: method as CodexLoginMethod,
      proc: null,
      conn: null,
      rpcLoginId: null,
      loginDir,
      target,
      label: cleanLabel(opts.label),
      output: '',
      apiKeyHash: apiKey ? hashApiKey(apiKey) : null,
      timer: null,
      cancelTimer: null,
      finishing: false,
      cancelled: false,
    };

    const env = codexAccountEnv(loginDir, this.baseEnv);
    const spawnFn = this.deps.spawnLogin ?? defaultSpawnLogin;

    try {
      if (method === 'deviceAuth') {
        this.launchDeviceAuth(job, info.execPath, env, spawnFn);
      } else if (method === 'apiKey') {
        this.launchApiKey(job, info.execPath, env, spawnFn, apiKey!);
      } else {
        this.launchChatGpt(job, info.execPath, env, spawnFn);
      }
    } catch (e) {
      void this.discardDir(loginDir);
      if (e instanceof HttpError) throw e;
      throw new HttpError(500, `无法启动 codex：${e instanceof Error ? e.message : String(e)}`);
    }

    this.login = job;
    job.timer = setTimeout(() => {
      void this.finishLogin(job, null, '登录超时');
      this.terminateJobProc(job);
    }, this.loginTimeoutMs);
    job.timer.unref?.();
    return { ...state };
  }

  private launchDeviceAuth(
    job: LoginJob,
    execPath: string,
    env: NodeJS.ProcessEnv,
    spawnFn: (execPath: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess,
  ): void {
    const args = [...codexAccountArgs(job.loginDir), 'login', '--device-auth'];
    const proc = spawnFn(execPath, args, env);
    job.proc = proc;

    const onData = (d: Buffer | string) => {
      const chunk = d.toString('utf8');
      if (job.output.length < OUTPUT_MAX) job.output += chunk;
      if (!job.state.url || !job.state.userCode) {
        const found = findCodexDeviceAuth(job.output);
        if (found.url && !job.state.url) job.state.url = found.url;
        if (found.userCode && !job.state.userCode) job.state.userCode = found.userCode;
        if (job.state.url && job.state.userCode && job.state.status === 'starting') {
          job.state.status = 'waiting';
        }
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.stdin?.on('error', () => {});
    proc.on('error', () => void this.finishLogin(job, null, '启动登录进程失败'));
    proc.on('close', (code) => void this.finishLogin(job, code, null));
  }

  private launchApiKey(
    job: LoginJob,
    execPath: string,
    env: NodeJS.ProcessEnv,
    spawnFn: (execPath: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess,
    apiKey: string,
  ): void {
    const args = [...codexAccountArgs(job.loginDir), 'login', '--with-api-key'];
    const proc = spawnFn(execPath, args, env);
    job.proc = proc;

    const onData = (d: Buffer | string) => {
      const chunk = d.toString('utf8');
      if (job.output.length < OUTPUT_MAX) job.output += chunk;
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.stdin?.on('error', () => {});
    proc.on('error', () => void this.finishLogin(job, null, '启动登录进程失败'));
    proc.on('close', (code) => void this.finishLogin(job, code, null));
    // API Key 只走 stdin，不进命令行、不进日志
    try {
      proc.stdin?.write(apiKey + '\n');
      proc.stdin?.end();
    } catch { /* 由 close / error 处理 */ }
  }

  private launchChatGpt(
    job: LoginJob,
    execPath: string,
    env: NodeJS.ProcessEnv,
    spawnFn: (execPath: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcess,
  ): void {
    const args = [...codexAccountArgs(job.loginDir), 'app-server', '--listen', 'stdio://'];
    const proc = spawnFn(execPath, args, env);
    job.proc = proc;

    const conn = new JsonRpcConnection({
      write: (line) => {
        try {
          return proc.stdin?.write(line) !== undefined;
        } catch {
          return false;
        }
      },
      timeoutMs: CHATGPT_RPC_TIMEOUT_MS,
      onNotification: (method, params) => {
        if (method !== 'account/login/completed') return;
        const p = (params && typeof params === 'object' ? params : {}) as { loginId?: unknown; success?: unknown; error?: unknown };
        if (job.rpcLoginId && typeof p.loginId === 'string' && p.loginId && p.loginId !== job.rpcLoginId) return;
        if (p.success === true) {
          this.terminateJobProc(job);
          void this.finishLogin(job, 0, null);
        } else {
          const rawErr = typeof p.error === 'string' ? p.error : '';
          this.terminateJobProc(job);
          void this.finishLogin(job, null, describePort1455Error(rawErr) ?? (sanitizeLogLine(rawErr) || 'ChatGPT 登录失败'));
        }
      },
    });
    job.conn = conn;

    proc.stdout?.on('data', (d: Buffer | string) => conn.feed(d));
    proc.stdout?.on('end', () => conn.end());
    proc.stderr?.on('data', (d: Buffer | string) => {
      const s = d.toString('utf8');
      conn.feedStderr(s);
      if (job.output.length < OUTPUT_MAX) job.output += s;
    });
    proc.stdin?.on('error', () => {});
    proc.on('error', () => {
      conn.failAll(new Error('启动登录进程失败'));
      void this.finishLogin(job, null, '启动登录进程失败');
    });
    proc.on('close', (code) => {
      conn.failAll(new Error(`登录进程退出（${code}）`));
      if (job.state.status === 'starting' || job.state.status === 'waiting') {
        const portErr = describePort1455Error(job.output + '\n' + conn.stderrTail);
        void this.finishLogin(job, code, portErr);
      }
    });

    // 异步握手并发起 account/login/start { type: 'chatgpt' }
    void (async () => {
      try {
        await conn.request('initialize', { clientInfo: CLIENT_INFO, capabilities: { experimentalApi: false, requestAttestation: false } });
        conn.notify('initialized');
        if (job.cancelled || this.disposed) return;
        const res = (await conn.request('account/login/start', { type: 'chatgpt' })) as { loginId?: unknown; authUrl?: unknown } | null;
        if (job.cancelled || this.disposed) return;
        const authUrl = typeof res?.authUrl === 'string' ? res.authUrl.trim() : '';
        const rpcId = typeof res?.loginId === 'string' ? res.loginId : null;
        if (!authUrl) throw new Error('Codex 未返回登录链接');
        job.rpcLoginId = rpcId;
        job.state.url = authUrl;
        job.state.status = 'waiting';
      } catch (e) {
        if (job.cancelled || this.disposed) return;
        const msg = e instanceof Error ? e.message : String(e);
        this.terminateJobProc(job);
        void this.finishLogin(job, null, describePort1455Error(msg) ?? (sanitizeLogLine(msg) || '发起 ChatGPT 登录失败'));
      }
    })();
  }

  private terminateJobProc(job: LoginJob): void {
    const proc = job.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      proc.stdin?.end();
    } catch { /* ignore */ }
    if (!job.cancelTimer) {
      job.cancelTimer = setTimeout(() => {
        job.cancelTimer = null;
        killProc(proc);
      }, CANCEL_KILL_GRACE_MS);
      job.cancelTimer.unref?.();
    }
  }

  cancelLogin(loginId: string): void {
    const job = this.login;
    if (!job || job.state.loginId !== loginId) return;
    if (!this.busy()) return;
    job.cancelled = true;
    if (job.method === 'chatgpt' && job.conn && job.rpcLoginId) {
      void job.conn.request('account/login/cancel', { loginId: job.rpcLoginId }, { timeoutMs: 2000 }).catch(() => {});
    }
    this.terminateJobProc(job);
    void this.finishLogin(job, null, '已取消');
  }

  private async finishLogin(job: LoginJob, code: number | null, error: string | null): Promise<void> {
    const st = job.state;
    const isTerminal = (): boolean => st.status === 'done' || st.status === 'failed';
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
      if (job.method === 'deviceAuth') {
        const devErr = describeDeviceAuthError(job.output);
        if (devErr) return fail(devErr);
      }
      if (job.method === 'chatgpt') {
        const portErr = describePort1455Error(job.output);
        if (portErr) return fail(portErr);
      }
      const tail = sanitizeErrorTail(job.output);
      return fail(tail || '登录进程异常退出');
    }
    if (this.disposed) return fail('服务已关闭');

    if (!hasCodexAuthFile(job.loginDir)) {
      return fail('登录没有完成（未生成凭据文件）');
    }

    const meta = readAuthJsonMeta(job.loginDir);
    const hash = computeCodexIdentityHash({
      authMode: meta?.authMode ?? (job.method === 'apiKey' ? 'apiKey' : 'chatgpt'),
      email: meta?.email ?? null,
      accountId: meta?.accountId ?? null,
      apiKeyHash: meta?.apiKeyHash ?? job.apiKeyHash,
    });

    // 判重：检查默认账号 + 全部已添加账号（重登时排除目标自身）
    if (hash) {
      if (job.target !== DEFAULT_ID && this.identityHashOf(DEFAULT_ID) === hash) {
        return fail('这个账号已经添加过了');
      }
      if (this.s.list.some((a) => a.id !== job.target && this.identityHashOf(a.id, a) === hash)) {
        return fail('这个账号已经添加过了');
      }
    }

    if (job.target) {
      const isDefault = job.target === DEFAULT_ID;
      const stored = isDefault ? undefined : this.find(job.target);
      if (!isDefault && !stored) return fail('账号不存在');
      const targetDir = isDefault ? this.baseHomeFn() : stored!.dir;

      this.deps.resetAccount?.(job.target);
      try {
        await replaceAuthJson(job.loginDir, targetDir);
      } catch {
        return fail('更新登录凭据失败，原登录未受影响');
      }
      this.deps.resetAccount?.(job.target);
      await this.discardDir(job.loginDir);
      if (job.cancelled || this.disposed || isTerminal()) return;
      if (stored && hash) stored.identityHash = hash;
      this.cache.delete(job.target);
      this.deps.store.save();
      st.status = 'done';
      st.error = null;
      this.notify();
      const ref = this.accountFor(job.target);
      if (ref) void this.triggerProbe(ref, true);
      return;
    }

    // 添加新账号
    const dir = job.loginDir;
    const id = path.basename(dir);
    if (this.s.list.some((x) => x.id === id || pathKey(x.dir) === pathKey(dir))) {
      return fail('账号目录冲突，请重试');
    }
    const label = job.label || (meta?.email ? '' : this.defaultAccountLabel());
    this.s.list.push({
      id,
      label,
      dir,
      createdAt: this.now(),
      ...(hash ? { identityHash: hash } : {}),
    });
    this.deps.store.save();
    st.accountId = id;
    st.status = 'done';
    st.error = null;
    this.notify();
    const ref = this.accountFor(id);
    if (ref) void this.triggerProbe(ref, true);
  }

  private async discardDir(dir: string): Promise<void> {
    if (this.s.list.some((a) => pathKey(a.dir) === pathKey(dir))) return;
    try {
      await safeRemoveAccountDir(dir, this.accountsRootFn());
    } catch { /* 下次启动超过 1 小时会被清理 */ }
  }

  dispose(): void {
    this.disposed = true;
    if (this.login && this.busy()) {
      const job = this.login;
      job.cancelled = true;
      if (job.cancelTimer) {
        clearTimeout(job.cancelTimer);
        job.cancelTimer = null;
      }
      void this.finishLogin(job, null, '服务已关闭');
      if (job.proc) killProc(job.proc);
    }
  }
}

export { N as CODEX_RPC_NOTIFICATIONS };
