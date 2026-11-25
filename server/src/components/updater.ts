// 本机组件的注册表、自动更新开关与调度，以及 /api/components* 的路由处理。
import fs from 'node:fs';
import path from 'node:path';
import { COMPONENT_IDS, type ComponentId, type ComponentList, type ComponentStatus } from '@cosyee/shared';
import { writeFileAtomic } from '../kiro/sanitize.js';
import { cosyeeHome } from '../paths.js';
import { RunningError } from '../accounts/index.js';
import { HttpError } from '../workspaces.js';
import { type AdapterInfo, type ComponentAdapter, errText } from './common.js';
import { SERVER_UPDATE_BY_CLIENT } from './server.js';

export const FIRST_TICK_MS = 5 * 60_000;
export const TICK_INTERVAL_MS = 60 * 60_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;
/** 一次自动更新尝试之后，至少隔这么久才再自动尝试（失败不连续重试；成功但版本仍落后也不循环） */
export const RETRY_INTERVAL_MS = 24 * 60 * 60_000;

export function isComponentId(v: string): v is ComponentId {
  return (COMPONENT_IDS as readonly string[]).includes(v);
}

/** ~/.cosyee/components.json：{ "auto": { "claude": true, ... } }，缺省 true */
export class ComponentSettings {
  private auto: Partial<Record<ComponentId, boolean>> | null = null;

  constructor(private readonly home: () => string) {}

  private file(): string {
    return path.join(this.home(), 'components.json');
  }

  private load(): Partial<Record<ComponentId, boolean>> {
    if (this.auto) return this.auto;
    const out: Partial<Record<ComponentId, boolean>> = {};
    try {
      const j = JSON.parse(fs.readFileSync(this.file(), 'utf8')) as { auto?: Record<string, unknown> };
      for (const id of COMPONENT_IDS) {
        const v = j?.auto?.[id];
        if (typeof v === 'boolean') out[id] = v;
      }
    } catch { /* 没有文件或格式不对：全部用默认 */ }
    return (this.auto = out);
  }

  autoUpdate(id: ComponentId): boolean {
    return this.load()[id] !== false;
  }

  setAutoUpdate(id: ComponentId, enabled: boolean): void {
    const cur = { ...this.load(), [id]: enabled };
    const auto: Record<string, boolean> = {};
    for (const k of COMPONENT_IDS) auto[k] = cur[k] !== false;
    writeFileAtomic(this.file(), JSON.stringify({ auto }, null, 2) + '\n', 0o600);
    this.auto = cur;
  }
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export interface ComponentUpdaterOptions {
  adapters: ComponentAdapter[];
  /** cosyee 数据目录，默认 cosyeeHome()；测试注入 */
  home?: () => string;
  now?: () => number;
  timers?: Timers;
  firstTickMs?: number;
  tickIntervalMs?: number;
}

interface CheckRecord {
  at: number;
  error: string | null;
}

interface JobRecord {
  kind: 'install' | 'update';
  state: 'running' | 'failed';
  error: string | null;
}

export class ComponentUpdater {
  private readonly adapters = new Map<ComponentId, ComponentAdapter>();
  private readonly settings: ComponentSettings;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly firstTickMs: number;
  private readonly tickIntervalMs: number;
  private readonly checks = new Map<ComponentId, CheckRecord>();
  private readonly checking = new Map<ComponentId, Promise<void>>();
  private readonly jobs = new Map<ComponentId, JobRecord>();
  private readonly running = new Map<ComponentId, Promise<void>>();
  private readonly lastAttempt = new Map<ComponentId, number>();
  private timer: unknown = null;
  private ticking: Promise<void> | null = null;
  private stopped = true;

  constructor(opts: ComponentUpdaterOptions) {
    for (const a of opts.adapters) this.adapters.set(a.id, a);
    this.settings = new ComponentSettings(opts.home ?? cosyeeHome);
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? {
      setTimeout: (fn, ms) => {
        const t = setTimeout(fn, ms);
        t.unref?.();
        return t;
      },
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    this.firstTickMs = opts.firstTickMs ?? FIRST_TICK_MS;
    this.tickIntervalMs = opts.tickIntervalMs ?? TICK_INTERVAL_MS;
  }

  /** 启动定时器：5 分钟后第一次，之后每小时一次 */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(this.firstTickMs);
  }

  /** 停止定时器。不终止正在执行的更新（中途强杀可能留下半装的程序） */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    for (const a of this.adapters.values()) a.dispose?.();
  }

  private schedule(ms: number): void {
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => {
        if (!this.stopped) this.schedule(this.tickIntervalMs);
      });
    }, ms);
  }

  private adapter(id: string): ComponentAdapter {
    const a = isComponentId(id) ? this.adapters.get(id) : undefined;
    if (!a) throw new HttpError(404, '未找到');
    return a;
  }

  private build(a: ComponentAdapter, info: AdapterInfo): ComponentStatus {
    const own = this.checks.get(a.id);
    const infoAt = info.checkedAt ?? 0;
    const checkedAt = own || info.checkedAt !== null ? Math.max(own?.at ?? 0, infoAt) : null;
    const checkError = own && own.at >= infoAt ? own.error : info.checkError;
    const autoUpdate = this.settings.autoUpdate(a.id);
    const job: ComponentStatus['job'] = this.jobs.get(a.id) ?? info.job;
    const jobRunning = job?.state === 'running';
    const eligible = !info.custom && info.installed && info.updateAvailable && autoUpdate;
    return {
      id: a.id,
      name: a.name,
      installed: info.installed,
      custom: info.custom,
      version: info.version,
      latest: info.latest,
      updateAvailable: info.updateAvailable,
      checkedAt,
      checkError,
      autoUpdate,
      busy: info.busy,
      // 有新版、开关开着、不是 custom，但组件忙：等空闲后自动更新（server 组件由客户端更新，同样显示）
      pending: eligible && info.busy > 0 && !jobRunning && !this.coolingDown(a.id),
      updatedBy: a.updatedBy,
      ...(a.installable ? { installable: true } : {}),
      job,
      ...(a.service && info.installed ? { service: a.service.status() } : {}),
    };
  }

  private coolingDown(id: ComponentId): boolean {
    const t = this.lastAttempt.get(id);
    return t !== undefined && this.now() - t < RETRY_INTERVAL_MS;
  }

  async status(id: string): Promise<ComponentStatus> {
    const a = this.adapter(id);
    return this.build(a, await a.info());
  }

  async list(): Promise<ComponentList> {
    const list: ComponentStatus[] = [];
    for (const id of COMPONENT_IDS) {
      const a = this.adapters.get(id);
      if (a) list.push(this.build(a, await a.info()));
    }
    return { list };
  }

  /** 立即查最新版；失败记入 checkError，不抛错 */
  async check(id: string): Promise<ComponentStatus> {
    const a = this.adapter(id);
    await this.doCheck(a);
    return this.status(id);
  }

  private doCheck(a: ComponentAdapter): Promise<void> {
    const cur = this.checking.get(a.id);
    if (cur) return cur;
    const p = (async () => {
      let error: string | null = null;
      try {
        await a.check();
      } catch (e) {
        error = errText(e);
      }
      this.checks.set(a.id, { at: this.now(), error });
    })();
    this.checking.set(a.id, p);
    const clear = () => {
      if (this.checking.get(a.id) === p) this.checking.delete(a.id);
    };
    p.then(clear, clear);
    return p;
  }

  /** 手动更新：后台执行，立即返回带 job 的状态 */
  async update(id: string): Promise<ComponentStatus> {
    const a = this.adapter(id);
    if (a.updatedBy === 'client') throw new HttpError(409, SERVER_UPDATE_BY_CLIENT);
    const info = await a.info();
    if (info.custom) throw new HttpError(409, '已用环境变量指定或源码运行，不支持自动更新');
    if (!info.installed && !a.installable) throw new HttpError(409, `${a.name} 未安装`);
    if (this.running.has(a.id) || info.job?.state === 'running') throw new HttpError(409, '正在更新中，请稍候');
    if (info.busy > 0) throw new HttpError(409, `有 ${info.busy} 个任务正在使用，等任务结束后再更新`);
    this.launch(a, info.installed ? 'update' : 'install');
    return this.status(id);
  }

  private launch(a: ComponentAdapter, kind: 'install' | 'update' = 'update'): void {
    this.jobs.set(a.id, { kind, state: 'running', error: null });
    this.lastAttempt.set(a.id, this.now());
    const p = (async () => {
      try {
        await a.update();
        this.jobs.delete(a.id);
      } catch (e) {
        this.jobs.set(a.id, { kind, state: 'failed', error: errText(e) });
      }
    })();
    this.running.set(a.id, p);
    p.then(() => {
      if (this.running.get(a.id) === p) this.running.delete(a.id);
    });
  }

  async setAuto(id: string, enabled: boolean): Promise<ComponentStatus> {
    const a = this.adapter(id);
    this.settings.setAutoUpdate(a.id, enabled);
    return this.status(id);
  }

  /** 服务启停：start / stop / restart；组件没有服务时 404 */
  async serviceOp(id: string, op: 'start' | 'stop' | 'restart', force: boolean): Promise<ComponentStatus> {
    const svc = this.adapter(id).service;
    if (!svc) throw new HttpError(404, '未找到');
    if (op === 'start') await svc.start();
    else if (op === 'stop') await svc.stop(force);
    else await svc.restart(force);
    return this.status(id);
  }

  log(id: string, from: number): { lines: string[]; next: number } {
    return this.adapter(id).log(from);
  }

  /** 等所有后台更新结束（测试用） */
  async waitForJobs(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running.values()]);
  }

  /** 调度一轮（也供测试直接调用）；上一轮没结束时直接复用 */
  tick(): Promise<void> {
    this.ticking ??= this.runTick().finally(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  private async runTick(): Promise<void> {
    for (const a of this.adapters.values()) {
      try {
        await this.tickOne(a);
      } catch { /* 单个组件出错不影响其它组件 */ }
    }
  }

  private async tickOne(a: ComponentAdapter): Promise<void> {
    let info = await a.info();
    if (info.custom || !info.installed) return;
    const status = this.build(a, info);
    if (status.checkedAt === null || this.now() - status.checkedAt >= CHECK_INTERVAL_MS) {
      await this.doCheck(a);
      info = await a.info();
    }
    if (a.updatedBy === 'client') return;
    if (!info.updateAvailable || !this.settings.autoUpdate(a.id)) return;
    if (this.running.has(a.id) || info.job?.state === 'running') return;
    if (this.coolingDown(a.id)) return;
    if (info.busy > 0) return; // 标记 pending 由 build() 按 busy 实时算出
    this.launch(a);
  }
}

// ---- 路由 ----

export interface ComponentRouteRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  fromLocal: boolean;
}

export interface ComponentRouteResponse {
  status: number;
  body: unknown;
}

const ROUTE_RE = /^\/api\/components\/([^/]+)\/(check|update|auto|log|start|stop|restart)$/;

/** /api/components* 路由；未命中返回 null（调用方按 404 处理） */
export async function componentRoutes(
  updater: ComponentUpdater,
  req: ComponentRouteRequest,
): Promise<ComponentRouteResponse | null> {
  const { method, pathname, query, fromLocal } = req;
  if (pathname === '/api/components') {
    return method === 'GET' ? { status: 200, body: await updater.list() } : null;
  }
  const m = ROUTE_RE.exec(pathname);
  if (!m) return null;
  const id = m[1]!;
  const op = m[2]!;
  const isGet = method === 'GET' && op === 'log';
  if (!isGet && !(method === 'POST' && op !== 'log')) return null;
  try {
    if (!isComponentId(id)) throw new HttpError(404, '未找到');
    if (op === 'log') {
      const raw = query.get('from');
      let from = 0;
      if (raw !== null && raw !== '') {
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
          return { status: 400, body: { error: 'from 参数必须为非负整数' } };
        }
        from = Number(raw);
      }
      return { status: 200, body: updater.log(id, from) };
    }
    if (!fromLocal) return { status: 403, body: { error: '该操作仅允许本机连接' } };
    if (op === 'check') return { status: 200, body: await updater.check(id) };
    if (op === 'update') return { status: 200, body: await updater.update(id) };
    if (op === 'start' || op === 'stop' || op === 'restart') {
      try {
        return { status: 200, body: await updater.serviceOp(id, op, query.get('force') === '1') };
      } catch (e) {
        if (e instanceof RunningError) return { status: 409, body: { error: e.message, running: e.running } };
        throw e;
      }
    }
    const enabled = query.get('enabled');
    if (enabled !== '0' && enabled !== '1') return { status: 400, body: { error: 'enabled 必须为 0 或 1' } };
    return { status: 200, body: await updater.setAuto(id, enabled === '1') };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
    throw e;
  }
}
