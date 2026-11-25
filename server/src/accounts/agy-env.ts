// Antigravity CLI（agy）多账号的环境变量与额外参数：集中在这里，登录与运行都只走这里。
import path from 'node:path';
import { cleanEnv } from '../claude/bin.js';

/** 删除环境变量（忽略大小写，适配 Windows） */
function deleteEnvIgnoreCase(env: NodeJS.ProcessEnv, name: string): void {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) delete env[k];
  }
}

/**
 * 运行 / 探测 agy 用的环境变量：
 * - dir 为 null（默认账号）：只 cleanEnv，不加任何东西（沿用系统凭据库）
 * - dir 非空（添加的账号）：cleanEnv + AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1（不改 USERPROFILE/HOME）
 */
export function agyAccountEnv(dir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = cleanEnv(base);
  if (dir !== null) {
    deleteEnvIgnoreCase(env, 'AGY_CLI_FORCE_FILE_TOKEN_STORAGE');
    env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE = '1';
  }
  return env;
}

/**
 * 运行 / 探测 / 登录 agy 的额外 CLI 参数：
 * - dir 为 null（默认账号）：空数组
 * - dir 非空（<root>/<id>）：['--gemini-dir', <root>, '--app-data-dir', <id>]
 */
export function agyAccountArgs(dir: string | null): string[] {
  if (dir === null) return [];
  const abs = path.resolve(dir);
  return ['--gemini-dir', path.dirname(abs), '--app-data-dir', path.basename(abs)];
}

/**
 * 探测 agy 用的额外 CLI 参数：
 * - dir 非空（添加的账号）：同 agyAccountArgs(dir)
 * - dir 为 null 且传入一次性临时目录（Windows 默认账号探测）：['--gemini-dir', <scratchDir>, '--app-data-dir', 'p']
 * - 其余（非 Windows 默认账号）：空数组
 */
export function agyProbeArgs(dir: string | null, scratchDir?: string): string[] {
  if (dir !== null) return agyAccountArgs(dir);
  if (scratchDir) return ['--gemini-dir', path.resolve(scratchDir), '--app-data-dir', 'p'];
  return [];
}

/**
 * 登录 agy 用的环境变量：在 agyAccountEnv 基础上加 SSH_CONNECTION，
 * 让 `agy acp --login` 不弹本机浏览器，只输出登录链接等待粘贴授权码。运行时不要设。
 */
export function agyLoginEnv(dir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = agyAccountEnv(dir, base);
  deleteEnvIgnoreCase(env, 'SSH_CONNECTION');
  env.SSH_CONNECTION = '127.0.0.1 54321 127.0.0.1 22';
  return env;
}
