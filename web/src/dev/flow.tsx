// 会话流调试页：http://127.0.0.1:5173/?dev=flow
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Step, Turn } from '@cosyee/shared';
import '../styles/tokens.css';
import { ConversationView } from '../ui/flow/ConversationView';
import { SessionDock } from '../ui/flow/SessionDock';
import { SubagentOverlay } from '../ui/flow/SubagentOverlay';
import { FilesContext, type FilesApi } from '../ui/files/FileContext';
import { FlowMetaContext, type FlowMeta } from '../ui/flow/flowContext';
import { FilePreview } from '../ui/files/FilePreview';
import { mockTurns } from '../mock/flow';
import { mockWorkspaces } from '../mock/shell';

// 技能 / MCP 面板的本地演示轮（不依赖 mock/flow.ts）
const PANEL_DEMO: Turn = {
  id: 'panel-demo',
  userText: '演示技能与 MCP 面板',
  attachments: [],
  status: 'running',
  statusText: '',
  steps: [
    { kind: 'tool', id: 'm1', name: 'mcp__playwright__browser_navigate', input: { url: 'https://example.com' }, summary: 'browser_navigate', result: { content: [{ type: 'text', text: 'ok' }], isError: false } },
    { kind: 'tool', id: 'm2', name: 'mcp__playwright__browser_click', input: { ref: 'e3' }, summary: 'browser_click', result: { content: 'Element not found', isError: true } },
    { kind: 'tool', id: 'm3', name: 'mcp__my-docs__search', input: { q: 'hooks' }, summary: 'search' },
  ],
  answer: '已演示。',
  subagents: [],
  skills: [
    { id: 's1', name: 'impeccable', source: 'model', status: 'loaded', body: '# impeccable\n\n演示正文：**设计**前端界面。' },
    { id: 's2', name: 'verify', source: 'user', status: 'loaded', args: 'alpha' },
    { id: 's3', name: 'verify', source: 'model', status: 'loaded' },
    { id: 's4', name: 'ghost', source: 'model', status: 'error', error: 'Unknown skill: ghost' },
    { id: 's5', name: 'debug', source: 'model', status: 'loading' },
  ],
  startedAt: Date.now() - 5000,
};
const DEV_FLOW_META: FlowMeta = {
  mcpServers: ['playwright', 'my-docs'],
  loadSkill: async (name) => ({ name, description: '演示描述', body: `# ${name}\n\n（演示：来自磁盘的 SKILL.md）`, dir: '/demo' }),
};

const SIM_ID = 'sim-turn';
const DEV_CWD = mockWorkspaces[0].path;
const SIM_ANSWER =
  '好的，分析完成。\n\n这是一段**流式**输出的答复，用来观察贴底滚动与光标动画：\n\n' +
  Array.from({ length: 8 }, (_, i) => `${i + 1}. 第 ${i + 1} 条结论：模拟文字不断追加，列表会越来越长。`).join('\n') +
  '\n\n```ts\nconst done = true;\nconsole.log("流式结束");\n```\n\n以上。';

export default function FlowDev() {
  const [turns, setTurns] = useState<Turn[]>(() => [...mockTurns, PANEL_DEMO]);
  const [openSub, setOpenSub] = useState<{ turnId: string; toolUseId: string } | null>(null);
  const timers = useRef<number[]>([]);
  const toolSeq = useRef(0);

  const patch = useCallback((id: string, fn: (t: Turn) => Turn) => {
    setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
  }, []);
  const later = useCallback((ms: number, fn: () => void) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);
  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  // 手动：对「最后一个进行中的轮」操作
  const target = useMemo(
    () => [...turns].reverse().find((t) => t.status === 'running')?.id,
    [turns],
  );
  const appendAnswer = () => target && patch(target, (t) => ({ ...t, answer: t.answer + '\n\n又追加了一段文字，用来测试贴底。'.repeat(2) }));
  const appendTool = () => {
    if (!target) return;
    const id = `tu_sim_${++toolSeq.current}`;
    const step: Step = {
      kind: 'tool',
      id,
      name: 'Bash',
      input: { command: `echo step ${toolSeq.current}` },
      summary: `Bash: echo step ${toolSeq.current}`,
      streaming: true,
    };
    patch(target, (t) => ({ ...t, steps: [...t.steps, step], statusText: `执行第 ${toolSeq.current} 个命令` }));
    later(1200, () =>
      patch(target, (t) => ({
        ...t,
        steps: t.steps.map((s) =>
          s.kind === 'tool' && s.id === id ? { ...s, streaming: false, result: { content: `step ${toolSeq.current}\n`, isError: false } } : s,
        ),
      })),
    );
  };
  const finish = () => target && patch(target, (t) => ({ ...t, status: 'done', endedAt: Date.now() }));

  // 自动模拟一整轮：understanding → running(thinking, 工具) → 流式 answer → done
  const simulate = () => {
    clearTimers();
    const startedAt = Date.now();
    setTurns((ts) => [
      ...ts.filter((t) => t.id !== SIM_ID),
      {
        id: SIM_ID,
        userText: '模拟一轮完整的流式回复',
        attachments: [],
        status: 'understanding',
        statusText: '正在理解问题',
        steps: [],
        answer: '',
        subagents: [],
        startedAt,
      },
    ]);
    later(1500, () =>
      patch(SIM_ID, (t) => ({
        ...t,
        status: 'running',
        statusText: '先看看目录结构',
        steps: [{ kind: 'thinking', text: '用户想看一轮完整的流式效果。我先执行一个命令，再输出答复。' }],
      })),
    );
    later(2500, () =>
      patch(SIM_ID, (t) => ({
        ...t,
        steps: [
          ...t.steps,
          { kind: 'tool', id: 'tu_sim_a', name: 'Bash', input: { command: 'ls -la' }, summary: 'Bash: ls -la', streaming: true },
        ],
      })),
    );
    later(4000, () =>
      patch(SIM_ID, (t) => ({
        ...t,
        statusText: '命令执行完毕，整理结果',
        steps: t.steps.map((s) =>
          s.kind === 'tool' && s.id === 'tu_sim_a'
            ? { ...s, streaming: false, result: { content: 'total 0\ndrwxr-xr-x  2 u u 64 .\n', isError: false } }
            : s,
        ),
      })),
    );
    // 流式 answer：每 40ms 追加几个字符
    const chunk = 4;
    for (let i = chunk, k = 0; i < SIM_ANSWER.length + chunk; i += chunk, k++) {
      later(4600 + k * 40, () => patch(SIM_ID, (t) => ({ ...t, answer: SIM_ANSWER.slice(0, i) })));
    }
    later(4600 + Math.ceil(SIM_ANSWER.length / chunk) * 40 + 400, () =>
      patch(SIM_ID, (t) => ({ ...t, status: 'done', endedAt: Date.now() })),
    );
  };

  const [lastReply, setLastReply] = useState<{ quote: string; reply: string } | null>(null);

  const reset = () => {
    clearTimers();
    setOpenSub(null);
    setTurns([...mockTurns, PANEL_DEMO]);
  };

  const run = useMemo(() => {
    if (!openSub) return null;
    return turns.find((t) => t.id === openSub.turnId)?.subagents.find((s) => s.toolUseId === openSub.toolUseId) ?? null;
  }, [openSub, turns]);
  const onOpen = useCallback((turnId: string, toolUseId: string) => setOpenSub({ turnId, toolUseId }), []);
  const onClose = useCallback(() => setOpenSub(null), []);

  // 本地文件预览：调试页没有真实会话，浮窗会显示「读取失败」的错误态（接真实后端的页面里才有完整效果）
  const [preview, setPreview] = useState<{ path: string; line?: number; nonce: number } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const files = useMemo<FilesApi>(
    () => ({
      cwd: DEV_CWD,
      open: (req, el) => {
        if (el && !opener.current) opener.current = el;
        setPreview((p) => ({ ...req, nonce: (p?.nonce ?? 0) + 1 }));
      },
      reveal: (path) => console.info('[dev] reveal', path),
      terminal: (path) => console.info('[dev] terminal', path),
      openLocal: (path) => console.info('[dev] openLocal', path),
    }),
    [],
  );
  const closePreview = useCallback((restoreFocus: boolean) => {
    setPreview(null);
    if (restoreFocus && opener.current?.isConnected) opener.current.focus();
    opener.current = null;
  }, []);

  return (
    <FlowMetaContext.Provider value={DEV_FLOW_META}>
    <FilesContext.Provider value={files}>
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ display: 'flex', gap: 8, padding: 8, borderBottom: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={simulate}>模拟完整一轮</button>
        <button onClick={appendAnswer} disabled={!target}>追加答复文字</button>
        <button onClick={appendTool} disabled={!target}>追加工具步骤</button>
        <button onClick={finish} disabled={!target}>结束为 done</button>
        <button onClick={reset}>重置</button>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>手动按钮作用于最后一个 running 的轮</span>
        <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
          选中回复：{lastReply ? `「${lastReply.quote}」→ ${lastReply.reply || '（空）'}` : '在答复里选中文字试试'}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <ConversationView turns={turns} onReply={(quote, reply) => setLastReply({ quote, reply })} />
      </div>
      <div style={{ maxWidth: 'var(--content-max)', width: '100%', margin: '0 auto', padding: '0 var(--sp-4) var(--sp-3)', boxSizing: 'border-box' }}>
        <SessionDock turns={turns} sessionKey="dev" onOpenSubagent={onOpen} />
      </div>
      <SubagentOverlay run={run} onClose={onClose} />
      {preview && <FilePreview session="dev" cwd={DEV_CWD} path={preview.path} line={preview.line} nonce={preview.nonce} onClose={closePreview} />}
    </div>
    </FilesContext.Provider>
    </FlowMetaContext.Provider>
  );
}
