import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILTIN_PRICES, requestCost, uncachedCost, addCost, ZERO_COST } from '@cosyee/shared';
import { encodeCwd, encodeCwdCandidates, isSafeId } from './paths.js';
import { Sessions } from './sessions.js';
import { DotState } from './state.js';
import { StateStore } from './workspaces.js';
import { planLabel, nameFromOauth } from './account.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures');
const SID = '356bef19-b6ff-4428-a37c-12134e4e2bfd';
const CWD = 'F:\\Cosyee\\spike\\fake-ws';

let tmp: string;
let prevEnv: string | undefined;
let sessions: Sessions;
let dots: DotState;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-sess-'));
  prevEnv = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp;
  const dir = path.join(tmp, 'projects', encodeCwd(CWD));
  fs.mkdirSync(path.join(dir, SID, 'subagents'), { recursive: true });
  fs.copyFileSync(path.join(FIX, 'transcript-sample.jsonl'), path.join(dir, `${SID}.jsonl`));
  fs.copyFileSync(path.join(FIX, 'subagent-transcript.jsonl'), path.join(dir, SID, 'subagents', 'agent-a49bbf4470cede9cd.jsonl'));
  fs.copyFileSync(path.join(FIX, 'subagent-transcript.meta.json'), path.join(dir, SID, 'subagents', 'agent-a49bbf4470cede9cd.meta.json'));
  // 一个没有消息的空会话，应被跳过
  fs.writeFileSync(path.join(dir, '99999999-0000-4000-8000-000000000000.jsonl'), '{"type":"mode","mode":"normal"}\n');
  dots = new DotState(new StateStore(path.join(tmp, 'state.json')));
  sessions = new Sessions(dots);
});

afterAll(() => {
  if (prevEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('cwd 编码', () => {
  it('非字母数字字符各换成一个 -', () => {
    expect(encodeCwd('F:\\Cosyee')).toBe('F--Cosyee');
    expect(encodeCwd('C:\\a b\\中文')).toBe('C--a-b---');
    expect(encodeCwd('/home/u/proj.x')).toBe('-home-u-proj-x');
  });
  it('候选包含盘符大小写变体', () => {
    const c = encodeCwdCandidates('f:\\Cosyee');
    expect(c).toContain('f--Cosyee');
    expect(c).toContain('F--Cosyee');
  });
  it('isSafeId', () => {
    expect(isSafeId(SID)).toBe(true);
    expect(isSafeId('toolu_01Lv5LVynpaCKUoaWAvGFGoP')).toBe(true);
    expect(isSafeId('../x')).toBe(false);
    expect(isSafeId('a/b')).toBe(false);
    expect(isSafeId('')).toBe(false);
  });
});

describe('Sessions', () => {
  it('list：跳过 0 消息会话，标题与时间正确', async () => {
    const rows = await sessions.list(CWD);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: SID, cwd: CWD, title: '示例标题', dot: null });
    expect(rows[0]!.lastActiveAt).toBeGreaterThan(0);
    expect(rows[0]!.lastActiveAt).toBeLessThanOrEqual(Date.now());
  });

  it('list：目录不存在返回 []', async () => {
    expect(await sessions.list('F:\\nope\\nothing')).toEqual([]);
  });

  it('dot 随 DotState 变化', async () => {
    dots.setRunning(SID, true);
    expect((await sessions.list(CWD))[0]!.dot).toBe('running');
    dots.setRunning(SID, false);
    dots.turnFinished(SID, false);
    expect((await sessions.list(CWD))[0]!.dot).toBe('unread');
    expect(dots.viewed(SID)).toBe(true);
    expect((await sessions.list(CWD))[0]!.dot).toBeNull();
  });

  it('history 过滤个人信息条目', async () => {
    const h = await sessions.history(SID, CWD);
    const s = JSON.stringify(h);
    expect(s).not.toContain('accountUuid');
    expect(h.some((e) => e.type === 'attachment')).toBe(false);
    expect(h.length).toBeGreaterThan(3);
  });

  it('history：会话不存在抛 404；路径穿越的 id 被拒绝', async () => {
    await expect(sessions.history('00000000-0000-4000-8000-0000000000ff', CWD)).rejects.toMatchObject({ status: 404 });
    await expect(sessions.history('../../x', CWD)).rejects.toMatchObject({ status: 404 });
  });

  it('historyVersioned：版本没变只回 unchanged；文件追加后版本变化并返回条目', async () => {
    const a = await sessions.historyVersioned(SID, CWD);
    expect(a.entries).toEqual(await sessions.history(SID, CWD));
    expect(a.version).toMatch(/^\d+\.\d+\./);
    expect(await sessions.historyVersioned(SID, CWD, a.version)).toEqual({ version: a.version, unchanged: true });
    expect((await sessions.historyVersioned(SID, CWD, 'stale')).entries).toEqual(a.entries);

    const EMPTY = '99999999-0000-4000-8000-000000000000';
    const b = await sessions.historyVersioned(EMPTY, CWD);
    fs.appendFileSync(path.join(tmp, 'projects', encodeCwd(CWD), `${EMPTY}.jsonl`), '{"type":"mode","mode":"plan"}\n');
    const c = await sessions.historyVersioned(EMPTY, CWD, b.version);
    expect(c.version).not.toBe(b.version);
    expect(c.unchanged).toBeUndefined();
    expect(c.entries).toEqual([]);
    await expect(sessions.historyVersioned('00000000-0000-4000-8000-0000000000ff', CWD)).rejects.toMatchObject({ status: 404 });
  });

  it('subagent：按 meta.json 的 toolUseId 找到记录', async () => {
    const entries = await sessions.subagent(SID, 'toolu_01Lv5LVynpaCKUoaWAvGFGoP', CWD);
    expect(entries.length).toBeGreaterThan(0);
    await expect(sessions.subagent(SID, 'toolu_nope', CWD)).rejects.toMatchObject({ status: 404 });
  });

  it('appendTitle：追加两行后标题变化，文件仍以换行结尾', async () => {
    await sessions.appendTitle(SID, CWD, '新标题');
    const file = path.join(tmp, 'projects', encodeCwd(CWD), `${SID}.jsonl`);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    const last = text.trim().split('\n').slice(-2).map((l) => JSON.parse(l));
    expect(last).toEqual([
      { type: 'custom-title', customTitle: '新标题', sessionId: SID },
      { type: 'agent-name', agentName: '新标题', sessionId: SID },
    ]);
    expect((await sessions.list(CWD))[0]!.title).toBe('新标题');
  });

  it('appendTitle：文件末尾没有换行时先补一个', async () => {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    const file = path.join(tmp, 'projects', encodeCwd(CWD), `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
    await sessions.appendTitle(id, CWD, 'T');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).type).toBe('user');
  });

  it('findCwd 从会话头部读出 cwd 或返回 null', async () => {
    expect(await sessions.findCwd('00000000-0000-4000-8000-0000000000ff')).toBeNull();
    const v = await sessions.findCwd(SID);
    expect(v === null || typeof v === 'string').toBe(true);
  });
});

describe('fork', () => {
  const SRC = 'dddddddd-0000-4000-8000-000000000004';
  const U1 = '11111111-0000-4000-8000-0000000000a1';
  const U2 = '11111111-0000-4000-8000-0000000000a2';
  const U3 = '11111111-0000-4000-8000-0000000000a3';
  const NL = String.fromCharCode(10);
  let dir: string;
  /** 两轮对话：每轮「user + 它的 attachment + assistant」，中间夹着元数据行 */
  const lines = () => [
    { type: 'session-owner', sessionId: SRC },
    { type: 'user', uuid: U1, parentUuid: null, sessionId: SRC, cwd: CWD, message: { role: 'user', content: '第一问' } },
    { type: 'attachment', uuid: 'att-1', parentUuid: U1, sessionId: SRC },
    { type: 'assistant', uuid: 'asst-1', parentUuid: 'att-1', sessionId: SRC, message: { role: 'assistant', content: [] } },
    { type: 'last-prompt', sessionId: SRC },
    { type: 'attachment', uuid: 'att-2', parentUuid: 'asst-1', sessionId: SRC },
    { type: 'atis-latch', sessionId: SRC },
    { type: 'user', uuid: U2, parentUuid: 'att-2', sessionId: SRC, cwd: CWD, message: { role: 'user', content: '第二问' } },
    { type: 'assistant', uuid: 'asst-2', parentUuid: U2, sessionId: SRC, message: { role: 'assistant', content: [] } },
    { type: 'user', uuid: U3, parentUuid: 'asst-2', sessionId: SRC, cwd: CWD, message: { role: 'user', content: '第三问' } },
    { type: 'assistant', uuid: 'asst-3', parentUuid: U3, sessionId: SRC, message: { role: 'assistant', content: [] } },
    { type: 'custom-title', customTitle: '源标题', sessionId: SRC },
    { type: 'tools-used', sessionId: SRC },
  ];

  beforeAll(() => {
    dir = path.join(tmp, 'projects', encodeCwd(CWD));
    fs.writeFileSync(path.join(dir, `${SRC}.jsonl`), lines().map((l) => JSON.stringify(l)).join(NL) + NL);
  });

  const read = (id: string) =>
    fs.readFileSync(path.join(dir, `${id}.jsonl`), 'utf8').trim().split(NL).map((l) => JSON.parse(l));

  it('保留目标消息之前的内容，丢掉只服务于它的附属行；sessionId 换成新 id', async () => {
    const { sessionId } = await sessions.fork(SRC, CWD, U2);
    const out = read(sessionId);
    // 最后一条对话消息（asst-1）之后的附属行（last-prompt / att-2 / atis-latch）只服务于目标消息，一并丢掉；
    // 末尾两行标题是分支自己追加的
    expect(out.map((e) => e.type)).toEqual([
      'session-owner', 'user', 'attachment', 'assistant', 'custom-title', 'agent-name',
    ]);
    expect(out.every((e) => e.sessionId === sessionId)).toBe(true);
    expect(out.find((e) => e.type === 'user')!.uuid).toBe(U1);
    expect(out.find((e) => e.type === 'custom-title')!.customTitle).toBe('分支 · 源标题');
  });

  it('源会话一字不改', async () => {
    const before = fs.readFileSync(path.join(dir, `${SRC}.jsonl`), 'utf8');
    await sessions.fork(SRC, CWD, U2);
    expect(fs.readFileSync(path.join(dir, `${SRC}.jsonl`), 'utf8')).toBe(before);
  });

  it('分支出的会话能出现在列表里，标题是「分支 · 源标题」', async () => {
    const { sessionId } = await sessions.fork(SRC, CWD, U2);
    const row = (await sessions.list(CWD)).find((r) => r.id === sessionId);
    expect(row?.title).toBe('分支 · 源标题');
  });

  it('再从分支里分支：标题不重复堆前缀', async () => {
    const a = await sessions.fork(SRC, CWD, U3);
    const b = await sessions.fork(a.sessionId, CWD, U2);
    expect(read(b.sessionId).find((e) => e.type === 'custom-title')!.customTitle).toBe('分支 · 源标题');
    expect(read(b.sessionId).filter((e) => e.type === 'user').map((e) => e.uuid)).toEqual([U1]);
  });

  it('第一条消息之前没有内容：400，且不留下残文件', async () => {
    const before = fs.readdirSync(dir).length;
    await expect(sessions.fork(SRC, CWD, U1)).rejects.toMatchObject({ status: 400 });
    expect(fs.readdirSync(dir).length).toBe(before);
  });

  it('消息 id 不存在 404、格式不合法 400、会话不存在 404', async () => {
    await expect(sessions.fork(SRC, CWD, '11111111-0000-4000-8000-0000000000ff')).rejects.toMatchObject({ status: 404 });
    await expect(sessions.fork(SRC, CWD, 'not-a-uuid')).rejects.toMatchObject({ status: 400 });
    await expect(sessions.fork('00000000-0000-4000-8000-0000000000ff', CWD, U1)).rejects.toMatchObject({ status: 404 });
  });

  it('分支点之前的子代理：顺着 forkSrcOf 到来源会话目录下找', async () => {
    const { sessionId } = await sessions.fork(SRC, CWD, U2);
    // 分支自己没有 subagents 目录
    await expect(sessions.subagent(sessionId, 'toolu_01Lv5LVynpaCKUoaWAvGFGoP', CWD)).rejects.toMatchObject({ status: 404 });
    // 记上「分支 ← 来源」后，能找到来源会话里的子代理记录
    const withFork = new Sessions(dots, {
      isDeleted: () => false,
      pinKind: () => null,
      forkSrcOf: (id) => (id === sessionId ? SID : null),
    });
    const entries = await withFork.subagent(sessionId, 'toolu_01Lv5LVynpaCKUoaWAvGFGoP', CWD);
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe('account 辅助', () => {
  it('planLabel', () => {
    expect(planLabel('pro')).toBe('Pro');
    expect(planLabel('max')).toBe('Max');
    expect(planLabel('claude_max_5x')).toBe('Max');
    expect(planLabel('')).toBeNull();
    expect(planLabel(null)).toBeNull();
  });
  it('nameFromOauth：含 @ 的不用', () => {
    expect(nameFromOauth({ displayName: 'Alice' })).toBe('Alice');
    expect(nameFromOauth({ displayName: 'a@b.com', fullName: 'Full Name' })).toBe('Full Name');
    expect(nameFromOauth({ displayName: 'a@b.com' })).toBeNull();
    expect(nameFromOauth(null)).toBeNull();
  });
});

describe('subagentCosts', () => {
  const SID2 = 'bbbbbbbb-0000-4000-8000-000000000002';
  const NL = String.fromCharCode(10);
  const asst = (id: string, model: string, usage: object) =>
    JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', model, content: [], usage } });
  const u1 = { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const u1Final = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 2000, cache_read_input_tokens: 30000, cache_creation: { ephemeral_1h_input_tokens: 1500, ephemeral_5m_input_tokens: 500 } };
  const u2 = { input_tokens: 200, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, speed: 'fast', inference_geo: 'us' };

  beforeAll(() => {
    const dir = path.join(tmp, 'projects', encodeCwd(CWD));
    const sub = path.join(dir, SID2, 'subagents');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(dir, `${SID2}.jsonl`), JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }) + NL);
    // agent a1：同一个 message.id 写了两次（中途 + 最终），外加一条 <synthetic>
    fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), [
      asst('m1', 'claude-sonnet-4-5-20250929', u1),
      asst('m1', 'claude-sonnet-4-5-20250929', u1Final),
      asst('m2', '<synthetic>', u1),
      '坏行',
    ].join(NL) + NL);
    fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', toolUseId: 'toolu_x1' }));
    // agent a2：一个 opus 5.5（fast + 美国境内）、一个不认识的模型；没有 meta
    fs.writeFileSync(path.join(sub, 'agent-a2.jsonl'), [asst('m3', 'claude-opus-5-5', u2), asst('m4', 'gpt-x', u1)].join(NL) + NL);
  });

  it('按 message.id 去重（取最后一次）、跳过 synthetic、未知模型计入 unpriced', async () => {
    const items = await sessions.subagentCosts(SID2, CWD, BUILTIN_PRICES);
    expect(items.map((i) => i.agentId)).toEqual(['a1', 'a2']);
    const [a1, a2] = items as [typeof items[0], typeof items[0]];

    const r1 = { model: 'claude-sonnet-4-5-20250929', input: 1000, create: 2000, create1h: 1500, read: 30000, output: 500 };
    expect(a1).toMatchObject({ toolUseId: 'toolu_x1', agentType: 'Explore', requests: 1, unpriced: 0, models: ['claude-sonnet-4-5-20250929'] });
    expect(a1.cost).toEqual(requestCost(BUILTIN_PRICES, r1));
    expect(a1.uncached).toBeCloseTo(uncachedCost(BUILTIN_PRICES, r1)!, 12);

    const r2 = { model: 'claude-opus-5-5', input: 200, create: 0, create1h: 0, read: 5000, output: 100, fast: true, usGeo: true };
    expect(a2).toMatchObject({ toolUseId: null, requests: 2, unpriced: 1, models: ['claude-opus-5-5', 'gpt-x'] });
    expect(a2.agentType).toBeUndefined();
    expect(a2.cost).toEqual(addCost(ZERO_COST, requestCost(BUILTIN_PRICES, r2)!));
    expect(a2.uncached).toBeCloseTo(uncachedCost(BUILTIN_PRICES, r2)!, 12);
  });

  it('没有 subagents 目录返回空；会话不存在报 404', async () => {
    expect(await sessions.subagentCosts('99999999-0000-4000-8000-000000000000', CWD, BUILTIN_PRICES)).toEqual([]);
    await expect(sessions.subagentCosts('cccccccc-0000-4000-8000-000000000003', CWD, BUILTIN_PRICES)).rejects.toMatchObject({ status: 404 });
  });
});
