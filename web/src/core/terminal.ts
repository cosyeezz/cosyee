// 内置终端的 WebSocket 连接与多标签状态管理：
// - 每个工作空间维护一个 workspace 级 store（tabs 列表、activeId、提示信息）；
// - 每个终端标签维护独立的 TerminalSession（key 为 rootKey(root) + '::' + (id ?? '')），
//   仅当前激活的标签保持活跃连接，非当前标签或面板关闭后走 IDLE_DISCONNECT_MS 空闲回收。
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  TERM_BLOCK_LIMIT,
  TERM_HISTORY_LIMIT,
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
} from '@cosyee/shared';
import { uuid } from './browser';
import { readTerminalActiveTab, saveTerminalActiveTab } from './terminalPrefs';

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

export interface TerminalTabsController {
  tabs: readonly TermTabInfo[];
  activeId: string | null;
  notice: string | null;
  clearNotice: () => void;
  current: TerminalController;
  selectTab: (id: string) => void;
  newTab: () => string | null;
  closeTab: (id: string) => { closedLast: boolean };
  renameTab: (id: string, name: string) => void;
  moveTab: (id: string, toIndex: number) => void;
}

const IDLE_DISCONNECT_MS = 30_000;
const RETRY_BASE_MS = 300;
const RETRY_MAX_MS = 5_000;
export const TERM_LIMIT_NOTICE = `每个工作空间最多 ${TERM_TAB_LIMIT} 个终端`;

function rootKey(root: string): string {
  return root.replace(/[\\/]+$/, '').toLowerCase();
}

function sessionKey(root: string, id?: string | null): string {
  return `${rootKey(root)}::${id ?? ''}`;
}

export function terminalWsUrl(root: string, id?: string | null, create?: boolean): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let url = `${proto}://${location.host}/api/terminal/ws?root=${encodeURIComponent(root)}`;
  if (id) {
    url += `&id=${encodeURIComponent(id)}`;
    if (create) url += '&create=1';
  }
  return url;
}

/** 按协议语义移动标签：先移除 id，再按目标下标（夹到两端）插入 */
export function reorderTabs(tabs: readonly TermTabInfo[], id: string, toIndex: number): TermTabInfo[] {
  const from = tabs.findIndex((t) => t.id === id);
  if (from < 0) return tabs.slice();
  const item = tabs[from]!;
  const rest = tabs.filter((t) => t.id !== id);
  const clamped = Math.max(0, Math.min(rest.length, Math.round(toIndex)));
  rest.splice(clamped, 0, item);
  return rest;
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
    case 'tabs':
      return { ...snap, tabs: msg.tabs };
    case 'closed':
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

interface WorkspaceState {
  tabs: TermTabInfo[];
  activeId: string | null;
  notice: string | null;
}

class TerminalWorkspaceStore {
  private listeners = new Set<() => void>();
  private state: WorkspaceState;
  /** 正在乐观创建中的标签 id → 创建前的 activeId（4429 时回退） */
  private pendingCreates = new Map<string, string | null>();
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly root: string) {
    this.state = {
      tabs: [],
      activeId: readTerminalActiveTab(root),
      notice: null,
    };
  }

  getState = (): WorkspaceState => this.state;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  private emit(patch: Partial<WorkspaceState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  setNotice(msg: string | null) {
    if (this.noticeTimer !== null) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = null;
    }
    this.emit({ notice: msg });
    if (msg) {
      this.noticeTimer = setTimeout(() => {
        this.noticeTimer = null;
        if (this.state.notice === msg) {
          this.emit({ notice: null });
        }
      }, 4000);
    }
  }

  private mergeServerTabs(serverTabs: TermTabInfo[]): TermTabInfo[] {
    const serverIds = new Set(serverTabs.map((t) => t.id));
    for (const pid of [...this.pendingCreates.keys()]) {
      if (serverIds.has(pid)) this.pendingCreates.delete(pid);
    }
    if (this.pendingCreates.size === 0) return serverTabs;
    const extra = this.state.tabs.filter((t) => this.pendingCreates.has(t.id) && !serverIds.has(t.id));
    return extra.length > 0 ? [...serverTabs, ...extra] : serverTabs;
  }

  handleSnapshot(snap: TermSnapshot) {
    this.pendingCreates.delete(snap.id);
    const tabs = this.mergeServerTabs(snap.tabs);
    const activeMissing =
      !this.state.activeId ||
      (!this.pendingCreates.has(this.state.activeId) && !tabs.some((t) => t.id === this.state.activeId));
    const nextActive = activeMissing ? snap.id : this.state.activeId;
    if (nextActive !== this.state.activeId) {
      saveTerminalActiveTab(this.root, nextActive);
    }
    this.emit({ tabs, activeId: nextActive });
  }

  handleTabsBroadcast(serverTabs: TermTabInfo[]) {
    const tabs = this.mergeServerTabs(serverTabs);
    let nextActive = this.state.activeId;
    if (nextActive && !this.pendingCreates.has(nextActive) && tabs.length > 0 && !tabs.some((t) => t.id === nextActive)) {
      nextActive = tabs[0]!.id;
      saveTerminalActiveTab(this.root, nextActive);
    }
    this.emit({ tabs, activeId: nextActive });
  }

  handleTabClosed(closedId: string, nextId?: string) {
    this.pendingCreates.delete(closedId);
    const tabs = this.state.tabs.filter((t) => t.id !== closedId);
    let nextActive = this.state.activeId;
    if (nextActive === closedId) {
      nextActive = (nextId && nextId !== closedId ? nextId : null) ?? tabs[0]?.id ?? null;
      saveTerminalActiveTab(this.root, nextActive);
    }
    this.emit({ tabs, activeId: nextActive });
  }

  handleCreateLimit(failedId: string, message?: string) {
    const fallback = this.pendingCreates.get(failedId) ?? null;
    this.pendingCreates.delete(failedId);
    const tabs = this.state.tabs.filter((t) => t.id !== failedId);
    let nextActive = this.state.activeId;
    if (nextActive === failedId) {
      nextActive =
        (fallback && tabs.some((t) => t.id === fallback) ? fallback : null) ??
        tabs[tabs.length - 1]?.id ??
        null;
      saveTerminalActiveTab(this.root, nextActive);
    }
    this.emit({ tabs, activeId: nextActive });
    this.setNotice(message || TERM_LIMIT_NOTICE);
  }

  isPendingCreate(id: string): boolean {
    return this.pendingCreates.has(id);
  }

  selectTab(id: string) {
    if (!id || this.state.activeId === id) return;
    saveTerminalActiveTab(this.root, id);
    this.emit({ activeId: id });
  }

  newTab(fallbackShell: TermShell = 'pwsh'): string | null {
    if (this.state.tabs.length >= TERM_TAB_LIMIT) {
      this.setNotice(TERM_LIMIT_NOTICE);
      return null;
    }
    const id = uuid();
    const prevActive = this.state.activeId;
    this.pendingCreates.set(id, prevActive);
    const optimisticTab: TermTabInfo = {
      id,
      cwd: this.root,
      shell: fallbackShell,
      status: 'idle',
      createdAt: Date.now(),
    };
    const tabs = [...this.state.tabs, optimisticTab];
    // 预先注册带 createOnFirstConnect 标记的 session
    getOrCreateSession(this.root, id, true);
    saveTerminalActiveTab(this.root, id);
    this.emit({ tabs, activeId: id, notice: null });
    return id;
  }

  closeTab(id: string, sendViaWorkspace: (msg: TermClientMsg) => boolean): { closedLast: boolean } {
    const curTabs = this.state.tabs;
    const closedLast = curTabs.length <= 1;
    sendViaWorkspace({ t: 'tab.close', id });
    this.pendingCreates.delete(id);

    // 断开并移除被关标签的 session
    destroySession(this.root, id);

    if (closedLast) {
      // 关掉最后一个时服务端会补新终端，清空记住的 id 以便下次打开自动连上新终端
      saveTerminalActiveTab(this.root, null);
      this.emit({ tabs: [], activeId: null });
      return { closedLast: true };
    }

    const idx = curTabs.findIndex((t) => t.id === id);
    const tabs = curTabs.filter((t) => t.id !== id);
    let nextActive = this.state.activeId;
    if (nextActive === id) {
      const pick = tabs[Math.min(Math.max(0, idx), tabs.length - 1)] ?? tabs[0] ?? null;
      nextActive = pick?.id ?? null;
      saveTerminalActiveTab(this.root, nextActive);
    }
    this.emit({ tabs, activeId: nextActive });
    return { closedLast: false };
  }

  renameTab(id: string, rawName: string, sendViaWorkspace: (msg: TermClientMsg) => boolean) {
    const trimmed = rawName.trim().slice(0, TERM_TAB_NAME_MAX);
    const tabs = this.state.tabs.map((t) =>
      t.id === id ? { ...t, name: trimmed || undefined } : t,
    );
    this.emit({ tabs });
    sendViaWorkspace({ t: 'tab.rename', id, name: trimmed });
  }

  moveTab(id: string, toIndex: number, sendViaWorkspace: (msg: TermClientMsg) => boolean) {
    const restLen = Math.max(0, this.state.tabs.length - 1);
    const clamped = Math.max(0, Math.min(restLen, Math.round(toIndex)));
    const tabs = reorderTabs(this.state.tabs, id, clamped);
    this.emit({ tabs });
    sendViaWorkspace({ t: 'tab.move', id, index: clamped });
  }
}

class TerminalSession {
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private activeCount = 0;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private manualClose = false;
  private terminalClosed = false;
  private createOnFirstConnect: boolean;
  private state: TerminalState;
  readonly actions: TerminalActions;
  tabId: string | null;

  constructor(
    readonly root: string,
    tabId: string | null,
    createOnFirstConnect = false,
  ) {
    this.tabId = tabId;
    this.createOnFirstConnect = createOnFirstConnect;
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

  isOpen = (): boolean => !!this.ws && this.ws.readyState === WebSocket.OPEN;

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
    if (this.terminalClosed) return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connect(false);
  }

  private forceReconnect() {
    this.terminalClosed = false;
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
    // 重连时绝不带 create=1，只在新建标签的首次建连带一次
    const useCreate = !isRetry && this.createOnFirstConnect && !!this.tabId;
    this.createOnFirstConnect = false;
    this.emit({ connState: isRetry ? 'reconnecting' : 'connecting', error: isRetry ? this.state.error : null });

    let ws: WebSocket;
    try {
      ws = new WebSocket(terminalWsUrl(this.root, this.tabId, useCreate));
    } catch (e) {
      this.emit({ connState: 'error', error: e instanceof Error ? e.message : String(e) });
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    const wsStore = getWorkspaceStore(this.root);
    let lastErrorMsg: string | null = null;
    let receivedClosedNext: string | undefined;

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
        lastErrorMsg = msg.message;
        if (this.tabId && wsStore.isPendingCreate(this.tabId)) {
          wsStore.setNotice(msg.message || TERM_LIMIT_NOTICE);
        }
        this.emit({ error: msg.message });
        return;
      }
      if (msg.t === 'closed') {
        receivedClosedNext = msg.next;
        this.terminalClosed = true;
        const closedId = msg.id || this.tabId || '';
        if (closedId) {
          removeSessionRef(this.root, closedId, this);
          wsStore.handleTabClosed(closedId, msg.next);
        }
        return;
      }
      if (msg.t === 'snapshot') {
        // 不带 id 连接时服务端返回了真实 id，把 session 迁移到对应 key 避免重复建连
        if (!this.tabId && msg.snap.id) {
          migrateSessionKey(this.root, this, msg.snap.id);
        }
        wsStore.handleSnapshot(msg.snap);
      } else if (msg.t === 'tabs') {
        wsStore.handleTabsBroadcast(msg.tabs);
      }
      const nextSnap = applyTerminalServerMsg(this.state.snapshot, msg);
      if (nextSnap !== this.state.snapshot || this.state.error !== null) {
        this.emit({ snapshot: nextSnap, error: null });
      }
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.manualClose) {
        this.emit({ connState: 'idle' });
        return;
      }
      // 4404：终端不存在 / 已被别处关闭——不重连，切到 next
      if (ev.code === TERM_WS_CLOSED) {
        this.terminalClosed = true;
        if (this.tabId) {
          removeSessionRef(this.root, this.tabId, this);
          wsStore.handleTabClosed(this.tabId, receivedClosedNext);
        }
        this.emit({ connState: 'idle' });
        return;
      }
      // 4429：超过终端数量上限——不重连，回退乐观标签并提示
      if (ev.code === TERM_WS_LIMIT) {
        this.terminalClosed = true;
        if (this.tabId) {
          removeSessionRef(this.root, this.tabId, this);
          wsStore.handleCreateLimit(this.tabId, lastErrorMsg || TERM_LIMIT_NOTICE);
        }
        this.emit({ connState: 'idle' });
        return;
      }
      if (this.terminalClosed) {
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
    if (this.activeCount <= 0 || this.terminalClosed) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.retry++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.activeCount > 0 && !this.terminalClosed) this.connect(true);
    }, delay);
  }

  disconnect() {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
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

  sendRaw(msg: TermClientMsg): boolean {
    return this.send(msg);
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
const workspaces = new Map<string, TerminalWorkspaceStore>();

function getWorkspaceStore(root: string): TerminalWorkspaceStore {
  const key = rootKey(root);
  let ws = workspaces.get(key);
  if (!ws) {
    ws = new TerminalWorkspaceStore(root);
    workspaces.set(key, ws);
  }
  return ws;
}

function getOrCreateSession(root: string, id: string | null, createOnFirstConnect = false): TerminalSession {
  const key = sessionKey(root, id);
  let s = sessions.get(key);
  if (!s) {
    s = new TerminalSession(root, id, createOnFirstConnect);
    sessions.set(key, s);
  }
  return s;
}

function migrateSessionKey(root: string, session: TerminalSession, realId: string) {
  const oldKey = sessionKey(root, session.tabId);
  const newKey = sessionKey(root, realId);
  if (sessions.get(oldKey) === session) {
    sessions.delete(oldKey);
  }
  session.tabId = realId;
  if (!sessions.has(newKey)) {
    sessions.set(newKey, session);
  }
}

function removeSessionRef(root: string, id: string, session: TerminalSession) {
  const key = sessionKey(root, id);
  if (sessions.get(key) === session) {
    sessions.delete(key);
  }
}

function destroySession(root: string, id: string) {
  const key = sessionKey(root, id);
  const s = sessions.get(key);
  if (s) {
    sessions.delete(key);
    s.disconnect();
  }
}

/** 挑一条该工作空间下已打开的 WS 发送工作空间级控制消息（tab.close / tab.rename / tab.move） */
function sendWorkspaceMsg(root: string, preferredId: string | null, msg: TermClientMsg): boolean {
  if (preferredId) {
    const pref = sessions.get(sessionKey(root, preferredId));
    if (pref?.isOpen()) return pref.sendRaw(msg);
  }
  const prefix = `${rootKey(root)}::`;
  for (const [k, s] of sessions) {
    if (k.startsWith(prefix) && s.isOpen()) {
      return s.sendRaw(msg);
    }
  }
  return false;
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

const EMPTY_WORKSPACE_STATE: WorkspaceState = {
  tabs: [],
  activeId: null,
  notice: null,
};

/** 订阅指定工作空间的默认（或指定 id）终端连接与状态。 */
export function useTerminal(root: string | null, active: boolean, tabId: string | null = null): TerminalController {
  const session = useMemo(() => (root ? getOrCreateSession(root, tabId) : null), [root, tabId]);

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

/** 订阅指定工作空间的多终端标签列表与当前激活标签的控制器。只有当前激活标签保持活跃连接。 */
export function useTerminalTabs(root: string | null, active: boolean): TerminalTabsController {
  const wsStore = useMemo(() => (root ? getWorkspaceStore(root) : null), [root]);

  const wsState = useSyncExternalStore(
    (cb) => (wsStore ? wsStore.subscribe(cb) : () => {}),
    () => (wsStore ? wsStore.getState() : EMPTY_WORKSPACE_STATE),
    () => EMPTY_WORKSPACE_STATE,
  );

  const current = useTerminal(root, active, wsState.activeId);

  const selectTab = useCallback(
    (id: string) => {
      wsStore?.selectTab(id);
    },
    [wsStore],
  );

  const newTab = useCallback(() => {
    if (!wsStore) return null;
    const shell = current.state.snapshot?.shell ?? 'pwsh';
    return wsStore.newTab(shell);
  }, [wsStore, current.state.snapshot?.shell]);

  const closeTab = useCallback(
    (id: string) => {
      if (!wsStore || !root) return { closedLast: false };
      return wsStore.closeTab(id, (msg) => sendWorkspaceMsg(root, wsStore.getState().activeId, msg));
    },
    [wsStore, root],
  );

  const renameTab = useCallback(
    (id: string, name: string) => {
      if (!wsStore || !root) return;
      wsStore.renameTab(id, name, (msg) => sendWorkspaceMsg(root, wsStore.getState().activeId, msg));
    },
    [wsStore, root],
  );

  const moveTab = useCallback(
    (id: string, toIndex: number) => {
      if (!wsStore || !root) return;
      wsStore.moveTab(id, toIndex, (msg) => sendWorkspaceMsg(root, wsStore.getState().activeId, msg));
    },
    [wsStore, root],
  );

  const clearNotice = useCallback(() => {
    wsStore?.setNotice(null);
  }, [wsStore]);

  return {
    tabs: wsState.tabs,
    activeId: wsState.activeId,
    notice: wsState.notice,
    clearNotice,
    current,
    selectTab,
    newTab,
    closeTab,
    renameTab,
    moveTab,
  };
}
