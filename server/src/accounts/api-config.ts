// API 账号：不走 claude.ai 登录，而是用 API Key（可自定义 Base URL，用于第三方兼容服务 / 代理）。
// 配置存在账号目录里的私有文件（不在共享链接里，移除账号时随目录一起删掉）；启动 claude 时注入环境变量。
// 密钥绝不下发前端，列表里只给 Base URL 与密钥末 4 位。
import fs from 'node:fs';
import path from 'node:path';
import { type AccountApiInfo, type ApiAuthType, type ApiModelMap, type ApiModelTarget, type KiroLoginMethod, MODEL_ALIASES, type ModelAlias } from '@cosyee/shared';

export const API_FILE = 'cosyee-api.json';
export const OFFICIAL_HOST = 'api.anthropic.com';

const KIRO_METHODS = new Set<string>(['builderId', 'idc', 'kiroIde', 'kiroCli', 'apiKey']);

/** Kiro 账号元数据（新格式）：账号在内置 kiro.rs 服务里对应的凭据与客户端 Key（Key 绑定以账号 id 命名的分组） */
export interface KiroAccountMeta {
  method: KiroLoginMethod;
  credentialId: number;
  keyId: number;
  /** 凭据的登录邮箱（kiro.rs 查额度时拿到的，只用于显示）；读不到就没有 */
  email?: string;
}

/** 旧格式：每个账号一个独立的 kiro.rs 进程（端口记在这里）。迁移到内置服务前仍然算 Kiro 账号 */
export interface KiroLegacyMeta {
  method: KiroLoginMethod;
  legacyPort: number;
}

export function isLegacyKiro(k: KiroAccountMeta | KiroLegacyMeta): k is KiroLegacyMeta {
  return 'legacyPort' in k;
}

export interface ApiConfig {
  /** 空 = 官方地址 */
  baseUrl: string;
  apiKey: string;
  /** apiKey = ANTHROPIC_API_KEY（x-api-key 头）；authToken = ANTHROPIC_AUTH_TOKEN（Authorization: Bearer） */
  authType: ApiAuthType;
  /** 模型映射；没配 = 不介入 */
  models?: ApiModelMap;
  /** Kiro 账号元数据（内置 kiro.rs 服务）；普通 API 账号没有 */
  kiro?: KiroAccountMeta | KiroLegacyMeta;
}

/** 邮箱只用于显示：去空白、不含控制字符、限长；不合格返回 null */
export function cleanKiroEmail(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t && t.length <= 200 && !/[\s\x00-\x1f\x7f]/.test(t) ? t : null;
}

function parseKiroMeta(v: unknown): KiroAccountMeta | KiroLegacyMeta | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.method !== 'string' || !KIRO_METHODS.has(o.method)) return null;
  const method = o.method as KiroLoginMethod;
  const isId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  if (isId(o.credentialId) && isId(o.keyId)) {
    const email = cleanKiroEmail(o.email);
    return { method, credentialId: o.credentialId, keyId: o.keyId, ...(email ? { email } : {}) };
  }
  if (typeof o.port === 'number' && Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535) {
    return { method, legacyPort: o.port };
  }
  return null;
}

/** 账号目录里的 API 配置；不是 API 账号（或读不到）返回 null */
export function readApiConfig(dir: string | null | undefined): ApiConfig | null {
  if (!dir) return null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, API_FILE), 'utf8')) as Record<string, unknown>;
    if (!j || typeof j !== 'object' || typeof j.apiKey !== 'string' || !j.apiKey) return null;
    const models = normalizeModelMap(j.models);
    const kiro = parseKiroMeta(j.kiro);
    return {
      baseUrl: typeof j.baseUrl === 'string' ? j.baseUrl : '',
      apiKey: j.apiKey,
      authType: j.authType === 'authToken' ? 'authToken' : 'apiKey',
      ...(models ? { models } : {}),
      ...(kiro ? { kiro } : {}),
    };
  } catch {
    return null;
  }
}

export function writeApiConfig(dir: string, cfg: ApiConfig): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, API_FILE);
  const tmp = `${file}.tmp`;
  // 旧格式落盘时还原成 { method, port }，保证迁移前后读写一致
  const out = cfg.kiro && isLegacyKiro(cfg.kiro) ? { ...cfg, kiro: { method: cfg.kiro.method, port: cfg.kiro.legacyPort } } : cfg;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
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
  return {
    baseUrl: cfg.baseUrl,
    authType: cfg.authType,
    keyHint: cfg.apiKey.length > 8 ? cfg.apiKey.slice(-4) : '',
    ...(cfg.models ? { models: cfg.models } : {}),
  };
}

/** 模型 id：可见 ASCII，不含空白与引号（第三方的 provider/model、model:tag 都要放过） */
const MODEL_ID_RE = /^[A-Za-z0-9._:/@+[\]-]{1,120}$/;
const LABEL_MAX = 40;
const EXTRA_MAX = 30;

function cleanModelId(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && MODEL_ID_RE.test(s) ? s : null;
}

function cleanTarget(v: unknown): ApiModelTarget | null {
  if (typeof v === 'string') {
    const id = cleanModelId(v);
    return id ? { id } : null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = cleanModelId(o.id);
  if (!id) return null;
  const label = typeof o.label === 'string' ? o.label.replace(/[\r\n\t]+/g, ' ').trim().slice(0, LABEL_MAX) : '';
  return { id, ...(label ? { label } : {}), ...(o.m1 === true ? { m1: true } : {}) };
}

/**
 * 校验并规范模型映射。全部字段都可缺省；一项都没有时返回 null（= 不介入）。
 * 非法的项直接丢掉，不抛错——映射只是转发用的字符串，宁可少一项也不要卡住保存。
 */
export function normalizeModelMap(v: unknown): ApiModelMap | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const out: ApiModelMap = {};

  const rawAlias = o.alias && typeof o.alias === 'object' ? (o.alias as Record<string, unknown>) : null;
  if (rawAlias) {
    const alias: Partial<Record<ModelAlias, ApiModelTarget>> = {};
    for (const a of MODEL_ALIASES) {
      const t = cleanTarget(rawAlias[a]);
      if (t) alias[a] = t;
    }
    if (Object.keys(alias).length) out.alias = alias;
  }

  const sub = cleanModelId(o.subagent);
  if (sub) out.subagent = sub;
  const fb = cleanModelId(o.fallback);
  if (fb) out.fallback = fb;

  if (Array.isArray(o.extra)) {
    const seen = new Set<string>();
    const extra: ApiModelTarget[] = [];
    for (const e of o.extra) {
      const t = cleanTarget(e);
      if (!t || seen.has(t.id)) continue;
      seen.add(t.id);
      extra.push(t);
      if (extra.length >= EXTRA_MAX) break;
    }
    if (extra.length) out.extra = extra;
  }

  return Object.keys(out).length ? out : null;
}

/** 别名 → CLI 的重映射环境变量（见 CLI 里的 Tb 表）。haiku 还会被 ANTHROPIC_SMALL_FAST_MODEL 抢先，一并清掉 */
const ALIAS_ENV: Record<ModelAlias, string> = {
  sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
  fable: 'ANTHROPIC_DEFAULT_FABLE_MODEL',
  haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
};

const API_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  // 模型相关：外部环境里继承来的一律清掉，只认本账号映射里写的
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_CUSTOM_MODEL_OPTION',
  'ANTHROPIC_CUSTOM_MODEL_OPTION_NAME',
  ...Object.values(ALIAS_ENV),
  ...Object.values(ALIAS_ENV).map((k) => `${k}_NAME`),
  'CLAUDE_CODE_SUBAGENT_MODEL',
];

/** 「声明支持 1M」的模型要带 [1m] 后缀（CLI 里 "claude-sonnet-5[1m]" = supports1m 的简写） */
function envModelValue(t: ApiModelTarget): string {
  return t.m1 ? `${t.id}[1m]` : t.id;
}

/**
 * 把 API 配置写进子进程环境：先删掉外部环境里继承来的同名变量，避免混用。
 * 有模型映射时再写 CLI 的别名重映射变量——菜单发出去的还是 sonnet / opus 这类别名，
 * 由 CLI 自己换成实际模型，所以订阅账号那条路完全不受影响。
 */
export function applyApiEnv(env: NodeJS.ProcessEnv, cfg: ApiConfig): void {
  for (const k of Object.keys(env)) if (API_ENV_KEYS.includes(k.toUpperCase())) delete env[k];
  if (cfg.authType === 'authToken') env.ANTHROPIC_AUTH_TOKEN = cfg.apiKey;
  else env.ANTHROPIC_API_KEY = cfg.apiKey;
  if (cfg.baseUrl) env.ANTHROPIC_BASE_URL = cfg.baseUrl;

  const m = cfg.models;
  if (!m) return;
  for (const a of MODEL_ALIASES) {
    const t = m.alias?.[a];
    if (!t?.id) continue;
    env[ALIAS_ENV[a]] = envModelValue(t);
    const label = t.label?.trim();
    if (label) env[`${ALIAS_ENV[a]}_NAME`] = label;
  }
  if (m.subagent) env.CLAUDE_CODE_SUBAGENT_MODEL = m.subagent;
  if (m.fallback) env.ANTHROPIC_DEFAULT_MODEL = m.fallback;
}

/**
 * 同一组 API 变量，写进 claude 的 --settings env 用：本账号用到的给值，其余一律置空。
 * settings.json（账号目录里是指向 ~/.claude 的共享链接）的 env 会覆盖进程环境，
 * 里面若配了 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN 等，API / Kiro 账号的请求就会发错地方；
 * 只有命令行 --settings 的优先级比它高。含密钥，只能写进私有文件，不能直接放命令行。
 */
export function apiSettingsEnv(cfg: ApiConfig): Record<string, string> {
  const env: NodeJS.ProcessEnv = {};
  applyApiEnv(env, cfg);
  const out: Record<string, string> = {};
  for (const k of API_ENV_KEYS) out[k] = env[k] ?? '';
  return out;
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
