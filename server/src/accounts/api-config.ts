// API 账号：不走 claude.ai 登录，而是用 API Key（可自定义 Base URL，用于第三方兼容服务 / 代理）。
// 配置存在账号目录里的私有文件（不在共享链接里，移除账号时随目录一起删掉）；启动 claude 时注入环境变量。
// 密钥绝不下发前端，列表里只给 Base URL 与密钥末 4 位。
import fs from 'node:fs';
import path from 'node:path';
import type { AccountApiInfo, ApiAuthType } from '@cosyee/shared';

export const API_FILE = 'cosyee-api.json';
export const OFFICIAL_HOST = 'api.anthropic.com';

export interface ApiConfig {
  /** 空 = 官方地址 */
  baseUrl: string;
  apiKey: string;
  /** apiKey = ANTHROPIC_API_KEY（x-api-key 头）；authToken = ANTHROPIC_AUTH_TOKEN（Authorization: Bearer） */
  authType: ApiAuthType;
}

/** 账号目录里的 API 配置；不是 API 账号（或读不到）返回 null */
export function readApiConfig(dir: string | null | undefined): ApiConfig | null {
  if (!dir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, API_FILE), 'utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object' || typeof j.apiKey !== 'string' || !j.apiKey) return null;
    return {
      baseUrl: typeof j.baseUrl === 'string' ? j.baseUrl : '',
      apiKey: j.apiKey,
      authType: j.authType === 'authToken' ? 'authToken' : 'apiKey',
    };
  } catch {
    return null;
  }
}

export function writeApiConfig(dir: string, cfg: ApiConfig): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, API_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 列表里显示的主机名（Base URL 为空 = 官方） */
export function apiHost(baseUrl: string): string {
  if (!baseUrl) return OFFICIAL_HOST;
  try {
    return new URL(baseUrl).host || baseUrl;
  } catch {
    return baseUrl;
  }
}

/** 下发给前端的信息：不含密钥本身 */
export function apiInfo(cfg: ApiConfig): AccountApiInfo {
  return { baseUrl: cfg.baseUrl, authType: cfg.authType, keyHint: cfg.apiKey.length > 8 ? cfg.apiKey.slice(-4) : '' };
}

const API_ENV_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'];

/** 把 API 配置写进子进程环境：先删掉外部环境里继承来的同名变量，避免混用 */
export function applyApiEnv(env: NodeJS.ProcessEnv, cfg: ApiConfig): void {
  for (const k of Object.keys(env)) if (API_ENV_KEYS.includes(k.toUpperCase())) delete env[k];
  if (cfg.authType === 'authToken') env.ANTHROPIC_AUTH_TOKEN = cfg.apiKey;
  else env.ANTHROPIC_API_KEY = cfg.apiKey;
  if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;
}

/** 校验并规范 Base URL：空 = 官方；只允许 http / https；去掉末尾的斜杠。不合法返回 null */
export function normalizeBaseUrl(v: unknown): string | null {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return '';
  if (s.length > 500 || /[\s\x00-\x1f]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.search || u.hash) return null;
  return s.replace(/\/+$/, '');
}

/** 校验 API Key：可见 ASCII、不含空白；不合法返回 null */
export function normalizeApiKey(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 1000 || !/^[\x21-\x7e]+$/.test(s)) return null;
  return s;
}
