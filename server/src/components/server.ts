// cosyee 服务端自身的版本组件：只负责显示版本与查最新版，更新由桌面客户端执行（停服务 → npm 安装 → 再启动）。
import { type AdapterInfo, type ComponentAdapter, fetchJsonLimited, pickString } from './common.js';

export const SERVER_LATEST_URL = 'https://raw.githubusercontent.com/cosyeezz/cosyee/server-dist/package.json';
export const SERVER_UPDATE_BY_CLIENT = '由桌面客户端更新';

export interface ParsedServerVersion {
  base: [number, number, number];
  /** CI 生成的 `X.Y.Z-main.N` 里的 N：tag X.Y.Z 之后的第 N 个提交；没有 = 0 */
  main: number;
}

const SERVER_VERSION_RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-main\.(\d{1,9}))?$/;

export function parseServerVersion(v: string): ParsedServerVersion | null {
  const m = SERVER_VERSION_RE.exec(v.trim());
  if (!m) return null;
  return { base: [Number(m[1]), Number(m[2]), Number(m[3])], main: m[4] ? Number(m[4]) : 0 };
}

/**
 * 比较服务端版本（a 更新返回 1，相等 0，a 更旧 -1），按（基础版本, main 序号）排序：
 * `0.1.6-main.3` 比 `0.1.6` 新（按 semver 预发布规则会算反），比 `0.1.7` 旧。无法解析时返回 0。
 */
export function compareServerVersion(a: string, b: string): number {
  const pa = parseServerVersion(a);
  const pb = parseServerVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa.base[i]! !== pb.base[i]!) return pa.base[i]! > pb.base[i]! ? 1 : -1;
  }
  if (pa.main !== pb.main) return pa.main > pb.main ? 1 : -1;
  return 0;
}

export interface ServerAdapterOptions {
  version: string;
  /** 源码运行（没有打包注入版本）或由桌面端启动：只显示，不检查不更新 */
  custom: boolean;
  /** 正在运行的会话数（manager.runningCount） */
  running: () => number;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function createServerAdapter(opts: ServerAdapterOptions): ComponentAdapter {
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  let latest: string | null = null;
  let checkedAt: number | null = null;

  return {
    id: 'server',
    name: 'Cosyee 服务端',
    updatedBy: 'client',

    async info(): Promise<AdapterInfo> {
      return {
        installed: true,
        custom: opts.custom,
        version: opts.version,
        latest,
        updateAvailable: Boolean(latest && compareServerVersion(latest, opts.version) > 0),
        checkedAt,
        checkError: null,
        busy: opts.running(),
        job: null,
      };
    },

    async check(): Promise<void> {
      const data = await fetchJsonLimited(fetchFn, SERVER_LATEST_URL);
      const v = pickString(data, 'version');
      if (!parseServerVersion(v)) throw new Error('服务端最新版本号格式无效');
      latest = v;
      checkedAt = now();
    },

    async update(): Promise<void> {
      throw new Error(SERVER_UPDATE_BY_CLIENT);
    },

    log: () => ({ lines: [], next: 0 }),
  };
}
