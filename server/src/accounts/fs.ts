// 账号目录通用的安全文件工具（agy / codex 等多账号管理共用，与具体 CLI 无关）：
// 删除只解除链接、不跟进；Windows 占用时带重试；令牌类文件原子替换并可回滚。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from '../paths.js';
import { removeLink } from './links.js';

export const RETRY_ERRORS = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

/** 邮箱归一化（去首尾空白与标点、转小写）后算 sha256 哈希；无效返回 null */
export function hashEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.replace(/[.,;:!?]+$/, '').trim().toLowerCase();
  if (!email) return null;
  return crypto.createHash('sha256').update(email).digest('hex');
}

export function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** 递归安全删除目录树：遇到 symlink / junction 只解除链接，绝不跟进删除目标内容 */
export function safeRemoveTreeSync(dir: string): void {
  const st = lstat(dir);
  if (!st) return;
  if (st.isSymbolicLink()) {
    removeLink(dir);
    return;
  }
  if (!st.isDirectory()) {
    fs.unlinkSync(dir);
    return;
  }
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const cst = lstat(p);
    if (!cst) continue;
    if (cst.isSymbolicLink()) removeLink(p);
    else if (cst.isDirectory()) safeRemoveTreeSync(p);
    else fs.unlinkSync(p);
  }
  fs.rmdirSync(dir);
}

/** 校验 dir 是 root 的直接子目录（含 realpath 校验），通过后安全删除；Windows 占用时重试几次 */
export async function safeRemoveAccountDir(dir: string, root: string): Promise<void> {
  const rootAbs = path.resolve(root);
  const abs = path.resolve(dir);
  const rel = path.relative(rootAbs, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep) || rel.includes('/')) return;
  const st = lstat(abs);
  if (!st) return;
  if (st.isSymbolicLink()) {
    removeLink(abs);
    return;
  }
  let rootReal: string;
  let parentReal: string;
  try {
    rootReal = fs.realpathSync(rootAbs);
    parentReal = fs.realpathSync(path.dirname(abs));
  } catch {
    return;
  }
  if (pathKey(parentReal) !== pathKey(rootReal)) return;

  for (let i = 0; ; i++) {
    try {
      safeRemoveTreeSync(abs);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (i >= 5 || !code || !RETRY_ERRORS.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** 通用文件 / 目录操作占用重试（Windows 句柄释放延迟）；失败静默 */
export async function retrySilently(fn: () => void, maxRetries = 8): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      fn();
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') return;
      if (i >= maxRetries || !code || !RETRY_ERRORS.has(code)) return;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** Windows 偶发占用时带重试的 rename */
export async function renameRetry(from: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (i >= 5 || !code || !RETRY_ERRORS.has(code)) throw e;
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** 创建 0700 权限的账号目录 */
export function mkdirPrivate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch { /* Windows 忽略 */ }
}

/**
 * 把 tempDir 里新登录的认证文件（names，只处理存在的；requiredName 必须存在）原子替换进 targetDir，
 * 不碰目录里其它内容；任一步失败反向回滚，不破坏原登录。
 */
export async function replaceAuthFiles(tempDir: string, targetDir: string, names: string[], requiredName: string): Promise<void> {
  mkdirPrivate(targetDir);
  const present = names.filter((n) => fs.existsSync(path.join(tempDir, n)));
  if (!present.includes(requiredName)) throw new Error('未找到新的令牌文件');

  const stamp = crypto.randomBytes(5).toString('hex');
  const backups: { name: string; target: string; bak: string | null }[] = [];
  try {
    for (const name of present) {
      const src = path.join(tempDir, name);
      const dst = path.join(targetDir, name);
      let bak: string | null = null;
      if (fs.existsSync(dst)) {
        bak = path.join(targetDir, `.${name}.bak-${stamp}`);
        await renameRetry(dst, bak);
      }
      backups.push({ name, target: dst, bak });
      await renameRetry(src, dst);
    }
  } catch (e) {
    // 反向回滚：恢复原文件，不破坏原登录
    for (const b of [...backups].reverse()) {
      await fs.promises.unlink(b.target).catch(() => {});
      if (b.bak) await renameRetry(b.bak, b.target).catch(() => {});
    }
    throw e;
  }
  // 全部替换成功后删除备份文件
  for (const b of backups) {
    if (b.bak) await fs.promises.unlink(b.bak).catch(() => {});
  }
}
