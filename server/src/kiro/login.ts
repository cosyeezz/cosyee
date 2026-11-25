// Kiro 账号登录：同一时间只允许一个，10 分钟超时，可取消，失败不留目录，重新登录先备份失败恢复。
// 支持 5 种方式：
//   - builderId / idc：AWS SSO OIDC 设备码授权（严格校验 region 与 startUrl，防 SSRF）
//   - kiroIde：只读导入 ~/.aws/sso/cache/kiro-auth-token.json（IdC 时校验 40 位 hex clientIdHash 读同目录客户端文件）
//   - kiroCli：动态 import('node:sqlite') 只读打开 kiro-cli 数据库的 auth_kv 表
//   - apiKey：ksk_ 开头
// 任何令牌都绝不进日志、错误信息或 HTTP 响应。
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import type { AccountLogin, KiroLoginMethod } from '@cosyee/shared';
import { API_FILE } from '../accounts/api-config.js';
import { isFile } from '../claude/bin.js';
import { HttpError } from '../workspaces.js';
import type { KiroEngine } from './engine.js';
import {
  type KiroProxyManager,
  createProxyConfig,
  kiroConfigPath,
  kiroCredsPath,
  readKiroProxyConfig,
} from './proxy.js';
import {
  HEX40_RE,
  KIRO_API_KEY_RE,
  KIRO_ENGINE_MISSING,
  KIRO_LOGIN_METHODS,
  KIRO_SERVICE_STOPPED,
  type KiroCredentialEntry,
  buildKiroCredential,
  isValidRegion,
  kiroApiRegion,
  normalizeStartUrl,
  sanitizeKiroError,
  writeFileAtomic,
} from './sanitize.js';

const BUILDER_ID_START_URL = 'https://view.awsapps.com/start';
const DEFAULT_REGION = 'us-east-1';
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const OIDC_REQ_TIMEOUT_MS = 15_000;
const LABEL_MAX = 40;

const OIDC_SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
];

const OIDC_GRANT_TYPES = [
  'urn:ietf:params:oauth:grant-type:device_code',
  'refresh_token',
];

export interface KiroAccountHooks {
  /** 为新 Kiro 账号准备目录（建共享链接与 MCP 同步） */
  allocateNewDir(): { id: string; dir: string };
  /** 查已有 Kiro 账号的目录；不存在抛 404，不是 Kiro 账号抛 400 */
  existingKiroDir(accountId: string): string;
  /** 该账号正在执行的会话数 */
  running(accountId: string): number;
  /** 停止该账号空闲的 claude 进程 */
  stopAccountProcesses(accountId: string): Promise<void>;
  /** 登录成功后登记新账号 */
  commitNew(id: string, dir: string, label: string): void;
  /** 重新登录成功后更新备注（可选）并通知刷新 */
  commitRelogin(accountId: string, label?: string): void;
  /** 失败时清理未登记的新目录 */
  discardDir(dir: string): void;
}

export interface KiroLoginOptions {
  engine: Pick<KiroEngine, 'binaryPath' | 'isEnabled'>;
  proxy: KiroProxyManager;
  accounts: KiroAccountHooks;
  /** 测试替换：fetch */
  fetch?: typeof globalThis.fetch;
  /** 测试替换：Kiro IDE 令牌文件路径 */
  kiroIdeTokenPath?: () => string;
  /** 测试替换：Kiro CLI SQLite 数据库路径 */
  kiroCliDbPath?: () => string;
  /** 测试替换：时间源 */
  now?: () => number;
  /** 测试替换：登录超时（ms） */
  loginTimeoutMs?: number;
  /** 测试替换：设备码轮询间隔（传入服务端返回的秒数，返回实际等待毫秒） */
  pollDelayMs?: (intervalSec: number) => number;
  /** 测试替换：动态加载 node:sqlite */
  loadSqlite?: () => Promise<{ DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDbLike }>;
}

interface SqliteDbLike {
  prepare(sql: string): { all(...params: unknown[]): Array<{ key?: unknown; value?: unknown }> };
  close(): void;
}

export interface StartKiroLoginOpts {
  method: unknown;
  label?: unknown;
  accountId?: unknown;
  startUrl?: unknown;
  region?: unknown;
  apiKey?: unknown;
}

interface ReloginBackup {
  credsPath: string;
  credsRaw: Buffer | null;
  configPath: string;
  configRaw: Buffer | null;
  apiPath: string;
  apiRaw: Buffer | null;
}

interface LoginJob {
  state: AccountLogin;
  ac: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
  done: Promise<void>;
}

export function defaultKiroIdeTokenPath(): string {
  return path.join(os.homedir(), '.aws', 'sso', 'cache', 'kiro-auth-token.json');
}

export function defaultKiroCliDbPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'Kiro-Cli', 'data.sqlite3');
  }
  if (platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3');
  }
  return path.join(os.homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3');
}

function cleanLabel(v: unknown): string {
  return typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, LABEL_MAX) : '';
}

function newLoginId(): string {
  return crypto.randomBytes(5).toString('hex');
}

function readRawOrNull(file: string): Buffer | null {
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

function captureBackup(dir: string): ReloginBackup {
  return {
    credsPath: kiroCredsPath(dir),
    credsRaw: readRawOrNull(kiroCredsPath(dir)),
    configPath: kiroConfigPath(dir),
    configRaw: readRawOrNull(kiroConfigPath(dir)),
    apiPath: path.join(dir, API_FILE),
    apiRaw: readRawOrNull(path.join(dir, API_FILE)),
  };
}

function restoreBackup(b: ReloginBackup): void {
  const restoreOne = (p: string, raw: Buffer | null) => {
    if (raw !== null) {
      writeFileAtomic(p, raw, 0o600);
    } else {
      try { fs.rmSync(p, { force: true }); } catch { /* ignore */ }
    }
  };
  restoreOne(b.credsPath, b.credsRaw);
  restoreOne(b.configPath, b.configRaw);
  restoreOne(b.apiPath, b.apiRaw);
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('已取消'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('已取消'));
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref?.();
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function combineSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

export class KiroLogin {
  private job: LoginJob | null = null;

  constructor(private readonly opts: KiroLoginOptions) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private fetchFn(): typeof globalThis.fetch {
    return this.opts.fetch ?? globalThis.fetch;
  }

  private idePath(): string {
    return this.opts.kiroIdeTokenPath ? this.opts.kiroIdeTokenPath() : defaultKiroIdeTokenPath();
  }

  private cliPath(): string {
    return this.opts.kiroCliDbPath ? this.opts.kiroCliDbPath() : defaultKiroCliDbPath();
  }

  /** 只判断本机是否存在可导入的文件，绝不读取令牌 */
  importsStatus(): { kiroIde: boolean; kiroCli: boolean } {
    return {
      kiroIde: isFile(this.idePath()),
      kiroCli: isFile(this.cliPath()),
    };
  }

  private busy(): boolean {
    const st = this.job?.state.status;
    return st === 'starting' || st === 'waiting';
  }

  currentLogin(): AccountLogin | null {
    return this.job ? { ...this.job.state } : null;
  }

  getLogin(loginId: string): AccountLogin {
    if (!this.job || this.job.state.loginId !== loginId) {
      throw new HttpError(404, '登录已结束或不存在');
    }
    return { ...this.job.state };
  }

  /** 等待当前登录任务完成（测试用） */
  waitForLogin(): Promise<void> {
    return this.job?.done ?? Promise.resolve();
  }

  startLogin(raw: StartKiroLoginOpts): AccountLogin {
    if (this.busy()) throw new HttpError(409, '已有一个 Kiro 登录正在进行');
    if (!this.opts.engine.isEnabled()) throw new HttpError(409, KIRO_SERVICE_STOPPED);
    if (!this.opts.engine.binaryPath()) throw new HttpError(409, KIRO_ENGINE_MISSING);

    if (typeof raw.method !== 'string' || !KIRO_LOGIN_METHODS.includes(raw.method as KiroLoginMethod)) {
      throw new HttpError(400, '不支持的 Kiro 登录方式');
    }
    const method = raw.method as KiroLoginMethod;

    // 校验方式专属参数
    let region = DEFAULT_REGION;
    let startUrl = BUILDER_ID_START_URL;
    let apiKey = '';

    if (method === 'builderId' || method === 'idc') {
      const r = typeof raw.region === 'string' && raw.region.trim() ? raw.region.trim() : DEFAULT_REGION;
      if (!isValidRegion(r)) throw new HttpError(400, 'region 格式不合法（如 us-east-1）');
      region = r;
      if (method === 'idc') {
        const u = normalizeStartUrl(raw.startUrl);
        if (!u) throw new HttpError(400, 'Start URL 不合法，必须是 https://*.awsapps.com 或 https://*.app.aws');
        startUrl = u;
      }
    } else if (method === 'apiKey') {
      const k = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
      if (!KIRO_API_KEY_RE.test(k)) throw new HttpError(400, 'Kiro API Key 不合法，需以 ksk_ 开头');
      apiKey = k;
    }

    // 校验重新登录目标账号
    let target: string | null = null;
    let existingDir: string | null = null;
    if (raw.accountId !== undefined && raw.accountId !== null) {
      if (typeof raw.accountId !== 'string' || !raw.accountId) throw new HttpError(400, 'accountId 不合法');
      target = raw.accountId;
      existingDir = this.opts.accounts.existingKiroDir(target);
      const running = this.opts.accounts.running(target);
      if (running > 0) {
        throw new HttpError(409, `该账号有 ${running} 个会话正在执行，请等它们结束后再重新登录`);
      }
    }

    const label = raw.label !== undefined ? cleanLabel(raw.label) : undefined;
    const ac = new AbortController();
    const state: AccountLogin = {
      loginId: newLoginId(),
      status: 'starting',
      url: null,
      userCode: null,
      accountId: target,
      error: null,
    };

    const job: LoginJob = {
      state,
      ac,
      timer: null,
      done: Promise.resolve(),
    };
    const timeoutMs = this.opts.loginTimeoutMs ?? LOGIN_TIMEOUT_MS;
    job.timer = setTimeout(() => {
      if (this.job === job && (job.state.status === 'starting' || job.state.status === 'waiting')) {
        job.state.error = '登录超时';
        ac.abort(new Error('登录超时'));
      }
    }, timeoutMs);
    job.timer.unref?.();

    this.job = job;
    job.done = this.runJob(job, { method, label, target, existingDir, region, startUrl, apiKey });
    return { ...state };
  }

  cancelLogin(loginId: string): void {
    const job = this.job;
    if (!job || job.state.loginId !== loginId) return;
    if (job.state.status === 'starting' || job.state.status === 'waiting') {
      job.state.error = '已取消';
      job.ac.abort(new Error('已取消'));
    }
  }

  dispose(): void {
    if (this.job && this.busy()) {
      this.job.state.error = '服务已关闭';
      this.job.ac.abort(new Error('服务已关闭'));
    }
  }

  private async runJob(
    job: LoginJob,
    params: {
      method: KiroLoginMethod;
      label: string | undefined;
      target: string | null;
      existingDir: string | null;
      region: string;
      startUrl: string;
      apiKey: string;
    },
  ): Promise<void> {
    const { state, ac } = job;
    let allocated: { id: string; dir: string } | null = null;
    let dir: string | null = params.existingDir;
    let backup: ReloginBackup | null = null;

    try {
      // 1. 获取凭据（在写任何账号目录文件之前完成 OIDC / 导入，取消时零残留）
      let cred: KiroCredentialEntry;
      let credRegion = params.region;

      if (params.method === 'builderId' || params.method === 'idc') {
        cred = await this.loginOidc(job, params.region, params.startUrl, ac.signal);
      } else if (params.method === 'kiroIde') {
        const imported = this.importKiroIde();
        cred = imported.cred;
        credRegion = imported.region;
      } else if (params.method === 'kiroCli') {
        const imported = await this.importKiroCli();
        cred = imported.cred;
        credRegion = imported.region;
      } else {
        cred = buildKiroCredential({ authMethod: 'api_key', kiroApiKey: params.apiKey }, this.now());
      }

      if (ac.signal.aborted) throw new Error(state.error ?? '已取消');

      // 2. 准备账号目录（重新登录先停旧进程并备份；新账号分配目录）
      if (params.target && dir) {
        // 等授权可能过了几分钟：期间账号可能被移除，或有会话开始执行
        this.opts.accounts.existingKiroDir(params.target);
        const running = this.opts.accounts.running(params.target);
        if (running > 0) throw new Error(`该账号有 ${running} 个会话正在执行，请等它们结束后再重新登录`);
        await this.opts.accounts.stopAccountProcesses(params.target);
        await this.opts.proxy.stop(dir);
        backup = captureBackup(dir);
      } else {
        allocated = this.opts.accounts.allocateNewDir();
        dir = allocated.dir;
      }

      // 3. 写入 kiro/credentials.json（数组格式）与 kiro/config.json + cosyee-api.json
      const prevProxyCfg = params.target ? readKiroProxyConfig(dir) : null;
      const port = prevProxyCfg?.port ?? (await this.opts.proxy.pickFreePort());
      const proxyCfg = prevProxyCfg
        ? { ...prevProxyCfg, port, region: credRegion }
        : createProxyConfig(port, credRegion);

      writeFileAtomic(kiroCredsPath(dir), JSON.stringify([cred], null, 2) + '\n', 0o600);
      this.opts.proxy.writeAccountConfigs(dir, params.method, proxyCfg);

      if (ac.signal.aborted) throw new Error(state.error ?? '已取消');

      // 4. 启动代理并验证凭据
      if (params.method === 'apiKey') {
        await this.opts.proxy.getBalance(dir);
      } else {
        await this.opts.proxy.refreshToken(dir);
      }

      if (ac.signal.aborted) throw new Error(state.error ?? '已取消');

      // 5. 登记账号 / 通知更新
      if (params.target) {
        this.opts.accounts.commitRelogin(params.target, params.label);
        state.accountId = params.target;
      } else if (allocated) {
        this.opts.accounts.commitNew(allocated.id, allocated.dir, params.label ?? '');
        state.accountId = allocated.id;
      }
      state.status = 'done';
      state.error = null;
    } catch (e) {
      // 失败 / 取消：停止本次启动的代理，恢复备份或删除新目录
      if (dir) {
        try { await this.opts.proxy.stop(dir); } catch { /* ignore */ }
      }
      if (backup) {
        try { restoreBackup(backup); } catch { /* ignore */ }
      } else if (allocated) {
        this.opts.accounts.discardDir(allocated.dir);
      }
      if (state.status !== 'done') {
        state.status = 'failed';
        state.error = state.error && ac.signal.aborted ? state.error : sanitizeKiroError(e);
      }
    } finally {
      if (job.timer) clearTimeout(job.timer);
      job.timer = null;
    }
  }

  /** AWS SSO OIDC 设备码授权流程（builderId / idc） */
  private async loginOidc(
    job: LoginJob,
    region: string,
    startUrl: string,
    signal: AbortSignal,
  ): Promise<KiroCredentialEntry> {
    const oidcBase = `https://oidc.${region}.amazonaws.com`;
    const fetchFn = this.fetchFn();

    // Step 1: /client/register
    const regRes = await fetchFn(`${oidcBase}/client/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientName: 'kiro-device-login',
        clientType: 'public',
        scopes: OIDC_SCOPES,
        grantTypes: OIDC_GRANT_TYPES,
        issuerUrl: startUrl,
      }),
      signal: combineSignal(signal, OIDC_REQ_TIMEOUT_MS),
    });
    if (!regRes.ok) throw new Error(`注册 OIDC 客户端失败（HTTP ${regRes.status}）`);
    const reg = (await regRes.json()) as { clientId?: unknown; clientSecret?: unknown };
    const clientId = strOrNull(reg?.clientId);
    const clientSecret = strOrNull(reg?.clientSecret);
    if (!clientId || !clientSecret) throw new Error('OIDC 客户端注册响应缺少必要字段');

    // Step 2: /device_authorization
    const devRes = await fetchFn(`${oidcBase}/device_authorization`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId, clientSecret, startUrl }),
      signal: combineSignal(signal, OIDC_REQ_TIMEOUT_MS),
    });
    if (!devRes.ok) throw new Error(`获取设备授权码失败（HTTP ${devRes.status}）`);
    const dev = (await devRes.json()) as {
      deviceCode?: unknown;
      userCode?: unknown;
      verificationUri?: unknown;
      verificationUriComplete?: unknown;
      interval?: unknown;
      expiresIn?: unknown;
    };
    const deviceCode = strOrNull(dev?.deviceCode);
    const userCode = strOrNull(dev?.userCode);
    const verifyUrl = strOrNull(dev?.verificationUriComplete) ?? strOrNull(dev?.verificationUri);
    if (!deviceCode || !verifyUrl) throw new Error('设备授权响应缺少必要字段');

    job.state.url = verifyUrl;
    job.state.userCode = userCode;
    job.state.status = 'waiting';

    let intervalSec = typeof dev?.interval === 'number' && Number.isFinite(dev.interval) && dev.interval > 0 ? dev.interval : 5;
    const expiresInSec = typeof dev?.expiresIn === 'number' && Number.isFinite(dev.expiresIn) && dev.expiresIn > 0 ? dev.expiresIn : 600;
    const deadline = this.now() + expiresInSec * 1000;

    // Step 3: /token 轮询
    while (this.now() < deadline) {
      const waitMs = this.opts.pollDelayMs ? this.opts.pollDelayMs(intervalSec) : intervalSec * 1000;
      await sleepAbortable(waitMs, signal);

      const tokRes = await fetchFn(`${oidcBase}/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          clientId,
          clientSecret,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code',
          deviceCode,
        }),
        signal: combineSignal(signal, OIDC_REQ_TIMEOUT_MS),
      });

      const body = (await tokRes.json().catch(() => ({}))) as {
        accessToken?: unknown;
        refreshToken?: unknown;
        expiresIn?: unknown;
        error?: unknown;
      };

      if (tokRes.ok) {
        const refreshToken = strOrNull(body.refreshToken);
        const accessToken = strOrNull(body.accessToken);
        if (!refreshToken) throw new Error('授权响应缺少刷新令牌');
        const expSec = typeof body.expiresIn === 'number' && Number.isFinite(body.expiresIn) && body.expiresIn > 0 ? body.expiresIn : 0;
        const expiresAt = accessToken && expSec > 0 ? new Date(this.now() + expSec * 1000).toISOString() : null;
        return buildKiroCredential(
          {
            authMethod: 'idc',
            refreshToken,
            accessToken,
            expiresAt,
            clientId,
            clientSecret,
            authRegion: region,
            apiRegion: kiroApiRegion(region, null),
          },
          this.now(),
        );
      }

      const errCode = typeof body.error === 'string' ? body.error : '';
      if (errCode === 'authorization_pending') continue;
      if (errCode === 'slow_down') {
        intervalSec += 5;
        continue;
      }
      if (errCode === 'expired_token') throw new Error('授权码已过期，请重试');
      if (errCode === 'access_denied') throw new Error('用户拒绝了授权');
      throw new Error(`设备码授权失败（HTTP ${tokRes.status}）`);
    }

    throw new Error('授权码已过期，请重试');
  }

  /** 只读导入 Kiro IDE 的登录凭据 */
  private importKiroIde(): { cred: KiroCredentialEntry; region: string } {
    const file = this.idePath();
    if (!isFile(file)) throw new Error('未找到本机 Kiro IDE 登录文件');
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('格式异常');
      }
      raw = parsed as Record<string, unknown>;
    } catch {
      throw new Error('无法解析 Kiro IDE 登录文件');
    }

    const refreshToken = strOrNull(raw.refreshToken);
    if (!refreshToken) throw new Error('Kiro IDE 登录文件缺少刷新令牌');
    const accessToken = strOrNull(raw.accessToken);
    const expiresAt = strOrNull(raw.expiresAt);
    const profileArn = strOrNull(raw.profileArn);
    const rawMethod = (strOrNull(raw.authMethod) ?? '').toLowerCase();
    const isIdc = rawMethod === 'idc' || rawMethod === 'builder-id' || rawMethod === 'iam';

    if (isIdc) {
      const hash = strOrNull(raw.clientIdHash);
      if (!hash || !HEX40_RE.test(hash)) {
        throw new Error('Kiro IDE 的 IdC 登录缺少有效的 clientIdHash');
      }
      const clientFile = path.join(path.dirname(file), `${hash}.json`);
      if (!isFile(clientFile)) throw new Error('找不到对应的 Kiro IDE 客户端注册文件');
      let clientJson: Record<string, unknown>;
      try {
        const parsed = JSON.parse(fs.readFileSync(clientFile, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('格式异常');
        clientJson = parsed as Record<string, unknown>;
      } catch {
        throw new Error('无法解析 Kiro IDE 客户端注册文件');
      }
      const clientId = strOrNull(clientJson.clientId);
      const clientSecret = strOrNull(clientJson.clientSecret);
      if (!clientId || !clientSecret) throw new Error('Kiro IDE 客户端注册文件缺少必要字段');
      const rawRegion = strOrNull(raw.region) ?? strOrNull(clientJson.region) ?? DEFAULT_REGION;
      const region = isValidRegion(rawRegion) ? rawRegion : DEFAULT_REGION;
      return {
        region,
        cred: buildKiroCredential(
          {
            authMethod: 'idc',
            refreshToken,
            accessToken,
            expiresAt,
            profileArn,
            clientId,
            clientSecret,
            authRegion: region,
            apiRegion: kiroApiRegion(region, profileArn),
          },
          this.now(),
        ),
      };
    }

    const rawRegion = strOrNull(raw.region) ?? DEFAULT_REGION;
    const region = isValidRegion(rawRegion) ? rawRegion : DEFAULT_REGION;
    return {
      region,
      cred: buildKiroCredential(
        {
          authMethod: 'social',
          refreshToken,
          accessToken,
          expiresAt,
          profileArn,
          authRegion: region,
          apiRegion: kiroApiRegion(region, profileArn),
        },
        this.now(),
      ),
    };
  }

  /** 动态加载 node:sqlite 并只读打开 Kiro CLI 数据库导入凭据 */
  private async importKiroCli(): Promise<{ cred: KiroCredentialEntry; region: string }> {
    const dbFile = this.cliPath();
    if (!isFile(dbFile)) throw new Error('未找到本机 Kiro CLI 数据库');

    let sqliteMod: { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDbLike };
    try {
      if (this.opts.loadSqlite) {
        sqliteMod = await this.opts.loadSqlite();
      } else {
        const req = createRequire(import.meta.url);
        sqliteMod = req('node:sqlite') as { DatabaseSync: new (file: string, opts?: { readOnly?: boolean }) => SqliteDbLike };
      }
    } catch {
      throw new Error('当前 Node.js 环境不支持 node:sqlite，无法读取 Kiro CLI 登录记录');
    }

    if (typeof sqliteMod?.DatabaseSync !== 'function') {
      throw new Error('当前 Node.js 环境不支持 node:sqlite，无法读取 Kiro CLI 登录记录');
    }

    const kv = new Map<string, Record<string, unknown>>();
    let db: SqliteDbLike | null = null;
    try {
      db = new sqliteMod.DatabaseSync(dbFile, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT key, value FROM auth_kv WHERE key IN (
            'kirocli:social:token',
            'kirocli:odic:token',
            'kirocli:odic:device-registration',
            'kirocli:oidc:token',
            'kirocli:oidc:device-registration'
          )`,
        )
        .all();
      for (const row of rows) {
        if (typeof row.key !== 'string' || typeof row.value !== 'string') continue;
        try {
          const parsed = JSON.parse(row.value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            kv.set(row.key, parsed as Record<string, unknown>);
          }
        } catch { /* 跳过非法条目 */ }
      }
    } catch (e) {
      throw new Error(`读取 Kiro CLI 数据库失败：${sanitizeKiroError(e)}`);
    } finally {
      try { db?.close(); } catch { /* ignore */ }
    }

    // 优先 social，再兜底 IdC（兼容 kiro-cli 的 odic 拼写与 oidc）
    const social = kv.get('kirocli:social:token');
    if (social && strOrNull(social.refresh_token)) {
      const rawRegion = strOrNull(social.region) ?? DEFAULT_REGION;
      const region = isValidRegion(rawRegion) ? rawRegion : DEFAULT_REGION;
      return {
        region,
        cred: buildKiroCredential(
          {
            authMethod: 'social',
            refreshToken: strOrNull(social.refresh_token),
            accessToken: strOrNull(social.access_token),
            expiresAt: strOrNull(social.expires_at),
            profileArn: strOrNull(social.profile_arn),
            authRegion: region,
            apiRegion: kiroApiRegion(region, strOrNull(social.profile_arn)),
          },
          this.now(),
        ),
      };
    }

    const idcTok = kv.get('kirocli:odic:token') ?? kv.get('kirocli:oidc:token');
    const idcReg = kv.get('kirocli:odic:device-registration') ?? kv.get('kirocli:oidc:device-registration');
    if (idcTok && strOrNull(idcTok.refresh_token)) {
      const clientId = strOrNull(idcReg?.client_id) ?? strOrNull(idcTok.client_id);
      const clientSecret = strOrNull(idcReg?.client_secret) ?? strOrNull(idcTok.client_secret);
      if (!clientId || !clientSecret) {
        throw new Error('Kiro CLI 的 IdC 登录缺少客户端注册信息');
      }
      const rawRegion = strOrNull(idcTok.region) ?? strOrNull(idcReg?.region) ?? DEFAULT_REGION;
      const region = isValidRegion(rawRegion) ? rawRegion : DEFAULT_REGION;
      return {
        region,
        cred: buildKiroCredential(
          {
            authMethod: 'idc',
            refreshToken: strOrNull(idcTok.refresh_token),
            accessToken: strOrNull(idcTok.access_token),
            expiresAt: strOrNull(idcTok.expires_at),
            profileArn: strOrNull(idcTok.profile_arn),
            clientId,
            clientSecret,
            authRegion: region,
            apiRegion: kiroApiRegion(region, null),
          },
          this.now(),
        ),
      };
    }

    throw new Error('未在 Kiro CLI 数据库中找到可用的登录凭据');
  }
}
