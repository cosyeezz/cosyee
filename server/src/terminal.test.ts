import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { TERM_HISTORY_LIMIT, type TermServerMsg } from '@cosyee/shared';
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
    ws.on('close', () => {
      this.closed = true;
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

  const wsUrl = (root?: string) =>
    `ws://127.0.0.1:${srv.port}/api/terminal/ws${root ? `?root=${encodeURIComponent(root)}` : ''}`;

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
});
