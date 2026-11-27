// 内置终端独立调试页（?dev=terminal）：纯内存 mock，支持多场景、亮暗主题与窄屏验收截图。
// 参数：?dev=terminal&theme=dark|light&scenario=default|history|stdin|empty|reconnecting&narrow=1
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TermBlock, TermShell, TermSnapshot } from '@cosyee/shared';
import type { TerminalActions, TerminalConnState, TerminalController } from '../core/terminal';
import { AppShell } from '../ui/layout/AppShell';
import { SessionHeader } from '../ui/header/SessionHeader';
import { TerminalPanel } from '../ui/terminal/TerminalPanel';

const FIXED_NOW = 1_732_700_062_400;
const ROOT = 'F:\\Cosyee';

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

function buildInitial(scenario: string): { snap: TermSnapshot; connState: TerminalConnState; error: string | null } {
  const base: TermSnapshot = {
    root: ROOT,
    cwd: 'F:\\Cosyee\\web\\src\\ui\\terminal',
    shell: 'pwsh',
    shells: [
      { id: 'pwsh', label: 'PowerShell 7' },
      { id: 'powershell', label: 'Windows PowerShell' },
      { id: 'cmd', label: '命令提示符' },
      { id: 'gitbash', label: 'Git Bash' },
    ],
    platform: 'win32',
    blocks: [],
    history: SAMPLE_HISTORY,
  };

  if (scenario === 'empty') {
    return { snap: { ...base, cwd: ROOT, blocks: [] }, connState: 'open', error: null };
  }

  if (scenario === 'reconnecting') {
    return {
      snap: {
        ...base,
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
      connState: 'reconnecting',
      error: null,
    };
  }

  const blocks: TermBlock[] = [
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

  return { snap: { ...base, blocks }, connState: 'open', error: null };
}

export default function TerminalDevPage() {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') === 'light' ? 'light' : 'dark';
  const scenario = params.get('scenario') ?? 'default';
  const forceNarrow = params.get('narrow') === '1';

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const init = useMemo(() => buildInitial(scenario), [scenario]);
  const [snap, setSnap] = useState<TermSnapshot>(init.snap);
  const [open, setOpen] = useState(true);
  const [height, setHeight] = useState(440);

  const actions = useMemo<TerminalActions>(
    () => ({
      run: (cmd) => {
        const id = `mock-${Date.now()}`;
        const block: TermBlock = {
          id,
          cmd,
          cwd: snap.cwd,
          shell: snap.shell,
          startedAt: Date.now(),
          endedAt: Date.now() + 180,
          exitCode: 0,
          state: 'done',
          output: `\x1b[32m✓\x1b[0m 已在预览模式执行: ${cmd}\n`,
        };
        setSnap((s) => ({
          ...s,
          blocks: [...s.blocks, block],
          history: [...s.history.filter((h) => h !== cmd.trim()), cmd.trim()],
        }));
        return id;
      },
      sendStdin: (id, data) => {
        setSnap((s) => ({
          ...s,
          blocks: s.blocks.map((b) => (b.id === id ? { ...b, output: `${b.output}\n\x1b[36m[stdin]\x1b[0m ${data}` } : b)),
        }));
      },
      stop: (id) => {
        setSnap((s) => ({
          ...s,
          blocks: s.blocks.map((b) => (b.id === id ? { ...b, state: 'stopped', endedAt: FIXED_NOW, exitCode: null } : b)),
        }));
      },
      clear: () => {
        setSnap((s) => ({ ...s, blocks: s.blocks.filter((b) => b.state === 'running') }));
      },
      setShell: (shell: TermShell) => {
        setSnap((s) => ({ ...s, shell }));
      },
      resetCwd: () => {
        setSnap((s) => ({ ...s, cwd: s.root }));
      },
      removeHistory: (cmd) => {
        setSnap((s) => ({ ...s, history: s.history.filter((h) => h !== cmd) }));
      },
      clearHistory: () => {
        setSnap((s) => ({ ...s, history: [] }));
      },
      reconnect: () => {},
    }),
    [snap.cwd, snap.shell],
  );

  const controller = useMemo<TerminalController>(
    () => ({
      state: { root: ROOT, connState: init.connState, error: init.error, snapshot: snap },
      actions,
    }),
    [init.connState, init.error, snap, actions],
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
          title="实现内置终端前端面板"
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
            点击顶栏工作目录右侧的终端图标可随时展开 / 收起终端面板；拖拽终端顶边可自由调整高度，双击顶边最大化。
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
          controller={controller}
          initialHistoryOpen={scenario === 'history'}
          initialStdinMode={scenario === 'stdin'}
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
