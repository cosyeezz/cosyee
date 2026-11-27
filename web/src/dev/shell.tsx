// 外壳调试页：http://127.0.0.1:5173/?dev=shell
import { useMemo, useState } from 'react';
import { BUILTIN_PRICES, DEFAULT_SUBAGENTS } from '@cosyee/shared';
import type { CachePoint, ContextUsage, DelegateJobInfo, DelegateModelList, DeletedSession, SessionSummary, SkillMode, SubagentConfig, SubagentCost, SubagentRun, SubagentState, SubagentTypeInfo, Turn, Workspace } from '@cosyee/shared';
import { AppShell } from '../ui/layout/AppShell';
import { NARROW_QUERY, useMediaQuery } from '../ui/layout/useMediaQuery';
import { PinnedRail } from '../ui/sidebar/PinnedRail';
import { Sidebar } from '../ui/sidebar/Sidebar';
import { SessionDetailContext } from '../ui/sidebar/sessionDetail';
import { WorkspaceMenu } from '../ui/sidebar/WorkspaceMenu';
import { SessionHeader } from '../ui/header/SessionHeader';
import { ContextPanel } from '../ui/context/ContextPanel';
import { ChartRail } from '../ui/context/ChartRail';
import { SubagentOverlay } from '../ui/flow/SubagentOverlay';
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
    id: 'dt0', userText: '看看这个项目的结构', attachments: [], status: 'done', statusText: '', answer: '', startedAt: 0,
    subagents: [
      { toolUseId: 'demo-native', title: '梳理 reducer 用量统计链路', subagentType: 'Explore', model: 'claude-sonnet-4-5-20250929', status: 'done', turn: { id: 'sub-demo-native', userText: '梳理 reducer', attachments: [], status: 'done', statusText: '', steps: [], answer: '', subagents: [], startedAt: 0 } },
      { toolUseId: 'demo-agy', title: '探索前端交互动效与布局细节', subagentType: 'Explore', delegate: true, model: 'gemini-4-neon', status: 'done', turn: { id: 'sub-demo-agy', userText: '探索前端交互动效', attachments: [], status: 'done', statusText: '', steps: [], answer: '', subagents: [], startedAt: 0 } },
    ],
    steps: [
      { kind: 'tool', id: 'd1', name: 'Glob', input: { pattern: 'src/**/*.ts' }, summary: 'Glob: src/**/*.ts', result: { content: 'a.ts b.ts '.repeat(80), isError: false } },
      { kind: 'tool', id: 'd2', name: 'Read', input: { file_path: 'src/reducer.ts' }, summary: 'Read: src/reducer.ts', result: { content: 'x'.repeat(56_000), isError: false } },
      { kind: 'tool', id: 'd3', name: 'Bash', input: { command: 'git log -5' }, summary: 'Bash: git log -5', result: { content: 'commit …'.repeat(60), isError: false } },
    ],
  },
  {
    id: 'dt1', userText: '把 reducer 拆开', attachments: [], status: 'done', statusText: '', answer: '', startedAt: 0, steps: [],
    subagents: [
      { toolUseId: 'demo-codex', title: '实现 UsageBoard 单测与类型校验', subagentType: 'general-purpose', delegate: true, model: 'gpt-5.3-codex', status: 'done', turn: { id: 'sub-demo-codex', userText: '补充单测', attachments: [], status: 'done', statusText: '', steps: [], answer: '', subagents: [], startedAt: 0 } },
    ],
  },
];
const devSubCosts: SubagentCost[] = [
  { agentId: 'ag-native-1', toolUseId: 'demo-native', agentType: 'Explore', source: 'native', requests: 4, cost: { input: 0.02, write: 0.14, read: 0.03, output: 0.04 }, uncached: 0.35, unpriced: 0, models: ['claude-sonnet-4-5-20250929'] },
  { agentId: 'ag-agy-1', toolUseId: 'demo-agy', agentType: 'Explore', source: 'agy', requests: 3, cost: { input: 0.11, write: 0, read: 0.01, output: 0.03 }, uncached: 0.22, unpriced: 0, models: ['gemini-4-neon'] },
  { agentId: 'ag-codex-1', toolUseId: 'demo-codex', agentType: 'general-purpose', source: 'codex', requests: 3, cost: { input: 0.04, write: 0, read: 0.01, output: 0.04 }, uncached: 0.14, unpriced: 0, models: ['gpt-5.3-codex'] },
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
  output: 420, model: 'claude-sonnet-4-5-20250929',
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

const devCodexDelegate: DelegateModelList = {
  models: [
    { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] },
    { value: 'gpt-5.2-codex', displayName: 'GPT-5.2 Codex', efforts: ['low', 'medium', 'high'] },
  ],
  current: { model: 'gpt-5.3-codex', effort: 'medium' },
  at: 0,
};

/** ?dev=shell&stress=1：长名字、大数字，检查上下文栏在最窄时会不会溢出；&sub=claude|agy|unavail|fallback 切换子代理演示状态；&overlay=native|codex|agy|empty 打开子代理统计浮层 */
const devQuery = new URLSearchParams(location.search);
const stress = devQuery.has('stress');
const subMode = devQuery.get('sub');
type OverlayDemoKind = 'native' | 'codex' | 'agy' | 'empty';
const overlayParam = devQuery.get('overlay') as OverlayDemoKind | null;

const nowTs = Date.now();
const mkPt = (over: Partial<CachePoint> & { id: string; input: number; create: number; read: number }): CachePoint => {
  const total = over.input + over.create + over.read;
  return {
    turn: 0,
    rate: total > 0 ? (over.read / total) * 100 : 0,
    ...over,
  };
};

const OVERLAY_DEMOS: Record<OverlayDemoKind, { label: string; run: SubagentRun; job?: DelegateJobInfo }> = {
  native: {
    label: '原生（精确）',
    run: {
      toolUseId: 'demo-native',
      title: '梳理 reducer 用量统计链路',
      subagentType: 'Explore',
      model: 'claude-sonnet-4-5-20250929',
      effort: 'medium',
      status: 'done',
      contextWindow: 200_000,
      cache: [
        mkPt({ id: 'n1', input: 420, create: 22_000, read: 0, output: 380, model: 'claude-sonnet-4-5-20250929', tools: ['nt1'] }),
        mkPt({ id: 'n2', input: 160, create: 6_400, read: 22_420, output: 520, model: 'claude-sonnet-4-5-20250929', tools: ['nt2'] }),
        mkPt({ id: 'n3', input: 90, create: 14_200, read: 28_980, output: 640, model: 'claude-sonnet-4-5-20250929' }),
        mkPt({ id: 'n4', input: 120, create: 1_800, read: 43_270, output: 910, model: 'claude-sonnet-4-5-20250929' }),
      ],
      turn: {
        id: 'sub-demo-native',
        userText: '检查 web/src/core/reducer 里缓存统计和历史还原的调用关系',
        attachments: [],
        status: 'done',
        statusText: '',
        steps: [
          { kind: 'tool', id: 'nt1', name: 'Glob', input: { pattern: 'web/src/core/reducer/*.ts' }, summary: 'Glob: web/src/core/reducer/*.ts', result: { content: 'live.ts history.ts cacheHit.ts delegate.ts', isError: false } },
          { kind: 'tool', id: 'nt2', name: 'Read', input: { file_path: 'web/src/core/reducer/live.ts' }, summary: 'Read: web/src/core/reducer/live.ts', result: { content: 'x'.repeat(28_000), isError: false } },
        ],
        answer: '已完成梳理：主线程统计落在 `SessionMeta.cache`，子代理统计落在 `SubagentRun.cache`。',
        subagents: [],
        startedAt: nowTs - 42_000,
        endedAt: nowTs - 3_000,
      },
    },
  },
  codex: {
    label: 'Codex（无写缓存）',
    run: {
      toolUseId: 'demo-codex',
      title: '实现 UsageBoard 单测与类型校验',
      subagentType: 'general-purpose',
      delegate: true,
      model: 'gpt-5.3-codex',
      effort: 'high',
      status: 'done',
      contextWindow: 400_000,
      cache: [
        mkPt({ id: 'c1', input: 18_500, create: 0, read: 0, output: 640, model: 'gpt-5.3-codex', tools: ['ct1'] }),
        mkPt({ id: 'c2', input: 3_200, create: 0, read: 18_500, output: 1_120, model: 'gpt-5.3-codex' }),
        mkPt({ id: 'c3', input: 2_100, create: 0, read: 21_700, output: 880, model: 'gpt-5.3-codex' }),
      ],
      turn: {
        id: 'sub-demo-codex',
        userText: '补充 UsageBoard 和 usageStats 的单元测试',
        attachments: [],
        status: 'done',
        statusText: '',
        steps: [
          { kind: 'tool', id: 'ct1', name: 'Bash', input: { command: 'npm test -w web' }, summary: 'Bash: npm test -w web', result: { content: 'PASS 12 tests', isError: false } },
        ],
        answer: '所有单测已通过。OpenAI / Codex 采用隐式缓存，`create = 0`，占用条展示读缓存与未缓存两段。',
        subagents: [],
        startedAt: nowTs - 68_000,
        endedAt: nowTs - 5_000,
      },
    },
  },
  agy: {
    label: 'Antigravity（估算）',
    run: {
      toolUseId: 'demo-agy',
      title: '探索前端交互动效与布局细节',
      subagentType: 'Explore',
      delegate: true,
      model: 'gemini-4-neon',
      effort: 'low',
      status: 'done',
      contextWindow: 1_000_000,
      cache: [
        mkPt({ id: 'a1', input: 26_000, create: 0, read: 0, output: 450, model: 'gemini-4-neon', estimated: true, tools: ['at1'] }),
        mkPt({ id: 'a2', input: 8_400, create: 0, read: 26_000, output: 720, model: 'gemini-4-neon', estimated: true }),
        mkPt({ id: 'a3', input: 4_100, create: 0, read: 34_400, output: 610, model: 'gemini-4-neon', estimated: true }),
      ],
      turn: {
        id: 'sub-demo-agy',
        userText: '检查 ChartRail 和 ContextPanel 的响应式断点与动画参数',
        attachments: [],
        status: 'done',
        statusText: '',
        steps: [
          { kind: 'tool', id: 'at1', name: 'Read', input: { file_path: 'web/src/ui/context/ChartRail.css' }, summary: 'Read: web/src/ui/context/ChartRail.css', result: { content: '/* ... */', isError: false } },
        ],
        answer: '已完成调研。悬停走势 / 命中率 / 花费图可查看「拆分按本轮合计估算」提示。',
        subagents: [],
        startedAt: nowTs - 29_000,
        endedAt: nowTs - 2_000,
      },
    },
  },
  empty: {
    label: '无数据（运行中）',
    run: {
      toolUseId: 'demo-empty',
      title: '正在初始化代码审查任务',
      subagentType: 'code-reviewer',
      delegate: true,
      background: true,
      model: 'opus',
      effort: 'high',
      status: 'running',
      cache: [],
      turn: {
        id: 'sub-demo-empty',
        userText: '审查本次改动的所有边界条件',
        attachments: [],
        status: 'understanding',
        statusText: '正在理解问题',
        steps: [],
        answer: '',
        subagents: [],
        startedAt: nowTs - 6_000,
      },
    },
    job: {
      toolUseId: 'demo-empty',
      conversationId: 'conv-demo-empty',
      description: '正在初始化代码审查任务',
      background: true,
      state: 'running',
      startedAt: nowTs - 6_000,
      pending: 1,
      tail: '',
    },
  },
};
const devSubagentTypes: SubagentTypeInfo[] = [
  { name: 'Explore', description: 'Fast agent specialized for exploring codebases.', source: 'builtin', readOnly: true, model: 'haiku' },
  { name: 'Plan', description: 'Software architect agent for designing implementation plans.', source: 'builtin', readOnly: true },
  { name: 'general-purpose', description: 'General-purpose agent for complex multi-step tasks.', source: 'builtin' },
  { name: 'code-reviewer', description: '按团队规范审查 PR 变更与边界条件，指出潜在回归、类型问题和性能风险。', source: 'projectSettings', model: 'opus', effort: 'high' },
  { name: 'security-audit', description: '扫描敏感信息、权限绕过与不安全的依赖用法。', source: 'plugin', readOnly: true },
];

function initialSubagents(): SubagentState {
  const accounts: SubagentState['accounts'] = [
    { backend: 'claude', id: 'default', label: 'cosyeey', group: 'claude' },
    { backend: 'claude', id: 'api-1', label: '官方 API', group: 'api' },
    { backend: 'claude', id: 'kiro-1', label: 'Kiro 代理', group: 'kiro' },
    { backend: 'agy', id: 'agy-1', label: 'alex.chen@example.com', group: 'agy' },
    { backend: 'codex', id: 'default', label: 'dev@openai.com', group: 'codex' },
  ];
  const baseConfig: SubagentConfig = {
    ...DEFAULT_SUBAGENTS,
    native: { ...DEFAULT_SUBAGENTS.native, agents: { Explore: { model: 'haiku', effort: 'low' } } },
    delegate: {
      default: { backend: 'claude', accountId: 'default', model: null, effort: null },
      agents: {
        Explore: { backend: 'agy', accountId: 'agy-1', model: 'gemini-4-neon', effort: 'low' },
        'code-reviewer': { backend: 'claude', accountId: 'api-1', model: 'opus', effort: 'high' },
      },
    },
  };
  const common = { accounts, routeFallbacks: {}, agents: devSubagentTypes, disabledAgents: ['security-audit'] };
  if (subMode === 'delegate' || subMode === 'claude') {
    return { config: { ...baseConfig, mode: 'delegate' }, effective: 'delegate', ...common };
  }
  if (subMode === 'agy') {
    return {
      config: {
        ...baseConfig,
        mode: 'delegate',
        delegate: {
          ...baseConfig.delegate,
          default: { backend: 'agy', accountId: 'agy-1', model: 'gemini-4-neon', effort: 'high' },
        },
      },
      effective: 'delegate',
      ...common,
    };
  }
  if (subMode === 'codex') {
    return {
      config: {
        ...baseConfig,
        mode: 'delegate',
        delegate: {
          ...baseConfig.delegate,
          default: { backend: 'codex', accountId: 'default', model: 'gpt-5.3-codex', effort: 'high' },
        },
      },
      effective: 'delegate',
      ...common,
    };
  }
  if (subMode === 'fallback') {
    return {
      config: { ...baseConfig, mode: 'delegate' },
      effective: 'native',
      ...common,
      accounts: [],
      routeFallbacks: { Explore: 'Antigravity 账号未登录' },
      fallbackReason: '默认委派账号未登录',
    };
  }
  return { config: baseConfig, effective: 'native', ...common };
}
const devUsage: ContextUsage = stress
  ? {
      ...mockContextUsage,
      usedTokens: 1_845_200, totalTokens: 2_000_000, percent: 92.26, untilAutocompact: 1_098_400,
      toolTokens: [
        { name: 'Bash', tokens: 12_300, estimated: true },
        { name: 'Read', tokens: 1_200, estimated: true },
        { name: 'mcp__cosyee__delegate', tokens: 920 },
        { name: 'mcp__cosyee__delegate_send', tokens: 680 },
        { name: 'mcp__cosyee__delegate_stop', tokens: 260 },
        { name: 'mcp__cosyee__delegate_result', tokens: 540 },
        { name: 'mcp__cosyee__delegate_agents', tokens: 220, deferred: true, loaded: true },
        { name: 'WebFetch', tokens: 1_850, deferred: true, estimated: true, loaded: true },
        { name: 'Monitor', tokens: 3_850, deferred: true, estimated: true },
      ],
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
  : { ...mockContextUsage, disabledTools: ['WebSearch'] };
const devTools = [
  'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Monitor', 'SendMessage',
  'mcp__cosyee__delegate', 'mcp__cosyee__delegate_send', 'mcp__cosyee__delegate_stop', 'mcp__cosyee__delegate_result', 'mcp__cosyee__delegate_agents',
  'CustomProbe',
];

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
  const [overlayDemo, setOverlayDemo] = useState<OverlayDemoKind | null>(
    overlayParam && overlayParam in OVERLAY_DEMOS ? overlayParam : null,
  );

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
          <ChartRail
            open={ctxCollapsed && !narrow}
            usage={usage}
            cache={devCache}
            turns={devTurns}
            subCosts={devSubCosts}
            subagents={subagents.config}
            subagentAccounts={subagents.accounts}
            billing={devQuery.get('billing') === 'subscription' ? 'subscription' : 'api'}
            pricing={BUILTIN_PRICES}
          />
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
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 6, marginTop: 10 }}>
              {(Object.keys(OVERLAY_DEMOS) as OverlayDemoKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setOverlayDemo(k)}
                  style={{ background: 'var(--bg-elev)', border: '1px solid var(--border)', borderRadius: 'var(--r-sm)', padding: '4px 10px', cursor: 'pointer', color: 'var(--text-2)' }}
                >
                  子代理浮层：{OVERLAY_DEMOS[k].label}
                </button>
              ))}
            </div>
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
          toolStats={stress ? { counts: { Bash: 123_456, Read: 8_921 }, skills: { impeccable: 1_234 }, sessions: 88, at: 0 } : null}
          cache={devCache}
          turns={devTurns}
          subCosts={devSubCosts}
          billing={devQuery.get('billing') === 'subscription' ? 'subscription' : 'api'}
          onOpenSubagent={(_turnId, toolUseId) => {
            const k = (Object.keys(OVERLAY_DEMOS) as OverlayDemoKind[]).find((x) => OVERLAY_DEMOS[x].run.toolUseId === toolUseId);
            if (k) setOverlayDemo(k);
          }}
          subagents={{
            state: subagents,
            onChange: (c: SubagentConfig) =>
              setSubagents((prev) => {
                const def = c.delegate.default;
                const defOk = !!def && prev.accounts.some((a) => a.backend === def.backend && a.id === def.accountId);
                return { ...prev, config: c, effective: c.mode === 'delegate' && defOk ? 'delegate' : 'native' };
              }),
            delegateModels: {
              'agy:agy-1': { list: devDelegate, error: null, loading: false },
              'codex:default': { list: devCodexDelegate, error: null, loading: false },
            },
            onLoadDelegateModels: () => undefined,
            sessionAgents: ['Explore', 'Plan', 'general-purpose', 'statusline-setup', 'fork'],
            onToggleAgent: (name, enabled) =>
              setSubagents((prev) => ({ ...prev, disabledAgents: flip(prev.disabledAgents, name, enabled) })),
            defaultOpen: !!subMode,
          }}
        />
      }
    />
    <SubagentOverlay
      run={overlayDemo ? OVERLAY_DEMOS[overlayDemo].run : null}
      onClose={() => setOverlayDemo(null)}
      subagents={{
        ...subagents.config,
        delegate: {
          ...subagents.config.delegate,
          agents: {
            ...subagents.config.delegate.agents,
            'general-purpose': { backend: 'codex', accountId: 'default', model: 'gpt-5.3-codex', effort: 'high' },
          },
        },
      }}
      subagentAccounts={subagents.accounts}
      sessionBilling="subscription"
      pricing={BUILTIN_PRICES}
      delegates={overlayDemo && OVERLAY_DEMOS[overlayDemo].job ? [OVERLAY_DEMOS[overlayDemo].job!] : []}
      onDelegateStop={(id) => console.info('[dev] stop delegate', id)}
    />
    </FilesContext.Provider>
    </SessionDetailContext.Provider>
  );
}
