// 内置浏览器：用 agent-browser 驱动一个 cosyee 专用的 Chrome（无界面，独立 profile，登录状态长期保存）。
// 画面靠 agent-browser 自带的 stream（WebSocket 推 JPEG 帧、收鼠标键盘输入），本进程转发给前端；
// 导航 / 视口 / 悬停 / 抓取元素走 CLI（命令很快，约 10ms；首次启动浏览器约 4s）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { WebSocket } from 'ws';
import type { BrowserHover, BrowserStatus } from '@cosyee/shared';
import { cosyeeHome } from '../paths.js';
import { HttpError } from '../workspaces.js';
import type { BrowserInstall } from './install.js';
import { elementMarkdown, newElementFiles, parseRawPick, pickScript, toElement, unmarkScript, type RawPick } from './elements.js';

const NAMESPACE = 'cosyee';
const SESSION = 'cosyee';
const CMD_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 60_000;
const KEEPALIVE_MS = 5 * 60_000;
const MAX_PNG = 4 * 1024 * 1024;
/** 前端可以发给浏览器的消息类型（其余丢弃） */
const INPUT_TYPES = new Set(['input_mouse', 'input_keyboard', 'input_touch', 'ack']);
const CLIENT_MSG_MAX = 64 * 1024;

export interface BrowserManagerOptions {
  install: BrowserInstall;
  /** 数据目录（profile、UA、抓取的元素），默认 <cosyee 目录>/browser */
  dataDir?: () => string;
  namespace?: string;
}

export interface PickOutput {
  md: string;
  png: string | null;
  raw: RawPick;
}

/** 地址栏输入 → 可打开的地址；不接受 http(s) / about:blank 以外的协议 */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) throw new HttpError(400, '地址为空');
  if (s.length > 4000) throw new HttpError(400, '地址过长');
  if (s === 'about:blank') return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^\s:/]+:\d+(?:[/?#]|$)/.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new HttpError(400, '地址无效');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, '只支持 http / https 地址');
    return u.href;
  }
  // 没写协议：像域名 / IP / localhost 就补协议，否则当搜索词
  if (!/\s/.test(s) && /^(?:localhost|[\w-]+(?:\.[\w-]+)+|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i.test(s)) {
    const local = /^(?:localhost|127\.|10\.|192\.168\.|\[)/i.test(s);
    try {
      return new URL(`${local ? 'http' : 'https'}://${s}`).href;
    } catch {
      throw new HttpError(400, '地址无效');
    }
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(s)}`;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(v)));

export class BrowserManager {
  private queue: Promise<unknown> = Promise.resolve();
  private started = false;
  private ua: string | null = null;
  private lastViewport = '';
  private hoverBusy = false;
  private hoverNext: { x: number; y: number; resolve: (v: BrowserHover | null) => void } | null = null;
  private clients = new Set<WebSocket>();
  private keepalive: NodeJS.Timeout | null = null;
  private last: { url: string | null; title: string | null } = { url: null, title: null };

  constructor(private readonly opts: BrowserManagerOptions) {}

  private dataDir(): string {
    return this.opts.dataDir ? this.opts.dataDir() : path.join(cosyeeHome(), 'browser');
  }

  private ns(): string {
    return this.opts.namespace ?? NAMESPACE;
  }

  /** 程序路径（写进元素描述，让 Claude 能接着操作同一个浏览器） */
  binPath(): string | null {
    return this.opts.install.binPath();
  }

  /** 正在看画面的窗口数（组件面板「使用中」） */
  busy(): number {
    return this.clients.size;
  }

  /** 启动参数：每条命令都要一致，否则 agent-browser 会重启浏览器 */
  private launchArgs(withUa: boolean): string[] {
    const profile = path.join(this.dataDir(), 'profile');
    const args = ['--namespace', this.ns(), '--session', SESSION, '--profile', profile, '--idle-timeout', '1h'];
    if (withUa && this.ua) args.push('--user-agent', this.ua);
    return args;
  }

  private baseArgs(withUa: boolean): string[] {
    return ['--json', ...this.launchArgs(withUa)];
  }

  /** 给 Claude 的命令前缀（写进元素描述） */
  private cliPrefix(): string[] | null {
    const bin = this.binPath();
    return bin ? [bin, ...this.launchArgs(true)] : null;
  }

  /** 跑一条命令，返回 data；失败抛 HttpError(502) */
  private exec(args: string[], timeoutMs = CMD_TIMEOUT_MS, withUa = true): Promise<Record<string, unknown>> {
    const bin = this.binPath();
    if (!bin) return Promise.reject(new HttpError(409, '内置浏览器未安装，请在浏览器面板或客户端「本机服务」里安装'));
    fs.mkdirSync(path.join(this.dataDir(), 'profile'), { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        [...this.baseArgs(withUa), ...args],
        { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env, AGENT_BROWSER_NAMESPACE: undefined, AGENT_BROWSER_SESSION: undefined } },
        (err, stdout) => {
          type Out = { success?: unknown; data?: unknown; error?: unknown };
          let j: Out | null = null;
          try {
            j = JSON.parse(String(stdout).trim().split('\n').pop() ?? '') as Out;
          } catch { /* 下面按失败处理 */ }
          if (j && j.success === true) {
            this.started = true;
            return resolve((j.data && typeof j.data === 'object' ? j.data : {}) as Record<string, unknown>);
          }
          const msg = j && typeof j.error === 'string' && j.error ? j.error : err ? err.message : '没有输出';
          reject(new HttpError(502, `浏览器命令失败：${msg.split('\n')[0]!.slice(0, 300)}`));
        },
      );
    });
  }

  /** 串行执行（同一个会话上的命令互不打断） */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => { /* 不影响后面的命令 */ });
    return p;
  }

  /**
   * 无界面 Chrome 的 UA 带 HeadlessChrome，不少网站会拦。首次运行读出真实 UA 改成 Chrome 存下来，
   * 之后每条命令都带同一个 --user-agent（值一变 agent-browser 就会重启浏览器，所以必须固定）。
   */
  private async ensureUa(): Promise<void> {
    if (this.ua) return;
    const file = path.join(this.dataDir(), 'ua.txt');
    try {
      const s = fs.readFileSync(file, 'utf8').trim();
      if (s && s.length < 500 && !/[\r\n]/.test(s)) {
        this.ua = s;
        return;
      }
    } catch { /* 没有：现读 */ }
    const d = await this.exec(['eval', '-b', Buffer.from('navigator.userAgent').toString('base64')], OPEN_TIMEOUT_MS, false);
    const real = typeof d.result === 'string' ? d.result : '';
    if (!real) return;
    const ua = real.replace(/HeadlessChrome\//g, 'Chrome/');
    fs.mkdirSync(this.dataDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, ua + '\n', { mode: 0o600 });
    this.ua = ua;
  }

  private async run(args: string[], timeoutMs = CMD_TIMEOUT_MS): Promise<Record<string, unknown>> {
    await this.ensureUa();
    return this.exec(args, timeoutMs);
  }

  private async evalJs(js: string): Promise<unknown> {
    const d = await this.run(['eval', '-b', Buffer.from(js, 'utf8').toString('base64')]);
    return d.result;
  }

  private remember(d: Record<string, unknown>): void {
    if (typeof d.url === 'string') this.last.url = d.url;
    if (typeof d.title === 'string') this.last.title = d.title;
  }

  status(): BrowserStatus {
    return { installed: this.binPath() !== null, running: this.started, url: this.last.url, title: this.last.title };
  }

  /** 启动（或复用）浏览器，确保画面推流已开，返回推流端口 */
  streamPort(): Promise<number> {
    return this.serial(async () => {
      let d = await this.run(['stream', 'status'], OPEN_TIMEOUT_MS);
      if (d.enabled !== true) d = await this.run(['stream', 'enable']);
      if (d.port === undefined) d = await this.run(['stream', 'status']);
      const port = Number(d.port);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new HttpError(502, '浏览器画面推流没有开启');
      return port;
    });
  }

  open(input: string): Promise<{ url: string | null; title: string | null }> {
    const url = normalizeUrl(input);
    return this.serial(async () => {
      const d = await this.run(['open', '--', url], OPEN_TIMEOUT_MS);
      this.remember(d);
      return { ...this.last };
    });
  }

  nav(action: 'back' | 'forward' | 'reload'): Promise<void> {
    return this.serial(async () => {
      try {
        this.remember(await this.run([action]));
      } catch (e) {
        // 后退 / 前进时页面换了，agent-browser 会报「target navigated or closed」，实际已经成功
        if (!(e instanceof Error && /navigated or closed/i.test(e.message))) throw e;
      }
    });
  }

  /** 视口跟随前端面板大小；scale 是设备像素比（高分屏画面才清楚） */
  viewport(width: number, height: number, scale: number): Promise<void> {
    const w = clamp(width, 320, 3840);
    const h = clamp(height, 240, 2160);
    const s = scale >= 1.5 ? 2 : 1;
    const key = `${w}x${h}@${s}`;
    if (key === this.lastViewport) return Promise.resolve();
    return this.serial(async () => {
      await this.run(['set', 'viewport', '--', String(w), String(h), String(s)]);
      this.lastViewport = key;
    });
  }

  /** 抓取模式悬停：返回指针下元素的矩形；只保留一个进行中的请求，新的顶掉旧的 */
  hover(x: number, y: number): Promise<BrowserHover | null> {
    return new Promise((resolve) => {
      if (this.hoverNext) this.hoverNext.resolve(null);
      this.hoverNext = { x, y, resolve };
      void this.pumpHover();
    });
  }

  private async pumpHover(): Promise<void> {
    if (this.hoverBusy) return;
    this.hoverBusy = true;
    try {
      while (this.hoverNext) {
        const { x, y, resolve } = this.hoverNext;
        this.hoverNext = null;
        try {
          const r = parseRawPick(await this.serial(() => this.evalJs(pickScript(x, y, null, true))));
          resolve(r ? { rect: r.rect, label: r.label } : null);
        } catch {
          resolve(null);
        }
      }
    } finally {
      this.hoverBusy = false;
    }
  }

  /** 抓取 (x, y) 处的元素：写描述文件和截图 */
  pick(x: number, y: number): Promise<PickOutput> {
    return this.serial(async () => {
      const mark = crypto.randomBytes(8).toString('hex');
      const raw = parseRawPick(await this.evalJs(pickScript(x, y, mark, false)));
      if (!raw) throw new HttpError(404, '这个位置没有元素');
      const files = newElementFiles();
      let png: string | null = null;
      try {
        if (!raw.inFrame && !raw.inShadow && raw.rect.width >= 1 && raw.rect.height >= 1) {
          try {
            await this.run(['screenshot', `[data-cosyee-pick="${mark}"]`, files.png]);
            const st = fs.statSync(files.png);
            if (st.isFile() && st.size > 0 && st.size <= MAX_PNG) {
              fs.chmodSync(files.png, 0o600);
              png = files.png;
            } else fs.rmSync(files.png, { force: true });
          } catch {
            fs.rmSync(files.png, { force: true });
          }
        }
      } finally {
        await this.evalJs(unmarkScript(mark)).catch(() => { /* 页面可能已跳走 */ });
      }
      fs.writeFileSync(files.md, elementMarkdown(raw, { png, cli: this.cliPrefix() }), { mode: 0o600 });
      this.last.url = raw.url;
      this.last.title = raw.title;
      return { md: files.md, png, raw };
    });
  }

  /** 关闭浏览器（更新程序前调用） */
  async close(): Promise<void> {
    for (const c of this.clients) c.close(1001, 'closing');
    if (!this.started || !this.binPath()) return;
    await this.serial(() => this.exec(['close'], CMD_TIMEOUT_MS).catch(() => ({})));
    this.started = false;
    this.lastViewport = '';
  }

  /** 前端画面连接：接到 agent-browser 的推流上，双向转发（前端只能发输入类消息） */
  async attach(client: WebSocket): Promise<void> {
    this.clients.add(client);
    this.syncKeepalive();
    let upstream: WebSocket | null = null;
    let done = false;
    const cleanup = (): void => {
      if (done) return;
      done = true;
      this.clients.delete(client);
      this.syncKeepalive();
      upstream?.close();
      if (client.readyState === WebSocket.OPEN) client.close();
    };
    client.on('close', cleanup);
    client.on('error', cleanup);
    let port: number;
    try {
      port = await this.streamPort();
    } catch (e) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: 'cosyee_error', message: e instanceof Error ? e.message : String(e) }));
      }
      cleanup();
      return;
    }
    if (client.readyState !== WebSocket.OPEN) return cleanup();
    upstream = new WebSocket(`ws://127.0.0.1:${port}/?maxFps=30&pacing=ack`, { maxPayload: 32 * 1024 * 1024 });
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('close', cleanup);
    upstream.on('error', cleanup);
    client.on('message', (data, isBinary) => {
      if (isBinary || !upstream || upstream.readyState !== WebSocket.OPEN) return;
      const s = String(data);
      if (s.length > CLIENT_MSG_MAX) return;
      let m: unknown;
      try {
        m = JSON.parse(s);
      } catch {
        return;
      }
      if (!m || typeof m !== 'object' || !INPUT_TYPES.has(String((m as { type?: unknown }).type))) return;
      upstream.send(s);
    });
  }

  /** 有人在看时定期跑一条轻命令，免得 agent-browser 空闲 1 小时后自己退出 */
  private syncKeepalive(): void {
    if (this.clients.size > 0 && !this.keepalive) {
      this.keepalive = setInterval(() => {
        void this.serial(() => this.run(['get', 'url']).then((d) => this.remember(d))).catch(() => { /* ignore */ });
      }, KEEPALIVE_MS);
      this.keepalive.unref?.();
    } else if (this.clients.size === 0 && this.keepalive) {
      clearInterval(this.keepalive);
      this.keepalive = null;
    }
  }

  dispose(): void {
    if (this.keepalive) clearInterval(this.keepalive);
    this.keepalive = null;
    for (const c of this.clients) c.terminate();
    this.clients.clear();
  }
}
