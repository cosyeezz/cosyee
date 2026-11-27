// 终端命令历史与 shell 选择持久化：按工作空间 pathKey 分组，防抖 + 原子写落盘。
import fs from 'node:fs';
import path from 'node:path';
import { TERM_HISTORY_LIMIT, type TermShell } from '@cosyee/shared';
import { pathKey } from '../paths.js';

const VALID_SHELLS: ReadonlySet<string> = new Set<TermShell>([
  'pwsh',
  'powershell',
  'cmd',
  'gitbash',
  'bash',
  'zsh',
  'sh',
]);

interface WorkspaceTermData {
  history: string[];
  shell?: TermShell;
}

interface StoredTermFile {
  workspaces: Record<string, WorkspaceTermData>;
}

function sanitize(raw: unknown): StoredTermFile {
  const out: StoredTermFile = { workspaces: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const ws = (raw as Record<string, unknown>).workspaces;
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return out;
  for (const [key, v] of Object.entries(ws as Record<string, unknown>)) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const item = v as Record<string, unknown>;
    const history: string[] = [];
    if (Array.isArray(item.history)) {
      const seen = new Set<string>();
      // 从后往前去重再反转，保留最新的位置，符合「旧 → 新」
      for (let i = item.history.length - 1; i >= 0; i--) {
        const s = item.history[i];
        if (typeof s !== 'string') continue;
        const t = s.trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        history.push(t);
        if (history.length >= TERM_HISTORY_LIMIT) break;
      }
      history.reverse();
    }
    const shell = typeof item.shell === 'string' && VALID_SHELLS.has(item.shell) ? (item.shell as TermShell) : undefined;
    if (history.length > 0 || shell) {
      out.workspaces[key] = shell ? { history, shell } : { history };
    }
  }
  return out;
}

export class TerminalHistoryStore {
  private data: StoredTermFile;
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private tmpSeq = 0;

  constructor(
    private readonly file: string,
    private readonly debounceMs = 300,
  ) {
    this.data = this.load();
  }

  private load(): StoredTermFile {
    try {
      return sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return { workspaces: {} };
    }
  }

  private entry(root: string): WorkspaceTermData {
    const k = pathKey(root);
    let e = this.data.workspaces[k];
    if (!e) {
      e = { history: [] };
      this.data.workspaces[k] = e;
    }
    return e;
  }

  getHistory(root: string): string[] {
    const e = this.data.workspaces[pathKey(root)];
    return e ? [...e.history] : [];
  }

  /** 加入一条历史命令（去首尾空白，空命令忽略；已存在则移到最后；超上限裁掉最旧）。返回更新后的列表，未变化返回 null。 */
  addHistory(root: string, cmd: string): string[] | null {
    const trimmed = cmd.trim();
    if (!trimmed) return null;
    const e = this.entry(root);
    const idx = e.history.indexOf(trimmed);
    if (idx >= 0 && idx === e.history.length - 1) return null; // 已经在最后，无变化
    if (idx >= 0) e.history.splice(idx, 1);
    e.history.push(trimmed);
    if (e.history.length > TERM_HISTORY_LIMIT) {
      e.history.splice(0, e.history.length - TERM_HISTORY_LIMIT);
    }
    this.scheduleSave();
    return [...e.history];
  }

  removeHistory(root: string, cmd: string): string[] {
    const e = this.data.workspaces[pathKey(root)];
    if (!e) return [];
    const idx = e.history.indexOf(cmd);
    if (idx >= 0) {
      e.history.splice(idx, 1);
      this.scheduleSave();
    }
    return [...e.history];
  }

  clearHistory(root: string): string[] {
    const e = this.data.workspaces[pathKey(root)];
    if (e && e.history.length > 0) {
      e.history = [];
      this.scheduleSave();
    }
    return [];
  }

  getShell(root: string): TermShell | null {
    return this.data.workspaces[pathKey(root)]?.shell ?? null;
  }

  setShell(root: string, shell: TermShell): void {
    const e = this.entry(root);
    if (e.shell === shell) return;
    e.shell = shell;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.triggerFlush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private triggerFlush(): void {
    this.writing = this.writing.then(() => this.flush()).catch(() => {});
  }

  /** 立即取消防抖并等待挂起的原子落盘完成（关闭服务 / 测试用）。 */
  async idle(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.triggerFlush();
    }
    await this.writing;
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    const json = JSON.stringify(this.data, null, 2);
    const dir = path.dirname(this.file);
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.${++this.tmpSeq}.tmp`;
    await fs.promises.writeFile(tmp, json, 'utf8');
    // Windows 上目标被占用时 rename 偶发 EPERM/EBUSY，重试几次
    for (let i = 0; ; i++) {
      try {
        await fs.promises.rename(tmp, this.file);
        return;
      } catch (e) {
        if (i >= 5) {
          await fs.promises.rm(tmp, { force: true }).catch(() => {});
          throw e;
        }
        await new Promise((r) => setTimeout(r, 30 * (i + 1)));
      }
    }
  }
}
