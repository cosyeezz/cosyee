import { describe, expect, it, vi } from 'vitest';
import { AutoTitle, MATERIAL_MAX, MAX_ATTEMPTS, type TitleTarget, eventText } from './claude/autotitle.js';

type Json = Record<string, any>;

function setup(opts: { has?: boolean | null; first?: string } = {}) {
  let has: boolean | null = opts.has === undefined ? false : opts.has;
  const onTitled = vi.fn();
  const at = new AutoTitle({
    hasTitle: async () => has,
    firstPrompt: async () => opts.first,
    onTitled,
  });
  const reqs: Json[] = [];
  let reply: () => Promise<Json> = async () => ({ title: '登录页样式' });
  const r: TitleTarget & { alive: boolean } = {
    sessionId: 's1',
    alive: true,
    request: (subtype, extra = {}) => {
      reqs.push({ subtype, ...extra });
      return reply();
    },
  };
  return {
    at, r, reqs, onTitled,
    setHas: (v: boolean | null) => { has = v; },
    setReply: (f: () => Promise<Json>) => { reply = f; },
  };
}

const user = (text: string) => ({ type: 'cosyee_user', text, at: 0 });
const asst = (text: string, parent: string | null = null) => ({
  type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text }] },
});

describe('eventText', () => {
  it('取用户消息与主线程 assistant 正文，忽略思考 / 子代理 / 其它事件', () => {
    expect(eventText(user('你好'))).toBe('你好');
    expect(eventText(asst('答复'))).toBe('答复');
    expect(eventText(asst('子代理', 'toolu_1'))).toBeNull();
    expect(eventText({ type: 'stream_event' })).toBeNull();
    expect(eventText(null)).toBeNull();
  });
});

describe('AutoTitle', () => {
  it('没有标题：用本轮对话作素材请求 generate_session_title(persist)', async () => {
    const t = setup();
    t.at.collect('s1', user('改下样式'));
    t.at.collect('s1', asst('好的，已修改 login.css'));
    await t.at.ensure(t.r, 'C:\\w');
    expect(t.reqs).toEqual([
      { subtype: 'generate_session_title', description: '改下样式\n\n好的，已修改 login.css', persist: true },
    ]);
    expect(t.onTitled).toHaveBeenCalledWith('s1', 'C:\\w');
    // 成功后不再请求
    await t.at.ensure(t.r, 'C:\\w');
    expect(t.reqs).toHaveLength(1);
  });

  it('已有标题：不请求，之后也不再检查', async () => {
    const t = setup({ has: true });
    t.at.collect('s1', user('hi'));
    await t.at.ensure(t.r, 'c');
    t.setHas(false);
    await t.at.ensure(t.r, 'c');
    expect(t.reqs).toHaveLength(0);
  });

  it('读不到会话文件：本轮跳过，下轮再看', async () => {
    const t = setup({ has: null });
    t.at.collect('s1', user('hi'));
    await t.at.ensure(t.r, 'c');
    expect(t.reqs).toHaveLength(0);
    t.setHas(false);
    await t.at.ensure(t.r, 'c');
    expect(t.reqs).toHaveLength(1);
  });

  it('素材为空时用首条用户消息兜底；都没有则不请求', async () => {
    const t = setup({ first: '旧会话的第一句' });
    await t.at.ensure(t.r, 'c');
    expect(t.reqs[0]!.description).toBe('旧会话的第一句');
    const t2 = setup();
    await t2.at.ensure(t2.r, 'c');
    expect(t2.reqs).toHaveLength(0);
  });

  it('模型回空 / 请求失败会重试，最多 MAX_ATTEMPTS 次', async () => {
    const t = setup();
    t.at.collect('s1', user('hi'));
    let n = 0;
    t.setReply(async () => {
      if (n++ % 2) throw new Error('timeout');
      return { title: null };
    });
    for (let i = 0; i < MAX_ATTEMPTS + 2; i++) await t.at.ensure(t.r, 'c');
    expect(t.reqs).toHaveLength(MAX_ATTEMPTS);
    expect(t.onTitled).not.toHaveBeenCalled();
  });

  it('同一会话同时只有一个请求在途；进程已退出不请求', async () => {
    const t = setup();
    t.at.collect('s1', user('hi'));
    let release!: (v: Json) => void;
    t.setReply(() => new Promise((res) => { release = res; }));
    const p = t.at.ensure(t.r, 'c');
    await new Promise((r) => setTimeout(r, 0));
    await t.at.ensure(t.r, 'c');
    expect(t.reqs).toHaveLength(1);
    release({ title: 'x' });
    await p;

    const t2 = setup();
    t2.at.collect('s1', user('hi'));
    t2.r.alive = false;
    await t2.at.ensure(t2.r, 'c');
    expect(t2.reqs).toHaveLength(0);
  });

  it('observe：用户消息之后的第一个本轮事件立即触发，不等本轮结束；会话文件未落盘也照样生成', async () => {
    const t = setup({ has: null });
    const tick = () => new Promise((r) => setTimeout(r, 0));
    t.at.observe(t.r, 'c', user('修bug'));
    await tick();
    expect(t.reqs).toHaveLength(0); // CLI 还没接收这条消息
    t.at.observe(t.r, 'c', { type: 'system', subtype: 'init' });
    await tick();
    expect(t.reqs).toEqual([{ subtype: 'generate_session_title', description: '修bug', persist: true }]);
    expect(t.onTitled).toHaveBeenCalledTimes(1);
    // 已生成：后续消息不再触发
    t.at.observe(t.r, 'c', user('再改一下'));
    t.at.observe(t.r, 'c', { type: 'stream_event' });
    await tick();
    expect(t.reqs).toHaveLength(1);
  });

  it('observe：非本轮开始事件不触发；已有标题则不请求', async () => {
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const t = setup();
    t.at.observe(t.r, 'c', user('hi'));
    t.at.observe(t.r, 'c', { type: 'system', subtype: 'status' });
    await tick();
    expect(t.reqs).toHaveLength(0);
    t.at.observe(t.r, 'c', asst('答'));
    await tick();
    expect(t.reqs).toHaveLength(1);

    const t2 = setup({ has: true });
    t2.at.observe(t2.r, 'c', user('hi'));
    t2.at.observe(t2.r, 'c', asst('答'));
    await tick();
    expect(t2.reqs).toHaveLength(0);
  });

  it('素材以斜杠命令开头：改写成 "skill: 参数"（CLI 对无来源的斜杠命令素材直接返回 null）', async () => {
    const t = setup();
    t.at.collect('s1', user('/interaction-motion 优化一下账号模块'));
    t.at.collect('s1', asst('好的'));
    await t.at.ensure(t.r, 'c');
    expect(t.reqs[0]!.description).toBe('interaction-motion: 优化一下账号模块\n\n好的');

    const t2 = setup({ first: '/review' });
    await t2.at.ensure(t2.r, 'c');
    expect(t2.reqs[0]!.description).toBe('review');
  });

  it('素材截断到 MATERIAL_MAX', async () => {
    const t = setup();
    t.at.collect('s1', user('a'.repeat(MATERIAL_MAX - 10)));
    t.at.collect('s1', asst('b'.repeat(100)));
    t.at.collect('s1', asst('c'.repeat(100)));
    await t.at.ensure(t.r, 'c');
    const d = t.reqs[0]!.description as string;
    expect(d.length).toBe(MATERIAL_MAX);
    expect(d).not.toContain('c');
  });
});
