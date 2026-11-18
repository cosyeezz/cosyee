// 会话状态点：running（进程在跑）→ 绿；unread（一轮结束时没人订阅且未查看）→ 蓝；其余不显示。
import type { SessionDot } from '@cosyee/shared';
import type { StateStore } from './workspaces.js';

export class DotState {
  private running = new Set<string>();

  constructor(private readonly store: StateStore) {}

  /** manager 在会话状态变化时调用：running / starting 为 true。返回 dot 是否有变化。 */
  setRunning(id: string, running: boolean): boolean {
    const before = this.dot(id);
    if (running) this.running.add(id);
    else this.running.delete(id);
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

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  dot(id: string): SessionDot {
    if (this.running.has(id)) return 'running';
    if (this.store.state.unread[id]) return 'unread';
    return null;
  }
}
