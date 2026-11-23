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
import type { AccountEntry, AccountList, AccountLogin, AccountMode, ApiAuthType, ApiModelListing } from '@cosyee/shared';
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
}

interface LocalInfo {
  name: string | null;
  plan: string | null;
  loggedIn: boolean;
  /** 只在服务端用于判重，绝不下发 */
  uuid: string | null;
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
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** 某个配置目录（null = 默认账号）的本地登录信息：只读文件，不起进程。API 账号有密钥就算已登录，名字是主机名 */
export function localInfo(dir: string | null): LocalInfo {
  const api = readApiConfig(dir);
  if (api) return { name: apiHost(api.baseUrl), plan: 'API', loggedIn: true, uuid: null };
  const j = readClaudeJson(dir);
  const oauth = j?.oauthAccount as Record<string, unknown> | undefined;
  const credsFile = path.join(dir ?? baseClaudeHome(), '.credentials.json');
  const creds = readJson(credsFile);
  const ai = creds?.claudeAiOauth as Record<string, unknown> | undefined;
  let loggedIn: boolean;
  if (creds) loggedIn = !!(ai && (typeof ai.refreshToken === 'string' || typeof ai.accessToken === 'string'));
  // macOS 的凭据在钥匙串里，读不到文件时以账号状态里有没有 oauthAccount 为准
  else loggedIn = process.platform === 'darwin' && !!oauth;
  const uuid = typeof oauth?.accountUuid === 'string' ? oauth.accountUuid : null;
  return {
    name: loggedIn || oauth ? nameFromOauth(oauth) : null,
    plan: loggedIn ? (planLabel(ai?.subscriptionType) ?? planLabel(oauth?.organizationType)) : null,
    loggedIn,
    uuid,
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

  list(): AccountList {
    const active = this.activeId();
    const def = localInfo(null);
    const out: AccountEntry[] = [
      { id: DEFAULT_ID, label: '', name: def.name, plan: def.plan, loggedIn: def.loggedIn, active: active === DEFAULT_ID, isDefault: true },
    ];
    for (const a of this.s.list) {
      const i = localInfo(a.dir);
      const e: AccountEntry = { id: a.id, label: a.label, name: i.name, plan: i.plan, loggedIn: i.loggedIn, active: active === a.id, isDefault: false };
      const api = readApiConfig(a.dir);
      // API 账号没有登录名：标题用备注名，没有备注名用主机名
      if (api) Object.assign(e, { name: a.label || i.name, api: apiInfo(api) });
      out.push(e);
    }
    return { mode: this.s.mode, list: out, login: this.login ? { ...this.login.state } : null };
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

  /** 是否 API 账号（没有订阅额度，也不需要 claude.ai 登录） */
  isApi(id: string): boolean {
    return !!readApiConfig(this.dirFor(id));
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
        const running = this.deps.running(a.id);
        if (running > 0) throw new HttpError(409, `该账号有 ${running} 个会话正在执行，请等它们结束后再修改`);
        if ((this.deps.processes?.(a.id) ?? 0) > 0) await this.deps.stop((x) => x === a.id);
        const keep = opts.models === undefined ? old.models : models;
        writeApiConfig(a.dir, { baseUrl, authType, apiKey: apiKey ?? old.apiKey, ...(keep ? { models: keep } : {}) });
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

  /**
   * 移除添加的账号：先解除共享链接，再删配置目录（只删 accountsRoot 下的目录）。
   * 并行模式下该账号有执行中的会话时不能移除，空闲的进程先停掉；绑定它的会话之后改用当前账号。
   */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (id === DEFAULT_ID) throw new HttpError(400, '默认账号不能移除');
      const a = this.find(id);
      if (!a) throw new HttpError(404, '账号不存在');
      if (id === this.activeId()) throw new HttpError(409, '不能移除当前账号，请先切换到其它账号');
      if (this.login && this.login.target === id && this.busy()) throw new HttpError(409, '该账号正在登录');
      const running = this.deps.running(id);
      if (running > 0) throw new HttpError(409, `该账号有 ${running} 个会话正在执行，请等它们结束后再移除`);
      if ((this.deps.processes?.(id) ?? 0) > 0) await this.deps.stop((x) => x === id);
      this.removeDir(a.dir);
      this.s.list = this.s.list.filter((x) => x.id !== id);
      for (const [sid, acc] of Object.entries(this.s.sessions)) if (acc === id) delete this.s.sessions[sid];
      this.deps.store.save();
      this.names = null;
      this.deps.onChanged({ reset: id, notify: 'refresh' });
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
      if (readApiConfig(d)) throw new HttpError(400, 'API 账号不需要登录，请直接修改它的 API Key');
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

    const state: AccountLogin = { loginId: newId(), status: 'starting', url: null, accountId: target, error: null };
    const job: LoginJob = { state, proc: null, dir, target, label: cleanLabel(opts.label), output: '', timer: null };
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
    // 同一个账号不重复添加
    if (info.uuid) {
      const others: (string | null)[] = [];
      if (!isDefault) others.push(null);
      for (const a of this.s.list) if (a.id !== job.target) others.push(a.dir);
      if (others.some((d) => localInfo(d).uuid === info.uuid)) {
        if (!job.target) return fail('该账号已经添加过了');
        // 重新登录成了另一个已存在的账号：凭据已经写进这个目录，只能提示
        st.error = '注意：登录的是另一个已添加的账号';
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
