import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AcpPool, type AcpPoolOptions, type AcpRunOptions, AgyBackend } from './delegate/acp.js';
import { AGY_NOT_LOGGED_IN } from './delegate/agy.js';
import { BackendError } from './delegate/backend.js';

type Json = Record<string, any>;
type Reply = { result: Json } | { error: Json } | 'none' | undefined;
type Handler = (m: Json, c: FakeChild) => Reply;

interface FakeChild extends EventEmitter {
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: Writable;
  pid: number;
  /** 收到的全部消息（已解析） */
  msgs: Json[];
  /** 收到的 prompt 请求（用于手动放行） */
  prompts: Json[];
  send(o: Json): void;
  reply(id: number, result: Json): void;
  update(sessionId: string, update: Json): void;
  methods(): string[];
}

/** 假 ACP agent：拦截 stdin 的每行 JSON，用 handler 回复（返回 'none' 表示不回复，undefined 走默认回复） */
function harness(opts: AcpPoolOptions = {}, handler: Handler = () => undefined) {
  const children: FakeChild[] = [];
  let sessionCounter = 0;
  const kill = vi.fn();
  const spawn = vi.fn(() => {
    const c = new EventEmitter() as FakeChild;
    c.stdout = new PassThrough();
    c.stderr = new PassThrough();
    c.pid = 1000 + children.length;
    c.msgs = [];
    c.prompts = [];
    c.send = (o) => void c.stdout.write(JSON.stringify(o) + '\n');
    c.reply = (id, result) => c.send({ jsonrpc: '2.0', id, result });
    c.update = (sessionId, update) => c.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
    c.methods = () => c.msgs.filter((m) => m.method).map((m) => m.method);
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
          if (m.method === 'session/prompt') c.prompts.push(m);
          if (m.method === undefined) continue; // 客户端对 agent 请求的回复
          const r = handler(m, c);
          if (r === 'none' || m.id === undefined) continue;
          if (r && 'error' in r) c.send({ jsonrpc: '2.0', id: m.id, error: r.error });
          else if (r) c.reply(m.id, r.result);
          else if (m.method === 'session/new') c.reply(m.id, { sessionId: `s${++sessionCounter}` });
          else if (m.method === 'session/prompt') c.reply(m.id, { stopReason: 'end_turn' });
          else c.reply(m.id, {});
        }
        cb();
      },
    });
    children.push(c);
    return c;
  }) as any;
  const pool = new AcpPool({ spawn, kill, firstUpdateMs: 10_000, cancelGraceMs: 10_000, ...opts });
  const all = (method: string) => children.flatMap((c) => c.msgs.filter((m) => m.method === method));
  return { pool, spawn, kill, children, all };
}

const pools: AcpPool[] = [];
afterEach(() => {
  for (const p of pools.splice(0)) p.dispose();
});
function h(opts?: AcpPoolOptions, handler?: Handler) {
  const x = harness(opts, handler);
  pools.push(x.pool);
  return x;
}

function runOpts(over: Partial<AcpRunOptions> = {}): AcpRunOptions {
  return { agyPath: 'agy', cwd: process.cwd(), prompt: '做点事', signal: new AbortController().signal, ...over };
}

async function until(cond: () => boolean, ms = 2000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until 超时');
    await new Promise((r) => setTimeout(r, 2));
  }
}
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('AcpPool 基本流程', () => {
  it('冷启动：initialize -> session/new -> session/prompt，汇总结果；systemPrompt 只进 session/new', async () => {
    const { pool, children } = h({}, (m, c) => {
      if (m.method !== 'session/prompt') return undefined;
      const sid = m.params.sessionId;
      c.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '你' } });
      c.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好' } });
      c.update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'x', status: 'in_progress' });
      c.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
      c.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
      c.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed' });
      c.update(sid, { sessionUpdate: 'usage_update' });
      return { result: { stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 4 } } };
    });
    const seen: string[] = [];
    const r = await pool.run(runOpts({ systemPrompt: 'SYS', onUpdate: (u) => void seen.push(u.sessionUpdate) }));
    // 工具调用后没有新文字，回退为全部文字
    expect(r).toEqual({ stopReason: 'end_turn', response: '你好', sessionId: 's1', accountId: 'default', usage: { inputTokens: 3, outputTokens: 4 }, toolCalls: 2 });
    expect(seen).toHaveLength(7);
    expect(children[0].methods()).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(children[0].msgs[1].params).toEqual({
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { antigravity: { systemPrompt: { append: 'SYS' } } },
    });
    expect(children[0].msgs[2].params).toEqual({ sessionId: 's1', prompt: [{ type: 'text', text: '做点事' }] });
    expect(pool.stats()).toEqual({ processes: 1, sessions: 1, busy: 0 });
  });

  it('结果文字：只取最后一个 tool_call/tool_call_update 之后的文字；若为空回退全部文字', async () => {
    const { pool } = h({}, (m, c) => {
      if (m.method !== 'session/prompt') return undefined;
      const sid = m.params.sessionId;
      c.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '思考过程' } });
      c.update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', name: 'read', status: 'in_progress' });
      c.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '中间文字' } });
      c.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
      c.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '最终' } });
      c.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '结论' } });
      return { result: { stopReason: 'end_turn' } };
    });
    const r = await pool.run(runOpts());
    expect(r.response).toBe('最终结论');
  });

  it('onUpdate 抛错被吞掉', async () => {
    const { pool } = h({}, (m, c) => {
      if (m.method === 'session/prompt') c.update(m.params.sessionId, { sessionUpdate: 'plan' });
      return undefined;
    });
    const r = await pool.run(runOpts({ onUpdate: () => { throw new Error('x'); } }));
    expect(r.stopReason).toBe('end_turn');
  });

  it('热复用：同 cwd 不再 spawn / initialize；不同 cwd 新进程', async () => {
    const { pool, spawn, all } = h();
    await pool.run(runOpts());
    await pool.run(runOpts());
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(all('initialize')).toHaveLength(1);
    expect(all('session/new')).toHaveLength(2);
    await pool.run(runOpts({ cwd: process.cwd() + '-other' }));
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(pool.stats().processes).toBe(2);
  });

  it('并发冷启动只 spawn / initialize 一次', async () => {
    const { pool, spawn, all } = h();
    const [a, b] = await Promise.all([pool.run(runOpts()), pool.run(runOpts())]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(all('initialize')).toHaveLength(1);
    expect(new Set([a.sessionId, b.sessionId]).size).toBe(2);
  });
});

describe('并发、扩容与排队', () => {
  it('单进程内 2 个 prompt 并发执行；超过单进程上限扩容第 2 个进程；超过进程上限 FIFO 排队', async () => {
    const { pool, spawn, children } = h({ maxPromptsPerProc: 2, maxProcsPerCwd: 2 }, (m) =>
      m.method === 'session/prompt' ? 'none' : undefined,
    );
    const p1 = pool.run(runOpts({ prompt: '1' }));
    const p2 = pool.run(runOpts({ prompt: '2' }));
    await until(() => children[0]?.prompts.length === 2);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(pool.stats()).toEqual({ processes: 1, sessions: 2, busy: 2 });

    // 第 3 个超出单进程上限 -> 扩容第 2 个进程
    const p3 = pool.run(runOpts({ prompt: '3' }));
    const p4 = pool.run(runOpts({ prompt: '4' }));
    await until(() => children[1]?.prompts.length === 2);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(pool.stats()).toEqual({ processes: 2, sessions: 4, busy: 4 });

    // 第 5、6 个超出进程上限 -> 排队等待
    const order: string[] = [];
    const p5 = pool.run(runOpts({ prompt: '5' })).then((r) => { order.push('5'); return r; });
    const ab6 = new AbortController();
    const p6 = pool.run(runOpts({ prompt: '6', signal: ab6.signal })).catch((e) => e);
    const p7 = pool.run(runOpts({ prompt: '7' })).then((r) => { order.push('7'); return r; });
    await tick();
    expect(spawn).toHaveBeenCalledTimes(2);

    // 取消排队中的 p6：立刻离开队列，不占槽位也不报错噪音
    ab6.abort();
    expect((await p6).message).toBe('已取消');

    // 放行 p1 -> p5 拿到空位；放行 p2 -> p7 拿到空位
    children[0].reply(children[0].prompts[0].id, { stopReason: 'end_turn' });
    await until(() => children[0].prompts.length === 3);
    expect(children[0].prompts[2].params.prompt[0].text).toBe('5');

    children[0].reply(children[0].prompts[1].id, { stopReason: 'end_turn' });
    await until(() => children[0].prompts.length === 4);
    expect(children[0].prompts[3].params.prompt[0].text).toBe('7');

    // 全部放行
    children[0].reply(children[0].prompts[2].id, { stopReason: 'end_turn' });
    children[0].reply(children[0].prompts[3].id, { stopReason: 'end_turn' });
    children[1].reply(children[1].prompts[0].id, { stopReason: 'end_turn' });
    children[1].reply(children[1].prompts[1].id, { stopReason: 'end_turn' });
    await Promise.all([p1, p2, p3, p4, p5, p7]);
    expect(order).toEqual(['5', '7']);
    expect(pool.stats().busy).toBe(0);
  });

  it('续聊优先用原进程，原进程满槽时切到其它空闲进程并 session/load', async () => {
    const { pool, children, all } = h({ maxPromptsPerProc: 1, maxProcsPerCwd: 2 }, (m) =>
      m.method === 'session/prompt' && m.params.prompt[0].text === 'hold' ? 'none' : undefined,
    );
    const r1 = await pool.run(runOpts({ prompt: 'first' }));
    // 占满 proc 0
    const blocker = pool.run(runOpts({ prompt: 'hold' }));
    await until(() => children[0].prompts.length === 2);
    // 续聊 r1：proc 0 满槽，扩容到 proc 1 并 load
    const r2 = await pool.run(runOpts({ sessionId: r1.sessionId, prompt: 'continue' }));
    expect(r2.sessionId).toBe(r1.sessionId);
    expect(children).toHaveLength(2);
    expect(all('session/load')).toHaveLength(1);
    expect(all('session/load')[0].params.sessionId).toBe(r1.sessionId);
    // session/load 不带 systemPrompt
    expect(all('session/load')[0].params._meta).toBeUndefined();

    children[0].reply(children[0].prompts[1].id, { stopReason: 'end_turn' });
    await blocker;
  });
});

describe('会话选择', () => {
  it('表里有 -> 不 load；表里没有 -> 先 load 再 prompt，回放不转发', async () => {
    const { pool, all, children } = h({}, (m, c) => {
      if (m.method === 'session/load') {
        c.update(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '旧' } });
        c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '旧回复' } });
      }
      if (m.method === 'session/prompt') c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '新' } });
      return undefined;
    });
    const r1 = await pool.run(runOpts());
    await pool.run(runOpts({ sessionId: r1.sessionId }));
    expect(all('session/load')).toHaveLength(0);

    const seen: Json[] = [];
    const r = await pool.run(runOpts({ sessionId: 'old-1', onUpdate: (u) => void seen.push(u) }));
    expect(r.sessionId).toBe('old-1');
    expect(r.response).toBe('新');
    expect(seen).toHaveLength(1);
    const ms = children[0].methods();
    expect(ms.slice(-2)).toEqual(['session/load', 'session/prompt']);
    expect(all('session/load')[0].params).toMatchObject({ sessionId: 'old-1', mcpServers: [] });
  });

  it('冷启动模型未就绪（plan model not specified）-> close + load 后重试一次', async () => {
    let n = 0;
    const { pool, all } = h({}, (m, c) => {
      if (m.method !== 'session/prompt') return undefined;
      if (n++ === 0) c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '⚠ failed to construct executor: plan model not specified; you must specify a valid model' } });
      else c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } });
      return undefined;
    });
    const r = await pool.run(runOpts());
    expect(r).toMatchObject({ stopReason: 'end_turn', response: 'OK', sessionId: 's1' });
    expect(all('session/close')).toHaveLength(1);
    expect(all('session/load').map((m) => m.params.sessionId)).toEqual(['s1']);
    expect(all('session/prompt')).toHaveLength(2);
    expect(pool.stats()).toEqual({ processes: 1, sessions: 1, busy: 0 });
  });

  it('load 失败 -> BackendError 带 id；会话不存在 -> 不带 id', async () => {
    const a = h({}, (m) => (m.method === 'session/load' ? { error: { code: -1, message: 'nope' } } : undefined));
    const e1 = await a.pool.run(runOpts({ sessionId: 'gone' })).catch((x) => x);
    expect(e1).toBeInstanceOf(BackendError);
    expect(e1.sessionId).toBe('gone');
    expect(e1.message).toBe('无法恢复会话 gone: nope');
    expect(a.pool.stats().sessions).toBe(0);

    const b = h({}, (m) => (m.method === 'session/load' ? { error: { code: -32602, message: 'Session not found: gone' } } : undefined));
    const e2 = await b.pool.run(runOpts({ sessionId: 'gone' })).catch((x) => x);
    expect(e2).toBeInstanceOf(BackendError);
    expect(e2.sessionId).toBeUndefined();
  });

  it('同 id 并发 -> 正在执行中', async () => {
    const { pool, children } = h({}, (m) => (m.method === 'session/prompt' && m.params.prompt[0].text === 'hang' ? 'none' : undefined));
    const r = await pool.run(runOpts());
    const a = pool.run(runOpts({ sessionId: r.sessionId, prompt: 'hang' }));
    await until(() => children[0].prompts.length === 2);
    const e = await pool.run(runOpts({ sessionId: r.sessionId })).catch((x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect(e.message).toBe('该 conversation_id 正在执行中');
    expect(e.sessionId).toBe(r.sessionId);
    children[0].reply(children[0].prompts[1].id, { stopReason: 'end_turn' });
    expect((await a).stopReason).toBe('end_turn');
    expect(pool.stats().busy).toBe(0);
  });
});

describe('模型与思考强度', () => {
  const models = {
    availableModels: ['neon-low', 'neon-high', 'orch'].map((modelId) => ({ modelId, name: modelId })),
    currentModelId: 'neon-high',
  };
  let n = 0;
  const withModels: Handler = (m) => {
    if (m.method === 'session/new') return { result: { sessionId: `m${++n}`, models } };
    if (m.method === 'session/load') return { result: { models: { ...models, currentModelId: 'neon-low' } } };
    return undefined;
  };
  const setIds = (all: (m: string) => Json[]) => all('session/set_model').map((m) => m.params.modelId);

  it('新会话：defaults.effort 优先于 opts.effort；一致时不发 set_model；报告实际模型', async () => {
    const { pool, all } = h({}, withModels);
    const seen: unknown[] = [];
    const onModel = (m: unknown) => void seen.push(m);
    await pool.run(runOpts({ defaults: { model: 'neon', effort: 'high' }, effort: 'low', onModel }));
    expect(setIds(all)).toEqual([]);
    await pool.run(runOpts({ defaults: { model: null, effort: null }, effort: 'low', onModel }));
    await pool.run(runOpts({ defaults: { model: 'orch', effort: 'low' }, onModel }));
    await pool.run(runOpts({ onModel }));
    expect(setIds(all)).toEqual(['neon-low', 'orch']);
    expect(seen).toEqual([
      { model: 'neon', effort: 'high' },
      { model: 'neon', effort: 'low' },
      { model: 'orch', effort: null },
      { model: 'neon', effort: 'high' },
    ]);
  });

  it('续聊沿用原来的模型，默认设置和 effort 不介入', async () => {
    const { pool, all } = h({}, withModels);
    const seen: unknown[] = [];
    await pool.run(runOpts({ sessionId: 'old-session', defaults: { model: 'orch', effort: 'high' }, effort: 'high', onModel: (m) => void seen.push(m) }));
    expect(setIds(all)).toEqual([]);
    expect(seen).toEqual([{ model: 'neon', effort: 'low' }]);
  });

  it('models()：开临时会话读取并关闭，之后走缓存，refresh 重新读', async () => {
    const { pool, all } = h({}, withModels);
    const list = await pool.models({ agyPath: 'agy', cwd: process.cwd() });
    expect(list.models.map((m) => [m.value, m.efforts])).toEqual([['neon', ['low', 'high']], ['orch', []]]);
    expect(list.current).toEqual({ model: 'neon', effort: 'high' });
    expect(all('session/close')).toHaveLength(1);
    await pool.models({ agyPath: 'agy', cwd: process.cwd() + '-other' });
    expect(all('session/new')).toHaveLength(1);
    await pool.models({ agyPath: 'agy', cwd: process.cwd(), refresh: true });
    expect(all('session/new')).toHaveLength(2);
    expect(pool.stats().sessions).toBe(0);
  });

  it('models()：冷启动列表为空会重试，一直空则报错且不缓存', async () => {
    let k = 0;
    const a = h({ modelsRetryMs: 1 }, (m) => (m.method === 'session/new' ? { result: { sessionId: `e${++k}`, models: k < 2 ? { availableModels: [] } : models } } : undefined));
    expect((await a.pool.models({ agyPath: 'agy', cwd: process.cwd() })).models).toHaveLength(2);
    const b = h({ modelsRetryMs: 1 });
    await expect(b.pool.models({ agyPath: 'agy', cwd: process.cwd() })).rejects.toThrow('没有返回模型列表');
  });
});

describe('取消', () => {
  it('进行中 abort -> 写出 session/cancel，reject 已取消，会话复位', async () => {
    const { pool, children } = h({}, (m, c) => {
      if (m.method === 'session/prompt') return 'none';
      if (m.method === 'session/cancel') c.reply(c.prompts[0].id, { stopReason: 'cancelled' });
      return undefined;
    });
    const ctl = new AbortController();
    const p = pool.run(runOpts({ signal: ctl.signal }));
    const rejected = p.catch((e) => e);
    await until(() => children[0]?.prompts.length === 1);
    ctl.abort();
    const e = await rejected;
    expect(e.message).toBe('已取消');
    expect(children[0].msgs.find((m) => m.method === 'session/cancel')?.params).toEqual({ sessionId: 's1' });
    expect(pool.stats().busy).toBe(0);
  });

  it('onSession 在 prompt 之前报告 sessionId；取消后立即同会话重 prompt 可用', async () => {
    let n = 0;
    const { pool, children } = h({}, (m, c) => {
      if (m.method === 'session/prompt') {
        if (n++ === 0) return 'none';
        return { result: { stopReason: 'end_turn' } };
      }
      if (m.method === 'session/cancel') c.reply(c.prompts[0].id, { stopReason: 'cancelled' });
      return undefined;
    });
    const sessions: string[] = [];
    const ctl = new AbortController();
    const first = pool.run(runOpts({ signal: ctl.signal, onSession: (id) => void sessions.push(id) })).catch((e) => e);
    await until(() => children[0]?.prompts.length === 1);
    expect(sessions).toEqual(['s1']);
    ctl.abort();
    expect((await first).message).toBe('已取消');
    expect(pool.stats().busy).toBe(0);

    const r = await pool.run(runOpts({ sessionId: 's1', prompt: '换个做法' }));
    expect(r).toMatchObject({ stopReason: 'end_turn', sessionId: 's1' });
    expect(children[0].methods()).not.toContain('session/load');
  });

  it('预先 abort -> 不 spawn', async () => {
    const { pool, spawn } = h();
    const ctl = new AbortController();
    ctl.abort();
    await expect(pool.run(runOpts({ signal: ctl.signal }))).rejects.toThrow('已取消');
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('首次输出看门狗', () => {
  function stuckHandler(opts: { stuckPrompts: number; cancelReturns: boolean }) {
    let n = 0;
    return (m: Json, c: FakeChild): Reply => {
      if (m.method === 'session/prompt') {
        if (++n <= opts.stuckPrompts) return 'none';
        c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } });
        return undefined;
      }
      if (m.method === 'session/cancel' && opts.cancelReturns) c.reply(c.prompts[c.prompts.length - 1].id, { stopReason: 'cancelled' });
      return undefined;
    };
  }

  it('(a) 卡死 -> cancel 后 prompt 返回 -> 同进程同会话重试成功', async () => {
    const { pool, spawn, children, kill } = h({ firstUpdateMs: 40, cancelGraceMs: 200 }, stuckHandler({ stuckPrompts: 1, cancelReturns: true }));
    const r = await pool.run(runOpts());
    expect(r).toMatchObject({ response: 'ok', sessionId: 's1' });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
    expect(children[0].methods()).toEqual(['initialize', 'session/new', 'session/prompt', 'session/cancel', 'session/prompt']);
  });

  it('(b) cancel 后也不返回 -> 杀进程、新 spawn、load、重试成功', async () => {
    const { pool, spawn, children, kill } = h({ firstUpdateMs: 40, cancelGraceMs: 40 }, stuckHandler({ stuckPrompts: 1, cancelReturns: false }));
    const r = await pool.run(runOpts());
    expect(r).toMatchObject({ response: 'ok', sessionId: 's1' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(children[0].pid);
    expect(children[1].methods()).toEqual(['initialize', 'session/load', 'session/prompt']);
  });

  it('(c) 重试也卡死 -> BackendError 带中性提示与 sessionId', async () => {
    const { pool, spawn, kill } = h({ firstUpdateMs: 40, cancelGraceMs: 40 }, stuckHandler({ stuckPrompts: 99, cancelReturns: false }));
    const e = await pool.run(runOpts()).catch((x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect(e.sessionId).toBe('s1');
    expect(e.message).toMatch(/委派任务无响应.*conversation_id/);
    expect(e.message).not.toMatch(/Antigravity|Gemini|\bagy\b/i);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(pool.stats().processes).toBe(0);
  });
});

describe('进程异常', () => {
  it('会话建立前 close -> pending reject 含退出码与 stderr（不含 agy）；下次重新 spawn', async () => {
    const { pool, spawn, children } = h({}, (m) => (m.method === 'session/new' ? 'none' : undefined));
    const p = pool.run(runOpts()).catch((e) => e);
    await until(() => children[0]?.methods().includes('session/new'));
    children[0].stderr.write('boom\n');
    await tick();
    children[0].emit('close', 3);
    const e = await p;
    expect(e.message).toContain('退出码 3');
    expect(e.message).toContain('boom');
    expect(e.message).not.toMatch(/Antigravity|Gemini|\bagy\b/i);
    expect(pool.stats().processes).toBe(0);
    const h2 = pool.run(runOpts({ prompt: 'again' })).catch((x) => x);
    await until(() => spawn.mock.calls.length === 2);
    void h2;
  });

  it('prompt 进行中进程意外退出 -> 新进程 session/load 并加提示前缀重试一次，丢弃旧文字但累加 toolCalls', async () => {
    let promptNum = 0;
    const { pool, spawn, children } = h({}, (m, c) => {
      if (m.method !== 'session/prompt') return undefined;
      const sid = m.params.sessionId;
      if (++promptNum === 1) {
        c.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '半截输出' } });
        c.update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', status: 'in_progress' });
        c.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
        c.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't2', status: 'failed' });
        return 'none';
      }
      c.update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'completed' });
      c.update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '继续完成' } });
      return { result: { stopReason: 'end_turn' } };
    });
    const p = pool.run(runOpts({ prompt: '原始任务' }));
    await until(() => children[0]?.prompts.length === 1);
    children[0].emit('close', 1);
    const r = await p;
    expect(r).toMatchObject({ stopReason: 'end_turn', response: '继续完成', sessionId: 's1', toolCalls: 3 });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[1].methods()).toEqual(['initialize', 'session/load', 'session/prompt']);
    expect(children[1].prompts[0].params.prompt[0].text).toBe(
      '(Your previous run of this task was interrupted because your process exited unexpectedly. Before continuing, check what has already been done, such as files changed and commands run, and do not repeat completed steps.)\n\n原始任务',
    );
  });

  it('prompt 进行中连续两次意外退出 -> BackendError 带 sessionId 与中性提示', async () => {
    const { pool, spawn, children } = h({}, (m) => (m.method === 'session/prompt' ? 'none' : undefined));
    const p = pool.run(runOpts()).catch((e) => e);
    await until(() => children[0]?.prompts.length === 1);
    children[0].emit('close', 1);
    await until(() => children[1]?.prompts.length === 1);
    children[1].stderr.write('boom\n');
    await tick();
    children[1].emit('close', 3);
    const e = await p;
    expect(e).toBeInstanceOf(BackendError);
    expect(e.sessionId).toBe('s1');
    expect(e.message).toContain('退出码 3');
    expect(e.message).toContain('boom');
    expect(e.message).not.toMatch(/Antigravity|Gemini|\bagy\b/i);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(pool.stats().processes).toBe(0);
  });

  it('进程 error 事件 -> 中性错误；stderr Authentication required -> AGY_NOT_LOGGED_IN 且不重试', async () => {
    const a = h({}, (m) => (m.method === 'initialize' ? 'none' : undefined));
    const p1 = a.pool.run(runOpts()).catch((e) => e);
    await until(() => a.children.length === 1);
    a.children[0].emit('error', new Error('ENOENT'));
    const e1 = await p1;
    expect(e1.message).toBe('无法启动委派进程: ENOENT');
    expect(e1.message).not.toMatch(/\bagy\b/i);

    const b = h({}, (m) => (m.method === 'session/prompt' ? 'none' : undefined));
    const p2 = b.pool.run(runOpts()).catch((e) => e);
    await until(() => b.children[0]?.prompts.length === 1);
    b.children[0].stderr.write('Error: Authentication required\n');
    expect((await p2).message).toBe(AGY_NOT_LOGGED_IN);
    expect(b.kill).toHaveBeenCalledWith(b.children[0].pid);
    expect(b.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('排空（draining）与运行中看门狗', () => {
  it('共享进程中一个会话卡死不杀其它在跑的 prompt；排空进程不接新会话、续聊会迁移，等在跑的完成后才关闭', async () => {
    const { pool, spawn, children, kill } = h(
      { maxPromptsPerProc: 3, maxProcsPerCwd: 3, firstUpdateMs: 40, cancelGraceMs: 40 },
      (m, c) => {
        if (m.method !== 'session/prompt') return undefined;
        const text = m.params.prompt[0].text;
        if (text === 'idle-setup') return { result: { stopReason: 'end_turn' } };
        if (text === 'healthy') {
          c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } });
          return 'none';
        }
        if (text === 'stuck' && c === children[0]) return 'none';
        c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `ok:${text}` } });
        return { result: { stopReason: 'end_turn' } };
      },
    );

    // 先在 proc 0 建一个空闲会话，稍后验证排空时会迁移走
    const idleSess = await pool.run(runOpts({ prompt: 'idle-setup' }));
    expect(spawn).toHaveBeenCalledTimes(1);

    // proc 0 上同时跑 healthy 和 stuck
    const pHealthy = pool.run(runOpts({ prompt: 'healthy' }));
    const pStuck = pool.run(runOpts({ prompt: 'stuck' }));

    // stuck 触发看门狗并排空 proc 0，随后在 proc 1 上 load 并完成
    const rStuck = await pStuck;
    expect(rStuck.response).toBe('ok:stuck');
    expect(spawn).toHaveBeenCalledTimes(2);
    // healthy 还在跑，proc 0 绝不能被杀
    expect(kill).not.toHaveBeenCalled();

    // 排空中的 proc 0 不接新会话
    const rNew = await pool.run(runOpts({ prompt: 'fresh' }));
    expect(rNew.response).toBe('ok:fresh');
    expect(children[0].prompts.some((p) => p.params.prompt[0].text === 'fresh')).toBe(false);
    expect(children[1].prompts.some((p) => p.params.prompt[0].text === 'fresh')).toBe(true);

    // 续聊归属在排空 proc 0 上的空闲会话 -> 在 proc 0 上 close，在 proc 1 上 load
    const rMoved = await pool.run(runOpts({ sessionId: idleSess.sessionId, prompt: 'moved' }));
    expect(rMoved.response).toBe('ok:moved');
    expect(children[0].msgs.some((m) => m.method === 'session/close' && m.params.sessionId === idleSess.sessionId)).toBe(true);
    expect(children[1].msgs.some((m) => m.method === 'session/load' && m.params.sessionId === idleSess.sessionId)).toBe(true);
    expect(kill).not.toHaveBeenCalled();

    // 放行 healthy -> proc 0 槽位归零，立刻关闭
    const healthyReq = children[0].prompts.find((p) => p.params.prompt[0].text === 'healthy')!;
    children[0].reply(healthyReq.id, { stopReason: 'end_turn' });
    const rHealthy = await pHealthy;
    expect(rHealthy.response).toBe('working');
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(children[0].pid);
  });

  it('调用方 abort 但 prompt 不返回 -> 排空进程并移除会话，下次同 sessionId 在新进程 session/load', async () => {
    const { pool, spawn, children, kill } = h({ cancelGraceMs: 40 }, (m, c) => {
      if (m.method !== 'session/prompt') return undefined;
      if (c === children[0]) {
        if (m.params.prompt[0].text === 'other') {
          c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'alive' } });
        }
        return 'none';
      }
      c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'reloaded' } });
      return { result: { stopReason: 'end_turn' } };
    });

    const pOther = pool.run(runOpts({ prompt: 'other' }));
    const ctl = new AbortController();
    let abortedSid = '';
    const pAborted = pool
      .run(runOpts({ prompt: 'to-abort', signal: ctl.signal, onSession: (id) => { abortedSid = id; } }))
      .catch((e) => e);
    await until(() => children[0]?.prompts.length === 2);

    ctl.abort();
    const err = await pAborted;
    expect(err.message).toBe('已取消');
    // 另一个 prompt 还在跑，不杀 proc 0
    expect(kill).not.toHaveBeenCalled();

    // 下次用同一 sessionId -> 走新进程并 session/load
    const rNext = await pool.run(runOpts({ sessionId: abortedSid, prompt: 'continue' }));
    expect(rNext).toMatchObject({ sessionId: abortedSid, response: 'reloaded' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(children[1].methods()).toEqual(['initialize', 'session/load', 'session/prompt']);

    // 放行 other -> proc 0 排空完成并关闭
    const otherReq = children[0].prompts.find((p) => p.params.prompt[0].text === 'other')!;
    children[0].reply(otherReq.id, { stopReason: 'end_turn' });
    expect((await pOther).response).toBe('alive');
    expect(kill).toHaveBeenCalledWith(children[0].pid);
  });

  it('运行中看门狗：无工具执行且超过 idleUpdateMs 无更新 -> 触发排空并换进程重试', async () => {
    const { pool, spawn, children, kill } = h(
      { firstUpdateMs: 500, idleUpdateMs: 50, cancelGraceMs: 30 },
      (m, c) => {
        if (m.method !== 'session/prompt') return undefined;
        if (c === children[0]) {
          // 发出首次进度后卡住
          c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '开始...' } });
          return 'none';
        }
        c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '恢复完成' } });
        return { result: { stopReason: 'end_turn' } };
      },
    );
    const r = await pool.run(runOpts());
    expect(r).toMatchObject({ response: '恢复完成', sessionId: 's1' });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenCalledWith(children[0].pid);
    expect(children[1].methods()).toEqual(['initialize', 'session/load', 'session/prompt']);
  });

  it('运行中看门狗：有工具执行中（未 completed/failed）时不触发', async () => {
    const { pool, spawn, children } = h(
      { firstUpdateMs: 500, idleUpdateMs: 40, cancelGraceMs: 30 },
      (m, c) => {
        if (m.method !== 'session/prompt') return undefined;
        c.update(m.params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'long-1', status: 'in_progress' });
        return 'none';
      },
    );
    const p = pool.run(runOpts());
    await until(() => children[0]?.prompts.length === 1);
    // 等待远超 idleUpdateMs 的时间，工具未结束不应触发 cancel
    await new Promise((r) => setTimeout(r, 120));
    expect(children[0].methods()).not.toContain('session/cancel');
    children[0].update('s1', { sessionUpdate: 'tool_call_update', toolCallId: 'long-1', status: 'completed' });
    children[0].update('s1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } });
    children[0].reply(children[0].prompts[0].id, { stopReason: 'end_turn' });
    const r = await p;
    expect(r).toMatchObject({ response: 'done', toolCalls: 1 });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('运行中看门狗连续两次失败 -> BackendError 带 sessionId 与中性文案', async () => {
    const { pool, spawn } = h(
      { firstUpdateMs: 500, idleUpdateMs: 40, cancelGraceMs: 30 },
      (m, c) => {
        if (m.method !== 'session/prompt') return undefined;
        c.update(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
        return 'none';
      },
    );
    const e = await pool.run(runOpts()).catch((x) => x);
    expect(e).toBeInstanceOf(BackendError);
    expect(e.sessionId).toBe('s1');
    expect(e.message).toMatch(/委派任务无响应.*conversation_id/);
    expect(e.message).not.toMatch(/Antigravity|Gemini|\bagy\b/i);
    expect(spawn).toHaveBeenCalledTimes(2);
  });
});

describe('sweep 回收、hold 与 prewarm', () => {
  it('会话超时 -> session/close；hold 阻止进程回收，释放后回收；额外进程无会话 2min 回收', async () => {
    let t = 0;
    const { pool, kill, children, all } = h(
      { now: () => t, sessionIdleMs: 1000, extraProcessIdleMs: 2000, processIdleMs: 5000, maxPromptsPerProc: 1, maxProcsPerCwd: 2 },
      (m) => (m.method === 'session/prompt' && m.params.prompt[0].text === 'hold' ? 'none' : undefined),
    );
    const release = pool.hold('agy', process.cwd());
    const p1 = pool.run(runOpts({ prompt: 'hold' }));
    await until(() => children[0]?.prompts.length === 1);
    await pool.run(runOpts({ prompt: 'second' }));
    expect(children).toHaveLength(2);
    children[0].reply(children[0].prompts[0].id, { stopReason: 'end_turn' });
    await p1;

    // 超过 sessionIdleMs：两个会话被关闭，但 hold 阻止进程被回收
    t = 1500;
    pool.sweep();
    await until(() => all('session/close').length === 2);
    expect(pool.stats()).toEqual({ processes: 2, sessions: 0, busy: 0 });
    t = 10_000;
    pool.sweep();
    expect(kill).not.toHaveBeenCalled();
    expect(pool.stats().processes).toBe(2);

    // 释放 hold（幂等）：再次 sweep，额外进程和主进程被回收
    release();
    release();
    pool.sweep();
    expect(kill).toHaveBeenCalledTimes(2);
    expect(pool.stats().processes).toBe(0);
  });

  it('额外进程在无会话超过 extraProcessIdleMs 后回收，主进程仍保留至 processIdleMs', async () => {
    let t = 0;
    const { pool, kill, children } = h(
      { now: () => t, sessionIdleMs: 1000, extraProcessIdleMs: 2000, processIdleMs: 10_000, maxPromptsPerProc: 1, maxProcsPerCwd: 2 },
      (m) => (m.method === 'session/prompt' && m.params.prompt[0].text === 'hold' ? 'none' : undefined),
    );
    const p1 = pool.run(runOpts({ prompt: 'hold' }));
    await until(() => children[0]?.prompts.length === 1);
    await pool.run(runOpts({ prompt: 'second' }));
    children[0].reply(children[0].prompts[0].id, { stopReason: 'end_turn' });
    await p1;

    t = 1500;
    pool.sweep(); // 关闭两个会话，extra.emptySince = 1500
    expect(pool.stats().processes).toBe(2);

    t = 4000; // 4000 - 1500 = 2500 > 2000 (extraProcessIdleMs), 但 4000 < 10000 (processIdleMs)
    pool.sweep();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(children[1].pid);
    expect(pool.stats().processes).toBe(1);
  });

  it('prewarm：initialize 后发送 session/new + session/close，重复调用不再触发，失败静默', async () => {
    const { pool, spawn, children, all } = h();
    pool.prewarm('agy', process.cwd());
    await until(() => all('session/close').length === 1);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(children[0].methods()).toEqual(['initialize', 'session/new', 'session/close']);
    expect(children[0].msgs[1].params).toEqual({ cwd: process.cwd(), mcpServers: [] });
    expect(children[0].msgs[2].params).toEqual({ sessionId: 's1' });
    expect(pool.stats()).toEqual({ processes: 1, sessions: 0, busy: 0 });

    // 已有活进程时再次 prewarm 不再 spawn 也不再建临时会话
    pool.prewarm('agy', process.cwd());
    await tick();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(all('session/new')).toHaveLength(1);
  });

  it('AgyBackend：available / prewarm / hold / run / models', async () => {
    const { pool, spawn } = h();
    const unavailable = new AgyBackend({ pool, agyPath: null });
    expect(unavailable.available()).toBe(false);
    unavailable.prewarm(process.cwd());
    expect(spawn).not.toHaveBeenCalled();

    const backend = new AgyBackend({ pool, agyPath: 'agy' });
    expect(backend.id).toBe('agy');
    expect(backend.label).toBe('Antigravity');
    expect(backend.available()).toBe(true);
    backend.prewarm(process.cwd());
    expect(spawn).toHaveBeenCalledTimes(1);
    backend.prewarm(process.cwd());
    expect(spawn).toHaveBeenCalledTimes(1);
    const r = await backend.run({ cwd: process.cwd(), prompt: 'hi', signal: new AbortController().signal });
    expect(r.stopReason).toBe('end_turn');
  });
});

describe('多账号分桶、模型缓存、hold、移除与默认模型回退', () => {
  it('两账号分桶与 env/args 隔离、模型缓存按账号分开', async () => {
    const accA = { id: 'default', dir: null };
    const accB = { id: 'acc22222', dir: 'X:/agy-root/acc22222', label: '工作' };
    const { pool, spawn } = h({}, (m) => {
      if (m.method !== 'session/new') return undefined;
      // 根据 spawn 顺序给不同账号返回不同的模型列表
      const callIdx = spawn.mock.calls.length;
      const models =
        callIdx === 1
          ? { currentModelId: 'model-a-high', availableModels: [{ modelId: 'model-a-high', name: 'Model A (High)' }] }
          : { currentModelId: 'model-b-medium', availableModels: [{ modelId: 'model-b-medium', name: 'Model B (Medium)' }] };
      return { result: { sessionId: `s-${callIdx}`, models } };
    });

    const mA = await pool.models({ agyPath: 'agy', cwd: process.cwd(), account: accA });
    const mB = await pool.models({ agyPath: 'agy', cwd: process.cwd(), account: accB });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(mA.models.map((m) => m.value)).toEqual(['model-a']);
    expect(mB.models.map((m) => m.value)).toEqual(['model-b']);

    // 校验 spawn 参数与 env
    const [, argsA, optsA] = spawn.mock.calls[0]!;
    const [, argsB, optsB] = spawn.mock.calls[1]!;
    expect(argsA).toEqual(['acp', '--dangerously-skip-permissions']);
    expect(optsA.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBeUndefined();
    expect(argsB).toContain('--gemini-dir');
    expect(argsB).toContain('--app-data-dir');
    expect(argsB).toContain('acc22222');
    expect(optsB.env.AGY_CLI_FORCE_FILE_TOKEN_STORAGE).toBe('1');
  });

  it('hold 按 cwd 统计：切账号后新账号桶被保活、旧账号桶按空闲时间正常回收', async () => {
    let t = 0;
    let active = 'default';
    const accA = { id: 'default', dir: null };
    const accB = { id: 'acc22222', dir: 'X:/agy-root/acc22222' };
    const { pool, kill, children } = h({
      now: () => t,
      activeAccountId: () => active,
      sessionIdleMs: 500,
      processIdleMs: 1000,
    });
    const release = pool.hold('agy', process.cwd());
    await pool.run(runOpts({ account: accA }));
    active = accB.id;
    await pool.run(runOpts({ account: accB }));
    expect(pool.stats().processes).toBe(2);

    t = 2000;
    pool.sweep();
    // 旧账号 A 不再受 hold 保护 -> 被回收；新账号 B 被 hold 住 -> 保留
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(children[0].pid);
    expect(pool.stats().processes).toBe(1);

    release();
    t = 4000;
    pool.sweep();
    expect(kill).toHaveBeenCalledTimes(2);
    expect(pool.stats().processes).toBe(0);
  });

  it('runningCount / stopAccount / resetAccount 与切换不影响执行中任务', async () => {
    const accB = { id: 'acc22222', dir: 'X:/agy-root/acc22222', label: '工作' };
    const { pool, kill, children } = h({}, (m) => (m.method === 'session/prompt' ? 'none' : undefined));

    const p = pool.run(runOpts({ account: accB }));
    await until(() => children[0]?.prompts.length === 1);
    expect(pool.runningCount(accB.id)).toBe(1);
    // 有执行中任务时 stopAccount 不动并返回 false
    expect(pool.stopAccount(accB.id)).toBe(false);
    expect(kill).not.toHaveBeenCalled();

    // resetAccount 对忙进程标 draining，不中断当前任务；完成后自动退出
    pool.resetAccount(accB.id);
    expect(kill).not.toHaveBeenCalled();
    children[0].reply(children[0].prompts[0].id, { stopReason: 'end_turn' });
    const res = await p;
    expect(res.accountId).toBe(accB.id);
    expect(pool.runningCount(accB.id)).toBe(0);
    expect(kill).toHaveBeenCalledWith(children[0].pid);
  });

  it('默认模型在另一账号不可用时回退到该账号的 current 模型，不让委派失败', async () => {
    const accB = { id: 'acc22222', dir: 'X:/agy-root/acc22222' };
    const { pool, all } = h({}, (m) => {
      if (m.method === 'session/new') {
        return {
          result: {
            sessionId: 's1',
            models: {
              currentModelId: 'model-b-medium',
              availableModels: [{ modelId: 'model-b-medium', name: 'Model B (Medium)' }],
            },
          },
        };
      }
      return undefined;
    });
    const reported: any[] = [];
    const r = await pool.run(
      runOpts({
        account: accB,
        defaults: { model: 'only-on-account-a', effort: null },
        onModel: (m) => reported.push(m),
      }),
    );
    expect(r.stopReason).toBe('end_turn');
    expect(all('session/set_model')).toHaveLength(0);
    expect(reported).toEqual([{ model: 'model-b', effort: 'medium' }]);
  });

  it('添加账号未登录报错含备注名；AgyBackend 续接已移除账号明确报错', async () => {
    const accB = { id: 'acc22222', dir: 'X:/agy-root/acc22222', label: '工作号' };
    const { pool } = h({}, (m) =>
      m.method === 'session/new' ? { error: { code: -32000, message: 'Authentication required' } } : undefined,
    );
    await expect(pool.run(runOpts({ account: accB }))).rejects.toThrow(
      'Antigravity 账号「工作号」未登录：请在左下角账号菜单重新登录',
    );

    const backend = new AgyBackend({
      pool,
      agyPath: 'agy',
      accounts: {
        activeAccount: () => ({ id: 'default', dir: null }),
        accountFor: (id) => (id === 'default' ? { id: 'default', dir: null } : null),
      },
    });
    await expect(
      backend.run({ cwd: process.cwd(), prompt: '续接', sessionId: 'old-s', accountId: 'removed1', signal: new AbortController().signal }),
    ).rejects.toThrow('创建这个委派会话的账号已移除，请新建委派');
  });

  it('retireAll：立即回收空闲进程、忙进程不打断且不再复用、完成后自动退出', async () => {
    const { pool, spawn, kill, children } = h({}, (m) =>
      m.method === 'session/prompt' && m.params.prompt[0].text === 'slow' ? 'none' : undefined,
    );
    // cwd A：空闲进程；cwd B：执行中进程
    await pool.run(runOpts({ cwd: process.cwd(), prompt: 'idle' }));
    const pSlow = pool.run(runOpts({ cwd: process.cwd() + '-busy', prompt: 'slow' }));
    await until(() => children[1]?.prompts.length === 1);
    expect(pool.stats().processes).toBe(2);
    expect(pool.runningCount()).toBe(1);

    // CLI 更新完成：retireAll 回收空闲进程 0，进程 1 继续执行不中断
    pool.retireAll();
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(children[0].pid);
    expect(pool.stats().processes).toBe(1);

    // 同 cwd B 新任务不会复用旧代进程 1，而是起新进程 2
    const rFast = await pool.run(runOpts({ cwd: process.cwd() + '-busy', prompt: 'fast' }));
    expect(rFast.stopReason).toBe('end_turn');
    expect(spawn).toHaveBeenCalledTimes(3);

    // 放行 slow -> 旧代进程 1 完成后自动退出
    children[1].reply(children[1].prompts[0].id, { stopReason: 'end_turn' });
    const rSlow = await pSlow;
    expect(rSlow.stopReason).toBe('end_turn');
    expect(kill).toHaveBeenCalledWith(children[1].pid);
    expect(pool.runningCount()).toBe(0);
    expect(pool.stats().processes).toBe(1);
  });

  it('stopAll：非 force 有任务时返回 stopped=false；force 终止全部任务与排队者不悬挂', async () => {
    const { pool, kill, children } = h(
      { maxPromptsPerProc: 1, maxProcsPerCwd: 1 },
      (m) => (m.method === 'session/prompt' ? 'none' : undefined),
    );
    const p1 = pool.run(runOpts({ prompt: 'running' })).catch((e) => e);
    await until(() => children[0]?.prompts.length === 1);
    const p2 = pool.run(runOpts({ prompt: 'queued' })).catch((e) => e);
    await tick();

    expect(pool.runningCount()).toBe(2);
    // 非 force：不动进程，返回 running=2
    expect(pool.stopAll(false)).toEqual({ stopped: false, running: 2 });
    expect(kill).not.toHaveBeenCalled();

    // force：立即终止进程与排队者，两者都按失败路径收尾，不重试、不悬挂
    expect(pool.stopAll(true)).toEqual({ stopped: true, running: 2 });
    const [e1, e2] = await Promise.all([p1, p2]);
    expect(e1).toBeInstanceOf(Error);
    expect(e1.message).toContain('强制重启');
    expect(e2).toBeInstanceOf(Error);
    expect(e2.message).toContain('强制重启');
    expect(kill).toHaveBeenCalledWith(children[0].pid);
    expect(pool.stats().processes).toBe(0);
    expect(pool.runningCount()).toBe(0);
  });

  it('livePids / onProcReady / onRunFinished：进程就绪与委派结束正确回调并列出存活 pid', async () => {
    const onProcReady = vi.fn();
    const onRunFinished = vi.fn();
    const { pool, children } = h({ onProcReady, onRunFinished });
    const account = { id: 'agy-1', dir: '/tmp/agy-1' };
    expect(pool.livePids('agy-1')).toEqual([]);

    await pool.run(runOpts({ account }));
    expect(onProcReady).toHaveBeenCalledTimes(1);
    expect(onProcReady).toHaveBeenCalledWith('agy-1', children[0]!.pid);
    expect(onRunFinished).toHaveBeenCalledTimes(1);
    expect(onRunFinished).toHaveBeenCalledWith('agy-1');
    expect(pool.livePids('agy-1')).toEqual([children[0]!.pid]);
    expect(pool.livePids('other')).toEqual([]);

    pool.stopAccount('agy-1');
    expect(pool.livePids('agy-1')).toEqual([]);
  });
});
