// 定位 claude 可执行文件、构造干净的环境变量、生成 spawn 参数。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { activeConfigDir } from '../paths.js';

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

/** 启动 claude 用的环境：cleanEnv + 当前账号的 CLAUDE_CONFIG_DIR（默认账号不改，沿用外部环境）。 */
export function claudeEnv(dir: string | null = activeConfigDir()): NodeJS.ProcessEnv {
  const env = cleanEnv();
  if (dir) {
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'CLAUDE_CONFIG_DIR') delete env[k];
    env.CLAUDE_CONFIG_DIR = dir;
  }
  return env;
}

function isFile(p: string): boolean {
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
