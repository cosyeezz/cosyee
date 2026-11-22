// 会话列表 / 历史 / 子代理 / 改名：读写 ~/.claude/projects 下的 jsonl（只读，唯一的写入是改名追加两行）。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { PinKind, SessionConfig, SessionSummary } from '@cosyee/shared';
import { encodeCwdCandidates, isSafeId, projectsDir } from './paths.js';
import type { DotState } from './state.js';
import {
  HistoryFilter, type Json, type Scan, mergeScans, newScan, parseLine, pickLastActive, pickTitle, scanLines, splitLines,
} from './transcript.js';
import { HttpError } from './workspaces.js';

const WINDOW = 64 * 1024;
const CONCURRENCY = 16;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  scan: Scan;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readRange(file: string, start: number, length: number): Promise<string> {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** 历史过滤规则变化时递增，让前端缓存的旧结果失效 */
const HISTORY_FORMAT = 2;

export interface LocatedSession {
  file: string;
  dir: string;
}

/** 置顶 / 软删除对列表的影响（由 Pins / Trash 提供；不设置则列表不过滤、都不置顶） */
export interface SessionFlags {
  isDeleted(id: string): boolean;
  pinKind(id: string): PinKind | null;
  /** 并行模式下会话所属账号的显示名（其它情况返回 null / 不提供） */
  accountOf?(id: string): string | null;
  /** 会话最近一次使用的配置（发送 / 切换时记下）；没有记录返回 null */
  configOf?(id: string): SessionConfig | null;
}

export class Sessions {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly dots: DotState,
    private flags: SessionFlags | null = null,
  ) {}

  /** server.ts 在 Pins / Trash 构造好之后接上 */
  setFlags(flags: SessionFlags): void {
    this.flags = flags;
  }

  /** 有账号名时才带 account 字段 */
  private accountField(id: string): { account?: string } {
    const a = this.flags?.accountOf?.(id);
    return a ? { account: a } : {};
  }

  /** 会话配置字段：有记录带 config；没有记录时带从会话记录推断的 lastModel */
  private configField(id: string, scan?: Scan): { config?: SessionConfig; lastModel?: string } {
    const c = this.flags?.configOf?.(id);
    if (c) return { config: { ...c } };
    return scan?.model ? { lastModel: scan.model } : {};
  }

  /** cwd 对应的 projects 子目录；不存在返回 null。 */
  async projectDir(cwd: string): Promise<string | null> {
    const root = projectsDir();
    for (const name of encodeCwdCandidates(cwd)) {
      const d = path.join(root, name);
      if (await exists(d)) return d;
    }
    return null;
  }

  /** 找会话文件：先按 cwd 编码找，找不到则扫描 projects 下所有目录。 */
  async locate(id: string, cwd?: string): Promise<LocatedSession | null> {
    if (!isSafeId(id)) return null;
    if (cwd) {
      const d = await this.projectDir(cwd);
      if (d) {
        const f = path.join(d, `${id}.jsonl`);
        if (await exists(f)) return { file: f, dir: d };
      }
    }
    let names: string[];
    try {
      names = await fs.promises.readdir(projectsDir());
    } catch {
      return null;
    }
    for (const n of names) {
      const d = path.join(projectsDir(), n);
      const f = path.join(d, `${id}.jsonl`);
      if (await exists(f)) return { file: f, dir: d };
    }
    return null;
  }

  /** 从会话文件头部读出它记录的 cwd（context refresh 没带 cwd 时用）。 */
  async findCwd(id: string): Promise<string | null> {
    const loc = await this.locate(id);
    if (!loc) return null;
    try {
      const text = await readRange(loc.file, 0, WINDOW);
      const s = scanLines(splitLines(text, { dropLast: text.length >= WINDOW }));
      return s.cwd ?? null;
    } catch {
      return null;
    }
  }

  // ───────────── 列表 ─────────────

  async list(cwd: string): Promise<SessionSummary[]> {
    const dir = await this.projectDir(cwd);
    if (!dir) return [];
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return [];
    }
    const released = new Set(
      names.filter((n) => n.endsWith('.desktop-released.json')).map((n) => n.slice(0, -'.desktop-released.json'.length)),
    );
    const ids = names
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.slice(0, -'.jsonl'.length))
      .filter((id) => isSafeId(id) && !released.has(id) && !this.flags?.isDeleted(id));

    const rows = await mapLimit(ids, CONCURRENCY, (id) => this.summarize(id, cwd, path.join(dir, `${id}.jsonl`)));
    return rows.filter((r): r is SessionSummary => r !== null).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /** 单个会话的摘要（置顶区用）；文件不存在 / 没有消息 / 已删除返回 null。 */
  async get(id: string, cwd: string): Promise<SessionSummary | null> {
    if (!isSafeId(id) || this.flags?.isDeleted(id)) return null;
    const loc = await this.locate(id, cwd);
    if (!loc) return null;
    return this.summarize(id, cwd, loc.file);
  }

  /**
   * 执行中、但记录文件还没写出第一条消息的会话（新会话刚发出第一条消息时）的占位摘要：
   * 置顶区先显示「新会话」，等这一轮结束（sessions.changed）后再换成真正的标题。已删除返回 null。
   */
  placeholder(id: string, cwd: string): SessionSummary | null {
    if (!isSafeId(id) || this.flags?.isDeleted(id)) return null;
    return {
      id,
      cwd,
      title: '',
      lastActiveAt: Date.now(),
      dot: this.dots.dot(id),
      pinned: this.flags?.pinKind(id) ?? null,
      ...this.accountField(id),
      ...this.configField(id),
    };
  }

  private async summarize(id: string, cwd: string, file: string): Promise<SessionSummary | null> {
    try {
      const st = await fs.promises.stat(file);
      const scan = await this.scanFile(file, st);
      if (!scan.hasMessages) return null;
      return {
        id,
        cwd,
        title: pickTitle(scan, id),
        lastActiveAt: pickLastActive(scan.lastTs, st.mtimeMs),
        dot: this.dots.dot(id),
        pinned: this.flags?.pinKind(id) ?? null,
        ...this.accountField(id),
        ...this.configField(id, scan),
      };
    } catch {
      return null;
    }
  }

  /** 会话文件的扫描结果（标题、首条消息等）；找不到 / 读失败返回 null。 */
  async scan(id: string, cwd: string): Promise<Scan | null> {
    try {
      const loc = await this.locate(id, cwd);
      if (!loc) return null;
      return await this.scanFile(loc.file, await fs.promises.stat(loc.file));
    } catch {
      return null;
    }
  }

  private async scanFile(file: string, st: fs.Stats): Promise<Scan> {
    const hit = this.cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.scan;
    let scan: Scan;
    if (st.size <= WINDOW * 2) {
      const text = await readRange(file, 0, st.size);
      scan = scanLines(splitLines(text));
    } else {
      const [headText, tailText] = await Promise.all([
        readRange(file, 0, WINDOW),
        readRange(file, st.size - WINDOW, WINDOW),
      ]);
      const head = scanLines(splitLines(headText, { dropLast: true }), newScan());
      const tail = scanLines(splitLines(tailText, { dropFirst: true }), newScan());
      scan = mergeScans(head, tail);
    }
    this.cache.set(file, { mtimeMs: st.mtimeMs, size: st.size, scan });
    return scan;
  }

  // ───────────── 历史 / 子代理 ─────────────

  private async filterFile(file: string): Promise<Json[]> {
    const f = new HistoryFilter();
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) if (line) f.push(line);
    return f.result();
  }

  async history(id: string, cwd: string): Promise<Json[]> {
    const loc = await this.locate(id, cwd);
    if (!loc) throw new HttpError(404, '会话不存在');
    return this.filterFile(loc.file);
  }

  /**
   * 带版本号的历史：版本号由文件大小 + 修改时间（+ 过滤格式版本）组成。
   * since 与当前版本相同时不读文件，只回 unchanged，前端直接复用上次构建好的状态（切回刚看过的会话时省掉下载和重建）。
   * 先取版本再读文件：读的过程中文件又追加了，下次版本对不上会重新拉，不会漏。
   */
  async historyVersioned(id: string, cwd: string, since?: string | null): Promise<{ version: string; entries?: Json[]; unchanged?: true }> {
    const loc = await this.locate(id, cwd);
    if (!loc) throw new HttpError(404, '会话不存在');
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(loc.file);
    } catch {
      throw new HttpError(404, '会话不存在');
    }
    const version = `${HISTORY_FORMAT}.${st.size}.${st.mtimeMs}`;
    if (since && since === version) return { version, unchanged: true };
    return { version, entries: await this.filterFile(loc.file) };
  }

  async subagent(id: string, toolUseId: string, cwd: string): Promise<Json[]> {
    if (!isSafeId(toolUseId)) throw new HttpError(400, 'toolUseId 不合法');
    const loc = await this.locate(id, cwd);
    if (!loc) throw new HttpError(404, '会话不存在');
    const subDir = path.join(loc.dir, id, 'subagents');
    let agentId: string | null = null;

    // 1) meta.json 里的 toolUseId
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(subDir);
    } catch { /* 没有子代理目录 */ }
    for (const n of names) {
      const m = /^agent-(.+)\.meta\.json$/.exec(n);
      if (!m) continue;
      try {
        const meta = JSON.parse(await fs.promises.readFile(path.join(subDir, n), 'utf8')) as Json;
        if (meta.toolUseId === toolUseId) {
          agentId = m[1]!;
          break;
        }
      } catch { /* 忽略坏文件 */ }
    }

    // 2) 老会话没有 meta：在主会话里找这个 tool_use 的 tool_result.toolUseResult.agentId
    if (!agentId) agentId = await this.findAgentIdInMain(loc.file, toolUseId);
    if (!agentId || !isSafeId(agentId)) throw new HttpError(404, '找不到该子代理的记录');

    const file = path.join(subDir, `agent-${agentId}.jsonl`);
    if (!(await exists(file))) throw new HttpError(404, '找不到该子代理的记录');
    return this.filterFile(file);
  }

  private async findAgentIdInMain(file: string, toolUseId: string): Promise<string | null> {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.includes(toolUseId) || !line.includes('agentId')) continue;
        const e = parseLine(line);
        if (!e || e.type !== 'user') continue;
        const c = e.message?.content;
        if (!Array.isArray(c)) continue;
        if (c.some((b: Json) => b && b.type === 'tool_result' && b.tool_use_id === toolUseId)) {
          const a = e.toolUseResult?.agentId;
          if (typeof a === 'string') return a;
        }
      }
    } finally {
      rl.close();
    }
    return null;
  }

  // ───────────── 改名（进程不在线时） ─────────────

  /** 往会话 jsonl 末尾追加 custom-title + agent-name 两行（先确认文件以换行结尾）。 */
  async appendTitle(id: string, cwd: string, title: string): Promise<void> {
    const loc = await this.locate(id, cwd);
    if (!loc) throw new HttpError(404, '会话不存在');
    const st = await fs.promises.stat(loc.file);
    let prefix = '';
    if (st.size > 0) {
      const last = await readRange(loc.file, st.size - 1, 1);
      if (last !== '\n') prefix = '\n';
    }
    const lines =
      JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id }) + '\n' +
      JSON.stringify({ type: 'agent-name', agentName: title, sessionId: id }) + '\n';
    await fs.promises.appendFile(loc.file, prefix + lines, 'utf8');
  }
}
