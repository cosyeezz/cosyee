// Kiro 服务总入口：组合 KiroEngine、KiroProxyManager、KiroLogin，对接 HTTP 路由与 server.ts 生命周期。
import type { AccountLogin, KiroBalance, KiroServiceStatus, KiroStatus } from '@cosyee/shared';
import { RunningError } from '../accounts/index.js';
import { pathKey } from '../paths.js';
import { HttpError } from '../workspaces.js';
import { KiroEngine, type KiroEngineOptions } from './engine.js';
import { KiroLogin, type KiroAccountHooks, type KiroLoginOptions, type StartKiroLoginOpts } from './login.js';
import { KiroProxyManager, type KiroProxyOptions } from './proxy.js';
import { KIRO_ENGINE_MISSING, KIRO_SERVICE_STOPPED } from './sanitize.js';

export interface KiroServiceAccounts extends KiroAccountHooks {
  /** 全部 Kiro 账号的 { id, dir, label } 列表 */
  listKiroAccounts(): Array<{ id: string; dir: string; label: string }>;
}

export interface KiroServiceOptions {
  accounts: KiroServiceAccounts;
  engine?: Omit<KiroEngineOptions, 'hasKiroAccounts' | 'onUpgraded'>;
  proxy?: Omit<KiroProxyOptions, 'engine'>;
  login?: Omit<KiroLoginOptions, 'engine' | 'proxy' | 'accounts'>;
}

export class KiroService {
  readonly engine: KiroEngine;
  readonly proxy: KiroProxyManager;
  readonly login: KiroLogin;
  private readonly accounts: KiroServiceAccounts;

  constructor(opts: KiroServiceOptions) {
    this.accounts = opts.accounts;
    this.engine = new KiroEngine({
      ...opts.engine,
      hasKiroAccounts: () => this.accounts.listKiroAccounts().length > 0,
      onUpgraded: () => {
        void this.proxy.restartIdle((dir) => {
          const acc = this.accounts.listKiroAccounts().find((a) => pathKey(a.dir) === pathKey(dir));
          return acc ? this.accounts.running(acc.id) > 0 : false;
        });
      },
    });
    this.proxy = new KiroProxyManager({
      ...opts.proxy,
      engine: this.engine,
    });
    this.login = new KiroLogin({
      ...opts.login,
      engine: this.engine,
      proxy: this.proxy,
      accounts: this.accounts,
    });
  }

  /** 服务启动时调用：仅在已有 Kiro 账号且超 24h 时后台检查一次上游更新 */
  init(): void {
    this.engine.maybeAutoCheck();
  }

  serviceStatus(): KiroServiceStatus {
    const list = this.accounts.listKiroAccounts();
    let running = 0;
    let failed = 0;
    let busySessions = 0;
    let outdated = 0;
    const items: KiroServiceStatus['items'] = [];
    for (const a of list) {
      const st = this.proxy.stateOf(a.dir);
      if (st.proxy === 'starting' || st.proxy === 'ready') running++;
      else if (st.proxy === 'failed') failed++;
      busySessions += this.accounts.running(a.id);
      if (this.proxy.isOutdated(a.dir)) outdated++;
      items.push({ id: a.id, label: a.label, proxy: st.proxy });
    }
    return {
      enabled: this.engine.isEnabled(),
      accounts: list.length,
      running,
      failed,
      busySessions,
      outdated,
      items,
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

  /** 打开总开关并启动全部 Kiro 账号的代理 */
  startService(): KiroStatus {
    if (!this.engine.binaryPath()) throw new HttpError(409, KIRO_ENGINE_MISSING);
    this.engine.setEnabled(true);
    for (const a of this.accounts.listKiroAccounts()) {
      try {
        this.proxy.ensure(a.dir, { force: true });
      } catch { /* 单账号失败记在 proxy 状态里 */ }
    }
    return this.status();
  }

  /** 关闭总开关（持久化）并停止全部代理；有执行中的 Kiro 会话且没带 force 时抛 RunningError(409) */
  async stopService(force: boolean): Promise<KiroStatus> {
    const busy = this.busySessionCount();
    if (busy > 0 && !force) {
      throw new RunningError(busy, `有 ${busy} 个 Kiro 会话正在执行，停止服务会中断它们`);
    }
    this.engine.setEnabled(false);
    await this.proxy.stopAll();
    return this.status();
  }

  /** 用当前引擎重启全部代理；有执行中的 Kiro 会话且没带 force 时抛 RunningError(409) */
  async restartService(force: boolean): Promise<KiroStatus> {
    if (!this.engine.binaryPath()) throw new HttpError(409, KIRO_ENGINE_MISSING);
    const busy = this.busySessionCount();
    if (busy > 0 && !force) {
      throw new RunningError(busy, `有 ${busy} 个 Kiro 会话正在执行，重启服务会中断它们`);
    }
    this.engine.setEnabled(true);
    await this.proxy.stopAll();
    for (const a of this.accounts.listKiroAccounts()) {
      try {
        this.proxy.ensure(a.dir, { force: true });
      } catch { /* 单账号失败记在 proxy 状态里 */ }
    }
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
    const dir = this.accounts.existingKiroDir(accountId);
    return this.proxy.getBalance(dir);
  }

  /** 获取某个 Kiro 账号的管理页面地址与密钥（按需启动代理并等就绪） */
  async adminAccess(accountId: string): Promise<{ url: string; key: string }> {
    const dir = this.accounts.existingKiroDir(accountId);
    if (!this.engine.isEnabled()) throw new HttpError(409, KIRO_SERVICE_STOPPED);
    if (!this.engine.binaryPath()) throw new HttpError(409, KIRO_ENGINE_MISSING);
    const eng = this.engine.status();
    if (!eng.adminUi) {
      const reason = eng.adminUiError ? `（${eng.adminUiError}）` : '';
      throw new HttpError(409, `当前 kiro.rs 引擎未包含管理页面${reason}，请重新构建引擎`);
    }
    return this.proxy.adminEndpoint(dir);
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

export { KiroEngine, KiroLogin, KiroProxyManager };
export { KIRO_ENGINE_MISSING, KIRO_SERVICE_STOPPED } from './sanitize.js';
