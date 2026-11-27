import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackendError } from './delegate/backend.js';
import { CodexBackend, DELEGATE_FEATURE_ARGS, DELEGATE_ROLE_INSTRUCTIONS, type CodexAccountRef, type CodexAccountSource, CodexPool, type CodexPoolOptions, type CodexRunOptions } from './delegate/codexAppServer.js';

type Json = Record<string, any>;
type Reply = { result: Json } | { error: Json } | 'none' | undefined;
type Handler = (m: Json, c: FakeChild) => Reply;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  pid: number;
  args: string[];
  env: Record<string, string | undefined>;
  msgs: Json[];
  /** 客户端对服务端请求的应答 */
  replies: Json[];
  send(o: Json): void;
  reply(id: number, result: Json): void;
  notify(method: string, params: Json): void;
  serverRequest(id: number, method: string, params: Json): void;
  methods(): string[];
  /** 把当前 turn 正常结束（带文字与用量） */
  finishTurn(threadId: string, turnId: string, text?: string, status?: string): void;
  crash(code?: number): void;
}

/** 假 codex app-server：拦截 stdin 每行 JSON，用 handler 回复；默认行为 = 正常完成一轮 */
function harness(opts: CodexPoolOptions = {}, handler: Handler = () => undefined) {
  const children: FakeChild[] = [];
  let threadCounter = 0;
  let turnCounter = 0;
  const totals = new Map<string, number>();
  const kill = vi.fn();
  const spawn = vi.fn((command: string, args: string[], so: any) => {
    const c = new EventEmitter() as FakeChild;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.pid = 2000 + children.length;
    c.args = args;
    c.env = so?.env ?? {};
    c.msgs = [];
    c.replies = [];
    c.send = (o) => void c.stdout.write(JSON.stringify(o) + '\n');
    c.reply = (id, result) => c.send({ jsonrpc: '2.0', id, result });
    c.notify = (method, params) => c.send({ jsonrpc: '2.0', method, params });
    c.serverRequest = (id, method, params) => c.send({ jsonrpc: '2.0', id, method, params });
    c.methods = () => c.msgs.filter((m) => m.method).map((m) => m.method);
    c.finishTurn = (threadId, turnId, text = '好的', status = 'completed') => {
      const total = (totals.get(threadId) ?? 0) + 100;
      totals.set(threadId, total);
      c.notify('item/agentMessage/delta', { threadId, turnId, itemId: `m${turnId}`, delta: text });
      c.notify('thread/tokenUsage/updated', {
        threadId,
        turnId,
        tokenUsage: {
          total: { totalTokens: total, inputTokens: total - 10, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
          last: { totalTokens: 100, inputTokens: 90, cachedInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0 },
        },
      });
      c.notify('turn/completed', { threadId, turn: { id: turnId, status } });
    };
    c.crash = (code = 1) => {
      c.stdout.end();
      c.emit('close', code);
    };
    let buf = '';
    c.stdin = new Writable({
      write(chunk, _enc, cb) {
        buf += chunk.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const text = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const m = JSON.parse(text);
          c.msgs.push(m);
          if (m.method === undefined) {
            c.replies.push(m);
            continue;
          }
          const r = handler(m, c);
          if (r === 'none' || m.id === undefined) continue;
          if (r && 'error' in r) c.send({ jsonrpc: '2.0', id: m.id, error: r.error });
          else if (r) c.reply(m.id, r.result);
          else if (m.method === 'thread/start') c.reply(m.id, { thread: { id: `th${++threadCounter}` }, model: 'm-def', reasoningEffort: 'medium' });
          else if (m.method === 'thread/resume') c.reply(m.id, { thread: { id: m.params.threadId }, model: 'm-def', reasoningEffort: 'medium' });
          else if (m.method === 'turn/start') {
            const turnId = `tu${++turnCounter}`;
            c.reply(m.id, { turn: { id: turnId, status: 'inProgress' } });
            c.finishTurn(m.params.threadId, turnId);
          } else c.reply(m.id, {});
        }
        cb();
      },
    });
    children.push(c);
    return c;
  }) as any;
  const pool = new CodexPool({ spawn, kill, firstUpdateMs: 10_000, cancelGraceMs: 10_000, baseEnv: { PATH: 'p', CODEX_API_KEY: 'sk-secret-key-1', OPENAI_API_KEY: 'sk-secret-key-2', COSYEE_AGENT_TOKEN: 'tok' }, ...opts });
  const all = (method: string) => children.flatMap((c) => c.msgs.filter((m) => m.method === method));
  return { pool, spawn, kill, children, all };
}

const pools: CodexPool[] = [];
afterEach(() => {
  for (const p of pools.splice(0)) p.dispose();
});
function h(opts?: CodexPoolOptions, handler?: Handler) {
  const x = harness(opts, handler);
  pools.push(x.pool);
  return x;
}

function runOpts(over: Partial<CodexRunOptions> = {}): CodexRunOptions {
  return { execPath: 'codex', cwd: process.cwd(), prompt: '做点事', signal: new AbortController().signal, ...over } as CodexRunOptions;
}

async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 2));
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('CodexPool 基本流程', () => {
  it('握手顺序 + thread/start 参数（只读沙箱、developerInstructions、模型 / 强度）+ 汇总结果', async () => {
    const { pool, children } = h();
    const updates: string[] = [];
    const models: any[] = [];
    const sessions: any[] = [];
    const r = await pool.run(
      runOpts({
        readOnly: true,
        systemPrompt: 'SYS',
        defaults: { model: 'gpt-x', effort: 'high' },
        onUpdate: (u: any) => void updates.push(u.sessionUpdate),
        onModel: (m) => void models.push(m),
        onSession: (id, acc) => void sessions.push([id, acc]),
      }),
    );
    expect(r).toMatchObject({ stopReason: 'end_turn', response: '好的', sessionId: 'th1', accountId: 'default', toolCalls: 0, usage: { totalTokens: 100 } });
    expect(children[0]!.methods()).toEqual(['initialize', 'initialized', 'model/list', 'thread/start', 'turn/start']);
    expect(children[0]!.msgs[0]!.params).toMatchObject({ clientInfo: { name: 'cosyee' } });
    const ts = children[0]!.msgs[3]!.params;
    expect(ts).toMatchObject({ cwd: process.cwd(), approvalPolicy: 'never', sandbox: 'read-only', developerInstructions: `${DELEGATE_ROLE_INSTRUCTIONS}\n\nSYS`, model: 'gpt-x' });
    const turn = children[0]!.msgs[4]!.params;
    expect(turn).toMatchObject({
      threadId: 'th1',
      input: [{ type: 'text', text: '做点事' }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      model: 'gpt-x',
      effort: 'high',
    });
    expect(sessions).toEqual([['th1', 'default']]);
    expect(models).toEqual([{ model: 'm-def', effort: 'high' }]); // onModel 报告服务端实际生效的模型
    expect(updates).toContain('agent_message_chunk');
    expect(children[0]!.args).toEqual(['-c', 'features.computer_use=false', '-c', 'features.multi_agent=false', '-c', 'features.multi_agent_v2.max_concurrent_threads_per_session=1', 'app-server', '--listen', 'stdio://']);
  });

  it('可写：每轮 danger-full-access（无人值守，写工作区外也不失败）；线程本身以只读打开，免得 Codex 把目录写进信任列表', async () => {
    const { pool, children } = h();
    const r = await pool.run(runOpts());
    const ts = children[0]!.msgs.find((m) => m.method === 'thread/start')!.params;
    const turn = children[0]!.msgs.find((m) => m.method === 'turn/start')!.params;
    expect(ts.sandbox).toBe('read-only');
    expect(ts.approvalPolicy).toBe('never');
    expect(turn.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
    // 续接（换进程走 thread/resume）也只读打开，权限仍由每轮决定
    pool.stopAll();
    await pool.run(runOpts({ sessionId: r.sessionId }));
    const last = children.at(-1)!;
    expect(last.msgs.find((m) => m.method === 'thread/resume')!.params.sandbox).toBe('read-only');
    expect(last.msgs.find((m) => m.method === 'turn/start')!.params.sandboxPolicy).toEqual({ type: 'dangerFullAccess' });
  });

  it('默认模型兜底：未指定模型时显式传入 model/list 的 isDefault；不在列表的模型回退 current 并报告实际模型', async () => {
    const { pool, children } = h({}, (m) => {
      if (m.method === 'model/list') {
        return {
          result: {
            data: [
              { id: 'gpt-5', model: 'gpt-5', displayName: 'GPT-5', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'ultra' }] },
              { id: 'gpt-5-mini', model: 'gpt-5-mini', displayName: 'GPT-5 Mini', hidden: false, isDefault: false, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'none' }, { reasoningEffort: 'low' }] },
            ],
            nextCursor: null,
          },
        };
      }
      if (m.method === 'thread/start') {
        return { result: { thread: { id: 'th-' + Math.random().toString(36).slice(2, 6) }, model: m.params.model ?? 'bad-config-model', reasoningEffort: 'medium' } };
      }
      return undefined;
    });
    const seen1: any[] = [];
    await pool.run(runOpts({ onModel: (m) => seen1.push(m) }));
    const ts1 = children[0]!.msgs.filter((m) => m.method === 'thread/start')[0]!.params;
    expect(ts1.model).toBe('gpt-5');
    expect(seen1).toEqual([{ model: 'gpt-5', effort: 'medium' }]);

    const seen2: any[] = [];
    await pool.run(runOpts({ defaults: { model: 'gpt-6.1-sol-unavailable', effort: 'ultra' }, onModel: (m) => seen2.push(m) }));
    const ts2 = children[0]!.msgs.filter((m) => m.method === 'thread/start')[1]!.params;
    expect(ts2.model).toBe('gpt-5');
    expect(seen2).toEqual([{ model: 'gpt-5', effort: 'ultra' }]);
  });

  it('account/rateLimits/updated 推送触发 onRateLimits 回调', async () => {
    const got: Array<{ id: string; raw: unknown }> = [];
    const { pool, children } = h({ onRateLimits: (id, raw) => got.push({ id, raw }) });
    await pool.run(runOpts());
    children[0]!.notify('account/rateLimits/updated', { rateLimits: { limitId: 'codex', primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1760000000 } } });
    expect(got).toHaveLength(1);
    expect(got[0]!.id).toBe('default');
  });

  it('turn 失败：unauthorized → 统一未登录提示；其它 → BackendError 带 sessionId', async () => {
    const mk = (error: any) =>
      h({}, (m, c) => {
        if (m.method !== 'turn/start') return undefined;
        c.reply(m.id, { turn: { id: 'tu1', status: 'inProgress' } });
        c.notify('turn/completed', { threadId: m.params.threadId, turn: { id: 'tu1', status: 'failed', error } });
        return 'none';
      });
    const a = mk({ message: 'x', codexErrorInfo: 'unauthorized' });
    const e1 = await a.pool.run(runOpts()).catch((e) => e);
    expect(e1).toBeInstanceOf(Error);
    expect(e1).not.toBeInstanceOf(BackendError);
    expect(e1.message).toContain('登录');
    const b = mk({ message: '模型炸了', codexErrorInfo: null });
    const e2 = await b.pool.run(runOpts()).catch((e) => e);
    expect(e2).toBeInstanceOf(BackendError);
    expect(e2.message).toBe('模型炸了');
    expect(e2.sessionId).toBe('th1');
  });

  it('模型强度校正：模型缓存里不支持的强度落到该模型默认', async () => {
    const { pool, children } = h({}, (m) => {
      if (m.method !== 'model/list') return undefined;
      return { result: { data: [{ id: 'g', model: 'g', displayName: 'G', hidden: false, isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }], nextCursor: null } };
    });
    await pool.run(runOpts({ defaults: { model: 'g', effort: 'max' } }));
    const turn = children[0]!.msgs.find((m) => m.method === 'turn/start')!;
    expect(turn.params.effort).toBe('medium');
  });
});

describe('服务端请求', () => {
  async function approvals(readOnly: boolean) {
    const { pool, children } = h({}, (m, c) => {
      if (m.method !== 'turn/start') return undefined;
      const th = m.params.threadId;
      c.reply(m.id, { turn: { id: 'tu1', status: 'inProgress' } });
      c.serverRequest(101, 'item/commandExecution/requestApproval', { threadId: th, turnId: 'tu1', itemId: 'c1' });
      c.serverRequest(102, 'item/fileChange/requestApproval', { threadId: th, turnId: 'tu1', itemId: 'f1' });
      c.serverRequest(103, 'item/permissions/requestApproval', { threadId: th, turnId: 'tu1', itemId: 'p1', permissions: { network: { enabled: true } } });
      c.serverRequest(104, 'applyPatchApproval', { conversationId: th });
      c.serverRequest(105, 'item/tool/requestUserInput', { threadId: th, turnId: 'tu1', itemId: 'q', questions: [{ id: 'q1', options: [{ label: '选项A' }, { label: '选项B' }] }, { id: 'q2', options: null }] });
      c.serverRequest(106, 'mcpServer/elicitation/request', { threadId: th });
      c.serverRequest(107, 'item/tool/call', { threadId: th, tool: 'x' });
      c.serverRequest(108, 'account/chatgptAuthTokens/refresh', {});
      c.serverRequest(109, 'something/unknown', {});
      setTimeout(() => c.notify('turn/completed', { threadId: th, turn: { id: 'tu1', status: 'completed' } }), 20);
      return 'none';
    });
    await pool.run(runOpts({ readOnly }));
    await until(() => children[0]!.replies.length >= 9);
    const by = (id: number) => children[0]!.replies.find((r) => r.id === id)!;
    return by;
  }

  it('只读：审批一律拒绝；提问不挂起；未知请求回 -32601', async () => {
    const by = await approvals(true);
    expect(by(101).result).toEqual({ decision: 'decline' });
    expect(by(102).result).toEqual({ decision: 'decline' });
    expect(by(103).result).toEqual({ permissions: {}, scope: 'turn' });
    expect(by(104).result).toEqual({ decision: 'denied' });
    expect(by(105).result.answers.q1.answers).toEqual(['选项A']);
    expect(by(105).result.answers.q2.answers[0]).toContain('无人值守');
    expect(by(106).result).toMatchObject({ action: 'decline' });
    expect(by(107).result).toMatchObject({ success: false });
    expect(by(108).error.code).toBe(-32601);
    expect(by(109).error.code).toBe(-32601);
  });

  it('可写：审批放行', async () => {
    const by = await approvals(false);
    expect(by(101).result).toEqual({ decision: 'accept' });
    expect(by(102).result).toEqual({ decision: 'accept' });
    expect(by(103).result).toEqual({ permissions: { network: { enabled: true } }, scope: 'turn' });
    expect(by(104).result).toEqual({ decision: 'approved' });
  });
});

describe('并发 / 排队 / 续接', () => {
  it('单进程多线程并发；超过 maxPromptsPerProc 扩容新进程；超过 maxProcsPerCwd 排队', async () => {
    const held: Array<() => void> = [];
    const { pool, children } = h({ maxPromptsPerProc: 2, maxProcsPerCwd: 2 }, (m, c) => {
      if (m.method !== 'turn/start') return undefined;
      const turnId = `u${m.id}`;
      c.reply(m.id, { turn: { id: turnId, status: 'inProgress' } });
      held.push(() => c.finishTurn(m.params.threadId, turnId));
      return 'none';
    });
    const rs = [1, 2, 3, 4, 5].map(() => pool.run(runOpts()));
    await until(() => held.length === 4);
    expect(children).toHaveLength(2);
    expect(pool.runningCount()).toBe(5);
    expect(held).toHaveLength(4);
    held.shift()!();
    await until(() => held.length === 4); // 第 5 个拿到槽位
    for (const f of held.splice(0)) f();
    const res = await Promise.all(rs);
    expect(res).toHaveLength(5);
    expect(new Set(res.map((r) => r.sessionId)).size).toBe(5);
    expect(pool.runningCount()).toBe(0);
  });

  it('排队中的任务可取消', async () => {
    const { pool } = h({ maxPromptsPerProc: 1, maxProcsPerCwd: 1 }, (m, c) => {
      if (m.method !== 'turn/start') return undefined;
      c.reply(m.id, { turn: { id: 'u', status: 'inProgress' } });
      return 'none';
    });
    void pool.run(runOpts()).catch(() => {});
    await sleep(30);
    const ac = new AbortController();
    const p = pool.run(runOpts({ signal: ac.signal }));
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow('已取消');
  });

  it('续接：同进程复用线程不再 thread/resume；进程换了则 thread/resume；用量取差值', async () => {
    const { pool, children, all } = h();
    const r1 = await pool.run(runOpts());
    const r2 = await pool.run(runOpts({ sessionId: r1.sessionId }));
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(all('thread/resume')).toHaveLength(0);
    expect(all('thread/start')).toHaveLength(1);
    expect(r2.usage?.totalTokens).toBe(100); // 累计 200 - 基线 100
    pool.retireAll();
    await until(() => children[0]!.msgs.length > 0 && pool.stats().processes === 0);
    const r3 = await pool.run(runOpts({ sessionId: r1.sessionId }));
    expect(r3.sessionId).toBe(r1.sessionId);
    expect(children).toHaveLength(2);
    expect(children[1]!.methods()).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    expect(children[1]!.msgs[2]!.params).toMatchObject({ threadId: r1.sessionId, approvalPolicy: 'never' });
  });

  it('同一会话并发续接 → 正在执行中', async () => {
    const { pool } = h({}, (m, c) => {
      if (m.method === 'turn/interrupt') {
        c.reply(m.id, {});
        c.notify('turn/completed', { threadId: m.params.threadId, turn: { id: 'u', status: 'interrupted' } });
        return 'none';
      }
      if (m.method !== 'turn/start') return undefined;
      c.reply(m.id, { turn: { id: 'u', status: 'inProgress' } });
      return 'none';
    });
    const ac = new AbortController();
    let sid = '';
    const p1 = pool.run(runOpts({ signal: ac.signal, onSession: (id) => void (sid = id) }));
    await until(() => !!sid);
    await sleep(10);
    const e = await pool.run(runOpts({ sessionId: sid })).catch((x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect(e.message).toContain('正在执行中');
    ac.abort();
    await p1.catch(() => {});
  });
});

describe('中断 / 看门狗 / 崩溃', () => {
  it('取消：发 turn/interrupt，收到 interrupted 后抛已取消，进程保持可用', async () => {
    const { pool, children } = h({}, (m, c) => {
      if (m.method === 'turn/start') {
        c.reply(m.id, { turn: { id: 'u1', status: 'inProgress' } });
        return 'none';
      }
      if (m.method === 'turn/interrupt') {
        c.reply(m.id, {});
        c.notify('turn/completed', { threadId: m.params.threadId, turn: { id: 'u1', status: 'interrupted' } });
        return 'none';
      }
      return undefined;
    });
    const ac = new AbortController();
    const p = pool.run(runOpts({ signal: ac.signal }));
    await until(() => children[0]?.methods().includes('turn/start') === true);
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow('已取消');
    const itr = children[0]!.msgs.find((m) => m.method === 'turn/interrupt')!;
    expect(itr.params).toEqual({ threadId: 'th1', turnId: 'u1' });
    expect(children[0]!.msgs.filter((m) => m.method === 'thread/unsubscribe').length).toBe(0);
    expect(pool.stats().processes).toBe(1);
    expect(pool.runningCount()).toBe(0);
  });

  it('取消后宽限期内没有收尾：进程标记排空，空闲后被回收', async () => {
    const { pool, children } = h({ cancelGraceMs: 30 }, (m, c) => {
      if (m.method === 'turn/start') {
        c.reply(m.id, { turn: { id: 'u1', status: 'inProgress' } });
        return 'none';
      }
      if (m.method === 'turn/interrupt') return 'none';
      return undefined;
    });
    const ac = new AbortController();
    const p = pool.run(runOpts({ signal: ac.signal }));
    await until(() => children[0]?.methods().includes('turn/start') === true);
    await sleep(10);
    ac.abort();
    await expect(p).rejects.toThrow('已取消');
    await until(() => pool.stats().processes === 0);
  });

  it('首次输出看门狗：第一次卡死 interrupt 后重试，第二次仍卡死 → 无响应错误', async () => {
    const { pool, children } = h({ firstUpdateMs: 30, cancelGraceMs: 30 }, (m, c) => {
      if (m.method === 'turn/start') {
        c.reply(m.id, { turn: { id: `u${m.id}`, status: 'inProgress' } });
        return 'none';
      }
      if (m.method === 'turn/interrupt') {
        c.reply(m.id, {});
        c.notify('turn/completed', { threadId: m.params.threadId, turn: { id: m.params.turnId, status: 'interrupted' } });
        return 'none';
      }
      return undefined;
    });
    const e = await pool.run(runOpts()).catch((x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect(e.message).toContain('委派任务无响应');
    expect(e.sessionId).toBe('th1');
    expect(children[0]!.msgs.filter((m) => m.method === 'turn/interrupt')).toHaveLength(2);
  });

  it('空闲看门狗：有进度之后长时间无任何通知 → 卡死；工具执行期间暂停', async () => {
    const { pool } = h({ firstUpdateMs: 10_000, idleUpdateMs: 40, cancelGraceMs: 30 }, (m, c) => {
      if (m.method === 'turn/start') {
        c.reply(m.id, { turn: { id: `u${m.id}`, status: 'inProgress' } });
        c.notify('item/agentMessage/delta', { threadId: m.params.threadId, itemId: 'a', delta: '开头' });
        return 'none';
      }
      if (m.method === 'turn/interrupt') {
        c.reply(m.id, {});
        c.notify('turn/completed', { threadId: m.params.threadId, turn: { id: m.params.turnId, status: 'interrupted' } });
        return 'none';
      }
      return undefined;
    });
    const e = await pool.run(runOpts()).catch((x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect(e.message).toContain('无响应');

    const t = h({ idleUpdateMs: 40, cancelGraceMs: 30 }, (m, c) => {
      if (m.method !== 'turn/start') return undefined;
      const th = m.params.threadId;
      c.reply(m.id, { turn: { id: 'u1', status: 'inProgress' } });
      c.notify('item/started', { threadId: th, turnId: 'u1', item: { type: 'commandExecution', id: 'c1', command: 'sleep' } });
      setTimeout(() => {
        c.notify('item/completed', { threadId: th, turnId: 'u1', item: { type: 'commandExecution', id: 'c1', command: 'sleep', status: 'completed', exitCode: 0 } });
        c.notify('turn/completed', { threadId: th, turn: { id: 'u1', status: 'completed' } });
      }, 150);
      return 'none';
    });
    const r = await t.pool.run(runOpts());
    expect(r.toolCalls).toBe(1);
  });

  it('进程中途崩溃：新进程 thread/resume 重试一次（带重试前缀）；再崩溃则 BackendError', async () => {
    let turns = 0;
    const { pool, children } = h({}, (m, c) => {
      if (m.method !== 'turn/start') return undefined;
      turns++;
      if (turns === 1) {
        c.reply(m.id, { turn: { id: 'u1', status: 'inProgress' } });
        setTimeout(() => c.crash(3), 5);
        return 'none';
      }
      return undefined;
    });
    const r = await pool.run(runOpts({ prompt: '原任务' }));
    expect(r.stopReason).toBe('end_turn');
    expect(children).toHaveLength(2);
    expect(children[1]!.methods()).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    const text = children[1]!.msgs[3]!.params.input[0].text as string;
    expect(text.endsWith('原任务')).toBe(true);
    expect(text.length).toBeGreaterThan('原任务'.length);

    const t = h({}, (m, c) => {
      if (m.method !== 'turn/start') return undefined;
      c.reply(m.id, { turn: { id: 'u', status: 'inProgress' } });
      setTimeout(() => c.crash(9), 5);
      return 'none';
    });
    const e = await t.pool.run(runOpts()).catch((x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect(e.message).toContain('委派进程意外退出');
    expect(t.children).toHaveLength(2);
  });
});

describe('协议不兼容 / 模型 / 账号读取', () => {
  it('-32601 → 标记协议不兼容，availability 给出升级提示，clearIncompatible 后恢复', async () => {
    const { pool } = h({}, (m) => (m.method === 'thread/start' ? { error: { code: -32601, message: 'Method not found: thread/start' } } : undefined));
    let changed = 0;
    const be = new CodexBackend({ pool, resolve: () => ({ execPath: 'codex', rawPath: 'codex', installKind: 'custom' }), version: () => '0.150.0', onChanged: () => void changed++ });
    expect(be.availability()).toEqual({ ok: true });
    await expect(be.run({ cwd: process.cwd(), prompt: 'x', signal: new AbortController().signal })).rejects.toThrow();
    const a = be.availability();
    expect(a.ok).toBe(false);
    expect((a as any).reason).toContain('升级');
    expect(changed).toBe(1);
    be.clearIncompatible();
    expect(be.availability()).toEqual({ ok: true });
  });

  it('availability 顺序：未安装 → 版本过低 → 协议不兼容 → 账号未登录', () => {
    const { pool } = h();
    const info = { execPath: 'codex', rawPath: 'codex', installKind: 'custom' as const };
    let installed: typeof info | null = null;
    let version: string | null = '0.143.9';
    let logged: boolean | 'unknown' = false;
    const accounts: CodexAccountSource = { active: () => ({ id: 'default', dir: null }), accountFor: () => null, activeLoggedIn: () => logged };
    const be = new CodexBackend({ pool, resolve: () => installed, version: () => version, accounts });
    expect((be.availability() as any).reason).toContain('未安装');
    installed = info;
    expect((be.availability() as any).reason).toContain('版本过低');
    version = '0.144.0';
    expect((be.availability() as any).reason).toContain('未登录');
    logged = 'unknown';
    expect(be.availability()).toEqual({ ok: true });
    version = null;
    expect(be.available()).toBe(true);
  });

  it('model/list 分页拉全并缓存；refresh 强制重取；readAccount 解析登录态', async () => {
    const { pool, all } = h({}, (m) => {
      if (m.method === 'model/list') {
        return m.params.cursor
          ? { result: { data: [{ id: 'b', model: 'b', displayName: 'B', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null } }
          : { result: { data: [{ id: 'a', model: 'a', displayName: 'A', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }, { id: 'h', model: 'h', hidden: true }], nextCursor: 'c2' } };
      }
      if (m.method === 'account/read') return { result: { account: { type: 'chatgpt', email: 'a@b.c', planType: 'plus' }, requiresOpenaiAuth: true } };
      return undefined;
    });
    const l1 = await pool.models({ execPath: 'codex', cwd: process.cwd() });
    expect(l1.models.map((x) => x.value)).toEqual(['a', 'b']);
    expect(l1.current).toEqual({ model: 'b', effort: 'low' });
    expect(all('model/list')).toHaveLength(2);
    await pool.models({ execPath: 'codex', cwd: process.cwd() });
    expect(all('model/list')).toHaveLength(2);
    await pool.models({ execPath: 'codex', cwd: process.cwd(), refresh: true });
    expect(all('model/list')).toHaveLength(4);
    const acc = await pool.readAccount({ execPath: 'codex', cwd: process.cwd() });
    expect(acc.account).toMatchObject({ type: 'chatgpt', email: 'a@b.c' });
  });
});

describe('回收 / 保活 / 账号', () => {
  it('sweep：空闲线程被关闭（thread/unsubscribe），空闲主进程超时回收；hold 期间保活', async () => {
    let now = 1_000_000;
    const { pool, all } = h({ now: () => now, sessionIdleMs: 1000, processIdleMs: 5000, activeAccountId: () => 'default' });
    await pool.run(runOpts());
    expect(pool.stats()).toMatchObject({ processes: 1, sessions: 1, busy: 0 });
    const release = pool.hold('codex', process.cwd());
    now += 2000;
    pool.sweep();
    await until(() => all('thread/unsubscribe').length === 1);
    expect(pool.stats().sessions).toBe(0);
    now += 10_000;
    pool.sweep();
    expect(pool.stats().processes).toBe(1); // 被 hold
    release();
    release(); // 幂等
    pool.sweep();
    expect(pool.stats().processes).toBe(0);
  });

  it('retireAll：空闲进程立即回收；执行中进程排空后回收', async () => {
    const turns: Array<() => void> = [];
    const { pool, kill } = h({}, (m, c) => {
      if (m.method !== 'turn/start') return undefined;
      c.reply(m.id, { turn: { id: 'u', status: 'inProgress' } });
      turns.push(() => c.finishTurn(m.params.threadId, 'u'));
      return 'none';
    });
    const p = pool.run(runOpts());
    await until(() => turns.length === 1);
    pool.retireAll();
    expect(pool.stats().processes).toBe(1);
    expect(kill).not.toHaveBeenCalled();
    turns[0]!();
    await p;
    await until(() => pool.stats().processes === 0);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it('resetAccount 只影响该账号；stopAccount 在有任务时拒绝', async () => {
    const { pool } = h();
    const a: CodexAccountRef = { id: 'a1', dir: 'C:/tmp/cosyee-codex-a1' };
    const b: CodexAccountRef = { id: 'a2', dir: 'C:/tmp/cosyee-codex-a2' };
    await pool.run(runOpts({ account: a }));
    await pool.run(runOpts({ account: b }));
    expect(pool.stats().processes).toBe(2);
    pool.resetAccount('a1');
    await until(() => pool.stats().processes === 1);
    expect(pool.stopAccount('a2')).toBe(true);
    expect(pool.stats().processes).toBe(0);
  });

  it('stopAll：有任务时 force=false 不动；dispose 杀掉全部', async () => {
    const { pool, kill } = h({}, (m, c) => {
      if (m.method !== 'turn/start') return undefined;
      c.reply(m.id, { turn: { id: 'u', status: 'inProgress' } });
      return 'none';
    });
    const ac = new AbortController();
    const p = pool.run(runOpts({ signal: ac.signal, }));
    p.catch(() => {});
    await sleep(40);
    expect(pool.stopAll()).toEqual({ stopped: false, running: 1 });
    expect(pool.stopAll(true).stopped).toBe(true);
    expect(kill).toHaveBeenCalled();
    await p.catch(() => {});
  });
});

describe('进程环境', () => {
  it('默认账号沿用宿主环境；添加的账号用自己的 CODEX_HOME 且不泄漏宿主密钥；Cosyee 内部变量一律清掉', async () => {
    const { pool, children } = h();
    await pool.run(runOpts());
    expect(children[0]!.env.CODEX_API_KEY).toBe('sk-secret-key-1');
    expect(children[0]!.env.COSYEE_AGENT_TOKEN).toBeUndefined();
    expect(children[0]!.args).toEqual([...DELEGATE_FEATURE_ARGS, 'app-server', '--listen', 'stdio://']);

    const dir = require('node:path').join(require('node:os').tmpdir(), `cosyee-codex-env-${Date.now()}`);
    await pool.run(runOpts({ account: { id: 'acc', dir } }));
    const env = children[1]!.env;
    expect(env.CODEX_HOME).toBe(require('node:path').resolve(dir));
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.COSYEE_AGENT_TOKEN).toBeUndefined();
    expect(children[1]!.args).toEqual(['-c', 'cli_auth_credentials_store="file"', ...DELEGATE_FEATURE_ARGS, 'app-server', '--listen', 'stdio://']);
    require('node:fs').rmSync(dir, { recursive: true, force: true });
  });
});
