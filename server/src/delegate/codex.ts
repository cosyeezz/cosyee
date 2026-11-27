// 定位 Codex CLI 可执行文件：COSYEE_CODEX > PATH > 默认安装目录。
// Windows 的 npm 安装只放一个 codex.cmd / codex.ps1 / 无扩展名 sh 垫片（实际是 node 跑 codex.js 再拉起原生 exe），
// 直接 spawn 垫片既慢又杀不干净进程树，所以这里解析到真正的 codex.exe；解析不到才退回垫片本身。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isFile, spawnSpec } from '../claude/bin.js';
import { parseCodexVersion } from './codexProtocol.js';

/** 未登录 Codex 时给用户 / 模型看的提示 */
export const CODEX_NOT_LOGGED_IN = 'Codex 尚未登录：请先在设置里登录 Codex 账号（或在终端运行 codex login），再重试。';

export type CodexInstallKind = 'npm' | 'standalone' | 'custom';

export interface CodexInfo {
  /** 实际 spawn 的路径（npm 垫片已解析到原生 exe；解析不到则是垫片本身） */
  execPath: string;
  /** 在 PATH / 默认目录 / COSYEE_CODEX 里找到的原始路径（可能是垫片） */
  rawPath: string;
  installKind: CodexInstallKind;
}

export interface ResolveOptions {
  /** 测试用：覆盖平台 / 架构 / home 目录 */
  platform?: NodeJS.Platform;
  arch?: string;
  homedir?: string;
}

const TRIPLES: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
};

/** 从 npm 包根（…/node_modules/@openai/codex）找原生可执行文件，找不到返回 null */
function nativeFromPackageRoot(pkgRoot: string, platform: NodeJS.Platform, arch: string): string | null {
  const key = `${platform}-${arch}`;
  const triple = TRIPLES[key];
  if (!triple) return null;
  const exeName = platform === 'win32' ? 'codex.exe' : 'codex';
  const platPkg = `codex-${key}`;
  const tail = path.join('vendor', triple, 'bin', exeName);
  const cands: string[] = [path.join(pkgRoot, 'node_modules', '@openai', platPkg, tail)];
  // 依赖被提升：往上逐级找 node_modules/@openai/<platPkg>
  let dir = path.dirname(pkgRoot);
  for (let i = 0; i < 6; i++) {
    cands.push(path.join(dir, platPkg, tail));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  cands.push(path.join(pkgRoot, tail));
  for (const c of cands) if (isFile(c)) return c;
  return null;
}

/** 垫片文本里写死的 codex.js 位置（%dp0% / $basedir / ${basedir} 替换成垫片目录） */
function pkgRootFromShimText(shim: string): string | null {
  let text: string;
  try {
    const st = fs.statSync(shim);
    if (st.size > 64 * 1024) return null;
    text = fs.readFileSync(shim, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shim);
  const m = /((?:%~?dp0%?|\$basedir|\$\{basedir\}|\$PSScriptRoot|\$\(dirname[^)]*\))?[\\/]*(?:[^"'\s]*?[\\/])?node_modules[\\/]@openai[\\/]codex)[\\/]bin[\\/]codex\.js/i.exec(text);
  if (!m) return null;
  let rel = m[1]!.replace(/^(?:%~?dp0%?|\$basedir|\$\{basedir\}|\$PSScriptRoot|\$\(dirname[^)]*\))/i, '').replace(/^[\\/]+/, '');
  rel = rel.replace(/[\\/]+/g, path.sep);
  return path.isAbsolute(rel) ? rel : path.join(dir, rel);
}

/** npm 垫片（或 Unix 上指向 codex.js 的符号链接）→ 原生可执行文件；解析不到返回 null */
function resolveNpmShim(raw: string, platform: NodeJS.Platform, arch: string): string | null {
  const roots: string[] = [];
  const dir = path.dirname(raw);
  // 垫片同目录的 node_modules（Windows 全局前缀 / 本地 .bin 的上一级）
  roots.push(path.join(dir, 'node_modules', '@openai', 'codex'));
  // Unix：codex → ../lib/node_modules/@openai/codex/bin/codex.js
  try {
    const real = fs.realpathSync(raw);
    if (/[\\/]bin[\\/]codex\.js$/i.test(real)) roots.push(path.dirname(path.dirname(real)));
  } catch { /* ignore */ }
  roots.push(path.join(dir, '..', 'lib', 'node_modules', '@openai', 'codex'));
  const fromText = pkgRootFromShimText(raw);
  if (fromText) roots.push(fromText);
  const seen = new Set<string>();
  for (const r of roots) {
    const k = path.resolve(r);
    if (seen.has(k)) continue;
    seen.add(k);
    const exe = nativeFromPackageRoot(k, platform, arch);
    if (exe) return exe;
  }
  return null;
}

function isShimLike(p: string, platform: NodeJS.Platform): boolean {
  const ext = path.extname(p).toLowerCase();
  if (platform === 'win32') return ext === '.cmd' || ext === '.bat' || ext === '.ps1' || ext === '';
  // Unix：符号链接 / 脚本都可能是 npm 的入口，交给 resolveNpmShim 判断（不是 npm 布局就返回 null）
  return true;
}

function classify(raw: string, exec: string): CodexInstallKind {
  if (/[\\/]node_modules[\\/]/i.test(exec) || /[\\/]node_modules[\\/]/i.test(raw)) return 'npm';
  return 'standalone';
}

/** PATH 里逐目录找：同一目录里 exe 优先于垫片 */
function searchDirs(dirs: string[], platform: NodeJS.Platform): string | null {
  const names = platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex.ps1', 'codex'] : ['codex'];
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (isFile(p)) return p;
    }
  }
  return null;
}

function defaultDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string[] {
  const dirs: string[] = [];
  if (env.CODEX_INSTALL_DIR) dirs.push(env.CODEX_INSTALL_DIR);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    dirs.push(path.join(local, 'Programs', 'OpenAI', 'Codex', 'bin'));
    const roaming = env.APPDATA || path.join(home, 'AppData', 'Roaming');
    dirs.push(path.join(roaming, 'npm'));
  } else {
    dirs.push(path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.npm-global', 'bin'));
  }
  return dirs;
}

function finish(raw: string, kind: CodexInstallKind | null, platform: NodeJS.Platform, arch: string): CodexInfo {
  if (isShimLike(raw, platform)) {
    const real = resolveNpmShim(raw, platform, arch);
    if (real) {
      return { execPath: real, rawPath: raw, installKind: kind ?? 'npm' };
    }
  }
  return { execPath: raw, rawPath: raw, installKind: kind ?? classify(raw, raw) };
}

/**
 * 找 Codex CLI：COSYEE_CODEX > PATH > 默认安装目录。找不到返回 null。
 * COSYEE_CODEX 指向的文件不存在也返回 null（显式配置错了不静默回退）。
 */
export function resolveCodexInfo(env: NodeJS.ProcessEnv = process.env, o: ResolveOptions = {}): CodexInfo | null {
  const platform = o.platform ?? process.platform;
  const arch = o.arch ?? process.arch;
  const home = o.homedir ?? os.homedir();
  const override = env.COSYEE_CODEX;
  if (override) {
    if (!isFile(override)) return null;
    return finish(override, 'custom', platform, arch);
  }
  const pathDirs = (env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((d) => (platform === 'win32' ? d.trim().replace(/^"|"$/g, '') : d.trim()))
    .filter(Boolean);
  const hit = searchDirs(pathDirs, platform) ?? searchDirs(defaultDirs(env, platform, home), platform);
  return hit ? finish(hit, null, platform, arch) : null;
}

/** 运行 `codex --version` 取版本号；失败 / 超时返回 null（同步，调用方自行缓存） */
export function probeCodexVersion(execPath: string, env: NodeJS.ProcessEnv, timeoutMs = 8000): string | null {
  try {
    const spec = spawnSpec(execPath, ['--version']);
    const r = spawnSync(spec.command, spec.args, {
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: spec.verbatim,
    });
    if (r.error || r.status !== 0) return null;
    return parseCodexVersion(String(r.stdout ?? ''));
  } catch {
    return null;
  }
}
