// 外壳组件的 mock 数据（仅 dev 页使用）。时间相对"现在"生成，保证今天/昨天/本年/去年始终都有。
import type { Account, ContextUsage, DeletedSession, SessionDetail, SessionSummary, Workspace } from '@cosyee/shared';

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
  const mk = (
    id: string,
    title: string,
    lastActiveAt: number,
    dot: SessionSummary['dot'],
    extra: Partial<SessionSummary> = {},
  ): SessionSummary => ({
    id,
    cwd,
    title,
    lastActiveAt,
    dot,
    pinned: null,
    ...extra,
  });
  return [
    mk('s1', '实现左侧栏与工作空间切换', now - 2 * MIN, 'running', {
      config: { model: 'opus', effort: 'high' },
      account: '工作',
    }),
    mk('s2', '修复上下文面板的百分比计算', now - 35 * MIN, 'unread', {
      lastModel: 'claude-sonnet-5-5-20260101',
    }),
    mk('s3', '重构 WebSocket 重连逻辑并补充单元测试，处理断线后的会话订阅恢复', now - 3 * HOUR, null, {
      config: { model: 'sonnet', effort: 'medium' },
    }),
    mk('s4', '梳理 stream-json 事件格式', startOfToday - 2 * HOUR, 'unread'),
    mk('s5', '子代理浮层设计讨论', startOfToday - 20 * HOUR, null, {
      lastModel: 'claude-opus-4-8',
    }),
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
  agentDescriptions: {
    Explore: 'Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns, search code for keywords, or answer questions about the codebase.',
    Plan: 'Software architect agent for designing implementation plans.',
  },
  skills: [
    { name: 'anthropic-skills:docx', mode: 'on', tokens: 210, source: 'syncedSkills', description: 'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx files). Triggers include any mention of "Word doc", "word document", ".docx", or requests to produce professional documents with formatting like tables of contents, headings, page numbers, or letterheads.' },
    { name: 'impeccable', mode: 'on', tokens: 67, source: 'userSettings', removable: true, onDisk: true, description: 'Polish UI details until they feel inevitable.' },
    { name: 'anthropic-skills:pdf', mode: 'on', tokens: 180, source: 'syncedSkills' },
    { name: 'schedule', mode: 'user-invocable-only', tokens: null, source: null, description: 'Create, update, list, or run scheduled remote agents (routines) that execute on a cron schedule.' },
    { name: 'anthropic-skills:xlsx', mode: 'off', tokens: null, source: 'plugin', onDisk: true },
  ],
  mcpServers: [
    {
      name: 'claude.ai Claude Docs',
      status: 'connected',
      tokens: 3_010,
      tools: [
        { name: 'batch', tokens: 1_480, description: 'Run several documentation lookups in one call and return the merged results.' },
        { name: 'guide', tokens: 620 },
        { name: 'update', tokens: 910 },
      ],
    },
    {
      name: 'playwright',
      status: 'connected',
      tokens: 1_270,
      tools: [
        { name: 'browser_click', tokens: 540, description: 'Perform click on a web page' },
        { name: 'browser_navigate', tokens: 380 },
        { name: 'browser_snapshot', tokens: 350 },
      ],
    },
    { name: 'github', status: 'disabled', tokens: 0, tools: [] },
    { name: 'linear', status: 'needs-auth', tokens: 0, tools: [] },
    {
      name: 'cosyee',
      status: 'connected',
      tokens: 2_620,
      tools: [
        {
          name: 'delegate',
          tokens: 920,
          description: 'Launch a delegate agent on a self-contained task in the same directory. It can read and edit files and run commands there.\n\ninput_schema: {\n  "type": "object",\n  "required": ["description", "prompt"]\n}',
        },
        { name: 'delegate_send', tokens: 680 },
        { name: 'delegate_stop', tokens: 260 },
        { name: 'delegate_result', tokens: 540 },
        { name: 'delegate_agents', tokens: 220 },
      ],
    },
  ],
  toolLoadSource: 'session',
  toolLoad: {
    Bash: { load: 'resident', source: 'session' },
    Read: { load: 'resident', source: 'session' },
    Edit: { load: 'resident', source: 'session' },
    Write: { load: 'resident', source: 'session' },
    Glob: { load: 'resident', source: 'session' },
    Grep: { load: 'resident', source: 'session' },
    mcp__cosyee__delegate: { load: 'resident', source: 'session' },
    mcp__cosyee__delegate_send: { load: 'resident', source: 'session' },
    mcp__cosyee__delegate_stop: { load: 'resident', source: 'session' },
    mcp__cosyee__delegate_result: { load: 'resident', source: 'session' },
    mcp__cosyee__delegate_agents: { load: 'deferred', loaded: true, source: 'session' },
    WebFetch: { load: 'deferred', loaded: true, source: 'session' },
    SendMessage: { load: 'deferred', loaded: true, source: 'session' },
    Monitor: { load: 'deferred', source: 'session' },
    WebSearch: { load: 'deferred', source: 'cache' },
    CustomProbe: { load: 'unknown' },
  },
  // 常驻合计：7,400（内置估算）+ 2,400（delegate + send/stop/result 精确值）= 9,800 = System tools
  // 懒加载合计：5,480（内置估算）+ 220（delegate_agents 精确值）= 5,700 = System tools (deferred)
  toolTokens: [
    { name: 'Bash', tokens: 2_600, estimated: true },
    { name: 'Read', tokens: 1_230, estimated: true },
    { name: 'Edit', tokens: 620, estimated: true },
    { name: 'Write', tokens: 410, estimated: true },
    { name: 'Glob', tokens: 470, estimated: true },
    { name: 'Grep', tokens: 2_070, estimated: true },
    { name: 'mcp__cosyee__delegate', tokens: 920 },
    { name: 'mcp__cosyee__delegate_send', tokens: 680 },
    { name: 'mcp__cosyee__delegate_stop', tokens: 260 },
    { name: 'mcp__cosyee__delegate_result', tokens: 540 },
    { name: 'mcp__cosyee__delegate_agents', tokens: 220, deferred: true, loaded: true },
    { name: 'WebFetch', tokens: 590, deferred: true, estimated: true, loaded: true },
    { name: 'Monitor', tokens: 2_790, deferred: true, estimated: true },
    { name: 'SendMessage', tokens: 2_100, deferred: true, estimated: true, loaded: true },
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
      config: { model: 'fable', effort: 'xhigh' },
      account: '个人',
    },
    {
      id: 's1',
      cwd: mockWorkspaces[0].path,
      title: '实现左侧栏与工作空间切换',
      lastActiveAt: now - 2 * MIN,
      dot: 'running',
      pinned: 'auto',
      config: { model: 'opus', effort: 'high' },
      account: '工作',
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

/**
 * 调试页用的会话详情假数据（首次请求模拟 900ms 延迟，供观察骨架与平滑高度过渡）：
 * - s4：模拟读取失败
 * - s3：超长内容（含最初 / 最近消息 / 最近回复 / 长分支名 / 大上下文）
 * - s5：仅一条消息（lastPrompt 为 null）
 */
export function mockSessionDetail(id: string, _cwd: string): Promise<SessionDetail> {
  const baseId = id.split('@')[0]!;
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      const now = Date.now();
      if (baseId === 's4') {
        reject(new Error('模拟详情读取失败'));
        return;
      }
      if (baseId === 's3') {
        resolve({
          createdAt: now - 14 * HOUR,
          lastMessageAt: now - 3 * HOUR,
          userMessages: 27,
          toolCalls: 94,
          firstPrompt: '帮我把前端 WebSocket 客户端的断线重连逻辑梳理一遍，重点检查重连之后已经订阅的多个会话如何重新补发 subscribe、以及断线期间排队的 send 消息会不会重复发送。',
          lastPrompt: '现在单测跑通了，但还有一个边界场景：如果服务端在握手完成前主动断开连接，指数退避计时器在页面卸载或切换账号重载时是否需要显式清理，顺便把重连横幅和会话列表刷新时序也一起验证一下。',
          lastReply: '已经把 Socket.onReconnect 的订阅重放和退避计时器清理全部重构完成，并在 reducer.test.ts 中补充了 8 条断线重连与并发订阅恢复的用例。所有断言均已通过，断线期间只会缓存非订阅类消息，重连成功后按 subs 集合幂等补发。',
          model: 'claude-sonnet-5-5-20260101',
          branch: 'feat/ws-reconnect-and-session-subscription-recovery',
          contextTokens: 148_600,
        });
        return;
      }
      if (baseId === 's5') {
        resolve({
          createdAt: now - 24 * HOUR,
          lastMessageAt: now - 20 * HOUR,
          userMessages: 1,
          toolCalls: 4,
          firstPrompt: '帮我评估一下把子代理详情做成右侧抽屉还是居中浮层，哪个更适合多层级工具输出浏览？',
          lastPrompt: null,
          lastReply: '建议采用居中磨砂浮层并保留原位展开动效：当左侧栏与右侧上下文面板同时打开时，中间留给会话流的宽度有限，浮层能提供更宽敞的代码块与 diff 阅读空间。',
          model: 'claude-opus-4-8',
          branch: 'main',
          contextTokens: 32_400,
        });
        return;
      }
      if (baseId === 'p1') {
        resolve({
          createdAt: now - 30 * HOUR,
          lastMessageAt: now - 5 * HOUR,
          userMessages: 11,
          toolCalls: 29,
          firstPrompt: '核对 Tailscale MagicDNS 短主机名和局域网 IP 访问时的 Origin 校验白名单逻辑。',
          lastPrompt: '再确认一下桌面版 Electron 与 Tauri 发起请求时没有 Origin 头或 origin 为 null 的情况。',
          lastReply: '已核对完毕：本机回环与 Tailscale 主机名统一走白名单校验，无 Origin 头仅在携带有效 token 的非浏览器客户端放行，并补充了 6 个边界单测。',
          model: 'claude-fable-5-2',
          branch: 'fix/origin-tailscale-short-host',
          contextTokens: 64_800,
        });
        return;
      }
      if (baseId === 'd1' || baseId === 'd2' || baseId === 'd3') {
        resolve({
          createdAt: now - 5 * 24 * HOUR,
          lastMessageAt: now - 4 * HOUR,
          userMessages: 5,
          toolCalls: 12,
          firstPrompt: '试一下流式 Markdown 渲染在高频 delta 推送下是否会掉帧。',
          lastPrompt: '把实验代码先删掉，方案已经验证通过。',
          lastReply: '已整理好基准测试数据：合帧刷新可将高频推送时的重排次数降低约 70%。',
          model: 'claude-haiku-5-5',
          branch: baseId === 'd3' ? null : 'exp/stream-md',
          contextTokens: 18_900,
        });
        return;
      }
      resolve({
        createdAt: now - 4 * HOUR,
        lastMessageAt: now - 2 * MIN,
        userMessages: 14,
        toolCalls: 38,
        firstPrompt: '把侧栏的工作空间分组和置顶区重新排一下，置顶会话不要在下面重复出现。',
        lastPrompt: '现在把会话悬浮卡片加上，侧栏悬停时显示最近消息、模型、分支和上下文占用。',
        lastReply: '已完成侧栏与头部共用的悬浮卡片控制器，支持 400ms 冷打开、70ms 温切换以及平滑位移和高度过渡。',
        model: baseId === 's2' ? 'claude-sonnet-5-5-20260101' : 'claude-opus-5-5',
        branch: 'main',
        contextTokens: baseId === 's1' ? 86_400 : 45_200,
      });
    }, 900);
  });
}
