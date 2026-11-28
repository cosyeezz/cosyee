// 组装并启动服务：HTTP + WebSocket。index.ts 与 smoke 脚本都通过 startServer 使用它。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMsg, PriceTable, ServerMsg, SubagentAccountOption } from '@cosyee/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { AccountProvider } from './account.js';
import { AgyAccounts } from './accounts/agy.js';
import { CodexAccounts } from './accounts/codex.js';
import { Accounts, DEFAULT_ID } from './accounts/index.js';
import { setBeforeClaudeEnv } from './claude/bin.js';
import { Manager } from './claude/manager.js';
import type { RunnerTimings } from './claude/runner.js';
import { AcpPool, AgyBackend } from './delegate/acp.js';
import { ClaudeBackend } from './delegate/claudeBackend.js';
import { resolveCodexInfo } from './delegate/codex.js';
import { CodexBackend, CodexPool } from './delegate/codexAppServer.js';
import { CodexCli } from './delegate/codexCli.js';
import { BrowserInstall } from './browser/install.js';
import { BrowserManager } from './browser/manager.js';
import { ensureBrowserPlugin } from './browser/skill.js';
import { createAgyAdapter } from './components/agy.js';
import { createBrowserAdapter } from './components/browser.js';
import { createClaudeAdapter } from './components/claude.js';
import { createCodexAdapter } from './components/codex.js';
import { createKiroAdapter } from './components/kiro.js';
import { createServerAdapter } from './components/server.js';
import { ComponentUpdater } from './components/updater.js';
import { createHandler, hostAllowed } from './http.js';
import { KiroService } from './kiro/index.js';
import { createLedger, type LedgerService } from './ledger/service.js';
import { setLedgerSink } from './ledger/sink.js';
import { KiroBalanceCollector, startLedgerProbes, wrapClaudeUsageFetch } from './ledger/collect/index.js';
import { Pins } from './pins.js';
import { PricingService } from './pricing.js';
import { startUploadSweeper } from './uploads.js';
import { Previews } from './preview.js';
import type { Spawner } from './reveal.js';
import { cosyeeHome, isSafeId } from './paths.js';
import { AgyCli } from './delegate/agyCli.js';
import { DelegateRecorder } from './delegate/record.js';
import { TAILSCALE_MODE, connectionAllowed, listenAddress, originAllowed, requestAuthorized } from './security.js';
import { Sessions } from './sessions.js';
import { Trash } from './trash.js';
import { StopStore } from './stops.js';
import { ToolStatsStore } from './toolStats.js';
import { CompactStatsStore } from './compactStats.js';
import { DotState } from './state.js';
import { UsageProvider, fetchUsage } from './usage.js';
import { CliModelsDisk, CliModelsProvider, fetchCliModels, type FetchedModels } from './cliModels.js';
import { HttpError, StateStore, Workspaces } from './workspaces.js';
import { Speech } from './speech/index.js';
import { TwoFaService } from './twofa/index.js';
import { ensureTwoFaPlugin } from './twofa/skill.js';
import { TerminalManager } from './terminal/index.js';

/** state.json 里最多保留多少个会话的配置记录（超出丢最久没用的） */
const MAX_SESSION_CONFIGS = 2000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, '..');

export interface StartOptions {
  /** 默认读 COSYEE_PORT，再默认 7878；传 0 则随机端口（测试用） */
  port?: number;
  /** 指定 claude 可执行文件（默认自动查找） */
  claudePath?: string;
  /** 覆盖 web/dist 目录；传 null 表示不托管静态文件 */
  webDist?: string | null;
  timings?: Partial<RunnerTimings>;
  /** state.json 位置，默认 COSYEE_HOME 或 ~/.cosyee */
  stateFile?: string;
  /** 版本号；不传则读 server/package.json（打包成单文件后读不到，由调用方传入） */
  version?: string;
  /** 桌面版访问令牌：设置后每个 HTTP 请求与 WS 升级都必须带 x-cosyee-token 头，否则 403；不设置则行为不变（网页版） */
  authToken?: string;
  /**
   * 监听地址，默认 127.0.0.1；0.0.0.0 / 具体 IP 时 Host / Origin 白名单随之放宽（见 security.allowedHostnames）。
   * 'tailscale'：只接受本机和 tailnet 内的连接（见 security.TAILSCALE_MODE）。
   */
  host?: string;
  /** 「在文件管理器中打开」用的 spawn（测试替换，默认 explorer.exe / open / xdg-open） */
  spawner?: Spawner;
  /** 本机发来 POST /api/shutdown 时调用（见 http.ts）；不传则没有这个接口 */
  onShutdown?: () => void;
  /** 价格表来源（测试替换）；默认定期从官方页面更新，缓存放在 state.json 同目录的 pricing.json */
  pricing?: { table(): PriceTable; start?(): void; stop?(): void };
  /** 模型列表的拉取（测试替换，默认起一个 claude 进程发 initialize） */
  fetchCliModels?: (dir: string | null) => Promise<FetchedModels | null>;
  /** false = 模型列表不落盘（测试用） */
  cliModels?: false;
  /** 启动后在后台下载语音运行库和模型（朗读、语音输入、通话首次使用不用等） */
  prefetchSpeech?: boolean;
  /** Tailscale HTTPS 入口（见 tailscaleHttps.ts），经 /api/bootstrap 告诉网页 */
  httpsUrl?: () => string | null;
  /** 2FA GitHub 同步用的 fetch（测试可替换） */
  twoFaFetch?: typeof globalThis.fetch;
  /** 2FA 获取 GitHub Token 的函数（测试可替换） */
  twoFaGetToken?: () => Promise<string>;
  /** 2FA Agent 令牌（测试可覆盖，默认每次启动随机生成） */
  agentToken?: string;
}

export interface RunningServer {
  port: number;
  /** 本次启动生成的 2FA Agent 令牌（仅限 /api/2fa/agent/*） */
  agentToken: string;
  manager: Manager;
  sessions: Sessions;
  workspaces: Workspaces;
  store: StateStore;
  pins: Pins;
  trash: Trash;
  stops: StopStore;
  /** 优雅关闭：断开 WS、停止 HTTP、结束所有 claude 进程。 */
  stop(): Promise<void>;
}

function readVersion(): string {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SERVER_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return j.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function findWebDist(): string | null {
  // 独立服务端包（server/scripts/bundle.mjs）：server.mjs 同目录下的 web/；源码运行：仓库里的 web/dist
  for (const dir of [path.join(HERE, 'web'), path.resolve(SERVER_ROOT, '..', 'web', 'dist')]) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

const HEARTBEAT_MS = 30_000;

export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  const bindHost = opts.host ?? process.env.COSYEE_HOST ?? '127.0.0.1';
  if (bindHost !== TAILSCALE_MODE && !net.isIPv4(bindHost)) throw new Error(`监听地址必须是 IPv4 地址或 tailscale: ${bindHost}`);
  const wantPort = opts.port ?? (process.env.COSYEE_PORT ? Number(process.env.COSYEE_PORT) : 7878);
  const webDist = opts.webDist === undefined ? findWebDist() : opts.webDist;

  const store = new StateStore(opts.stateFile);
  const workspaces = new Workspaces(store);
  const dots = new DotState(store);
  const sessions = new Sessions(dots);
  const delegateRecord = new DelegateRecorder(path.join(opts.stateFile ? path.dirname(opts.stateFile) : cosyeeHome(), 'delegates'));
  // Pins 的到期回调需要 manager，manager 又需要 pins：用闭包延后取
  let notifySidebar: () => void = () => {};
  const pins = new Pins(store, { onExpire: () => notifySidebar() });
  const stops = new StopStore(store);
  const trash = new Trash(store, dots, pins, undefined, stops);
  const toolStats = new ToolStatsStore();
  const compactStats = new CompactStatsStore();
  // 多账号：manager / sessions 与 accounts 互相需要，同样用闭包延后取
  let accounts: Accounts | null = null;
  let agyAccounts: AgyAccounts | null = null;
  let codexAccounts: CodexAccounts | null = null;
  let kiro: KiroService | null = null;
  // 保活委派路线里用到的 agy / codex 账号（子代理模式为 delegate 时）
  const heldAccountsFor = (backend: 'agy' | 'codex'): string[] => {
    const cfg = store.state.subagents;
    if (cfg.mode !== 'delegate') return [];
    const ids: string[] = [];
    for (const r of [cfg.delegate.default, ...Object.values(cfg.delegate.agents ?? {})]) {
      if (r?.backend === backend && !ids.includes(r.accountId)) ids.push(r.accountId);
    }
    return ids;
  };
  const acpPool = new AcpPool({
    activeAccountId: () => agyAccounts?.activeId() ?? '',
    heldAccountIds: () => heldAccountsFor('agy'),
    onProcReady: (id, pid) => void agyAccounts?.refreshFromLiveProc(id, pid, { retry: true }),
    onRunFinished: (id) => void agyAccounts?.refreshFromLiveProc(id),
  });
  // 账本：Kiro 账号每轮结束后节流查余额（只在 kiro.rs 已运行时查，不额外启动）
  const kiroBalanceCollector = new KiroBalanceCollector({
    fetchBalance: async (accountId) => {
      if (!kiro?.proxy.isRunning()) return null;
      try {
        return await kiro.balance(accountId);
      } catch {
        return null;
      }
    },
  });
  const onExitPool = () => acpPool.dispose(true);
  process.once('exit', onExitPool);
  const agyCli = new AgyCli({ pool: acpPool });
  const agyBackend = new AgyBackend({
    pool: acpPool,
    accounts: {
      activeAccount: () => agyAccounts?.activeAccount() ?? null,
      accountFor: (id) => agyAccounts?.accountFor(id) ?? null,
      isLoggedIn: () => agyAccounts?.activeLoggedIn() ?? null,
      isAccountLoggedIn: (id) => agyAccounts?.loggedIn(id) ?? null,
    },
  });
  let notifyCodexChanged: () => void = () => {};
  const codexPool = new CodexPool({
    activeAccountId: () => codexAccounts?.activeId() ?? DEFAULT_ID,
    heldAccountIds: () => heldAccountsFor('codex'),
    onRateLimits: (id, raw) => codexAccounts?.noteRateLimits(id, raw),
  });
  const onExitCodexPool = () => codexPool.dispose(true);
  process.once('exit', onExitCodexPool);
  let codexBackend!: CodexBackend;
  const codexCli = new CodexCli({
    pool: codexPool,
    onUpdated: () => {
      codexBackend.clearIncompatible();
      notifyCodexChanged();
    },
    onChanged: () => notifyCodexChanged(),
  });
  codexBackend = new CodexBackend({
    pool: codexPool,
    resolve: resolveCodexInfo,
    version: () => codexCli.cachedVersion(),
    accounts: {
      active: () => codexAccounts?.active() ?? { id: DEFAULT_ID, dir: null },
      accountFor: (id) => codexAccounts?.accountFor(id) ?? (id === DEFAULT_ID ? { id: DEFAULT_ID, dir: null } : null),
      activeLoggedIn: () => codexAccounts?.activeLoggedIn() ?? 'unknown',
      loggedIn: (id) => codexAccounts?.loggedIn(id) ?? (id === DEFAULT_ID ? 'unknown' : null),
    },
    onChanged: () => notifyCodexChanged(),
  });
  codexCli.prefetchVersion();
  const claudeBackend = new ClaudeBackend({
    claudePath: opts.claudePath,
    subagentAccountId: () => accounts?.subagentClaudeId() ?? DEFAULT_ID,
    isLoggedIn: () => accounts?.subagentClaudeLoggedIn() ?? true,
    isAccountLoggedIn: (id) => (accounts ? accounts.claudeLoggedIn(id) : id === DEFAULT_ID ? true : null),
    prepareAccount: (id) => accounts?.prepareSubagent(id) ?? null,
    finishAccount: (id) => accounts?.syncSubagentBack(id),
  });
  sessions.setFlags({
    isDeleted: (id) => trash.isDeleted(id),
    pinKind: (id) => pins.kind(id),
    configOf: (id) => store.state.sessionConfigs[id] ?? null,
    forkSrcOf: (id) => store.state.forks[id]?.src ?? null,
    delegateEntries: (id, toolUseId) => delegateRecord.read(id, toolUseId),
    delegateUsages: (id) => delegateRecord.listUsage(id),
    // 并行模式下会话列表标出账号：正在运行的进程用的账号优先，否则看绑定
    accountOf: (id) => {
      if (!accounts || accounts.mode() !== 'parallel') return null;
      const acc = manager.runnerAccount(id) ?? accounts.boundAccount(id);
      return acc ? accounts.displayName(acc) : null;
    },
  });
  // 内置浏览器（agent-browser）与 2FA 共用 <数据目录>/claude-plugin 本地插件目录
  const dataHome = () => (opts.stateFile ? path.dirname(opts.stateFile) : cosyeeHome());
  const browserInstall = new BrowserInstall({ rootDir: () => path.join(dataHome(), 'agent-browser') });
  const browserPlugin = () => {
    void browserInstall.ensureSkills();
    const pluginDir = path.join(dataHome(), 'claude-plugin');
    ensureBrowserPlugin({ pluginDir, dataDir: path.join(dataHome(), 'browser'), install: browserInstall });
    ensureTwoFaPlugin({ pluginDir });
    return pluginDir;
  };
  let actualPort = wantPort;
  const agentToken = opts.agentToken ?? crypto.randomBytes(32).toString('hex');
  // 监听 0.0.0.0 或 tailscale 时 127.0.0.1 可达且通过 hostAllowed；监听指定非回环 IPv4 时用该 IP
  const agentApiHost = bindHost === '0.0.0.0' || bindHost === TAILSCALE_MODE ? '127.0.0.1' : bindHost;
  const manager = new Manager({
    onKiroTurnEnd: (id) => kiroBalanceCollector.poll(id),
    codexAccountKind: (id) => codexAccounts?.accountKind(id) ?? 'subscription',
    pluginDir: browserPlugin,
    extraEnv: () => ({
      COSYEE_API_URL: `http://${agentApiHost}:${actualPort}`,
      COSYEE_AGENT_TOKEN: agentToken,
    }),
    dots,
    sessions,
    pins,
    stops,
    delegateRecord,
    delegateBackends: { claude: claudeBackend, agy: agyBackend, codex: codexBackend },
    delegateAccounts: () => {
      const out: SubagentAccountOption[] = [];
      for (const a of accounts?.list().list ?? [{ id: DEFAULT_ID, label: '默认账号', name: null, loggedIn: true, isDefault: true }]) {
        if (!a.loggedIn) continue;
        const e = a as { api?: unknown; kiro?: unknown };
        out.push({ backend: 'claude', id: a.id, label: a.label || a.name || (a.isDefault ? '默认账号' : a.id), group: e.kiro ? 'kiro' : e.api ? 'api' : 'claude' });
      }
      for (const a of agyAccounts?.list().list ?? []) {
        if (a.loggedIn === false) continue;
        out.push({ backend: 'agy', id: a.id, label: a.label || a.email || a.id, group: 'agy' });
      }
      for (const a of codexAccounts?.list().list ?? []) {
        if (a.loggedIn === false) continue;
        out.push({ backend: 'codex', id: a.id, label: a.label || a.email || (a.isDefault ? '默认账号' : a.id), group: 'codex' });
      }
      return out;
    },
    timings: opts.timings,
    claudePath: opts.claudePath,
    configs: {
      get: (id) => store.state.sessionConfigs[id] ?? null,
      set: (id, c) => {
        const cur = store.state.sessionConfigs[id];
        if (cur && cur.model === c.model && cur.effort === c.effort && !!cur.ultracode === !!c.ultracode && (cur.permissionMode ?? 'auto') === (c.permissionMode ?? 'auto')) return;
        delete store.state.sessionConfigs[id]; // 重新插入，保持「最近使用」在末尾
        store.state.sessionConfigs[id] = {
          model: c.model,
          effort: c.effort,
          ...(c.ultracode ? { ultracode: true } : {}),
          ...(c.permissionMode === 'plan' ? { permissionMode: 'plan' as const } : {}), // auto 是缺省，不存
        };
        const keys = Object.keys(store.state.sessionConfigs);
        for (const k of keys.slice(0, Math.max(0, keys.length - MAX_SESSION_CONFIGS))) delete store.state.sessionConfigs[k];
        store.save();
      },
    },
    tools: {
      get: () => store.state.disabledTools,
      set: (names) => {
        store.state.disabledTools = [...names];
        store.save();
      },
      agents: () => store.state.disabledAgents,
      setAgents: (names) => {
        store.state.disabledAgents = [...names];
        store.save();
      },
      known: () => store.state.knownTools,
      setKnown: (names) => {
        const cur = store.state.knownTools;
        if (cur.length === names.length && cur.every((n, i) => n === names[i])) return;
        store.state.knownTools = [...names];
        store.save();
      },
      knownDeferred: () => store.state.knownDeferredTools,
      setKnownDeferred: (names) => {
        const cur = store.state.knownDeferredTools;
        if (cur.length === names.length && cur.every((n, i) => n === names[i])) return;
        store.state.knownDeferredTools = [...names];
        store.save();
      },
    },
    subagents: {
      get: () => store.state.subagents,
      set: (c) => {
        store.state.subagents = structuredClone(c);
        store.save();
      },
    },
    compactWindow: {
      get: () => store.state.compactWindow,
      set: (w) => {
        store.state.compactWindow = w;
        store.save();
      },
    },
    skills: {
      get: () => store.state.skillOverrides,
      set: (name, mode) => {
        store.state.skillOverrides[name] = mode;
        store.save();
      },
      remove: (name) => {
        delete store.state.skillOverrides[name];
        store.save();
      },
      setMany: (modes) => {
        Object.assign(store.state.skillOverrides, modes);
        store.save();
      },
    },
    accounts: {
      resolve: (id) => accounts?.resolve(id) ?? { id: DEFAULT_ID, dir: null },
      activeDir: () => accounts?.activeDir() ?? null,
      prepare: (id) => accounts?.prepare(id),
      syncFromSubagent: (id) => accounts?.syncSubagentBack(id, { silent: true }),
      bind: (sid, id) => accounts?.bind(sid, id),
      isApi: (id) => accounts?.isApi(id) ?? false,
      isKiro: (id) => accounts?.isKiro(id) ?? false,
    },
    forks: {
      set: (sessionId, cwd, src) => {
        store.state.forks[sessionId] = { cwd, src, at: Date.now() };
        store.save();
      },
    },
  });
  notifySidebar = () => manager.notifySidebar();
  notifyCodexChanged = () => {
    manager.notifyCodex();
    manager.notifySubagents();
  };
  // 账号信息与额度按账号分开缓存（并行模式下每个会话看它自己账号的）
  const accountInfos = new Map<string, AccountProvider>();
  const usages = new Map<string, UsageProvider>();
  const modelLists = new Map<string, CliModelsProvider>();
  const modelsDisk = new CliModelsDisk(opts.cliModels === false ? null : path.join(opts.stateFile ? path.dirname(opts.stateFile) : cosyeeHome(), 'cli-models.json'));
  const providerFor = <T>(map: Map<string, T>, make: (dir: string | null) => T, id: string, dir: string | null): T => {
    let p = map.get(id);
    if (!p) map.set(id, (p = make(dir)));
    return p;
  };
  const activeAccount = () => accounts ? { id: accounts.activeId(), dir: accounts.activeDir() } : { id: DEFAULT_ID, dir: null };
  const account = {
    get: () => {
      const a = activeAccount();
      // Kiro 账号：名字用备注名 / Kiro，套餐显示为 Kiro
      if (accounts?.isKiro(a.id)) return Promise.resolve({ name: accounts.displayName(a.id) ?? 'Kiro', plan: 'Kiro' });
      // API 账号没有 claude.ai 登录信息：名字用备注名 / 主机名，套餐显示为 API
      if (accounts?.isApi(a.id)) return Promise.resolve({ name: accounts.displayName(a.id) ?? 'API', plan: 'API' });
      return providerFor(accountInfos, (d) => new AccountProvider(d), a.id, a.dir).get();
    },
  };
  const usage = {
    get: (refresh: boolean, session?: string | null, accountId?: string | null) => {
      // account 优先（账号菜单里逐个账号看额度）：必须是已存在的账号，各账号各自缓存
      if (accountId) {
        const dir = accounts?.dirFor(accountId) ?? (accountId === DEFAULT_ID ? null : undefined);
        if (dir === undefined) throw new HttpError(404, '账号不存在');
        // API 账号按量计费，没有订阅额度
        if (accounts?.isApi(accountId)) return Promise.resolve(null);
        return wrapClaudeUsageFetch(accountId, 'subscription', providerFor(usages, (d) => new UsageProvider(() => fetchUsage(d)), accountId, dir).get(refresh));
      }
      const a = session && isSafeId(session) && accounts ? accounts.resolve(session) : activeAccount();
      if (accounts?.isApi(a.id)) return Promise.resolve(null);
      return wrapClaudeUsageFetch(a.id, 'subscription', providerFor(usages, (d) => new UsageProvider(() => fetchUsage(d)), a.id, a.dir).get(refresh));
    },
  };
  // 模型菜单：账号实际可用的模型。与额度不同，API 账号也要（别名重映射会体现在里面）
  const cliModels = {
    get: async (refresh: boolean, session?: string | null, accountId?: string | null) => {
      let a: { id: string; dir: string | null };
      if (accountId) {
        const dir = accounts?.dirFor(accountId) ?? (accountId === DEFAULT_ID ? null : undefined);
        if (dir === undefined) throw new HttpError(404, '账号不存在');
        a = { id: accountId, dir };
      } else {
        a = session && isSafeId(session) && accounts ? accounts.resolve(session) : activeAccount();
      }
      // Kiro 账号：刷新时先从内置服务重新拉模型并写回映射（会触发账号重置），再取模型表；拉取失败保留旧映射
      if (refresh && accounts?.isKiro(a.id)) await kiro?.refreshModels(a.id).catch(() => false);
      const fetcher = opts.fetchCliModels ?? fetchCliModels;
      return providerFor(modelLists, (d) => new CliModelsProvider({ id: a.id, fetcher: () => fetcher(d), disk: modelsDisk }), a.id, a.dir).get(refresh);
    },
  };
  const claudeRunning = (id?: string) => manager.runningCount(id) + claudeBackend.runningCount(id);
  accounts = new Accounts({
    store,
    running: claudeRunning,
    processes: (id) => manager.processCount(id),
    stop: (match) => (match ? manager.stopAccounts(match, 5000) : manager.resetAll(5000)),
    kiroState: (id, dir) => kiro?.accountState(id, dir) ?? { proxy: 'stopped', error: null, credential: 'unknown' },
    removeKiroAccount: (id, dir) => kiro?.removeAccount(id, dir) ?? Promise.resolve(),
    onChanged: (e) => {
      accounts?.invalidateLoginCache(e.reset);
      if (e.reset) {
        accountInfos.get(e.reset)?.reset();
        usages.get(e.reset)?.reset();
        accountInfos.delete(e.reset);
        usages.delete(e.reset);
        // 凭据 / API 配置 / 映射变了：模型表要重拉（provider 还没建过也要清掉落盘的）
        (modelLists.get(e.reset) ?? new CliModelsProvider({ id: e.reset, fetcher: async () => null, disk: modelsDisk })).reset();
        modelLists.delete(e.reset);
      }
      if (e.notify === 'reload') {
        manager.notifyAccount(true);
        manager.notifySubagents();
      } else if (e.notify === 'refresh') {
        manager.notifyAccount(false);
        manager.notifySubagents();
      } else if (e.reset) {
        manager.notifySubagents();
      }
    },
  });
  accounts.init();
  kiro = new KiroService({
    accounts: {
      listKiroAccounts: () => accounts!.listKiroAccounts(),
      allocateNewDir: () => accounts!.allocateKiroDir(),
      existingKiroDir: (id) => accounts!.existingKiroDir(id),
      kiroEmailTaken: (email, except) => accounts!.kiroEmailTaken(email, except),
      running: claudeRunning,
      stopAccountProcesses: (id) => accounts!.stopAccountProcesses(id),
      commitNew: (id, dir, label) => accounts!.commitNewKiro(id, dir, label),
      commitRelogin: (id, label) => accounts!.commitReloginKiro(id, label),
      discardDir: (dir) => accounts!.discardKiroDir(dir),
      modelsChanged: (id) => accounts!.kiroModelsChanged(id),
      infoChanged: () => accounts!.kiroInfoChanged(),
    },
  });
  kiro.init();
  setBeforeClaudeEnv(() => kiro?.proxy.kick());
  const onExitKiro = () => kiro?.disposeSync();
  process.once('exit', onExitKiro);
  agyAccounts = new AgyAccounts({
    store,
    running: (id) => acpPool.runningCount(id),
    livePids: (id) => acpPool.livePids(id),
    stopAccount: (id) => acpPool.stopAccount(id),
    resetAccount: (id) => acpPool.resetAccount(id),
    onChanged: () => {
      manager.notifyAgy();
      manager.notifySubagents();
    },
  });
  agyAccounts.init();
  codexAccounts = new CodexAccounts({
    store,
    running: (id) => codexPool.runningCount(id),
    stopAccount: (id) => codexPool.stopAccount(id),
    resetAccount: (id) => codexPool.resetAccount(id),
    readAccount: (o) => codexPool.readAccount(o),
    readRateLimits: (o) => codexPool.readRateLimitsRaw(o),
    onChanged: () => notifyCodexChanged(),
  });
  codexAccounts.init();
  const previews = new Previews();
  const pricing = opts.pricing ?? new PricingService({ file: path.join(opts.stateFile ? path.dirname(opts.stateFile) : cosyeeHome(), 'pricing.json') });
  pricing.start?.();
  let ledger: LedgerService | null = null;
  try {
    const created = createLedger({
      path: path.join(dataHome(), 'usage-ledger.sqlite'),
      prices: () => pricing.table(),
      accountInfo: (backend, accountId) => {
        if (backend === 'claude') {
          const name = accounts?.displayName(accountId) ?? null;
          return name ? { name } : null;
        }
        if (backend === 'agy') {
          const a = agyAccounts?.list().list.find((x) => x.id === accountId);
          const name = a ? (a.label || a.email || null) : null;
          return name ? { name } : null;
        }
        if (backend === 'codex') {
          const ref = codexAccounts?.accountFor(accountId);
          if (ref?.label) return { name: ref.label };
          const a = codexAccounts?.list().list.find((x) => x.id === accountId);
          const name = a ? (a.label || a.email || (a.isDefault ? '默认账号' : null)) : null;
          return name ? { name } : null;
        }
        return null;
      },
    });
    if (created.enabled()) {
      ledger = created;
      setLedgerSink(ledger.sink);
    }
  } catch (e) {
    console.warn('[ledger] 初始化失败，已停用账本（不影响服务启动）:', e);
    ledger = null;
  }
  // 账本：Claude 订阅账号近 5 小时有活动但当前空闲时，每 5 分钟补一个额度快照（复用 UsageProvider 缓存）
  const ledgerProbes = ledger
    ? startLedgerProbes({
        getUsage: (id) => {
          const dir = accounts?.dirFor(id) ?? (id === DEFAULT_ID ? null : undefined);
          if (dir === undefined) return Promise.resolve(null);
          return providerFor(usages, (d) => new UsageProvider(() => fetchUsage(d)), id, dir).get(false).catch(() => null);
        },
        isRunning: (id) => claudeRunning(id) > 0,
        accountKind: (id) => (accounts?.isKiro(id) ? 'kiro' : accounts?.isApi(id) ? 'api' : 'subscription'),
        listClaudeAccounts: () => [DEFAULT_ID, ...(store.state.accounts?.list ?? []).map((a) => a.id).filter((id) => id !== DEFAULT_ID)],
      })
    : null;
  const stopUploadSweeper = startUploadSweeper();

  const browser = new BrowserManager({ install: browserInstall, dataDir: () => path.join(dataHome(), 'browser') });

  // 本机组件版本与自动更新。服务端自己：源码运行（没有打包注入的版本）或桌面版（带访问令牌）只显示不更新
  const components = new ComponentUpdater({
    home: () => (opts.stateFile ? path.dirname(opts.stateFile) : cosyeeHome()),
    onUpdated: (id) => {
      if (id === 'codex') {
        codexPool.retireAll();
        codexBackend.clearIncompatible();
        notifyCodexChanged();
        return;
      }
      if (id === 'claude' || id === 'agy') manager.notifySubagents();
    },
    adapters: [
      createClaudeAdapter({ claudePath: opts.claudePath, running: () => manager.runningCount() }),
      createKiroAdapter(kiro),
      createAgyAdapter(agyCli),
      createCodexAdapter(codexCli),
      createBrowserAdapter(browserInstall, browser),
      createServerAdapter({
        version: opts.version ?? readVersion(),
        custom: opts.version === undefined || opts.authToken !== undefined,
        running: () => manager.runningCount(),
      }),
    ],
  });
  components.start();

  const speech = new Speech();
  const twoFa = new TwoFaService({
    dir: () => path.join(dataHome(), '2fa'),
    fetch: opts.twoFaFetch,
    getToken: opts.twoFaGetToken,
    onChange: () => manager.notifyTwoFa(),
  });
  const terminals = new TerminalManager({ workspaces, dataDir: dataHome });
  const handler = createHandler({
    delegateModels: (cwd, refresh, backend, account) =>
      (backend === 'claude' ? claudeBackend : backend === 'codex' ? codexBackend : agyBackend).models({ cwd, refresh, ...(account ? { accountId: account } : {}) }),
    port: () => actualPort,
    version: opts.version ?? readVersion(),
    webDist,
    workspaces,
    sessions,
    manager,
    account,
    accounts,
    agyAccounts,
    codexAccounts,
    components,
    browser,
    kiro,
    usage,
    cliModels,
    store,
    previews,
    pins,
    trash,
    pricing,
    ...(ledger ? { ledger } : {}),
    toolStats,
    compactStats,
    spawner: opts.spawner,
    authToken: opts.authToken,
    agentToken,
    host: bindHost,
    onShutdown: opts.onShutdown,
    speech,
    twoFa,
    httpsUrl: opts.httpsUrl,
  });

  if (opts.prefetchSpeech) {
    speech.prepare('tts');
    speech.prepare('stt');
  }

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  // Tailscale 模式：不是本机、也不是从 tailnet 打到本机 Tailscale 地址的连接，在 TCP 层直接断开
  server.on('connection', (socket) => {
    if (!connectionAllowed(socket.localAddress, socket.remoteAddress, bindHost)) socket.destroy();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  // 内置浏览器画面：转发 agent-browser 的推流（帧是服务端发出的，前端只发输入，消息很小）
  const browserWss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const terminalWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const reject = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      if (opts.authToken && !requestAuthorized(req.headers, actualPort, opts.authToken)) return reject(403, 'Forbidden');
      if (url.pathname !== '/ws' && url.pathname !== '/api/browser/stream' && url.pathname !== '/api/terminal/ws') return reject(404, 'Not Found');
      if (!hostAllowed(req.headers.host, actualPort, bindHost)) return reject(403, 'Forbidden');
      const origin = req.headers.origin;
      if (!originAllowed(typeof origin === 'string' ? origin : undefined, actualPort, bindHost)) return reject(403, 'Forbidden');
      if (url.pathname === '/api/browser/stream') {
        browserWss.handleUpgrade(req, socket, head, (ws) => void browser.attach(ws, url.searchParams.get('profile')));
        return;
      }
      if (url.pathname === '/api/terminal/ws') {
        terminalWss.handleUpgrade(req, socket, head, (ws) => {
          alive.set(ws, true);
          ws.on('pong', () => alive.set(ws, true));
          void terminals.attach(ws, url.searchParams.get('root'));
        });
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
    } catch {
      reject(400, 'Bad Request');
    }
  });

  const alive = new WeakMap<WebSocket, boolean>();
  function onConnection(ws: WebSocket): void {
    alive.set(ws, true);
    ws.on('pong', () => alive.set(ws, true));
    const client = {
      send(msg: ServerMsg): void {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
    };
    manager.addClient(client);
    ws.on('message', (data) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(data.toString('utf8')) as ClientMsg;
      } catch {
        return client.send({ t: 'error', message: '消息不是合法 JSON' });
      }
      manager.handle(client, msg);
    });
    const cleanup = () => manager.removeClient(client);
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  // 心跳：每 30s 发 ping；上一轮没回 pong 的连接直接终止
  const heartbeat = setInterval(() => {
    for (const set of [wss.clients, terminalWss.clients]) {
      for (const ws of set) {
        if (alive.get(ws) === false) {
          ws.terminate();
          continue;
        }
        alive.set(ws, false);
        try {
          ws.ping();
        } catch { /* 已断开 */ }
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(wantPort, listenAddress(bindHost), () => {
      server.off('error', reject);
      resolve();
    });
  });
  actualPort = (server.address() as AddressInfo).port;
  twoFa.start();

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(heartbeat);
      twoFa.dispose();
      pins.dispose();
      accounts?.dispose();
      agyAccounts?.dispose();
      agyCli.dispose();
      codexAccounts?.dispose();
      codexCli.dispose();
      components.stop();
      browser.dispose();
      browserWss.close();
      for (const ws of terminalWss.clients) ws.terminate();
      terminalWss.close();
      await terminals.dispose();
      setBeforeClaudeEnv(null);
      process.off('exit', onExitKiro);
      await kiro?.dispose();
      process.off('exit', onExitPool);
      acpPool.dispose();
      process.off('exit', onExitCodexPool);
      codexPool.dispose();
      pricing.stop?.();
      ledgerProbes?.stop();
      setLedgerSink(null);
      try {
        ledger?.close();
      } catch { /* 忽略关闭失败 */ }
      stopUploadSweeper();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await manager.shutdown(5000);
      await store.idle();
    })();
    return stopping;
  };

  return { port: actualPort, agentToken, manager, sessions, workspaces, store, pins, trash, stops, stop };
}
