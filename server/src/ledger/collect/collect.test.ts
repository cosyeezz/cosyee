import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgyQuota, CachePoint, UsageInfo } from '@cosyee/shared';
import { CodexAccounts } from '../../accounts/codex.js';
import type { BackendResult, BackendRunOptions, DelegateBackend } from '../../delegate/backend.js';
import { DelegateJobs } from '../../delegate/jobs.js';
import type { StateStore } from '../../workspaces.js';
import { FIVE_HOURS_MS, type LedgerRequest, type LedgerSink, type LedgerSnapshot, WEEK_MS, setLedgerSink } from '../sink.js';
import { recordAgyQuotaSnapshot } from './agy.js';
import { ClaudeSessionCollector } from './claudeSession.js';
import { recordClaudeRateLimitEvent, recordClaudeUsageSnapshot } from './claudeSnapshots.js';
import { clearActivityForTest, recordActivity } from './common.js';
import { KiroBalanceCollector, recordKiroBalanceSnapshot } from './kiro.js';
import { startLedgerProbes, wrapClaudeUsageFetch } from './probes.js';

/** 内存账本 sink：模拟账本核心的按 backend+id upsert（token 取较大值） */
class MemoryLedgerSink implements LedgerSink {
  readonly requests: LedgerRequest[] = [];
  readonly byKey = new Map<string, LedgerRequest>();
  readonly snapshots: LedgerSnapshot[] = [];

  record(r: LedgerRequest): void {
    this.requests.push({ ...r });
    const key = `${r.backend}\0${r.id}`;
    const prev = this.byKey.get(key);
    if (!prev) {
      this.byKey.set(key, { ...r });
      return;
    }
    this.byKey.set(key, {
      ...prev,
      ...r,
      at: prev.at,
      input: Math.max(prev.input, r.input),
      create5m: Math.max(prev.create5m, r.create5m),
      create1h: Math.max(prev.create1h, r.create1h),
      read: Math.max(prev.read, r.read),
      output: Math.max(prev.output, r.output),
      reasoning: Math.max(prev.reasoning, r.reasoning),
    });
  }

  snapshot(s: LedgerSnapshot): void {
    this.snapshots.push({ ...s });
  }
}

let sink: MemoryLedgerSink;

beforeEach(() => {
  sink = new MemoryLedgerSink();
  setLedgerSink(sink);
  clearActivityForTest();
});

afterEach(() => {
  setLedgerSink(null);
  clearActivityForTest();
  vi.useRealTimers();
});

describe('ClaudeSessionCollector 主会话与原生子代理采集', () => {
  it('分层记录主代理与原生子代理、按 message.id 去重并用 message_delta 补齐 output', () => {
    let t = 1_700_000_000_000;
    const collector = new ClaudeSessionCollector({
      sessionId: 'sess-1',
      cwd: '/repo',
      account: 'default',
      accountKind: 'subscription',
      getEffort: () => 'high',
      now: () => (t += 10),
    });

    // 1. 主代理 message_start（初始 output=1，含 1h 缓存）
    collector.onEvent({
      type: 'stream_event',
      event: {
        type: 'message_start',
        message: {
          id: 'msg_main_1',
          model: 'claude-opus-5-20260101',
          usage: {
            input_tokens: 100,
            cache_creation_input_tokens: 500,
            cache_read_input_tokens: 2000,
            output_tokens: 1,
            cache_creation: { ephemeral_1h_input_tokens: 300 },
            speed: 'fast',
            inference_geo: 'us',
          },
        },
      },
    });

    // 2. 主代理 message_delta 补齐最终 output=420
    collector.onEvent({
      type: 'stream_event',
      event: {
        type: 'message_delta',
        usage: { output_tokens: 420 },
      },
    });

    // 3. 主代理 assistant 帧发起原生子代理 Agent 工具调用
    collector.onEvent({
      type: 'assistant',
      message: {
        id: 'msg_main_1',
        model: 'claude-opus-5-20260101',
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 500,
          cache_read_input_tokens: 2000,
          output_tokens: 420,
          cache_creation: { ephemeral_1h_input_tokens: 300 },
          speed: 'fast',
          inference_geo: 'us',
        },
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent_1',
            name: 'Agent',
            input: { subagent_type: 'Explore', effort: 'medium' },
          },
        ],
      },
    });

    // 4. 原生子代理 assistant 帧（带 parent_tool_use_id）
    collector.onEvent({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent_1',
      agent_id: 'ag123',
      subagent_type: 'Explore',
      message: {
        id: 'msg_sub_1',
        model: 'claude-sonnet-5-5',
        usage: {
          input_tokens: 50,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 800,
          output_tokens: 12,
        },
        content: [{ type: 'text', text: 'hi' }],
      },
    });

    const mainReq = sink.byKey.get('claude\0msg_main_1');
    expect(mainReq).toBeDefined();
    expect(mainReq).toMatchObject({
      backend: 'claude',
      id: 'msg_main_1',
      account: 'default',
      accountKind: 'subscription',
      session: 'sess-1',
      layer: 'main',
      agent: null,
      toolUseId: null,
      model: 'claude-opus-5-20260101',
      effort: 'high',
      input: 100,
      create5m: 200,
      create1h: 300,
      read: 2000,
      output: 420,
      fast: true,
      usGeo: true,
      estimated: false,
    });

    const subReq = sink.byKey.get('claude\0msg_sub_1');
    expect(subReq).toBeDefined();
    expect(subReq).toMatchObject({
      backend: 'claude',
      id: 'msg_sub_1',
      layer: 'native',
      agent: 'Explore',
      toolUseId: 'toolu_agent_1',
      model: 'claude-sonnet-5-5',
      effort: 'medium',
      input: 50,
      create5m: 0,
      create1h: 0,
      read: 800,
      output: 12,
    });

    collector.dispose();
  });

  it('原生子代理结束后异步读取 subagents/agent-<agentId>.jsonl 补齐最终 output', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-ledger-sub-'));
    try {
      const subDir = path.join(tmpDir, 'sess-sub', 'subagents');
      fs.mkdirSync(subDir, { recursive: true });
      const agentFile = path.join(subDir, 'agent-abc999.jsonl');
      const lines = [
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_sub_final',
            model: 'claude-sonnet-5-5',
            usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, output_tokens: 5 },
            content: [],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          message: {
            id: 'msg_sub_final',
            model: 'claude-sonnet-5-5',
            usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, output_tokens: 950 },
            content: [{ type: 'text', text: 'done' }],
          },
        }),
      ];
      fs.writeFileSync(agentFile, lines.join('\n') + '\n', 'utf8');

      const collector = new ClaudeSessionCollector({
        sessionId: 'sess-sub',
        cwd: '/repo',
        account: 'default',
        accountKind: 'subscription',
        locateSession: async () => ({ file: path.join(tmpDir, 'sess-sub.jsonl'), dir: tmpDir }),
        subagentBackfillDelayMs: 10,
      });

      collector.onEvent({
        type: 'assistant',
        message: {
          id: 'msg_m',
          model: 'claude-opus-5',
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 30 },
          content: [{ type: 'tool_use', id: 'toolu_s1', name: 'Agent', input: { subagent_type: 'Plan' } }],
        },
      });
      // stdout 收到初始 output=5
      collector.onEvent({
        type: 'assistant',
        parent_tool_use_id: 'toolu_s1',
        message: {
          id: 'msg_sub_final',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 600, output_tokens: 5 },
          content: [],
        },
      });
      expect(sink.byKey.get('claude\0msg_sub_final')?.output).toBe(5);

      // 主代理 user tool_result 带着 toolUseResult.agentId 到达
      collector.onEvent({
        type: 'user',
        toolUseResult: { agentId: 'abc999' },
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'toolu_s1', content: 'ok' }],
        },
      });

      await new Promise((r) => setTimeout(r, 80));
      const updated = sink.byKey.get('claude\0msg_sub_final');
      expect(updated?.output).toBe(950);
      expect(updated?.layer).toBe('native');
      expect(updated?.agent).toBe('Plan');
      collector.dispose();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('internal 差额：正差额入账、负/零不记、原生子代理纯 output 滞后不重复计费', () => {
    const collector = new ClaudeSessionCollector({
      sessionId: 'sess-int',
      cwd: '/repo',
      account: 'default',
      accountKind: 'subscription',
    });

    // 本轮主代理：opus input=100, read=500, output=80
    collector.onEvent({
      type: 'assistant',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        usage: { input_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 500, output_tokens: 80 },
        content: [{ type: 'tool_use', id: 'toolu_n1', name: 'Agent', input: { subagent_type: 'Explore' } }],
      },
    });
    // 本轮原生子代理：sonnet input=50, read=200, stdout 初始 output=5
    collector.onEvent({
      type: 'assistant',
      parent_tool_use_id: 'toolu_n1',
      message: {
        id: 'msg_n1',
        model: 'claude-sonnet-5',
        usage: { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 200, output_tokens: 5 },
        content: [],
      },
    });

    // result 帧：
    // - haiku 有额外内部调用（自动标题）：input=300, output=20 → 记 internal
    // - opus 总量小于等于已入账（零/负差额）→ 不记
    // - sonnet 输入/缓存吻合，仅 output 多 400（子代理滞后）→ 不记 internal，防重复计费
    collector.onEvent({
      type: 'result',
      uuid: 'res-uuid-1',
      model_usage_since_last_result: {
        'claude-opus-5': { inputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 500, outputTokens: 70 },
        'claude-sonnet-5': { inputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 200, outputTokens: 405 },
        'claude-haiku-5': { inputTokens: 300, cacheCreationInputTokens: 10, cacheReadInputTokens: 0, outputTokens: 20 },
      },
    });

    const internals = [...sink.byKey.values()].filter((r) => r.layer === 'internal');
    expect(internals).toHaveLength(1);
    expect(internals[0]).toMatchObject({
      backend: 'claude',
      id: 'sess-int:internal:res-uuid-1:claude-haiku-5',
      layer: 'internal',
      model: 'claude-haiku-5',
      input: 300,
      create5m: 10,
      create1h: 0,
      read: 0,
      output: 20,
    });

    collector.dispose();
  });
});

describe('额度快照采集（Claude / Codex / agy / Kiro）', () => {
  it('Claude rate_limit_event 正确换算 5h / 7d / scoped 与秒→毫秒、小数→百分比', () => {
    const at = 1_700_000_000_000;
    recordClaudeRateLimitEvent(
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          unifiedWindows: {
            five_hour: { utilization: 0.425, resetsAt: 1_700_010_000 },
            seven_day: { utilization: 0.18, resetsAt: 1_700_500_000 },
            seven_day_opus: { utilization: 0.75, resetsAt: 1_700_500_000 },
          },
        },
      },
      'acc-1',
      'subscription',
      at,
    );

    expect(sink.snapshots).toHaveLength(3);
    expect(sink.snapshots).toEqual([
      {
        backend: 'claude',
        account: 'acc-1',
        accountKind: 'subscription',
        kind: 'session',
        group: null,
        at,
        percent: 42.5,
        resetsAt: 1_700_010_000_000,
        windowMs: FIVE_HOURS_MS,
        source: 'event',
      },
      {
        backend: 'claude',
        account: 'acc-1',
        accountKind: 'subscription',
        kind: 'weekly',
        group: null,
        at,
        percent: 18,
        resetsAt: 1_700_500_000_000,
        windowMs: WEEK_MS,
        source: 'event',
      },
      {
        backend: 'claude',
        account: 'acc-1',
        accountKind: 'subscription',
        kind: 'scoped',
        group: 'opus',
        at,
        percent: 75,
        resetsAt: 1_700_500_000_000,
        windowMs: WEEK_MS,
        source: 'event',
      },
    ]);

    // API 账号不记订阅快照
    recordClaudeRateLimitEvent(
      { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1_700_010_000 } } } },
      'api-1',
      'api',
      at,
    );
    expect(sink.snapshots).toHaveLength(3);
  });

  it('Codex noteRateLimits 正确写入 primary(300m) / secondary(10080m) 快照', () => {
    const fakeStore = {
      state: { codexAccounts: { active: null, list: [] } },
      save: vi.fn(),
    } as unknown as StateStore;

    const accounts = new CodexAccounts({
      store: fakeStore,
      now: () => 1_700_000_000_000,
      resolveCodex: () => null,
    });

    accounts.noteRateLimits('default', {
      rateLimits: {
        limitId: 'codex',
        planType: 'plus',
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_700_018_000 },
        secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1_700_600_000 },
      },
    });

    expect(sink.snapshots).toEqual([
      {
        backend: 'codex',
        account: 'default',
        accountKind: 'subscription',
        kind: 'session',
        group: null,
        at: 1_700_000_000_000,
        percent: 25,
        resetsAt: 1_700_018_000_000,
        windowMs: 300 * 60_000,
        source: 'event',
      },
      {
        backend: 'codex',
        account: 'default',
        accountKind: 'subscription',
        kind: 'weekly',
        group: null,
        at: 1_700_000_000_000,
        percent: 60,
        resetsAt: 1_700_600_000_000,
        windowMs: 10080 * 60_000,
        source: 'event',
      },
    ]);
    accounts.dispose();
  });

  it('agy 额度写入 group×bucket 快照', () => {
    const now = 1_700_000_000_000;
    const quota: AgyQuota = {
      at: now,
      groups: [
        {
          name: 'Gemini',
          buckets: [
            { window: '5h', percent: 30, severity: 'normal', resetsAt: now + FIVE_HOURS_MS },
            { window: 'weekly', percent: 15, severity: 'normal', resetsAt: now + WEEK_MS },
          ],
        },
      ],
    };
    recordAgyQuotaSnapshot('agy-1', quota);
    expect(sink.snapshots).toHaveLength(2);
    expect(sink.snapshots[0]).toMatchObject({ backend: 'agy', account: 'agy-1', kind: 'session', group: 'Gemini', percent: 30 });
    expect(sink.snapshots[1]).toMatchObject({ backend: 'agy', account: 'agy-1', kind: 'weekly', group: 'Gemini', percent: 15 });
  });

  it('Kiro 余额快照写入 monthly 与 used/limit，节流有效', async () => {
    recordKiroBalanceSnapshot('kiro-1', { subscription: 'Pro', used: 25, limit: 100, resetsAt: 1_702_000_000_000 }, 1_700_000_000_000);
    expect(sink.snapshots).toHaveLength(1);
    expect(sink.snapshots[0]).toMatchObject({
      backend: 'claude',
      account: 'kiro-1',
      accountKind: 'kiro',
      kind: 'monthly',
      group: null,
      percent: 25,
      used: 25,
      limit: 100,
      windowMs: null,
      resetsAt: 1_702_000_000_000,
    });

    let now = 1_700_000_000_000;
    const fetchBalance = vi.fn().mockResolvedValue({ subscription: 'Pro', used: 50, limit: 100, resetsAt: 1_702_000_000_000 });
    const kiroCol = new KiroBalanceCollector({ fetchBalance, now: () => now });
    kiroCol.poll('kiro-1');
    kiroCol.poll('kiro-1');
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchBalance).toHaveBeenCalledTimes(1);
    expect(sink.snapshots).toHaveLength(2);
  });
});

describe('DelegateJobs 无 progress 时也入账且不破坏前端事件行为', () => {
  const dummyBackend: DelegateBackend = {
    id: 'codex',
    label: 'Codex',
    available: () => true,
    models: async () => ({ models: [], current: null, at: 0 }),
    run: async () => ({ stopReason: 'end_turn', response: 'ok', sessionId: 'th-1', accountId: 'cx-1', toolCalls: 0 }),
  };

  it('无 onEvents/progress 时仍将 onUsage 写入账本（含 reasoning），且不触发前端事件', async () => {
    const jobs = new DelegateJobs({
      sessionId: 'parent-sess',
      now: () => 1_700_000_123_000,
      git: async () => { throw new Error('no git'); },
      accountKind: () => 'subscription',
      run: async (opts: BackendRunOptions): Promise<BackendResult> => {
        opts.onSession?.('th-1', 'cx-1');
        opts.onModel?.({ model: 'gpt-5.4', effort: 'high' });
        const pt: CachePoint = {
          id: 'codex:th-1:turn-1:1',
          turn: 0,
          input: 120,
          create: 0,
          read: 880,
          rate: 88,
          output: 300,
          model: 'gpt-5.4',
        };
        opts.onUsage?.(pt, 1_050_000, { reasoning: 150 });
        return { stopReason: 'end_turn', response: 'done', sessionId: 'th-1', accountId: 'cx-1', toolCalls: 0 };
      },
    });

    const res = await jobs.callTool(
      'delegate',
      { agent: 'Explore', description: 'check', prompt: 'hello', run_in_background: false },
      { cwd: '/repo', backend: dummyBackend, agents: { cwd: '/repo', configDir: os.tmpdir(), disabled: [] } },
      '', // 无 toolUseId → 无 progress
      new AbortController().signal,
    );
    expect(res.isError).not.toBe(true);

    const rec = sink.byKey.get('codex\0codex:th-1:turn-1:1');
    expect(rec).toMatchObject({
      backend: 'codex',
      id: 'codex:th-1:turn-1:1',
      account: 'cx-1',
      accountKind: 'subscription',
      session: 'parent-sess',
      layer: 'delegate',
      agent: 'Explore',
      toolUseId: null,
      model: 'gpt-5.4',
      effort: 'high',
      input: 120,
      create5m: 0,
      create1h: 0,
      read: 880,
      output: 300,
      reasoning: 150,
    });
  });

  it('有 progress 时既写账本又正常向前端发 agent_params 与 cosyee_usage 事件', async () => {
    const emitted: unknown[] = [];
    const jobs = new DelegateJobs({
      sessionId: 'parent-sess',
      git: async () => { throw new Error('no git'); },
      onEvents: (evs) => emitted.push(...evs),
      run: async (opts: BackendRunOptions): Promise<BackendResult> => {
        opts.onSession?.('th-2', 'cx-2');
        opts.onModel?.({ model: 'gpt-5.4', effort: 'medium' });
        opts.onUsage?.(
          { id: 'codex:th-2:turn-1:1', turn: 0, input: 10, create: 0, read: 90, rate: 90, output: 50, model: 'gpt-5.4' },
          400_000,
        );
        return { stopReason: 'end_turn', response: 'done', sessionId: 'th-2', accountId: 'cx-2', toolCalls: 0 };
      },
    });

    await jobs.callTool(
      'delegate',
      { agent: 'Explore', description: 'check', prompt: 'hello', run_in_background: false },
      { cwd: '/repo', backend: dummyBackend, agents: { cwd: '/repo', configDir: os.tmpdir(), disabled: [] } },
      'toolu_dlg_1',
      new AbortController().signal,
    );

    expect(sink.byKey.has('codex\0codex:th-2:turn-1:1')).toBe(true);
    expect(emitted.some((e) => (e as { subtype?: string }).subtype === 'cosyee_usage')).toBe(true);
  });
});

describe('Claude 空闲补点与采集异常隔离', () => {
  it('仅对 5 小时内有活动、当前无运行进程的订阅账号探测，API/Kiro/无活动跳过', async () => {
    const now = 1_700_000_000_000;
    recordActivity('claude', 'sub-active', now - 60_000);
    recordActivity('claude', 'sub-running', now - 60_000);
    recordActivity('claude', 'sub-stale', now - FIVE_HOURS_MS - 1_000);
    recordActivity('claude', 'api-acc', now - 60_000);

    const usageResp: UsageInfo = {
      at: now,
      limits: [
        { kind: 'session', percent: 33, severity: 'normal', resetsAt: now + FIVE_HOURS_MS },
        { kind: 'weekly', percent: 12, severity: 'normal', resetsAt: now + WEEK_MS, shares: [] },
        { kind: 'scoped', model: 'Opus', percent: 40, severity: 'normal', resetsAt: now + WEEK_MS, allowance: 50 },
      ],
    };
    const getUsage = vi.fn().mockResolvedValue(usageResp);

    const handle = startLedgerProbes({
      getUsage,
      isRunning: (id) => id === 'sub-running',
      accountKind: (id) => (id === 'api-acc' ? 'api' : 'subscription'),
      listClaudeAccounts: () => ['sub-active', 'sub-running', 'sub-stale', 'sub-never', 'api-acc'],
      now: () => now,
      intervalMs: 60_000,
    });

    await handle.tick();
    handle.stop();

    expect(getUsage).toHaveBeenCalledTimes(1);
    expect(getUsage).toHaveBeenCalledWith('sub-active');
    expect(sink.snapshots).toHaveLength(3);
    expect(sink.snapshots.map((s) => `${s.kind}:${s.group ?? ''}:${s.percent}`)).toEqual([
      'session::33',
      'weekly::12',
      'scoped:opus:40',
    ]);
  });

  it('wrapClaudeUsageFetch 透传结果并写入快照', async () => {
    const info: UsageInfo = {
      at: 1_700_000_000_000,
      limits: [{ kind: 'session', percent: 55, severity: 'normal', resetsAt: 1_700_018_000_000 }],
    };
    const out = await wrapClaudeUsageFetch('default', 'subscription', Promise.resolve(info));
    expect(out).toBe(info);
    expect(sink.snapshots).toHaveLength(1);
    expect(sink.snapshots[0]).toMatchObject({ backend: 'claude', account: 'default', kind: 'session', percent: 55, source: 'probe' });
  });

  it('sink 抛异常时绝不外传，不影响主会话与委派正常完成', async () => {
    const brokenSink: LedgerSink = {
      record: () => {
        throw new Error('disk full');
      },
      snapshot: () => {
        throw new Error('disk full');
      },
    };
    setLedgerSink(brokenSink);

    const collector = new ClaudeSessionCollector({
      sessionId: 'sess-err',
      cwd: '/repo',
      account: 'default',
      accountKind: 'subscription',
    });
    expect(() => {
      collector.onEvent({
        type: 'assistant',
        message: {
          id: 'msg_e',
          model: 'claude-opus-5',
          usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 5 },
          content: [],
        },
      });
      collector.onEvent({
        type: 'rate_limit_event',
        rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: 1_700_010_000 } } },
      });
      recordClaudeUsageSnapshot({ at: 1, limits: [{ kind: 'session', percent: 10, severity: 'normal', resetsAt: null }] }, 'default', 'subscription');
    }).not.toThrow();
    collector.dispose();
  });
});
