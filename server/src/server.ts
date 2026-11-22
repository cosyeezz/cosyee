// 组装并启动服务：HTTP + WebSocket。index.ts 与 smoke 脚本都通过 startServer 使用它。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClientMsg, ServerMsg } from '@cosyee/shared';
import { WebSocket, WebSocketServer } from 'ws';
import { AccountProvider } from './account.js';
import { Accounts, DEFAULT_ID } from './accounts/index.js';
import { Manager } from './claude/manager.js';
import type { RunnerTimings } from './claude/runner.js';
import { createHandler, hostAllowed } from './http.js';
import { Pins } from './pins.js';
import { Previews } from './preview.js';
import type { Spawner } from './reveal.js';
import { isSafeId } from './paths.js';
import { TAILSCALE_MODE, connectionAllowed, listenAddress, originAllowed, requestAuthorized } from './security.js';
import { Sessions } from './sessions.js';
import { Trash } from './trash.js';
import { ToolStatsStore } from './toolStats.js';
import { CompactStatsStore } from './compactStats.js';
import { DotState } from './state.js';
import { UsageProvider, fetchUsage } from './usage.js';
import { HttpError, StateStore, Workspaces } from './workspaces.js';

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
}

export interface RunningServer {
  port: number;
  manager: Manager;
  sessions: Sessions;
  workspaces: Workspaces;
  store: StateStore;
  pins: Pins;
  trash: Trash;
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
  // Pins 的到期回调需要 manager，manager 又需要 pins：用闭包延后取
  let notifySidebar: () => void = () => {};
  const pins = new Pins(store, { onExpire: () => notifySidebar() });
  const trash = new Trash(store, dots, pins);
  const toolStats = new ToolStatsStore();
  const compactStats = new CompactStatsStore();
  // 多账号：manager / sessions 与 accounts 互相需要，同样用闭包延后取
  let accounts: Accounts | null = null;
  sessions.setFlags({
    isDeleted: (id) => trash.isDeleted(id),
    pinKind: (id) => pins.kind(id),
    configOf: (id) => store.state.sessionConfigs[id] ?? null,
    // 并行模式下会话列表标出账号：正在运行的进程用的账号优先，否则看绑定
    accountOf: (id) => {
      if (!accounts || accounts.mode() !== 'parallel') return null;
      const acc = manager.runnerAccount(id) ?? accounts.boundAccount(id);
      return acc ? accounts.displayName(acc) : null;
    },
  });
  const manager = new Manager({
    dots,
    sessions,
    pins,
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
      prepare: (id) => accounts?.prepare(id),
      bind: (sid, id) => accounts?.bind(sid, id),
    },
  });
  notifySidebar = () => manager.notifySidebar();
  // 账号信息与额度按账号分开缓存（并行模式下每个会话看它自己账号的）
  const accountInfos = new Map<string, AccountProvider>();
  const usages = new Map<string, UsageProvider>();
  const providerFor = <T>(map: Map<string, T>, make: (dir: string | null) => T, id: string, dir: string | null): T => {
    let p = map.get(id);
    if (!p) map.set(id, (p = make(dir)));
    return p;
  };
  const activeAccount = () => accounts ? { id: accounts.activeId(), dir: accounts.activeDir() } : { id: DEFAULT_ID, dir: null };
  const account = {
    get: () => {
      const a = activeAccount();
      return providerFor(accountInfos, (d) => new AccountProvider(d), a.id, a.dir).get();
    },
  };
  const usage = {
    get: (refresh: boolean, session?: string | null, accountId?: string | null) => {
      // account 优先（账号菜单里逐个账号看额度）：必须是已存在的账号，各账号各自缓存
      if (accountId) {
        const dir = accounts?.dirFor(accountId) ?? (accountId === DEFAULT_ID ? null : undefined);
        if (dir === undefined) throw new HttpError(404, '账号不存在');
        return providerFor(usages, (d) => new UsageProvider(() => fetchUsage(d)), accountId, dir).get(refresh);
      }
      const a = session && isSafeId(session) && accounts ? accounts.resolve(session) : activeAccount();
      return providerFor(usages, (d) => new UsageProvider(() => fetchUsage(d)), a.id, a.dir).get(refresh);
    },
  };
  accounts = new Accounts({
    store,
    running: (id) => manager.runningCount(id),
    processes: (id) => manager.processCount(id),
    stop: (match) => (match ? manager.stopAccounts(match, 5000) : manager.resetAll(5000)),
    onChanged: (e) => {
      if (e.reset) {
        accountInfos.get(e.reset)?.reset();
        usages.get(e.reset)?.reset();
        accountInfos.delete(e.reset);
        usages.delete(e.reset);
      }
      if (e.notify === 'reload') manager.notifyAccount(true);
      else if (e.notify === 'refresh') manager.notifyAccount(false);
    },
  });
  accounts.init();
  const previews = new Previews();

  let actualPort = wantPort;
  const handler = createHandler({
    port: () => actualPort,
    version: opts.version ?? readVersion(),
    webDist,
    workspaces,
    sessions,
    manager,
    account,
    accounts,
    usage,
    store,
    previews,
    pins,
    trash,
    toolStats,
    compactStats,
    spawner: opts.spawner,
    authToken: opts.authToken,
    host: bindHost,
    onShutdown: opts.onShutdown,
  });

  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  // Tailscale 模式：不是本机、也不是从 tailnet 打到本机 Tailscale 地址的连接，在 TCP 层直接断开
  server.on('connection', (socket) => {
    if (!connectionAllowed(socket.localAddress, socket.remoteAddress, bindHost)) socket.destroy();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const reject = (code: number, text: string) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      if (opts.authToken && !requestAuthorized(req.headers, actualPort, opts.authToken)) return reject(403, 'Forbidden');
      if (url.pathname !== '/ws') return reject(404, 'Not Found');
      if (!hostAllowed(req.headers.host, actualPort, bindHost)) return reject(403, 'Forbidden');
      const origin = req.headers.origin;
      if (!originAllowed(typeof origin === 'string' ? origin : undefined, actualPort, bindHost)) return reject(403, 'Forbidden');
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
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      try {
        ws.ping();
      } catch { /* 已断开 */ }
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

  let stopping: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      clearInterval(heartbeat);
      pins.dispose();
      accounts?.dispose();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      await manager.shutdown(5000);
      await store.idle();
    })();
    return stopping;
  };

  return { port: actualPort, manager, sessions, workspaces, store, pins, trash, stop };
}
