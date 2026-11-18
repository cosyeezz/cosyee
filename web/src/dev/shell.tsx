// 外壳调试页：http://127.0.0.1:5173/?dev=shell
import { useMemo, useState } from 'react';
import type { ContextUsage, DeletedSession, SessionSummary, Workspace } from '@cosyee/shared';
import { AppShell } from '../ui/layout/AppShell';
import { Sidebar } from '../ui/sidebar/Sidebar';
import { SessionHeader } from '../ui/header/SessionHeader';
import { ContextPanel } from '../ui/context/ContextPanel';
import {
  mockAccount,
  mockContextUsage,
  mockDeleted,
  mockNonGitPaths,
  mockPinned,
  mockSessionsFor,
  mockWorkspaces,
} from '../mock/shell';

export default function ShellDev() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(mockWorkspaces);
  const [currentWs, setCurrentWs] = useState<string>(mockWorkspaces[0].path);
  // 每个工作空间各自的会话，切换时保留改名结果
  const [sessionsByWs, setSessionsByWs] = useState<Record<string, SessionSummary[]>>(() => ({
    [mockWorkspaces[0].path]: mockSessionsFor(mockWorkspaces[0].path),
  }));
  const [pins, setPins] = useState<SessionSummary[]>(mockPinned);
  const [deleted, setDeleted] = useState<DeletedSession[]>(mockDeleted);
  const [currentId, setCurrentId] = useState<string | null>('s1');
  const [collapsed, setCollapsed] = useState(false);
  const [signedIn] = useState(true);

  const [usage, setUsage] = useState<ContextUsage | null>(mockContextUsage);
  const [loading, setLoading] = useState(false);

  const sessions = sessionsByWs[currentWs] ?? mockSessionsFor(currentWs);
  const current = useMemo(
    () => sessions.find((s) => s.id === currentId) ?? pins.find((s) => s.id === currentId) ?? null,
    [sessions, pins, currentId],
  );

  const updateSessions = (fn: (list: SessionSummary[]) => SessionSummary[]) =>
    setSessionsByWs((m) => ({ ...m, [currentWs]: fn(m[currentWs] ?? mockSessionsFor(currentWs)) }));

  const selectWorkspace = (path: string) => {
    setCurrentWs(path);
    setCurrentId(null);
  };

  const selectSession = (id: string) => {
    setCurrentId(id);
    // 查看后清除蓝点
    updateSessions((l) => l.map((s) => (s.id === id && s.dot === 'unread' ? { ...s, dot: null } : s)));
  };

  // 置顶 / 删除 / 恢复 / 工作空间管理：dev 页全在本地模拟，不走网络
  const togglePin = (s: SessionSummary) =>
    setPins((l) => (s.pinned ? l.filter((x) => x.id !== s.id) : [{ ...s, pinned: 'manual' }, ...l]));

  const deleteSession = (s: SessionSummary) => {
    if (s.dot === 'running') return;
    setPins((l) => l.filter((x) => x.id !== s.id));
    setSessionsByWs((m) => {
      const next: Record<string, SessionSummary[]> = {};
      for (const [k, v] of Object.entries(m)) next[k] = v.filter((x) => x.id !== s.id);
      return next;
    });
    setDeleted((l) => [{ id: s.id, cwd: s.cwd, title: s.title, deletedAt: Date.now() }, ...l]);
    if (currentId === s.id) setCurrentId(null);
  };

  const restoreSession = (id: string) => {
    const d = deleted.find((x) => x.id === id);
    if (!d) return;
    setDeleted((l) => l.filter((x) => x.id !== id));
    setSessionsByWs((m) => {
      const base = m[d.cwd] ?? mockSessionsFor(d.cwd);
      const back: SessionSummary = { id: d.id, cwd: d.cwd, title: d.title, lastActiveAt: Date.now(), dot: null, pinned: null };
      return { ...m, [d.cwd]: [back, ...base] };
    });
  };

  const purgeSession = (id: string) => setDeleted((l) => l.filter((x) => x.id !== id));

  const moveWorkspaceTop = (path: string) =>
    setWorkspaces((l) => {
      const w = l.find((x) => x.path === path);
      return w ? [w, ...l.filter((x) => x.path !== path)] : l;
    });

  const removeWorkspace = (path: string) => {
    const rest = workspaces.filter((w) => w.path !== path);
    setWorkspaces(rest);
    if (path === currentWs && rest[0]) selectWorkspace(rest[0].path);
  };

  const openFolder = () => {
    const n = workspaces.length + 1;
    const ws: Workspace = { path: `E:\\demo\\folder-${n}`, name: `folder-${n}` };
    setWorkspaces((l) => [...l, ws]);
    selectWorkspace(ws.path);
  };

  const rename = (title: string) => {
    if (!currentId) return;
    updateSessions((l) => l.map((s) => (s.id === currentId ? { ...s, title } : s)));
  };

  const refresh = () => {
    setLoading(true);
    setTimeout(() => {
      setUsage({ ...mockContextUsage, at: Date.now() });
      setLoading(false);
    }, 800);
  };

  const compact = () => {
    setUsage((u) =>
      u
        ? {
            ...u,
            usedTokens: 12_000,
            percent: 6,
            untilAutocompact: 155_000,
            categories: u.categories.map((c) =>
              c.name === 'Messages' ? { ...c, tokens: 2_400, percent: 1.2 } : c.name === 'Free space' ? { ...c, tokens: 140_000, percent: 70 } : c,
            ),
          }
        : u,
    );
  };

  return (
    <AppShell
      sidebarCollapsed={collapsed}
      onToggleSidebar={() => setCollapsed((v) => !v)}
      sidebar={
        <Sidebar
          workspaces={workspaces}
          currentWorkspace={currentWs}
          sessions={sessions}
          pinned={pins}
          deleted={deleted}
          currentSessionId={currentId}
          account={signedIn ? mockAccount : null}
          onNewSession={() => setCurrentId(null)}
          onCollapse={() => setCollapsed(true)}
          onSelectWorkspace={selectWorkspace}
          onOpenFolder={openFolder}
          onMoveWorkspaceTop={moveWorkspaceTop}
          onRemoveWorkspace={removeWorkspace}
          onRevealWorkspace={() => undefined}
          onSelectSession={selectSession}
          onTogglePin={togglePin}
          onDeleteSession={deleteSession}
          onRestoreSession={restoreSession}
          onPurgeSession={purgeSession}
        />
      }
      header={
        <SessionHeader
          title={current ? current.title : null}
          cwd={currentWs}
          branch={mockNonGitPaths.includes(currentWs) ? null : 'main'}
          onRename={rename}
        />
      }
      main={
        <div style={{ flex: 1, display: 'grid', placeItems: 'center', color: 'var(--text-3)', fontSize: 'var(--fs-sm)' }}>
          <div style={{ textAlign: 'center', lineHeight: 2 }}>
            <div>会话流 + 输入框 占位</div>
            <div>点账户栏可切换「已登录 / 未登录」</div>
            <button
              type="button"
              onClick={() => setUsage((u) => (u ? null : mockContextUsage))}
              style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '4px 12px', cursor: 'pointer' }}
            >
              切换上下文：{usage ? '有数据 → 空态' : '空态 → 有数据'}
            </button>
          </div>
        </div>
      }
      context={<ContextPanel usage={usage} loading={loading} onRefresh={refresh} onCompact={compact} />}
    />
  );
}
