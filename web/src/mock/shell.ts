// 外壳组件的 mock 数据（仅 dev 页使用）。时间相对"现在"生成，保证今天/昨天/本年/去年始终都有。
import type { Account, ContextUsage, DeletedSession, SessionSummary, Workspace } from '@cosyee/shared';

export const mockWorkspaces: Workspace[] = [
  { path: 'F:\\Cosyee', name: 'Cosyee' },
  { path: 'F:\\Projects\\a-very-long-workspace-folder-name-for-ellipsis-test', name: 'a-very-long-workspace-folder-name-for-ellipsis-test' },
  { path: 'D:\\work\\axiom', name: 'axiom' },
  { path: 'C:\\Users\\dane\\Documents\\notes', name: 'notes' },
];

/** 非 git 仓库的工作空间路径（dev 页据此隐藏分支行） */
export const mockNonGitPaths = ['C:\\Users\\dane\\Documents\\notes'];

const MIN = 60_000;
const HOUR = 60 * MIN;

function buildSessions(cwd: string): SessionSummary[] {
  const now = Date.now();
  const d = new Date(now);
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const year = d.getFullYear();
  const mk = (id: string, title: string, lastActiveAt: number, dot: SessionSummary['dot']): SessionSummary => ({
    id,
    cwd,
    title,
    lastActiveAt,
    dot,
    pinned: null,
  });
  return [
    mk('s1', '实现左侧栏与工作空间切换', now - 2 * MIN, 'running'),
    mk('s2', '修复上下文面板的百分比计算', now - 35 * MIN, 'unread'),
    mk('s3', '重构 WebSocket 重连逻辑并补充单元测试，处理断线后的会话订阅恢复', now - 3 * HOUR, null),
    mk('s4', '梳理 stream-json 事件格式', startOfToday - 2 * HOUR, 'unread'),
    mk('s5', '子代理浮层设计讨论', startOfToday - 20 * HOUR, null),
    mk('s6', '输入框标签的光标定位问题', new Date(year, 5, 12, 10, 20).getTime(), null),
    mk('s7', '后端鉴权与 Origin 校验', new Date(year, 2, 3, 16, 45).getTime(), null),
    mk('s8', '', new Date(year, 0, 2, 9, 5).getTime(), null),
    mk('s9', '初始化 monorepo 骨架', new Date(year - 1, 10, 28, 21, 0).getTime(), null),
    mk('s10', 'Windows 文件选择窗口混选调研', new Date(year - 1, 6, 9, 13, 30).getTime(), null),
  ];
}

export function mockSessionsFor(cwd: string): SessionSummary[] {
  // 非第一个工作空间只给少量会话，便于看到列表切换效果
  const all = buildSessions(cwd);
  return cwd === mockWorkspaces[0].path ? all : all.slice(2, 6).map((s) => ({ ...s, id: `${s.id}@${cwd}` }));
}

export const mockAccount: Account = { name: 'Dane', plan: 'Max' };

export const mockContextUsage: ContextUsage = {
  usedTokens: 45_200,
  totalTokens: 200_000,
  percent: 22.6,
  categories: [
    { name: 'System prompt', tokens: 3_200, percent: 1.6 },
    { name: 'System tools', tokens: 9_800, percent: 4.9 },
    { name: 'MCP tools', tokens: 6_400, percent: 3.2 },
    { name: 'Custom agents', tokens: 1_100, percent: 0.6 },
    { name: 'Skills', tokens: 2_300, percent: 1.2 },
    { name: 'MCP server instructions', tokens: 800, percent: 0.4 },
    { name: 'Messages', tokens: 21_600, percent: 10.8 },
    { name: 'Autocompact buffer', tokens: 33_000, percent: 16.5 },
    { name: 'Free space', tokens: 121_800, percent: 60.9 },
  ],
  deferred: [
    { name: 'MCP tools (deferred)', tokens: 14_300 },
    { name: 'System tools (deferred)', tokens: 5_700 },
  ],
  mcpTools: [
    { name: 'mcp__claude_ai_Claude_Docs__batch', server: 'claude_ai_Claude_Docs', tokens: 1_480 },
    { name: 'mcp__claude_ai_Claude_Docs__guide', server: 'claude_ai_Claude_Docs', tokens: 620 },
    { name: 'mcp__claude_ai_Claude_Docs__update', server: 'claude_ai_Claude_Docs', tokens: 910 },
    { name: 'mcp__playwright__browser_click', server: 'playwright', tokens: 540 },
    { name: 'mcp__playwright__browser_navigate', server: 'playwright', tokens: 380 },
    { name: 'mcp__playwright__browser_snapshot', server: 'playwright', tokens: 350 },
  ],
  agents: [
    { name: 'Explore', tokens: 420 },
    { name: 'Plan', tokens: 380 },
    { name: 'general-purpose', tokens: 300 },
  ],
  skills: [
    { name: 'anthropic-skills:docx', mode: 'on', tokens: 210, source: 'syncedSkills' },
    { name: 'impeccable', mode: 'on', tokens: 67, source: 'userSettings' },
    { name: 'anthropic-skills:pdf', mode: 'on', tokens: 180, source: 'syncedSkills' },
    { name: 'schedule', mode: 'user-invocable-only', tokens: null, source: null },
    { name: 'anthropic-skills:xlsx', mode: 'off', tokens: null, source: 'plugin' },
  ],
  mcpServers: [
    {
      name: 'claude.ai Claude Docs',
      status: 'connected',
      tokens: 3_010,
      tools: [
        { name: 'batch', tokens: 1_480 },
        { name: 'guide', tokens: 620 },
        { name: 'update', tokens: 910 },
      ],
    },
    {
      name: 'playwright',
      status: 'connected',
      tokens: 1_270,
      tools: [
        { name: 'browser_click', tokens: 540 },
        { name: 'browser_navigate', tokens: 380 },
        { name: 'browser_snapshot', tokens: 350 },
      ],
    },
    { name: 'github', status: 'disabled', tokens: 0, tools: [] },
    { name: 'linear', status: 'needs-auth', tokens: 0, tools: [] },
  ],
  untilAutocompact: 98_400,
  at: Date.now(),
};

/** 置顶的 mock：一个手动置顶（来自别的工作空间）、一个自动置顶（正在执行） */
export function mockPinned(): SessionSummary[] {
  const now = Date.now();
  return [
    {
      id: 'p1@axiom',
      cwd: mockWorkspaces[2].path,
      title: '审查 Origin 校验的边界情况',
      lastActiveAt: now - 5 * HOUR,
      dot: null,
      pinned: 'manual',
    },
    {
      id: 's1',
      cwd: mockWorkspaces[0].path,
      title: '实现左侧栏与工作空间切换',
      lastActiveAt: now - 2 * MIN,
      dot: 'running',
      pinned: 'auto',
    },
  ];
}

/** 已删除的 mock（全局） */
export function mockDeleted(): DeletedSession[] {
  const now = Date.now();
  return [
    { id: 'd1', cwd: mockWorkspaces[0].path, title: '临时试验：流式渲染', deletedAt: now - 3 * HOUR },
    { id: 'd2', cwd: mockWorkspaces[2].path, title: '', deletedAt: now - 26 * HOUR },
    { id: 'd3', cwd: mockWorkspaces[3].path, title: '整理读书笔记的目录结构', deletedAt: now - 4 * 24 * HOUR },
  ];
}
