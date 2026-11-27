// 多账号的共享：账号配置目录里的共享项都是指向基础配置目录（默认账号）的链接。
// 目录用 junction（Windows 不需要管理员 / 开发者模式），文件用符号链接（Windows 需要开发者模式），失败时退回硬链接。
// 私有的只有登录凭据、.claude.json（账号状态）和运行时杂项（sessions、backups、debug…）。
import fs from 'node:fs';
import path from 'node:path';
import { pathKey } from '../paths.js';

/** 共享目录：会话记录、文件历史、skill / agent / 命令 / 插件等 */
export const SHARED_DIRS = [
  'projects',
  'file-history',
  'todos',
  'plans',
  'tasks',
  'session-env',
  'paste-cache',
  'skills',
  'agents',
  'commands',
  'plugins',
  'output-styles',
  'hooks',
] as const;

/** 共享文件：设置、全局 CLAUDE.md、输入历史、快捷键 */
export const SHARED_FILES = ['settings.json', 'CLAUDE.md', 'history.jsonl', 'keybindings.json'] as const;

/** 子代理配置空间共享的目录（隔离 projects / file-history / todos / plans / tasks / session-env / paste-cache） */
export const SUBAGENT_SHARED_DIRS = [
  'skills',
  'agents',
  'commands',
  'plugins',
  'output-styles',
  'hooks',
] as const;

/** 子代理配置空间共享的文件（隔离 history.jsonl） */
export const SUBAGENT_SHARED_FILES = ['settings.json', 'CLAUDE.md', 'keybindings.json'] as const;

/** 基础目录里没有时要先建出来的文件（其余的没有就不链接） */
const CREATE_IF_MISSING: Record<string, string> = {
  'settings.json': '{}\n',
  'CLAUDE.md': '',
  'history.jsonl': '',
};

const isWin = process.platform === 'win32';

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
}

/** 生成不与现有文件/目录冲突的带时间戳备份路径（避免同一秒内两次重命名撞名失败） */
function uniqueStampedPath(basePath: string, suffix: string): string {
  const first = `${basePath}.${suffix}-${stamp()}`;
  if (!lstat(first)) return first;
  for (let i = 1; i < 1000; i++) {
    const cand = `${first}-${i}`;
    if (!lstat(cand)) return cand;
  }
  return `${first}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function lstat(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch {
    return null;
  }
}

/** 链接指向的绝对路径（去掉 Windows 的 \\?\ 前缀），读不到返回 null */
function linkTarget(p: string): string | null {
  try {
    const t = fs.readlinkSync(p).replace(/^\\\\\?\\/, '');
    return path.resolve(path.dirname(p), t);
  } catch {
    return null;
  }
}

function samePath(a: string, b: string): boolean {
  return pathKey(path.resolve(a)) === pathKey(path.resolve(b));
}

/** 删掉一个链接本身（不跟随）。目录 junction / 符号链接在 Windows 上要用 rmdir。 */
export function removeLink(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (isWin) fs.rmdirSync(p);
    else throw e;
  }
}

function linkDir(master: string, at: string): void {
  fs.symlinkSync(master, at, isWin ? 'junction' : 'dir');
}

function linkFile(master: string, at: string): void {
  try {
    fs.symlinkSync(master, at, 'file');
  } catch {
    // 没有符号链接权限（Windows 未开开发者模式）：退回硬链接（同一磁盘才行）
    fs.linkSync(master, at);
  }
}

/** 把 from 目录里的条目移进 to（to 里已有同名的不覆盖，留在原处）；返回是否全部移走 */
function mergeInto(from: string, to: string): boolean {
  let all = true;
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    const ds = lstat(dst);
    const ss = lstat(src);
    if (!ss) continue;
    if (!ds) {
      try {
        fs.renameSync(src, dst);
      } catch {
        all = false;
      }
    } else if (ss.isDirectory() && !ss.isSymbolicLink() && ds.isDirectory() && !ds.isSymbolicLink()) {
      if (!mergeInto(src, dst)) all = false;
      else fs.rmdirSync(src);
    } else {
      all = false;
    }
  }
  return all;
}

function sameContent(a: string, b: string): boolean {
  try {
    const x = fs.readFileSync(a);
    const y = fs.readFileSync(b);
    return x.equals(y);
  } catch {
    return false;
  }
}

function ensureDirLink(base: string, dir: string, name: string): void {
  const master = path.join(base, name);
  const at = path.join(dir, name);
  const ms = lstat(master);
  if (!ms) fs.mkdirSync(master, { recursive: true });
  const st = lstat(at);
  if (st?.isSymbolicLink()) {
    const t = linkTarget(at);
    if (t && samePath(t, master)) return;
    removeLink(at);
  } else if (st?.isDirectory()) {
    // 链接被换成了真实目录（比如在别处被复制 / 重建）：内容并进基础目录，剩下的改名留存
    const all = mergeInto(at, master);
    if (all) fs.rmdirSync(at);
    else fs.renameSync(at, uniqueStampedPath(at, 'cosyee-orphan'));
  } else if (st) {
    fs.renameSync(at, uniqueStampedPath(at, 'cosyee-orphan'));
  }
  linkDir(master, at);
}

function ensureFileLink(base: string, dir: string, name: string): void {
  const master = path.join(base, name);
  const at = path.join(dir, name);
  const st = lstat(at);
  let ms = lstat(master);
  if (st?.isSymbolicLink()) {
    const t = linkTarget(at);
    if (t && samePath(t, master) && ms) return;
    removeLink(at);
  } else if (st?.isFile()) {
    if (ms && st.nlink > 1 && st.ino === ms.ino && st.dev === ms.dev) return; // 硬链接，同一个文件
    // 链接被换成了真实文件（有的程序写文件是「写临时文件再改名」）：比基础目录新就以它为准，旧的备份
    if (!ms) {
      fs.renameSync(at, master);
    } else if (sameContent(at, master)) {
      fs.rmSync(at, { force: true });
    } else if (st.mtimeMs > ms.mtimeMs) {
      fs.copyFileSync(master, uniqueStampedPath(master, 'cosyee-bak'));
      fs.copyFileSync(at, master);
      fs.rmSync(at, { force: true });
    } else {
      fs.renameSync(at, uniqueStampedPath(at, 'cosyee-orphan'));
    }
    ms = lstat(master);
  } else if (st) {
    fs.renameSync(at, uniqueStampedPath(at, 'cosyee-orphan'));
  }
  if (!ms) {
    const init = CREATE_IF_MISSING[name];
    if (init === undefined) return;
    fs.writeFileSync(master, init, 'utf8');
  }
  linkFile(master, at);
}

/**
 * 保证账号目录 dir 里的共享项都正确链接到基础目录 base。可重复调用（已正确的项不动）。
 * 单项失败不影响其它项；返回失败的项名。
 */
export function ensureLinks(
  base: string,
  dir: string,
  opts?: { dirs?: readonly string[]; files?: readonly string[] },
): string[] {
  if (samePath(base, dir)) return [];
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  const dirs = opts?.dirs ?? SHARED_DIRS;
  const files = opts?.files ?? SHARED_FILES;
  const failed: string[] = [];
  for (const name of dirs) {
    try {
      ensureDirLink(base, dir, name);
    } catch {
      failed.push(name);
    }
  }
  for (const name of files) {
    try {
      ensureFileLink(base, dir, name);
    } catch {
      failed.push(name);
    }
  }
  return failed;
}

/** 删除账号目录前先解除所有链接（只删链接本身，绝不碰基础目录里的内容）；返回仍是链接、没解除成功的项 */
export function unlinkShared(dir: string): string[] {
  const left: string[] = [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return left;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    if (!lstat(p)?.isSymbolicLink()) continue;
    try {
      removeLink(p);
    } catch {
      left.push(name);
    }
  }
  // 硬链接的共享文件：删掉这一份不影响基础目录里的那一份，所以不用特别处理
  return left;
}
