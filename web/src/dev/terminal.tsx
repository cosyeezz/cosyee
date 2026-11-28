// 内置终端独立调试页（?dev=terminal）：纯内存 mock，支持单标签、多标签、满额、改名、关闭确认、亮暗主题与窄屏验收截图。
// 参数：?dev=terminal&theme=dark|light&scenario=default|tabs|tabs-full|tabs-rename|tabs-confirm|tabs-limit|history|stdin|empty|reconnecting&narrow=1
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  TERM_TAB_LIMIT,
  TERM_TAB_NAME_MAX,
  type TermBlock,
  type TermShell,
  type TermSnapshot,
  type TermTabInfo,
} from '@cosyee/shared';
import {
  reorderTabs,
  TERM_LIMIT_NOTICE,
  type TerminalActions,
  type TerminalConnState,
  type TerminalController,
  type TerminalTabsController,
} from '../core/terminal';
import { AppShell } from '../ui/layout/AppShell';
import { SessionHeader } from '../ui/header/SessionHeader';
import { TerminalPanel } from '../ui/terminal/TerminalPanel';

const FIXED_NOW = 1_732_700_062_400;
const ROOT = 'F:\\Cosyee';

const SHELLS = [
  { id: 'pwsh' as const, label: 'PowerShell 7' },
  { id: 'powershell' as const, label: 'Windows PowerShell' },
  { id: 'cmd' as const, label: '命令提示符' },
  { id: 'gitbash' as const, label: 'Git Bash' },
];

const ANSI_DEMO_OUT = [
  '\x1b[1;36m  VITE v6.0.3\x1b[0m  \x1b[32mready in 312 ms\x1b[0m',
  '',
  '  \x1b[32m➜\x1b[0m  \x1b[1mLocal:\x1b[0m   http://127.0.0.1:5273/',
  '  \x1b[2m➜  Network: use --host to expose\x1b[0m',
  '\x1b[33mwarn\x1b[0m \x1b[3mchunk size\x1b[0m \x1b[4moptimization\x1b[0m \x1b[7m INVERSE \x1b[0m \x1b[38;5;208m256-color\x1b[0m \x1b[38;2;120;210;255mtruecolor\x1b[0m',
  'Building bundle 12%...\rBuilding bundle 64%...\r\x1b[32m✓\x1b[0m Building bundle 100% (48 modules)',
].join('\n');

const LONG_TRUNC_OUT = [
  '\x1b[2m... (previous 240KB omitted) ...\x1b[0m',
  '  \x1b[32m✓\x1b[0m src/core/terminalAnsi.test.ts \x1b[2m(7 tests) 14ms\x1b[0m',
  '  \x1b[32m✓\x1b[0m src/core/terminal.test.ts \x1b[2m(4 tests) 9ms\x1b[0m',
  '  \x1b[32m✓\x1b[0m src/ui/terminal/TerminalPanel.test.tsx \x1b[2m(3 tests) 68ms\x1b[0m',
  '',
  ' \x1b[1;32mTest Files\x1b[0m  \x1b[1m42 passed\x1b[0m (42)',
  '      \x1b[1;32mTests\x1b[0m  \x1b[1m318 passed\x1b[0m (318)',
].join('\n');

const FAIL_OUT = [
  '\x1b[31merror TS2345:\x1b[0m Argument of type \x1b[33m\'string | null\'\x1b[0m is not assignable to parameter of type \x1b[33m\'string\'\x1b[0m.',
  '  \x1b[2msrc/ui/terminal/TerminalPanel.tsx:142:18\x1b[0m',
].join('\n');

const SAMPLE_HISTORY = [
  'git status -sb',
  'git log --oneline -n 10',
  'npm run typecheck -w web',
  'npm run test -w web',
  'npm run dev -w web',
  'node --version && npm --version',
  'cd web && npx vitest run src/core/terminalAnsi.test.ts',
];

interface MockTabEntry {
  tab: TermTabInfo;
  blocks: TermBlock[];
}

function makeSampleBlocks(): TermBlock[] {
  return [
    {
      id: 'b-fail',
      cmd: 'npm run typecheck -w web',
      cwd: ROOT,
      shell: 'pwsh',
      startedAt: FIXED_NOW - 120_000,
      endedAt: FIXED_NOW - 117_200,
      exitCode: 2,
      state: 'done',
      output: FAIL_OUT,
    },
    {
      id: 'b-stopped',
      cmd: 'npm run watch -- --filter=@cosyee/web --verbose',
      cwd: 'F:\\Cosyee\\web',
      shell: 'gitbash',
      startedAt: FIXED_NOW - 80_000,
      endedAt: FIXED_NOW - 68_400,
      exitCode: null,
      state: 'stopped',
      output: '\x1b[36m[watch]\x1b[0m watching 128 files for changes…\n\x1b[33m^C received, shutting down\x1b[0m',
    },
    {
      id: 'b-trunc',
      cmd: 'npm run test -w web',
      cwd: 'F:\\Cosyee\\web',
      shell: 'pwsh',
      startedAt: FIXED_NOW - 40_000,
      endedAt: FIXED_NOW - 34_600,
      exitCode: 0,
      state: 'done',
      output: LONG_TRUNC_OUT,
      truncated: true,
    },
    {
      id: 'b-run',
      cmd: 'npm run dev -w web',
      cwd: 'F:\\Cosyee\\web\\src\\ui\\terminal',
      shell: 'pwsh',
      startedAt: FIXED_NOW - 14_300,
      state: 'running',
      output: ANSI_DEMO_OUT,
    },
  ];
}

function buildInitial(scenario: string): {
  entries: MockTabEntry[];
  activeId: string;
  connState: TerminalConnState;
  error: string | null;
  notice: string | null;
} {
  if (scenario === 'empty') {
    return {
      entries: [
        {
          tab: { id: 'tab-1', cwd: ROOT, shell: 'pwsh', status: 'idle', createdAt: FIXED_NOW - 60_000 },
          blocks: [],
        },
      ],
      activeId: 'tab-1',
      connState: 'open',
      error: null,
      notice: null,
    };
  }

  if (scenario === 'reconnecting') {
    return {
      entries: [
        {
          tab: { id: 'tab-1', cwd: ROOT, shell: 'pwsh', status: 'idle', createdAt: FIXED_NOW - 60_000 },
          blocks: [
            {
              id: 'b-ok',
              cmd: 'git status -sb',
              cwd: ROOT,
              shell: 'pwsh',
              startedAt: FIXED_NOW - 45_000,
              endedAt: FIXED_NOW - 44_780,
              exitCode: 0,
              state: 'done',
              output: '\x1b[32m## main...origin/main\x1b[0m\n \x1b[33mM\x1b[0m web/src/app/MainApp.tsx\n',
            },
          ],
        },
      ],
      activeId: 'tab-1',
      connState: 'reconnecting',
      error: null,
      notice: null,
    };
  }

  if (scenario === 'default' || scenario === 'history' || scenario === 'stdin') {
    return {
      entries: [
        {
          tab: {
            id: 'tab-1',
            cwd: 'F:\\Cosyee\\web\\src\\ui\\terminal',
            shell: 'pwsh',
            status: 'running',
            runningCmd: 'npm run dev -w web',
            createdAt: FIXED_NOW - 120_000,
          },
          blocks: makeSampleBlocks(),
        },
      ],
      activeId: 'tab-1',
      connState: 'open',
      error: null,
      notice: null,
    };
  }

  // 多标签基础集合（涵盖运行中、失败、自定义名、超长名）
  const multi: MockTabEntry[] = [
    {
      tab: {
        id: 'tab-dev',
        cwd: 'F:\\Cosyee\\web',
        shell: 'pwsh',
        status: 'running',
        runningCmd: 'npm run dev -w web',
        createdAt: FIXED_NOW - 240_000,
      },
      blocks: [
        {
          id: 'b-dev',
          cmd: 'npm run dev -w web',
          cwd: 'F:\\Cosyee\\web',
          shell: 'pwsh',
          startedAt: FIXED_NOW - 14_300,
          state: 'running',
          output: ANSI_DEMO_OUT,
        },
      ],
    },
    {
      tab: {
        id: 'tab-check',
        cwd: 'F:\\Cosyee\\web',
        shell: 'pwsh',
        status: 'failed',
        createdAt: FIXED_NOW - 180_000,
      },
      blocks: [
        {
          id: 'b-tc',
          cmd: 'npm run typecheck -w web',
          cwd: 'F:\\Cosyee\\web',
          shell: 'pwsh',
          startedAt: FIXED_NOW - 30_000,
          endedAt: FIXED_NOW - 27_400,
          exitCode: 2,
          state: 'done',
          output: FAIL_OUT,
        },
      ],
    },
    {
      tab: {
        id: 'tab-api',
        name: '后端日志',
        cwd: 'F:\\Cosyee\\server',
        shell: 'gitbash',
        status: 'running',
        runningCmd: 'node --watch dist/index.js',
        createdAt: FIXED_NOW - 120_000,
      },
      blocks: [
        {
          id: 'b-api',
          cmd: 'node --watch dist/index.js',
          cwd: 'F:\\Cosyee\\server',
          shell: 'gitbash',
          startedAt: FIXED_NOW - 90_000,
          state: 'running',
          output: '\x1b[32m[server]\x1b[0m listening on http://127.0.0.1:7878\n\x1b[2m[ws] terminal session attached\x1b[0m\n',
        },
      ],
    },
    {
      tab: {
        id: 'tab-long',
        name: '超长自定义标签名测试-生产环境灰度发布日志监控终端',
        cwd: 'F:\\Cosyee\\web\\src\\ui\\terminal',
        shell: 'pwsh',
        status: 'idle',
        createdAt: FIXED_NOW - 60_000,
      },
      blocks: [
        {
          id: 'b-git',
          cmd: 'git status -sb',
          cwd: 'F:\\Cosyee\\web\\src\\ui\\terminal',
          shell: 'pwsh',
          startedAt: FIXED_NOW - 10_000,
          endedAt: FIXED_NOW - 9_820,
          exitCode: 0,
          state: 'done',
          output: '\x1b[32m## main...origin/main\x1b[0m\n \x1b[33mM\x1b[0m web/src/ui/terminal/TerminalPanel.tsx\n',
        },
      ],
    },
  ];

  if (scenario === 'tabs-full' || scenario === 'tabs-limit') {
    const extra: MockTabEntry[] = [
      {
        tab: { id: 'tab-5', name: '单测监听', cwd: 'F:\\Cosyee\\web', shell: 'pwsh', status: 'running', runningCmd: 'npx vitest --watch', createdAt: FIXED_NOW - 50_000 },
        blocks: [],
      },
      {
        tab: { id: 'tab-6', cwd: 'F:\\Cosyee\\shared', shell: 'cmd', status: 'idle', createdAt: FIXED_NOW - 40_000 },
        blocks: [],
      },
      {
        tab: { id: 'tab-7', name: '构建产物检查', cwd: 'F:\\Cosyee\\client', shell: 'gitbash', status: 'failed', createdAt: FIXED_NOW - 30_000 },
        blocks: [],
      },
      {
        tab: { id: 'tab-8', name: 'SQLite 查询', cwd: 'F:\\Cosyee', shell: 'pwsh', status: 'idle', createdAt: FIXED_NOW - 20_000 },
        blocks: [],
      },
    ];
    return {
      entries: [...multi, ...extra],
      activeId: 'tab-dev',
      connState: 'open',
      error: null,
      notice: scenario === 'tabs-limit' ? TERM_LIMIT_NOTICE : null,
    };
  }

  return {
    entries: multi,
    activeId: scenario === 'tabs-rename' ? 'tab-api' : 'tab-dev',
    connState: 'open',
    error: null,
    notice: null,
  };
}

export default function TerminalDevPage() {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const scenario = params.get('scenario') ?? 'tabs';
  const forceNarrow = params.get('narrow') === '1';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const init = useMemo(() => buildInitial(scenario), [scenario]);
  const [entries, setEntries] = useState<MockTabEntry[]>(init.entries);
  const [activeId, setActiveId] = useState<string>(init.activeId);
  const [history, setHistory] = useState<string[]>(SAMPLE_HISTORY);
  const [notice, setNotice] = useState<string | null>(init.notice);
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(440);

  const activeEntry = useMemo(
    () => entries.find((e) => e.tab.id === activeId) ?? entries[0],
    [entries, activeId],
  );

  const tabs = useMemo(() => entries.map((e) => e.tab), [entries]);

  const activeSnap: TermSnapshot | null = useMemo(() => {
    if (!activeEntry) return null;
    return {
      id: activeEntry.tab.id,
      root: ROOT,
      tabs,
      cwd: activeEntry.tab.cwd,
      shell: activeEntry.tab.shell,
      shells: SHELLS,
      platform: 'win32',
      blocks: activeEntry.blocks,
      history,
    };
  }, [activeEntry, tabs, history]);

  const actions = useMemo<TerminalActions>(
    () => ({
      run: (cmd) => {
        if (!activeEntry) return null;
        const id = `mock-${Date.now()}`;
        const block: TermBlock = {
          id,
          cmd,
          cwd: activeEntry.tab.cwd,
          shell: activeEntry.tab.shell,
          startedAt: Date.now(),
          endedAt: Date.now() + 180,
          exitCode: 0,
          state: 'done',
          output: `\x1b[32m✓\x1b[0m 已在预览模式执行: ${cmd}\n`,
        };
        setEntries((list) =>
          list.map((e) =>
            e.tab.id === activeEntry.tab.id ? { ...e, blocks: [...e.blocks, block] } : e,
          ),
        );
        setHistory((h) => [...h.filter((x) => x !== cmd.trim()), cmd.trim()]);
        return id;
      },
      sendStdin: (id, data) => {
        if (!activeEntry) return;
        setEntries((list) =>
          list.map((e) =>
            e.tab.id === activeEntry.tab.id
              ? {
                  ...e,
                  blocks: e.blocks.map((b) =>
                    b.id === id ? { ...b, output: `${b.output}\n\x1b[36m[stdin]\x1b[0m ${data}` } : b,
                  ),
                }
              : e,
          ),
        );
      },
      stop: (id) => {
        if (!activeEntry) return;
        setEntries((list) =>
          list.map((e) => {
            if (e.tab.id !== activeEntry.tab.id) return e;
            const blocks = e.blocks.map((b) =>
              b.id === id ? { ...b, state: 'stopped' as const, endedAt: FIXED_NOW, exitCode: null } : b,
            );
            const stillRunning = blocks.find((b) => b.state === 'running');
            return {
              tab: {
                ...e.tab,
                status: stillRunning ? 'running' : 'idle',
                runningCmd: stillRunning?.cmd,
              },
              blocks,
            };
          }),
        );
      },
      clear: () => {
        if (!activeEntry) return;
        setEntries((list) =>
          list.map((e) =>
            e.tab.id === activeEntry.tab.id
              ? { ...e, blocks: e.blocks.filter((b) => b.state === 'running') }
              : e,
          ),
        );
      },
      setShell: (shell: TermShell) => {
        if (!activeEntry) return;
        setEntries((list) =>
          list.map((e) =>
            e.tab.id === activeEntry.tab.id ? { ...e, tab: { ...e.tab, shell } } : e,
          ),
        );
      },
      resetCwd: () => {
        if (!activeEntry) return;
        setEntries((list) =>
          list.map((e) =>
            e.tab.id === activeEntry.tab.id ? { ...e, tab: { ...e.tab, cwd: ROOT } } : e,
          ),
        );
      },
      removeHistory: (cmd) => {
        setHistory((h) => h.filter((x) => x !== cmd));
      },
      clearHistory: () => {
        setHistory([]);
      },
      reconnect: () => {},
    }),
    [activeEntry],
  );

  const current: TerminalController = useMemo(
    () => ({
      state: { root: ROOT, connState: init.connState, error: init.error, snapshot: activeSnap },
      actions,
    }),
    [init.connState, init.error, activeSnap, actions],
  );

  const tabsController: TerminalTabsController = useMemo(
    () => ({
      tabs,
      activeId: activeEntry?.tab.id ?? null,
      notice,
      clearNotice: () => setNotice(null),
      current,
      selectTab: (id) => setActiveId(id),
      newTab: () => {
        if (entries.length >= TERM_TAB_LIMIT) {
          setNotice(TERM_LIMIT_NOTICE);
          return null;
        }
        const id = `tab-new-${Date.now()}`;
        const nextEntry: MockTabEntry = {
          tab: { id, cwd: ROOT, shell: activeEntry?.tab.shell ?? 'pwsh', status: 'idle', createdAt: Date.now() },
          blocks: [],
        };
        setEntries((list) => [...list, nextEntry]);
        setActiveId(id);
        setNotice(null);
        return id;
      },
      closeTab: (id) => {
        const closedLast = entries.length <= 1;
        if (closedLast) {
          const freshId = `tab-fresh-${Date.now()}`;
          setEntries([
            {
              tab: { id: freshId, cwd: ROOT, shell: 'pwsh', status: 'idle', createdAt: Date.now() },
              blocks: [],
            },
          ]);
          setActiveId(freshId);
          return { closedLast: true };
        }
        const idx = entries.findIndex((e) => e.tab.id === id);
        const nextList = entries.filter((e) => e.tab.id !== id);
        setEntries(nextList);
        if (activeId === id) {
          const pick = nextList[Math.min(Math.max(0, idx), nextList.length - 1)] ?? nextList[0];
          if (pick) setActiveId(pick.tab.id);
        }
        return { closedLast: false };
      },
      renameTab: (id, name) => {
        const trimmed = name.trim().slice(0, TERM_TAB_NAME_MAX);
        setEntries((list) =>
          list.map((e) =>
            e.tab.id === id ? { ...e, tab: { ...e.tab, name: trimmed || undefined } } : e,
          ),
        );
      },
      moveTab: (id, toIndex) => {
        setEntries((list) => {
          const orderedTabs = reorderTabs(list.map((e) => e.tab), id, toIndex);
          const map = new Map(list.map((e) => [e.tab.id, e]));
          return orderedTabs.map((t) => map.get(t.id)!).filter(Boolean);
        });
      },
    }),
    [tabs, activeEntry, notice, current, entries, activeId],
  );

  const toggleOpen = useCallback(() => setOpen((o) => !o), []);

  return (
    <AppShell
      narrow={forceNarrow}
      sidebarCollapsed={forceNarrow}
      contextCollapsed={forceNarrow}
      onToggleSidebar={() => {}}
      onToggleContext={() => {}}
      sidebar={
        <div style={{ padding: 16, fontSize: 13, color: 'var(--text-3)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 12 }}>Cosyee 工作空间</div>
          <div>内置终端设计预览</div>
          <div style={{ marginTop: 8, fontSize: 12 }}>场景：{scenario} · 主题：{theme}</div>
        </div>
      }
      header={
        <SessionHeader
          title="实现内置终端多标签前端"
          cwd={ROOT}
          branch="main"
          onRename={() => {}}
          terminalOpen={open}
          onToggleTerminal={toggleOpen}
        />
      }
      main={
        <div style={{ flex: 1, padding: '24px 32px', color: 'var(--text-2)', fontSize: 14, overflow: 'auto' }}>
          <p style={{ margin: '0 0 12px', color: 'var(--text)' }}>中间对话区（宽屏停靠时终端位于此处底部，不遮挡左右侧栏）</p>
          <p style={{ margin: 0, color: 'var(--text-3)', fontSize: 13 }}>
            多标签支持双击改名、拖动排序、Ctrl+Shift+T 新建、Ctrl+Shift+W 关闭、Ctrl+Tab / Ctrl+PageDown 切换。
          </p>
        </div>
      }
      bottom={
        <TerminalPanel
          open={open}
          root={ROOT}
          height={height}
          onHeightChange={setHeight}
          onClose={() => setOpen(false)}
          onOpenSystemTerminal={() => {}}
          narrow={forceNarrow}
          touch={forceNarrow}
          tabsController={tabsController}
          initialHistoryOpen={scenario === 'history'}
          initialStdinMode={scenario === 'stdin'}
          initialRenamingId={scenario === 'tabs-rename' ? 'tab-api' : null}
          initialConfirmCloseId={scenario === 'tabs-confirm' ? 'tab-dev' : null}
          fixedNowMs={FIXED_NOW}
        />
      }
      context={
        <div style={{ padding: 16, fontSize: 13, color: 'var(--text-3)' }}>
          <div style={{ fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>上下文面板</div>
          <div>右侧栏保持完整可见，不被终端面板遮挡。</div>
        </div>
      }
    />
  );
}
