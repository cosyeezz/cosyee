// 路径相关：cwd 编码、~/.claude（含多账号的配置目录）与 ~/.cosyee 目录、路径规范化。
import os from 'node:os';
import path from 'node:path';

/**
 * 基础配置目录（默认账号）：CLAUDE_CONFIG_DIR 或 ~/.claude。
 * 共享内容（projects 会话记录、skills、settings.json 等）的「本体」都在这里，其它账号目录用链接指过来。
 */
export function baseClaudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/** 当前账号的配置目录；null = 默认账号（用基础目录） */
let activeDir: string | null = null;

/** 切换账号时由 accounts 模块设置；传 null 回到默认账号 */
export function setActiveConfigDir(dir: string | null): void {
  activeDir = dir;
}

/** 非默认账号的配置目录；默认账号返回 null（此时子进程不设置 CLAUDE_CONFIG_DIR，沿用外部环境） */
export function activeConfigDir(): string | null {
  return activeDir;
}

/** 当前账号的 Claude 配置目录。只读使用。 */
export function claudeHome(): string {
  return activeDir ?? baseClaudeHome();
}

/** 会话记录目录：所有账号共用基础目录下的 projects（账号目录里的 projects 是指向它的链接） */
export function projectsDir(): string {
  return path.join(baseClaudeHome(), 'projects');
}

/**
 * 某个配置目录对应的全局状态文件（.claude.json）。
 * dir 为 null 表示默认账号：设置了 CLAUDE_CONFIG_DIR 时在它里面，否则在用户目录根下（~/.claude.json）。
 */
export function claudeJsonPath(dir: string | null): string {
  if (dir) return path.join(dir, '.claude.json');
  const env = process.env.CLAUDE_CONFIG_DIR;
  return env ? path.join(env, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** 额外账号的配置目录放在这里（每个账号一个子目录）。可用 COSYEE_ACCOUNTS_DIR 覆盖（测试用）。 */
export function accountsRoot(): string {
  return process.env.COSYEE_ACCOUNTS_DIR || path.join(os.homedir(), '.claude-accounts');
}

/** 子代理配置空间根目录（与 accountsRoot 并列，不会被主会话扫描）。可用 COSYEE_SUBAGENT_ACCOUNTS_DIR 覆盖（测试用）。 */
export function subagentAccountsRoot(): string {
  return process.env.COSYEE_SUBAGENT_ACCOUNTS_DIR || path.join(os.homedir(), '.claude-subagents');
}

/** 某个账号（含默认账号 'default'）的子代理配置目录 */
export function subagentAccountDir(accountId: string): string {
  return path.join(subagentAccountsRoot(), accountId);
}

/** Cosyee 自己的数据目录（state.json）。可用 COSYEE_HOME 覆盖（测试用）。 */
export function cosyeeHome(): string {
  return process.env.COSYEE_HOME || path.join(os.homedir(), '.cosyee');
}

/** Antigravity（agy）额外账号的数据目录（每个账号一个子目录）。可用 COSYEE_AGY_ACCOUNTS_DIR 覆盖（测试用）。 */
export function agyAccountsRoot(): string {
  return process.env.COSYEE_AGY_ACCOUNTS_DIR || path.join(cosyeeHome(), 'agy-accounts');
}

/**
 * cwd -> ~/.claude/projects 下的目录名：每个非 ASCII 字母数字字符各换成一个 `-`。
 * 有损且不可逆（见 spike/FINDINGS2.md B2 §1）。
 */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * 编码候选：原样、盘符大写、盘符小写（Windows 盘符大小写可能不同）。
 * NTFS 默认大小写不敏感，多数情况下第一个就命中；这里保留候选以防在大小写敏感的文件系统上。
 */
export function encodeCwdCandidates(cwd: string): string[] {
  const base = encodeCwd(cwd);
  const out = [base];
  if (/^[A-Za-z]/.test(base)) {
    const up = base[0]!.toUpperCase() + base.slice(1);
    const lo = base[0]!.toLowerCase() + base.slice(1);
    for (const v of [up, lo]) if (!out.includes(v)) out.push(v);
  }
  return out;
}

const isWin = process.platform === 'win32';
const caseInsensitive = isWin || process.platform === 'darwin';
const TRAILING_SEP = /[\\/]+$/;

/** 规范化目录路径：绝对化、去尾部分隔符、Windows 盘符大写。 */
export function normalizeDir(p: string): string {
  let r = path.resolve(p);
  const root = path.parse(r).root;
  if (r.length > root.length) r = r.replace(TRAILING_SEP, '');
  if (isWin && /^[a-z]:/.test(r)) r = r[0]!.toUpperCase() + r.slice(1);
  return r;
}

/** 用于比较两个路径是否同一目录（Windows / macOS 默认大小写不敏感，两种分隔符视为相同）。 */
export function pathKey(p: string): string {
  let r = p;
  if (r.length > 1) r = r.replace(TRAILING_SEP, '') || r;
  if (isWin) r = r.replace(/\//g, '\\');
  return caseInsensitive ? r.toLowerCase() : r;
}

/** 校验会话 ID / tool_use id：只允许安全字符，防路径穿越。 */
export function isSafeId(s: unknown): s is string {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);
}

/** 会话 UUID（Claude Code 的会话记录文件名）。永久删除前用它做严格校验。 */
export function isSessionUuid(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}
