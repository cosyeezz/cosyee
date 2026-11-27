// 内置终端管理：每个工作空间一个 WorkspaceTerminal（状态与广播），TerminalManager 负责 WebSocket 接入与生命周期。
import fs from 'node:fs';
import path from 'node:path';
import {
  TERM_BLOCK_LIMIT,
  TERM_OUTPUT_LIMIT,
  type TermBlock,
  type TermClientMsg,
  type TermServerMsg,
  type TermShell,
  type TermSnapshot,
} from '@cosyee/shared';
import { WebSocket } from 'ws';
import { pathKey } from '../paths.js';
import { TerminalHistoryStore } from './history.js';
import { type RunningCommand, startCommand } from './runner.js';
import { type DetectedShells, detectShells } from './shells.js';

export interface TermClient {
  send(msg: TermServerMsg): void;
}

export class WorkspaceTerminal {
  private cwd: string;
  private shell: TermShell;
  private blocks: TermBlock[] = [];
  private running = new Map<string, RunningCommand>();
  private clients = new Set<TermClient>();

  constructor(
    readonly root: string,
    private readonly detected: DetectedShells,
    private readonly history: TerminalHistoryStore,
  ) {
    this.cwd = root;
    const saved = history.getShell(root);
    this.shell = saved && detected.bins[saved] ? saved : detected.defaultShell;
  }

  addClient(client: TermClient): void {
    this.clients.add(client);
    client.send({ t: 'snapshot', snap: this.snapshot() });
  }

  removeClient(client: TermClient): void {
    this.clients.delete(client);
  }

  snapshot(): TermSnapshot {
    return {
      root: this.root,
      cwd: this.cwd,
      shell: this.shell,
      shells: this.detected.list.map((s) => ({ ...s })),
      platform: process.platform,
      blocks: this.blocks.map((b) => ({ ...b })),
      history: this.history.getHistory(this.root),
    };
  }

  private broadcast(msg: TermServerMsg): void {
    for (const c of this.clients) c.send(msg);
  }

  handle(client: TermClient, msg: TermClientMsg): void {
    if (!msg || typeof msg !== 'object') {
      client.send({ t: 'error', message: '无效消息格式' });
      return;
    }
    switch (msg.t) {
      case 'run':
        this.handleRun(client, msg.id, msg.cmd);
        return;
      case 'stdin':
        if (typeof msg.id === 'string' && typeof msg.data === 'string') {
          this.running.get(msg.id)?.writeStdin(msg.data);
        }
        return;
      case 'stop':
        if (typeof msg.id === 'string') {
          this.running.get(msg.id)?.stop();
        }
        return;
      case 'clear': {
        this.blocks = this.blocks.filter((b) => b.state === 'running');
        this.broadcast({ t: 'cleared', keep: this.blocks.map((b) => b.id) });
        return;
      }
      case 'shell': {
        if (typeof msg.shell !== 'string' || !this.detected.bins[msg.shell]) {
          client.send({ t: 'error', message: `不可用的 shell: ${String(msg.shell)}` });
          return;
        }
        this.shell = msg.shell;
        this.history.setShell(this.root, msg.shell);
        this.broadcast({ t: 'shell', shell: msg.shell });
        return;
      }
      case 'cwd.reset': {
        if (pathKey(this.cwd) !== pathKey(this.root)) {
          this.cwd = this.root;
        }
        this.broadcast({ t: 'cwd', cwd: this.cwd });
        return;
      }
      case 'history.remove': {
        if (typeof msg.cmd !== 'string') return;
        const next = this.history.removeHistory(this.root, msg.cmd);
        this.broadcast({ t: 'history', history: next });
        return;
      }
      case 'history.clear': {
        const next = this.history.clearHistory(this.root);
        this.broadcast({ t: 'history', history: next });
        return;
      }
      default:
        client.send({ t: 'error', message: `未知消息类型: ${String((msg as { t?: unknown }).t)}` });
    }
  }

  private handleRun(client: TermClient, id: unknown, cmd: unknown): void {
    if (typeof id !== 'string' || !id.trim()) {
      client.send({ t: 'error', message: '缺少命令 id' });
      return;
    }
    if (typeof cmd !== 'string' || !cmd.trim()) {
      client.send({ t: 'error', id, message: '命令不能为空' });
      return;
    }
    if (this.running.has(id) || this.blocks.some((b) => b.id === id)) {
      client.send({ t: 'error', id, message: '命令 id 重复' });
      return;
    }

    // 若当前 cwd 已被删除，自动退回工作空间根目录
    try {
      if (!fs.statSync(this.cwd).isDirectory()) {
        this.cwd = this.root;
        this.broadcast({ t: 'cwd', cwd: this.cwd });
      }
    } catch {
      this.cwd = this.root;
      this.broadcast({ t: 'cwd', cwd: this.cwd });
    }

    const nextHist = this.history.addHistory(this.root, cmd);
    if (nextHist) this.broadcast({ t: 'history', history: nextHist });

    const block: TermBlock = {
      id,
      cmd,
      cwd: this.cwd,
      shell: this.shell,
      startedAt: Date.now(),
      state: 'running',
      output: '',
    };
    this.blocks.push(block);
    this.trimBlocks();
    this.broadcast({ t: 'block', block: { ...block } });

    const bin = this.detected.bins[this.shell] ?? this.shell;
    const task = startCommand({
      shell: this.shell,
      bin,
      cmd,
      cwd: this.cwd,
      onData: (chunk) => {
        block.output += chunk;
        if (block.output.length > TERM_OUTPUT_LIMIT) {
          block.output = block.output.slice(block.output.length - TERM_OUTPUT_LIMIT);
          block.truncated = true;
        }
        this.broadcast({ t: 'out', id, data: chunk });
      },
      onEnd: ({ state, exitCode, endedAt, nextCwd }) => {
        this.running.delete(id);
        block.state = state;
        block.exitCode = exitCode;
        block.endedAt = endedAt;
        this.broadcast({
          t: 'end',
          id,
          state,
          exitCode,
          endedAt,
          ...(block.truncated ? { truncated: true } : {}),
        });
        if (nextCwd && pathKey(nextCwd) !== pathKey(this.cwd)) {
          this.cwd = nextCwd;
          this.broadcast({ t: 'cwd', cwd: this.cwd });
        }
      },
    });
    this.running.set(id, task);
  }

  /** 超出 TERM_BLOCK_LIMIT 时丢弃最旧的已结束块 */
  private trimBlocks(): void {
    while (this.blocks.length > TERM_BLOCK_LIMIT) {
      const idx = this.blocks.findIndex((b) => b.state !== 'running');
      if (idx < 0) break;
      this.blocks.splice(idx, 1);
    }
  }

  /** 停止所有正在运行的命令 */
  async stopAll(timeoutMs = 2000): Promise<void> {
    const tasks = [...this.running.values()];
    if (tasks.length === 0) return;
    for (const t of tasks) t.stop();
    await Promise.race([
      Promise.allSettled(tasks.map((t) => t.done)),
      new Promise<void>((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}

export interface TerminalManagerDeps {
  workspaces: { find(p: string): { path: string } | null };
  dataDir: () => string;
}

export class TerminalManager {
  private readonly history: TerminalHistoryStore;
  private readonly terminals = new Map<string, WorkspaceTerminal>();

  constructor(private readonly deps: TerminalManagerDeps) {
    this.history = new TerminalHistoryStore(path.join(deps.dataDir(), 'terminal-history.json'));
  }

  async getOrCreate(root: string): Promise<WorkspaceTerminal> {
    const key = pathKey(root);
    let term = this.terminals.get(key);
    if (!term) {
      const detected = await detectShells();
      term = this.terminals.get(key);
      if (!term) {
        term = new WorkspaceTerminal(root, detected, this.history);
        this.terminals.set(key, term);
      }
    }
    return term;
  }

  async attach(ws: WebSocket, rawRoot: string | null): Promise<void> {
    const send = (msg: TermServerMsg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    if (!rawRoot) {
      send({ t: 'error', message: '缺少工作空间路径 root' });
      ws.close(1008, 'missing root');
      return;
    }
    const workspace = this.deps.workspaces.find(rawRoot);
    if (!workspace) {
      send({ t: 'error', message: '工作空间未登记' });
      ws.close(1008, 'unknown workspace');
      return;
    }

    const client: TermClient = { send };
    // 探测 shell 是异步的：期间到达的消息先缓存，终端就绪后按顺序处理，避免丢消息
    let term: WorkspaceTerminal | null = null;
    const pending: TermClientMsg[] = [];
    ws.on('message', (data) => {
      let msg: TermClientMsg;
      try {
        msg = JSON.parse(data.toString('utf8')) as TermClientMsg;
      } catch {
        client.send({ t: 'error', message: '消息不是合法 JSON' });
        return;
      }
      if (term) term.handle(client, msg);
      else pending.push(msg);
    });
    let closed = false;
    const cleanup = () => {
      closed = true;
      term?.removeClient(client);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    const t = await this.getOrCreate(workspace.path);
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    term = t;
    t.addClient(client);
    for (const msg of pending.splice(0)) t.handle(client, msg);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.terminals.values()].map((t) => t.stopAll()));
    await this.history.idle();
  }
}
