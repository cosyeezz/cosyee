// 侧栏相关：置顶（含自动置顶到期）、软删除 / 恢复 / 永久删除（路径校验）、工作空间排序与移除、HTTP 接口。
// 全部用临时目录（CLAUDE_CONFIG_DIR / COSYEE_HOME 指向 os.tmpdir() 下的 mkdtemp），不碰真实的 ~/.claude。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeCwd, isSessionUuid } from './paths.js';
import { AUTO_PIN_IDLE_MS, Pins } from './pins.js';
import { revealCommand, revealFolder } from './reveal.js';
import { type RunningServer, startServer } from './server.js';
import { Sessions } from './sessions.js';
import { DotState } from './state.js';
import { Trash } from './trash.js';
import { StateStore, Workspaces } from './workspaces.js';

const FIX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../shared/fixtures');
const A = '356bef19-b6ff-4428-a37c-12134e4e2bfd';
const B = '11111111-2222-4333-8444-555555555555';
const CWD = 'F:\\Cosyee\\spike\\fake-ws';
const CWD2 = 'F:\\Cosyee\\spike\\other-ws';

let tmp: string;
let prevClaude: string | undefined;
let prevHome: string | undefined;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-sidebar-'));
  prevClaude = process.env.CLAUDE_CONFIG_DIR;
  prevHome = process.env.COSYEE_HOME;
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
  process.env.COSYEE_HOME = path.join(tmp, 'home');
});

afterAll(() => {
  if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = prevClaude;
  if (prevHome === undefined) delete process.env.COSYEE_HOME;
  else process.env.COSYEE_HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function newStore(): StateStore {
  return new StateStore(path.join(tmp, `state-${n++}.json`));
}

/** 在临时 projects 下放一个会话：<uuid>.jsonl + <uuid>/subagents/x.jsonl */
function putSession(id: string, cwd: string): { dir: string; file: string; side: string } {
  const dir = path.join(tmp, 'claude', 'projects', encodeCwd(cwd));
  const side = path.join(dir, id);
  fs.mkdirSync(path.join(side, 'subagents'), { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.copyFileSync(path.join(FIX, 'transcript-sample.jsonl'), file);
  fs.writeFileSync(path.join(side, 'subagents', 'x.jsonl'), '{}\n');
  return { dir, file, side };
}

describe('Pins：手动 / 自动置顶', () => {
  let now = 1_000_000;
  const clock = () => now;
  let store: StateStore;
  let pins: Pins;
  let expired: number;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    store = newStore();
    expired = 0;
    pins = new Pins(store, { now: clock, onExpire: () => expired++ });
  });
  afterEach(() => {
    pins.dispose();
    vi.useRealTimers();
  });

  it('手动置顶一直保留，取消后消失', () => {
    pins.pin('a', CWD);
    now += 10 * AUTO_PIN_IDLE_MS;
    expect(pins.kind('a')).toBe('manual');
    expect(store.state.pinned.a).toEqual({ cwd: CWD, pinnedAt: 1_000_000 });
    pins.unpin('a');
    expect(pins.kind('a')).toBeNull();
    expect(store.state.pinned.a).toBeUndefined();
  });

  it('手动置顶按置顶时间倒序，排在自动置顶之前', () => {
    pins.onRunning('auto1', CWD, true);
    now += 1000;
    pins.pin('m1', CWD);
    now += 1000;
    pins.pin('m2', CWD2);
    expect(pins.list().map((e) => [e.id, e.kind])).toEqual([
      ['m2', 'manual'],
      ['m1', 'manual'],
      ['auto1', 'auto'],
    ]);
  });

  it('开始执行就自动置顶；执行期间永不过期', () => {
    expect(pins.onRunning('a', CWD, true)).toBe(true);
    expect(pins.kind('a')).toBe('auto');
    now += 5 * AUTO_PIN_IDLE_MS;
    vi.advanceTimersByTime(5 * AUTO_PIN_IDLE_MS);
    expect(pins.kind('a')).toBe('auto');
    expect(expired).toBe(0);
  });

  it('停止后从停止时刻起空闲满 30 分钟自动失效，并回调 onExpire（不需要刷新）', () => {
    pins.onRunning('a', CWD, true);
    now += 2 * AUTO_PIN_IDLE_MS; // 跑了很久
    pins.onRunning('a', CWD, false); // 此刻停止
    now += AUTO_PIN_IDLE_MS - 1000;
    vi.advanceTimersByTime(AUTO_PIN_IDLE_MS - 1000);
    expect(pins.kind('a')).toBe('auto');
    expect(expired).toBe(0);
    now += 2000;
    vi.advanceTimersByTime(2000);
    expect(pins.kind('a')).toBeNull();
    expect(expired).toBe(1);
    expect(store.state.autoPinned.a).toBeUndefined();
  });

  it('touch（回合结束）顺延到期时间', () => {
    pins.onRunning('a', CWD, true);
    pins.onRunning('a', CWD, false);
    now += AUTO_PIN_IDLE_MS - 1000;
    pins.touch('a');
    now += AUTO_PIN_IDLE_MS - 1000;
    expect(pins.kind('a')).toBe('auto');
    now += 2000;
    expect(pins.kind('a')).toBeNull();
  });

  it('取消自动置顶：即使还在执行也隐藏，下次开始执行再回来', () => {
    pins.onRunning('a', CWD, true);
    pins.unpin('a');
    expect(pins.kind('a')).toBeNull();
    expect(pins.list()).toEqual([]);
    pins.onRunning('a', CWD, false);
    expect(pins.onRunning('a', CWD, true)).toBe(true);
    expect(pins.kind('a')).toBe('auto');
  });

  it('手动置顶的会话开始执行不会产生自动置顶；手动置顶会盖掉自动置顶', () => {
    pins.pin('m', CWD);
    expect(pins.onRunning('m', CWD, true)).toBe(false);
    expect(store.state.autoPinned.m).toBeUndefined();
    pins.onRunning('x', CWD, true);
    pins.pin('x', CWD);
    expect(store.state.autoPinned.x).toBeUndefined();
    expect(pins.kind('x')).toBe('manual');
  });

  it('已删除的会话不能置顶，也不会被自动置顶', () => {
    store.state.deleted.d = { cwd: CWD, title: 't', deletedAt: 1 };
    expect(() => pins.pin('d', CWD)).toThrow(/已删除/);
    expect(pins.onRunning('d', CWD, true)).toBe(false);
    expect(pins.kind('d')).toBeNull();
  });

  it('启动时清掉已过期的自动置顶（服务重启后）', () => {
    store.state.autoPinned.old = { cwd: CWD, at: now - 2 * AUTO_PIN_IDLE_MS };
    store.state.autoPinned.fresh = { cwd: CWD, at: now - 1000 };
    const p2 = new Pins(store, { now: clock });
    expect(store.state.autoPinned.old).toBeUndefined();
    expect(p2.kind('fresh')).toBe('auto');
    p2.dispose();
  });
});

describe('state.json 读取容错', () => {
  it('缺字段 / 垃圾值都不会炸，已删除的不会同时置顶', async () => {
    const f = path.join(tmp, 'garbage.json');
    fs.writeFileSync(
      f,
      JSON.stringify({
        workspaces: [],
        pinned: { a: { cwd: CWD, pinnedAt: 'x' }, b: 5, c: { pinnedAt: 1 } },
        autoPinned: [1, 2],
        deleted: { a: { cwd: CWD, title: 9, deletedAt: 3 } },
      }),
    );
    const s = new StateStore(f).state;
    expect(s.pinned).toEqual({});
    expect(s.autoPinned).toEqual({});
    expect(s.deleted).toEqual({ a: { cwd: CWD, title: '', deletedAt: 3 } });
    expect(new StateStore(path.join(tmp, 'nope.json')).state.deleted).toEqual({});
  });

  it('pinned / autoPinned / deleted 落盘后能读回', async () => {
    const f = path.join(tmp, 'roundtrip.json');
    const st = new StateStore(f);
    st.state.pinned.a = { cwd: CWD, pinnedAt: 7 };
    st.state.autoPinned.b = { cwd: CWD, at: 8 };
    st.state.deleted.c = { cwd: CWD2, title: 'T', deletedAt: 9 };
    st.save();
    await st.idle();
    const back = new StateStore(f).state;
    expect(back.pinned.a).toEqual({ cwd: CWD, pinnedAt: 7 });
    expect(back.autoPinned.b).toEqual({ cwd: CWD, at: 8 });
    expect(back.deleted.c).toEqual({ cwd: CWD2, title: 'T', deletedAt: 9 });
  });
});

describe('Trash：软删除 / 恢复', () => {
  it('软删除不碰记录文件，清掉置顶，列表里排除，恢复后回来', async () => {
    const { file, side } = putSession(A, CWD);
    const store = newStore();
    const dots = new DotState(store);
    const pins = new Pins(store);
    const trash = new Trash(store, dots, pins, () => 5000);
    const sessions = new Sessions(dots, { isDeleted: (id) => trash.isDeleted(id), pinKind: (id) => pins.kind(id) });

    pins.pin(A, CWD);
    expect((await sessions.list(CWD)).map((s) => [s.id, s.pinned])).toEqual([[A, 'manual']]);

    trash.softDelete(A, CWD, '标题快照');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(side)).toBe(true);
    expect(await sessions.list(CWD)).toEqual([]);
    expect(await sessions.get(A, CWD)).toBeNull();
    expect(store.state.pinned[A]).toBeUndefined();
    expect(trash.list()).toEqual([{ id: A, cwd: CWD, title: '标题快照', deletedAt: 5000 }]);
    expect(store.state.deleted[A]).toEqual({ cwd: CWD, title: '标题快照', deletedAt: 5000 });

    expect(trash.restore(A)).toBe(CWD);
    expect(trash.list()).toEqual([]);
    const rows = await sessions.list(CWD);
    expect(rows.map((s) => [s.id, s.pinned])).toEqual([[A, null]]); // 恢复不会自动重新置顶
    pins.dispose();
  });

  it('执行中的会话不能删除；恢复不存在的 id 404', () => {
    const store = newStore();
    const dots = new DotState(store);
    const pins = new Pins(store);
    const trash = new Trash(store, dots, pins);
    dots.setRunning(A, true);
    expect(() => trash.softDelete(A, CWD, 't')).toThrow(/正在执行/);
    expect(store.state.deleted[A]).toBeUndefined();
    expect(() => trash.restore(B)).toThrow(/不在已删除列表/);
    pins.dispose();
  });

  it('批量：softDeleteMany 跳过执行中的并清掉置顶；restoreMany 忽略不在列表里的 id', () => {
    const store = newStore();
    const dots = new DotState(store);
    const pins = new Pins(store);
    const trash = new Trash(store, dots, pins, () => 7000);
    pins.pin(A, CWD);
    dots.setRunning(B, true);
    const r = trash.softDeleteMany([{ id: A, cwd: CWD, title: 'a' }, { id: B, cwd: CWD, title: 'b' }]);
    expect(r).toEqual({ deleted: [A], skipped: [B] });
    expect(store.state.deleted[A]).toEqual({ cwd: CWD, title: 'a', deletedAt: 7000 });
    expect(store.state.deleted[B]).toBeUndefined();
    expect(store.state.pinned[A]).toBeUndefined();
    expect(trash.restoreMany([A, B])).toEqual([A]);
    expect(trash.list()).toEqual([]);
    pins.dispose();
  });
});

describe('Trash：永久删除的路径校验', () => {
  function setup() {
    const store = newStore();
    const dots = new DotState(store);
    const pins = new Pins(store);
    const trash = new Trash(store, dots, pins);
    const sessions = new Sessions(dots);
    const locate = (id: string, cwd: string) => sessions.locate(id, cwd);
    return { store, dots, pins, trash, locate };
  }

  it('isSessionUuid 只认标准 UUID', () => {
    expect(isSessionUuid(A)).toBe(true);
    expect(isSessionUuid('../' + A)).toBe(false);
    expect(isSessionUuid(A + '/x')).toBe(false);
    expect(isSessionUuid('toolu_01Lv5LVynpaCKUoaWAvGFGoP')).toBe(false);
    expect(isSessionUuid('')).toBe(false);
    expect(isSessionUuid(undefined)).toBe(false);
  });

  it('只允许已在 deleted 里的 id：未删除的会话文件原样保留', async () => {
    const { file } = putSession(A, CWD);
    const { trash, locate } = setup();
    await expect(trash.purge(A, locate)).rejects.toMatchObject({ status: 404 });
    expect(fs.existsSync(file)).toBe(true);
  });

  it('id 不是 UUID 直接 400，即使它在 deleted 里', async () => {
    const { store, trash, locate } = setup();
    store.state.deleted['..'] = { cwd: CWD, title: 't', deletedAt: 1 };
    store.state.deleted['a/b'] = { cwd: CWD, title: 't', deletedAt: 1 };
    await expect(trash.purge('..', locate)).rejects.toMatchObject({ status: 400 });
    await expect(trash.purge('a/b', locate)).rejects.toMatchObject({ status: 400 });
  });

  it('删除 <id>.jsonl 与同名目录，不动同目录其它会话；并清掉 deleted / unread / pinned', async () => {
    const a = putSession(A, CWD);
    const b = putSession(B, CWD);
    const other = putSession(A.replace('3', '4'), CWD2); // 别的工作空间的会话
    const { store, trash, pins, locate } = setup();
    store.state.deleted[A] = { cwd: CWD, title: 't', deletedAt: 1 };
    store.state.unread[A] = true;
    store.state.pinned[A] = { cwd: CWD, pinnedAt: 1 }; // 异常数据：已删除却还有置顶，也要清掉

    await trash.purge(A, locate);
    expect(fs.existsSync(a.file)).toBe(false);
    expect(fs.existsSync(a.side)).toBe(false);
    expect(fs.existsSync(b.file)).toBe(true);
    expect(fs.existsSync(b.side)).toBe(true);
    expect(fs.existsSync(other.file)).toBe(true);
    expect(fs.existsSync(a.dir)).toBe(true); // 项目目录本身保留
    expect(store.state.deleted[A]).toBeUndefined();
    expect(store.state.unread[A]).toBeUndefined();
    expect(store.state.pinned[A]).toBeUndefined();
    pins.dispose();
  });

  it('执行中拒绝；文件已不在时只清记录', async () => {
    const a = putSession(A, CWD);
    const { store, dots, trash, pins, locate } = setup();
    store.state.deleted[A] = { cwd: CWD, title: 't', deletedAt: 1 };
    dots.setRunning(A, true);
    await expect(trash.purge(A, locate)).rejects.toMatchObject({ status: 409 });
    expect(fs.existsSync(a.file)).toBe(true);
    dots.setRunning(A, false);
    fs.rmSync(a.file);
    fs.rmSync(a.side, { recursive: true });
    await trash.purge(A, locate);
    expect(store.state.deleted[A]).toBeUndefined();
    pins.dispose();
  });

  it('定位结果不在 projects 的直接子目录下时拒绝，文件原样保留', async () => {
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(path.join(outside, A), { recursive: true });
    const victim = path.join(outside, `${A}.jsonl`);
    fs.writeFileSync(victim, 'x');
    const nested = path.join(tmp, 'claude', 'projects', 'p', 'nested');
    fs.mkdirSync(nested, { recursive: true });
    const nestedFile = path.join(nested, `${A}.jsonl`);
    fs.writeFileSync(nestedFile, 'x');
    const { store, trash, pins } = setup();
    store.state.deleted[A] = { cwd: CWD, title: 't', deletedAt: 1 };

    await expect(trash.purge(A, async () => ({ file: victim, dir: outside }))).rejects.toMatchObject({ status: 400 });
    await expect(trash.purge(A, async () => ({ file: nestedFile, dir: nested }))).rejects.toMatchObject({ status: 400 });
    // 用 .. 绕出 projects
    const sneaky = path.join(tmp, 'claude', 'projects', '..', 'outside');
    await expect(trash.purge(A, async () => ({ file: path.join(sneaky, `${A}.jsonl`), dir: sneaky }))).rejects.toMatchObject({ status: 400 });
    // 文件名与 id 不符
    const real = putSession(B, CWD);
    await expect(trash.purge(A, async () => ({ file: real.file, dir: real.dir }))).rejects.toMatchObject({ status: 400 });
    expect(fs.existsSync(victim)).toBe(true);
    expect(fs.existsSync(nestedFile)).toBe(true);
    expect(fs.existsSync(real.file)).toBe(true);
    expect(store.state.deleted[A]).toBeDefined();
    pins.dispose();
  });

  it('purgeMany：逐个校验，单个失败不影响其它', async () => {
    const a = putSession(A, CWD);
    const b = putSession(B, CWD);
    const { store, trash, pins, locate } = setup();
    store.state.deleted[A] = { cwd: CWD, title: 't', deletedAt: 1 };
    // B 不在已删除列表里 → 404，文件保留
    const r = await trash.purgeMany([B, A], locate);
    expect(r.purged).toEqual([A]);
    expect(r.failed.map((f) => f.id)).toEqual([B]);
    expect(fs.existsSync(a.file)).toBe(false);
    expect(fs.existsSync(b.file)).toBe(true);
    pins.dispose();
  });
});

describe('Workspaces：移到最前 / 从列表移除', () => {
  function make() {
    const store = newStore();
    const ws = new Workspaces(store);
    const dirs = ['w1', 'w2', 'w3'].map((n) => {
      const d = path.join(tmp, 'ws', n);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'keep.txt'), 'x');
      return d;
    });
    for (const d of dirs) ws.add(d);
    return { store, ws, dirs };
  }

  it('moveToTop 持久化新顺序；不在列表里 404', async () => {
    const { store, ws, dirs } = make();
    ws.moveToTop(dirs[2]!);
    expect(ws.list().list.map((w) => w.name)).toEqual(['w3', 'w1', 'w2']);
    await store.idle();
    expect(new Workspaces(new StateStore(path.join(tmp, `state-${n - 1}.json`))).list().list.map((w) => w.name)).toEqual(['w3', 'w1', 'w2']);
    expect(() => ws.moveToTop(path.join(tmp, 'ws', 'zzz'))).toThrow(/不在列表/);
  });

  it('remove 只改列表，不动磁盘；移除当前工作空间时切到下一个，没有下一个切到上一个，都没有则为 null', () => {
    const { ws, dirs } = make();
    ws.setCurrent(dirs[1]!);
    ws.remove(dirs[1]!);
    expect(ws.list().current).toBe(dirs[2]);
    expect(fs.existsSync(path.join(dirs[1]!, 'keep.txt'))).toBe(true);
    ws.remove(dirs[2]!);
    expect(ws.list().current).toBe(dirs[0]);
    ws.remove(dirs[0]!);
    expect(ws.list()).toEqual({ current: null, list: [] });
    expect(() => ws.remove(dirs[0]!)).toThrow(/不在列表/);
    for (const d of dirs) expect(fs.existsSync(path.join(d, 'keep.txt'))).toBe(true);
  });

  it('移除非当前工作空间不改 current', () => {
    const { ws, dirs } = make();
    ws.setCurrent(dirs[0]!);
    ws.remove(dirs[2]!);
    expect(ws.list().current).toBe(dirs[0]);
  });
});

describe('reveal：在文件管理器中打开', () => {
  it('各平台用参数数组，不经过 shell', () => {
    expect(revealCommand('C:\\a b', 'win32')).toEqual({ cmd: 'explorer.exe', args: ['C:\\a b'] });
    expect(revealCommand('/x', 'darwin')).toEqual({ cmd: 'open', args: ['/x'] });
    expect(revealCommand('/x', 'linux')).toEqual({ cmd: 'xdg-open', args: ['/x'] });
  });
  it('目录不存在时不 spawn', () => {
    const calls: string[][] = [];
    expect(revealFolder(path.join(tmp, 'nope'), (c, a) => calls.push([c, ...a]))).toBe(false);
    expect(calls).toEqual([]);
    expect(revealFolder(tmp, (c, a) => calls.push([c, ...a]))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]![1]).toBe(tmp);
  });
});

describe('HTTP 接口', () => {
  let srv: RunningServer;
  let base: string;
  let wsDir: string;
  let revealed: string[][];
  const post = (p: string, body?: unknown) =>
    fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const get = async (p: string) => (await fetch(`${base}${p}`)).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

  beforeAll(async () => {
    revealed = [];
    wsDir = path.join(tmp, 'http-ws');
    fs.mkdirSync(wsDir, { recursive: true });
    putSession(A, wsDir);
    putSession(B, wsDir);
    srv = await startServer({
      port: 0,
      webDist: null,
      stateFile: path.join(tmp, 'http-state.json'),
      spawner: (c, a) => revealed.push([c, ...a]),
    });
    base = `http://127.0.0.1:${srv.port}`;
    srv.workspaces.add(wsDir);
  });
  afterAll(async () => {
    await srv.stop();
  });

  it('置顶 → /api/pins → 取消置顶', async () => {
    expect((await post(`/api/sessions/${A}/pin`, { cwd: wsDir })).status).toBe(200);
    const pins = await get('/api/pins');
    expect(pins.map((s: { id: string; pinned: string }) => [s.id, s.pinned])).toEqual([[A, 'manual']]);
    const list = await get(`/api/sessions?cwd=${encodeURIComponent(wsDir)}`);
    expect(list.find((s: { id: string }) => s.id === A).pinned).toBe('manual');
    expect(list.find((s: { id: string }) => s.id === B).pinned).toBeNull();
    expect((await post(`/api/sessions/${A}/unpin`, { cwd: wsDir })).status).toBe(200);
    expect(await get('/api/pins')).toEqual([]);
  });

  it('执行中的新会话（记录文件还没写出来）在 /api/pins 里有占位行，停止后不再返回', async () => {
    const C = '22222222-3333-4444-8555-666666666666';
    srv.pins.onRunning(C, wsDir, true);
    const pins = await get('/api/pins');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ id: C, cwd: wsDir, title: '', pinned: 'auto' });
    srv.pins.onRunning(C, wsDir, false);
    expect(await get('/api/pins')).toEqual([]);
    srv.pins.clear(C);
  });

  it('置顶不存在的会话 404', async () => {
    expect((await post(`/api/sessions/${'0'.repeat(8)}-0000-4000-8000-000000000000/pin`, { cwd: wsDir })).status).toBe(404);
  });

  it('软删除 → /api/deleted → 恢复；记录文件不动', async () => {
    const file = path.join(tmp, 'claude', 'projects', encodeCwd(wsDir), `${B}.jsonl`);
    expect((await post(`/api/sessions/${B}/delete`, { cwd: wsDir })).status).toBe(200);
    expect(fs.existsSync(file)).toBe(true);
    const del = await get('/api/deleted');
    expect(del).toHaveLength(1);
    expect(del[0]).toMatchObject({ id: B, cwd: wsDir });
    expect(typeof del[0].title).toBe('string');
    const list = await get(`/api/sessions?cwd=${encodeURIComponent(wsDir)}`);
    expect(list.map((s: { id: string }) => s.id)).toEqual([A]);
    expect((await post(`/api/sessions/${B}/restore`)).status).toBe(200);
    expect(await get('/api/deleted')).toEqual([]);
    expect((await post(`/api/sessions/${B}/restore`)).status).toBe(404);
  });

  it('永久删除只对已删除的会话生效', async () => {
    const dir = path.join(tmp, 'claude', 'projects', encodeCwd(wsDir));
    expect((await post(`/api/sessions/${B}/purge`)).status).toBe(404);
    expect(fs.existsSync(path.join(dir, `${B}.jsonl`))).toBe(true);
    await post(`/api/sessions/${B}/delete`, { cwd: wsDir });
    expect((await post(`/api/sessions/${B}/purge`)).status).toBe(200);
    expect(fs.existsSync(path.join(dir, `${B}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(dir, B))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${A}.jsonl`))).toBe(true);
    expect(await get('/api/deleted')).toEqual([]);
    expect((await post('/api/sessions/not-a-uuid/purge')).status).toBe(400);
  });

  it('批量删除 → 批量恢复 → 批量永久删除', async () => {
    const C = '33333333-4444-4555-8666-777777777777';
    putSession(C, wsDir);
    const dir = path.join(tmp, 'claude', 'projects', encodeCwd(wsDir));
    // 不存在的 id 忽略；只删给出的那些
    const r = await (await post('/api/sessions/delete-many', { cwd: wsDir, ids: [A, C, 'nope'] })).json();
    expect(r).toEqual({ deleted: 2, skipped: 0 });
    expect((await get(`/api/sessions?cwd=${encodeURIComponent(wsDir)}`)).map((s: { id: string }) => s.id)).not.toContain(A);
    expect((await get('/api/deleted')).map((d: { id: string }) => d.id).sort()).toEqual([A, C].sort());

    expect(await (await post('/api/deleted/restore', { ids: [A] })).json()).toEqual({ restored: 1 });
    expect((await get('/api/deleted')).map((d: { id: string }) => d.id)).toEqual([C]);

    // A 未删除 → 失败计数；C 被永久删除
    const p = await (await post('/api/deleted/purge', { ids: [A, C] })).json();
    expect(p).toMatchObject({ purged: 1, failed: 1 });
    expect(fs.existsSync(path.join(dir, `${C}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(dir, `${A}.jsonl`))).toBe(true);
    expect(await get('/api/deleted')).toEqual([]);

    expect((await post('/api/deleted/purge', { ids: [] })).status).toBe(400);
    expect((await post('/api/deleted/restore', { ids: ['../x'] })).status).toBe(400);
    expect((await post('/api/sessions/delete-many', { ids: [A] })).status).toBe(400);
  });

  it('打开文件夹：只接受工作空间列表里的路径', async () => {
    expect((await post('/api/workspaces/reveal', { path: tmp })).status).toBe(404);
    expect(revealed).toEqual([]);
    expect((await post('/api/workspaces/reveal', { path: wsDir })).status).toBe(200);
    expect(revealed).toHaveLength(1);
    expect(revealed[0]![1]).toBe(wsDir);
    expect((await post('/api/workspaces/reveal', {})).status).toBe(400);
  });

  it('移到最前 / 移除', async () => {
    const extra = path.join(tmp, 'http-ws-2');
    fs.mkdirSync(extra, { recursive: true });
    srv.workspaces.add(extra);
    const top = await (await post('/api/workspaces/top', { path: extra })).json();
    expect(top.list[0].path).toBe(extra);
    const removed = await (await post('/api/workspaces/remove', { path: extra })).json();
    expect(removed.list.map((w: { path: string }) => w.path)).toEqual([wsDir]);
    expect(fs.existsSync(extra)).toBe(true);
    expect((await post('/api/workspaces/remove', { path: extra })).status).toBe(404);
  });
});
