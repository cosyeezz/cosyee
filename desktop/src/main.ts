// Cosyee 桌面版主进程。
//
//   Electron 主进程
//    ├─ utilityProcess.fork(server.mjs)   现有后端；地址和端口来自 userData/config.json（默认 127.0.0.1:7878），带访问令牌
//    │     └─ claude 子进程
//    ├─ BrowserWindow.loadURL("http://<host>:<port>/")   主窗口
//    ├─ Tray                              托盘菜单（打开窗口 / 在浏览器中打开 / 复制访问链接 / 地址和端口… / 退出）
//    └─ 设置窗口（settings.html，独立页面）  改监听地址和端口、重新生成令牌
//
// 前端只用相对 URL（fetch('/api/..')、WebSocket 到 location.host），所以窗口直接加载后端地址即可，前端零改动。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserWindow, Menu, Tray, app, clipboard, dialog, ipcMain, nativeImage, session, shell, utilityProcess } from 'electron';
import type { IpcMainInvokeEvent, NativeImage, UtilityProcess } from 'electron';
import { type Config, DEFAULT_HOST, DEFAULT_PORT, isLoopback, loadConfig, newToken, saveConfig, validate } from './config';

const TOKEN_HEADER = 'x-cosyee-token';

/**
 * 开发模式（COSYEE_DESKTOP_DEV=1，由 scripts/dev.mjs 设置）：
 * 不拉起后端，直接加载 Vite（默认 http://127.0.0.1:5273/）以便热更新；后端由 `npm run dev:desktop` 另行启动在 7878。
 * 开发模式下**不启用访问令牌**：Vite 的代理不会替我们加 x-cosyee-token 头，后端也没配 authToken，行为与网页版开发一致。
 * 开发模式也不读 config.json、不建托盘，设置窗口只能看不能保存。
 */
const isDev = process.env.COSYEE_DESKTOP_DEV === '1';
const devUrl = `http://127.0.0.1:${Number(process.env.COSYEE_WEB_PORT) || 5273}/`;
const devApi = `http://127.0.0.1:${Number(process.env.COSYEE_PORT) || 7878}`;

app.setName('Cosyee');

// ───────────── 日志 ─────────────

let logFile: string | null = null;
function log(...a: unknown[]): void {
  const line = `${new Date().toISOString()} ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  try {
    logFile ??= path.join(app.getPath('logs'), 'desktop.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, line + '\n');
  } catch { /* 日志写不了不影响运行 */ }
}

// ───────────── 路径 ─────────────

/** 打包后后端 / 前端放在 resources/ 下（extraResources）；未打包时用 desktop/dist 与 web/dist。 */
function serverEntry(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'server', 'server.mjs')
    : path.join(__dirname, 'server', 'server.mjs');
}
function webDist(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '..', '..', 'web', 'dist');
}

// ───────────── macOS：从登录 shell 取 PATH ─────────────
// 从 Finder / Dock 启动的应用拿不到用户 shell 里配置的 PATH（找不到 claude），所以打包后先问一次登录 shell。

function fixMacPath(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  try {
    const shellPath = process.env.SHELL || '/bin/zsh';
    const out = execFileSync(shellPath, ['-ilc', 'echo -n "__COSYEE_PATH__${PATH}__COSYEE_PATH__"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const m = /__COSYEE_PATH__(.*)__COSYEE_PATH__/s.exec(out);
    if (m?.[1]) process.env.PATH = m[1];
  } catch (e) {
    log('解析登录 shell 的 PATH 失败:', String(e));
  }
}

// ───────────── 图标（代码生成，免得带二进制资源；正式图标由设计会话提供后替换） ─────────────

function makeIcon(size: number, scaleFactor = 1): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const R = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      const outer = Math.min(1, Math.max(0, R - d + 0.5)); // 外圈抗锯齿覆盖率
      const inner = Math.min(1, Math.max(0, R * 0.42 - d + 0.5)); // 中间白点
      // 橙色圆盘 #c8651b，中间白点；BGRA，预乘 alpha
      const r = 200 * (1 - inner) + 255 * inner;
      const g = 101 * (1 - inner) + 255 * inner;
      const b = 27 * (1 - inner) + 255 * inner;
      const i = (y * size + x) * 4;
      buf[i] = Math.round(b * outer);
      buf[i + 1] = Math.round(g * outer);
      buf[i + 2] = Math.round(r * outer);
      buf[i + 3] = Math.round(255 * outer);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor });
}

// ───────────── 状态 ─────────────

let cfg: Config = { host: DEFAULT_HOST, port: DEFAULT_PORT, token: '' };
let cfgFile = '';
let child: UtilityProcess | null = null;
/** 当前后端实际监听的地址和端口（"用随机端口启动"时与 cfg 不同） */
let runHost = DEFAULT_HOST;
let port = 0;
let quitState: 'idle' | 'confirming' | 'stopping' | 'done' = 'idle';
let win: BrowserWindow | null = null;
let settingsWin: BrowserWindow | null = null;
let tray: Tray | null = null;
/** 主动停掉的后端（重启 / 退出），exit 时不当崩溃处理 */
const intentional = new WeakSet<UtilityProcess>();

/** 本机连接后端用的主机名：监听 0.0.0.0 时用回环地址 */
function connectHost(): string {
  return runHost === '0.0.0.0' ? '127.0.0.1' : runHost;
}

function baseUrl(): string {
  return isDev ? devUrl : `http://${connectHost()}:${port}/`;
}

/** 局域网 IPv4（优先私网地址），用于生成「复制访问链接」。 */
function lanIp(): string | undefined {
  const all = Object.values(os.networkInterfaces())
    .flat()
    .filter((i): i is os.NetworkInterfaceInfo => !!i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  return all.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)) ?? all[0];
}

/** 带令牌的访问链接：打开后后端会种 cookie 再跳到干净地址。forCopy=true 且监听 0.0.0.0 时用局域网 IP（给别的设备用）。 */
function accessLink(forCopy: boolean): string {
  let h = runHost;
  if (h === '0.0.0.0') h = forCopy ? (lanIp() ?? '127.0.0.1') : '127.0.0.1';
  return `http://${h}:${port}/?token=${cfg.token}`;
}

/** 只给发往本后端端口（HTTP 与 WS）的请求加令牌头；每次后端换地址 / 端口（重启）后重新注册（会替换旧的）。 */
function installTokenInjection(): void {
  const h = connectHost();
  const filter = { urls: [`http://${h}:${port}/*`, `ws://${h}:${port}/*`] };
  const token = cfg.token;
  session.defaultSession.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    cb({ requestHeaders: { ...details.requestHeaders, [TOKEN_HEADER]: token } });
  });
}

// ───────────── 后端进程 ─────────────

class BackendError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

function startBackend(host: string, wantPort: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const entry = serverEntry();
    if (!fs.existsSync(entry)) return reject(new BackendError(`找不到后端文件: ${entry}`));
    const p = utilityProcess.fork(entry, [], {
      serviceName: 'Cosyee Server',
      stdio: 'pipe',
      // 令牌不放环境变量（会被 claude 子进程继承），启动后通过消息传递
      env: { ...process.env } as Record<string, string>,
    });
    child = p;
    let settled = false;
    p.stdout?.on('data', (d: Buffer) => log('[server]', d.toString('utf8').trimEnd()));
    p.stderr?.on('data', (d: Buffer) => log('[server:err]', d.toString('utf8').trimEnd()));
    p.on('message', (m: { type?: string; port?: number; message?: string; code?: string }) => {
      if (m?.type === 'ready' && typeof m.port === 'number' && !settled) {
        settled = true;
        port = m.port;
        runHost = host;
        log('后端已就绪', `${host}:${port}`, 'pid', p.pid);
        resolve(m.port);
      } else if (m?.type === 'error' && !settled) {
        settled = true;
        intentional.add(p); // 启动失败后它自己会退出，不是崩溃
        reject(new BackendError(m.message ?? '后端启动失败', m.code));
      }
    });
    p.on('exit', (code) => {
      log('后端进程退出，code =', code);
      if (child === p) child = null;
      if (!settled) {
        settled = true;
        reject(new BackendError(`后端进程启动阶段退出（code ${code}）`));
        return;
      }
      if (intentional.has(p)) return;
      if (quitState === 'idle' || quitState === 'confirming') void onBackendCrashed(code);
    });
    p.postMessage({ type: 'init', token: cfg.token, webDist: webDist(), host, port: wantPort });
  });
}

/** 优雅停止后端：发 shutdown，等它自己退出；超时则强杀进程树（含 claude 子进程）。 */
function stopBackend(timeoutMs = 10_000): Promise<void> {
  const p = child;
  if (!p) return Promise.resolve();
  intentional.add(p);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      log('后端关闭超时，强制结束');
      const pid = p.pid;
      if (process.platform === 'win32' && pid) {
        try {
          execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
        } catch { /* 已退出 */ }
      } else {
        p.kill();
      }
      resolve();
    }, timeoutMs);
    p.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    p.postMessage({ type: 'shutdown' });
  });
}

type BringUp = 'ok' | 'settings' | 'quit';

/**
 * 按当前配置拉起后端。端口被占用（或地址不可用）时弹窗：改端口（打开设置窗口）/ 用随机端口启动（仅本次）/ 退出。
 * 返回 'ok' 后端已就绪；'settings' 用户选择去改设置（后端未启动）；'quit' 用户选择退出。
 */
async function bringUp(): Promise<BringUp> {
  let host = cfg.host;
  let wantPort = cfg.port;
  for (;;) {
    try {
      await startBackend(host, wantPort);
      installTokenInjection();
      ensureTray();
      return 'ok';
    } catch (e) {
      const err = e instanceof BackendError ? e : new BackendError(String(e));
      log('后端启动失败', err.message, err.code ?? '');
      const inUse = err.code === 'EADDRINUSE';
      const portProblem = inUse || err.code === 'EACCES';
      const r = await dialog.showMessageBox({
        type: 'error',
        title: 'Cosyee',
        message: inUse ? `端口 ${wantPort} 已被占用` : `无法在 ${host}:${wantPort} 上启动`,
        detail: inUse
          ? `${host}:${wantPort} 已被其它程序占用（可能是另一个 Cosyee 或 npm run dev 的后端）。\n可以改用别的端口，或者这次先用随机端口启动。`
          : `${err.message}\n可以去修改监听地址和端口，或者这次先用 127.0.0.1 + 随机端口启动。`,
        buttons: ['改端口', portProblem ? '用随机端口启动' : '用 127.0.0.1 随机端口启动', '退出'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (r.response === 0) {
        openSettings();
        return 'settings';
      }
      if (r.response === 2) return 'quit';
      // 仅本次运行用随机端口，不改 config.json
      if (!portProblem) host = '127.0.0.1';
      wantPort = 0;
    }
  }
}

async function startup(): Promise<void> {
  const r = await bringUp();
  if (r === 'quit') {
    quitState = 'done';
    app.quit();
  } else if (r === 'ok') {
    showMain();
  }
}

/** 停掉旧后端再按（新）配置拉起，成功后让窗口重新加载。 */
async function restartBackend(): Promise<BringUp> {
  await stopBackend();
  const r = await bringUp();
  if (r === 'ok') showMain();
  else if (r === 'quit') {
    quitState = 'done';
    app.quit();
  }
  return r;
}

async function onBackendCrashed(code: number | null): Promise<void> {
  const r = await dialog.showMessageBox({
    type: 'error',
    title: 'Cosyee',
    message: '后端进程意外退出',
    detail: `退出码：${code ?? '未知'}\n正在运行的会话已中断。可以重启后端，或退出应用。日志：${logFile ?? ''}`,
    buttons: ['重启后端', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (r.response !== 0) {
    quitState = 'done';
    app.quit();
    return;
  }
  await restartBackend();
}

// ───────────── 退出 ─────────────

/** 问后端有几个会话在执行；查不到就当作 0（不拦着用户退出）。 */
async function runningCount(): Promise<number> {
  try {
    const base = isDev ? devApi : `http://${connectHost()}:${port}`;
    const r = await fetch(`${base}/api/running`, { headers: isDev ? {} : { [TOKEN_HEADER]: cfg.token }, signal: AbortSignal.timeout(2000) });
    if (!r.ok) return 0;
    const j = (await r.json()) as { count?: number };
    return typeof j.count === 'number' ? j.count : 0;
  } catch {
    return 0;
  }
}

async function beginQuit(): Promise<void> {
  if (quitState !== 'idle') return;
  quitState = 'confirming';
  const n = child || isDev ? await runningCount() : 0;
  if (n > 0) {
    const opts = {
      type: 'warning' as const,
      title: 'Cosyee',
      message: `还有 ${n} 个会话正在执行`,
      detail: '现在退出会中断它们。确定退出吗？',
      buttons: ['退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const r = win && !win.isDestroyed() && win.isVisible() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (r.response !== 0) {
      quitState = 'idle';
      return;
    }
  }
  quitState = 'stopping';
  if (win && !win.isDestroyed()) win.hide();
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.hide();
  // 开发模式后端是外部进程，由 `npm run dev:desktop` 管理，这里不动它
  if (!isDev) await stopBackend();
  quitState = 'done';
  tray?.destroy();
  tray = null;
  app.quit();
}

// ───────────── 窗口 ─────────────

function isOwnUrl(u: string): boolean {
  try {
    return new URL(u).origin === new URL(baseUrl()).origin;
  } catch {
    return false;
  }
}

function openExternalSafe(u: string): void {
  try {
    const { protocol } = new URL(u);
    if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(u);
  } catch { /* 非法 URL 忽略 */ }
}

async function waitForUrl(url: string, timeoutMs: number): Promise<void> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (r.status < 500) return;
    } catch { /* 还没起来 */ }
    if (Date.now() > end) throw new Error(`等待 ${url} 超时（开发模式请用 npm run dev:desktop 同时启动后端与 Vite）`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    title: 'Cosyee',
    icon: makeIcon(128),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  w.once('ready-to-show', () => w.show());
  // 关窗口 = 退出（有会话在跑时先确认），不最小化到托盘
  w.on('close', (e) => {
    if (quitState !== 'done') {
      e.preventDefault();
      void beginQuit();
    }
  });
  w.on('closed', () => {
    if (win === w) win = null;
  });

  const wc = w.webContents;
  // 新窗口（target=_blank / window.open）：外部链接交给系统浏览器，其它一律拒绝
  wc.setWindowOpenHandler(({ url }) => {
    if (!isOwnUrl(url)) openExternalSafe(url);
    return { action: 'deny' };
  });
  // 页内导航：只允许留在本站，其它交给系统浏览器并阻止
  wc.on('will-navigate', (e, url) => {
    if (isOwnUrl(url)) return;
    e.preventDefault();
    openExternalSafe(url);
  });
  wc.on('did-finish-load', () => log('页面加载完成', wc.getURL(), JSON.stringify(wc.getTitle())));
  wc.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (isMain) log('页面加载失败', code, desc, url);
  });
  return w;
}

/** 显示主窗口：没有就创建，有就重新加载当前后端地址（重启后端 / 换端口之后）。 */
function showMain(): void {
  if (!win || win.isDestroyed()) win = createWindow();
  void win.loadURL(baseUrl()).catch((e) => log('loadURL 失败', String(e)));
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/** 托盘「打开窗口」：只把已有窗口拉到前台，不重新加载页面。 */
function focusMain(): void {
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (child) {
    showMain();
  } else {
    openSettings();
  }
}

// ───────────── 托盘 ─────────────

function ensureTray(): void {
  if (isDev || tray) return;
  tray = new Tray(makeIcon(32, 2));
  tray.setToolTip('Cosyee');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开窗口', click: focusMain },
      { label: '在浏览器中打开', click: () => openExternalSafe(accessLink(false)) },
      { label: '复制访问链接', click: () => clipboard.writeText(accessLink(true)) },
      { label: '地址和端口…', click: openSettings },
      { type: 'separator' },
      { label: '退出', click: () => void beginQuit() },
    ]),
  );
  tray.on('click', focusMain);
}

// ───────────── 设置窗口 ─────────────

function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const w = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '地址和端口',
    icon: makeIcon(128),
    parent: win && !win.isDestroyed() ? win : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'settings-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin = w;
  w.setMenu(null);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.on('closed', () => {
    if (settingsWin === w) settingsWin = null;
    // 启动时端口被占用 -> 用户点了「改端口」却没保存就关了窗口：回到启动流程再问一次
    if (!isDev && !child && !win && quitState === 'idle') void startup();
  });
  void w.loadFile(path.join(__dirname, 'settings.html'));
}

/** 只接受设置窗口自己发来的 IPC。 */
function fromSettings(e: IpcMainInvokeEvent): boolean {
  return !!settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents;
}

type ApplyResult = { ok: true } | { ok: false; error: string };
let applying = false;

/** 保存新配置并重启后端。regen = 同时重新生成令牌（旧链接作废）。 */
async function applySettings(host: unknown, portIn: unknown, regen: boolean): Promise<ApplyResult> {
  if (isDev) return { ok: false, error: '开发模式下后端由 npm run dev:desktop 管理，请改 COSYEE_PORT 环境变量。' };
  const bad = validate(host, portIn);
  if (bad) return { ok: false, error: bad };
  if (applying) return { ok: false, error: '正在应用上一次设置，请稍候。' };
  const h = host as string;
  const p = portIn as number;
  if (!regen && h === cfg.host && p === cfg.port && child) return { ok: true };
  applying = true;
  try {
    const n = await runningCount();
    if (n > 0) {
      const opts = {
        type: 'warning' as const,
        title: 'Cosyee',
        message: `还有 ${n} 个会话正在执行`,
        detail: '重启后端会中断它们。确定继续吗？',
        buttons: ['重启后端', '取消'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const r = settingsWin && !settingsWin.isDestroyed() ? await dialog.showMessageBox(settingsWin, opts) : await dialog.showMessageBox(opts);
      if (r.response !== 0) return { ok: false, error: '已取消，设置未保存。' };
    }
    const next: Config = { host: h, port: p, token: regen ? newToken() : cfg.token };
    try {
      saveConfig(cfgFile, next);
    } catch (e) {
      return { ok: false, error: `写入配置文件失败：${String(e)}` };
    }
    cfg = next;
    log('设置已保存', `${h}:${p}`, regen ? '（令牌已重新生成）' : '');
    const r = await restartBackend();
    if (r === 'settings') return { ok: false, error: '新的地址 / 端口不可用，设置已保存但后端未启动。请换一个端口再保存。' };
    return { ok: true };
  } finally {
    applying = false;
  }
}

function registerIpc(): void {
  // 主窗口 preload 的 openSettings()：只认加载本站页面的主窗口
  ipcMain.handle('desktop:open-settings', (e) => {
    const url = e.senderFrame?.url ?? '';
    if (win && e.sender === win.webContents && isOwnUrl(url)) openSettings();
  });
  // 用 Electron 原生对话框选文件 / 文件夹（代替服务端的 osascript：utility process 里弹不到前台）
  ipcMain.handle('desktop:pick', async (e, mode: unknown, title: unknown, startDir: unknown): Promise<string[]> => {
    if (!win || e.sender !== win.webContents) return [];
    const props: Electron.OpenDialogOptions['properties'] = ['multiSelections'];
    const m = typeof mode === 'string' ? mode : 'mixed';
    if (m === 'folders') props.push('openDirectory');
    else if (m === 'files') props.push('openFile');
    else { props.push('openFile', 'openDirectory'); }
    const opts: Electron.OpenDialogOptions = { properties: props, title: typeof title === 'string' ? title : undefined };
    if (typeof startDir === 'string' && startDir) opts.defaultPath = startDir;
    const r = await dialog.showOpenDialog(win, opts);
    return r.filePaths;
  });
  ipcMain.handle('settings:get', async (e) => {
    if (!fromSettings(e)) return null;
    return { host: cfg.host, port: cfg.port, running: await runningCount() };
  });
  ipcMain.handle('settings:save', (e, host: unknown, portIn: unknown) => (fromSettings(e) ? applySettings(host, portIn, false) : { ok: false, error: '拒绝' }));
  ipcMain.handle('settings:regen', (e) => (fromSettings(e) ? applySettings(cfg.host, cfg.port, true) : { ok: false, error: '拒绝' }));
  ipcMain.handle('settings:close', (e) => {
    if (fromSettings(e)) settingsWin?.close();
  });
}

// ───────────── 启动 ─────────────

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) focusMain();
    else if (settingsWin && !settingsWin.isDestroyed()) openSettings();
  });

  app.on('before-quit', (e) => {
    if (quitState !== 'done') {
      e.preventDefault();
      void beginQuit();
    }
  });
  app.on('window-all-closed', () => {
    if (quitState === 'done') app.quit();
  });

  void app.whenReady().then(async () => {
    // 默认拒绝所有权限请求（摄像头 / 麦克风 / 通知等）；剪贴板写入不需要权限
    session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    fixMacPath();
    registerIpc();
    if (isDev) {
      try {
        await waitForUrl(devUrl, 120_000);
      } catch (e) {
        log('启动失败', String(e));
        dialog.showErrorBox('Cosyee 启动失败', e instanceof Error ? e.message : String(e));
        quitState = 'done';
        app.quit();
        return;
      }
      win = createWindow();
      await win.loadURL(baseUrl()).catch((e) => log('loadURL 失败', String(e)));
      return;
    }
    cfgFile = path.join(app.getPath('userData'), 'config.json');
    const loaded = loadConfig(cfgFile);
    cfg = loaded.config;
    log('配置', cfgFile, `${cfg.host}:${cfg.port}`);
    if (loaded.warning) {
      log('配置警告', loaded.warning);
      void dialog.showMessageBox({ type: 'warning', title: 'Cosyee', message: '配置文件有问题', detail: loaded.warning, buttons: ['知道了'], noLink: true });
    }
    if (!isLoopback(cfg.host)) log('警告：监听', cfg.host, '，同一网络里拿到链接的人可以在本机执行命令');
    await startup();
  });
}
