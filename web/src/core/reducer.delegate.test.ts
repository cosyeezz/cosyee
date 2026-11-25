import { describe, expect, it } from 'vitest';
import { DELEGATE_BG_MARKER, formatDelegateNotification, type DelegateJobInfo } from '@cosyee/shared';
import { applyDelegates, applyEvent, applyEvents, applyStatus, fromHistory, initState, recordFuller, subagentTurnFromHistory, toolSummary, withRecord, type ConvState } from './reducer';

// 后台委派（delegate run_in_background / delegate_send 续跑）：主轮结束不影响它，状态由任务快照或完成通知决定
const D = 'toolu_D';
const NOW = 2_000_000;
const user = (text: string, id?: string) => ({ type: 'cosyee_user', text, at: 1_000_000, ...(id ? { id } : {}) });
const call = (id = D, name = 'mcp__cosyee__delegate', input: unknown = { description: '重构登录页', prompt: '把登录页拆组件' }) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const result = (text: string, id = D, isError = false) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: isError }] },
});
const bgResult = (id = D) => result(`${DELEGATE_BG_MARKER}\nconversation_id: conv-1`, id);
const done = { type: 'result', subtype: 'success', is_error: false };
/** 后台委派过程里的一段文字（parent_tool_use_id = delegate 调用） */
const progress = (text: string, id = D, mid = 'agy-1') => ({
  type: 'assistant',
  parent_tool_use_id: id,
  message: { id: `${mid}-${text}`, role: 'assistant', model: 'gemini-3-pro', content: [{ type: 'text', text }] },
});
const job = (over: Partial<DelegateJobInfo> = {}): DelegateJobInfo => ({
  toolUseId: D, conversationId: 'conv-1', description: '重构登录页', background: true, state: 'running', startedAt: 1, pending: 0, tail: '', ...over,
});
const play = (events: unknown[], s: ConvState = initState()): ConvState => applyEvents(s, events, NOW);
const runOf = (s: ConvState, turn = s.turns.length - 1) => s.turns[turn]!.subagents.find((r) => r.toolUseId === D)!;

/** 后台启动后主轮正常结束 */
const launchedAndDone = (): ConvState => play([user('后台做一下'), call(), bgResult(), { type: 'assistant', parent_tool_use_id: null, message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '已在后台启动' }] } }, done]);

describe('后台委派：启动', () => {
  it('回执（DELEGATE_BG_MARKER）不结束子代理，也不当回答', () => {
    const s = play([user('x'), call(), bgResult()]);
    const run = runOf(s);
    expect(run).toMatchObject({ status: 'running', background: true, delegate: true, subagentType: 'general-purpose' });
    expect(run.turn.answer).toBe('');
    expect(run.turn.status).not.toBe('done');
  });

  it('前台调用的结果仍然结束子代理', () => {
    const run = runOf(play([user('x'), call(), result('做完了\n\n[conversation_id: conv-1]')]));
    expect(run).toMatchObject({ status: 'done' });
    expect(run.background).toBeUndefined();
  });

  it('主轮 result 后主轮 done，后台委派仍在运行', () => {
    const s = launchedAndDone();
    expect(s.turns[0]!.status).toBe('done');
    expect(runOf(s)).toMatchObject({ status: 'running', background: true });
  });

  it('idle / exited 状态兜底不收尾后台委派', () => {
    const s = play([user('x'), call(), bgResult()]);
    const idle = applyStatus(s, 'idle', undefined, NOW);
    expect(idle.turns[0]!.status).toBe('done');
    expect(runOf(idle).status).toBe('running');
    const exited = applyStatus(s, 'exited', 'boom', NOW);
    expect(exited.turns[0]!.status).toBe('error');
    expect(runOf(exited).status).toBe('running');
  });

  it('开新一轮时上一轮的后台委派不被收尾', () => {
    const s = play([user('x'), call(), bgResult(), user('再来一个')]);
    expect(s.turns).toHaveLength(2);
    expect(s.turns[0]!.status).toBe('done');
    expect(runOf(s, 0).status).toBe('running');
  });
});

describe('后台委派：主轮结束后的进度', () => {
  it('进度只更新子代理，不重开已结束的主轮', () => {
    const s0 = launchedAndDone();
    const s = play([progress('正在拆组件'), progress('拆完了')], s0);
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.status).toBe('done');
    expect(s.turns[0]!.endedAt).toBe(s0.turns[0]!.endedAt);
    expect(s.book!.inRound).toBe(false);
    const run = runOf(s);
    expect(run.status).toBe('running');
    expect(run.turn.steps.length + (run.turn.answer ? 1 : 0)).toBeGreaterThan(0);
    expect(run.model).toBe('gemini-3-pro');
  });

  it('流式进度同样不重开主轮', () => {
    const sub = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: D, api_message_id: 'agy-s', event });
    const s = play(
      [
        sub({ type: 'message_start', message: { id: 'agy-s' } }),
        sub({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
        sub({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '流式输出' } }),
      ],
      launchedAndDone(),
    );
    expect(s.turns[0]!.status).toBe('done');
    expect(runOf(s).turn.answer).toBe('流式输出');
  });

  it('子代理自己的 tool_result 也不重开主轮', () => {
    const s = play(
      [
        progress('x'),
        { type: 'user', parent_tool_use_id: D, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agy_1', content: '{}', is_error: false }] } },
      ],
      launchedAndDone(),
    );
    expect(s.turns[0]!.status).toBe('done');
  });

  it('后台委派在更早的轮里：进度复制进当前轮，当前轮结束后不被它重开', () => {
    const s0 = play([user('x'), call(), bgResult(), done, user('第二问'), { type: 'assistant', parent_tool_use_id: null, message: { id: 'm9', role: 'assistant', content: [{ type: 'text', text: '好' }] } }, done]);
    expect(s0.turns[1]!.status).toBe('done');
    const s = play([progress('后台又吐了一段')], s0);
    expect(s.turns).toHaveLength(2);
    expect(s.turns[1]!.status).toBe('done');
    expect(runOf(s, 1)).toMatchObject({ status: 'running', background: true });
    expect(runOf(s, 0).status).toBe('running');
  });

  it('delegate_send 续跑已结束的委派：同一个子代理回到运行中并标为后台，主轮不动', () => {
    // 前台委派先做完（主轮也结束了），之后服务端在后台续跑，进度仍然带原来的 toolUseId
    const s0 = play([user('x'), call(), result('第一次的结果\n\n[conversation_id: conv-1]'), done]);
    expect(runOf(s0)).toMatchObject({ status: 'done' });
    const s = play([progress('续跑的输出')], s0);
    expect(runOf(s)).toMatchObject({ status: 'running', background: true });
    expect(s.turns[0]!.status).toBe('done');
  });

  it('停止 / 超时后才到的收尾事件（文本块结束、工具「已中断」）不让已结束的委派回到运行中', () => {
    const stream = (event: unknown) => ({ type: 'stream_event', parent_tool_use_id: D, api_message_id: 'agy-t1', event });
    const running = play([
      user('x'), call(),
      stream({ type: 'message_start', message: { id: 'agy-t1', model: 'gemini' } }),
      stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '等脚本跑完' } }),
    ]);
    expect(runOf(running).status).toBe('running');
    const closers = [
      stream({ type: 'content_block_stop', index: 0 }),
      { type: 'user', parent_tool_use_id: D, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'agy_x', content: '已中断', is_error: true }] } },
    ];
    // 前台调用超时：先到工具结果（出错），再到收尾事件
    const timedOut = play([result('timed out after 3600s', D, true)], running);
    expect(runOf(play(closers, timedOut))).toMatchObject({ status: 'error', turn: { status: 'error' } });
    expect(runOf(play(closers, timedOut)).background).toBeUndefined();
    // 先到任务快照（已停止），再到收尾事件；主轮已进入下一轮也一样
    const stopped = applyDelegates(timedOut, [job({ state: 'stopped', background: false, endedAt: 5 })], NOW);
    expect(runOf(play(closers, stopped)).status).toBe('done');
    const next = play([done, user('下一句')], stopped);
    expect(play(closers, next).turns[1]!.subagents).toEqual([]);
    expect(runOf(play(closers, next), 0).status).toBe('done');
    // 真正的续跑（有新内容）仍然回到运行中
    expect(runOf(play([...closers, stream({ type: 'message_start', message: { id: 'agy-t2' } })], stopped))).toMatchObject({ status: 'running', background: true });
  });

  it('完成通知触发的 CLI 自启动轮：照常重开主轮（现有路径），后台委派不影响收尾', () => {
    const s = play(
      [{ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm-n' } } }, { type: 'assistant', parent_tool_use_id: null, message: { id: 'm-n', role: 'assistant', content: [{ type: 'text', text: '后台那边做完了' }] } }, done],
      launchedAndDone(),
    );
    expect(s.turns[0]!.status).toBe('done');
    expect(s.turns[0]!.steps.some((x) => x.kind === 'text' && x.text === '后台那边做完了') || s.turns[0]!.answer === '后台那边做完了').toBe(true);
    expect(runOf(s).status).toBe('running');
  });
});

describe('applyDelegates：任务快照', () => {
  it('done：子代理 done，回答为空时用 tail 补', () => {
    const s = applyDelegates(launchedAndDone(), [job({ state: 'done', tail: '最终回答', endedAt: 5 })], NOW);
    const run = runOf(s);
    expect(run).toMatchObject({ status: 'done', background: true });
    expect(run.turn).toMatchObject({ status: 'done', answer: '最终回答' });
  });

  it('已有回答不覆盖；stopped 回答为空时加（已停止）前缀；error 记原因', () => {
    const withAnswer = applyDelegates(play([progress('过程中的回答')], launchedAndDone()), [job({ state: 'done', tail: '别的' })], NOW);
    expect(runOf(withAnswer).turn.answer).not.toBe('别的');
    const stopped = applyDelegates(launchedAndDone(), [job({ state: 'stopped', tail: '做到一半' })], NOW);
    expect(runOf(stopped)).toMatchObject({ status: 'done' });
    expect(runOf(stopped).turn.answer).toBe('（已停止）做到一半');
    const err = applyDelegates(launchedAndDone(), [job({ state: 'error', tail: '', error: 'agy 崩了' })], NOW);
    expect(runOf(err)).toMatchObject({ status: 'error' });
    expect(runOf(err).turn.reason).toBe('agy 崩了');
  });

  it('更新所有轮里的同名副本', () => {
    const s0 = play([user('x'), call(), bgResult(), done, user('第二问'), done]);
    const s1 = play([progress('又一段')], s0); // 复制进第二轮
    expect(s1.turns[1]!.subagents).toHaveLength(1);
    const s = applyDelegates(s1, [job({ state: 'done', tail: '好了' })], NOW);
    expect(runOf(s, 0).status).toBe('done');
    expect(runOf(s, 1).status).toBe('done');
    expect(runOf(s, 0).turn.answer).toBe('好了');
  });

  it('running：已结束的后台任务（续跑）回到运行中；前台任务不复活', () => {
    const finished = applyDelegates(launchedAndDone(), [job({ state: 'done', tail: 'a' })], NOW);
    const again = applyDelegates(finished, [job({ state: 'running' })], NOW);
    expect(runOf(again)).toMatchObject({ status: 'running' });
    expect(runOf(again).turn.status).toBe('running');
    const fg = play([user('x'), call(), result('结果'), done]);
    expect(runOf(applyDelegates(fg, [job({ state: 'running', background: false })], NOW)).status).toBe('done');
  });

  it('快照里没有的后台运行 → error（任务已丢失）；前台与已结束的不受影响', () => {
    const lost = applyDelegates(launchedAndDone(), [], NOW);
    expect(runOf(lost)).toMatchObject({ status: 'error' });
    expect(runOf(lost).turn.answer).toContain('任务已丢失');
    const fg = play([user('x'), call()]);
    expect(runOf(applyDelegates(fg, [], NOW)).status).toBe('running');
    const ended = applyDelegates(launchedAndDone(), [job({ state: 'done', tail: 'a' })], NOW);
    expect(runOf(applyDelegates(ended, [], NOW)).status).toBe('done');
  });

  it('没有变化时原样返回，且不改动传入的状态（不可变）', () => {
    const s = launchedAndDone();
    const before = JSON.stringify(s);
    const same = applyDelegates(s, [job()], NOW);
    expect(same).toBe(s);
    applyDelegates(s, [job({ state: 'done', tail: 'x' })], NOW);
    expect(JSON.stringify(s)).toBe(before);
    const x = applyDelegates(s, [job({ state: 'done', tail: 'x' })], NOW);
    expect(applyDelegates(x, [job({ state: 'done', tail: 'x' })], NOW)).toBe(x);
  });
});

describe('后台委派：完成通知', () => {
  /** 旧格式：正文直接写在通知里 */
  const note = ({ status = 'done', result = '拆成了 3 个组件' }: { status?: string; result?: string } = {}) =>
    `<cosyee-delegate-notification>\nnote: x\nconversation_id: conv-1\ntool_use_id: ${D}\nstatus: ${status}\ndescription: 重构登录页\nresult_id: res_1\nresult:\n${result}\n</cosyee-delegate-notification>`;
  /** 现在的格式：只有 result_id */
  const idNote = (status: 'done' | 'error' | 'stopped', result = '') =>
    formatDelegateNotification({ conversationId: 'conv-1', toolUseId: D, status, description: '重构登录页', resultId: 'res_1', result });
  const histEntries = (text: string) => [
    { type: 'user', timestamp: '2026-11-16T10:00:00.000Z', sessionId: 'S', message: { role: 'user', content: '后台做一下' } },
    { ...call(), timestamp: '2026-11-16T10:00:01.000Z' },
    { ...bgResult(), timestamp: '2026-11-16T10:00:02.000Z' },
    { type: 'system', subtype: 'turn_duration', durationMs: 3000, timestamp: '2026-11-16T10:00:03.000Z' },
    { type: 'user', timestamp: '2026-11-16T10:05:00.000Z', message: { role: 'user', content: text } },
  ];

  it('历史：通知不开新轮，按 toolUseId 落定对应子代理，结果当回答', () => {
    const h = fromHistory(histEntries(note()));
    expect(h.turns).toHaveLength(1);
    const run = runOf(h);
    expect(run).toMatchObject({ status: 'done' });
    expect(run.turn.answer).toBe('拆成了 3 个组件');
  });

  it('只带 result_id 的通知：落定状态，流式收到的回答保留；出错写原因', () => {
    const live = (text: string) =>
      runOf(applyEvent(play([progress('流式回答')], launchedAndDone()), { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: text } }, NOW));
    const ok = live(idNote('done', '不会出现在通知里'));
    expect(ok.status).toBe('done');
    expect(ok.turn.answer).toBe('流式回答');
    const err = live(idNote('error', '卡住了'));
    expect(err).toMatchObject({ status: 'error' });
    expect(err.turn.reason).toBe('卡住了');
    expect(runOf(fromHistory(histEntries(idNote('done')))).status).toBe('done');
    expect(runOf(fromHistory(histEntries(idNote('stopped')))).turn.answer).toBe('（已停止）');
    expect(runOf(fromHistory(histEntries(idNote('error', '卡住了')))).turn.reason).toBe('卡住了');
  });

  it('历史：没有通知时后台委派保持运行（主轮 done 也不收尾）', () => {
    const h = fromHistory(histEntries('随便说一句').slice(0, 4));
    expect(h.turns[0]!.status).toBe('done');
    expect(runOf(h)).toMatchObject({ status: 'running', background: true });
  });

  it('历史：error / stopped', () => {
    const e = fromHistory(histEntries(note({ status: 'error', result: 'agy 退出码 1' })));
    expect(runOf(e)).toMatchObject({ status: 'error' });
    const st = fromHistory(histEntries(note({ status: 'stopped', result: '做到一半' })));
    expect(runOf(st).status).toBe('done');
    expect(runOf(st).turn.answer).toBe('（已停止）做到一半');
    const empty = fromHistory(histEntries(note({ status: 'done', result: '' })));
    expect(runOf(empty).status).toBe('done');
  });

  it('历史：通知夹在后续轮之间也只落定运行，不产生用户轮', () => {
    const h = fromHistory([
      ...histEntries('占位').slice(0, 4),
      { type: 'user', timestamp: '2026-11-16T10:04:00.000Z', message: { role: 'user', content: '第二问' } },
      { type: 'user', timestamp: '2026-11-16T10:05:00.000Z', message: { role: 'user', content: [{ type: 'text', text: note() }] } },
    ]);
    expect(h.turns.map((t) => t.userText)).toEqual(['后台做一下', '第二问']);
    expect(runOf(h, 0).status).toBe('done');
  });

  it('历史：执行中送达的通知存成 queued_command 附件，同样落定、不开轮', () => {
    for (const prompt of [note(), [{ type: 'text', text: note() }]]) {
      const h = fromHistory([
        ...histEntries('占位').slice(0, 3),
        { type: 'attachment', timestamp: '2026-11-16T10:00:02.500Z', attachment: { type: 'queued_command', commandMode: 'prompt', prompt } },
        ...histEntries('占位').slice(3, 4),
      ]);
      expect(h.turns).toHaveLength(1);
      expect(runOf(h)).toMatchObject({ status: 'done' });
      expect(runOf(h).turn.answer).toBe('拆成了 3 个组件');
    }
  });

  it('旧记录里没有 note 行的通知也能解析', () => {
    const old = note().replace(/\nnote: .*/, '');
    expect(old).not.toContain('note:');
    expect(runOf(fromHistory(histEntries(old))).turn.answer).toBe('拆成了 3 个组件');
  });

  it('历史：模型用 delegate_stop 停掉的没有通知，靠停止结果落定；没有 tool_use_id 的普通文本不认', () => {
    const stop = (text: string) =>
      fromHistory([
        ...histEntries('占位').slice(0, 3),
        { type: 'user', timestamp: '2026-11-16T10:00:02.500Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: [{ type: 'text', text }] }] } },
        ...histEntries('占位').slice(3, 4),
      ]);
    const foot = '\n\n[conversation_id: conv-1]';
    const some = stop('Stopped delegate conv-1.\nPartial output (tail):\n第一段\n\n第二段' + foot + '\n[tool_use_id: ' + D + ']');
    expect(runOf(some).status).toBe('done');
    expect(runOf(some).turn.answer).toBe('（已停止）第一段\n\n第二段');
    const none = stop('Stopped delegate conv-1.\nNo output yet.' + foot + '\n[tool_use_id: ' + D + ']');
    expect(runOf(none).status).toBe('done');
    expect(runOf(none).turn.answer).toBe('（已停止）');
    expect(runOf(stop('Stopped delegate conv-1.\nNo output yet.' + foot)).status).toBe('running');
  });

  it('实时：通知 user 事件落定运行，不开轮', () => {
    const s = applyEvent(launchedAndDone(), { type: 'user', parent_tool_use_id: null, message: { role: 'user', content: note() } }, NOW);
    expect(s.turns).toHaveLength(1);
    expect(runOf(s)).toMatchObject({ status: 'done' });
    expect(runOf(s).turn.answer).toBe('拆成了 3 个组件');
  });
});

describe('后台委派：用过程记录补全', () => {
  const rec = () => subagentTurnFromHistory(
    [
      { type: 'assistant', timestamp: '2026-11-16T10:00:01.000Z', message: { id: 'a', role: 'assistant', content: [{ type: 'text', text: '先看看' }] } },
      { type: 'assistant', timestamp: '2026-11-16T10:00:02.000Z', message: { id: 'b', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'run', input: {} }] } },
      { type: 'user', timestamp: '2026-11-16T10:00:03.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } },
      { type: 'assistant', timestamp: '2026-11-16T10:00:04.000Z', message: { id: 'c', role: 'assistant', content: [{ type: 'text', text: '做完了' }] } },
    ],
    { title: 'x', toolUseId: D },
  );

  it('历史里没有步骤：补上步骤，页面上的结果更长就保留', () => {
    const base = runOf(launchedAndDone());
    const done = { ...base, status: 'done' as const, turn: { ...base.turn, status: 'done' as const, answer: '通知里的结果', steps: [] } };
    expect(recordFuller(done, rec())).toBe(true);
    const r = withRecord(done, rec());
    expect(r.turn.steps.map((s) => s.kind)).toEqual(['text', 'tool']);
    expect(r.turn.answer).toBe('通知里的结果');
    expect(r.turn.userText).toBe(done.turn.userText);
  });

  it('通知不带正文：最终结果取自记录；快照截过的尾部也换成完整的；停止保留前缀，出错保留原因', () => {
    const base = runOf(launchedAndDone());
    const at = (status: 'done' | 'error', answer: string) => ({ ...base, status, turn: { ...base.turn, status, answer, steps: [] } });
    const text = { ...rec(), steps: [], answer: '很长的完整回答' }; // 纯文字任务：没有步骤
    expect(withRecord(at('done', ''), text).turn.answer).toBe('很长的完整回答');
    expect(withRecord(at('done', '完整回答'), text).turn.answer).toBe('很长的完整回答');
    expect(withRecord(at('done', '（已停止）'), text).turn.answer).toBe('（已停止）很长的完整回答');
    expect(withRecord(at('error', '卡住了'), text).turn.answer).toBe('卡住了');
    const full = at('done', '很长的完整回答');
    expect(withRecord(full, text)).toBe(full);
  });

  it('运行中：记录更全时连正在写的文字一起用；实时的不比记录少就用实时的', () => {
    const base = runOf(launchedAndDone());
    const live = { ...base, status: 'running' as const, turn: { ...base.turn, status: 'running' as const, steps: [], answer: '半' } };
    expect(withRecord(live, rec()).turn.answer).toBe('做完了');
    const full = { ...live, turn: { ...live.turn, steps: rec().steps, answer: '做完了，再补一句' } };
    expect(withRecord(full, rec())).toBe(full);
  });
});

describe('delegate 配套工具是普通工具步骤', () => {
  it('delegate_send / stop / status 不进子代理，摘要带会话 id 短写与消息摘录', () => {
    const cid = 'a1b2c3d4-0000-4000-8000-000000000000';
    const s = play([
      user('x'),
      call('S1', 'mcp__cosyee__delegate_send', { conversation_id: cid, message: '再加上单测', mode: 'steer' }),
      call('S2', 'mcp__cosyee__delegate_stop', { conversation_id: cid }),
      call('S3', 'mcp__cosyee__delegate_status', { wait_seconds: 5 }),
    ]);
    expect(s.turns[0]!.subagents).toHaveLength(0);
    const tools = s.turns[0]!.steps.filter((x) => x.kind === 'tool');
    expect(tools.map((t) => t.kind === 'tool' && t.summary)).toEqual([
      'delegate_send: a1b2c3d4 · 再加上单测',
      'delegate_stop: a1b2c3d4',
      'delegate_status',
    ]);
    expect(toolSummary('mcp__cosyee__delegate_result', { result_id: `res_${'a1b2c3d4'.repeat(4)}` })).toBe('delegate_result: a1b2c3d4');
    expect(toolSummary('mcp__cosyee__delegate_status', { conversation_id: cid })).toBe('delegate_status: a1b2c3d4');
    expect(toolSummary('mcp__cosyee__delegate_send', { message: '只有消息' })).toBe('delegate_send: 只有消息');
  });
});

describe('委派子代理工具归一化', () => {
  it('实时事件：read_file 归一化为 Read，带 file_path 与格式化摘要', () => {
    const s = play(
      [
        {
          type: 'assistant',
          parent_tool_use_id: D,
          message: {
            id: 'agy-1',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'agy_D_1', name: 'read_file', input: { Path: 'F:\\a.ts' } }],
          },
        },
      ],
      launchedAndDone(),
    );
    const step = runOf(s).turn.steps[0];
    expect(step).toMatchObject({
      kind: 'tool',
      name: 'Read',
      input: { file_path: 'F:\\a.ts' },
      summary: 'Read: F:\\a.ts',
    });
  });

  it('过程记录：subagentTurnFromHistory 里的 run_command 归一化为 Bash', () => {
    const t = subagentTurnFromHistory(
      [
        {
          type: 'assistant',
          timestamp: '2026-11-16T10:00:01.000Z',
          message: {
            id: 'a',
            role: 'assistant',
            content: [{ type: 'tool_use', id: 't1', name: 'run_command', input: { CommandLine: 'npm test', toolSummary: 'Run tests' } }],
          },
        },
      ],
      { title: 'x', toolUseId: D },
    );
    expect(t.steps[0]).toMatchObject({
      kind: 'tool',
      name: 'Bash',
      input: { command: 'npm test', description: 'Run tests' },
      summary: 'Bash: npm test',
    });
  });
});
