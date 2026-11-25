// 多账号：默认账号 = 基础配置目录（CLAUDE_CONFIG_DIR 或 ~/.claude）；添加的账号各有一个配置目录（~/.claude-accounts/<id>），
// 共享项链接到基础目录（links.ts），MCP 配置三方同步（mcp-sync.ts），私有的只有登录凭据与账号状态。
// 两种模式：
//   切换模式（默认）：同一时间只有一个账号生效。切换 = 停掉所有 claude 进程 → 改当前账号 → 之后启动的进程都用它的配置目录。
//   并行模式：每个会话绑定一个账号（发送时用的账号），进程按会话的账号启动，多个账号同时运行；
//            「当前账号」只决定新会话用哪个账号，切换它不停任何进程。
// 列表只下发显示名 / 套餐 / 是否已登录，绝不下发邮箱、uuid、令牌。
// 账号有两种来源：claude.ai 登录（claude auth login），或 API 账号（API Key + 可选的自定义 Base URL，见 api-config.ts）。
import { type ChildProcess, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AccountDedupeResult, AccountEntry, AccountKiroInfo, AccountList, AccountLogin, AccountMode, ApiAuthType, ApiModelListing } from '@cosyee/shared';
import { nameFromOauth, planLabel, readClaudeJson } from '../account.js';
import { claudeEnv, resolveClaude, spawnSpec } from '../claude/bin.js';
import { accountsRoot, baseClaudeHome, claudeJsonPath, pathKey, setActiveConfigDir } from '../paths.js';
import { ACCOUNT_ID_RE, HttpError, type StateStore, type StoredAccount } from '../workspaces.js';
import { type ApiConfig, apiHost, apiInfo, normalizeApiKey, normalizeBaseUrl, normalizeModelMap, readApiConfig, writeApiConfig } from './api-config.js';
import { ensureLinks, unlinkShared } from './links.js';
import { fetchModelList } from './model-list.js';
import { SNAPSHOT_FILE, syncMcp } from './mcp-sync.js';

export const DEFAULT_ID = 'default';
const LABEL_MAX = 40;
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const OUTPUT_MAX = 16 * 1024;

export interface AccountsDeps {
  store: StateStore;
  /** 正在执行的会话数；传 account 时只数该账号的 */
  running(account?: string): number;
  /** 该账号的 claude 进程数（含空闲的） */
  processes?(account: string): number;
  /** 停止 claude 进程（不传 match = 全部，并清空与账号相关的缓存） */
  stop(match?: (accountId: string | null) => boolean): Promise<void>;
  /**
   * 账号有变化。reset：该账号的身份变了（重新登录 / 移除），重置它的账号信息与额度缓存；
   * notify：通知前端，reload = 整页刷新（切换模式下换了账号），refresh = 重新拉取账号与会话列表。
   */
  onChanged(e: { reset?: string; notify?: 'reload' | 'refresh' }): void;
  /** 测试替换：启动登录进程 */
  spawnLogin?: (env: NodeJS.ProcessEnv) => ChildProcess;
  /** Kiro 账号代理状态查询（供 list() 下发 AccountKiroInfo） */
  kiroProxyState?: (dir: string) => Pick<AccountKiroInfo, 'proxy' | 'error'>;
  /** 移除 Kiro 账号前，把它在内置 kiro.rs 服务里的凭据 / Key / 分组一并删掉（失败只记日志，不阻止移除） */
  removeKiroAccount?: (id: string, dir: string) => Promise<void>;
}

interface LocalInfo {
  name: string | null;
  plan: string | null;
  loggedIn: boolean;
  /** 订阅开始时间（毫秒）；读不到 / 非法值 / API 或未登录为 null */
  subscribedAt: number | null;
  /** 登录凭据失效时间（毫秒）；读不到 / 非法值 / API 或未登录为 null */
  loginExpiresAt: number | null;
  /** 只在服务端用于判重，绝不下发 */
  uuid: string | null;
  /** 邮箱 sha256 哈希，只在服务端用于 uuid 缺失时的兜底判重，绝不下发 */
  emailHash: string | null;
}

/** 重新登录前备份的原凭据，撞车时用于无损恢复 */
interface LoginBackup {
  credsPath: string;
  credsRaw: Buffer | null;
  claudeJsonPath: string;
  claudeJsonExisted: boolean;
  hadOauthAccount: boolean;
  prevOauthAccount: unknown;
}

interface LoginJob {
  state: AccountLogin;
  proc: ChildProcess | null;
  dir: string;
  /** 给已有账号重新登录时是它的 id；添加新账号时为 null */
  target: string | null;
  label: string;
  output: string;
  timer: NodeJS.Timeout | null;
  backup: LoginBackup | null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 邮箱转小写后做 sha256 哈希，仅在内存用于判重，不暴露原文 */
function hashEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const norm = raw.trim().toLowerCase();
  if (!norm) return null;
  return crypto.createHash('sha256').update(norm).digest('hex');
}

/** 判断两个 Claude 本地账号是否为同一个真实账号：优先比对 accountUuid，任一方缺 uuid 时用邮箱哈希兜底 */
function sameClaudeIdentity(a: Pick<LocalInfo, 'uuid' | 'emailHash'>, b: Pick<LocalInfo, 'uuid' | 'emailHash'>): boolean {
  if (a.uuid && b.uuid) return a.uuid === b.uuid;
  if (a.emailHash && b.emailHash) return a.emailHash === b.emailHash;
  return false;
}

/** 原子写回文件（临时文件 + rename） */
function writeFileAtomic(file: string, data: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/** 重新登录前备份原目录的登录凭据（.credentials.json 原文 + .claude.json 的 oauthAccount） */
function captureLoginBackup(dir: string | null): LoginBackup {
  const realDir = dir ?? baseClaudeHome();
  const credsPath = path.join(realDir, '.credentials.json');
  let credsRaw: Buffer | null = null;
  try {
    credsRaw = fs.readFileSync(credsPath);
  } catch { /* 原来没有凭据文件 */ }
  const cJsonPath = claudeJsonPath(dir);
  const claudeJsonExisted = fs.existsSync(cJsonPath);
  const j = readClaudeJson(dir);
  const hadOauthAccount = !!(j && Object.prototype.hasOwnProperty.call(j, 'oauthAccount'));
  const prevOauthAccount = hadOauthAccount ? structuredClone(j!.oauthAccount) : undefined;
  return { credsPath, credsRaw, claudeJsonPath: cJsonPath, claudeJsonExisted, hadOauthAccount, prevOauthAccount };
}

/** 重新登录撞车后恢复原凭据：只还原 .credentials.json 与 .claude.json 的 oauthAccount，不破坏其它配置 */
function restoreLoginBackup(backup: LoginBackup): void {
  if (backup.credsRaw !== null) {
    writeFileAtomic(backup.credsPath, backup.credsRaw, 0o600);
  } else {
    try {
      fs.rmSync(backup.credsPath, { force: true });
    } catch { /* 忽略 */ }
  }
  const cur = readJson(backup.claudeJsonPath);
  if (backup.hadOauthAccount) {
    const next: Record<string, unknown> = cur ? { ...cur } : {};
    next.oauthAccount = backup.prevOauthAccount;
    writeFileAtomic(backup.claudeJsonPath, JSON.stringify(next, null, 2) + '\n');
  } else if (cur) {
    const next: Record<string, unknown> = { ...cur };
    delete next.oauthAccount;
    if (!backup.claudeJsonExisted && Object.keys(next).length === 0) {
      try {
        fs.rmSync(backup.claudeJsonPath, { force: true });
      } catch { /* 忽略 */ }
    } else {
      writeFileAtomic(backup.claudeJsonPath, JSON.stringify(next, null, 2) + '\n');
    }
  }
}

function parseIsoMs(raw: unknown): number | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) && t > 0 ? t : null;
}

function parseEpochMs(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
}

/** 某个配置目录（null = 默认账号）的本地登录信息：只读文件，不起进程。API / Kiro 账号有配置就算已登录 */
export function localInfo(dir: string | null): LocalInfo {
  const api = readApiConfig(dir);
  if (api?.kiro) return { name: 'Kiro', plan: 'Kiro', loggedIn: true, subscribedAt: null, loginExpiresAt: null, uuid: null, emailHash: null };
  if (api) return { name: apiHost(api.baseUrl), plan: 'API', loggedIn: true, subscribedAt: null, loginExpiresAt: null, uuid: null, emailHash: null };
  const j = readClaudeJson(dir);
  const oauth = j?.oauthAccount as Record<string, unknown> | undefined;
  const credsFile = path.join(dir ?? baseClaudeHome(), '.credentials.json');
  const creds = readJson(credsFile);
  const ai = creds?.claudeAiOauth as Record<string, unknown> | undefined;
  let loggedIn: boolean;
  if (creds) loggedIn = !!(ai && (typeof ai.refreshToken === 'string' || typeof ai.accessToken === 'string'));
  // macOS 的凭据在钥匙串里，读不到文件时以账号状态里有没有 oauthAccount 为准
  else loggedIn = process.platform === 'darwin' && !!oauth;
  const rawUuid = typeof oauth?.accountUuid === 'string' ? oauth.accountUuid.trim().toLowerCase() : '';
  const uuid = rawUuid || null;
  const emailHash = hashEmail(oauth?.emailAddress ?? oauth?.email);
  return {
    name: loggedIn || oauth ? nameFromOauth(oauth) : null,
    plan: loggedIn ? (planLabel(ai?.subscriptionType) ?? planLabel(oauth?.organizationType)) : null,
    loggedIn,
    subscribedAt: loggedIn ? parseIsoMs(oauth?.subscriptionCreatedAt) : null,
    loginExpiresAt: loggedIn ? parseEpochMs(ai?.refreshTokenExpiresAt) : null,
    uuid,
    emailHash,
  };
}

/** 去掉 ANSI / OSC 转义序列（CLI 的链接用 OSC 8 包着） */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

/** 从登录命令的输出里找登录页地址 */
export function findLoginUrl(raw: string): string | null {
  const m = /https:\/\/[^\s"'<>\x07\x1b]+\/oauth\/authorize\?[^\s"'<>\x07\x1b]+/.exec(raw);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function newId(): string {
  return crypto.randomBytes(5).toString('hex');
}

function cleanLabel(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, LABEL_MAX) : '';
}

function killTree(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32' && proc.pid) {
    try {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
      return;
    } catch { /* 退回 kill */ }
  }
  try {
    proc.kill();
  } catch { /* 已退出 */ }
}

function defaultSpawnLogin(env: NodeJS.ProcessEnv): ChildProcess {
  const spec = spawnSpec(resolveClaude(), ['auth', 'login', '--claudeai']);
  return spawn(spec.command, spec.args, {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    windowsVerbatimArguments: spec.verbatim,
  });
}

export class Accounts {
  private login: LoginJob | null = null;
  /** 切换串行化 */
  private switching: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AccountsDeps) {}

  private get s() {
    return this.deps.store.state.accounts;
  }

  private find(id: string): StoredAccount | undefined {
    return this.s.list.find((a) => a.id === id);
  }

  /** 账号 id → 配置目录（默认账号为 null）；不存在抛 404 */
  private dirOf(id: string): string | null {
    if (id === DEFAULT_ID) return null;
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    return a.dir;
  }

  /** 当前账号的配置目录（默认账号为 null） */
  activeDir(): string | null {
    const id = this.s.active;
    return id ? (this.find(id)?.dir ?? null) : null;
  }

  activeId(): string {
    return this.s.active ?? DEFAULT_ID;
  }

  mode(): AccountMode {
    return this.s.mode;
  }

  /** 账号是否存在（默认账号或列表里的） */
  has(id: string): boolean {
    return id === DEFAULT_ID || !!this.find(id);
  }

  /** 账号的配置目录（默认账号为 null）；不存在返回 undefined */
  dirFor(id: string): string | null | undefined {
    if (id === DEFAULT_ID) return null;
    return this.find(id)?.dir;
  }

  /**
   * 会话该用哪个账号：并行模式下是会话绑定的账号（账号被移除了就用当前账号），切换模式下总是当前账号。
   * 绑定的账号未登录时不悄悄换成别的账号（进程会报未登录，去重新登录即可）。
   */
  resolve(sessionId: string): { id: string; dir: string | null } {
    if (this.s.mode === 'parallel') {
      const bound = this.s.sessions[sessionId];
      if (bound) {
        const dir = this.dirFor(bound);
        if (dir !== undefined) return { id: bound, dir };
      }
    }
    return { id: this.activeId(), dir: this.activeDir() };
  }

  /** 会话绑定的账号（不存在了返回 null） */
  boundAccount(sessionId: string): string | null {
    const id = this.s.sessions[sessionId];
    return id && this.has(id) ? id : null;
  }

  /** 记下会话最近一次用的账号（两种模式都记，换到并行模式后老会话沿用） */
  bind(sessionId: string, accountId: string): void {
    if (this.s.sessions[sessionId] === accountId || !this.has(accountId)) return;
    this.s.sessions[sessionId] = accountId;
    this.deps.store.save();
  }

  private names: { at: number; map: Map<string, string> } | null = null;

  /** 会话列表里显示的账号名：备注名优先（同一个人的几个账号显示名往往一样），其次显示名；缓存几秒 */
  displayName(id: string): string | null {
    if (!this.names || Date.now() - this.names.at > 5000) {
      const map = new Map<string, string>();
      map.set(DEFAULT_ID, localInfo(null).name ?? 'Claude 账号');
      for (const a of this.s.list) map.set(a.id, a.label || localInfo(a.dir).name || '未登录账号');
      this.names = { at: Date.now(), map };
    }
    return this.names.map.get(id) ?? null;
  }

  /** 服务启动时调用：恢复上次的当前账号（目录没了就回到默认账号），补链接并同步 MCP */
  init(): void {
    let dir = this.activeDir();
    if (dir && !fs.existsSync(dir)) {
      this.s.active = null;
      this.deps.store.save();
      dir = null;
    }
    setActiveConfigDir(dir);
    this.prepare(this.activeId());
  }

  /**
   * 账号没有 claude 进程时调用（启动它的第一个会话进程前）：补链接（有的程序会把链接换成真实文件）并同步 MCP 配置。
   * 默认账号就是主配置，不用做。任何错误都吞掉，不影响启动会话。
   */
  prepare(accountId: string): void {
    const dir = this.dirFor(accountId);
    if (!dir) return;
    try {
      ensureLinks(baseClaudeHome(), dir);
    } catch { /* 下次再补 */ }
    this.sync(dir);
  }

  /** 同步会写主文件：默认账号有进程在跑时（并行模式）跳过，避免与它的 CLI 写入冲突，下次再同步 */
  private sync(dir: string): void {
    if ((this.deps.processes?.(DEFAULT_ID) ?? 0) > 0) return;
    try {
      syncMcp(claudeJsonPath(null), claudeJsonPath(dir), path.join(dir, SNAPSHOT_FILE));
    } catch { /* 下次再同步 */ }
  }

  /** 把所有账号按真实身份分为「列表保留项」与「去重隐藏项」；优先级 当前账号 > 默认账号 > 最早添加 */
  private partition(): { kept: AccountEntry[]; hiddenIds: string[] } {
    const active = this.activeId();
    const def = localInfo(null);
    type Row = {
      idx: number;
      createdAt: number;
      entry: AccountEntry;
      info: LocalInfo;
      apiKeyId: string | null;
    };
    const timeFields = (info: LocalInfo): Pick<AccountEntry, 'subscribedAt' | 'loginExpiresAt'> => ({
      ...(info.subscribedAt !== null ? { subscribedAt: info.subscribedAt } : {}),
      ...(info.loginExpiresAt !== null ? { loginExpiresAt: info.loginExpiresAt } : {}),
    });
    const rows: Row[] = [
      {
        idx: 0,
        createdAt: -1,
        entry: { id: DEFAULT_ID, label: '', name: def.name, plan: def.plan, loggedIn: def.loggedIn, active: active === DEFAULT_ID, isDefault: true, ...timeFields(def) },
        info: def,
        apiKeyId: null,
      },
    ];
    for (let k = 0; k < this.s.list.length; k++) {
      const a = this.s.list[k]!;
      const i = localInfo(a.dir);
      const api = readApiConfig(a.dir);
      const e: AccountEntry = {
        id: a.id,
        label: a.label,
        name: i.name,
        plan: i.plan,
        loggedIn: i.loggedIn,
        active: active === a.id,
        isDefault: false,
        ...(api ? {} : timeFields(i)),
      };
      // Kiro 账号不下发 api，改下发 kiro；普通 API 账号标题用备注名或主机名
      if (api?.kiro) {
        const ps = this.deps.kiroProxyState?.(a.dir) ?? { proxy: 'stopped' as const, error: null };
        Object.assign(e, {
          name: a.label || 'Kiro',
          plan: 'Kiro',
          kiro: { method: api.kiro.method, proxy: ps.proxy, error: ps.error, ...(api.models ? { models: api.models } : {}) },
        });
      } else if (api) {
        Object.assign(e, { name: a.label || i.name, api: apiInfo(api) });
      }
      rows.push({
        idx: k + 1,
        createdAt: a.createdAt,
        entry: e,
        info: i,
        apiKeyId: api && !api.kiro ? `${api.baseUrl}\0${api.apiKey}` : null,
      });
    }

    // 历史重复条目去重显示（不静默删目录）：优先级 当前账号 > 默认账号 > 最早添加
    const rank = (r: Row): number => (r.entry.active ? 0 : r.entry.isDefault ? 1 : 2);
    const ordered = [...rows].sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt || a.idx - b.idx);
    const kept: Row[] = [];
    const hiddenIds: string[] = [];
    for (const r of ordered) {
      const dup = kept.some((k) => {
        if (r.apiKeyId && k.apiKeyId) return r.apiKeyId === k.apiKeyId;
        if (r.apiKeyId || k.apiKeyId) return false;
        return sameClaudeIdentity(r.info, k.info);
      });
      if (dup) hiddenIds.push(r.entry.id);
      else kept.push(r);
    }
    kept.sort((a, b) => a.idx - b.idx);
    return { kept: kept.map((r) => r.entry), hiddenIds };
  }

  list(): AccountList {
    const { kept, hiddenIds } = this.partition();
    return {
      mode: this.s.mode,
      list: kept,
      login: this.login ? { ...this.login.state } : null,
      ...(hiddenIds.length > 0 ? { duplicates: hiddenIds.length } : {}),
    };
  }

  /** 串行执行切换类操作 */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.switching.then(fn);
    this.switching = run.then(() => {}, () => {});
    return run;
  }

  /**
   * 切换当前账号。切换模式下有执行中的会话且没 force 时抛 409（http 层带上 running 数），确认后停掉所有进程；
   * 并行模式下只改新会话用的账号，不停任何进程。目标账号未登录时抛 400（应走重新登录）。
   */
  switchTo(id: string, force: boolean): Promise<void> {
    return this.serial(() => this.doSwitch(id, force));
  }

  private async doSwitch(id: string, force: boolean): Promise<void> {
    const dir = this.dirOf(id);
    if (id === this.activeId()) return;
    if (dir && !fs.existsSync(dir)) throw new HttpError(410, '账号的配置目录不存在了，请移除后重新添加');
    if (!localInfo(dir).loggedIn) throw new HttpError(400, '该账号还没有登录');
    const parallel = this.s.mode === 'parallel';
    if (!parallel) {
      const running = this.deps.running();
      if (running > 0 && !force) throw new RunningError(running);
      await this.deps.stop();
      // 旧账号期间改过的 MCP 配置写回主文件，再切到新账号并拉取
      const old = this.activeDir();
      if (old) this.sync(old);
    }
    this.s.active = id === DEFAULT_ID ? null : id;
    this.deps.store.save();
    setActiveConfigDir(dir);
    if (!parallel) this.prepare(id);
    this.deps.onChanged({ notify: parallel ? 'refresh' : 'reload' });
  }

  /** 切换模式。并行 → 切换：其它账号的进程都要停掉，有执行中的会话且没 force 时抛 409。 */
  setMode(mode: unknown, force: boolean): Promise<void> {
    if (mode !== 'switch' && mode !== 'parallel') return Promise.reject(new HttpError(400, 'mode 不合法'));
    return this.serial(async () => {
      if (mode === this.s.mode) return;
      if (mode === 'parallel') {
        this.s.mode = 'parallel';
        this.deps.store.save();
        this.deps.onChanged({ notify: 'refresh' });
        return;
      }
      const active = this.activeId();
      const others = [DEFAULT_ID, ...this.s.list.map((a) => a.id)].filter((id) => id !== active);
      const running = others.reduce((n, id) => n + this.deps.running(id), 0);
      if (running > 0 && !force) {
        throw new RunningError(running, `其它账号有 ${running} 个会话正在执行，换成切换模式会停止它们`);
      }
      await this.deps.stop((id) => id !== active);
      this.s.mode = 'switch';
      this.deps.store.save();
      // 其它账号这段时间改过的 MCP 配置写回主文件（它们现在都没有进程了）
      for (const a of this.s.list) if (a.id !== active) this.sync(a.dir);
      this.deps.onChanged({ notify: 'reload' });
    });
  }

  setLabel(id: string, label: unknown): void {
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    a.label = cleanLabel(label);
    this.deps.store.save();
    this.names = null;
  }

  /** 是否 API 账号（含 Kiro 账号：没有 Claude 订阅额度，也不需要 claude.ai 登录） */
  isApi(id: string): boolean {
    return !!readApiConfig(this.dirFor(id));
  }

  /** 是否 Kiro 账号 */
  isKiro(id: string): boolean {
    return !!readApiConfig(this.dirFor(id))?.kiro;
  }

  /** 全部 Kiro 账号列表（供 KiroService 管理代理和总状态） */
  listKiroAccounts(): Array<{ id: string; dir: string; label: string }> {
    const out: Array<{ id: string; dir: string; label: string }> = [];
    for (const a of this.s.list) {
      if (readApiConfig(a.dir)?.kiro) out.push({ id: a.id, dir: a.dir, label: a.label || 'Kiro' });
    }
    return out;
  }

  /** 为新 Kiro 账号分配并准备目录（建共享链接与 MCP 同步） */
  allocateKiroDir(): { id: string; dir: string } {
    let id = newId();
    while (this.find(id) || fs.existsSync(path.join(accountsRoot(), id))) id = newId();
    const dir = path.join(accountsRoot(), id);
    if (ensureLinks(baseClaudeHome(), dir).includes('projects')) {
      this.discardDir(dir);
      throw new HttpError(500, '无法在账号目录里创建共享链接');
    }
    this.sync(dir);
    return { id, dir };
  }

  /** 校验并返回已有 Kiro 账号的目录 */
  existingKiroDir(id: string): string {
    if (id === DEFAULT_ID) throw new HttpError(400, '默认账号不是 Kiro 账号');
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    if (!readApiConfig(a.dir)?.kiro) throw new HttpError(400, '该账号不是 Kiro 账号');
    return a.dir;
  }

  /** 停止单个账号的空闲 claude 进程（供 Kiro 重新登录前调用） */
  async stopAccountProcesses(id: string): Promise<void> {
    if ((this.deps.processes?.(id) ?? 0) > 0) await this.deps.stop((x) => x === id);
  }

  /** Kiro 新账号登录成功后登记 */
  commitNewKiro(id: string, dir: string, label: string): void {
    this.s.list.push({ id, label: cleanLabel(label), dir, createdAt: Date.now() });
    this.deps.store.save();
    this.names = null;
    this.deps.onChanged({ notify: 'refresh' });
  }

  /** Kiro 重新登录成功后更新备注并重置缓存 */
  commitReloginKiro(id: string, label?: string): void {
    const a = this.find(id);
    if (a && label !== undefined) {
      a.label = cleanLabel(label);
      this.deps.store.save();
    }
    this.names = null;
    this.deps.onChanged({ reset: id, notify: 'refresh' });
  }

  /** Kiro 模型映射重新拉取后变了：作废该账号的模型缓存并通知前端刷新 */
  kiroModelsChanged(id: string): void {
    this.deps.onChanged({ reset: id, notify: 'refresh' });
  }

  /** Kiro 登录失败时清理未登记的新目录 */
  discardKiroDir(dir: string): void {
    this.discardDir(dir);
  }

  /**
   * 拉取服务商的模型列表（映射表的下拉用）。密钥由服务端带上：
   * 传了 apiKey 就用它（添加账号时还没存盘），否则用该账号已存的密钥。
   */
  async modelList(opts: { id?: unknown; baseUrl?: unknown; apiKey?: unknown; authType?: unknown }): Promise<ApiModelListing> {
    const baseUrl = normalizeBaseUrl(opts.baseUrl);
    if (baseUrl === null) throw new HttpError(400, 'Base URL 不合法：需要以 http:// 或 https:// 开头，不能带查询参数');
    const given = typeof opts.apiKey === 'string' && opts.apiKey.trim() !== '' ? normalizeApiKey(opts.apiKey) : null;
    let apiKey = given;
    let authType: ApiAuthType = opts.authType === 'authToken' ? 'authToken' : 'apiKey';
    if (!apiKey) {
      if (typeof opts.id !== 'string') throw new HttpError(400, '请填写 API Key');
      const cfg = readApiConfig(this.dirFor(opts.id));
      if (!cfg) throw new HttpError(400, '该账号不是 API 账号');
      apiKey = cfg.apiKey;
      if (opts.authType === undefined) authType = cfg.authType;
    }
    try {
      return await fetchModelList({ baseUrl, apiKey, authType });
    } catch (e) {
      throw new HttpError(502, `拉取模型列表失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 添加（不传 id）或修改 API 账号。baseUrl 空 = 官方地址；修改时 apiKey 留空 = 沿用原来的。
   * 修改时该账号有执行中的会话就拒绝；空闲的进程先停掉（它们的环境变量还是旧配置），下次启动用新配置。
   */
  saveApi(opts: { id?: unknown; label?: unknown; baseUrl?: unknown; apiKey?: unknown; authType?: unknown; models?: unknown }): Promise<string> {
    return this.serial(async () => {
      const baseUrl = normalizeBaseUrl(opts.baseUrl);
      if (baseUrl === null) throw new HttpError(400, 'Base URL 不合法：需要以 http:// 或 https:// 开头，不能带查询参数');
      const authType = opts.authType === 'authToken' ? 'authToken' : 'apiKey';
      const keyGiven = typeof opts.apiKey === 'string' && opts.apiKey.trim() !== '';
      const apiKey = keyGiven ? normalizeApiKey(opts.apiKey) : null;
      if (keyGiven && !apiKey) throw new HttpError(400, 'API Key 不合法（不能含空格或非 ASCII 字符）');
      // 没传 models = 沿用原来的（改 Key 时前端可以不带映射）；传了就整体替换
      const models = opts.models === undefined ? undefined : normalizeModelMap(opts.models);

      if (opts.id !== undefined && opts.id !== null) {
        if (typeof opts.id !== 'string') throw new HttpError(400, 'id 不合法');
        if (opts.id === DEFAULT_ID) throw new HttpError(400, '默认账号不能改成 API 账号');
        const a = this.find(opts.id);
        if (!a) throw new HttpError(404, '账号不存在');
        const old = readApiConfig(a.dir);
        if (!old) throw new HttpError(400, '该账号不是 API 账号');
        if (old.kiro) throw new HttpError(400, 'Kiro 账号不能通过 API 账号接口修改');
        const running = this.deps.running(a.id);
        if (running > 0) throw new HttpError(409, `该账号有 ${running} 个会话正在执行，请等它们结束后再修改`);
        const nextKey = apiKey ?? old.apiKey;
        const dupOther = this.s.list.some((x) => {
          if (x.id === a.id) return false;
          const c = readApiConfig(x.dir);
          return !!c && c.apiKey === nextKey && c.baseUrl === baseUrl;
        });
        if (dupOther) throw new HttpError(409, '这个 Base URL 和 API Key 已经添加过了');
        if ((this.deps.processes?.(a.id) ?? 0) > 0) await this.deps.stop((x) => x === a.id);
        const keep = opts.models === undefined ? old.models : models;
        writeApiConfig(a.dir, { baseUrl, authType, apiKey: nextKey, ...(keep ? { models: keep } : {}) });
        if (opts.label !== undefined) a.label = cleanLabel(opts.label);
        this.deps.store.save();
        this.names = null;
        this.deps.onChanged({ reset: a.id, notify: 'refresh' });
        return a.id;
      }

      if (!apiKey) throw new HttpError(400, '请填写 API Key');
      const dup = this.s.list.some((a) => {
        const c = readApiConfig(a.dir);
        return !!c && c.apiKey === apiKey && c.baseUrl === baseUrl;
      });
      if (dup) throw new HttpError(409, '这个 Base URL 和 API Key 已经添加过了');
      let id = newId();
      while (this.find(id) || fs.existsSync(path.join(accountsRoot(), id))) id = newId();
      const dir = path.join(accountsRoot(), id);
      const cfg: ApiConfig = { baseUrl, apiKey, authType, ...(models ? { models } : {}) };
      try {
        if (ensureLinks(baseClaudeHome(), dir).includes('projects')) throw new Error('无法在账号目录里创建共享链接');
        writeApiConfig(dir, cfg);
      } catch (e) {
        this.discardDir(dir);
        throw new HttpError(500, e instanceof Error ? e.message : String(e));
      }
      this.sync(dir);
      this.s.list.push({ id, label: cleanLabel(opts.label), dir, createdAt: Date.now() });
      this.deps.store.save();
      this.names = null;
      return id;
    });
  }

  /** 实际移除单个账号（需在 serial 内调用；不落盘、不发通知） */
  private async removeOne(id: string): Promise<void> {
    if (id === DEFAULT_ID) throw new HttpError(400, '默认账号不能移除');
    const a = this.find(id);
    if (!a) throw new HttpError(404, '账号不存在');
    if (id === this.activeId()) throw new HttpError(409, '不能移除当前账号，请先切换到其它账号');
    if (this.login && this.login.target === id && this.busy()) throw new HttpError(409, '该账号正在登录');
    const running = this.deps.running(id);
    if (running > 0) throw new HttpError(409, `该账号有 ${running} 个会话正在执行，请等它们结束后再移除`);
    if ((this.deps.processes?.(id) ?? 0) > 0) await this.deps.stop((x) => x === id);
    if (readApiConfig(a.dir)?.kiro) await this.deps.removeKiroAccount?.(id, a.dir);
    this.removeDir(a.dir);
    this.s.list = this.s.list.filter((x) => x.id !== id);
    for (const [sid, acc] of Object.entries(this.s.sessions)) if (acc === id) delete this.s.sessions[sid];
  }

  /**
   * 移除添加的账号：先解除共享链接，再删配置目录（只删 accountsRoot 下的目录）。
   * 并行模式下该账号有执行中的会话时不能移除，空闲的进程先停掉；绑定它的会话之后改用当前账号。
   */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      await this.removeOne(id);
      this.deps.store.save();
      this.names = null;
      this.deps.onChanged({ reset: id, notify: 'refresh' });
    });
  }

  /**
   * 清理 list() 去重时隐藏的重复账号条目：按与 remove() 相同的规则逐条移除，
   * 默认账号 / 当前账号 / 正在登录 / 有执行中会话等不可删的跳过并计入 skipped，不抛错。
   */
  dedupe(): Promise<AccountDedupeResult> {
    return this.serial(async () => {
      const { hiddenIds } = this.partition();
      const removedIds: string[] = [];
      let skipped = 0;
      for (const id of hiddenIds) {
        try {
          await this.removeOne(id);
          removedIds.push(id);
        } catch {
          skipped++;
        }
      }
      if (removedIds.length > 0) {
        this.deps.store.save();
        this.names = null;
        for (let i = 0; i < removedIds.length; i++) {
          this.deps.onChanged({ reset: removedIds[i]!, ...(i === removedIds.length - 1 ? { notify: 'refresh' } : {}) });
        }
      }
      return { removed: removedIds.length, skipped };
    });
  }

  private removeDir(dir: string): void {
    const root = path.resolve(accountsRoot());
    const abs = path.resolve(dir);
    const rel = path.relative(root, abs);
    // 不在 accountsRoot 下的目录（不是 Cosyee 建的）只从列表移除，不删文件
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return;
    if (pathKey(abs) === pathKey(baseClaudeHome())) return;
    if (!fs.existsSync(abs)) return;
    const left = unlinkShared(abs);
    if (left.length) throw new HttpError(500, `解除共享链接失败：${left.join(', ')}`);
    fs.rmSync(abs, { recursive: true, force: true });
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

  /** 添加账号（target 不传）或给已有账号重新登录：后台跑 claude auth login，CLI 会自己打开浏览器 */
  startLogin(opts: { label?: unknown; accountId?: unknown }): AccountLogin {
    if (this.busy()) throw new HttpError(409, '已有一个登录正在进行');
    let target: string | null = null;
    let dir: string;
    if (opts.accountId !== undefined && opts.accountId !== null) {
      if (typeof opts.accountId !== 'string') throw new HttpError(400, 'accountId 不合法');
      target = opts.accountId;
      const d = this.dirOf(target);
      const existingApi = readApiConfig(d);
      if (existingApi?.kiro) throw new HttpError(400, 'Kiro 账号请通过 Kiro 登录');
      if (existingApi) throw new HttpError(400, 'API 账号不需要登录，请直接修改它的 API Key');
      dir = d ?? baseClaudeHome();
    } else {
      let id = newId();
      while (this.find(id) || fs.existsSync(path.join(accountsRoot(), id))) id = newId();
      dir = path.join(accountsRoot(), id);
    }
    if (target !== DEFAULT_ID) {
      const failed = ensureLinks(baseClaudeHome(), dir);
      if (failed.includes('projects')) throw new HttpError(500, '无法在账号目录里创建共享链接');
      // 新目录先拉一份 MCP 配置（不影响登录）
      this.sync(dir);
    }

    const backup = target ? captureLoginBackup(target === DEFAULT_ID ? null : dir) : null;
    const state: AccountLogin = { loginId: newId(), status: 'starting', url: null, accountId: target, error: null };
    const job: LoginJob = { state, proc: null, dir, target, label: cleanLabel(opts.label), output: '', timer: null, backup };
    const env = claudeEnv(target === DEFAULT_ID ? null : dir);
    let proc: ChildProcess;
    try {
      proc = (this.deps.spawnLogin ?? defaultSpawnLogin)(env);
    } catch (e) {
      if (!target) this.discardDir(dir);
      throw new HttpError(500, `无法启动 claude：${e instanceof Error ? e.message : String(e)}`);
    }
    job.proc = proc;
    this.login = job;
    const onData = (d: Buffer) => {
      if (job.output.length < OUTPUT_MAX) job.output += d.toString('utf8');
      if (!state.url) {
        const url = findLoginUrl(stripAnsi(job.output)) ?? findLoginUrl(job.output);
        if (url) {
          state.url = url;
          state.status = 'waiting';
        }
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.stdin?.on('error', () => {});
    proc.on('error', (e) => this.finishLogin(job, null, e.message));
    proc.on('close', (code) => this.finishLogin(job, code, null));
    job.timer = setTimeout(() => {
      if (job.proc) killTree(job.proc);
      this.finishLogin(job, null, '登录超时');
    }, LOGIN_TIMEOUT_MS);
    job.timer.unref?.();
    return { ...state };
  }

  /** 把浏览器页面上显示的授权码交给 CLI */
  submitCode(loginId: string, code: unknown): void {
    const job = this.login;
    if (!job || job.state.loginId !== loginId || !this.busy()) throw new HttpError(404, '登录已结束或不存在');
    const c = typeof code === 'string' ? code.trim() : '';
    if (!c || c.length > 2000 || /[\r\n\x00-\x1f]/.test(c)) throw new HttpError(400, '授权码不合法');
    const stdin = job.proc?.stdin;
    if (!stdin || stdin.destroyed) throw new HttpError(409, '登录进程已退出');
    stdin.write(c + '\n');
  }

  cancelLogin(loginId: string): void {
    const job = this.login;
    if (!job || job.state.loginId !== loginId) return;
    if (this.busy()) {
      if (job.proc) killTree(job.proc);
      this.finishLogin(job, null, '已取消');
    }
  }

  private finishLogin(job: LoginJob, code: number | null, error: string | null): void {
    const st = job.state;
    if (st.status === 'done' || st.status === 'failed') return;
    if (job.timer) clearTimeout(job.timer);
    job.timer = null;
    const fail = (msg: string) => {
      st.status = 'failed';
      st.error = msg;
      if (job.target) return;
      // 进程还没退出（取消 / 超时）时等它退出再删，Windows 上文件可能还被占用
      const p = job.proc;
      if (p && p.exitCode === null && p.signalCode === null) p.once('close', () => this.discardDir(job.dir));
      else this.discardDir(job.dir);
    };
    if (error !== null || code !== 0) {
      const tail = stripAnsi(job.output).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      return fail(error ?? (tail ? `登录失败：${tail.slice(0, 200)}` : '登录失败'));
    }
    const isDefault = job.target === DEFAULT_ID;
    const info = localInfo(isDefault ? null : job.dir);
    if (!info.loggedIn) return fail('登录没有完成');
    // 同一个账号不重复添加（优先 accountUuid，缺失时用邮箱哈希兜底）
    if (info.uuid || info.emailHash) {
      const others: (string | null)[] = [];
      if (!isDefault) others.push(null);
      for (const a of this.s.list) if (a.id !== job.target) others.push(a.dir);
      if (others.some((d) => sameClaudeIdentity(localInfo(d), info))) {
        if (!job.target) return fail('该账号已经添加过了');
        // 重新登录成了另一个已存在的账号：拒绝并回滚恢复原凭据，不产生重复条目也不丢原账号
        if (job.backup) {
          try {
            restoreLoginBackup(job.backup);
          } catch {
            return fail('该账号已经添加过了，恢复原登录状态失败');
          }
        }
        return fail('该账号已经添加过了，已恢复原登录状态');
      }
    }
    if (!job.target) {
      const id = path.basename(job.dir);
      this.s.list.push({ id, label: job.label, dir: job.dir, createdAt: Date.now() });
      this.deps.store.save();
      st.accountId = id;
    }
    st.status = 'done';
    this.names = null;
    // 账号目录此时可能有进程在跑（并行模式下重新登录），只在没有进程时同步
    if (!isDefault && !(job.target && (this.deps.processes?.(job.target) ?? 0) > 0)) this.sync(job.dir);
    // 重新登录：凭据变了，该账号的信息与额度要重取
    if (job.target) this.deps.onChanged({ reset: job.target });
  }

  /** 丢弃没登录成功的新账号目录（只删 accountsRoot 下、未登记的目录） */
  private discardDir(dir: string): void {
    if (this.s.list.some((a) => pathKey(a.dir) === pathKey(dir))) return;
    try {
      this.removeDir(dir);
    } catch { /* 留着也无害 */ }
  }

  /** 服务关闭时：结束进行中的登录 */
  dispose(): void {
    if (this.login && this.busy()) {
      if (this.login.proc) killTree(this.login.proc);
      this.finishLogin(this.login, null, '服务已关闭');
    }
  }
}

/** 有执行中的会话、需要确认才能切换 */
export class RunningError extends HttpError {
  constructor(public running: number, message?: string) {
    super(409, message ?? `有 ${running} 个会话正在执行，切换账号会停止它们`);
  }
}
