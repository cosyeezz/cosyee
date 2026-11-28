// 内置终端管理：每个工作空间一个 WorkspaceTerminalGroup（管理有序的一组 TerminalSession），
// TerminalManager 负责 WebSocket 接入、多终端生命周期与跨终端广播。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  TERM_BLOCK_LIMIT,
  TERM_OUTPUT_LIMIT,
  TERM_TAB_LIMIT,
  TERM_TAB_NAME_MAX,
  TERM_WS_CLOSED,
  TERM_WS_LIMIT,
  type TermBlock,
  type TermClientMsg,
  type TermServerMsg,
  type TermShell,
  type TermSnapshot,
  type TermTabInfo,
  type TermTabStatus,
} from '@cosyee/shared';
import { WebSocket } from 'ws';
import { pathKey } from '../paths.js';
import { TerminalHistoryStore } from './history.js';
import { type RunningCommand, startCommand } from './runner.js';
import { type DetectedShells, detectShells } from './shells.js';

const VALID_TAB_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface TermClient {
  send(msg: TermServerMsg): void;
  close?(code?: number, reason?: string): void;
}

interface TerminalCallbacks {
  getTabs: () => TermTabInfo[];
  onHistoryChange: (history: string[]) => void;
  onMetaChange: () => void;
  onTabClose: (client: TermClient, id: unknown) => void;
  onTabRename: (client: TermClient, id: unknown, name: unknown) => void;
  onTabMove: (client: TermClient, id: unknown, index: unknown) => void;
}

/** 单个终端标签页：维护独立的 cwd / shell / 执行块 / 运行中进程 / 连接集合 */
export class TerminalSession {
  readonly createdAt = Date.now();
  name?: string;
  private cwd: string;
  private shell: TermShell;
  private blocks: TermBlock[] = [];
  private running = new Map<string, RunningCommand>();
  private clients = new Set<TermClient>();
  private closed = false;

  constructor(
    readonly id: string,
    readonly root: string,
    private readonly detected: DetectedShells,
    private readonly history: TerminalHistoryStore,
    private readonly callbacks: TerminalCallbacks,
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

  /** 关闭终端时调用：标记关闭并摘除所有连接，交由上层发 closed 并断开 */
  detachAllClients(): TermClient[] {
    this.closed = true;
    const list = [...this.clients];
    this.clients.clear();
    return list;
  }

  /** 计算标签状态：运行中 > 最近结束块出错/非零退出码 > 空闲（stopped 不算失败） */
  private computeStatus(): { status: TermTabStatus; runningCmd?: string } {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const b = this.blocks[i]!;
      if (b.state === 'running') {
        return { status: 'running', runningCmd: b.cmd };
      }
    }
    const last = this.blocks[this.blocks.length - 1];
    if (last && (last.state === 'error' || (last.state === 'done' && last.exitCode !== 0))) {
      return { status: 'failed' };
    }
    return { status: 'idle' };
  }

  tabInfo(): TermTabInfo {
    const { status, runningCmd } = this.computeStatus();
    return {
      id: this.id,
      ...(this.name ? { name: this.name } : {}),
      cwd: this.cwd,
      shell: this.shell,
      status,
      ...(runningCmd !== undefined ? { runningCmd } : {}),
      createdAt: this.createdAt,
    };
  }

  snapshot(): TermSnapshot {
    return {
      id: this.id,
      root: this.root,
      tabs: this.callbacks.getTabs(),
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
    if (this.closed) return;
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
        const prev = this.computeStatus();
        this.blocks = this.blocks.filter((b) => b.state === 'running');
        this.broadcast({ t: 'cleared', keep: this.blocks.map((b) => b.id) });
        const next = this.computeStatus();
        if (prev.status !== next.status || prev.runningCmd !== next.runningCmd) {
          this.callbacks.onMetaChange();
        }
        return;
      }
      case 'shell': {
        if (typeof msg.shell !== 'string' || !this.detected.bins[msg.shell]) {
          client.send({ t: 'error', message: `不可用的 shell: ${String(msg.shell)}` });
          return;
        }
        const changed = this.shell !== msg.shell;
        this.shell = msg.shell;
        // 同时更新工作空间默认 shell，后续新建终端沿用此选择
        this.history.setShell(this.root, msg.shell);
        this.broadcast({ t: 'shell', shell: msg.shell });
        if (changed) this.callbacks.onMetaChange();
        return;
      }
      case 'cwd.reset': {
        const changed = pathKey(this.cwd) !== pathKey(this.root);
        if (changed) {
          this.cwd = this.root;
        }
        this.broadcast({ t: 'cwd', cwd: this.cwd });
        if (changed) this.callbacks.onMetaChange();
        return;
      }
      case 'history.remove': {
        if (typeof msg.cmd !== 'string') return;
        const next = this.history.removeHistory(this.root, msg.cmd);
        this.callbacks.onHistoryChange(next);
        return;
      }
      case 'history.clear': {
        const next = this.history.clearHistory(this.root);
        this.callbacks.onHistoryChange(next);
        return;
      }
      case 'tab.close':
        this.callbacks.onTabClose(client, msg.id);
        return;
      case 'tab.rename':
        this.callbacks.onTabRename(client, msg.id, msg.name);
        return;
      case 'tab.move':
        this.callbacks.onTabMove(client, msg.id, msg.index);
        return;
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
    if (nextHist) this.callbacks.onHistoryChange(nextHist);

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
    this.callbacks.onMetaChange();

    const bin = this.detected.bins[this.shell] ?? this.shell;
    const task = startCommand({
      shell: this.shell,
      bin,
      cmd,
      cwd: this.cwd,
      onData: (chunk) => {
        if (this.closed) return;
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
        if (this.closed) return;
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
        this.callbacks.onMetaChange();
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

/** 单个工作空间的终端组：维护有序标签列表与工作空间级连接集合 */
export class WorkspaceTerminalGroup {
  private readonly tabs: TerminalSession[] = [];
  private readonly clients = new Set<TermClient>();
  private readonly closing = new Set<Promise<void>>();

  constructor(
    readonly root: string,
    private readonly detected: DetectedShells,
    private readonly history: TerminalHistoryStore,
  ) {}

  get tabCount(): number {
    return this.tabs.length;
  }

  findTab(id: string): TerminalSession | undefined {
    return this.tabs.find((t) => t.id === id);
  }

  tabInfos(): TermTabInfo[] {
    return this.tabs.map((t) => t.tabInfo());
  }

  createTab(id: string): TerminalSession {
    const tab = new TerminalSession(id, this.root, this.detected, this.history, {
      getTabs: () => this.tabInfos(),
      onHistoryChange: (history) => this.broadcastHistory(history),
      onMetaChange: () => this.broadcastTabs(),
      onTabClose: (client, targetId) => this.closeTab(client, targetId),
      onTabRename: (client, targetId, name) => this.renameTab(client, targetId, name),
      onTabMove: (client, targetId, index) => this.moveTab(client, targetId, index),
    });
    this.tabs.push(tab);
    return tab;
  }

  /** 确保工作空间至少有一个终端，返回第一个终端 */
  ensureDefaultTab(): TerminalSession {
    if (this.tabs.length === 0) {
      return this.createTab(crypto.randomUUID());
    }
    return this.tabs[0]!;
  }

  attachClient(tab: TerminalSession, client: TermClient, broadcastTabsAfter = false): void {
    this.clients.add(client);
    tab.addClient(client);
    if (broadcastTabsAfter) {
      this.broadcastTabs();
    }
  }

  detachClient(tab: TerminalSession, client: TermClient): void {
    tab.removeClient(client);
    this.clients.delete(client);
  }

  broadcastTabs(): void {
    const msg: TermServerMsg = { t: 'tabs', tabs: this.tabInfos() };
    for (const c of this.clients) c.send(msg);
  }

  broadcastHistory(history: string[]): void {
    const msg: TermServerMsg = { t: 'history', history };
    for (const c of this.clients) c.send(msg);
  }

  private closeTab(client: TermClient, rawId: unknown): void {
    if (typeof rawId !== 'string') {
      client.send({ t: 'error', message: '缺少终端 id' });
      return;
    }
    const idx = this.tabs.findIndex((t) => t.id === rawId);
    if (idx < 0) {
      client.send({ t: 'error', message: `终端不存在: ${rawId}` });
      return;
    }

    const [removed] = this.tabs.splice(idx, 1);
    // 计算建议切换的下一个终端：优先右邻，否则左邻；关掉的是最后一个则先新建空终端顶上
    let nextId: string;
    if (this.tabs.length === 0) {
      nextId = this.createTab(crypto.randomUUID()).id;
    } else {
      nextId = (this.tabs[idx] ?? this.tabs[idx - 1])!.id;
    }

    // 摘除并断开连在被关终端上的所有客户端
    const detached = removed!.detachAllClients();
    for (const c of detached) {
      this.clients.delete(c);
    }
    const closedMsg: TermServerMsg = { t: 'closed', id: removed!.id, next: nextId };
    for (const c of detached) {
      c.send(closedMsg);
      c.close?.(TERM_WS_CLOSED, 'terminal closed');
    }

    // 异步停止被关终端里的所有运行中进程，并在 dispose 时一并等待
    const stopping = removed!.stopAll().finally(() => {
      this.closing.delete(stopping);
    });
    this.closing.add(stopping);

    // 向剩余连接广播最新的终端列表
    this.broadcastTabs();
  }

  private renameTab(client: TermClient, rawId: unknown, rawName: unknown): void {
    if (typeof rawId !== 'string') {
      client.send({ t: 'error', message: '缺少终端 id' });
      return;
    }
    if (typeof rawName !== 'string') {
      client.send({ t: 'error', message: '无效终端名称' });
      return;
    }
    const tab = this.findTab(rawId);
    if (!tab) {
      client.send({ t: 'error', message: `终端不存在: ${rawId}` });
      return;
    }
    const trimmed = rawName.trim().slice(0, TERM_TAB_NAME_MAX);
    tab.name = trimmed || undefined;
    this.broadcastTabs();
  }

  private moveTab(client: TermClient, rawId: unknown, rawIndex: unknown): void {
    if (typeof rawId !== 'string') {
      client.send({ t: 'error', message: '缺少终端 id' });
      return;
    }
    if (typeof rawIndex !== 'number' || !Number.isFinite(rawIndex)) {
      client.send({ t: 'error', message: '无效目标位置' });
      return;
    }
    const from = this.tabs.findIndex((t) => t.id === rawId);
    if (from < 0) {
      client.send({ t: 'error', message: `终端不存在: ${rawId}` });
      return;
    }
    const [tab] = this.tabs.splice(from, 1);
    const target = Math.max(0, Math.min(Math.trunc(rawIndex), this.tabs.length));
    this.tabs.splice(target, 0, tab!);
    this.broadcastTabs();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.tabs.map((t) => t.stopAll()), ...this.closing]);
  }
}

export interface TerminalManagerDeps {
  workspaces: { find(p: string): { path: string } | null };
  dataDir: () => string;
}

export class TerminalManager {
  private readonly history: TerminalHistoryStore;
  private readonly groups = new Map<string, WorkspaceTerminalGroup>();

  constructor(private readonly deps: TerminalManagerDeps) {
    this.history = new TerminalHistoryStore(path.join(deps.dataDir(), 'terminal-history.json'));
  }

  async getOrCreateGroup(root: string): Promise<WorkspaceTerminalGroup> {
    const key = pathKey(root);
    let group = this.groups.get(key);
    if (!group) {
      const detected = await detectShells();
      group = this.groups.get(key);
      if (!group) {
        group = new WorkspaceTerminalGroup(root, detected, this.history);
        this.groups.set(key, group);
      }
    }
    return group;
  }

  async attach(ws: WebSocket, rawRoot: string | null, rawId: string | null = null, create = false): Promise<void> {
    const send = (msg: TermServerMsg) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };
    const close = (code?: number, reason?: string) => {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    };
    if (!rawRoot) {
      send({ t: 'error', message: '缺少工作空间路径 root' });
      close(1008, 'missing root');
      return;
    }
    const workspace = this.deps.workspaces.find(rawRoot);
    if (!workspace) {
      send({ t: 'error', message: '工作空间未登记' });
      close(1008, 'unknown workspace');
      return;
    }

    const client: TermClient = { send, close };
    // 探测 shell 是异步的：期间到达的消息先缓存，终端就绪后按顺序处理，避免丢消息
    let activeGroup: WorkspaceTerminalGroup | null = null;
    let term: TerminalSession | null = null;
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
      if (activeGroup && term) activeGroup.detachClient(term, client);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);

    const group = await this.getOrCreateGroup(workspace.path);
    if (closed || ws.readyState !== WebSocket.OPEN) return;

    let target: TerminalSession;
    let created = false;
    if (rawId === null) {
      // 无 id：连第一个终端，没有就新建
      const hadTabs = group.tabCount > 0;
      target = group.ensureDefaultTab();
      created = !hadTabs;
    } else {
      const existing = group.findTab(rawId);
      if (existing) {
        target = existing;
      } else if (create) {
        if (!VALID_TAB_ID.test(rawId)) {
          send({ t: 'error', message: '终端 id 不合法' });
          close(1008, 'invalid id');
          return;
        }
        if (group.tabCount >= TERM_TAB_LIMIT) {
          send({ t: 'error', message: `每个工作空间最多 ${TERM_TAB_LIMIT} 个终端` });
          close(TERM_WS_LIMIT, 'tab limit reached');
          return;
        }
        target = group.createTab(rawId);
        created = true;
      } else {
        const first = group.ensureDefaultTab();
        send({ t: 'closed', id: rawId, next: first.id });
        close(TERM_WS_CLOSED, 'terminal closed');
        return;
      }
    }

    activeGroup = group;
    term = target;
    group.attachClient(target, client, created);
    for (const msg of pending.splice(0)) {
      if (closed || ws.readyState !== WebSocket.OPEN) break;
      target.handle(client, msg);
    }
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.groups.values()].map((g) => g.stopAll()));
    await this.history.idle();
  }
}
