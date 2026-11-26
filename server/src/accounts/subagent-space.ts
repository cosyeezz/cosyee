// 子代理配置空间与登录态双向同步：
// 每个被用作 Claude 委派子代理的账号在 ~/.claude-subagents/<accountId> 拥有独立配置空间：
// - 共享（链接到基础配置目录，复用 links.ts）：skills、agents、commands、plugins、output-styles、hooks、settings.json、CLAUDE.md、keybindings.json；
// - 隔离（子代理空间自己的）：projects、file-history、todos、plans、tasks、session-env、paste-cache、history.jsonl，以及 .claude.json 其余状态；
// - 登录态：订阅账号复制 .credentials.json（macOS 同步钥匙串条目）并在主/子之间双向「较新者胜」同步令牌刷新；
//   .claude.json 只复制 oauthAccount、mcpServers 以及跳过首次引导所需的最少字段（hasCompletedOnboarding / lastOnboardingVersion / bypassPermissionsModeAccepted）；
// - API / Kiro 账号不复制凭据，环境变量在启动子进程时仍从主代理账号目录读取。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { baseClaudeHome, claudeJsonPath, pathKey, subagentAccountDir, subagentAccountsRoot } from '../paths.js';
import { readApiConfig } from './api-config.js';
import { ensureLinks, SUBAGENT_SHARED_DIRS, SUBAGENT_SHARED_FILES, unlinkShared } from './links.js';

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

/** 原子写文件（临时文件 + rename，Windows 占用时短暂重试） */
export function writeFileAtomic(file: string, data: string | Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
  fs.writeFileSync(tmp, data, mode !== undefined ? { mode } : undefined);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 5) {
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

function readJsonObj(file: string): Record<string, unknown> | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readCredFile(file: string): CredSnapshot | null {
  let raw: string;
  let mtimeMs = 0;
  try {
    raw = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (!raw.trim()) return null;
  return { raw, expiresAt: parseCredExpiresAt(raw), mtimeMs };
}

function createMacKeychainAdapter(): KeychainAdapter {
  const find = (account: string, service: string) =>
    spawnSync('security', ['find-generic-password', '-a', account, '-w', '-s', service], {
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
      const val = (r.stdout ?? '').trim();
      return val || null;
    },
    write(service: string, data: string): void {
      // 经 stdin 以十六进制写给 security -i，避免密钥暴露在命令行参数中，也避免引号 / 换行破坏解析
      const hex = Buffer.from(data, 'utf8').toString('hex');
      const cmd = `add-generic-password -U -a "${KEYCHAIN_ACCOUNT}" -s "${service}" -X "${hex}"\n`;
      const r = spawnSync('security', ['-i'], {
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
        spawnSync('security', ['delete-generic-password', '-a', KEYCHAIN_ACCOUNT, '-s', service], {
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

function oauthUuidOf(j: Record<string, unknown> | null): string | null {
  const oauth = isPlainObj(j?.oauthAccount) ? j!.oauthAccount : null;
  const raw = typeof oauth?.accountUuid === 'string' ? oauth.accountUuid.trim().toLowerCase() : '';
  return raw || null;
}

/**
 * 同步主代理的 .claude.json 中必要字段到子代理空间：
 * - oauthAccount（仅订阅账号；API / Kiro 账号不写）
 * - hasCompletedOnboarding: true、bypassPermissionsModeAccepted: true、lastOnboardingVersion（跳过首次引导与权限确认）
 * - mcpServers（顶层 MCP 配置；添加的账号自身没有时从基础目录兜底读取）
 * 其余子代理运行态字段原样保留。返回「主与子的 oauthAccount.accountUuid 是否发生变化」。
 */
export function syncClaudeJsonToSubagent(mainDir: string | null, subDir: string, isApiOrKiro: boolean): boolean {
  const mainJson = readJsonObj(claudeJsonPath(mainDir));
  const subFile = path.join(subDir, '.claude.json');
  const subExisted = fs.existsSync(subFile);
  const subJson = readJsonObj(subFile) ?? {};
  const prevStr = subExisted ? JSON.stringify(subJson) : '';

  const prevUuid = oauthUuidOf(subJson);
  const mainUuid = isApiOrKiro ? null : oauthUuidOf(mainJson);
  const identityChanged = !isApiOrKiro && !!mainUuid && !!prevUuid && mainUuid !== prevUuid;

  const next: Record<string, unknown> = { ...subJson };
  next.hasCompletedOnboarding = true;
  next.bypassPermissionsModeAccepted = true;
  if (typeof mainJson?.lastOnboardingVersion === 'string' && mainJson.lastOnboardingVersion) {
    next.lastOnboardingVersion = mainJson.lastOnboardingVersion;
  }

  if (!isApiOrKiro && isPlainObj(mainJson?.oauthAccount)) {
    next.oauthAccount = structuredClone(mainJson!.oauthAccount);
  } else {
    delete next.oauthAccount;
  }

  // MCP 配置：优先取主代理空间 .claude.json 的 mcpServers，添加的账号未曾同步过时从基础目录兜底
  let mcpServers = isPlainObj(mainJson?.mcpServers) ? mainJson!.mcpServers : null;
  if (!mcpServers && mainDir !== null) {
    const baseJson = readJsonObj(claudeJsonPath(null));
    if (isPlainObj(baseJson?.mcpServers)) mcpServers = baseJson!.mcpServers;
  }
  if (mcpServers && Object.keys(mcpServers).length > 0) {
    next.mcpServers = structuredClone(mcpServers);
  } else {
    delete next.mcpServers;
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
  opts: SubagentSpaceOptions & { force?: boolean; requireAny?: boolean },
): boolean {
  const platform = opts.platform ?? process.platform;
  const envConfigDir = opts.envConfigDir !== undefined ? opts.envConfigDir : process.env.CLAUDE_CONFIG_DIR;

  if (platform === 'darwin') {
    const kc = opts.keychain ?? defaultMacKeychain;
    const srcSvc = keychainServiceFor(srcDir, envConfigDir);
    const dstSvc = keychainServiceFor(dstDir, envConfigDir);
    const srcRaw = kc.read(srcSvc);
    const dstRaw = kc.read(dstSvc);
    const src: CredSnapshot | null = srcRaw ? { raw: srcRaw, expiresAt: parseCredExpiresAt(srcRaw), mtimeMs: 0 } : null;
    const dst: CredSnapshot | null = dstRaw ? { raw: dstRaw, expiresAt: parseCredExpiresAt(dstRaw), mtimeMs: 0 } : null;
    if (!src) {
      if (opts.requireAny && !dst) throw new Error('子代理账号在 macOS 钥匙串中缺少登录凭据，请重新登录');
      return false;
    }
    if (!isNewerCred(src, dst, opts.force)) return false;
    kc.write(dstSvc, src.raw);
    return true;
  }

  const srcFile = path.join(srcDir ?? baseClaudeHome(), '.credentials.json');
  const dstFile = path.join(dstDir ?? baseClaudeHome(), '.credentials.json');
  const src = readCredFile(srcFile);
  const dst = readCredFile(dstFile);
  if (!src) {
    if (opts.requireAny && !dst) throw new Error('子代理账号未登录或缺少凭据，请重新登录');
    return false;
  }
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
    syncCredDirection(mainDir, subDir, { ...opts, force: identityChanged, requireAny: true });
  }
  return subDir;
}

/**
 * 把子代理空间刷新后的凭据回写到主代理空间（子 → 主，较新者胜）。
 * 时机：子代理进程退出后、或 runner 启动该账号的主代理进程前。
 * 子代理空间不存在或该账号为 API / Kiro 账号时直接跳过。返回是否写入了主空间。
 */
export function syncSubagentToMain(
  accountId: string,
  mainDir: string | null,
  opts: SubagentSpaceOptions = {},
): boolean {
  const subDir = subagentAccountDir(accountId);
  if (!fs.existsSync(subDir)) return false;
  if (readApiConfig(mainDir) !== null) return false;
  return syncCredDirection(subDir, mainDir, opts);
}

/**
 * 移除账号时清理对应的子代理配置空间：先解除共享链接，再删除目录（只删 subagentAccountsRoot 下的直接子目录）。
 * macOS 上同时尝试清理对应的钥匙串条目。
 */
export function removeSubagentSpace(accountId: string, opts: SubagentSpaceOptions = {}): void {
  const root = path.resolve(subagentAccountsRoot());
  const abs = path.resolve(subagentAccountDir(accountId));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) return;
  if (pathKey(abs) === pathKey(baseClaudeHome())) return;

  if (fs.existsSync(abs)) {
    const left = unlinkShared(abs);
    if (left.length) throw new Error(`解除子代理共享链接失败：${left.join(', ')}`);
    fs.rmSync(abs, { recursive: true, force: true });
  }

  const platform = opts.platform ?? process.platform;
  if (platform === 'darwin') {
    const kc = opts.keychain ?? defaultMacKeychain;
    kc.remove?.(macKeychainServiceName(abs));
  }
}
