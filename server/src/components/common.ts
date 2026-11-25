// 本机组件（Claude CLI / kiro.rs / agy / cosyee 服务端）的统一适配接口与公用工具。
import type { ComponentId, ComponentService, ComponentStatus } from '@cosyee/shared';
import { readTextLimited, sanitizeLogLine } from '../delegate/agyCli.js';

/** 适配器给调度器的原始信息（不含开关、pending 等调度层才知道的字段） */
export interface AdapterInfo {
  installed: boolean;
  custom: boolean;
  version: string | null;
  latest: string | null;
  updateAvailable: boolean;
  checkedAt: number | null;
  checkError: string | null;
  /** 正在使用这个组件的任务数 */
  busy: number;
  /** 组件自己已有的任务状态（比如从旧接口 /api/agy/cli/update 发起的）；没有则 null */
  job: ComponentStatus['job'];
}

export interface ComponentAdapter {
  id: ComponentId;
  name: string;
  /** server 组件由桌面客户端更新，本进程不执行 */
  updatedBy: 'server' | 'client';
  /** 没安装时 update() 负责安装（内置浏览器） */
  installable?: boolean;
  /** 读取当前状态，不访问网络，不抛错 */
  info(): Promise<AdapterInfo>;
  /** 查询最新版并记入自身状态；失败抛错 */
  check(): Promise<void>;
  /** 执行更新，结束（成功或失败）时才返回；失败抛错。调用前调度器已确认 !custom && (installed || installable) */
  update(): Promise<void>;
  /** 恢复上次检查的结果（服务端重启或命令行入口每次都是新进程，只有自己持久化了的组件不需要）；不联网 */
  restore?(latest: string, checkedAt: number): void;
  /** 本次更新日志的增量 */
  log(from: number): { lines: string[]; next: number };
  /** 服务端退出时调用 */
  dispose?(): void;
  /** 带常驻服务的组件（kiro.rs）：服务状态与启停。stop / restart 有任务在用且没带 force 时抛 RunningError */
  service?: {
    status(): ComponentService;
    start(): Promise<void>;
    stop(force: boolean): Promise<void>;
    restart(force: boolean): Promise<void>;
  };
}

export const FETCH_TIMEOUT_MS = 15_000;
export const FETCH_MAX_BYTES = 1024 * 1024;
const USER_AGENT = 'cosyee';

export function errText(e: unknown): string {
  return sanitizeLogLine(e instanceof Error ? e.message : String(e));
}

/** GET 一个 JSON：限时、限体积、只带通用 User-Agent，不带任何本机信息 */
export async function fetchJsonLimited(
  fetchFn: typeof globalThis.fetch,
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`检查最新版本失败（HTTP ${res.status}）`);
    const text = await readTextLimited(res, opts.maxBytes ?? FETCH_MAX_BYTES);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('检查最新版本失败：响应不是合法 JSON');
    }
  } catch (e) {
    if (ac.signal.aborted) throw new Error('检查最新版本超时');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 取响应对象里的字符串字段 */
export function pickString(data: unknown, key: string): string {
  if (data && typeof data === 'object') {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === 'string') return v.trim();
  }
  return '';
}

/** 带上限的增量日志缓冲（行已脱敏）；next 单调递增 */
export class LogBuffer {
  private lines: string[] = [];
  private base = 0;
  constructor(private readonly max = 2000) {}

  append(raw: string): void {
    this.lines.push(sanitizeLogLine(raw));
    if (this.lines.length > this.max) {
      const drop = this.lines.length - this.max;
      this.lines.splice(0, drop);
      this.base += drop;
    }
  }

  reset(): void {
    this.lines = [];
    this.base = 0;
  }

  read(from = 0): { lines: string[]; next: number } {
    const start = Number.isInteger(from) && from > 0 ? from : 0;
    const next = this.base + this.lines.length;
    if (start >= next) return { lines: [], next };
    return { lines: this.lines.slice(Math.max(0, start - this.base)), next };
  }
}
