// Codex CLI 多账号的环境变量与额外参数：集中在这里，登录、探测与运行都只走这里。
// 账号隔离靠 CODEX_HOME（每个添加的账号一个目录，里面放 auth.json / config / sessions）。
import fs from 'node:fs';
import path from 'node:path';
import { cleanEnv } from '../claude/bin.js';

/** 不能带进 codex 子进程的 Cosyee 内部变量（含 token / 本机服务地址）；前缀匹配，忽略大小写 */
const COSYEE_SENSITIVE = /^COSYEE_(?:AGENT_TOKEN|API_URL|HOST|PORT|WEB_PORT|HOME|ACCOUNTS_DIR|[A-Z_]*ACCOUNTS_DIR|DEFS|TERM_[A-Z_]*|TERMINAL_CWD|KIRO_RS|SNIPPET|PICKER_PS)$|^COSYEE_[A-Z_]*(?:TOKEN|SECRET|KEY|PASSWORD)$/i;

/** 添加的账号必须从环境里抹掉的认证 / 路由变量：外部环境里的它们会盖过账号自己的登录态 */
const ACCOUNT_STRIPPED = ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL'] as const;

function deleteEnvIgnoreCase(env: NodeJS.ProcessEnv, name: string): void {
  const upper = name.toUpperCase();
  for (const k of Object.keys(env)) {
    if (k.toUpperCase() === upper) delete env[k];
  }
}

/**
 * 运行 / 探测 / 登录 codex 用的环境变量：
 * - 先 cleanEnv（去 CLAUDE_CODE_* / CLAUDECODE），再清 Cosyee 内部变量（token、本机服务地址等）。
 * - dir 为 null（默认账号）：其余保持宿主环境（含宿主自己的 CODEX_HOME / OPENAI_* ）。
 * - dir 非空（添加的账号）：删除 CODEX_HOME / CODEX_API_KEY / OPENAI_API_KEY / OPENAI_BASE_URL（忽略大小写），
 *   并设 CODEX_HOME=<dir 的绝对路径>，不让宿主的密钥泄漏给别的账号。
 */
export function codexAccountEnv(dir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = cleanEnv(base);
  for (const k of Object.keys(env)) {
    if (COSYEE_SENSITIVE.test(k)) delete env[k];
  }
  if (dir !== null) {
    for (const k of ACCOUNT_STRIPPED) deleteEnvIgnoreCase(env, k);
    env.CODEX_HOME = path.resolve(dir);
  }
  return env;
}

/**
 * 运行 / 探测 / 登录 codex 的额外全局参数：
 * - dir 为 null：空数组
 * - dir 非空：登录凭据强制写文件（不用系统钥匙串，否则多个账号会互相覆盖）
 */
export function codexAccountArgs(dir: string | null): string[] {
  if (dir === null) return [];
  return ['-c', 'cli_auth_credentials_store="file"'];
}

/** CODEX_HOME 必须预先存在（codex 不会替我们创建）；目录权限 0700（Unix） */
export function ensureCodexHome(dir: string): void {
  fs.mkdirSync(path.resolve(dir), { recursive: true, mode: 0o700 });
}
