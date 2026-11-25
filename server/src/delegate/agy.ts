// Antigravity CLI（agy）的定位；驱动见 acp.ts（agy acp 常驻进程池）。
import os from 'node:os';
import path from 'node:path';
import { isFile } from '../claude/bin.js';

const isWin = process.platform === 'win32';
export const AGY_NOT_LOGGED_IN = 'Antigravity CLI 未登录：请先在终端运行 agy 完成登录';

/** 找 agy：COSYEE_AGY > PATH > 默认安装目录（新装后服务端 PATH 可能还是旧的）。找不到返回 null。 */
export function resolveAgy(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.COSYEE_AGY;
  if (override) return override;
  const names = isWin ? ['agy.exe', 'agy.cmd', 'agy.bat'] : ['agy'];
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  if (isWin) {
    if (env.LOCALAPPDATA) dirs.push(path.join(env.LOCALAPPDATA, 'agy', 'bin'));
  } else {
    dirs.push(path.join(os.homedir(), '.local', 'bin'));
  }
  for (const d of dirs) {
    for (const n of names) {
      const p = path.join(d, n);
      if (isFile(p)) return p;
    }
  }
  return null;
}
