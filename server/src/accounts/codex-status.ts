// Codex 账号状态解析：auth.json 元信息（仅内存读取，绝不对外返回 token）与限额快照解析。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CodexQuota, CodexQuotaGroup, CodexQuotaWindow } from '@cosyee/shared';
import { hashEmail, lstat } from './fs.js';

export const CODEX_AUTH_FILE = 'auth.json';
const AUTH_FILE_MAX = 256 * 1024;
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export interface CodexAuthMeta {
  authMode: 'chatgpt' | 'apiKey' | null;
  email: string | null;
  accountId: string | null;
  planType: string | null;
  /** 仅用于判重：sha256('apikey:' + key)，绝不下发或记录原 key */
  apiKeyHash: string | null;
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Codex 协议的 resetsAt 为 Unix epoch 秒；小于 1e12 按秒转毫秒，否则按毫秒保留 */
function toEpochMs(v: unknown): number | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

function parseWindow(v: unknown): CodexQuotaWindow | null {
  if (!isObj(v)) return null;
  const used = num(v.usedPercent);
  if (used === null) return null;
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMins: num(v.windowDurationMins),
    resetsAt: toEpochMs(v.resetsAt),
  };
}

function parseSnapshotGroup(v: unknown, fallbackLimitId: string): { group: CodexQuotaGroup; planType: string | null } | null {
  if (!isObj(v)) return null;
  const primary = parseWindow(v.primary);
  const secondary = parseWindow(v.secondary);
  const limitId = str(v.limitId) ?? fallbackLimitId;
  const limitName = str(v.limitName);
  const planType = str(v.planType);
  if (!primary && !secondary && !planType) return null;
  return {
    group: {
      limitId,
      ...(limitName ? { limitName } : {}),
      primary,
      secondary,
    },
    planType,
  };
}

/**
 * 解析 account/rateLimits/read 响应（GetAccountRateLimitsResponse）或 account/rateLimits/updated 通知里的限额。
 * - 支持 rateLimitsByLimitId 多组与 rateLimits 单组；
 * - resetsAt 由秒转换为毫秒；windowDurationMins 透传为 windowMins。
 */
export function parseCodexRateLimits(raw: unknown, at: number = Date.now()): CodexQuota | null {
  if (!isObj(raw)) return null;
  const groups: CodexQuotaGroup[] = [];
  let planType: string | null = null;

  const byId = isObj(raw.rateLimitsByLimitId) ? raw.rateLimitsByLimitId : null;
  if (byId) {
    for (const [key, snap] of Object.entries(byId)) {
      const parsed = parseSnapshotGroup(snap, key || 'codex');
      if (!parsed) continue;
      groups.push(parsed.group);
      if (!planType && parsed.planType) planType = parsed.planType;
    }
  }

  if (groups.length === 0) {
    const single = isObj(raw.rateLimits) ? raw.rateLimits : raw;
    const parsed = parseSnapshotGroup(single, 'codex');
    if (parsed) {
      groups.push(parsed.group);
      planType = parsed.planType;
    }
  } else if (!planType && isObj(raw.rateLimits)) {
    planType = str(raw.rateLimits.planType);
  }

  if (groups.length === 0 && !planType) return null;
  return {
    groups,
    planType,
    fetchedAt: at,
  };
}

/**
 * 把滚动推送（account/rateLimits/updated）合并到已有限额缓存：
 * 按 limitId 替换/追加组，不清空未出现在本次推送里的其它组与已有 planType。
 */
export function mergeCodexQuota(prev: CodexQuota | null, update: unknown, at: number = Date.now()): CodexQuota | null {
  const next = parseCodexRateLimits(update, at);
  if (!next) return prev;
  if (!prev) return next;
  const map = new Map<string, CodexQuotaGroup>();
  for (const g of prev.groups) map.set(g.limitId, g);
  for (const g of next.groups) {
    const old = map.get(g.limitId);
    map.set(g.limitId, {
      limitId: g.limitId,
      ...(g.limitName ?? old?.limitName ? { limitName: g.limitName ?? old?.limitName } : {}),
      primary: g.primary ?? old?.primary ?? null,
      secondary: g.secondary ?? old?.secondary ?? null,
    });
  }
  return {
    groups: [...map.values()],
    planType: next.planType ?? prev.planType ?? null,
    fetchedAt: at,
  };
}

/** 检查 CODEX_HOME 下是否存在 auth.json 普通文件（不跟进 symlink） */
export function hasCodexAuthFile(dir: string): boolean {
  const st = lstat(path.join(dir, CODEX_AUTH_FILE));
  return Boolean(st && st.isFile());
}

function decodeJwtPayload(jwt: unknown): Record<string, any> | null {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = Buffer.from(b64 + pad, 'base64').toString('utf8');
    const parsed = JSON.parse(json);
    return isObj(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function hashApiKey(raw: string): string {
  return crypto.createHash('sha256').update(`apikey:${raw.trim()}`).digest('hex');
}

/**
 * 计算 Codex 账号的判重身份哈希（仅存哈希，不存原始邮箱/密钥）：
 * - API Key 账号：sha256('apikey:' + key)
 * - ChatGPT 账号：email + (accountId ? ':' + accountId : '') 的 sha256（同邮箱不同 workspace 算不同账号）
 */
export function computeCodexIdentityHash(meta: {
  authMode?: 'chatgpt' | 'apiKey' | null;
  email?: string | null;
  accountId?: string | null;
  apiKeyHash?: string | null;
}): string | null {
  if (meta.authMode === 'apiKey' || meta.apiKeyHash) {
    return meta.apiKeyHash ?? null;
  }
  const email = str(meta.email);
  const accId = str(meta.accountId);
  if (email) {
    const key = accId ? `${email.toLowerCase()}:${accId.toLowerCase()}` : email.toLowerCase();
    return hashEmail(key);
  }
  if (accId) {
    return crypto.createHash('sha256').update(`chatgpt:${accId.toLowerCase()}`).digest('hex');
  }
  return null;
}

/**
 * 仅在内存中解析 <CODEX_HOME>/auth.json 的元信息（authMode / email / accountId / planType / apiKeyHash）。
 * 不跟进 symlink，绝不对外返回任何 token 或原始 API Key。
 */
export function readAuthJsonMeta(dir: string): CodexAuthMeta | null {
  const file = path.join(dir, CODEX_AUTH_FILE);
  const st = lstat(file);
  if (!st || !st.isFile() || st.size > AUTH_FILE_MAX) return null;
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (!isObj(data)) return null;

  const rawMode = str(data.auth_mode)?.toLowerCase() ?? null;
  const rawApiKey = str(data.OPENAI_API_KEY) ?? str(data.openai_api_key);
  const tokens = isObj(data.tokens) ? data.tokens : null;

  let authMode: 'chatgpt' | 'apiKey' | null = null;
  if (rawMode === 'apikey' || rawMode === 'api_key') authMode = 'apiKey';
  else if (rawMode === 'chatgpt' || rawMode === 'chatgpt_auth_tokens' || rawMode === 'chatgptauthtokens') authMode = 'chatgpt';
  else if (tokens && (str(tokens.id_token) || str(tokens.access_token))) authMode = 'chatgpt';
  else if (rawApiKey) authMode = 'apiKey';

  if (authMode === 'apiKey') {
    return {
      authMode: 'apiKey',
      email: null,
      accountId: null,
      planType: null,
      apiKeyHash: rawApiKey ? hashApiKey(rawApiKey) : null,
    };
  }

  const idPayload = decodeJwtPayload(tokens?.id_token);
  const accessPayload = decodeJwtPayload(tokens?.access_token);
  const authClaim = isObj(idPayload?.['https://api.openai.com/auth'])
    ? idPayload['https://api.openai.com/auth']
    : isObj(accessPayload?.['https://api.openai.com/auth'])
      ? accessPayload['https://api.openai.com/auth']
      : null;

  const rawEmail = str(idPayload?.email) ?? str(accessPayload?.email);
  const email = rawEmail && rawEmail.length <= 320 && EMAIL_RE.test(rawEmail) ? rawEmail : null;
  const accountId = str(authClaim?.chatgpt_account_id) ?? str(tokens?.account_id);
  const planType = str(authClaim?.chatgpt_plan_type);

  if (!authMode && !email && !accountId) return null;
  return {
    authMode: authMode ?? 'chatgpt',
    email,
    accountId,
    planType,
    apiKeyHash: null,
  };
}
