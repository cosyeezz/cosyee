// 在系统文件管理器里打开工作空间文件夹。只接受已在工作空间列表里的路径（由 http 层校验）；spawn 用参数数组、不经过 shell。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export type Spawner = (cmd: string, args: string[]) => void;

export const defaultSpawner: Spawner = (cmd, args) => {
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true, shell: false });
  child.on('error', () => {}); // 找不到命令等：忽略，不能让进程崩
  child.unref();
};

export function revealCommand(dir: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[] } {
  if (platform === 'win32') return { cmd: 'explorer.exe', args: [dir] }; // explorer 成功时退出码也常为 1，所以不看退出码
  if (platform === 'darwin') return { cmd: 'open', args: [dir] };
  return { cmd: 'xdg-open', args: [dir] };
}

/** 目录存在才打开；返回是否真的发出了命令 */
export function revealFolder(dir: string, spawner: Spawner = defaultSpawner): boolean {
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch { /* 不存在 */ }
  if (!isDir) return false;
  const { cmd, args } = revealCommand(dir);
  spawner(cmd, args);
  return true;
}
