// Claude CLI 组件：版本取自 `claude --version`，最新版取自 npm registry，更新运行 `claude update`。
// 没装时只提示，不负责安装。COSYEE_CLAUDE 或显式传入的 claudePath 视为自定义，只显示不更新。
import fs from 'node:fs';
import { cleanEnv, resolveClaude } from '../claude/bin.js';
import {
  type AgyCommandRunner,
  compareSemver,
  defaultRunCommand,
  lastNonEmptyLine,
  parseAgyVersion,
} from '../delegate/agyCli.js';
import { type AdapterInfo, type ComponentAdapter, LogBuffer, errText, fetchJsonLimited, pickString } from './common.js';

export const CLAUDE_LATEST_URL = 'https://registry.npmjs.org/@anthropic-ai/claude-code/latest';
const VERSION_TIMEOUT_MS = 10_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000;
const STRICT_SEMVER = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

export interface ClaudeAdapterOptions {
  /** 显式指定的 claude 路径（startServer 的 claudePath 选项）；视为自定义 */
  claudePath?: string;
  /** 正在运行的会话数（manager.runningCount） */
  running: () => number;
  env?: () => NodeJS.ProcessEnv;
  resolvePath?: (env: NodeJS.ProcessEnv) => string;
  runCommand?: AgyCommandRunner;
  fetch?: typeof globalThis.fetch;
  statFile?: (p: string) => { mtimeMs: number; size: number } | null;
  now?: () => number;
  versionTimeoutMs?: number;
  updateTimeoutMs?: number;
}

function defaultStat(p: string): { mtimeMs: number; size: number } | null {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? { mtimeMs: st.mtimeMs, size: st.size } : null;
  } catch {
    return null;
  }
}

export function createClaudeAdapter(opts: ClaudeAdapterOptions): ComponentAdapter & { waitIdle(): Promise<void> } {
  const envFn = opts.env ?? (() => process.env);
  const resolvePath = opts.resolvePath ?? ((env) => resolveClaude(env));
  const runCmd = opts.runCommand ?? defaultRunCommand;
  const fetchFn = opts.fetch ?? globalThis.fetch;
  const statFile = opts.statFile ?? defaultStat;
  const now = opts.now ?? Date.now;
  const versionTimeoutMs = opts.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
  const updateTimeoutMs = opts.updateTimeoutMs ?? UPDATE_TIMEOUT_MS;
  const log = new LogBuffer();

  let latest: string | null = null;
  let checkedAt: number | null = null;
  let cache: { path: string; mtimeMs: number; size: number; version: string } | null = null;
  let updating: Promise<void> | null = null;

  const isCustom = (env: NodeJS.ProcessEnv) => Boolean(opts.claudePath) || Boolean(env.COSYEE_CLAUDE?.trim());
  const claudePath = (env: NodeJS.ProcessEnv) => opts.claudePath || resolvePath(env);

  /** 运行 claude 用的环境：去掉外层 Claude Code 会话的 CLAUDE_CODE_* 变量 */
  const runEnv = () => cleanEnv(envFn());

  async function readVersion(p: string, force = false): Promise<string | null> {
    const st = statFile(p);
    if (!force && st && cache && cache.path === p && cache.mtimeMs === st.mtimeMs && cache.size === st.size) {
      return cache.version;
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), versionTimeoutMs);
    timer.unref?.();
    try {
      const res = await runCmd(p, ['--version'], { env: runEnv(), signal: ac.signal });
      if (res.code !== 0) return null;
      const v = parseAgyVersion(res.stdout) ?? parseAgyVersion(res.stderr);
      if (v && st) cache = { path: p, mtimeMs: st.mtimeMs, size: st.size, version: v };
      return v;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    id: 'claude',
    name: 'Claude CLI',
    updatedBy: 'server',

    async info(): Promise<AdapterInfo> {
      const env = envFn();
      const version = await readVersion(claudePath(env));
      const installed = version !== null;
      return {
        installed,
        custom: isCustom(env),
        version,
        latest,
        updateAvailable: Boolean(version && latest && compareSemver(latest, version) > 0),
        checkedAt,
        checkError: null,
        busy: opts.running(),
        job: null,
      };
    },

    async check(): Promise<void> {
      const data = await fetchJsonLimited(fetchFn, CLAUDE_LATEST_URL);
      const v = pickString(data, 'version');
      if (!STRICT_SEMVER.test(v)) throw new Error('npm 返回的版本号格式无效');
      latest = v;
      checkedAt = now();
    },

    update(): Promise<void> {
      if (updating) return updating;
      const run = (async () => {
        log.reset();
        log.append('开始更新 Claude CLI（claude update）…');
        const env = envFn();
        const p = claudePath(env);
        const ac = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          ac.abort();
        }, updateTimeoutMs);
        timer.unref?.();
        try {
          const res = await runCmd(p, ['update'], { env: runEnv(), signal: ac.signal, onLine: (l) => log.append(l) });
          if (res.code !== 0) {
            const detail = lastNonEmptyLine(res.stderr) ?? lastNonEmptyLine(res.stdout);
            throw new Error(detail ? `更新失败（退出码 ${res.code}）: ${detail}` : `更新失败（退出码 ${res.code}）`);
          }
          cache = null;
          const v = await readVersion(p, true);
          log.append(v ? `完成，当前版本：${v}` : '完成');
        } catch (e) {
          const msg = timedOut ? '更新超时，已终止子进程' : errText(e);
          log.append(msg);
          throw new Error(msg);
        } finally {
          clearTimeout(timer);
        }
      })();
      updating = run;
      const clear = () => {
        if (updating === run) updating = null;
      };
      run.then(clear, clear);
      return run;
    },

    log: (from) => log.read(from),

    waitIdle: () => (updating ?? Promise.resolve()).catch(() => undefined),
  };
}
