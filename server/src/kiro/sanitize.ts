// Kiro 模块公用工具：错误脱敏、原子写盘、凭据与区域校验。
import fs from 'node:fs';
import path from 'node:path';
import type { KiroLoginMethod } from '@cosyee/shared';

export const KIRO_SERVICE_STOPPED = 'kiro.rs 服务已停止，请在客户端的「本机服务」里启动';
export const KIRO_ENGINE_MISSING = '还没有安装 kiro.rs 引擎，请先安装';

export const KIRO_LOGIN_METHODS: readonly KiroLoginMethod[] = ['builderId', 'idc', 'kiroIde', 'kiroCli', 'apiKey'];

/** AWS Region 严格校验（如 us-east-1、ap-southeast-1、us-gov-west-1），防止 SSRF 拼入恶意主机名 */
export const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/;

/** 40 位十六进制 SHA-1（kiroIde 的 clientIdHash 与 git commit sha） */
export const HEX40_RE = /^[0-9a-f]{40}$/i;

/** Kiro API Key：ksk_ 开头、可见 ASCII */
export const KIRO_API_KEY_RE = /^ksk_[\x21-\x7e]{4,500}$/;

/** IdC Start URL 允许的主机后缀 */
const IDC_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:awsapps\.com|app\.aws)$/;

export function isValidRegion(v: unknown): v is string {
  return typeof v === 'string' && AWS_REGION_RE.test(v.trim());
}

/** Kiro API 只部署在这几个区域；IAM Identity Center 的登录区域可以是任意区域 */
const KIRO_API_REGIONS = new Set(['us-east-1', 'eu-central-1']);

/** API 区域：profileArn 里带的优先；登录区域没有 API 端点时用 us-east-1 */
export function kiroApiRegion(authRegion: string, profileArn: string | null): string {
  const fromArn = profileArn?.split(':')[3] ?? '';
  if (isValidRegion(fromArn)) return fromArn;
  return KIRO_API_REGIONS.has(authRegion) || authRegion.startsWith('us-gov-') ? authRegion : 'us-east-1';
}

/** 校验并规范 IdC Start URL：必须 https 且主机以 .awsapps.com 或 .app.aws 结尾，防 SSRF */
export function normalizeStartUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s || s.length > 500 || /[\s\x00-\x1f]/.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (!IDC_HOST_RE.test(host)) return null;
  return u.toString();
}

/** 原子写文件（临时文件 + rename）；mode 传 0o600 保护凭据 */
export function writeFileAtomic(file: string, data: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2, 8)}.tmp`;
  fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/**
 * 对外错误脱敏：去掉可能出现的令牌、密钥、Bearer / x-api-key / ksk_ / 长随机串，并截断长度。
 * 绝不把原始令牌、clientSecret、proxy apiKey 暴露到 HTTP 响应或日志中。
 */
export function sanitizeKiroError(raw: unknown, maxLen = 240): string {
  const s = (raw instanceof Error ? raw.message : String(raw ?? '')).replace(/[\r\n\t]+/g, ' ').trim();
  if (!s) return '未知错误';
  const cleaned = s
    .replace(/\bksk_[\x21-\x7e]+/gi, 'ksk_***')
    .replace(/\b(Bearer|Basic)\s+[\x21-\x7e]+/gi, '$1 ***')
    .replace(/(x-api-key|api[_-]?key|admin[_-]?api[_-]?key|refresh[_-]?token|access[_-]?token|client[_-]?secret|kiro[_-]?api[_-]?key)\s*[:=]\s*["']?[\x21-\x7e]+["']?/gi, '$1=***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '***')
    .replace(/\b[A-Za-z0-9+/_=-]{48,}\b/g, '***');
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}

export interface KiroCredentialInput {
  authMethod: 'social' | 'idc' | 'api_key';
  refreshToken?: string | null;
  accessToken?: string | null;
  expiresAt?: string | null;
  profileArn?: string | null;
  clientId?: string | null;
  clientSecret?: string | null;
  authRegion?: string | null;
  apiRegion?: string | null;
  kiroApiKey?: string | null;
}

export interface KiroCredentialEntry {
  authMethod: 'social' | 'idc' | 'api_key';
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: string;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
  authRegion?: string;
  apiRegion?: string;
  kiroApiKey?: string;
}

/**
 * 构造写入 kiro.rs credentials.json 的凭据条目。
 * 关键规则：只有 accessToken 与 expiresAt 同时存在且 expiresAt 在未来时才一起写入，
 * 否则两者都不写，让 kiro.rs 自行刷新（避免有未来 expiresAt 却缺 accessToken 报错）。
 */
export function buildKiroCredential(input: KiroCredentialInput, nowMs: number = Date.now()): KiroCredentialEntry {
  const out: KiroCredentialEntry = { authMethod: input.authMethod };
  if (input.authMethod === 'api_key') {
    if (input.kiroApiKey) out.kiroApiKey = input.kiroApiKey;
    if (input.apiRegion) out.apiRegion = input.apiRegion;
    return out;
  }
  if (input.refreshToken) out.refreshToken = input.refreshToken;
  const at = typeof input.accessToken === 'string' && input.accessToken.trim() ? input.accessToken.trim() : null;
  const exp = typeof input.expiresAt === 'string' && input.expiresAt.trim() ? input.expiresAt.trim() : null;
  const expMs = exp ? Date.parse(exp) : NaN;
  if (at && exp && Number.isFinite(expMs) && expMs > nowMs) {
    out.accessToken = at;
    out.expiresAt = new Date(expMs).toISOString();
  }
  if (input.profileArn) out.profileArn = input.profileArn;
  if (input.clientId) out.clientId = input.clientId;
  if (input.clientSecret) out.clientSecret = input.clientSecret;
  if (input.authRegion) out.authRegion = input.authRegion;
  if (input.apiRegion) out.apiRegion = input.apiRegion;
  return out;
}
