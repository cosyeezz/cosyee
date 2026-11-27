// 登录窗口：Google 等网站会拦截被自动化控制的无界面浏览器（navigator.webdriver 为 true），在内置浏览器里登不上。
// 登录时关掉无界面 Chrome，用同一个 profile 起一个普通的有界面 Chrome（不带自动化参数，webdriver 为 false），
// 用户在窗口里登录，点面板上的「登录完成」后经 CDP 的 Browser.close 正常退出，再切回无界面。
// 不按标签页数量自动判断结束：用户可能关掉一个标签再开别的；只有点「登录完成」或自己退出 Chrome 才算结束。
// 必须正常退出：直接杀进程时 Cookie 来不及写盘，切回去就丢了登录状态。
// 调试端口要先选好一个空闲端口再传给 Chrome：--remote-debugging-port=0 时 Chrome 会把 navigator.webdriver 设成 true
// （Chrome 158 实测；固定端口和不开端口都是 false），Google 照样拦登录。固定端口时 Chrome 不写 DevToolsActivePort，直接轮询端口。
// 启动参数里的 --use-mock-keychain / --password-store=basic 和 agent-browser 一致，否则两边加密 Cookie 的密钥不同、互相读不出。
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import { CHROME_ARGS } from './skill.js';

/** 窗口模式期间写在 profile 目录里的标记：包装脚本看到它就不启动无界面浏览器（同一个 profile 同时只能开一个 Chrome） */
export const WINDOW_MARKER = 'CosyeeWindow';
const START_TIMEOUT_MS = 15_000;
const POLL_MS = 1_000;
const CLOSE_TIMEOUT_MS = 10_000;

/** 本机的 Google Chrome；找不到返回 null */
export function findChrome(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | null {
  const list: string[] = [];
  if (platform === 'darwin') {
    const app = 'Google Chrome.app/Contents/MacOS/Google Chrome';
    list.push(path.join('/Applications', app));
    if (env.HOME) list.push(path.join(env.HOME, 'Applications', app));
  } else if (platform === 'win32') {
    for (const k of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) {
      const base = env[k];
      if (base) list.push(path.win32.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
  } else {
    list.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  return list.find((p) => exists(p)) ?? null;
}

/** 有界面 Chrome 的启动参数 */
export function windowArgs(profileDir: string, url: string | null, port: number): string[] {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--use-mock-keychain',
    '--password-store=basic',
    CHROME_ARGS,
    url && restorableUrl(url) ? url : 'about:blank',
  ];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 切回内置时要打开的地址：只要 http(s)，跳过「登录 Chrome」（同步）页和 Google 的拒绝页。
 * Chrome 会自己弹「登录 Chrome」标签页，这一步在带调试端口的 Chrome 里本来就登不了，切回内置后停在那里没有意义。
 */
export function restorableUrl(url: string): boolean {
  if (!/^https?:/i.test(url)) return false;
  if (!/^https:\/\/accounts\.google\.com\//i.test(url)) return true;
  const u = decodeURIComponentSafe(url);
  return !/signin\/chrome\/|\/signin\/rejected|flowName=GlifDesktopChrome/i.test(u);
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 本机一个空闲端口 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('没有空闲端口'))));
    });
  });
}

/** SingletonLock 指向「主机名-pid」：进程还在才算被占用 */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 一个身份的登录窗口：start 打开，done 在窗口退出后 resolve（带最后停留的地址） */
export class LoginWindow {
  private proc: ChildProcess | null = null;
  private port = 0;
  private exited = false;
  private closing = false;
  private lastUrl: string | null = null;
  readonly done: Promise<string | null>;
  private resolveDone!: (url: string | null) => void;

  constructor(private readonly chrome: string, private readonly profileDir: string) {
    this.done = new Promise((r) => (this.resolveDone = r));
  }

  private marker(): string {
    return path.join(this.profileDir, WINDOW_MARKER);
  }

  async start(url: string | null): Promise<void> {
    fs.mkdirSync(this.profileDir, { recursive: true, mode: 0o700 });
    await this.waitUnlocked();
    fs.writeFileSync(this.marker(), `${process.pid}\n`, { mode: 0o600 });
    this.lastUrl = url && restorableUrl(url) ? url : null;
    this.port = await freePort();
    const proc = spawn(this.chrome, windowArgs(this.profileDir, url, this.port), { stdio: 'ignore', windowsHide: false });
    this.proc = proc;
    proc.on('exit', () => {
      this.exited = true;
    });
    proc.on('error', () => {
      this.exited = true;
    });
    try {
      await this.waitReady();
    } catch (e) {
      this.kill();
      this.finish();
      throw e;
    }
    void this.watch();
  }

  /** 等刚关掉的无界面 Chrome 放开 profile（macOS / Linux 上 SingletonLock 是个悬空软链接，existsSync 看不见，要用 lstat） */
  private async waitUnlocked(): Promise<void> {
    const lock = path.join(this.profileDir, 'SingletonLock');
    const until = Date.now() + 5_000;
    for (;;) {
      let target: string;
      try {
        target = fs.readlinkSync(lock);
      } catch {
        return; // 没有锁（或不是软链接，Windows 不用这个文件）
      }
      if (!alive(Number(target.split('-').pop()))) return; // 上次崩溃留下的锁，Chrome 自己会接管
      if (Date.now() >= until) throw new Error('这个身份的内置浏览器没能关掉（profile 还被占用）');
      await sleep(200);
    }
  }

  /** 等调试端口能连上 */
  private async waitReady(): Promise<void> {
    const until = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < until) {
      if (this.exited) throw new Error('Chrome 窗口启动后马上退出了（这个身份的浏览器可能还开着）');
      try {
        const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(1_000) });
        if (r.ok) return;
      } catch { /* 还没起来 */ }
      await sleep(200);
    }
    throw new Error('Chrome 窗口启动超时');
  }

  private async pages(): Promise<{ url: string }[] | null> {
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(2_000) });
      const list = (await r.json()) as { type?: unknown; url?: unknown }[];
      return list.filter((t) => t.type === 'page' && typeof t.url === 'string' && !String(t.url).startsWith('chrome://')).map((t) => ({ url: String(t.url) }));
    } catch {
      return null;
    }
  }

  /** 每秒看一次：记下当前地址（切回内置时打开）；用户自己退出 Chrome 就收尾 */
  private async watch(): Promise<void> {
    while (!this.exited) {
      await sleep(POLL_MS);
      if (this.exited || this.closing) break;
      const u = (await this.pages())?.find((p) => restorableUrl(p.url))?.url;
      if (u) this.lastUrl = u;
    }
    if (!this.closing) this.finish();
  }

  /** 正常关闭（Cookie 写盘）；超时才强杀 */
  async close(): Promise<void> {
    if (this.closing) return this.done.then(() => undefined);
    this.closing = true;
    if (!this.exited) {
      await this.browserClose();
      const until = Date.now() + CLOSE_TIMEOUT_MS;
      while (!this.exited && Date.now() < until) await sleep(200);
      if (!this.exited) this.kill();
    }
    this.finish();
  }

  private async browserClose(): Promise<void> {
    let ws: string;
    try {
      const r = await fetch(`http://127.0.0.1:${this.port}/json/version`, { signal: AbortSignal.timeout(2_000) });
      ws = String(((await r.json()) as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl ?? '');
    } catch {
      return;
    }
    if (!/^ws:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(ws)) return;
    await new Promise<void>((resolve) => {
      const sock = new WebSocket(ws, { perMessageDeflate: false });
      const end = () => {
        clearTimeout(t);
        sock.removeAllListeners();
        sock.on('error', () => { /* ignore */ });
        sock.terminate();
        resolve();
      };
      const t = setTimeout(end, 3_000);
      sock.on('open', () => sock.send(JSON.stringify({ id: 1, method: 'Browser.close' })));
      sock.on('message', end);
      sock.on('error', end);
      sock.on('close', end);
    });
  }

  /** 服务退出时用：来不及正常关就直接结束进程 */
  kill(): void {
    if (this.proc && !this.exited) this.proc.kill();
    fs.rmSync(this.marker(), { force: true });
  }

  private finish(): void {
    fs.rmSync(this.marker(), { force: true });
    this.resolveDone(this.lastUrl);
  }
}
