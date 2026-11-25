// Kiro 服务总入口：组合 KiroEngine、KiroProxyManager（内置 kiro.rs 单实例）、KiroAccountAdmin、KiroLogin，对接 HTTP 路由与 server.ts 生命周期。
// kiro.rs 装好且没被手动停止时随 cosyee 启动，退出时一起停。
import path from 'node:path';
import type { AccountKiroInfo, AccountLogin, ComponentService, KiroBalance, KiroCredentialState, KiroServiceStatus, KiroStatus } from '@cosyee/shared';
import { isLegacyKiro, readApiConfig } from '../accounts/api-config.js';
import { RunningError } from '../accounts/index.js';
import { cosyeeHome } from '../paths.js';
import { HttpError } from '../workspaces.js';
import { KiroEngine, type KiroEngineOptions } from './engine.js';
import { KiroLogin, type KiroAccountHooks, type KiroLoginOptions, type StartKiroLoginOpts } from './login.js';
import { KiroProxyManager, type KiroProxyOptions } from './proxy.js';
import { KIRO_ENGINE_MISSING } from './sanitize.js';
import { KiroAccountAdmin, type KiroAccountAdminOptions } from './service-admin.js';

export interface KiroServiceAccounts extends KiroAccountHooks {
  /** 全部 Kiro 账号的 { id, dir, label } 列表 */
  listKiroAccounts(): Array<{ id: string; dir: string; label: string }>;
  /** 账号的模型映射被后台刷新后调用（让该账号的会话重置） */
  modelsChanged?(accountId: string): void;
  /** 账号显示用的信息（邮箱）变了后调用（刷新列表） */
  infoChanged?(accountId: string): void;
}

export interface KiroServiceOptions {
  accounts: KiroServiceAccounts;
  engine?: Omit<KiroEngineOptions, 'hasKiroAccounts' | 'onUpgraded'>;
  proxy?: Omit<KiroProxyOptions, 'engine' | 'dataDir' | 'listKiroAccounts'>;
  admin?: Omit<KiroAccountAdminOptions, 'onModelsChanged' | 'onInfoChanged'>;
  login?: Omit<KiroLoginOptions, 'engine' | 'admin' | 'accounts'>;
  /** 凭据状态缓存多久后重新读（ms），默认 30 秒 */
  credentialsTtlMs?: number;
}

export class KiroService {
  readonly engine: KiroEngine;
  readonly proxy: KiroProxyManager;
  readonly admin: KiroAccountAdmin;
  readonly login: KiroLogin;
  private readonly accounts: KiroServiceAccounts;
  /** 各账号凭据状态（来自 GET /api/admin/credentials），key = 账号 id */
  private creds = new Map<string, { credential: KiroCredentialState; reason: string | null }>();
  private credsAt = 0;
  private credsLoading: Promise<void> | null = null;
  private readonly credsTtlMs: number;

  constructor(opts: KiroServiceOptions) {
    this.accounts = opts.accounts;
    this.credsTtlMs = opts.credentialsTtlMs ?? 30_000;
    this.engine = new KiroEngine({
      ...opts.engine,
      hasKiroAccounts: () => this.accounts.listKiroAccounts().length > 0,
      onUpgraded: () => {
        // 没有执行中的 Kiro 会话就用新引擎重启服务；首次装好（还没在跑）就直接启动
        if (this.proxy.isRunning()) void this.proxy.restartIdle(() => this.busySessionCount() > 0).catch(() => undefined);
        else this.autoStart();
      },
    });
    const rootDir = () => (opts.engine?.rootDir ? opts.engine.rootDir() : path.join(cosyeeHome(), 'kiro-rs'));
    this.proxy = new KiroProxyManager({
      ...opts.proxy,
      engine: this.engine,
      dataDir: () => path.join(rootDir(), 'service'),
      listKiroAccounts: () => this.accounts.listKiroAccounts(),
    });
    this.admin = new KiroAccountAdmin(this.proxy, {
      ...opts.admin,
      onModelsChanged: (id) => this.accounts.modelsChanged?.(id),
      onInfoChanged: (id) => this.accounts.infoChanged?.(id),
    });
    this.login = new KiroLogin({
      ...opts.login,
      engine: this.engine,
      admin: this.admin,
      accounts: this.accounts,
    });
  }

  /** 服务启动时调用：没装 kiro.rs 但有 Kiro 账号时后台下载；装了且没被手动停止就启动服务 */
  init(): void {
    this.engine.maybeAutoInstall();
    this.autoStart();
  }

  private autoStart(): void {
    if (!this.engine.isEnabled() || !this.engine.binaryPath()) return;
    void this.proxy.start().then(() => this.loadCredentials(), () => undefined);
  }

  serviceStatus(): KiroServiceStatus {
    const list = this.accounts.listKiroAccounts();
    const svc = this.proxy.serviceState();
    return {
      enabled: this.engine.isEnabled(),
      accounts: list.length,
      running: svc.proxy === 'starting' || svc.proxy === 'ready' ? 1 : 0,
      failed: svc.proxy === 'failed' ? 1 : 0,
      busySessions: this.busySessionCount(),
      outdated: this.proxy.isOutdated() ? 1 : 0,
      usable: this.usableCount(list),
    };
  }

  /** 组件列表里 kiro.rs 一行的服务状态 */
  componentService(): ComponentService {
    const list = this.accounts.listKiroAccounts();
    const svc = this.proxy.serviceState();
    return {
      state: svc.proxy,
      error: svc.error,
      enabled: this.engine.isEnabled(),
      outdated: this.proxy.isOutdated(),
      port: this.proxy.port(),
      accounts: { total: list.length, usable: this.usableCount(list) },
    };
  }

  private usableCount(list: Array<{ id: string; dir: string }>): number {
    return list.filter((a) => this.accountState(a.id, a.dir).credential === 'ok').length;
  }

  /** 账号在列表里显示的服务与凭据状态；缓存过期时后台重读，变了再通知刷新列表 */
  accountState(accountId: string, dir: string): Pick<AccountKiroInfo, 'proxy' | 'error' | 'credential' | 'credentialReason'> {
    const svc = this.proxy.serviceState();
    const base = { proxy: svc.proxy, error: svc.error };
    if (svc.proxy !== 'ready') return { ...base, credential: 'unknown' };
    if (Date.now() - this.credsAt > this.credsTtlMs) void this.loadCredentials();
    const api = readApiConfig(dir);
    if (!api?.kiro || isLegacyKiro(api.kiro)) return { ...base, credential: 'missing' };
    const c = this.creds.get(accountId);
    if (!c) {
      // 新加的账号还没读到：补读一次
      void this.loadCredentials();
      return { ...base, credential: 'unknown' };
    }
    return { ...base, credential: c.credential, ...(c.reason ? { credentialReason: c.reason } : {}) };
  }

  /** 从 kiro.rs 读全部凭据，按账号的 credentialId（或分组）对上账号；有变化就通知刷新 */
  loadCredentials(): Promise<void> {
    if (this.credsLoading) return this.credsLoading;
    this.credsAt = Date.now();
    const p = (async () => {
      const list = await this.admin.listCredentials();
      const next = new Map<string, { credential: KiroCredentialState; reason: string | null }>();
      for (const a of this.accounts.listKiroAccounts()) {
        const api = readApiConfig(a.dir);
        if (!api?.kiro || isLegacyKiro(api.kiro)) continue;
        const credId = api.kiro.credentialId;
        const c = list.find((x) => x.id === credId) ?? list.find((x) => Array.isArray(x.groups) && x.groups.includes(a.id));
        if (!c) next.set(a.id, { credential: 'missing', reason: null });
        else if (c.disabled === true) {
          const reason = typeof c.disabledReason === 'string' ? c.disabledReason : null;
          next.set(a.id, { credential: reason === 'QuotaExceeded' ? 'quota' : 'disabled', reason });
        } else next.set(a.id, { credential: 'ok', reason: null });
      }
      const changed = next.size !== this.creds.size
        || [...next].some(([id, v]) => {
          const o = this.creds.get(id);
          return !o || o.credential !== v.credential || o.reason !== v.reason;
        });
      this.creds = next;
      if (changed) this.accounts.infoChanged?.('');
    })()
      .catch(() => undefined)
      .finally(() => {
        if (this.credsLoading === p) this.credsLoading = null;
      });
    this.credsLoading = p;
    return p;
  }

  status(): KiroStatus {
    return {
      service: this.serviceStatus(),
      imports: this.login.importsStatus(),
      login: this.login.currentLogin(),
    };
  }

  /** 打开总开关并启动服务（等就绪；失败抛错，原因也记在服务状态里） */
  async startService(): Promise<void> {
    if (!this.engine.binaryPath()) throw new HttpError(409, KIRO_ENGINE_MISSING);
    this.engine.setEnabled(true);
    await this.proxy.start({ force: true });
    await this.loadCredentials();
  }

  private checkBusy(force: boolean, what: string): void {
    const busy = this.busySessionCount();
    if (busy > 0 && !force) throw new RunningError(busy, `有 ${busy} 个 Kiro 会话正在执行，${what}会中断它们`);
  }

  /** 关闭总开关（持久化）并停止服务；有执行中的 Kiro 会话且没带 force 时抛 RunningError(409) */
  async stopService(force: boolean): Promise<void> {
    this.checkBusy(force, '停止服务');
    this.engine.setEnabled(false);
    await this.proxy.stop();
  }

  /** 用当前引擎重启服务；有执行中的 Kiro 会话且没带 force 时抛 RunningError(409) */
  async restartService(force: boolean): Promise<void> {
    if (!this.engine.binaryPath()) throw new HttpError(409, KIRO_ENGINE_MISSING);
    this.checkBusy(force, '重启服务');
    this.engine.setEnabled(true);
    await this.proxy.stop();
    await this.proxy.start({ force: true });
    await this.loadCredentials();
  }

  startLogin(opts: StartKiroLoginOpts): AccountLogin {
    return this.login.startLogin(opts);
  }

  getLogin(loginId: string): AccountLogin {
    return this.login.getLogin(loginId);
  }

  cancelLogin(loginId: string): void {
    this.login.cancelLogin(loginId);
  }

  async balance(accountId: string): Promise<KiroBalance> {
    return this.admin.balance(this.accounts.existingKiroDir(accountId), accountId);
  }

  /** 内置 kiro.rs 服务的管理页面地址与密钥（按需启动服务并等就绪）；全部账号共用一个管理页面 */
  adminAccess(): Promise<{ url: string; key: string }> {
    return this.proxy.adminEndpoint();
  }

  /** 重新拉取账号的模型列表并写回映射（失败保留旧映射）；映射变化时通知账号重置 */
  async refreshModels(accountId: string): Promise<boolean> {
    return this.admin.refreshModels(accountId, this.accounts.existingKiroDir(accountId));
  }

  /** 移除账号时清理服务里的凭据、Key 与分组（服务起不来只记日志，不阻止移除） */
  removeAccount(accountId: string, dir: string): Promise<void> {
    return this.admin.removeAccount(accountId, dir);
  }

  private busySessionCount(): number {
    return this.accounts.listKiroAccounts().reduce((n, a) => n + this.accounts.running(a.id), 0);
  }

  /** 优雅关闭：中止编译 / 登录、停止全部代理 */
  async dispose(): Promise<void> {
    this.engine.dispose();
    this.login.dispose();
    await this.proxy.stop();
  }

  /** 进程 exit 钩子里的同步强杀 */
  disposeSync(): void {
    this.engine.dispose();
    this.login.dispose();
    this.proxy.killSync();
  }
}

export { KiroAccountAdmin, KiroEngine, KiroLogin, KiroProxyManager };
export { KIRO_ENGINE_MISSING, KIRO_SERVICE_STOPPED } from './sanitize.js';
