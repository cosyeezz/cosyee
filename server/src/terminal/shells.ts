// 宿主机可用 shell 探测与默认 shell 选择（结果缓存）。
import fs from 'node:fs';
import path from 'node:path';
import type { TermShell, TermShellInfo } from '@cosyee/shared';
import { findGitBash } from '../exec.js';

export interface DetectedShells {
  list: TermShellInfo[];
  defaultShell: TermShell;
  /** 每个可用 shell 对应的可执行文件路径（可直接传给 spawn） */
  bins: Partial<Record<TermShell, string>>;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 按 PATH 查找可执行文件，找不到再检查 extra 候选路径 */
function findBin(names: string[], extra: string[] = [], env: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnv = env.PATH || env.Path || '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (isExecutable(full)) return full;
    }
  }
  for (const p of extra) {
    if (p && isExecutable(p)) return p;
  }
  return null;
}

const LABELS: Record<TermShell, string> = {
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell',
  cmd: '命令提示符',
  gitbash: 'Git Bash',
  zsh: 'zsh',
  bash: 'bash',
  sh: 'sh',
};

let cache: Promise<DetectedShells> | undefined;

export function detectShells(platform: NodeJS.Platform = process.platform): Promise<DetectedShells> {
  if (platform === process.platform) {
    cache ??= probeShells(platform);
    return cache;
  }
  return probeShells(platform);
}

/** 仅测试用：清除探测缓存 */
export function resetShellCache(): void {
  cache = undefined;
}

async function probeShells(platform: NodeJS.Platform): Promise<DetectedShells> {
  const list: TermShellInfo[] = [];
  const bins: Partial<Record<TermShell, string>> = {};
  const add = (id: TermShell, bin: string | null) => {
    if (!bin) return;
    list.push({ id, label: LABELS[id] });
    bins[id] = bin;
  };

  if (platform === 'win32') {
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    add('pwsh', findBin(['pwsh.exe'], [path.join(progFiles, 'PowerShell', '7', 'pwsh.exe')]));
    add(
      'powershell',
      findBin(['powershell.exe'], [path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]),
    );
    const comspec = process.env.ComSpec && isFile(process.env.ComSpec) ? process.env.ComSpec : null;
    add('cmd', comspec ?? findBin(['cmd.exe'], [path.join(sysRoot, 'System32', 'cmd.exe')]));
    add('gitbash', await findGitBash());

    if (list.length === 0) {
      const fallback = process.env.ComSpec || 'cmd.exe';
      list.push({ id: 'cmd', label: LABELS.cmd });
      bins.cmd = fallback;
    }
    const order: TermShell[] = ['pwsh', 'powershell', 'cmd', 'gitbash'];
    const defaultShell = order.find((id) => bins[id]) ?? list[0]!.id;
    return { list, defaultShell, bins };
  }

  // macOS / Linux
  add('zsh', findBin(['zsh'], ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh', '/opt/homebrew/bin/zsh']));
  add('bash', findBin(['bash'], ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']));
  add('sh', findBin(['sh'], ['/bin/sh', '/usr/bin/sh']));
  add('pwsh', findBin(['pwsh'], ['/usr/local/bin/pwsh', '/opt/homebrew/bin/pwsh', '/usr/bin/pwsh']));

  if (list.length === 0) {
    list.push({ id: 'sh', label: LABELS.sh });
    bins.sh = '/bin/sh';
  }

  // 默认：优先 $SHELL 对应项，否则 macOS 优先 zsh、Linux 优先 bash
  const envShellBase = process.env.SHELL ? path.basename(process.env.SHELL) : '';
  const envShell = (['zsh', 'bash', 'sh', 'pwsh'] as TermShell[]).find((id) => id === envShellBase && bins[id]);
  const order: TermShell[] = platform === 'darwin' ? ['zsh', 'bash', 'sh', 'pwsh'] : ['bash', 'zsh', 'sh', 'pwsh'];
  const defaultShell = envShell ?? order.find((id) => bins[id]) ?? list[0]!.id;
  return { list, defaultShell, bins };
}
