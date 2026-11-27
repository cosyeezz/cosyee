// 会话列表 / 历史 / 子代理 / 改名 / 分支：读 ~/.claude/projects 下的 jsonl。
// 写入只有两处：改名往末尾追加两行；分支写出一份新的 <新id>.jsonl（源记录始终只读）。
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  type CostParts, type PinKind, type PriceTable, type RequestUsage, type SessionConfig, type SessionDetail, type SessionSummary, type SubagentCost,
  ZERO_COST, addCost, requestCost, uncachedCost,
} from '@cosyee/shared';
import { encodeCwdCandidates, isSafeId, isSessionUuid, projectsDir } from './paths.js';
import type { DotState } from './state.js';
import {
  DetailScan, HistoryFilter, type Json, type Scan, mergeScans, newScan, parseLine, pickLastActive, pickTitle, scanLines, splitLines,
} from './transcript.js';
import { fileMentions } from './mentions.js';
import { HttpError } from './workspaces.js';

const WINDOW = 64 * 1024;
const CONCURRENCY = 16;
/** 分支链最多往上追几层（防环、防无意义的深链） */
const FORK_CHAIN_MAX = 20;
/** 会话详情缓存上限，超出淘汰最早写入的条目 */
const DETAIL_CACHE_MAX = 200;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  scan: Scan;
}

interface DetailCacheEntry {
  mtimeMs: number;
  size: number;
  detail: SessionDetail;
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
const HISTORY_FORMAT = 3;

/** 分支会话的标题：「分支 · 原标题」（原标题已经带前缀时不重复加） */
const FORK_PREFIX = '分支 · ';
function forkTitle(src: string): string {
  const base = src.startsWith(FORK_PREFIX) ? src.slice(FORK_PREFIX.length) : src;
  return (FORK_PREFIX + base).slice(0, 200);
}

export interface LocatedSession {
  file: string;
  dir: string;
}

/** 置顶 / 软删除对列表的影响（由 Pins / Trash 提供；不设置则列表不过滤、都不置顶） */
export interface SessionFlags {
  isDeleted(id: string): boolean;
  pinKind(id: string): PinKind | null;
  /** 分支会话的来源会话 id（子代理记录留在来源会话下，要顺着它去找）；不是分支返回 null */
  forkSrcOf?(id: string): string | null;
  /** 委派（Antigravity）的执行过程记录；没有返回 null */
  delegateEntries?(id: string, toolUseId: string): Promise<Json[] | null>;
  /** 并行模式下会话所属账号的显示名（其它情况返回 null / 不提供） */
  accountOf?(id: string): string | null;
  /** 会话最近一次使用的配置（发送 / 切换时记下）；没有记录返回 null */
  configOf?(id: string): SessionConfig | null;
}

export class Sessions {
  private cache = new Map<string, CacheEntry>();
  private detailCache = new Map<string, DetailCacheEntry>();
  /** 同一文件（路径 + mtime + size）的并发详情读取合并成一次 */
  private detailInflight = new Map<string, Promise<SessionDetail>>();
  /** 会话文件 → 已确认提到过的路径（mentions 的命中缓存） */
  private mentionHits = new Map<string, Set<string>>();

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

  /**
   * 会话记录里是否提到过这个路径（needles 是同一路径的几种写法，已按 JSON 转义）。
   * 记录只追加不改写，命中结果按文件缓存；没命中每次重扫（只在点开 cwd 之外的路径时发生）。
   */
  async mentions(id: string, needles: string[], ignoreCase = false): Promise<boolean> {
    const loc = await this.locate(id);
    if (!loc) return false;
    const key = needles.join('\0');
    const hits = this.mentionHits.get(loc.file);
    if (hits?.has(key)) return true;
    let found: boolean;
    try {
      found = await fileMentions(loc.file, needles, ignoreCase);
    } catch {
      return false;
    }
    if (found) {
      const set = hits ?? new Set<string>();
      set.add(key);
      this.mentionHits.delete(loc.file);
      this.mentionHits.set(loc.file, set);
      if (this.mentionHits.size > DETAIL_CACHE_MAX) {
        const oldest = this.mentionHits.keys().next().value;
        if (oldest !== undefined) this.mentionHits.delete(oldest);
      }
    }
    return found;
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

  private async readDetail(file: string): Promise<SessionDetail> {
    const scan = new DetailScan();
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) if (line) scan.push(line);
    } finally {
      rl.close();
    }
    return scan.result();
  }

  /** 会话悬浮卡片详情：按 mtimeMs + size 缓存，并发请求合并成一次流式读取。已软删除但文件仍在的会话也可读。 */
  async detail(id: string, cwd: string): Promise<SessionDetail> {
    const loc = await this.locate(id, cwd);
    if (!loc) throw new HttpError(404, '会话不存在');
    let st: fs.Stats;
    try {
      st = await fs.promises.stat(loc.file);
    } catch {
      throw new HttpError(404, '会话不存在');
    }
    const hit = this.detailCache.get(loc.file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.detail;

    const key = `${loc.file}\0${st.mtimeMs}\0${st.size}`;
    const pending = this.detailInflight.get(key);
    if (pending) return pending;

    const job = this.readDetail(loc.file)
      .then((detail) => {
        this.detailCache.delete(loc.file);
        this.detailCache.set(loc.file, { mtimeMs: st.mtimeMs, size: st.size, detail });
        if (this.detailCache.size > DETAIL_CACHE_MAX) {
          const oldest = this.detailCache.keys().next().value;
          if (oldest !== undefined) this.detailCache.delete(oldest);
        }
        return detail;
      })
      .finally(() => {
        this.detailInflight.delete(key);
      });
    this.detailInflight.set(key, job);
    return job;
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

  /**
   * 会话自身加上它的来源会话（分支链，最多 FORK_CHAIN_MAX 层）。
   * 分支只复制主记录，分支点之前的子代理记录还在来源会话的目录下。
   */
  private forkChain(id: string): string[] {
    const chain = [id];
    for (let i = 0; i < FORK_CHAIN_MAX; i++) {
      const src = this.flags?.forkSrcOf?.(chain[chain.length - 1]!);
      if (!src || chain.includes(src)) break;
      chain.push(src);
    }
    return chain;
  }

  async subagent(id: string, toolUseId: string, cwd: string): Promise<Json[]> {
    if (!isSafeId(toolUseId)) throw new HttpError(400, 'toolUseId 不合法');
    const loc = await this.locate(id, cwd);
    if (!loc) throw new HttpError(404, '会话不存在');
    // 分支会话与来源会话同属一个 projects 子目录，直接在 loc.dir 下按 id 取各自的 subagents
    const chain = this.forkChain(id);
    // 委派（Antigravity）不是 claude 的子代理，过程由 Cosyee 自己记录
    for (const sid of chain) {
      const own = await this.flags?.delegateEntries?.(sid, toolUseId);
      if (own) return own;
    }
    const subDirs = chain.map((sid) => path.join(loc.dir, sid, 'subagents'));
    let agentId: string | null = null;

    // 1) meta.json 里的 toolUseId
    for (const subDir of subDirs) {
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
      if (agentId) break;
    }

    // 2) 老会话没有 meta：在主会话里找这个 tool_use 的 tool_result.toolUseResult.agentId
    if (!agentId) agentId = await this.findAgentIdInMain(loc.file, toolUseId);
    if (!agentId || !isSafeId(agentId)) throw new HttpError(404, '找不到该子代理的记录');

    for (const subDir of subDirs) {
      const file = path.join(subDir, `agent-${agentId}.jsonl`);
      if (await exists(file)) return this.filterFile(file);
    }
    throw new HttpError(404, '找不到该子代理的记录');
  }

  /** 每个子代理的花费：逐个读 agent-<id>.jsonl 里的 assistant 请求用量，按价格表计价 */
  async subagentCosts(id: string, cwd: string, table: PriceTable): Promise<SubagentCost[]> {
    const loc = await this.locate(id, cwd);
    if (!loc) throw new HttpError(404, '会话不存在');
    const subDir = path.join(loc.dir, id, 'subagents');
    let names: string[] = [];
    try {
      names = await fs.promises.readdir(subDir);
    } catch { /* 没有子代理目录 */ }
    const agentIds = names
      .map((n) => /^agent-(.+)\.jsonl$/.exec(n)?.[1])
      .filter((a): a is string => !!a && isSafeId(a))
      .sort();
    return mapLimit(agentIds, CONCURRENCY, async (agentId) => {
      let meta: Json = {};
      try {
        meta = JSON.parse(await fs.promises.readFile(path.join(subDir, `agent-${agentId}.meta.json`), 'utf8')) as Json;
      } catch { /* 没有 meta（老会话）或坏文件 */ }
      return this.costOfAgent(path.join(subDir, `agent-${agentId}.jsonl`), agentId, meta, table);
    });
  }

  private async costOfAgent(file: string, agentId: string, meta: Json, table: PriceTable): Promise<SubagentCost> {
    // 同一个 message.id 会被流式写多次（先是中途用量，最后是完整的），只认最后一次
    const byMsg = new Map<string, Json>();
    let anon = 0;
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line.includes('"usage"')) continue;
        const e = parseLine(line);
        if (!e || e.type !== 'assistant') continue;
        const msg = e.message;
        if (!msg || typeof msg !== 'object' || !msg.usage || typeof msg.usage !== 'object') continue;
        if (msg.model === '<synthetic>') continue;
        byMsg.set(typeof msg.id === 'string' ? msg.id : `#${anon++}`, msg);
      }
    } finally {
      rl.close();
    }
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
    let cost: CostParts = ZERO_COST;
    let uncached = 0;
    let unpriced = 0;
    const models = new Set<string>();
    for (const msg of byMsg.values()) {
      const u = msg.usage as Json;
      const model = typeof msg.model === 'string' ? msg.model : undefined;
      if (model) models.add(model);
      const req: RequestUsage = {
        model,
        input: num(u.input_tokens),
        create: num(u.cache_creation_input_tokens),
        create1h: num(u.cache_creation?.ephemeral_1h_input_tokens),
        read: num(u.cache_read_input_tokens),
        output: num(u.output_tokens),
        fast: u.speed === 'fast',
        usGeo: u.inference_geo === 'us',
      };
      const c = requestCost(table, req);
      if (!c) {
        unpriced++;
        continue;
      }
      cost = addCost(cost, c);
      uncached += uncachedCost(table, req) ?? 0;
    }
    return {
      agentId,
      toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
      agentType: typeof meta.agentType === 'string' ? meta.agentType : undefined,
      requests: byMsg.size,
      cost,
      uncached,
      unpriced,
      models: [...models].sort(),
    };
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

  // ───────────── 分支（fork） ─────────────

  /**
   * 从某条用户消息（含插话）「之前」分支出一个新会话：把源记录里这条消息之前的行写成一份新的 <新id>.jsonl，
   * 每行的 sessionId 改成新 id（不改就会被 CLI 当作 stale_target）。源会话不受任何改动。
   *
   * 截断点取「最后一条对话消息（user / assistant / system）之后」：目标消息前面可能还跟着
   * 只服务于它的附属行（attachment、last-prompt 等），一并丢掉，新文件的内容正好等于界面上看到的分支点之前。
   * 返回新会话 id；新会话还会追加一个「分支 · 原标题」的标题，便于在侧栏区分。
   */
  async fork(id: string, cwd: string, targetId: string): Promise<{ sessionId: string }> {
    if (!isSessionUuid(targetId)) throw new HttpError(400, '消息 id 不合法');
    const loc = await this.locate(id, cwd);
    if (!loc) throw new HttpError(404, '会话不存在');
    const scan = await this.scan(id, cwd);

    const newId = randomUUID();
    const outFile = path.join(loc.dir, `${newId}.jsonl`);
    const tmpFile = `${outFile}.tmp`;
    const srcTag = `"sessionId":"${id}"`;
    const newTag = `"sessionId":"${newId}"`;

    const out = fs.createWriteStream(tmpFile, { encoding: 'utf8' });
    const write = (s: string): Promise<void> =>
      new Promise((resolve, reject) => {
        out.write(s, (e) => (e ? reject(e) : resolve()));
      });

    let found = false;
    let kept = 0;
    /** 还没遇到下一条对话消息的附属行：遇到对话消息就跟着写出，到截断点则一起丢掉 */
    let pending: string[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(loc.file, { encoding: 'utf8' }), crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        if (!line) continue;
        if (line.includes(targetId)) {
          const e = parseLine(line);
          // 普通消息是 uuid 相同的 user 条目；插话（steering）在记录里没有 user 条目，只有 source_uuid 相同的 queued_command 附件
          if (e && e.type === 'user' && e.uuid === targetId) {
            found = true;
            break;
          }
          if (e && e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.source_uuid === targetId) {
            found = true;
            break;
          }
        }
        const type = /^\{"type":"([A-Za-z0-9_-]+)"/.exec(line)?.[1] ?? parseLine(line)?.type;
        if (type === 'user' || type === 'assistant' || type === 'system') {
          for (const p of pending) await write(p.split(srcTag).join(newTag) + '\n');
          kept += pending.length;
          pending = [];
          await write(line.split(srcTag).join(newTag) + '\n');
          kept++;
        } else {
          pending.push(line);
        }
      }
    } finally {
      rl.close();
    }

    const fail = async (err: HttpError): Promise<never> => {
      out.destroy();
      await fs.promises.rm(tmpFile, { force: true });
      throw err;
    };
    if (!found) return fail(new HttpError(404, '在会话记录里找不到这条消息'));
    if (kept === 0) return fail(new HttpError(400, '这已经是第一条消息，它之前没有可分支的内容'));

    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
    await fs.promises.rename(tmpFile, outFile);
    await this.appendTitle(newId, cwd, forkTitle(scan ? pickTitle(scan, id) : id));
    return { sessionId: newId };
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
