// 外壳调试页：http://127.0.0.1:5173/?dev=shell
import { useMemo, useState } from 'react';
import { BUILTIN_PRICES, DEFAULT_SUBAGENTS } from '@cosyee/shared';
import type { CachePoint, ContextUsage, DelegateModelList, DeletedSession, SessionSummary, SkillMode, SubagentConfig, SubagentState, Turn, Workspace } from '@cosyee/shared';
import { AppShell } from '../ui/layout/AppShell';
import { NARROW_QUERY, useMediaQuery } from '../ui/layout/useMediaQuery';
import { PinnedRail } from '../ui/sidebar/PinnedRail';
import { Sidebar } from '../ui/sidebar/Sidebar';
import { SessionDetailContext } from '../ui/sidebar/sessionDetail';
import { WorkspaceMenu } from '../ui/sidebar/WorkspaceMenu';
import { SessionHeader } from '../ui/header/SessionHeader';
import { ContextPanel } from '../ui/context/ContextPanel';
import { ChartRail } from '../ui/context/ChartRail';
import { FilesContext, type FilesApi } from '../ui/files/FileContext';
import {
  mockAccount,
  mockContextUsage,
  mockDeleted,
  mockNonGitPaths,
  mockPinned,
  mockSessionDetail,
  mockSessionsFor,
  mockWorkspaces,
} from '../mock/shell';

/** 上下文走势 / 缓存命中率的演示数据：第 4 次请求读了个大文件，第 5 次因此涨了一大截 */
const devTurns: Turn[] = [
  {
    id: 'dt0', userText: '看看这个项目的结构', attachments: [], status: 'done', statusText: '', answer: '', subagents: [], startedAt: 0,
    steps: [
      { kind: 'tool', id: 'd1', name: 'Glob', input: { pattern: 'src/**/*.ts' }, summary: 'Glob: src/**/*.ts', result: { content: 'a.ts b.ts '.repeat(80), isError: false } },
      { kind: 'tool', id: 'd2', name: 'Read', input: { file_path: 'src/reducer.ts' }, summary: 'Read: src/reducer.ts', result: { content: 'x'.repeat(56_000), isError: false } },
      { kind: 'tool', id: 'd3', name: 'Bash', input: { command: 'git log -5' }, summary: 'Bash: git log -5', result: { content: 'commit …'.repeat(60), isError: false } },
    ],
  },
  { id: 'dt1', userText: '把 reducer 拆开', attachments: [], status: 'done', statusText: '', answer: '', subagents: [], startedAt: 0, steps: [] },
];
const devCache: CachePoint[] = [
  [0, 0, 18_000, 120, undefined],
  [1, 18_000, 900, 40, ['d1']],
  [2, 18_900, 1_400, 30, ['d2', 'd3']],
  [3, 20_300, 15_600, 20, undefined],
  [4, 35_900, 1_200, 600, undefined],
  [5, 37_100, 800, 30, undefined],
].map(([i, read, create, input, tools], n) => ({
  id: `dm${i}`, turn: n < 4 ? 0 : 1, read: read as number, create: create as number, input: input as number,
  rate: ((read as number) / ((read as number) + (create as number) + (input as number))) * 100,
  ...(tools ? { tools: tools as string[] } : {}),
}));

/** 调试页没有后端：路径操作只打印到控制台，让标题栏里的「显示 / 终端」按钮能看到 */
const devFiles: FilesApi = {
  cwd: mockWorkspaces[0].path,
  open: (req) => console.info('[dev] open', req),
  reveal: (path) => console.info('[dev] reveal', path),
  terminal: (path) => console.info('[dev] terminal', path),
};

const devDelegate: DelegateModelList = {
  models: [
    { value: 'gemini-4-neon', displayName: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high'] },
    { value: 'gemini-4-pro-preview', displayName: 'Gemini 4 Pro (Preview)', efforts: ['low', 'high'] },
    { value: 'orch', displayName: 'Orchestrator (Beta)', efforts: [] },
  ],
  current: { model: 'gemini-4-neon', effort: 'high' },
  at: 0,
};

/** ?dev=shell&stress=1：长名字、大数字，检查上下文栏在最窄时会不会溢出；&sub=claude|agy|unavail|fallback 切换子代理演示状态 */
const devQuery = new URLSearchParams(location.search);
const stress = devQuery.has('stress');
const subMode = devQuery.get('sub');
function initialSubagents(): SubagentState {
  const allOk: SubagentState['available'] = {
    native: { ok: true },
    claude: { ok: true },
    agy: { ok: true },
  };
  if (subMode === 'claude') {
    return { config: { ...DEFAULT_SUBAGENTS, kind: 'claude' }, available: allOk, effective: 'claude' };
  }
  if (subMode === 'agy') {
    return { config: { ...DEFAULT_SUBAGENTS, kind: 'agy', agy: { model: 'gemini-4-neon', effort: 'high' } }, available: allOk, effective: 'agy' };
  }
  if (subMode === 'unavail') {
    return {
      config: DEFAULT_SUBAGENTS,
      available: { native: { ok: true }, claude: { ok: true }, agy: { ok: false, reason: '未安装 Antigravity CLI' } },
      effective: 'native',
    };
  }
  if (subMode === 'fallback') {
    return {
      config: { ...DEFAULT_SUBAGENTS, kind: 'agy', agy: { model: 'gemini-4-neon', effort: 'high' } },
      available: { native: { ok: true }, claude: { ok: true }, agy: { ok: false, reason: '未安装 Antigravity CLI' } },
      effective: 'native',
    };
  }
  return { config: DEFAULT_SUBAGENTS, available: allOk, effective: 'native' };
}
const devUsage: ContextUsage = stress
  ? {
      ...mockContextUsage,
      usedTokens: 1_845_200, totalTokens: 2_000_000, percent: 92.26, untilAutocompact: 1_098_400,
      toolTokens: [{ name: 'Bash', tokens: 12_300 }, { name: 'Read', tokens: 1_200 }],
      disabledTools: ['WebSearch'],
      skills: [
        ...(mockContextUsage.skills ?? []),
        { name: 'some-plugin:a-really-long-skill-name-that-goes-on', mode: 'on', tokens: 12_340, source: 'plugin' },
      ],
      mcpServers: [
        ...(mockContextUsage.mcpServers ?? []),
        { name: 'a-very-long-mcp-server-name-for-testing', status: 'failed', tokens: 123_000, tools: [{ name: 'do_something_extremely_long_and_verbose', tokens: 12_000 }] },
      ],
    }
  : { ...mockContextUsage };
const devTools = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'mcp__cosyee__delegate'];

export default function ShellDev() {
  const narrow = useMediaQuery(NARROW_QUERY);
  const [drawer, setDrawer] = useState<'left' | 'right' | null>(null);
  const [ctxCollapsed, setCtxCollapsed] = useState(false);
  const [subagents, setSubagents] = useState<SubagentState>(initialSubagents);
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

  const [usage, setUsage] = useState<ContextUsage | null>(devUsage);
  const [loading, setLoading] = useState(false);

  const sessions = sessionsByWs[currentWs] ?? mockSessionsFor(currentWs);
  // 侧栏按工作空间分组，所以给它所有工作空间的会话
  const allSessions = useMemo(
    () => workspaces.flatMap((w) => sessionsByWs[w.path] ?? mockSessionsFor(w.path)),
    [workspaces, sessionsByWs],
  );
  const current = useMemo(
    () => allSessions.find((s) => s.id === currentId) ?? pins.find((s) => s.id === currentId) ?? null,
    [allSessions, pins, currentId],
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
      setUsage((u) => ({ ...(u ?? devUsage), at: Date.now() }));
      setLoading(false);
    }, 800);
  };

  const flip = (off: string[] | undefined, name: string, enabled: boolean) =>
    enabled ? (off ?? []).filter((n) => n !== name) : [...(off ?? []), name];
  const setSkillModes = (modes: Record<string, SkillMode>) =>
    setUsage((u) => (u ? { ...u, skills: u.skills?.map((s) => (s.name in modes ? { ...s, mode: modes[s.name]! } : s)) } : u));

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
    <SessionDetailContext.Provider value={mockSessionDetail}>
    <FilesContext.Provider value={devFiles}>
    <AppShell
      narrow={narrow}
      onDismiss={() => setDrawer(null)}
      sidebarCollapsed={narrow ? drawer !== 'left' : collapsed}
      onToggleSidebar={() => (narrow ? setDrawer('left') : setCollapsed((v) => !v))}
      onNewSession={() => setCurrentId(null)}
      contextCollapsed={narrow ? drawer !== 'right' : ctxCollapsed}
      onToggleContext={() => (narrow ? setDrawer('right') : setCtxCollapsed((v) => !v))}
      sidebar={
        <Sidebar
          workspaces={workspaces}
          sessions={allSessions}
          pinned={pins}
          deleted={deleted}
          currentSessionId={currentId}
          account={signedIn ? mockAccount : null}
          onNewSession={() => setCurrentId(null)}
          onCollapse={() => (narrow ? setDrawer(null) : setCollapsed(true))}
          onSelectSession={selectSession}
          onTogglePin={togglePin}
          onDeleteSession={deleteSession}
          onRestoreSession={restoreSession}
          onPurgeSession={purgeSession}
          onDeleteSessions={(_cwd, ids) => {
            for (const id of ids) {
              const x = allSessions.find((y) => y.id === id);
              if (x) deleteSession(x);
            }
          }}
          onRestoreSessions={(ids) => ids.forEach(restoreSession)}
          onPurgeSessions={(ids) => setDeleted((l) => l.filter((x) => !ids.includes(x.id)))}
        />
      }
      header={
        <SessionHeader
          title={current ? current.title : null}
          cwd={currentWs}
          branch={mockNonGitPaths.includes(currentWs) ? null : 'main'}
          session={current}
          onRename={rename}
        />
      }
      main={
        <div style={{ flex: 1, position: 'relative', display: 'grid', placeItems: 'center', color: 'var(--text-3)', fontSize: 'var(--fs-sm)', container: 'cz-main / inline-size' }}>
          <PinnedRail
            open={collapsed && !narrow}
            pinned={pins}
            workspaces={workspaces}
            currentSessionId={currentId}
            onSelectSession={selectSession}
          />
          <ChartRail open={ctxCollapsed && !narrow} usage={usage} cache={devCache} turns={devTurns} pricing={BUILTIN_PRICES} />
          <div style={{ textAlign: 'center', lineHeight: 2 }}>
            <div>会话流 + 输入框 占位</div>
            <div>点账户栏可切换「已登录 / 未登录」</div>
            <div style={{ display: 'flex', justifyContent: 'center' }}>
              {/* 工作空间选择器真实位置在输入框左下角（仅新会话草稿）；这里单独摆一份方便调样式 */}
              <WorkspaceMenu
                workspaces={workspaces}
                currentWorkspace={currentWs}
                onSelectWorkspace={selectWorkspace}
                onOpenFolder={openFolder}
                onMoveToTop={moveWorkspaceTop}
                onRemove={removeWorkspace}
                onReveal={() => undefined}
              />
            </div>
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
      context={
        <ContextPanel
          usage={usage}
          loading={loading}
          onRefresh={refresh}
          onCompact={compact}
          onCompactWindow={(w) => setUsage((u) => (u ? { ...u, compactWindow: w } : u))}
          onCollapse={() => (narrow ? setDrawer(null) : setCtxCollapsed(true))}
          onSkillMode={(name, mode) => setSkillModes({ [name]: mode })}
          onSkillModes={setSkillModes}
          onSkillRemove={(name) => setUsage((u) => (u ? { ...u, skills: u.skills?.filter((s) => s.name !== name) } : u))}
          onSkillReveal={(name) => console.info('[dev] reveal skill', name)}
          onMcpToggle={(server, enabled) =>
            setUsage((u) =>
              u ? { ...u, mcpServers: u.mcpServers?.map((s) => (s.name === server ? { ...s, status: enabled ? 'connected' : 'disabled' } : s)) } : u,
            )
          }
          tools={devTools}
          onToolToggle={(name, enabled) => setUsage((u) => (u ? { ...u, disabledTools: flip(u.disabledTools, name, enabled) } : u))}
          agents={['Explore', 'Plan', 'general-purpose', 'statusline-setup']}
          onAgentToggle={(name, enabled) => setUsage((u) => (u ? { ...u, disabledAgents: flip(u.disabledAgents, name, enabled) } : u))}
          toolStats={stress ? { counts: { Bash: 123_456, Read: 8_921 }, skills: { impeccable: 1_234 }, sessions: 88, at: 0 } : null}
          cache={devCache}
          turns={devTurns}
          subagents={{
            state: subagents,
            onChange: (c: SubagentConfig) =>
              setSubagents((prev) => ({ ...prev, config: c, effective: prev.available[c.kind]?.ok ? c.kind : 'native' })),
            delegate: devDelegate,
            onLoadDelegate: () => undefined,
            accounts: { claude: 'cosyeey', agy: 'alex.chen@example.com' },
            defaultOpen: !!subMode,
          }}
        />
      }
    />
    </FilesContext.Provider>
    </SessionDetailContext.Provider>
  );
}
