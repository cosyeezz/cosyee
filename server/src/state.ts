// 会话状态点：running（进程或后台任务在跑）→ 绿；unread（一轮结束时没人订阅且未查看）→ 蓝；其余不显示。
import type { SessionDot } from '@cosyee/shared';
import type { StateStore } from './workspaces.js';

/** 后台任务来源：claude=Claude 原生后台子代理/命令（随进程退出清零）；delegate=Antigravity 委派任务（独立于进程） */
export type BackgroundSource = 'claude' | 'delegate';

export class DotState {
  private running = new Set<string>();
  /** 按会话、按来源记录活跃后台任务数，不同来源互不覆盖 */
  private background = new Map<string, Partial<Record<BackgroundSource, number>>>();

  constructor(private readonly store: StateStore) {}

  /** manager 在会话状态变化时调用：running / starting 为 true。返回 dot 是否有变化。 */
  setRunning(id: string, running: boolean): boolean {
    const before = this.dot(id);
    if (running) this.running.add(id);
    else this.running.delete(id);
    return before !== this.dot(id);
  }

  /** 更新会话某来源的活跃后台任务数（<=0 视为无活跃任务）。返回 dot 是否有变化。 */
  setBackground(id: string, count: number, source: BackgroundSource = 'claude'): boolean {
    const before = this.dot(id);
    const n = count > 0 ? count : 0;
    let entry = this.background.get(id);
    if (n > 0) {
      if (!entry) this.background.set(id, (entry = {}));
      entry[source] = n;
    } else if (entry) {
      delete entry[source];
      if (!entry.claude && !entry.delegate) this.background.delete(id);
    }
    return before !== this.dot(id);
  }

  /** 一轮结束：没有任何订阅者时标记未读。返回 dot 是否有变化。 */
  turnFinished(id: string, hasSubscribers: boolean): boolean {
    const before = this.dot(id);
    if (!hasSubscribers) {
      this.store.state.unread[id] = true;
      this.store.save();
    }
    return before !== this.dot(id);
  }

  /** 查看（POST viewed / WS subscribe）：清除蓝点。返回是否真的清除了。 */
  viewed(id: string): boolean {
    if (!this.store.state.unread[id]) return false;
    delete this.store.state.unread[id];
    this.store.save();
    return true;
  }

  /** 标记会话为未读（蓝点）。 */
  markUnread(id: string): void {
    if (this.store.state.unread[id]) return;
    this.store.state.unread[id] = true;
    this.store.save();
  }

  /** 标记会话正在执行中（落盘，用于服务关闭/崩溃重启后补记中断）；已存在则不重复写盘。 */
  markInflight(id: string, cwd: string): void {
    if (this.store.state.inflight[id]) return;
    this.store.state.inflight[id] = { cwd, at: Date.now() };
    this.store.save();
  }

  /** 清除执行中标记；不存在则不写盘。 */
  clearInflight(id: string): void {
    if (!this.store.state.inflight[id]) return;
    delete this.store.state.inflight[id];
    this.store.save();
  }

  /** 取出全部残留的执行中记录并清空（只写一次盘）。 */
  takeInflight(): { id: string; cwd: string }[] {
    const entries = Object.entries(this.store.state.inflight);
    if (!entries.length) return [];
    const list = entries.map(([id, e]) => ({ id, cwd: e.cwd }));
    this.store.state.inflight = {};
    this.store.save();
    return list;
  }

  hasBackground(id: string): boolean {
    const entry = this.background.get(id);
    return !!entry && ((entry.claude ?? 0) > 0 || (entry.delegate ?? 0) > 0);
  }

  isRunning(id: string): boolean {
    return this.running.has(id) || this.hasBackground(id);
  }

  dot(id: string): SessionDot {
    if (this.isRunning(id)) return 'running';
    if (this.store.state.unread[id]) return 'unread';
    return null;
  }
}
