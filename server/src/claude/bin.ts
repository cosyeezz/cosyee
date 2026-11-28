// 定位 claude 可执行文件、构造干净的环境变量、生成 spawn 参数。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyApiEnv, apiSettingsEnv, readApiConfig } from '../accounts/api-config.js';
import { activeConfigDir, cosyeeHome } from '../paths.js';

const isWin = process.platform === 'win32';

/** 继承当前环境，但删除所有 CLAUDE_CODE_* 与 CLAUDECODE（避免被外层 Claude Code 会话的设置影响）。 */
export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const key = k.toUpperCase();
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') continue;
    env[k] = v;
  }
  return env;
}

type BeforeClaudeEnvHook = (dir: string) => void;
let beforeClaudeEnvHook: BeforeClaudeEnvHook | null = null;

/** 启动 claude 构造环境变量前的钩子（供 server.ts 注册 Kiro 代理按需拉起；默认无操作，测试不意外启进程） */
export function setBeforeClaudeEnv(hook: BeforeClaudeEnvHook | null): void {
  beforeClaudeEnvHook = hook;
}

/** Claude CLI 的凭据存储目录变量：登录凭据（.credentials.json / macOS 钥匙串条目）、刷新锁 .oauth_refresh.lock 都按它定位，缺省跟随 CLAUDE_CONFIG_DIR */
export const CRED_STORAGE_ENV = 'CLAUDE_SECURESTORAGE_CONFIG_DIR';

function envGet(env: NodeJS.ProcessEnv, name: string): string | undefined {
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() === name) return v;
  return undefined;
}

function envDel(env: NodeJS.ProcessEnv, name: string): void {
  for (const k of Object.keys(env)) if (k.toUpperCase() === name) delete env[k];
}

/**
 * 某个账号的主代理进程实际使用的凭据存储目录，作为子代理进程 CLAUDE_SECURESTORAGE_CONFIG_DIR 的值，
 * 让两边读写同一份凭据、共用同一把刷新锁（各持一份 refresh token 会互相把对方的令牌轮换作废）。
 * - 添加的账号：账号目录；
 * - 默认账号：沿用外部环境里的 CLAUDE_SECURESTORAGE_CONFIG_DIR / CLAUDE_CONFIG_DIR；都没有时为 ~/.claude，
 *   macOS 用空串（CLI 据此派生不带后缀的钥匙串服务名「Claude Code-credentials」，与默认登录一致）。
 */
export function credStorageDirFor(
  mainDir: string | null,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  if (mainDir) return mainDir;
  const sec = envGet(base, CRED_STORAGE_ENV);
  if (sec !== undefined) return sec;
  const cfg = envGet(base, 'CLAUDE_CONFIG_DIR');
  if (cfg) return cfg;
  return platform === 'darwin' ? '' : path.join(os.homedir(), '.claude');
}

/**
 * 启动 claude 用的环境：cleanEnv + 当前账号的 CLAUDE_CONFIG_DIR（默认账号不改，沿用外部环境）。
 * API 账号再注入它的 API Key / Base URL（覆盖外部环境里的同名变量）；
 * Kiro 账号在读取配置前先触发钩子确保本地代理已启动并完成端口同步。
 * apiDir：API / Kiro 配置的读取目录，默认同 dir；子代理空间传入主代理账号目录（CLAUDE_CONFIG_DIR 仍指向子代理空间）。
 * credDir：凭据存储目录（CLAUDE_SECURESTORAGE_CONFIG_DIR）；子代理空间传入 credStorageDirFor(主代理账号目录)，
 * 不传则添加的账号用自己的目录（去掉外部继承的值，免得各账号串用同一份凭据），默认账号沿用外部环境。
 */
export function claudeEnv(
  dir: string | null = activeConfigDir(),
  apiDir: string | null = dir,
  credDir?: string,
): NodeJS.ProcessEnv {
  const env = cleanEnv();
  if (dir) {
    envDel(env, 'CLAUDE_CONFIG_DIR');
    env.CLAUDE_CONFIG_DIR = dir;
    envDel(env, CRED_STORAGE_ENV);
  }
  if (credDir !== undefined) {
    envDel(env, CRED_STORAGE_ENV);
    env[CRED_STORAGE_ENV] = credDir;
  }
  if (apiDir) {
    const api0 = readApiConfig(apiDir);
    if (api0?.kiro) beforeClaudeEnvHook?.(apiDir);
    const api = api0?.kiro ? readApiConfig(apiDir) : api0;
    if (api) applyApiEnv(env, api);
  }
  return env;
}

/**
 * API / Kiro 账号启动 claude 时要放进 --settings 的 env（见 apiSettingsEnv，含密钥）；其它账号返回 null。
 * 在 claudeEnv(dir) 之后调用：Kiro 账号那时已完成端口同步。
 */
export function apiFlagEnv(dir: string | null | undefined): Record<string, string> | null {
  const api = readApiConfig(dir);
  return api ? apiSettingsEnv(api) : null;
}

function runDir(): string {
  return path.join(cosyeeHome(), 'run');
}

/** 把含密钥的 settings 写进私有文件（目录 0700、文件 0600），返回路径，供 --settings 使用；同名覆盖 */
export function writePrivateSettings(name: string, settings: Record<string, unknown>): string {
  const dir = runDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings), { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    removePrivateSettings(tmp);
    throw e;
  }
  return file;
}

/** 删掉 writePrivateSettings 写的文件（不存在就算了） */
export function removePrivateSettings(file: string | null | undefined): void {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch { /* ignore */ }
}

export function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 找 claude：COSYEE_CLAUDE > PATH > ~/.local/bin。找不到返回 null。 */
export function findClaude(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.COSYEE_CLAUDE;
  if (override) return override;
  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((d) => (isWin ? d.trim().replace(/^"|"$/g, '') : d.trim()))
    .filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** 找 claude：COSYEE_CLAUDE > PATH > ~/.local/bin。找不到返回 'claude'（让 spawn 报 ENOENT）。 */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env): string {
  return findClaude(env) ?? 'claude';
}

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Windows 下 .cmd 包装时需要原样传递命令行 */
  verbatim: boolean;
}

const CMD_META = /([()\][%!^"`<>&|;,*?])/g;

/**
 * 为 Windows `cmd.exe /d /s /c` + `.cmd/.bat` 的 `%*` 二次展开安全转义单个参数：
 * 先按 Win32 CRT（CommandLineToArgvW）规则处理反斜杠与双引号并加外层引号，
 * 再对 cmd.exe 元字符做两轮 `^` 转义（防引号逃逸、命令注入与 `%VAR%` 展开）。
 */
function quoteForCmd(a: string): string {
  let s = a.replace(/(\\*)"/g, '$1$1\\"');
  s = '"' + s.replace(/(\\*)$/, '$1$1') + '"';
  s = s.replace(CMD_META, '^$1');
  s = s.replace(CMD_META, '^$1');
  return s;
}

/** 生成 spawn 的命令与参数；Windows 的 .cmd/.bat 需要经 cmd.exe /d /s /c 包装。 */
export function spawnSpec(claudePath: string, args: string[]): SpawnSpec {
  if (isWin && /\.(cmd|bat)$/i.test(claudePath)) {
    const cmd = `"${claudePath.replace(/"/g, '')}"`;
    const line = [cmd, ...args.map(quoteForCmd)].join(' ');
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
  }
  return { command: claudePath, args, verbatim: false };
}

/** 杀进程树（Windows 用 taskkill /T，其它平台 SIGKILL）；失败忽略。 */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } catch { /* ignore */ }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
}

/** 同步版（进程退出钩子里用）。 */
export function killTreeSync(pid: number): void {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    } catch { /* ignore */ }
  } else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch { /* ignore */ }
  }
}
