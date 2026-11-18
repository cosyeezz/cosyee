// 置顶：手动置顶（一直保留到取消）+ 自动置顶（会话执行中自动置顶，停止后空闲满 30 分钟自动失效）。
// 数据在 state.json 的 pinned / autoPinned 里；到期靠内部定时器 + onExpire 回调推送给前端，不需要刷新页面。
import type { PinKind } from '@cosyee/shared';
import { HttpError, type StateStore } from './workspaces.js';

/** 自动置顶在会话停止后保留的时间 */
export const AUTO_PIN_IDLE_MS = 30 * 60 * 1000;
/** setTimeout 的最大延迟（超过会立即触发） */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface PinsOptions {
  now?: () => number;
  idleMs?: number;
  /** 有自动置顶到期被清掉时调用（server.ts 里接到 manager.notifySidebar） */
  onExpire?: () => void;
}

export interface PinEntry {
  id: string;
  cwd: string;
  kind: PinKind;
}

export class Pins {
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly onExpire: () => void;
  /** 当前执行中的会话（执行中的自动置顶永不过期） */
  private readonly active = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: StateStore, opts: PinsOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleMs = opts.idleMs ?? AUTO_PIN_IDLE_MS;
    this.onExpire = opts.onExpire ?? (() => {});
    this.sweep(false);
  }

  /** 会话「是否执行中」变化时调用（manager 的 onStatus）。返回置顶集合是否变化。 */
  onRunning(id: string, cwd: string, running: boolean): boolean {
    const st = this.store.state;
    if (running) {
      const was = this.active.has(id);
      this.active.add(id);
      if (was) return false;
      if (st.deleted[id]) return false;
      // 手动置顶的不需要再加自动置顶；否则（含用户之前手动取消过的）开始执行就重新自动置顶
      if (st.pinned[id]) return false;
      st.autoPinned[id] = { cwd, at: this.now() };
      this.store.save();
      this.schedule();
      return true;
    }
    if (!this.active.delete(id)) return false;
    const a = st.autoPinned[id];
    if (a) {
      a.at = this.now(); // 从停止的时刻开始计 30 分钟
      this.store.save();
    }
    this.schedule();
    return false; // 停止瞬间置顶集合没有变（仍在置顶区）
  }

  /** 会话有新活动（比如一轮结束）时顺延自动置顶的到期时间 */
  touch(id: string): void {
    const a = this.store.state.autoPinned[id];
    if (!a) return;
    a.at = this.now();
    this.store.save();
    this.schedule();
  }

  /** 会话当前是否在执行（自动置顶期间） */
  isRunning(id: string): boolean {
    return this.active.has(id);
  }

  kind(id: string): PinKind | null {
    const st = this.store.state;
    if (st.pinned[id]) return 'manual';
    const a = st.autoPinned[id];
    if (a && (this.active.has(id) || this.now() - a.at < this.idleMs)) return 'auto';
    return null;
  }

  pin(id: string, cwd: string): void {
    const st = this.store.state;
    if (st.deleted[id]) throw new HttpError(409, '该会话已删除，请先恢复');
    st.pinned[id] = { cwd, pinnedAt: this.now() };
    delete st.autoPinned[id];
    this.store.save();
    this.schedule();
  }

  /** 取消置顶：手动与自动都清掉。执行中的会话取消后保持隐藏，直到它下一次开始执行。 */
  unpin(id: string): void {
    this.clear(id);
  }

  /** 清掉某个会话的所有置顶（取消置顶 / 删除 / 永久删除共用） */
  clear(id: string): void {
    const st = this.store.state;
    if (!st.pinned[id] && !st.autoPinned[id]) return;
    delete st.pinned[id];
    delete st.autoPinned[id];
    this.store.save();
    this.schedule();
  }

  /** 当前有效的置顶：手动在前（置顶时间倒序），其后自动（最近活动倒序） */
  list(): PinEntry[] {
    const st = this.store.state;
    const manual = Object.entries(st.pinned)
      .sort((a, b) => b[1].pinnedAt - a[1].pinnedAt)
      .map(([id, e]): PinEntry => ({ id, cwd: e.cwd, kind: 'manual' }));
    const auto = Object.entries(st.autoPinned)
      .filter(([id]) => this.kind(id) === 'auto')
      .sort((a, b) => b[1].at - a[1].at)
      .map(([id, e]): PinEntry => ({ id, cwd: e.cwd, kind: 'auto' }));
    return [...manual, ...auto];
  }

  /** 清掉已过期的自动置顶。返回是否清掉了东西。notify 为 true 时调用 onExpire。 */
  sweep(notify = true): boolean {
    const st = this.store.state;
    let changed = false;
    for (const [id, a] of Object.entries(st.autoPinned)) {
      if (this.active.has(id)) continue;
      if (this.now() - a.at >= this.idleMs) {
        delete st.autoPinned[id];
        changed = true;
      }
    }
    if (changed) {
      this.store.save();
      if (notify) this.onExpire();
    }
    this.schedule();
    return changed;
  }

  /** 按最早的到期时间安排下一次 sweep */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    let earliest = Infinity;
    for (const [id, a] of Object.entries(this.store.state.autoPinned)) {
      if (this.active.has(id)) continue;
      earliest = Math.min(earliest, a.at + this.idleMs);
    }
    if (earliest === Infinity) return;
    const delay = Math.min(Math.max(earliest - this.now(), 0) + 50, MAX_TIMER_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.sweep();
    }, delay);
    this.timer.unref();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
