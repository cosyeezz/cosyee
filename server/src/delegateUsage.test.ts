import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_PRICES, COSYEE_USAGE_SUBTYPE, type CachePoint, ZERO_COST, addCost, cosyeeUsageEvent, isCosyeeUsageEvent, pushCachePoint, requestCost, uncachedCost } from '@cosyee/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BackendRunOptions, DelegateBackend } from './delegate/backend.js';
import { N, parseTokenUsage } from './delegate/codexProtocol.js';
import { DelegateJobs } from './delegate/jobs.js';
import { delegateToolId } from './delegate/progress.js';
import { DelegateRecorder } from './delegate/record.js';
import { AgyUsageAdapter } from './delegate/usage/agyUsage.js';
import { ClaudeUsageAdapter } from './delegate/usage/claudeUsage.js';
import { CodexUsageAdapter } from './delegate/usage/codexUsage.js';
import { encodeCwd } from './paths.js';
import { Sessions } from './sessions.js';
import { DotState } from './state.js';
import { filterHistory, type Json } from './transcript.js';
import { StateStore } from './workspaces.js';

describe('CodexUsageAdapter', () => {
  it('parseTokenUsage 保留 modelContextWindow，缺失或非法时为 null', () => {
    const ok = parseTokenUsage({
      total: { totalTokens: 21286, inputTokens: 21135, cachedInputTokens: 16000, outputTokens: 151, reasoningOutputTokens: 40 },
      last: { totalTokens: 21286, inputTokens: 21135, cachedInputTokens: 16000, outputTokens: 151, reasoningOutputTokens: 40 },
      modelContextWindow: 258400,
    });
    expect(ok?.modelContextWindow).toBe(258400);

    const noWin = parseTokenUsage({
      total: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 0, outputTokens: 20, reasoningOutputTokens: 0 },
    });
    expect(noWin?.modelContextWindow).toBeNull();
  });

  it('口径换算、窗口、tools 归属与跨 turn id 唯一', () => {
    const a1 = new CodexUsageAdapter({ threadId: 'thr_1', model: 'gpt-5.4' });
    // 未收到 modelContextWindow 前按模型推算
    expect(a1.window()).toBe(1_050_000);

    // turn/started 写入 turnId
    expect(a1.push({ method: N.turnStarted, params: { threadId: 'thr_1', turn: { id: 'turn_1', status: 'inProgress' } } })).toEqual([]);

    // 第一次请求期间发出两个工具调用
    expect(a1.push({ sessionUpdate: 'tool_call', toolCallId: 'cmd_1' })).toEqual([]);
    expect(a1.push({ sessionUpdate: 'tool_call', toolCallId: 'patch_1:0' })).toEqual([]);
    // 重复 toolCallId 去重
    expect(a1.push({ sessionUpdate: 'tool_call', toolCallId: 'cmd_1' })).toEqual([]);

    // 本机 rollout 样本：inputTokens 21135（含 cached 15000）+ outputTokens 151（已含 reasoning 42）= total 21286
    const pts1 = a1.push({
      method: N.threadTokenUsage,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        tokenUsage: {
          total: { totalTokens: 21286, inputTokens: 21135, cachedInputTokens: 15000, outputTokens: 151, reasoningOutputTokens: 42 },
          last: { totalTokens: 21286, inputTokens: 21135, cachedInputTokens: 15000, outputTokens: 151, reasoningOutputTokens: 42 },
          modelContextWindow: 272000,
        },
      },
    });
    expect(pts1).toHaveLength(1);
    expect(a1.window()).toBe(272000);
    expect(pts1[0]).toEqual({
      id: 'codex:thr_1:turn_1:1',
      turn: 0,
      input: 6135, // 21135 - 15000
      create: 0,
      read: 15000,
      rate: (15000 / 21135) * 100,
      output: 151,
      tools: ['cmd_1', 'patch_1:0'],
      model: 'gpt-5.4',
    });

    // 同 turn 第二次请求：没有新工具调用，tools 不存在，序号递增
    const pts2 = a1.push({
      method: N.threadTokenUsage,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_1',
        tokenUsage: {
          total: { totalTokens: 43000, inputTokens: 42000, cachedInputTokens: 35000, outputTokens: 1000, reasoningOutputTokens: 100 },
          last: { totalTokens: 21714, inputTokens: 20865, cachedInputTokens: 20000, outputTokens: 849, reasoningOutputTokens: 58 },
          modelContextWindow: 272000,
        },
      },
    });
    expect(pts2).toHaveLength(1);
    expect(pts2[0]!.id).toBe('codex:thr_1:turn_1:2');
    expect(pts2[0]!.tools).toBeUndefined();
    expect(pts2[0]!.input).toBe(865);
    expect(pts2[0]!.read).toBe(20000);

    // 续跑（delegate_send 第二轮）：不同 turnId，id 全局唯一
    const a2 = new CodexUsageAdapter({ threadId: 'thr_1', turnId: 'turn_2', model: 'gpt-5.4' });
    const pts3 = a2.push({
      method: N.threadTokenUsage,
      params: {
        threadId: 'thr_1',
        turnId: 'turn_2',
        tokenUsage: {
          total: { totalTokens: 50000, inputTokens: 48000, cachedInputTokens: 40000, outputTokens: 2000, reasoningOutputTokens: 200 },
          last: { totalTokens: 7000, inputTokens: 6000, cachedInputTokens: 5000, outputTokens: 1000, reasoningOutputTokens: 100 },
          modelContextWindow: 272000,
        },
      },
    });
    expect(pts3).toHaveLength(1);
    expect(pts3[0]!.id).toBe('codex:thr_1:turn_2:1');
    expect(new Set([pts1[0]!.id, pts2[0]!.id, pts3[0]!.id]).size).toBe(3);
  });
});

describe('ClaudeUsageAdapter', () => {
  it('同 message.id 跨帧去重合并 tools 与 output，result.modelUsage 覆盖窗口', () => {
    const adapter = new ClaudeUsageAdapter();

    // 1. message_start
    const p1 = adapter.push({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_01A',
          model: 'claude-sonnet-4-5-20250929',
          usage: { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1400, output_tokens: 5 },
          content: [],
        },
      },
    });
    expect(p1).toHaveLength(1);
    expect(adapter.window()).toBe(200_000);
    expect(p1[0]).toMatchObject({
      id: 'msg_01A',
      turn: 0,
      input: 100,
      create: 500,
      read: 1400,
      rate: 70,
      output: 5,
      model: 'claude-sonnet-4-5-20250929',
    });

    // 2. content_block_start (tool_use) + assistant 分段帧（带 tool_use，较低 output 不回退）
    const p2 = adapter.push({
      type: 'stream_event',
      event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'Read' } },
    });
    expect(p2).toHaveLength(1);
    expect(p2[0]!.tools).toEqual(['toolu_a']);

    // 3. message_delta 带来最终 output_tokens
    const p3 = adapter.push({
      type: 'stream_event',
      event: { type: 'message_delta', usage: { output_tokens: 120 } },
    });
    expect(p3).toHaveLength(1);
    expect(p3[0]!.output).toBe(120);
    expect(p3[0]!.tools).toEqual(['toolu_a']);

    // 4. assistant 帧带第二个 tool_use，但 usage.output_tokens 更小（50 < 120），output 应取较大值
    const p4 = adapter.push({
      type: 'assistant',
      message: {
        id: 'msg_01A',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1400, output_tokens: 50 },
        content: [
          { type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} },
          { type: 'tool_use', id: 'toolu_b', name: 'Grep', input: {} },
        ],
      },
    });
    expect(p4).toHaveLength(1);
    expect(p4[0]!.output).toBe(120);
    expect(p4[0]!.tools).toEqual(['toolu_a', 'toolu_b']);

    // 完全相同的 assistant 帧再推一次不重复发出
    const p4dup = adapter.push({
      type: 'assistant',
      message: {
        id: 'msg_01A',
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 100, cache_creation_input_tokens: 500, cache_read_input_tokens: 1400, output_tokens: 50 },
        content: [{ type: 'tool_use', id: 'toolu_a', name: 'Read', input: {} }],
      },
    });
    expect(p4dup).toEqual([]);

    // 5. result 帧带 1M 上下文窗口：window() 更新并重发最近一点通知前端新窗口
    const p5 = adapter.push({
      type: 'result',
      modelUsage: { 'claude-sonnet-4-5-20250929': { contextWindow: 1_000_000 } },
    });
    expect(adapter.window()).toBe(1_000_000);
    expect(p5).toHaveLength(1);
    expect(p5[0]!.id).toBe('msg_01A');
  });
});

describe('AgyUsageAdapter', () => {
  it('按 acp-trace.jsonl 实测数字验证两轮分摊、tools 归属与单次请求去 estimated', () => {
    const cache: CachePoint[] = [];

    // ── 第一轮：两次请求（used 10273、11198），合计 input 12865 / output 692 / cachedRead 7914 / cachedWrite 0 ──
    const t1 = new AgyUsageAdapter({ sessionId: 'sess_1', turnId: 't1', model: 'gemini-4-neon-high' });

    // 轮初 used: 0 跳过，但记录窗口 size
    expect(t1.push({ sessionUpdate: 'usage_update', used: 0, size: 1048576 })).toEqual([]);
    expect(t1.window()).toBe(1048576);

    // 第一次请求结束：先到 usage_update(10273)
    const r1Init = t1.push({ sessionUpdate: 'usage_update', used: 10273, size: 1048576 });
    expect(r1Init).toHaveLength(1);
    expect(r1Init[0]).toMatchObject({ input: 10273, create: 0, read: 0, output: 0, rate: 0, estimated: true, model: 'gemini-4-neon-high', turn: 0 });
    for (const p of r1Init) pushCachePoint(cache, p);

    // 紧接着两个 tool_call 归属到第一次请求
    const r1Tool1 = t1.push({ sessionUpdate: 'tool_call', toolCallId: 'call_17226190870861409422' });
    const r1Tool2 = t1.push({ sessionUpdate: 'tool_call', toolCallId: 'call_17226190870861409213' });
    expect(r1Tool1).toHaveLength(1);
    expect(r1Tool2).toHaveLength(1);
    expect(r1Tool2[0]!.id).toBe(r1Init[0]!.id);
    expect(r1Tool2[0]!.tools).toEqual(['call_17226190870861409422', 'call_17226190870861409213']);
    for (const p of [...r1Tool1, ...r1Tool2]) pushCachePoint(cache, p);

    // 第二次请求结束：usage_update(11198)
    const r2Init = t1.push({ sessionUpdate: 'usage_update', used: 11198, size: 1048576 });
    expect(r2Init).toHaveLength(1);
    expect(r2Init[0]!.id).not.toBe(r1Init[0]!.id);
    expect(r2Init[0]!.tools).toBeUndefined();
    for (const p of r2Init) pushCachePoint(cache, p);

    // PromptResponse 到达：按 10273 : 11198 分摊本轮合计，整数化总和严格等于合计，保留 estimated: true
    const t1Final = t1.push({
      type: 'prompt_response',
      usage: { inputTokens: 12865, outputTokens: 692, cachedReadTokens: 7914, cachedWriteTokens: 0, thoughtTokens: 305, totalTokens: 21471 },
    });
    expect(t1Final).toHaveLength(2);
    expect(t1Final[0]!.id).toBe(r1Init[0]!.id);
    expect(t1Final[1]!.id).toBe(r2Init[0]!.id);
    expect(t1Final[0]!.estimated).toBe(true);
    expect(t1Final[1]!.estimated).toBe(true);
    expect(t1Final[0]!.tools).toEqual(['call_17226190870861409422', 'call_17226190870861409213']);
    expect(t1Final[1]!.tools).toBeUndefined();
    // 整数且各项之和严格等于本轮合计
    expect(t1Final[0]!.input + t1Final[1]!.input).toBe(12865);
    expect(t1Final[0]!.read + t1Final[1]!.read).toBe(7914);
    expect(t1Final[0]!.create + t1Final[1]!.create).toBe(0);
    expect((t1Final[0]!.output ?? 0) + (t1Final[1]!.output ?? 0)).toBe(692);
    expect(Number.isInteger(t1Final[0]!.input) && Number.isInteger(t1Final[1]!.input)).toBe(true);
    for (const p of t1Final) pushCachePoint(cache, p);

    // ── 第二轮：单次请求（used 11341），合计 input 2514 / output 68 / cachedRead 8759 / cachedWrite 0 ──
    const t2 = new AgyUsageAdapter({ sessionId: 'sess_1', turnId: 't2', model: 'gemini-4-neon-high' });
    const r3Init = t2.push({ sessionUpdate: 'usage_update', used: 11341, size: 1048576 });
    expect(r3Init).toHaveLength(1);
    expect(r3Init[0]!.estimated).toBe(true);
    for (const p of r3Init) pushCachePoint(cache, p);

    const t2Final = t2.push({
      type: 'prompt_response',
      usage: { inputTokens: 2514, outputTokens: 68, cachedReadTokens: 8759, cachedWriteTokens: 0, thoughtTokens: 16, totalTokens: 11341 },
    });
    expect(t2Final).toHaveLength(1);
    expect(t2Final[0]!.id).toBe(r3Init[0]!.id);
    expect(t2Final[0]!.estimated).toBeUndefined();
    expect(t2Final[0]).toEqual({
      id: r3Init[0]!.id,
      turn: 0,
      input: 2514,
      create: 0,
      read: 8759,
      rate: (8759 / (2514 + 8759)) * 100,
      output: 68,
      model: 'gemini-4-neon-high',
    });
    for (const p of t2Final) pushCachePoint(cache, p);

    // 通过前端 pushCachePoint 归约后一共 3 个点，第二轮的 estimated 已被清除
    expect(cache).toHaveLength(3);
    expect(cache[2]!.estimated).toBeUndefined();
    expect(cache[2]!.read).toBe(8759);
  });
});

describe('DelegateJobs + DelegateRecorder + 历史接口', () => {
  let tmp: string;
  let prevConfigDir: string | undefined;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-du-'));
    prevConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  });
  afterEach(() => {
    if (prevConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevConfigDir;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const SID = '22222222-2222-4222-8222-222222222222';
  const TOOL_USE_ID = 'toolu_delegate_1';

  const stubBackend: DelegateBackend = {
    id: 'agy',
    label: 'Antigravity',
    available: () => true,
    models: async () => ({ models: [], current: null, at: 0 }),
    run: async () => ({ stopReason: 'end_turn', response: 'ok', sessionId: 's1', toolCalls: 0 }),
  };

  it('jobs 把 onUsage 转成 cosyee_usage（含 tools id 换算）、落盘并由历史接口原样返回', async () => {
    const recDir = path.join(tmp, 'records');
    const cwd = path.join(tmp, 'ws');
    fs.mkdirSync(cwd, { recursive: true });
    // 准备一个主会话 jsonl 让 Sessions.locate 能找到会话
    const projDir = path.join(tmp, 'claude', 'projects', encodeCwd(cwd));
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${SID}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'hi' } }) + '\n');

    const recorder = new DelegateRecorder(recDir);
    const emitted: Json[] = [];
    const jobs = new DelegateJobs({
      onEvents: (evs) => {
        emitted.push(...evs);
        recorder.write(SID, evs);
      },
      run: async (o: BackendRunOptions) => {
        o.onUpdate?.({ sessionUpdate: 'tool_call', toolCallId: 'call_1', name: 'Read', rawInput: { path: 'a.ts' } });
        o.onUsage?.(
          { id: 'req_1', turn: 0, input: 1000, create: 0, read: 500, rate: (500 / 1500) * 100, output: 80, model: 'gpt-5.4', tools: ['call_1'] },
          272000,
        );
        o.onUpdate?.({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', rawOutput: 'done' });
        return { stopReason: 'end_turn', response: '完成', sessionId: 'b_sess_1', toolCalls: 1 };
      },
    });

    await jobs.callTool(
      'delegate',
      { prompt: '检查文件', run_in_background: false },
      { cwd, backend: stubBackend, agents: { cwd, configDir: tmp, disabled: [] } },
      TOOL_USE_ID,
      new AbortController().signal,
    );

    const usageEvs = emitted.filter(isCosyeeUsageEvent);
    expect(usageEvs).toHaveLength(1);
    expect(usageEvs[0]).toEqual({
      type: 'system',
      subtype: COSYEE_USAGE_SUBTYPE,
      parent_tool_use_id: TOOL_USE_ID,
      point: {
        id: 'req_1',
        turn: 0,
        input: 1000,
        create: 0,
        read: 500,
        rate: (500 / 1500) * 100,
        output: 80,
        model: 'gpt-5.4',
        tools: [delegateToolId(TOOL_USE_ID, 'call_1')],
      },
      window: 272000,
    });

    // 与 AcpProgress 产出的 tool_use.id 完全一致
    const toolUseEv = emitted.find((e) => e.type === 'assistant' && e.message?.content?.[0]?.type === 'tool_use');
    expect(toolUseEv?.message.content[0].id).toBe(usageEvs[0]!.point.tools![0]);

    // 落盘后用新 DelegateRecorder 实例与 Sessions.subagent 读回
    await recorder.read(SID, TOOL_USE_ID);
    const freshRec = new DelegateRecorder(recDir);
    const sessions = new Sessions(new DotState(new StateStore(path.join(tmp, 'state.json'))), {
      isDeleted: () => false,
      pinKind: () => null,
      delegateEntries: (sid, tid) => freshRec.read(sid, tid),
    });
    const entries = await sessions.subagent(SID, TOOL_USE_ID, cwd);
    const diskUsage = entries.filter(isCosyeeUsageEvent);
    expect(diskUsage).toHaveLength(1);
    expect(diskUsage[0]!.point).toEqual(usageEvs[0]!.point);
    expect(diskUsage[0]!.window).toBe(272000);
  });

  it('HistoryFilter 放行 cosyee_usage 且保留原生子代理 assistant 的 usage / id / model / tool_use', () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        subtype: COSYEE_USAGE_SUBTYPE,
        parent_tool_use_id: TOOL_USE_ID,
        point: { id: 'p1', turn: 0, input: 10, create: 0, read: 90, rate: 90, output: 5 },
        window: 200000,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'msg_sub_1',
          model: 'claude-sonnet-4-5-20250929',
          usage: {
            input_tokens: 100,
            output_tokens: 40,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 700,
            cache_creation: { ephemeral_1h_input_tokens: 50 },
            speed: 'fast',
            inference_geo: 'us',
            extra_ignored: 123,
          },
          content: [{ type: 'tool_use', id: 'toolu_sub_1', name: 'Read', input: { file_path: 'a.ts' } }],
        },
      }),
    ];
    const filtered = filterHistory(lines);
    expect(filtered).toHaveLength(2);
    expect(isCosyeeUsageEvent(filtered[0])).toBe(true);
    expect(filtered[1]!.message).toEqual({
      id: 'msg_sub_1',
      model: 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 700,
        cache_creation: { ephemeral_1h_input_tokens: 50 },
        speed: 'fast',
        inference_geo: 'us',
      },
      content: [{ type: 'tool_use', id: 'toolu_sub_1', name: 'Read', input: { file_path: 'a.ts' } }],
    });
  });

  it('subagentCosts：委派记录计价/去重/source、原生返回 points 跨行合并 tools、forkChain 沿源会话查找', async () => {
    const recDir = path.join(tmp, 'records');
    const cwd = path.join(tmp, 'ws-costs');
    fs.mkdirSync(cwd, { recursive: true });
    const projDir = path.join(tmp, 'claude', 'projects', encodeCwd(cwd));
    const SRC_SID = '33333333-3333-4333-8333-333333333333';
    const FORK_SID = '44444444-4444-4444-8444-444444444444';
    const subDir = path.join(projDir, SRC_SID, 'subagents');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, `${SRC_SID}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'src' } }) + '\n');
    fs.writeFileSync(path.join(projDir, `${FORK_SID}.jsonl`), JSON.stringify({ type: 'user', cwd, message: { role: 'user', content: 'fork' } }) + '\n');

    // 原生子代理放在源会话里：同 message.id 分两行，各自带一个 tool_use，第二行带来更大 output
    fs.writeFileSync(path.join(subDir, 'agent-n1.meta.json'), JSON.stringify({ toolUseId: 'toolu_native_1', agentType: 'Explore' }));
    fs.writeFileSync(
      path.join(subDir, 'agent-n1.jsonl'),
      [
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_n1',
            model: 'claude-sonnet-4-5-20250929',
            usage: { input_tokens: 1000, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
            content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: {} }],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_n1',
            model: 'claude-sonnet-4-5-20250929',
            usage: { input_tokens: 1000, output_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000 },
            content: [{ type: 'tool_use', id: 'tu_2', name: 'Grep', input: {} }],
          },
        }),
      ].join('\n') + '\n',
    );

    const recorder = new DelegateRecorder(recDir);
    // 源会话里的 codex 委派（有 jobs.json + ids 映射；同 id 两条事件后到覆盖）
    const convCodex = 'dlg_aaaaaaaaaaaaaaaaaaaaaaaa';
    await recorder.saveId(convCodex, { backend: 'codex', agent: 'code-reviewer', cwd, createdAt: 1 });
    await recorder.saveJobs(SRC_SID, {
      jobs: [{ conversationId: convCodex, toolUseId: 'toolu_dlg_codex', description: 'review', agent: 'code-reviewer', background: true, state: 'done', startedAt: 1 }],
      pendingNotifications: [],
    });
    recorder.write(SRC_SID, [
      cosyeeUsageEvent('toolu_dlg_codex', { id: 'codex:t1:turn1:1', turn: 0, input: 500, create: 0, read: 500, rate: 50, output: 10, model: 'gpt-5.4', tools: ['agy_toolu_dlg_codex_c1'] }, 272000),
      // 同 id 重发：更新 output 与 tools
      cosyeeUsageEvent('toolu_dlg_codex', { id: 'codex:t1:turn1:1', turn: 0, input: 500, create: 0, read: 500, rate: 50, output: 80, model: 'gpt-5.4', tools: ['agy_toolu_dlg_codex_c2'] }, 272000),
    ]);

    // 分支会话里的 agy 委派（没有 jobs.json：agentId 回退 toolUseId，source 从 point.id 前缀推算）
    recorder.write(FORK_SID, [
      cosyeeUsageEvent('toolu_dlg_agy', { id: 'agy:s1:t1:1', turn: 0, input: 10000, create: 0, read: 0, rate: 0, output: 0, model: 'gemini-2.5-pro', estimated: true }, 1048576),
      // PromptResponse 分摊后同 id 覆盖，单次请求去掉 estimated
      cosyeeUsageEvent('toolu_dlg_agy', { id: 'agy:s1:t1:1', turn: 0, input: 2000, create: 0, read: 7500, rate: (7500 / 9500) * 100, output: 500, model: 'gemini-2.5-pro' }, 1048576),
    ]);

    const sessions = new Sessions(new DotState(new StateStore(path.join(tmp, 'state.json'))), {
      isDeleted: () => false,
      pinKind: () => null,
      forkSrcOf: (sid) => (sid === FORK_SID ? SRC_SID : null),
      delegateEntries: (sid, tid) => recorder.read(sid, tid),
      delegateUsages: (sid) => recorder.listUsage(sid),
    });

    const items = await sessions.subagentCosts(FORK_SID, cwd, BUILTIN_PRICES);
    expect(items).toHaveLength(3);

    // 1. 原生子代理（从源会话继承）：source='native'，points 合并了 tu_1 / tu_2，output 取 150
    const nat = items.find((i) => i.agentId === 'n1')!;
    expect(nat).toMatchObject({
      agentId: 'n1',
      toolUseId: 'toolu_native_1',
      agentType: 'Explore',
      source: 'native',
      requests: 1,
      unpriced: 0,
      models: ['claude-sonnet-4-5-20250929'],
    });
    expect(nat.points).toHaveLength(1);
    expect(nat.points![0]).toMatchObject({ id: 'msg_n1', turn: 0, input: 1000, create: 0, read: 4000, output: 150, tools: ['tu_1', 'tu_2'] });
    const natReq = { model: 'claude-sonnet-4-5-20250929', input: 1000, create: 0, create1h: 0, read: 4000, output: 150 };
    expect(nat.cost).toEqual(requestCost(BUILTIN_PRICES, natReq));

    // 2. 源会话里的 codex 委派：去重后 1 条请求，source='codex'，agentType='code-reviewer'
    const cdx = items.find((i) => i.toolUseId === 'toolu_dlg_codex')!;
    expect(cdx).toMatchObject({
      agentId: convCodex,
      toolUseId: 'toolu_dlg_codex',
      agentType: 'code-reviewer',
      source: 'codex',
      requests: 1,
      models: ['gpt-5.4'],
    });
    expect(cdx.points).toHaveLength(1);
    expect(cdx.points![0]).toMatchObject({ id: 'codex:t1:turn1:1', output: 80, tools: ['agy_toolu_dlg_codex_c1', 'agy_toolu_dlg_codex_c2'] });
    const cdxReq = { model: 'gpt-5.4', input: 500, create: 0, create1h: 0, read: 500, output: 80 };
    const cdxCost = requestCost(BUILTIN_PRICES, cdxReq);
    if (cdxCost) {
      expect(cdx.cost).toEqual(addCost(ZERO_COST, cdxCost));
      expect(cdx.uncached).toBeCloseTo(uncachedCost(BUILTIN_PRICES, cdxReq)!, 12);
    } else {
      expect(cdx.unpriced).toBe(1);
    }

    // 3. 分支会话里的 agy 委派：后到覆盖，source='agy'，agentId=toolUseId，无 agentType
    const agy = items.find((i) => i.toolUseId === 'toolu_dlg_agy')!;
    expect(agy).toMatchObject({
      agentId: 'toolu_dlg_agy',
      toolUseId: 'toolu_dlg_agy',
      source: 'agy',
      requests: 1,
      models: ['gemini-2.5-pro'],
    });
    expect(agy.agentType).toBeUndefined();
    expect(agy.points).toHaveLength(1);
    expect(agy.points![0]).toMatchObject({ id: 'agy:s1:t1:1', input: 2000, read: 7500, output: 500 });
    expect(agy.points![0]!.estimated).toBeUndefined();
  });
});
