// 侧栏用到的纯函数：路径比较、工作空间显示名、标题过滤、去掉已置顶的会话。
import type { SessionSummary, Workspace } from '@cosyee/shared';

/** Windows 路径不区分大小写，忽略末尾分隔符 */
export const samePath = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

/** 会话所属工作空间的显示名：优先用工作空间列表里的名字，列表里没有（比如已被移除）就取路径最后一段 */
export function workspaceName(cwd: string, workspaces: Workspace[]): string {
  const hit = workspaces.find((w) => samePath(w.path, cwd));
  if (hit) return hit.name;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** 列表里显示的标题（空标题显示「新会话」） */
export const displayTitle = (title: string): string => title || '新会话';

/** 按标题过滤（不区分大小写）；query 为空（或只有空白）时原样返回 */
export function filterByTitle<T extends { title: string }>(list: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((s) => displayTitle(s.title).toLowerCase().includes(q));
}

/** 工作空间列表里不再显示已经出现在「置顶」里的会话 */
export function excludePinned(sessions: SessionSummary[], pinned: SessionSummary[]): SessionSummary[] {
  if (pinned.length === 0) return sessions;
  const ids = new Set(pinned.map((p) => p.id));
  return sessions.filter((s) => !ids.has(s.id));
}

export interface WorkspaceGroup {
  path: string;
  name: string;
  sessions: SessionSummary[];
}

/**
 * 按工作空间分组：先按工作空间列表的顺序，每个工作空间一组（没有会话的也保留，方便看到全部工作空间）；
 * 会话所属的目录不在列表里（比如工作空间已被移除）时，另起一组放在最后，不让会话消失。组内顺序沿用传入顺序。
 */
export function groupByWorkspace(sessions: SessionSummary[], workspaces: Workspace[]): WorkspaceGroup[] {
  const groups: WorkspaceGroup[] = workspaces.map((w) => ({ path: w.path, name: w.name, sessions: [] }));
  for (const s of sessions) {
    let g = groups.find((x) => samePath(x.path, s.cwd));
    if (!g) {
      g = { path: s.cwd, name: workspaceName(s.cwd, workspaces), sessions: [] };
      groups.push(g);
    }
    g.sessions.push(s);
  }
  return groups;
}
