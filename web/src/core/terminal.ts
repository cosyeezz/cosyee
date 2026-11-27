// 内置终端的 WebSocket 连接与状态管理：按工作空间 root 管理连接、快照、增量合并、乐观更新与断线重连。
// 面板关闭后连接保留一小段时间（IDLE_DISCONNECT_MS）再断开，期间重新打开可秒恢复且不丢失输出。
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  TERM_BLOCK_LIMIT,
  TERM_HISTORY_LIMIT,
  TERM_OUTPUT_LIMIT,
  type TermBlock,
  type TermClientMsg,
  type TermServerMsg,
  type TermShell,
  type TermSnapshot,
} from '@cosyee/shared';
import { uuid } from './browser';

export type TerminalConnState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'error';

export interface TerminalState {
  root: string;
  connState: TerminalConnState;
  error: string | null;
  snapshot: TermSnapshot | null;
}

export interface TerminalActions {
  run: (cmd: string) => string | null;
  sendStdin: (id: string, data: string) => void;
  stop: (id: string) => void;
  clear: () => void;
  setShell: (shell: TermShell) => void;
  resetCwd: () => void;
  removeHistory: (cmd: string) => void;
  clearHistory: () => void;
  reconnect: () => void;
}

export interface TerminalController {
  state: TerminalState;
  actions: TerminalActions;
}

const IDLE_DISCONNECT_MS = 30_000;
const RETRY_BASE_MS = 300;
const RETRY_MAX_MS = 5_000;

function rootKey(root: string): string {
  return root.replace(/[\\/]+$/, '').toLowerCase();
}

export function terminalWsUrl(root: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/api/terminal/ws?root=${encodeURIComponent(root)}`;
}

/** 将一条服务端消息合入当前快照（纯函数，便于测试） */
export function applyTerminalServerMsg(snap: TermSnapshot | null, msg: TermServerMsg): TermSnapshot | null {
  if (msg.t === 'snapshot') {
    return msg.snap;
  }
  if (!snap) return null;

  switch (msg.t) {
    case 'block': {
      const idx = snap.blocks.findIndex((b) => b.id === msg.block.id);
      let blocks: TermBlock[];
      if (idx >= 0) {
        const prev = snap.blocks[idx]!;
        // 服务端确认块：合并，保留已收到的输出（防乱序）
        blocks = snap.blocks.slice();
        blocks[idx] = {
          ...msg.block,
          output: msg.block.output || prev.output,
          truncated: msg.block.truncated || prev.truncated,
        };
      } else {
        blocks = [...snap.blocks, msg.block];
        if (blocks.length > TERM_BLOCK_LIMIT) {
          blocks = blocks.slice(blocks.length - TERM_BLOCK_LIMIT);
        }
      }
      return { ...snap, blocks };
    }
    case 'out': {
      const idx = snap.blocks.findIndex((b) => b.id === msg.id);
      if (idx < 0) return snap;
      const cur = snap.blocks[idx]!;
      let output = cur.output + msg.data;
      let truncated = cur.truncated;
      if (output.length > TERM_OUTPUT_LIMIT) {
        output = output.slice(output.length - TERM_OUTPUT_LIMIT);
        truncated = true;
      }
      const blocks = snap.blocks.slice();
      blocks[idx] = { ...cur, output, ...(truncated ? { truncated: true } : {}) };
      return { ...snap, blocks };
    }
    case 'end': {
      const idx = snap.blocks.findIndex((b) => b.id === msg.id);
      if (idx < 0) return snap;
      const cur = snap.blocks[idx]!;
      const blocks = snap.blocks.slice();
      blocks[idx] = {
        ...cur,
        state: msg.state,
        exitCode: msg.exitCode,
        endedAt: msg.endedAt,
        ...(msg.truncated !== undefined ? { truncated: msg.truncated } : {}),
      };
      return { ...snap, blocks };
    }
    case 'cwd':
      return snap.cwd === msg.cwd ? snap : { ...snap, cwd: msg.cwd };
    case 'shell':
      return snap.shell === msg.shell ? snap : { ...snap, shell: msg.shell };
    case 'history':
      return { ...snap, history: msg.history };
    case 'cleared': {
      const keep = new Set(msg.keep);
      return { ...snap, blocks: snap.blocks.filter((b) => keep.has(b.id)) };
    }
    case 'error':
      return snap;
    default:
      return snap;
  }
}

/** 乐观插入命令历史（去重并移到末尾） */
export function pushHistoryOptimistic(history: string[], cmd: string): string[] {
  const trimmed = cmd.trim();
  if (!trimmed) return history;
  const filtered = history.filter((h) => h !== trimmed);
  filtered.push(trimmed);
  if (filtered.length > TERM_HISTORY_LIMIT) {
    return filtered.slice(filtered.length - TERM_HISTORY_LIMIT);
  }
  return filtered;
}

class TerminalSession {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private activeCount = 0;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private state: TerminalState;
  readonly actions: TerminalActions;

  constructor(readonly root: string) {
    this.state = {
      root,
      connState: 'idle',
      error: null,
      snapshot: null,
    };
    this.actions = {
      run: (cmd) => this.run(cmd),
      sendStdin: (id, data) => this.send({ t: 'stdin', id, data }),
      stop: (id) => this.send({ t: 'stop', id }),
      clear: () => this.clear(),
      setShell: (shell) => this.setShell(shell),
      resetCwd: () => this.send({ t: 'cwd.reset' }),
      removeHistory: (cmd) => this.removeHistory(cmd),
      clearHistory: () => this.clearHistory(),
      reconnect: () => this.forceReconnect(),
    };
  }

  getState = (): TerminalState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private emit(patch: Partial<TerminalState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  retain(): () => void {
    this.activeCount++;
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.ensureConnected();
    return () => {
      this.activeCount = Math.max(0, this.activeCount - 1);
      if (this.activeCount === 0) {
        this.scheduleIdleDisconnect();
      }
    };
  }

  private scheduleIdleDisconnect() {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.activeCount === 0) {
        this.disconnect();
      }
    }, IDLE_DISCONNECT_MS);
  }

  private ensureConnected() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connect(false);
  }

  private forceReconnect() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.retry = 0;
    if (this.ws) {
      this.manualClose = true;
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connect(false);
  }

  private connect(isRetry: boolean) {
    if (typeof WebSocket === 'undefined') return;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.manualClose = false;
    this.emit({ connState: isRetry ? 'reconnecting' : 'connecting', error: isRetry ? this.state.error : null });

    let ws: WebSocket;
    try {
      ws = new WebSocket(terminalWsUrl(this.root));
    } catch (e) {
      this.emit({ connState: 'error', error: e instanceof Error ? e.message : String(e) });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.emit({ connState: 'open', error: null });
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws || typeof ev.data !== 'string') return;
      let msg: TermServerMsg;
      try {
        msg = JSON.parse(ev.data) as TermServerMsg;
      } catch {
        return;
      }
      if (msg.t === 'error') {
        this.emit({ error: msg.message });
        return;
      }
      const nextSnap = applyTerminalServerMsg(this.state.snapshot, msg);
      if (nextSnap !== this.state.snapshot || this.state.error !== null) {
        this.emit({ snapshot: nextSnap, error: null });
      }
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.manualClose) {
        this.emit({ connState: 'idle' });
        return;
      }
      if (this.activeCount > 0) {
        this.emit({ connState: 'reconnecting' });
        this.scheduleRetry();
      } else {
        this.emit({ connState: 'idle' });
      }
    };
  }

  private scheduleRetry() {
    if (this.activeCount <= 0) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.activeCount > 0) this.connect(true);
    }, delay);
  }

  disconnect() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.manualClose = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    this.emit({ connState: 'idle' });
  }

  private send(msg: TermClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private run(cmd: string): string | null {
    const trimmed = cmd.trim();
    if (!trimmed) return null;
    const id = uuid();
    const snap = this.state.snapshot;
    if (snap) {
      const optimistic: TermBlock = {
        id,
        cmd,
        cwd: snap.cwd,
        shell: snap.shell,
        startedAt: Date.now(),
        state: 'running',
        output: '',
      };
      let blocks = [...snap.blocks, optimistic];
      if (blocks.length > TERM_BLOCK_LIMIT) {
        blocks = blocks.slice(blocks.length - TERM_BLOCK_LIMIT);
      }
      const history = pushHistoryOptimistic(snap.history, cmd);
      this.emit({ snapshot: { ...snap, blocks, history }, error: null });
    }
    this.send({ t: 'run', id, cmd });
    return id;
  }

  private clear() {
    const snap = this.state.snapshot;
    if (snap) {
      this.emit({
        snapshot: {
          ...snap,
          blocks: snap.blocks.filter((b) => b.state === 'running'),
        },
      });
    }
    this.send({ t: 'clear' });
  }

  private setShell(shell: TermShell) {
    const snap = this.state.snapshot;
    if (snap && snap.shell !== shell) {
      this.emit({ snapshot: { ...snap, shell } });
    }
    this.send({ t: 'shell', shell });
  }

  private removeHistory(cmd: string) {
    const snap = this.state.snapshot;
    if (snap) {
      this.emit({ snapshot: { ...snap, history: snap.history.filter((h) => h !== cmd) } });
    }
    this.send({ t: 'history.remove', cmd });
  }

  private clearHistory() {
    const snap = this.state.snapshot;
    if (snap) {
      this.emit({ snapshot: { ...snap, history: [] } });
    }
    this.send({ t: 'history.clear' });
  }
}

const sessions = new Map<string, TerminalSession>();

function getSession(root: string): TerminalSession {
  const key = rootKey(root);
  let s = sessions.get(key);
  if (!s) {
    s = new TerminalSession(root);
    sessions.set(key, s);
  }
  return s;
}

const EMPTY_ACTIONS: TerminalActions = {
  run: () => null,
  sendStdin: () => {},
  stop: () => {},
  clear: () => {},
  setShell: () => {},
  resetCwd: () => {},
  removeHistory: () => {},
  clearHistory: () => {},
  reconnect: () => {},
};

const EMPTY_STATE: TerminalState = {
  root: '',
  connState: 'idle',
  error: null,
  snapshot: null,
};

/** 订阅指定工作空间的终端连接与状态。active=false 时不主动建连（已建连的会在空闲超时后自动断开）。 */
export function useTerminal(root: string | null, active: boolean): TerminalController {
  const session = useMemo(() => (root ? getSession(root) : null), [root]);

  useEffect(() => {
    if (!session || !active) return;
    return session.retain();
  }, [session, active]);

  const state = useSyncExternalStore(
    (cb) => (session ? session.subscribe(cb) : () => {}),
    () => (session ? session.getState() : EMPTY_STATE),
    () => EMPTY_STATE,
  );

  return {
    state,
    actions: session ? session.actions : EMPTY_ACTIONS,
  };
}
