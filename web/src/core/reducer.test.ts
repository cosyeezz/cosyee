import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Turn } from '@cosyee/shared';
import { applyEvent, applyReplay, applyStatus, fromHistory, initState, subagentTurnFromHistory, toolSummary, type ConvState } from './reducer';

const FIX = path.resolve(__dirname, '../../../shared/fixtures');

function lines(name: string): unknown[] {
  return readFileSync(path.join(FIX, name), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const user = (text: string) => ({ type: 'cosyee_user', text, at: 1_000_000 });

/**
 * 回放 stdout fixture。fixture 里没有 cosyee_user（后端合成的），这里在开头和 userAt 指定的行号前补。
 * users[0] 在最前，users[i>0] 插在 userAt[i-1] 行之前。
 */
function play(name: string, users: string[], userAt: number[] = []): ConvState {
  let s = initState();
  const ev = lines(name);
  ev.forEach((e, i) => {
    const k = userAt.indexOf(i);
    if (i === 0) s = applyEvent(s, user(users[0]), 1_000_000);
    if (k >= 0) s = applyEvent(s, user(users[k + 1]), 1_000_000);
    s = applyEvent(s, e, 2_000_000);
  });
  return s;
}

describe('实时：basic-tool', () => {
  const s = play('basic-tool.jsonl', ['看一下']);
  const t = s.turns[0];
  it('一轮，结束为 done，有答复', () => {
    expect(s.turns).toHaveLength(1);
    expect(t.status).toBe('done');
    expect(t.answer.length).toBeGreaterThan(0);
    expect(t.endedAt).toBeDefined();
  });
  it('Bash 工具步骤带结果与摘要', () => {
    const bash = t.steps.find((x) => x.kind === 'tool' && x.name === 'Bash');
    expect(bash).toBeTruthy();
    if (bash?.kind === 'tool') {
      expect(bash.result).toBeDefined();
      expect(bash.result?.isError).toBe(false);
      expect(bash.summary.startsWith('Bash: ')).toBe(true);
      expect(bash.streaming).toBeFalsy();
    }
  });
  it('meta 来自 init', () => {
    expect(s.meta.sessionId).toBeTruthy();
    expect(s.meta.model).toBeTruthy();
    expect(Array.isArray(s.meta.tools)).toBe(true);
  });
  it('答复不重复（流式块与完整消息合并）', () => {
    const texts = [...t.steps.map((x) => (x.kind === 'text' ? x.text : '')), t.answer].filter(Boolean);
    expect(new Set(texts).size).toBe(texts.length);
  });
});

describe('实时：thinking', () => {
  const s = play('thinking.jsonl', ['想一想']);
  const t = s.turns[0];
  it('产生 ThinkingStep，tokens 来自 thinking_tokens，已不在流式中', () => {
    const th = t.steps.find((x) => x.kind === 'thinking');
    expect(th).toBeTruthy();
    if (th?.kind === 'thinking') {
      expect(typeof th.tokens).toBe('number');
      expect(th.streaming).toBeFalsy();
    }
    expect(t.status).toBe('done');
    expect(t.answer.length).toBeGreaterThan(0);
  });
});

describe('实时：subagents（后台，含自动续轮）', () => {
  const s = play('subagents.jsonl', ['并行跑两个子代理']);
  const t = s.turns[0];
  it('只有一轮，最终 done，续轮不新开轮', () => {
    expect(s.turns).toHaveLength(1);
    expect(t.status).toBe('done');
  });
  it('两个子代理都 done，各自有 turn', () => {
    expect(t.subagents).toHaveLength(2);
    for (const sub of t.subagents) {
      expect(sub.status).toBe('done');
      expect(sub.title).toBeTruthy();
      expect(sub.turn.id).toBe(`sub-${sub.toolUseId}`);
      expect(sub.turn.status).toBe('done');
      expect(sub.turn.subagents).toHaveLength(0);
    }
  });
  it('主代理的 Agent 调用不在 steps 里，最终答复含总结', () => {
    expect(t.steps.some((x) => x.kind === 'tool' && (x.name === 'Agent' || x.name === 'Task'))).toBe(false);
    expect(t.answer).toContain('两个子代理都已完成');
  });
  it('第一个 result 时（后台子代理未完）不结束轮', () => {
    const ev = lines('subagents.jsonl');
    let cur = applyEvent(initState(), user('x'), 1);
    for (const e of ev.slice(0, 67)) cur = applyEvent(cur, e, 2);
    expect(cur.turns[0].status).not.toBe('done');
    expect(cur.turns[0].subagents.some((x) => x.status === 'running')).toBe(true);
  });
});

describe('实时：subagents-fg（前台）', () => {
  const s = play('subagents-fg.jsonl', ['前台子代理']);
  const t = s.turns[0];
  it('一轮 done，一个 done 子代理，子代理内有 Bash 工具', () => {
    expect(s.turns).toHaveLength(1);
    expect(t.status).toBe('done');
    expect(t.subagents).toHaveLength(1);
    const sub = t.subagents[0];
    expect(sub.status).toBe('done');
    const bash = sub.turn.steps.find((x) => x.kind === 'tool' && x.name === 'Bash');
    expect(bash).toBeTruthy();
    if (bash?.kind === 'tool') expect(bash.result?.isError).toBe(false);
    expect(t.answer.length).toBeGreaterThan(0);
  });
});

describe('实时：interrupt', () => {
  const s = play('interrupt.jsonl', ['先做点什么', '继续'], [22]);
  it('第一轮 interrupted，原因「已中断」，工具结果为错误', () => {
    expect(s.turns).toHaveLength(2);
    const a = s.turns[0];
    expect(a.status).toBe('interrupted');
    expect(a.reason).toBe('已中断');
    const tool = a.steps.find((x) => x.kind === 'tool');
    expect(tool).toBeTruthy();
    if (tool?.kind === 'tool') expect(tool.result?.isError).toBe(true);
  });
  it('第二轮 done', () => {
    expect(s.turns[1].status).toBe('done');
    expect(s.turns[1].userText).toBe('继续');
  });
});

describe('实时：多轮 fixture', () => {
  it('setmodel：三轮都 done，init 更新 meta 不新开轮', () => {
    const s = play('setmodel.jsonl', ['a', 'b', 'c'], [13, 27]);
    expect(s.turns.map((t) => t.status)).toEqual(['done', 'done', 'done']);
    expect(s.turns.map((t) => t.userText)).toEqual(['a', 'b', 'c']);
    expect(s.turns.every((t) => t.answer.length > 0)).toBe(true);
  });
  it('resume / cwdenc：单轮 done；effort：两轮 done', () => {
    for (const f of ['resume.jsonl', 'cwdenc.jsonl']) {
      const s = play(f, ['hi']);
      expect(s.turns).toHaveLength(1);
      expect(s.turns[0].status).toBe('done');
    }
    const e = play('effort.jsonl', ['a', 'b'], [18]);
    expect(e.turns.map((t) => t.status)).toEqual(['done', 'done']);
  });
});

describe('实时：流式细节与健壮性', () => {
  const ss = (event: unknown) => ({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null });
  it('文字流式增长，开始后状态由 understanding 变 running', () => {
    let s = applyEvent(initState(), user('hi'), 1);
    expect(s.turns[0].status).toBe('understanding');
    expect(s.turns[0].statusText).toBe('正在理解问题');
    s = applyEvent(s, ss({ type: 'message_start', message: { id: 'm1' } }));
    s = applyEvent(s, ss({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    s = applyEvent(s, ss({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第一行\n第二' } }));
    expect(s.turns[0].status).toBe('running');
    expect(s.turns[0].answer).toBe('第一行\n第二');
    s = applyEvent(s, ss({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '行' } }));
    expect(s.turns[0].answer).toBe('第一行\n第二行');
  });
  it('工具在文字之后出现：文字并入 steps，answer 清空；输入 JSON 流式拼接', () => {
    let s = applyEvent(initState(), user('hi'), 1);
    s = applyEvent(s, ss({ type: 'message_start', message: { id: 'm1' } }));
    s = applyEvent(s, ss({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    s = applyEvent(s, ss({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来看看' } }));
    s = applyEvent(s, ss({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'Bash', input: {} } }));
    expect(s.turns[0].answer).toBe('');
    expect(s.turns[0].steps[0]).toEqual({ kind: 'text', text: '我来看看' });
    s = applyEvent(s, ss({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"npm ' } }));
    s = applyEvent(s, ss({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'test"}' } }));
    const tool = s.turns[0].steps[1];
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') {
      expect(tool.streaming).toBe(true);
      expect(tool.input).toEqual({ command: 'npm test' });
      expect(tool.summary).toBe('Bash: npm test');
    }
    s = applyEvent(s, ss({ type: 'content_block_stop', index: 1 }));
    const t2 = s.turns[0].steps[1];
    if (t2.kind === 'tool') expect(t2.streaming).toBeFalsy();
  });
  it('不可变：旧状态不被修改', () => {
    const s0 = applyEvent(initState(), user('hi'), 1);
    const snap = JSON.stringify(s0.turns);
    const s1 = applyEvent(s0, ss({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'x' } }));
    expect(JSON.stringify(s0.turns)).toBe(snap);
    expect(s1).not.toBe(s0);
  });
  it('result is_error → error，reason 取 result 文案', () => {
    let s = applyEvent(initState(), user('hi'), 1);
    s = applyEvent(s, { type: 'result', subtype: 'error_during_execution', is_error: true, result: '炸了' }, 5);
    expect(s.turns[0].status).toBe('error');
    expect(s.turns[0].reason).toBe('炸了');
    expect(s.turns[0].endedAt).toBe(5);
  });
  it('未知/畸形事件：不抛错，返回同一引用', () => {
    const s = applyEvent(initState(), user('hi'), 1);
    const bad = [null, undefined, 42, 'x', [], {}, { type: 'nope' }, { type: 'system', subtype: 'zzz' }, { type: 'stream_event' }, { type: 'stream_event', event: { type: 'ping' } }, { type: 'rate_limit_event' }, { type: 'control_response' }];
    for (const e of bad) expect(applyEvent(s, e)).toBe(s);
    const empty = initState();
    expect(applyEvent(empty, { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'x' }] } })).toBe(empty);
  });
  it('新一条 cosyee_user 时上一轮仍未结束 → 收尾为 done', () => {
    let s = applyEvent(initState(), user('a'), 1);
    s = applyEvent(s, user('b'), 9);
    expect(s.turns.map((t) => t.status)).toEqual(['done', 'understanding']);
    expect(s.turns.map((t) => t.id)).toEqual(['t0', 't1']);
  });
});

describe('applyStatus', () => {
  it('exited：当前轮未结束 → error 带 reason', () => {
    const s = applyEvent(initState(), user('hi'), 1);
    const x = applyStatus(s, 'exited', 'boom', 7);
    expect(x.turns[0].status).toBe('error');
    expect(x.turns[0].reason).toBe('boom');
    expect(x.turns[0].endedAt).toBe(7);
    expect(applyStatus(s, 'exited', undefined, 7).turns[0].reason).toBe('会话进程已退出');
  });
  it('idle：当前轮未结束 → done；已结束的轮不动', () => {
    const s = applyEvent(initState(), user('hi'), 1);
    const x = applyStatus(s, 'idle', undefined, 7);
    expect(x.turns[0].status).toBe('done');
    expect(applyStatus(x, 'exited', 'boom')).toBe(x);
    const e = initState();
    expect(applyStatus(e, 'idle')).toBe(e);
  });
  it('running 状态不改动', () => {
    const s = applyEvent(initState(), user('hi'), 1);
    expect(applyStatus(s, 'running')).toBe(s);
  });
});

describe('历史：transcript-sample', () => {
  const s = fromHistory(lines('transcript-sample.jsonl'));
  it('只有真实用户消息成轮；meta/本地命令不成轮', () => {
    expect(s.turns).toHaveLength(1);
    const t = s.turns[0];
    expect(t.userText).toBe('只回复 ok');
    expect(t.status).toBe('done');
    expect(t.id).toBe('t0');
    expect(s.meta.sessionId).toBeTruthy();
  });
  it('turn_duration 结束该轮', () => {
    expect(s.turns[0].endedAt).toBe(Date.parse('2026-11-16T13:08:06.000Z'));
    expect(s.turns[0].startedAt).toBe(Date.parse('2026-11-16T13:07:00.714Z'));
  });
  it('Agent 调用成为子代理（done）', () => {
    const t = s.turns[0];
    expect(t.subagents).toHaveLength(1);
    expect(t.subagents[0].toolUseId).toBe('toolu_01FIXTUREAGENT0001');
    expect(t.subagents[0].status).toBe('done');
    expect(t.subagents[0].title).toBe('示例子代理');
  });
  it('running=true：最后一轮保持未结束', () => {
    const head = lines('transcript-sample.jsonl').slice(0, 8);
    expect(fromHistory(head, { running: true }).turns[0].status).not.toBe('done');
    expect(fromHistory(head).turns[0].status).toBe('done');
  });
});

describe('历史：手造条目', () => {
  it('斜杠命令还原、中断、meta.cwd', () => {
    const entries = [
      { type: 'user', timestamp: '2026-11-16T10:00:00.000Z', sessionId: 'S', cwd: 'C:\\p', message: { role: 'user', content: '<command-name>/compact</command-name>\n<command-args>保留要点</command-args>' } },
      { type: 'user', timestamp: '2026-11-16T10:00:01.000Z', message: { role: 'user', content: '跑一下' } },
      { type: 'assistant', timestamp: '2026-11-16T10:00:02.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'sleep 99' } }] } },
      { type: 'user', timestamp: '2026-11-16T10:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'rejected', is_error: true }] } },
      { type: 'user', timestamp: '2026-11-16T10:00:04.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } },
    ];
    const r = fromHistory(entries);
    expect(r.turns.map((t) => t.userText)).toEqual(['/compact 保留要点', '跑一下']);
    expect(r.turns[1].status).toBe('interrupted');
    expect(r.turns[1].reason).toBe('已中断');
    const tool = r.turns[1].steps[0];
    expect(tool.kind).toBe('tool');
    if (tool.kind === 'tool') {
      expect(tool.result?.isError).toBe(true);
      expect(tool.summary).toBe('Bash: sleep 99');
    }
    expect(r.meta.cwd).toBe('C:\\p');
    expect(r.meta.sessionId).toBe('S');
  });
  it('附件还原', () => {
    const entries = [{ type: 'user', timestamp: '2026-11-16T10:00:00.000Z', message: { role: 'user', content: '看 @"C:\\x\\a.png" 吧' } }];
    const t = fromHistory(entries).turns[0];
    expect(t.attachments).toHaveLength(1);
    expect(t.attachments[0].path).toBe('C:\\x\\a.png');
    expect(t.userText).not.toContain('@"');
  });
  it('空输入与畸形条目不抛错', () => {
    expect(fromHistory([]).turns).toEqual([]);
    expect(fromHistory([null, 1, 'x', {}, { type: 'user' }, { type: 'assistant' }]).turns).toEqual([]);
  });
});

describe('子代理历史', () => {
  const meta = JSON.parse(readFileSync(path.join(FIX, 'subagent-transcript.meta.json'), 'utf8')) as { description: string; toolUseId: string };
  const t: Turn = subagentTurnFromHistory(lines('subagent-transcript.jsonl'), { title: meta.description, toolUseId: meta.toolUseId });
  it('userText 为首条 prompt，id 以 sub- 开头', () => {
    expect(t.id).toBe(`sub-${meta.toolUseId}`);
    expect(t.userText).toContain('echo AAA');
    expect(t.status).toBe('done');
    expect(t.subagents).toEqual([]);
  });
  it('含 Bash 工具（结果 AAA）与最终答复', () => {
    const bash = t.steps.find((x) => x.kind === 'tool' && x.name === 'Bash');
    expect(bash).toBeTruthy();
    if (bash?.kind === 'tool') expect(JSON.stringify(bash.result?.content)).toContain('AAA');
    expect(t.answer).toContain('echo AAA');
  });
  it('没有 prompt 时用标题', () => {
    const only = lines('subagent-transcript.jsonl').filter((e) => (e as { type?: string }).type === 'assistant');
    expect(subagentTurnFromHistory(only, { title: '标题', toolUseId: 'x' }).userText).toBe('标题');
  });
});

describe('applyReplay', () => {
  const ev = lines('basic-tool.jsonl');
  const hist = (running: boolean) => fromHistory([
    { type: 'user', timestamp: '2026-11-16T10:00:00.000Z', sessionId: 'S', message: { role: 'user', content: '先前的问题' } },
    { type: 'assistant', timestamp: '2026-11-16T10:00:01.000Z', message: { id: 'm0', role: 'assistant', content: [{ type: 'text', text: '先前的答复' }] } },
    { type: 'user', timestamp: '2026-11-16T10:01:00.000Z', message: { role: 'user', content: '看一下' } },
    { type: 'assistant', timestamp: '2026-11-16T10:01:01.000Z', message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '半截' }] } },
  ], { running });
  const replay = [user('看一下'), ...ev];

  it('丢掉历史最后一轮，用 replay 重建；重复调用结果相同', () => {
    const h = hist(true);
    expect(h.turns).toHaveLength(2);
    const a = applyReplay(h, replay);
    expect(a.turns).toHaveLength(2);
    expect(a.turns[0].userText).toBe('先前的问题');
    expect(a.turns[1].userText).toBe('看一下');
    expect(a.turns[1].status).toBe('done');
    const c = applyReplay(a, replay);
    expect(c.turns).toHaveLength(2);
    expect(c.turns[1].status).toBe('done');
    expect(c.turns[1].answer).toBe(a.turns[1].answer);
  });
  it('replay 的用户消息与历史最后一轮不同 → 不丢轮', () => {
    const a = applyReplay(hist(true), [user('新问题'), ...ev]);
    expect(a.turns.map((t) => t.userText)).toEqual(['先前的问题', '看一下', '新问题']);
  });
  it('空 replay 返回原状态；replay 后可继续实时事件', () => {
    const h = hist(true);
    expect(applyReplay(h, [])).toBe(h);
    const partial = applyReplay(h, replay.slice(0, 6));
    const more = applyEvent(partial, replay[6]);
    expect(more.turns).toHaveLength(2);
  });
});

describe('toolSummary', () => {
  it('常见工具', () => {
    expect(toolSummary('Bash', { command: 'npm test' })).toBe('Bash: npm test');
    expect(toolSummary('PowerShell', { command: 'ls' })).toBe('PowerShell: ls');
    expect(toolSummary('Read', { file_path: 'src/a.ts' })).toBe('Read: src/a.ts');
    expect(toolSummary('Edit', { file_path: 'src/b.ts', old_string: 'x' })).toBe('Edit: src/b.ts');
    expect(toolSummary('Grep', { pattern: 'foo' })).toBe('Grep: foo');
    expect(toolSummary('Agent', { description: '查一下', prompt: '...' })).toBe('Agent: 查一下');
    expect(toolSummary('WebFetch', { url: 'http://x' })).toBe('WebFetch: http://x');
  });
  it('多行取首行；过长截断；无参数只有名字；未知工具兜底', () => {
    expect(toolSummary('Bash', { command: 'echo a\necho b' })).toBe('Bash: echo a …');
    expect(toolSummary('Bash', { command: 'x'.repeat(300) }).length).toBeLessThanOrEqual(110);
    expect(toolSummary('Foo', {})).toBe('Foo');
    expect(toolSummary('Foo', null)).toBe('Foo');
    expect(toolSummary('Foo', { query: 'hi' })).toContain('hi');
  });
});
