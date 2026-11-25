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

/**
 * 启动 claude 用的环境：cleanEnv + 当前账号的 CLAUDE_CONFIG_DIR（默认账号不改，沿用外部环境）。
 * API 账号再注入它的 API Key / Base URL（覆盖外部环境里的同名变量）；
 * Kiro 账号在读取配置前先触发钩子确保本地代理已启动并完成端口同步。
 */
export function claudeEnv(dir: string | null = activeConfigDir()): NodeJS.ProcessEnv {
  const env = cleanEnv();
  if (dir) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'CLAUDE_CONFIG_DIR') delete env[k];
    env.CLAUDE_CONFIG_DIR = dir;
    const api0 = readApiConfig(dir);
    if (api0?.kiro) beforeClaudeEnvHook?.(dir);
    const api = api0?.kiro ? readApiConfig(dir) : api0;
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
  fs.renameSync(tmp, file);
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

/** 找 claude：COSYEE_CLAUDE > PATH > ~/.local/bin。找不到返回 'claude'（让 spawn 报 ENOENT）。 */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.COSYEE_CLAUDE;
  if (override) return override;
  const names = isWin ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  dirs.push(path.join(os.homedir(), '.local', 'bin'));
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (isFile(p)) return p;
    }
  }
  return 'claude';
}

export interface SpawnSpec {
  command: string;
  args: string[];
  /** Windows 下 .cmd 包装时需要原样传递命令行 */
  verbatim: boolean;
}

/** 参数里允许出现的字符（模型名、effort、会话 id 等已在入口校验；这里只做 cmd.exe 的引用）。 */
function quoteForCmd(a: string): string {
  return '"' + a.replace(/"/g, '\\"') + '"';
}

/** 生成 spawn 的命令与参数；Windows 的 .cmd/.bat 需要经 cmd.exe /d /s /c 包装。 */
export function spawnSpec(claudePath: string, args: string[]): SpawnSpec {
  if (isWin && /\.(cmd|bat)$/i.test(claudePath)) {
    const line = [claudePath, ...args].map(quoteForCmd).join(' ');
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
