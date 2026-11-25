// Kiro 服务总入口：组合 KiroEngine、KiroProxyManager（内置 kiro.rs 单实例）、KiroAccountAdmin、KiroLogin，对接 HTTP 路由与 server.ts 生命周期。
import path from 'node:path';
import type { AccountLogin, KiroBalance, KiroServiceStatus, KiroStatus } from '@cosyee/shared';
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
}

export interface KiroServiceOptions {
  accounts: KiroServiceAccounts;
  engine?: Omit<KiroEngineOptions, 'hasKiroAccounts' | 'onUpgraded'>;
  proxy?: Omit<KiroProxyOptions, 'engine' | 'dataDir' | 'listKiroAccounts'>;
  admin?: Omit<KiroAccountAdminOptions, 'onModelsChanged'>;
  login?: Omit<KiroLoginOptions, 'engine' | 'admin' | 'accounts'>;
}

export class KiroService {
  readonly engine: KiroEngine;
  readonly proxy: KiroProxyManager;
  readonly admin: KiroAccountAdmin;
  readonly login: KiroLogin;
  private readonly accounts: KiroServiceAccounts;
  private migrating: Promise<void> | null = null;
  private migrateAgain = false;

  constructor(opts: KiroServiceOptions) {
    this.accounts = opts.accounts;
    this.engine = new KiroEngine({
      ...opts.engine,
      hasKiroAccounts: () => this.accounts.listKiroAccounts().length > 0,
      onUpgraded: () => {
        // 没有执行中的 Kiro 会话就用新引擎重启服务；之后（或首次装好引擎后）补做旧账号迁移
        void this.proxy
          .restartIdle(() => this.busySessionCount() > 0)
          .catch(() => undefined)
          .then(() => this.migrate());
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
    });
    this.login = new KiroLogin({
      ...opts.login,
      engine: this.engine,
      admin: this.admin,
      accounts: this.accounts,
    });
  }

  /** 服务启动时调用：有账号但没有引擎时后台下载，并在后台迁移旧格式（每账号一个进程）的 Kiro 账号 */
  init(): void {
    this.engine.maybeAutoInstall();
    void this.migrate();
  }

  /**
   * 后台迁移旧格式账号到内置服务。同一时间只跑一轮；跑的过程中又被触发会在本轮结束后再跑一轮。
   * 引擎没装好或总开关关着时什么都不做（引擎装好 / 服务启动时会再触发）。
   */
  private migrate(): Promise<void> {
    if (this.migrating) {
      this.migrateAgain = true;
      return this.migrating;
    }
    const run = async (): Promise<void> => {
      do {
        this.migrateAgain = false;
        if (!this.engine.isEnabled() || !this.engine.binaryPath()) return;
        await this.admin.migrateAll(this.accounts.listKiroAccounts());
      } while (this.migrateAgain);
    };
    this.migrating = run()
      .catch(() => undefined)
      .finally(() => {
        this.migrating = null;
      });
    return this.migrating;
  }

  /** 等当前的迁移跑完（测试用） */
  waitForMigration(): Promise<void> {
    return this.migrating ?? Promise.resolve();
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
      items: list.map((a) => ({ id: a.id, label: a.label, proxy: this.proxy.stateOf(a.dir).proxy })),
    };
  }

  status(): KiroStatus {
    return {
      engine: this.engine.status(),
      service: this.serviceStatus(),
      imports: this.login.importsStatus(),
      login: this.login.currentLogin(),
    };
  }

  async checkEngine(): Promise<KiroStatus> {
    await this.engine.check();
    return this.status();
  }

  buildEngine(): KiroStatus {
    this.engine.startBuild();
    return this.status();
  }

  engineLog(from = 0): { lines: string[]; next: number } {
    return this.engine.getLog(from);
  }

  /** 打开总开关并启动服务 */
  startService(): KiroStatus {
    if (!this.engine.binaryPath()) throw new HttpError(409, KIRO_ENGINE_MISSING);
    this.engine.setEnabled(true);
    try {
      this.proxy.ensure({ force: true });
    } catch { /* 失败记在服务状态里 */ }
    void this.migrate();
    return this.status();
  }

  /** 关闭总开关（持久化）并停止服务；有执行中的 Kiro 会话且没带 force 时抛 RunningError(409) */
  async stopService(force: boolean): Promise<KiroStatus> {
    const busy = this.busySessionCount();
    if (busy > 0 && !force) {
      throw new RunningError(busy, `有 ${busy} 个 Kiro 会话正在执行，停止服务会中断它们`);
    }
    this.engine.setEnabled(false);
    await this.proxy.stopAll();
    return this.status();
  }

  /** 用当前引擎重启服务；有执行中的 Kiro 会话且没带 force 时抛 RunningError(409) */
  async restartService(force: boolean): Promise<KiroStatus> {
    if (!this.engine.binaryPath()) throw new HttpError(409, KIRO_ENGINE_MISSING);
    const busy = this.busySessionCount();
    if (busy > 0 && !force) {
      throw new RunningError(busy, `有 ${busy} 个 Kiro 会话正在执行，重启服务会中断它们`);
    }
    this.engine.setEnabled(true);
    await this.proxy.stopAll();
    try {
      this.proxy.ensure({ force: true });
    } catch { /* 失败记在服务状态里 */ }
    void this.migrate();
    return this.status();
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
    return this.admin.balance(this.accounts.existingKiroDir(accountId));
  }

  /** 获取内置 kiro.rs 服务的管理页面地址与密钥（按需启动服务并等就绪）；账号只用于确认调用方选的是 Kiro 账号 */
  async adminAccess(accountId: string): Promise<{ url: string; key: string }> {
    this.accounts.existingKiroDir(accountId);
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
    await this.proxy.stopAll();
  }

  /** 进程 exit 钩子里的同步强杀 */
  disposeSync(): void {
    this.engine.dispose();
    this.login.dispose();
    this.proxy.stopAll(true);
  }
}

export { KiroAccountAdmin, KiroEngine, KiroLogin, KiroProxyManager };
export { KIRO_ENGINE_MISSING, KIRO_SERVICE_STOPPED } from './sanitize.js';
