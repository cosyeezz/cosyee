// 会话流调试页：http://127.0.0.1:5173/?dev=flow
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Step, Turn } from '@cosyee/shared';
import '../styles/tokens.css';
import { ConversationView } from '../ui/flow/ConversationView';
import { SubagentOverlay } from '../ui/flow/SubagentOverlay';
import { mockTurns } from '../mock/flow';

const SIM_ID = 'sim-turn';
const SIM_ANSWER =
  '好的，分析完成。\n\n这是一段**流式**输出的答复，用来观察贴底滚动与光标动画：\n\n' +
  Array.from({ length: 8 }, (_, i) => `${i + 1}. 第 ${i + 1} 条结论：模拟文字不断追加，列表会越来越长。`).join('\n') +
  '\n\n```ts\nconst done = true;\nconsole.log("流式结束");\n```\n\n以上。';

export default function FlowDev() {
  const [turns, setTurns] = useState<Turn[]>(mockTurns);
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
    setTurns(mockTurns);
  };

  const run = useMemo(() => {
    if (!openSub) return null;
    return turns.find((t) => t.id === openSub.turnId)?.subagents.find((s) => s.toolUseId === openSub.toolUseId) ?? null;
  }, [openSub, turns]);
  const onOpen = useCallback((turnId: string, toolUseId: string) => setOpenSub({ turnId, toolUseId }), []);
  const onClose = useCallback(() => setOpenSub(null), []);

  return (
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
        <ConversationView turns={turns} onOpenSubagent={onOpen} onReply={(quote, reply) => setLastReply({ quote, reply })} />
      </div>
      <SubagentOverlay run={run} onClose={onClose} />
    </div>
  );
}
