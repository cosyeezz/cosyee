import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  TERM_HISTORY_LIMIT,
  TERM_TAB_LIMIT,
  TERM_TAB_NAME_MAX,
  TERM_WS_CLOSED,
  TERM_WS_LIMIT,
  type TermServerMsg,
} from '@cosyee/shared';
import { startServer, type RunningServer } from './server.js';
import { TerminalHistoryStore } from './terminal/history.js';
import { detectShells } from './terminal/shells.js';
import { startCommand } from './terminal/runner.js';
import { pathKey } from './paths.js';

const isWin = process.platform === 'win32';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cosyee-term-test-'));
const wsDir = path.join(tmpRoot, 'workspace');
const subDir = path.join(wsDir, 'sub-dir');
fs.mkdirSync(subDir, { recursive: true });

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 打开终端 WS 并收集消息的测试辅助工具 */
class TermWsClient {
  readonly msgs: TermServerMsg[] = [];
  private waiters: Array<{ pred: (m: TermServerMsg) => boolean; resolve: (m: TermServerMsg) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
  closed = false;
  closeCode: number | null = null;
  private closeWaiters: Array<(code: number) => void> = [];

  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString('utf8')) as TermServerMsg;
      this.msgs.push(m);
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const w = this.waiters[i]!;
        if (w.pred(m)) {
          clearTimeout(w.timer);
          this.waiters.splice(i, 1);
          w.resolve(m);
        }
      }
    });
    ws.on('close', (code) => {
      this.closed = true;
      this.closeCode = code;
      for (const fn of this.closeWaiters.splice(0)) fn(code);
    });
  }

  static connect(url: string): Promise<TermWsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const client = new TermWsClient(ws);
      ws.once('open', () => resolve(client));
      ws.once('error', reject);
    });
  }

  send(msg: unknown): void {
    this.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  waitFor<T extends TermServerMsg>(pred: (m: TermServerMsg) => m is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (m: TermServerMsg) => boolean, timeoutMs?: number): Promise<TermServerMsg>;
  waitFor(pred: (m: TermServerMsg) => boolean, timeoutMs = 15_000): Promise<TermServerMsg> {
    const existing = this.msgs.find(pred);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`等待消息超时（已收 ${this.msgs.length} 条：${this.msgs.map((m) => m.t).join(',')}）`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  /** 只匹配从 startIdx 之后（含）到达的消息，避免命中历史旧消息 */
  waitForFrom<T extends TermServerMsg>(startIdx: number, pred: (m: TermServerMsg) => m is T, timeoutMs?: number): Promise<T>;
  waitForFrom(startIdx: number, pred: (m: TermServerMsg) => boolean, timeoutMs?: number): Promise<TermServerMsg>;
  waitForFrom(startIdx: number, pred: (m: TermServerMsg) => boolean, timeoutMs = 15_000): Promise<TermServerMsg> {
    for (let i = startIdx; i < this.msgs.length; i++) {
      if (pred(this.msgs[i]!)) return Promise.resolve(this.msgs[i]!);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`等待消息超时（from=${startIdx}, 已收 ${this.msgs.length} 条：${this.msgs.map((m) => m.t).join(',')}）`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }

  waitClose(timeoutMs = 10_000): Promise<number> {
    if (this.closed && this.closeCode !== null) return Promise.resolve(this.closeCode);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待连接关闭超时')), timeoutMs);
      this.closeWaiters.push((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  outputOf(id: string): string {
    return this.msgs
      .filter((m): m is Extract<TermServerMsg, { t: 'out' }> => m.t === 'out' && m.id === id)
      .map((m) => m.data)
      .join('');
  }

  close(): void {
    this.ws.close();
  }
}

describe('TerminalHistoryStore', () => {
  it('去重（移到最后）、忽略空白、上限裁切与落盘恢复', async () => {
    const file = path.join(tmpRoot, 'hist-test.json');
    const store = new TerminalHistoryStore(file, 10);

    expect(store.addHistory(wsDir, '   ')).toBeNull();
    expect(store.addHistory(wsDir, '  echo 1  ')).toEqual(['echo 1']);
    expect(store.addHistory(wsDir, 'echo 2')).toEqual(['echo 1', 'echo 2']);
    // 重复命令移到最后
    expect(store.addHistory(wsDir, 'echo 1')).toEqual(['echo 2', 'echo 1']);
    // 已经在最后时无变化
    expect(store.addHistory(wsDir, 'echo 1')).toBeNull();

    // 删除与清空
    expect(store.removeHistory(wsDir, 'echo 2')).toEqual(['echo 1']);
    expect(store.clearHistory(wsDir)).toEqual([]);

    // 上限 TERM_HISTORY_LIMIT
    for (let i = 0; i < TERM_HISTORY_LIMIT + 25; i++) {
      store.addHistory(wsDir, `cmd-${i}`);
    }
    const list = store.getHistory(wsDir);
    expect(list.length).toBe(TERM_HISTORY_LIMIT);
    expect(list[0]).toBe('cmd-25');
    expect(list[list.length - 1]).toBe(`cmd-${TERM_HISTORY_LIMIT + 24}`);

    // shell 选择持久化
    store.setShell(wsDir, 'cmd');
    await store.idle();

    const reloaded = new TerminalHistoryStore(file, 10);
    expect(reloaded.getHistory(wsDir).length).toBe(TERM_HISTORY_LIMIT);
    expect(reloaded.getShell(wsDir)).toBe('cmd');
  });
});

describe('runner ENOENT 错误处理', () => {
  it('找不到可执行文件时返回 error 状态与中文原因', async () => {
    let out = '';
    const ended = await new Promise<{ state: string; exitCode: number | null }>((resolve) => {
      startCommand({
        shell: 'bash',
        bin: path.join(tmpRoot, 'non-existent-shell-xyz'),
        cmd: 'echo hi',
        cwd: wsDir,
        onData: (c) => {
          out += c;
        },
        onEnd: (r) => resolve({ state: r.state, exitCode: r.exitCode }),
      });
    });
    expect(ended.state).toBe('error');
    expect(ended.exitCode).toBeNull();
    expect(out).toMatch(/找不到/);
  });
});

describe('内置终端 WebSocket 端到端', () => {
  let srv: RunningServer;
  const stateFile = path.join(tmpRoot, 'state.json');

  const wsUrl = (root?: string, params?: { id?: string; create?: boolean }) => {
    const q = new URLSearchParams();
    if (root) q.set('root', root);
    if (params?.id !== undefined) q.set('id', params.id);
    if (params?.create) q.set('create', '1');
    const qs = q.toString();
    return `ws://127.0.0.1:${srv.port}/api/terminal/ws${qs ? `?${qs}` : ''}`;
  };

  afterAll(async () => {
    await srv?.stop();
  });

  it('启动服务并校验未登记工作空间被拒绝', async () => {
    srv = await startServer({
      port: 0,
      webDist: null,
      stateFile,
      cliModels: false,
      pricing: { table: () => ({ updatedAt: 0, fetchedAt: 0, source: 'builtin', models: [] }) },
    });
    srv.workspaces.add(wsDir);

    const bad = await TermWsClient.connect(wsUrl(path.join(tmpRoot, 'not-registered')));
    const err = await bad.waitFor((m): m is Extract<TermServerMsg, { t: 'error' }> => m.t === 'error');
    expect(err.message).toMatch(/未登记/);
    bad.close();

    const shells = await detectShells();
    expect(shells.list.length).toBeGreaterThan(0);
  }, 20_000);

  it('执行 echo、非零退出码、cd 保持目录、stop 终止长命令、stdin 读取与多客户端广播', async () => {
    const c1 = await TermWsClient.connect(wsUrl(wsDir));
    const c2 = await TermWsClient.connect(wsUrl(wsDir));

    const snap1 = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(pathKey(snap1.snap.root)).toBe(pathKey(wsDir));
    expect(pathKey(snap1.snap.cwd)).toBe(pathKey(wsDir));
    expect(snap1.snap.shells.length).toBeGreaterThan(0);

    // 1. 执行 echo，检查输出、退出码 0、以及 c2 广播同步
    c1.send({ t: 'run', id: 'b-echo', cmd: 'echo hello-cosyee' });
    const end1 = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-echo');
    expect(end1.state).toBe('done');
    expect(end1.exitCode).toBe(0);
    expect(c1.outputOf('b-echo')).toContain('hello-cosyee');
    // 第二个客户端也收到同一块的 end 与输出
    await c2.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-echo');
    expect(c2.outputOf('b-echo')).toContain('hello-cosyee');

    // 2. 非零退出码
    c1.send({ t: 'run', id: 'b-exit', cmd: 'exit 7' });
    const end2 = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-exit');
    expect(end2.state).toBe('done');
    expect(end2.exitCode).toBe(7);

    // 3. cd 子目录后下一条命令 cwd 改变
    c1.send({ t: 'run', id: 'b-cd', cmd: 'cd sub-dir' });
    const cwdMsg = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'cwd' }> => m.t === 'cwd' && pathKey(m.cwd) === pathKey(subDir));
    expect(pathKey(cwdMsg.cwd)).toBe(pathKey(subDir));
    await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-cd');

    c1.send({ t: 'run', id: 'b-pwd', cmd: isWin ? '(Get-Location).Path' : 'pwd' });
    const endPwd = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-pwd');
    expect(endPwd.exitCode).toBe(0);
    expect(c1.outputOf('b-pwd').toLowerCase()).toContain('sub-dir');

    // cwd.reset 回到根目录
    c1.send({ t: 'cwd.reset' });
    const resetMsg = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'cwd' }> => m.t === 'cwd' && pathKey(m.cwd) === pathKey(wsDir));
    expect(pathKey(resetMsg.cwd)).toBe(pathKey(wsDir));

    // 4. stop 终止长命令
    const longCmd = isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30';
    const t0 = Date.now();
    c1.send({ t: 'run', id: 'b-long', cmd: longCmd });
    await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'block' }> => m.t === 'block' && m.block.id === 'b-long');
    await new Promise((r) => setTimeout(r, 400));
    c1.send({ t: 'stop', id: 'b-long' });
    const endLong = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-long');
    expect(endLong.state).toBe('stopped');
    expect(Date.now() - t0).toBeLessThan(15_000);

    // 5. stdin 写入能被读取
    const stdinCmd = isWin
      ? '$x = [Console]::ReadLine(); Write-Output "GOT:$x"'
      : 'read x; echo "GOT:$x"';
    c1.send({ t: 'run', id: 'b-stdin', cmd: stdinCmd });
    await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'block' }> => m.t === 'block' && m.block.id === 'b-stdin');
    c1.send({ t: 'stdin', id: 'b-stdin', data: 'cosyee-input-42\n' });
    const endStdin = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-stdin');
    expect(endStdin.state).toBe('done');
    expect(endStdin.exitCode).toBe(0);
    expect(c1.outputOf('b-stdin')).toContain('GOT:cosyee-input-42');

    // 6. 切换 cmd（Windows 上额外验证 cmd 的 cd 和退出码）
    if (isWin && snap1.snap.shells.some((s) => s.id === 'cmd')) {
      c1.send({ t: 'shell', shell: 'cmd' });
      await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'shell' }> => m.t === 'shell' && m.shell === 'cmd');

      c1.send({ t: 'run', id: 'b-cmd-cd', cmd: 'cd sub-dir & echo in-cmd' });
      const endCmd = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-cmd-cd');
      expect(endCmd.exitCode).toBe(0);
      expect(c1.outputOf('b-cmd-cd')).toContain('in-cmd');
      await c1.waitFor(
        (m): m is Extract<TermServerMsg, { t: 'cwd' }> =>
          m.t === 'cwd' && pathKey(m.cwd) === pathKey(subDir) && m !== cwdMsg,
      );
      c1.send({ t: 'cwd.reset' });
      await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'cwd' }> => m.t === 'cwd' && pathKey(m.cwd) === pathKey(wsDir) && m !== resetMsg);
    }

    // 6b. Windows 上如果安装了 Git Bash，验证 Git Bash 的 cd（Windows 路径转换）与退出码
    if (isWin && snap1.snap.shells.some((s) => s.id === 'gitbash')) {
      c1.send({ t: 'shell', shell: 'gitbash' });
      await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'shell' }> => m.t === 'shell' && m.shell === 'gitbash');

      c1.send({ t: 'run', id: 'b-gitbash', cmd: 'cd sub-dir; echo in-gitbash; exit 3' });
      const endGb = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'b-gitbash');
      expect(endGb.exitCode).toBe(3);
      expect(c1.outputOf('b-gitbash')).toContain('in-gitbash');
      const gbCwd = [...c1.msgs].reverse().find((m): m is Extract<TermServerMsg, { t: 'cwd' }> => m.t === 'cwd');
      expect(gbCwd && pathKey(gbCwd.cwd)).toBe(pathKey(subDir));
    }

    // 7. clear / history.remove / history.clear
    c1.send({ t: 'clear' });
    const cleared = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'cleared' }> => m.t === 'cleared');
    expect(cleared.keep).toEqual([]);

    c1.send({ t: 'history.clear' });
    const histCleared = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'history' }> => m.t === 'history' && m.history.length === 0);
    expect(histCleared.history).toEqual([]);

    // 8. 非法 JSON 收到 error
    c1.send('{not-json');
    const badJson = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'error' }> => m.t === 'error' && m.message.includes('JSON'));
    expect(badJson.t).toBe('error');

    c1.close();
    c2.close();
  }, 45_000);

  it('多终端（标签页）：新建、隔离、无 id 兼容、4404/4429/1008、rename/move、close 与历史共享', async () => {
    const multiDir = path.join(tmpRoot, 'multi-workspace');
    const multiSub = path.join(multiDir, 'sub-a');
    fs.mkdirSync(multiSub, { recursive: true });
    srv.workspaces.add(multiDir);

    // 1. 无 id 兼容：自动创建并连接第一个终端
    const c1 = await TermWsClient.connect(wsUrl(multiDir));
    const snap1 = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'snapshot' }> => m.t === 'snapshot');
    const firstId = snap1.snap.id;
    expect(firstId).toBeTruthy();
    expect(snap1.snap.tabs.length).toBe(1);
    expect(snap1.snap.tabs[0]!.id).toBe(firstId);
    expect(snap1.snap.tabs[0]!.status).toBe('idle');

    // 再次不带 id 连接，连到同一个第一个终端
    const c1Dup = await TermWsClient.connect(wsUrl(multiDir));
    const snap1Dup = await c1Dup.waitFor((m): m is Extract<TermServerMsg, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(snap1Dup.snap.id).toBe(firstId);
    c1Dup.close();

    // 2. id 不存在且无 create：收到 closed（next 为第一个终端）并以 4404 关闭
    const missing = await TermWsClient.connect(wsUrl(multiDir, { id: 'non-existent-tab' }));
    const closedMissing = await missing.waitFor((m): m is Extract<TermServerMsg, { t: 'closed' }> => m.t === 'closed');
    expect(closedMissing.id).toBe('non-existent-tab');
    expect(closedMissing.next).toBe(firstId);
    expect(await missing.waitClose()).toBe(TERM_WS_CLOSED);

    // 3. create=1 但 id 不合法：收到 error 并以 1008 关闭
    const badId = await TermWsClient.connect(wsUrl(multiDir, { id: 'bad/id!', create: true }));
    const badIdErr = await badId.waitFor((m): m is Extract<TermServerMsg, { t: 'error' }> => m.t === 'error');
    expect(badIdErr.message).toMatch(/不合法/);
    expect(await badId.waitClose()).toBe(1008);

    // 4. create=1 新建第二个终端：c1 收到 tabs 广播，c2 收到含 2 个 tab 的 snapshot
    const c1MarkBeforeTab2 = c1.msgs.length;
    const c2 = await TermWsClient.connect(wsUrl(multiDir, { id: 'tab-2', create: true }));
    const snap2 = await c2.waitFor((m): m is Extract<TermServerMsg, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(snap2.snap.id).toBe('tab-2');
    expect(snap2.snap.tabs.map((t) => t.id)).toEqual([firstId, 'tab-2']);
    const c1TabsAfterCreate = await c1.waitForFrom(
      c1MarkBeforeTab2,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> => m.t === 'tabs' && m.tabs.length === 2,
    );
    expect(c1TabsAfterCreate.tabs.map((t) => t.id)).toEqual([firstId, 'tab-2']);

    // 5. 多终端 cwd / blocks / shell 隔离 & 命令历史跨终端共享
    const c2HistMark = c2.msgs.length;
    c1.send({ t: 'run', id: 'm-cd', cmd: 'cd sub-a' });
    await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'm-cd');
    await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'cwd' }> => m.t === 'cwd' && pathKey(m.cwd) === pathKey(multiSub));

    // c2 收到 history 广播（跨终端共享），但 c2 自己没收到 m-cd 的 block，cwd 仍是 multiDir
    const c2Hist = await c2.waitForFrom(
      c2HistMark,
      (m): m is Extract<TermServerMsg, { t: 'history' }> => m.t === 'history' && m.history.includes('cd sub-a'),
    );
    expect(c2Hist.history).toContain('cd sub-a');
    expect(c2.msgs.some((m) => m.t === 'block' && m.block.id === 'm-cd')).toBe(false);

    // 检查 tabs 广播里两个终端的 cwd 各自独立
    const tabsAfterCd = await c2.waitFor(
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> =>
        m.t === 'tabs' && m.tabs.some((t) => t.id === firstId && pathKey(t.cwd) === pathKey(multiSub)),
    );
    expect(pathKey(tabsAfterCd.tabs.find((t) => t.id === 'tab-2')!.cwd)).toBe(pathKey(multiDir));

    // 在 c2 里清空历史，c1 也收到空历史广播
    const c1HistClearMark = c1.msgs.length;
    c2.send({ t: 'history.clear' });
    const c1ClearedHist = await c1.waitForFrom(
      c1HistClearMark,
      (m): m is Extract<TermServerMsg, { t: 'history' }> => m.t === 'history' && m.history.length === 0,
    );
    expect(c1ClearedHist.history).toEqual([]);

    // shell 隔离：如果有至少两个可用 shell，切 tab-2 的 shell 不影响 firstId，但影响之后新建的 tab-3
    if (snap1.snap.shells.length >= 2) {
      const otherShell = snap1.snap.shells.find((s) => s.id !== snap1.snap.shell)!.id;
      const c1ShellMark = c1.msgs.length;
      c2.send({ t: 'shell', shell: otherShell });
      await c2.waitFor((m): m is Extract<TermServerMsg, { t: 'shell' }> => m.t === 'shell' && m.shell === otherShell);
      const tabsAfterShell = await c1.waitForFrom(
        c1ShellMark,
        (m): m is Extract<TermServerMsg, { t: 'tabs' }> =>
          m.t === 'tabs' && m.tabs.find((t) => t.id === 'tab-2')?.shell === otherShell,
      );
      expect(tabsAfterShell.tabs.find((t) => t.id === firstId)!.shell).toBe(snap1.snap.shell);

      // 新建 tab-3 默认继承工作空间默认 shell (otherShell)
      const c3Tmp = await TermWsClient.connect(wsUrl(multiDir, { id: 'tab-shell-inherit', create: true }));
      const snap3Tmp = await c3Tmp.waitFor((m): m is Extract<TermServerMsg, { t: 'snapshot' }> => m.t === 'snapshot');
      expect(snap3Tmp.snap.shell).toBe(otherShell);
      c3Tmp.close();
      // 关掉临时终端，恢复成 2 个终端
      const c1CloseTmpMark = c1.msgs.length;
      c1.send({ t: 'tab.close', id: 'tab-shell-inherit' });
      await c1.waitForFrom(
        c1CloseTmpMark,
        (m): m is Extract<TermServerMsg, { t: 'tabs' }> => m.t === 'tabs' && m.tabs.length === 2,
      );
    }

    // 6. status 的 running / failed / stopped->idle / clear->idle 变化
    // 6a. 运行非零退出码 -> failed，再 clear -> idle
    const c1FailMark = c1.msgs.length;
    c2.send({ t: 'run', id: 'm-fail', cmd: 'exit 5' });
    await c2.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'm-fail');
    const tabsFailed = await c1.waitForFrom(
      c1FailMark,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> =>
        m.t === 'tabs' && m.tabs.find((t) => t.id === 'tab-2')?.status === 'failed',
    );
    expect(tabsFailed.tabs.find((t) => t.id === 'tab-2')?.runningCmd).toBeUndefined();

    const c1ClearMark = c1.msgs.length;
    c2.send({ t: 'clear' });
    await c2.waitFor((m): m is Extract<TermServerMsg, { t: 'cleared' }> => m.t === 'cleared');
    await c1.waitForFrom(
      c1ClearMark,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> =>
        m.t === 'tabs' && m.tabs.find((t) => t.id === 'tab-2')?.status === 'idle',
    );

    // 6b. 运行长命令 -> running（含 runningCmd），stop 后 -> idle（stopped 不算失败）
    const longCmd = isWin ? 'ping -n 30 127.0.0.1' : 'sleep 30';
    const c1RunMark = c1.msgs.length;
    c2.send({ t: 'run', id: 'm-long-stop', cmd: longCmd });
    const tabsRunning = await c1.waitForFrom(
      c1RunMark,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> =>
        m.t === 'tabs' && m.tabs.find((t) => t.id === 'tab-2')?.status === 'running',
    );
    expect(tabsRunning.tabs.find((t) => t.id === 'tab-2')?.runningCmd).toBe(longCmd);
    await new Promise((r) => setTimeout(r, 300));
    const c1StopMark = c1.msgs.length;
    c2.send({ t: 'stop', id: 'm-long-stop' });
    await c2.waitFor((m): m is Extract<TermServerMsg, { t: 'end' }> => m.t === 'end' && m.id === 'm-long-stop');
    await c1.waitForFrom(
      c1StopMark,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> =>
        m.t === 'tabs' && m.tabs.find((t) => t.id === 'tab-2')?.status === 'idle',
    );

    // 7. tab.rename（trim、截断、空串清除、不存在 id 报错）与 tab.move（正常与越界夹紧）
    const longName = `  ${'A'.repeat(TERM_TAB_NAME_MAX + 15)}  `;
    const renameMark1 = c1.msgs.length;
    c1.send({ t: 'tab.rename', id: 'tab-2', name: longName });
    const tabsRenamed = await c1.waitForFrom(
      renameMark1,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> =>
        m.t === 'tabs' && m.tabs.find((t) => t.id === 'tab-2')?.name === 'A'.repeat(TERM_TAB_NAME_MAX),
    );
    expect(tabsRenamed.tabs.find((t) => t.id === 'tab-2')?.name?.length).toBe(TERM_TAB_NAME_MAX);

    const renameMark2 = c1.msgs.length;
    c1.send({ t: 'tab.rename', id: 'tab-2', name: '   ' });
    await c1.waitForFrom(
      renameMark2,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> =>
        m.t === 'tabs' && m.tabs.find((t) => t.id === 'tab-2')?.name === undefined,
    );

    const errRenameMark = c1.msgs.length;
    c1.send({ t: 'tab.rename', id: 'no-such-tab', name: 'x' });
    await c1.waitForFrom(errRenameMark, (m): m is Extract<TermServerMsg, { t: 'error' }> => m.t === 'error');

    // move: 把 tab-2 移到 index 0（越界 -5 夹紧到 0）
    const moveMark1 = c1.msgs.length;
    c1.send({ t: 'tab.move', id: 'tab-2', index: -5 });
    const tabsMoved1 = await c1.waitForFrom(
      moveMark1,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> => m.t === 'tabs' && m.tabs[0]?.id === 'tab-2',
    );
    expect(tabsMoved1.tabs.map((t) => t.id)).toEqual(['tab-2', firstId]);

    // 再移回末尾（越界 99 夹紧到末尾）
    const moveMark2 = c1.msgs.length;
    c1.send({ t: 'tab.move', id: 'tab-2', index: 99 });
    const tabsMoved2 = await c1.waitForFrom(
      moveMark2,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> => m.t === 'tabs' && m.tabs[1]?.id === 'tab-2',
    );
    expect(tabsMoved2.tabs.map((t) => t.id)).toEqual([firstId, 'tab-2']);

    // 8. 达到上限 TERM_TAB_LIMIT=8 后再 create=1 收到 error + 4429
    const extraClients: TermWsClient[] = [];
    for (let i = 3; i <= TERM_TAB_LIMIT; i++) {
      const cx = await TermWsClient.connect(wsUrl(multiDir, { id: `tab-${i}`, create: true }));
      await cx.waitFor((m): m is Extract<TermServerMsg, { t: 'snapshot' }> => m.t === 'snapshot');
      extraClients.push(cx);
    }
    const over = await TermWsClient.connect(wsUrl(multiDir, { id: 'tab-overflow', create: true }));
    const overErr = await over.waitFor((m): m is Extract<TermServerMsg, { t: 'error' }> => m.t === 'error');
    expect(overErr.message).toContain(`最多 ${TERM_TAB_LIMIT} 个终端`);
    expect(await over.waitClose()).toBe(TERM_WS_LIMIT);

    // 清理多余的 tab-3..tab-8
    for (let i = 3; i <= TERM_TAB_LIMIT; i++) {
      c1.send({ t: 'tab.close', id: `tab-${i}` });
    }
    await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'tabs' }> => m.t === 'tabs' && m.tabs.length === 2);
    for (const cx of extraClients) {
      expect(await cx.waitClose()).toBe(TERM_WS_CLOSED);
    }

    // 9. tab.close 杀掉运行中命令并让其连接收到 closed + 4404（next 为左邻 firstId）
    c2.send({ t: 'run', id: 'm-kill-on-close', cmd: longCmd });
    await c2.waitFor((m): m is Extract<TermServerMsg, { t: 'block' }> => m.t === 'block' && m.block.id === 'm-kill-on-close');
    await new Promise((r) => setTimeout(r, 300));
    const c1AfterClose2Mark = c1.msgs.length;
    c1.send({ t: 'tab.close', id: 'tab-2' });
    const c2Closed = await c2.waitFor((m): m is Extract<TermServerMsg, { t: 'closed' }> => m.t === 'closed');
    expect(c2Closed.id).toBe('tab-2');
    expect(c2Closed.next).toBe(firstId);
    expect(await c2.waitClose()).toBe(TERM_WS_CLOSED);
    const tabsOnlyFirst = await c1.waitForFrom(
      c1AfterClose2Mark,
      (m): m is Extract<TermServerMsg, { t: 'tabs' }> => m.t === 'tabs' && m.tabs.length === 1,
    );
    expect(tabsOnlyFirst.tabs[0]!.id).toBe(firstId);

    // 10. 关最后一个终端自动补一个新终端，next 为新终端 id
    c1.send({ t: 'tab.close', id: firstId });
    const c1Closed = await c1.waitFor((m): m is Extract<TermServerMsg, { t: 'closed' }> => m.t === 'closed');
    expect(c1Closed.id).toBe(firstId);
    expect(c1Closed.next).toBeTruthy();
    expect(c1Closed.next).not.toBe(firstId);
    expect(await c1.waitClose()).toBe(TERM_WS_CLOSED);

    // 连上自动补的新终端，确认它已就绪且为空终端
    const cNew = await TermWsClient.connect(wsUrl(multiDir, { id: c1Closed.next }));
    const snapNew = await cNew.waitFor((m): m is Extract<TermServerMsg, { t: 'snapshot' }> => m.t === 'snapshot');
    expect(snapNew.snap.id).toBe(c1Closed.next);
    expect(snapNew.snap.tabs.length).toBe(1);
    expect(snapNew.snap.blocks).toEqual([]);
    cNew.close();
  }, 45_000);
});
