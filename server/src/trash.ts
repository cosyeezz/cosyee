// 已删除：软删除（只是从列表隐藏，会话记录文件原样保留）、恢复、永久删除（真正删除记录文件）。
import fs from 'node:fs';
import path from 'node:path';
import type { DeletedSession } from '@cosyee/shared';
import { isSessionUuid, projectsDir } from './paths.js';
import type { Pins } from './pins.js';
import type { LocatedSession } from './sessions.js';
import type { DotState } from './state.js';
import { HttpError, type StateStore } from './workspaces.js';

export class Trash {
  constructor(
    private readonly store: StateStore,
    private readonly dots: DotState,
    private readonly pins: Pins,
    private readonly now: () => number = Date.now,
  ) {}

  isDeleted(id: string): boolean {
    return !!this.store.state.deleted[id];
  }

  list(): DeletedSession[] {
    return Object.entries(this.store.state.deleted)
      .map(([id, e]): DeletedSession => ({ id, cwd: e.cwd, title: e.title, deletedAt: e.deletedAt }))
      .sort((a, b) => b.deletedAt - a.deletedAt);
  }

  /** 软删除：写入 deleted，清掉置顶；不碰会话记录文件。执行中的会话不允许删除。 */
  softDelete(id: string, cwd: string, title: string): void {
    if (this.dots.isRunning(id)) throw new HttpError(409, '会话正在执行，不能删除');
    this.store.state.deleted[id] = { cwd, title, deletedAt: this.now() };
    this.pins.clear(id);
    this.store.save();
  }

  /**
   * 批量软删除（工作空间分组的「删除全部会话」）：执行中的会话跳过，其余同 softDelete；只存一次盘。
   * 返回实际删除的与跳过的 id。
   */
  softDeleteMany(items: { id: string; cwd: string; title: string }[]): { deleted: string[]; skipped: string[] } {
    const deleted: string[] = [];
    const skipped: string[] = [];
    const at = this.now();
    for (const it of items) {
      if (this.dots.isRunning(it.id)) {
        skipped.push(it.id);
        continue;
      }
      this.store.state.deleted[it.id] = { cwd: it.cwd, title: it.title, deletedAt: at };
      this.pins.clear(it.id);
      deleted.push(it.id);
    }
    if (deleted.length) this.store.save();
    return { deleted, skipped };
  }

  /** 批量恢复：不在已删除列表里的 id 忽略。返回实际恢复的 id。 */
  restoreMany(ids: string[]): string[] {
    const restored = ids.filter((id) => this.store.state.deleted[id]);
    for (const id of restored) delete this.store.state.deleted[id];
    if (restored.length) this.store.save();
    return restored;
  }

  /** 批量永久删除：逐个走 purge 的全部校验，单个失败不影响其它。 */
  async purgeMany(
    ids: string[],
    locate: (id: string, cwd: string) => Promise<LocatedSession | null>,
  ): Promise<{ purged: string[]; failed: { id: string; error: string }[] }> {
    const purged: string[] = [];
    const failed: { id: string; error: string }[] = [];
    for (const id of ids) {
      try {
        await this.purge(id, locate);
        purged.push(id);
      } catch (e) {
        failed.push({ id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { purged, failed };
  }

  /** 恢复：回到原工作空间的列表（不会自动重新置顶）。返回它的 cwd。 */
  restore(id: string): string {
    const e = this.store.state.deleted[id];
    if (!e) throw new HttpError(404, '该会话不在已删除列表里');
    delete this.store.state.deleted[id];
    this.store.save();
    return e.cwd;
  }

  /**
   * 永久删除：删除 <id>.jsonl 与同名目录 <id>/（子代理等附属文件）。
   * 安全：id 必须是 UUID 且已在 deleted 里；记录所在目录必须正好是 projects 目录的直接子目录；
   * 附属目录 resolve 之后再校验仍是该目录下名为 id 的子目录。
   */
  async purge(id: string, locate: (id: string, cwd: string) => Promise<LocatedSession | null>): Promise<void> {
    if (!isSessionUuid(id)) throw new HttpError(400, '会话 id 不合法');
    const entry = this.store.state.deleted[id];
    if (!entry) throw new HttpError(404, '只能永久删除已在「已删除」列表里的会话');
    if (this.dots.isRunning(id)) throw new HttpError(409, '会话正在执行，不能删除');

    const loc = await locate(id, entry.cwd);
    if (loc) {
      const root = path.resolve(projectsDir());
      const dir = path.resolve(loc.dir);
      const file = path.resolve(loc.file);
      const side = path.resolve(dir, id);
      if (path.dirname(dir) !== root) throw new HttpError(400, '会话目录不在 projects 下');
      if (file !== path.join(dir, `${id}.jsonl`)) throw new HttpError(400, '会话文件路径不合法');
      if (path.dirname(side) !== dir || path.basename(side) !== id) throw new HttpError(400, '会话附属目录路径不合法');
      await fs.promises.rm(file, { force: true });
      await fs.promises.rm(side, { recursive: true, force: true });
    }
    // 文件已经不在了（被外部删掉）时，只清掉记录
    const st = this.store.state;
    delete st.deleted[id];
    delete st.unread[id];
    this.pins.clear(id);
    this.store.save();
  }
}
