// 子代理配置空间与登录态双向同步：
// 每个被用作 Claude 委派子代理的账号在 ~/.claude-subagents/<accountId> 拥有独立配置空间：
// - 共享（链接到基础配置目录，复用 links.ts）：skills、agents、commands、plugins、output-styles、hooks、settings.json、CLAUDE.md、keybindings.json；
// - 隔离（子代理空间自己的）：projects、file-history、todos、plans、tasks、session-env、paste-cache、history.jsonl，以及 .claude.json 其余状态；
// - 登录态：子代理进程用 CLAUDE_SECURESTORAGE_CONFIG_DIR 直接读写主代理空间的凭据（同一份令牌、同一把刷新锁，见 claudeBackend）；
//   另外仍把 .credentials.json（macOS 钥匙串条目）复制到子空间并双向「较新者胜」同步，只给不认这个变量的旧版 CLI 兜底；
//   .claude.json 只复制 oauthAccount、顶层 mcpServers、projects 下各项目的 MCP 字段，以及跳过首次引导所需的最少字段（hasCompletedOnboarding / lastOnboardingVersion / bypassPermissionsModeAccepted）；
// - API / Kiro 账号不复制凭据，环境变量在启动子进程时仍从主代理账号目录读取。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseClaudeHome, claudeJsonPath, isSafeId, pathKey, subagentAccountDir, subagentAccountsRoot } from '../paths.js';
import { readApiConfig } from './api-config.js';
import { ensureLinks, removeLink, SUBAGENT_SHARED_DIRS, SUBAGENT_SHARED_FILES, unlinkShared } from './links.js';

export const KEYCHAIN_ACCOUNT = 'claude-code-user';
export const KEYCHAIN_PREFIX = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 5000;
/** macOS security 命令在条目不存在时返回的退出码（errSecItemNotFound） */
const ERR_SEC_ITEM_NOT_FOUND = 44;

export interface KeychainAdapter {
  /** 读取钥匙串条目原文；不存在返回 null，读取失败抛错 */
  read(service: string): string | null;
  /** 写入 / 更新钥匙串条目；失败抛错 */
  write(service: string, data: string): void;
  /** 删除钥匙串条目（可选，移除账号时清理） */
  remove?(service: string): void;
}

export interface SubagentSpaceOptions {
  platform?: NodeJS.Platform;
  keychain?: KeychainAdapter;
  /** 覆盖环境变量里的 CLAUDE_CONFIG_DIR（仅 macOS 默认账号派生钥匙串服务名时使用） */
  envConfigDir?: string | undefined;
}

export interface CredSnapshot {
  raw: string;
  /** claudeAiOauth.expiresAt（毫秒时间戳）；读不到为 null */
  expiresAt: number | null;
  /** 文件 mtimeMs；钥匙串条目为 0 */
  mtimeMs: number;
}

/**
 * 派生 macOS 钥匙串服务名，规则与 Claude CLI（hRe("-credentials")）一致：
 * - 未指定 configDir（默认账号且未设 CLAUDE_CONFIG_DIR）→ "Claude Code-credentials"
 * - 指定了 configDir → "Claude Code-credentials-" + sha256(configDir.normalize('NFC')).slice(0, 8)
 */
export function macKeychainServiceName(configDir: string | null): string {
  if (!configDir) return KEYCHAIN_PREFIX;
  const hash = crypto.createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8);
  return `${KEYCHAIN_PREFIX}-${hash}`;
}

/** 根据账号目录与外部 CLAUDE_CONFIG_DIR 计算 macOS 钥匙串服务名 */
export function keychainServiceFor(dir: string | null, envConfigDir?: string): string {
  if (dir !== null) return macKeychainServiceName(dir);
  return macKeychainServiceName(envConfigDir || null);
}

/** 解析并校验凭据 JSON 原文：必须是含有效 claudeAiOauth（非空 accessToken 或 refreshToken）的 JSON 对象 */
export function parseCredSnapshot(raw: string, mtimeMs = 0): CredSnapshot | null {
  if (!raw || !raw.trim()) return null;
  try {
    const j = JSON.parse(raw) as unknown;
    if (!isPlainObj(j)) return null;
    const ai = isPlainObj(j.claudeAiOauth) ? j.claudeAiOauth : null;
    if (!ai) return null;
    const hasAccess = typeof ai.accessToken === 'string' && ai.accessToken.trim().length > 0;
    const hasRefresh = typeof ai.refreshToken === 'string' && ai.refreshToken.trim().length > 0;
    if (!hasAccess && !hasRefresh) return null;
    const exp = ai.expiresAt;
    const expiresAt = typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp : null;
    return { raw, expiresAt, mtimeMs };
  } catch {
    return null;
  }
}

/**
 * 识别「Claude CLI 刷新令牌失败后清空的凭据」：刷新被拒（refresh token 已被另一个进程轮换作废等）时，
 * CLI 会把 accessToken / refreshToken 写成空串、expiresAt 置 0，但保留 accountUuid / refreshTokenExpiresAt / scopes 等字段；
 * 用户主动登出则是删除凭据（文件或 claudeAiOauth 不存在），两者据此区分。
 * 是清空状态时返回其中记录的 accountUuid（没有记录为 null），否则返回 undefined。
 */
export function wipedCredAccount(raw: string | null): string | null | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const j = JSON.parse(raw) as unknown;
    if (!isPlainObj(j) || !isPlainObj(j.claudeAiOauth)) return undefined;
    const ai = j.claudeAiOauth;
    const blank = (v: unknown) => typeof v === 'string' && v.trim().length === 0;
    if (!blank(ai.accessToken) || !blank(ai.refreshToken)) return undefined;
    const uuid = typeof ai.accountUuid === 'string' && ai.accountUuid.trim() ? ai.accountUuid.trim().toLowerCase() : null;
    const rtExp = typeof ai.refreshTokenExpiresAt === 'number' && ai.refreshTokenExpiresAt > 0;
    // 至少留有一项账号痕迹才认定是 CLI 清空的，空壳对象仍按「未登录」处理
    return uuid || rtExp ? uuid : undefined;
  } catch {
    return undefined;
  }
}

/** 凭据原文里记录的 claudeAiOauth.accountUuid（小写）；没有为 null */
function credAccountUuid(raw: string): string | null {
  try {
    const j = JSON.parse(raw) as unknown;
    const ai = isPlainObj(j) && isPlainObj(j.claudeAiOauth) ? j.claudeAiOauth : null;
    return typeof ai?.accountUuid === 'string' && ai.accountUuid.trim() ? ai.accountUuid.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** 从凭据 JSON 原文解析 claudeAiOauth.expiresAt（毫秒时间戳）；无效返回 null */
export function parseCredExpiresAt(raw: string): number | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown> | null;
    const ai = j && typeof j === 'object' && !Array.isArray(j) ? (j.claudeAiOauth as Record<string, unknown> | undefined) : undefined;
    const exp = ai?.expiresAt;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp : null;
  } catch {
    return null;
  }
}

/** 比较两份凭据，判断 src 是否比 dst 更新（较新者胜）：优先比较 claudeAiOauth.expiresAt，缺省时比较文件 mtime */
export function isNewerCred(src: CredSnapshot, dst: CredSnapshot | null, force = false): boolean {
  if (!dst) return true;
  if (src.raw === dst.raw) return false;
  if (force) return true;
  if (src.expiresAt !== null && dst.expiresAt !== null) {
    if (src.expiresAt !== dst.expiresAt) return src.expiresAt > dst.expiresAt;
    return src.mtimeMs > dst.mtimeMs;
  }
  if (src.expiresAt !== null) return true;
  if (dst.expiresAt !== null) return false;
  return src.mtimeMs > dst.mtimeMs;
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 原子写文件（临时文件 + rename，Windows 占用时短暂重试） */
export function writeFileAtomic(file: string, data: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch { /* ignore */ }
    throw e;
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (i >= 5 || !code || !RETRY_CODES.has(code)) {
        try {
          fs.rmSync(tmp, { force: true });
        } catch { /* ignore */ }
        throw e;
      }
      const until = Date.now() + 30 * (i + 1);
      while (Date.now() < until) { /* Windows 目标被占用时短暂重试 */ }
    }
  }
}

type JsonReadResult =
  | { kind: 'ok'; data: Record<string, unknown> }
  | { kind: 'missing' }
  | { kind: 'corrupt' };

/** 读取 JSON 对象文件，区分「正常」「明确不存在」「存在但读取/解析失败（如瞬时半写入/占用）」 */
function readJsonObjSafe(file: string): JsonReadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'corrupt' };
  }
  try {
    const j = JSON.parse(raw);
    return isPlainObj(j) ? { kind: 'ok', data: j } : { kind: 'corrupt' };
  } catch {
    return { kind: 'corrupt' };
  }
}

function readJsonObj(file: string): Record<string, unknown> | null {
  const r = readJsonObjSafe(file);
  return r.kind === 'ok' ? r.data : null;
}

function readCredFile(file: string): CredSnapshot | null {
  const r = readCredRaw(file);
  return r ? parseCredSnapshot(r.raw, r.mtimeMs) : null;
}

/** 读凭据文件原文；不存在返回 null */
function readCredRaw(file: string): { raw: string; mtimeMs: number } | null {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return { raw, mtimeMs: fs.statSync(file).mtimeMs };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * requireDst 时目标没有有效凭据，判断能否照常回写：目标是被 CLI 刷新失败清空的同一账号凭据才放行
 * （用户主动登出 = 凭据被删除，不复活；凭据里记录的 accountUuid 与源不一致也不放行）。
 */
function canRecoverWipedDst(srcRaw: string, dstRaw: string | null): boolean {
  const wiped = wipedCredAccount(dstRaw);
  if (wiped === undefined) return false;
  const srcUuid = credAccountUuid(srcRaw);
  return !(wiped && srcUuid && wiped !== srcUuid);
}

/** macOS security -w 在值包含非 ASCII UTF-8（如中文用户名）时会输出纯十六进制，此处自动解码 */
function decodeMacKeychainValue(val: string): string {
  const trimmed = val.trim();
  if (!trimmed) return '';
  if (trimmed.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(trimmed)) {
    try {
      const decoded = Buffer.from(trimmed, 'hex').toString('utf8');
      if (isPlainObj(JSON.parse(decoded))) return decoded;
    } catch { /* 并非十六进制编码的 JSON，原样返回 */ }
  }
  return trimmed;
}

export function createMacKeychainAdapter(spawnFn: typeof spawnSync = spawnSync): KeychainAdapter {
  const find = (account: string, service: string) =>
    spawnFn('security', ['find-generic-password', '-a', account, '-w', '-s', service], {
      encoding: 'utf8',
      timeout: KEYCHAIN_TIMEOUT_MS,
    });

  return {
    read(service: string): string | null {
      let r = find(KEYCHAIN_ACCOUNT, service);
      if (r.error) throw new Error(`读取 macOS 钥匙串失败：${r.error.message}`);
      if (r.status === ERR_SEC_ITEM_NOT_FOUND) {
        // 兼容早期 CLI 用系统用户名写入的条目
        let user = '';
        try {
          user = os.userInfo().username;
        } catch { /* ignore */ }
        if (user && user !== KEYCHAIN_ACCOUNT) {
          r = find(user, service);
          if (r.error) throw new Error(`读取 macOS 钥匙串失败：${r.error.message}`);
        }
      }
      if (r.status === ERR_SEC_ITEM_NOT_FOUND) return null;
      if (r.status !== 0) {
        const msg = (r.stderr || r.stdout || '').trim();
        throw new Error(`读取 macOS 钥匙串失败（退出码 ${r.status}${msg ? `：${msg}` : ''}）`);
      }
      const val = decodeMacKeychainValue(String(r.stdout ?? ''));
      return val || null;
    },
    write(service: string, data: string): void {
      if (/["\r\n\\]/.test(service)) throw new Error(`非法的 macOS 钥匙串服务名：${service}`);
      // 经 stdin 以十六进制写给 security -i，避免密钥暴露在命令行参数中，也避免引号 / 换行破坏解析
      const hex = Buffer.from(data, 'utf8').toString('hex');
      const cmd = `add-generic-password -U -a "${KEYCHAIN_ACCOUNT}" -s "${service}" -X "${hex}"\n`;
      const r = spawnFn('security', ['-i'], {
        input: cmd,
        encoding: 'utf8',
        timeout: KEYCHAIN_TIMEOUT_MS,
      });
      if (r.error) throw new Error(`写入 macOS 钥匙串失败：${r.error.message}`);
      if (r.status !== 0) {
        const msg = (r.stderr || r.stdout || '').trim();
        throw new Error(`写入 macOS 钥匙串失败（退出码 ${r.status}${msg ? `：${msg}` : ''}）`);
      }
    },
    remove(service: string): void {
      try {
        spawnFn('security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service], {
          timeout: KEYCHAIN_TIMEOUT_MS,
        });
      } catch { /* 清理失败忽略 */ }
    },
  };
}

const defaultMacKeychain = createMacKeychainAdapter();

function isPlainObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

interface OauthIdentity {
  uuid: string | null;
  email: string | null;
}

function oauthIdentityOf(j: Record<string, unknown> | null): OauthIdentity {
  const oauth = isPlainObj(j?.oauthAccount) ? j!.oauthAccount : null;
  const rawUuid = typeof oauth?.accountUuid === 'string' ? oauth.accountUuid.trim().toLowerCase() : '';
  const rawEmail = typeof oauth?.emailAddress === 'string'
    ? oauth.emailAddress.trim().toLowerCase()
    : typeof oauth?.email === 'string'
      ? oauth.email.trim().toLowerCase()
      : '';
  return { uuid: rawUuid || null, email: rawEmail || null };
}

/** 两份账号身份均有明确标识且不一致（优先比对 accountUuid，任一方缺失时用归一化邮箱兜底） */
function isDifferentOauthIdentity(a: OauthIdentity, b: OauthIdentity): boolean {
  if (a.uuid && b.uuid) return a.uuid !== b.uuid;
  if (a.email && b.email) return a.email !== b.email;
  return false;
}

/** 同步到子代理空间的项目级 MCP 字段（保留目标项目下的其他状态字段不动） */
const PROJECT_MCP_KEYS = [
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'disabledMcpServers',
  'enableAllProjectMcpServers',
  'mcpContextUris',
] as const;

/** 空值（undefined / null / false / [] / {}）视为未设置，不同步也不在目标中保留 */
function isEmptyProjectMcpValue(v: unknown): boolean {
  if (v === undefined || v === null || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObj(v)) return Object.keys(v).length === 0;
  return false;
}

type ResolvedObjField = { kind: 'preserve' } | { kind: 'value'; value: Record<string, unknown> | null };

/**
 * 解析源 .claude.json（及非默认账号的基础目录兜底）中的对象字段：
 * - 源或兜底文件存在但解析失败（瞬时改写/损坏）→ preserve（保留目标旧值，绝不误删）；
 * - 文件明确不存在或解析成功但字段缺失 → value: null（按已删除处理）。
 */
function resolveSrcObjField(
  mainRead: JsonReadResult,
  key: 'mcpServers' | 'projects',
  mainDir: string | null,
  getBaseRead: () => JsonReadResult,
): ResolvedObjField {
  if (mainRead.kind === 'corrupt') return { kind: 'preserve' };
  if (mainRead.kind === 'ok' && isPlainObj(mainRead.data[key])) {
    return { kind: 'value', value: mainRead.data[key] };
  }
  if (mainDir !== null) {
    const baseRead = getBaseRead();
    if (baseRead.kind === 'corrupt') return { kind: 'preserve' };
    if (baseRead.kind === 'ok' && isPlainObj(baseRead.data[key])) {
      return { kind: 'value', value: baseRead.data[key] };
    }
  }
  return { kind: 'value', value: null };
}

/**
 * 同步主代理的 .claude.json 中必要字段到子代理空间：
 * - oauthAccount（仅订阅账号；API / Kiro 账号不写）
 * - hasCompletedOnboarding: true、bypassPermissionsModeAccepted: true、lastOnboardingVersion（跳过首次引导与权限确认）
 * - mcpServers（顶层 MCP 配置；添加的账号自身没有时从基础目录兜底读取）
 * - projects[<path>] 下的项目级 MCP 字段（mcpServers / enabledMcpjsonServers / disabledMcpjsonServers / disabledMcpServers / enableAllProjectMcpServers / mcpContextUris）；
 *   保留目标项目下的其他字段，源中已删除的 MCP 字段在目标中同步删除。
 * - 若源（或兜底的基础目录）.claude.json 存在但解析失败（如主会话 CLI 正在改写），保留目标的顶层与项目级 MCP 旧值不清掉。
 * 其余子代理运行态字段原样保留。返回「主与子的账号身份是否发生变化」。
 */
export function syncClaudeJsonToSubagent(mainDir: string | null, subDir: string, isApiOrKiro: boolean): boolean {
  const mainRead = readJsonObjSafe(claudeJsonPath(mainDir));
  const mainJson = mainRead.kind === 'ok' ? mainRead.data : null;
  const subFile = path.join(subDir, '.claude.json');
  const subExisted = fs.existsSync(subFile);
  const subJson = readJsonObj(subFile) ?? {};
  const prevStr = subExisted ? JSON.stringify(subJson) : '';

  const prevId = oauthIdentityOf(subJson);
  const mainId = isApiOrKiro ? { uuid: null, email: null } : oauthIdentityOf(mainJson);
  const identityChanged = !isApiOrKiro && isDifferentOauthIdentity(mainId, prevId);

  const next: Record<string, unknown> = { ...subJson };
  next.hasCompletedOnboarding = true;
  next.bypassPermissionsModeAccepted = true;
  if (typeof mainJson?.lastOnboardingVersion === 'string' && mainJson.lastOnboardingVersion) {
    next.lastOnboardingVersion = mainJson.lastOnboardingVersion;
  }

  if (isApiOrKiro) {
    delete next.oauthAccount;
  } else if (mainRead.kind !== 'corrupt') {
    if (isPlainObj(mainJson?.oauthAccount)) {
      next.oauthAccount = structuredClone(mainJson!.oauthAccount);
    } else {
      delete next.oauthAccount;
    }
  }

  let baseReadCache: JsonReadResult | null = null;
  const getBaseRead = (): JsonReadResult => {
    if (!baseReadCache) {
      baseReadCache = mainDir !== null ? readJsonObjSafe(claudeJsonPath(null)) : { kind: 'missing' };
    }
    return baseReadCache;
  };

  // 顶层 MCP 配置：源/兜底瞬时损坏时保留目标旧值；明确缺失或字段已删时才删除
  const topMcp = resolveSrcObjField(mainRead, 'mcpServers', mainDir, getBaseRead);
  if (topMcp.kind === 'value') {
    if (topMcp.value && Object.keys(topMcp.value).length > 0) {
      next.mcpServers = structuredClone(topMcp.value);
    } else {
      delete next.mcpServers;
    }
  }

  // 项目级 MCP 配置：源/兜底瞬时损坏时保留目标旧值；否则按原路径键同步，保留目标项目其余字段，源删除则目标同步删除
  const projMcp = resolveSrcObjField(mainRead, 'projects', mainDir, getBaseRead);
  if (projMcp.kind === 'value') {
    const srcProjects = projMcp.value;
    const subProjects = isPlainObj(subJson.projects) ? subJson.projects : null;
    if (srcProjects || subProjects) {
      const allPaths = new Set<string>([
        ...(srcProjects ? Object.keys(srcProjects) : []),
        ...(subProjects ? Object.keys(subProjects) : []),
      ]);
      const nextProjects: Record<string, unknown> = {};
      for (const projPath of allPaths) {
        const srcEntry = isPlainObj(srcProjects?.[projPath]) ? srcProjects![projPath] : null;
        const subEntry = isPlainObj(subProjects?.[projPath]) ? subProjects![projPath] : null;
        if (!srcEntry && !subEntry) continue;
        const merged: Record<string, unknown> = subEntry ? structuredClone(subEntry) : {};
        for (const key of PROJECT_MCP_KEYS) {
          const val = srcEntry?.[key];
          if (!isEmptyProjectMcpValue(val)) {
            merged[key] = structuredClone(val);
          } else {
            delete merged[key];
          }
        }
        if (Object.keys(merged).length > 0) {
          nextProjects[projPath] = merged;
        }
      }
      if (Object.keys(nextProjects).length > 0) {
        next.projects = nextProjects;
      } else {
        delete next.projects;
      }
    }
  }

  if (!subExisted || JSON.stringify(next) !== prevStr) {
    writeFileAtomic(subFile, JSON.stringify(next, null, 2) + '\n');
  }
  return identityChanged;
}

/** 同步两个配置目录的凭据（单向 src → dst，较新者胜）；返回是否写入了目标 */
function syncCredDirection(
  srcDir: string | null,
  dstDir: string | null,
  opts: SubagentSpaceOptions & { force?: boolean; requireSrc?: boolean; requireDst?: boolean },
): boolean {
  const platform = opts.platform ?? process.platform;
  const envConfigDir = opts.envConfigDir !== undefined ? opts.envConfigDir : process.env.CLAUDE_CONFIG_DIR;

  if (platform === 'darwin') {
    const kc = opts.keychain ?? defaultMacKeychain;
    const srcSvc = keychainServiceFor(srcDir, envConfigDir);
    const dstSvc = keychainServiceFor(dstDir, envConfigDir);
    const srcRaw = kc.read(srcSvc);
    const dstRaw = kc.read(dstSvc);
    const src = srcRaw ? parseCredSnapshot(srcRaw, 0) : null;
    const dst = dstRaw ? parseCredSnapshot(dstRaw, 0) : null;
    if (!src) {
      if (opts.requireSrc) throw new Error('子代理账号在 macOS 钥匙串中缺少登录凭据，请重新登录');
      return false;
    }
    if (opts.requireDst && !dst && !canRecoverWipedDst(src.raw, dstRaw)) return false;
    if (!isNewerCred(src, dst, opts.force)) return false;
    kc.write(dstSvc, src.raw);
    return true;
  }

  const srcFile = path.join(srcDir ?? baseClaudeHome(), '.credentials.json');
  const dstFile = path.join(dstDir ?? baseClaudeHome(), '.credentials.json');
  const src = readCredFile(srcFile);
  const dstRaw = readCredRaw(dstFile);
  const dst = dstRaw ? parseCredSnapshot(dstRaw.raw, dstRaw.mtimeMs) : null;
  if (!src) {
    if (opts.requireSrc) throw new Error('子代理账号未登录或缺少凭据，请重新登录');
    return false;
  }
  if (opts.requireDst && !dst && !canRecoverWipedDst(src.raw, dstRaw?.raw ?? null)) return false;
  if (!isNewerCred(src, dst, opts.force)) return false;
  writeFileAtomic(dstFile, src.raw, 0o600);
  return true;
}

/**
 * 启动子代理进程前准备子代理配置空间：
 * 1. 创建目录并链接共享配置项（skills / agents / commands / plugins / output-styles / hooks / settings.json / CLAUDE.md / keybindings.json）；
 * 2. 同步 .claude.json 必要字段（oauthAccount / 跳过首次引导字段 / mcpServers）；
 * 3. 订阅账号同步凭据（主 → 子，较新者胜）；API / Kiro 账号跳过凭据复制。
 * 返回子代理配置空间路径。
 */
export function prepareSubagentSpace(
  accountId: string,
  mainDir: string | null,
  opts: SubagentSpaceOptions = {},
): string {
  const subDir = subagentAccountDir(accountId);
  fs.mkdirSync(subDir, { recursive: true });
  ensureLinks(baseClaudeHome(), subDir, { dirs: SUBAGENT_SHARED_DIRS, files: SUBAGENT_SHARED_FILES });

  const isApiOrKiro = readApiConfig(mainDir) !== null;
  const identityChanged = syncClaudeJsonToSubagent(mainDir, subDir, isApiOrKiro);
  if (!isApiOrKiro) {
    syncCredDirection(mainDir, subDir, { ...opts, force: identityChanged, requireSrc: true });
  }
  return subDir;
}

/**
 * 把子代理空间刷新后的凭据回写到主代理空间（子 → 主，较新者胜）。
 * 时机：子代理进程退出后、或 runner 启动该账号的主代理进程前。
 * 子代理空间不存在、主/子账号身份不一致、主空间已登出或为 API / Kiro 账号时直接跳过。
 * 主空间凭据被 CLI 刷新失败清空（主/子两个进程持有同一个 refresh token，子空间先刷新后旧令牌作废）不算登出，照常回写恢复登录。
 * 返回是否写入了主空间。
 */
export function syncSubagentToMain(
  accountId: string,
  mainDir: string | null,
  opts: SubagentSpaceOptions = {},
): boolean {
  if (!isSafeId(accountId)) return false;
  const subDir = subagentAccountDir(accountId);
  if (!fs.existsSync(subDir)) return false;
  if (readApiConfig(mainDir) !== null) return false;
  const mainId = oauthIdentityOf(readJsonObj(claudeJsonPath(mainDir)));
  const subId = oauthIdentityOf(readJsonObj(path.join(subDir, '.claude.json')));
  if (isDifferentOauthIdentity(mainId, subId)) return false;
  return syncCredDirection(subDir, mainDir, { ...opts, requireDst: true });
}

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * 移除账号时清理对应的子代理配置空间：先解除共享链接，再删除目录（只删 subagentAccountsRoot 下的直接子目录）。
 * 遇到符号链接/junction 只解除链接本身，绝不跟进删除目标（特别是绝不误碰 ~/.claude）。
 * macOS 上同时尝试清理对应的钥匙串条目。
 */
export function removeSubagentSpace(accountId: string, opts: SubagentSpaceOptions = {}): void {
  if (!isSafeId(accountId)) return;
  const root = path.resolve(subagentAccountsRoot());
  const abs = subagentAccountDir(accountId);
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || rel.includes('/')) return;
  if (pathKey(abs) === pathKey(baseClaudeHome())) return;

  const st = lstatOrNull(abs);
  if (st) {
    if (st.isSymbolicLink()) {
      removeLink(abs);
    } else {
      let safe = true;
      try {
        const rootReal = fs.realpathSync(root);
        const parentReal = fs.realpathSync(path.dirname(abs));
        const absReal = fs.realpathSync(abs);
        const baseReal = fs.existsSync(baseClaudeHome()) ? fs.realpathSync(baseClaudeHome()) : path.resolve(baseClaudeHome());
        if (pathKey(parentReal) !== pathKey(rootReal) || pathKey(absReal) === pathKey(baseReal)) safe = false;
      } catch {
        safe = false;
      }
      if (safe) {
        const left = unlinkShared(abs);
        if (left.length) throw new Error(`解除子代理共享链接失败：${left.join(', ')}`);
        fs.rmSync(abs, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }
  }

  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    const kc = opts.keychain ?? defaultMacKeychain;
    kc.remove?.(macKeychainServiceName(abs));
  }
}
