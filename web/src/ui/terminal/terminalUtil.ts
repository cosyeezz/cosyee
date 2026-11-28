// 终端 UI 工具函数：路径简写与中间省略、标签名生成、耗时格式化、历史命令模糊匹配。
import type { TermTabInfo } from '@cosyee/shared';

/** 取路径最后一段作为工作空间名称 */
export function workspaceName(root: string): string {
  const cleaned = root.replace(/[\\/]+$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? (root || '终端');
}

/** 计算标签自动展示名：运行中命令 → cwd 目录名 → 工作空间名 */
export function tabAutoName(tab: TermTabInfo, root: string): string {
  if (tab.status === 'running' && tab.runningCmd?.trim()) {
    return tab.runningCmd.trim();
  }
  return workspaceName(tab.cwd || root);
}

/** 计算标签最终展示名：自定义名 → 运行中命令 → cwd 目录名 */
export function tabDisplayName(tab: TermTabInfo, root: string): string {
  const custom = tab.name?.trim();
  if (custom) return custom;
  return tabAutoName(tab, root);
}

/** 路径中间省略，保留开头和末尾最有辨识度的部分 */
export function middleEllipsisPath(path: string, maxLen = 48): string {
  if (!path || path.length <= maxLen) return path;
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) {
    const head = Math.max(8, Math.floor((maxLen - 1) * 0.45));
    const tail = Math.max(8, maxLen - 1 - head);
    return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
  }
  const prefix = path.startsWith('/') ? '/' : '';
  const first = prefix + parts[0]!;
  const last = parts[parts.length - 1]!;
  const secondLast = parts.length >= 3 ? parts[parts.length - 2]! : '';
  const candidate2 = `${first}${sep}…${sep}${secondLast}${sep}${last}`;
  if (candidate2.length <= maxLen) return candidate2;
  const candidate1 = `${first}${sep}…${sep}${last}`;
  if (candidate1.length <= maxLen) return candidate1;
  const keepTail = Math.max(10, maxLen - first.length - 3);
  return `${first}${sep}…${last.slice(Math.max(0, last.length - keepTail))}`;
}

/** 将执行目录简写为相对于工作空间根的短路径（用于提示符行） */
export function shortCwd(cwd: string, root: string): string {
  if (!cwd) return workspaceName(root);
  const norm = (s: string) => s.replace(/[\\/]+$/, '');
  const nc = norm(cwd);
  const nr = norm(root);
  const name = workspaceName(nr);
  if (!nr) return middleEllipsisPath(nc, 36);
  const lc = nc.toLowerCase();
  const lr = nr.toLowerCase();
  if (lc === lr) return name;
  if (lc.startsWith(lr + '\\') || lc.startsWith(lr + '/')) {
    const rel = nc.slice(nr.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
    return middleEllipsisPath(`${name}/${rel}`, 40);
  }
  return middleEllipsisPath(nc, 40);
}

/** 格式化执行耗时 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const mins = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  if (mins < 60) return rem > 0 ? `${mins}m ${rem}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `${hrs}h ${remMin}m` : `${hrs}h`;
}

export interface FuzzyMatchResult {
  cmd: string;
  /** 命中的字符下标（递增） */
  indices: number[];
  score: number;
}

/** 轻量模糊匹配：支持连续命中加分、词首命中加分、越近越靠前 */
export function fuzzyMatchHistory(history: readonly string[], query: string): FuzzyMatchResult[] {
  // 历史是旧 -> 新，展示时新 -> 旧
  const rev = [...history].reverse();
  const q = query.trim().toLowerCase();
  if (!q) {
    return rev.map((cmd, idx) => ({ cmd, indices: [], score: -idx }));
  }

  const results: FuzzyMatchResult[] = [];
  for (let order = 0; order < rev.length; order++) {
    const cmd = rev[order]!;
    const lower = cmd.toLowerCase();
    // 优先子串精确包含
    const subIdx = lower.indexOf(q);
    if (subIdx !== -1) {
      const indices = Array.from({ length: q.length }, (_, k) => subIdx + k);
      const bonus = subIdx === 0 ? 40 : (lower[subIdx - 1] === ' ' || lower[subIdx - 1] === '/' ? 25 : 0);
      results.push({ cmd, indices, score: 1000 + bonus - subIdx * 2 - order * 0.1 });
      continue;
    }
    // 子序列模糊匹配
    let qi = 0;
    let score = 0;
    let prev = -2;
    const indices: number[] = [];
    for (let i = 0; i < lower.length && qi < q.length; i++) {
      if (lower[i] === q[qi]) {
        indices.push(i);
        if (i === prev + 1) score += 12;
        else if (i === 0 || lower[i - 1] === ' ' || lower[i - 1] === '-' || lower[i - 1] === '/') score += 8;
        else score += 2;
        prev = i;
        qi++;
      }
    }
    if (qi === q.length) {
      results.push({ cmd, indices, score: score - cmd.length * 0.05 - order * 0.1 });
    }
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}
