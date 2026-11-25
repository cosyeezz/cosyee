import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DelegateJobInfo, ServerMsg } from '@cosyee/shared';
import { Manager } from './claude/manager.js';
import type { DelegateJobs } from './delegate/jobs.js';
import { DelegateRecorder } from './delegate/record.js';
import { DotState } from './state.js';
import { StateStore } from './workspaces.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-dm-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const SID = '11111111-1111-4111-8111-111111111111';

const jobInfo = (state: DelegateJobInfo['state']): DelegateJobInfo => ({
  toolUseId: 'toolu_1',
  conversationId: 'conv-12345678',
  description: 'task',
  background: true,
  state,
  startedAt: 1,
  pending: 0,
  tail: '',
});

describe('Manager 的委派任务表', () => {
  it('探测进程与对话进程用同一张会话任务表：打开会话后马上发消息，探测进程会转正', () => {
    const m = new Manager({} as never) as any;
    const make = (probe: boolean) => m.createRunner(SID, dir, false, { model: 'sonnet', effort: 'medium' }, probe).delegateJobs as DelegateJobs;
    const probe = make(true);
    expect(probe).toBeDefined();
    expect(make(false)).toBe(probe);
  });

  it('过程事件既写盘也广播', async () => {
    const rec = new DelegateRecorder(dir);
    const m = new Manager({ delegateRecord: rec } as never) as any;
    const sent: any[] = [];
    m.emit = (_id: string, msg: unknown) => sent.push(msg);
    m.jobsFor(SID).o.onEvents([{ type: 'user', parent_tool_use_id: 'toolu_1', message: { content: 'x' } }]);
    expect(await rec.read(SID, 'toolu_1')).toHaveLength(1);
    expect(sent.map((x) => x.t)).toEqual(['event']);
  });

  it('后台委派运行中保持绿点，全部结束后通知侧栏并按订阅状态置 unread / null', () => {
    const dots = new DotState(new StateStore(path.join(dir, 'state.json')));
    const m = new Manager({ dots } as never) as any;
    const broadcast: ServerMsg[] = [];
    m.addClient({ send: (msg: ServerMsg) => broadcast.push(msg) });
    m.cwdOf.set(SID, dir);

    const onChange = m.jobsFor(SID).o.onChange as (jobs: DelegateJobInfo[]) => void;

    // 主进程已 idle，后台委派开始运行 → 绿点并通知侧栏
    onChange([jobInfo('running')]);
    expect(dots.dot(SID)).toBe('running');
    expect(broadcast.filter((x) => x.t === 'sessions.changed')).toHaveLength(1);

    // 委派全部结束且无订阅者 → 变为 unread 蓝点并通知侧栏
    onChange([jobInfo('done')]);
    expect(dots.dot(SID)).toBe('unread');
    expect(broadcast.filter((x) => x.t === 'sessions.changed')).toHaveLength(2);

    // 查看清除蓝点；有订阅者时委派结束后变为 null
    dots.viewed(SID);
    const sub = { send: () => {} };
    m.subs.set(SID, new Set([sub]));
    onChange([jobInfo('running')]);
    expect(dots.dot(SID)).toBe('running');
    onChange([jobInfo('done')]);
    expect(dots.dot(SID)).toBeNull();
  });

  it('切换账号（resetAll）不停掉后台委派，完成后照常通知', async () => {
    const m = new Manager({} as never) as any;
    m.cwdOf.set(SID, dir);
    const notified: any[] = [];
    m.notifyDelegate = (_id: string, n: unknown) => notified.push(n);
    let finish!: (r: any) => void;
    let aborted = false;
    const backend = {
      id: 'fake', label: 'fake', available: () => true, models: async () => ({ models: [] }),
      run: (o: any) => new Promise((resolve, reject) => {
        finish = resolve;
        o.signal.addEventListener('abort', () => { aborted = true; reject(new Error('已取消')); });
      }),
    };
    const jobs = m.jobsFor(SID) as DelegateJobs;
    const ctx = { cwd: dir, backend, agents: { configDir: dir, cwd: dir, disabled: [] } };
    const r = await jobs.callTool('delegate', { description: 'd', prompt: 'p' }, ctx as never, 'toolu_bg', new AbortController().signal);
    expect(JSON.stringify(r)).toContain('conversation_id: dlg_');
    // 首条 prompt 前要跑 git 收集上下文：等后端真正收到调用
    for (let i = 0; i < 200 && !finish; i++) await new Promise((res) => setTimeout(res, 10));
    expect(finish).toBeTypeOf('function');

    await m.resetAll(100);
    expect(aborted).toBe(false);
    expect(jobs.list()[0]!.state).toBe('running');

    finish({ stopReason: 'end_turn', response: 'ok', sessionId: 's1', toolCalls: 0 });
    await new Promise((res) => setTimeout(res, 20));
    expect(notified).toHaveLength(1);
    expect(notified[0].status).toBe('done');
  });

  it('进程退出清掉 Claude 后台任务但不影响仍在运行的 delegate 绿点', () => {
    const dots = new DotState(new StateStore(path.join(dir, 'state.json')));
    const m = new Manager({ dots } as never) as any;
    const broadcast: ServerMsg[] = [];
    m.addClient({ send: (msg: ServerMsg) => broadcast.push(msg) });
    m.cwdOf.set(SID, dir);

    const runner = m.createRunner(SID, dir, false, { model: 'sonnet', effort: 'medium' }, false);
    m.runners.set(SID, runner);
    // 模拟 Claude 后台子代理 + delegate 同时在跑
    runner.hooks.onBackgroundTasks(1);
    (m.jobsFor(SID).o.onChange as (jobs: DelegateJobInfo[]) => void)([jobInfo('running')]);
    expect(dots.dot(SID)).toBe('running');

    // 进程退出：Claude 后台任务清零，delegate 仍在跑 → 仍为 running
    runner.hooks.onExit();
    expect(dots.dot(SID)).toBe('running');

    // delegate 结束后不再残留绿点
    (m.jobsFor(SID).o.onChange as (jobs: DelegateJobInfo[]) => void)([jobInfo('done')]);
    expect(dots.dot(SID)).toBe('unread');
  });

  it('notifyDelegate：inject 抛错时保留 pending 并落盘，下次用户 send 时补发成功才移出', async () => {
    const rec = new DelegateRecorder(dir);
    const dots = new DotState(new StateStore(path.join(dir, 'state.json')));
    const m = new Manager({ dots, delegateRecord: rec } as never) as any;
    m.cwdOf.set(SID, dir);

    let failInject = true;
    const injected: string[] = [];
    const fakeRunner = {
      sessionId: SID,
      cwd: dir,
      alive: true,
      status: 'idle',
      accountId: null,
      send: () => {},
      inject: (text: string) => {
        if (failInject) throw new Error('pipe closed');
        injected.push(text);
      },
      shutdown: () => {},
    };
    m.runners.set(SID, fakeRunner);

    const jobs = m.jobsFor(SID) as DelegateJobs;
    const n = {
      conversationId: `dlg_${'a'.repeat(24)}`,
      toolUseId: 'toolu_1',
      status: 'done' as const,
      description: 'task',
      resultId: `res_${'a'.repeat(32)}`,
      result: 'done',
    };
    // 模拟通知入队并触发 notifyDelegate
    (jobs as any).pending.push({ n, fromRestart: false });
    await m.notifyDelegate(SID, n);
    expect(injected).toEqual([]);
    expect(jobs.pendingNotifications()).toHaveLength(1);

    // 下次用户 send：inject 成功，通知被补发并移出 pending
    failInject = false;
    m.send({ send: () => {} }, { t: 'send', sessionId: SID, cwd: dir, text: 'hi', config: { model: 'sonnet', effort: 'medium' } });
    await new Promise((r) => setTimeout(r, 20));
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain(n.resultId);
    expect(jobs.pendingNotifications()).toHaveLength(0);
    await jobs.flushPersist();
    expect(rec.readJobs(SID)?.pendingNotifications).toEqual([]);
  });

  it('notifyDelegate：缺 cwd 时通过 sessions.findCwd 补查，仍找不到时保留 pending 不丢弃', async () => {
    const rec = new DelegateRecorder(dir);
    let foundCwd: string | null = null;
    const sessions = { findCwd: async () => foundCwd };
    const m = new Manager({ sessions, delegateRecord: rec } as never) as any;
    const jobs = m.jobsFor(SID) as DelegateJobs;
    const n = {
      conversationId: `dlg_${'b'.repeat(24)}`,
      toolUseId: 'toolu_2',
      status: 'done' as const,
      description: 'task',
      resultId: `res_${'b'.repeat(32)}`,
      result: 'ok',
    };
    (jobs as any).pending.push({ n, fromRestart: false });

    // findCwd 返回 null：保留在 pending
    await m.notifyDelegate(SID, n);
    expect(jobs.pendingNotifications()).toHaveLength(1);

    // findCwd 返回有效 cwd 且有活 runner：送达并移出 pending
    foundCwd = dir;
    const injected: string[] = [];
    m.runners.set(SID, { sessionId: SID, cwd: dir, alive: true, inject: (t: string) => injected.push(t) });
    await m.notifyDelegate(SID, n);
    expect(injected).toHaveLength(1);
    expect(jobs.pendingNotifications()).toHaveLength(0);
  });

  it('服务重启恢复的通知绝不主动拉起 runner；用户 send（或探测进程转正）时才送达', async () => {
    const rec = new DelegateRecorder(dir);
    const dlgId = `dlg_${'e'.repeat(24)}`;
    await rec.saveJobs(SID, {
      jobs: [{ conversationId: dlgId, toolUseId: 'toolu_9', description: 'bg', agent: 'general-purpose', background: true, state: 'running', startedAt: 100 }],
      pendingNotifications: [],
    });

    const dots = new DotState(new StateStore(path.join(dir, 'state.json')));
    const m = new Manager({ dots, delegateRecord: rec } as never) as any;
    m.cwdOf.set(SID, dir);
    let createdRunners = 0;
    const injected: string[] = [];
    const origCreate = m.createRunner.bind(m);
    m.createRunner = (...args: any[]) => {
      createdRunners++;
      const r = origCreate(...args);
      r.start = () => {};
      r.send = () => {};
      r.inject = (t: string) => injected.push(t);
      Object.defineProperty(r, 'alive', { get: () => true });
      return r;
    };

    // 1. 恢复 jobs.json（running 变成 interrupted + pending），不拉起进程
    const jobs = m.jobsFor(SID) as DelegateJobs;
    expect(jobs.list()[0]).toMatchObject({ state: 'error', error: 'Interrupted because the service restarted' });
    expect(jobs.pendingNotifications()).toHaveLength(1);
    await jobs.flushPersist();
    expect(createdRunners).toBe(0);

    // 2. 即使 cwd 已知且 onExit 触发，也不会为了恢复的通知而拉起新进程
    await m.flushPending(SID, { allowSpawn: true, onlyLiveSpawn: true });
    expect(createdRunners).toBe(0);
    expect(injected).toEqual([]);

    // 3. 用户发送消息（拉起 runner 或探测进程转正）：通知随这次 send 送达
    m.send({ send: () => {} }, { t: 'send', sessionId: SID, cwd: dir, text: 'hello', config: { model: 'sonnet', effort: 'medium' } });
    await new Promise((r) => setTimeout(r, 20));
    await jobs.flushPersist();
    expect(createdRunners).toBe(1);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain(dlgId);
    expect(jobs.pendingNotifications()).toHaveLength(0);
  });

  it('forgetSession：静默停掉任务、丢弃任务表与待送达通知，并删除 <recordDir>/<sessionId>/', async () => {
    const rec = new DelegateRecorder(dir);
    const dots = new DotState(new StateStore(path.join(dir, 'state.json')));
    const m = new Manager({ dots, delegateRecord: rec } as never) as any;
    let aborted = false;
    const backend = {
      id: 'fake', label: 'fake', available: () => true, models: async () => ({ models: [] }),
      run: (o: any) => new Promise((_res, rej) => {
        o.signal.addEventListener('abort', () => { aborted = true; rej(new Error('已取消')); });
      }),
    };
    const jobs = m.jobsFor(SID) as DelegateJobs;
    const ctx = { cwd: dir, backend, agents: { configDir: dir, cwd: dir, disabled: [] } };
    await jobs.callTool('delegate', { description: 'd', prompt: 'p' }, ctx as never, 'toolu_bg', new AbortController().signal);
    await jobs.flushPersist();
    expect(fs.existsSync(path.join(dir, SID, 'jobs.json'))).toBe(true);
    for (let i = 0; i < 100 && !(jobs as any).jobs[0].cur; i++) await new Promise((r) => setTimeout(r, 5));

    m.forgetSession(SID);
    expect(aborted).toBe(true);
    expect(m.delegateJobs.has(SID)).toBe(false);
    // 等待异步删目录完成
    for (let i = 0; i < 100 && fs.existsSync(path.join(dir, SID)); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(path.join(dir, SID))).toBe(false);
  });
});
