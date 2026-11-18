import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
