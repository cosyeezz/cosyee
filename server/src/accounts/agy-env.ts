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
 * 运行 agy 用的环境变量：
 * - dir 为 null（不接账号管理时，agy 自己的默认目录）：只 cleanEnv
 * - dir 非空（Cosyee 里登录的账号）：cleanEnv + AGY_CLI_FORCE_FILE_TOKEN_STORAGE=1（不改 USERPROFILE/HOME）
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
 * 运行 / 登录 agy 的额外 CLI 参数：
 * - dir 为 null（agy 自己的默认目录）：空数组
 * - dir 非空（<root>/<id>）：['--gemini-dir', <root>, '--app-data-dir', <id>]
 */
export function agyAccountArgs(dir: string | null): string[] {
  if (dir === null) return [];
  const abs = path.resolve(dir);
  return ['--gemini-dir', path.dirname(abs), '--app-data-dir', path.basename(abs)];
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
