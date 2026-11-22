// 跨会话的压缩效果统计：扫描 projects 下所有主会话记录（不含子智能体），回答两个问题——
//  1. 上下文越大，模型表现是不是越差？按每次请求的上下文大小分桶，看工具出错率、用户中断率。
//  2. 在多大的上下文压缩，丢的信息更多？按压缩时的大小（preTokens）分桶，看压缩后多少次请求里
//     重新 Read 了压缩前读过的文件（摘要没保住的信息只能重读）、出错率前后对比、到下一次压缩隔多久。
// 都是观察性数据：不同会话的任务不同、样本量也小，只能当参考，不是对照实验。
// 会话记录只追加不改写，但一次压缩前后的统计要看整段，所以按文件（大小 + 修改时间）缓存每个文件的汇总，变了就整个重扫。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import type { CompactBucketStats, CompactStats, ContextBucketStats, TokenBucket } from '@cosyee/shared';
import { cosyeeHome, projectsDir } from './paths.js';
import { parseLine } from './transcript.js';

type Json = Record<string, any>;

/** 压缩前后各取多少次请求做比较 */
export const COMPACT_WINDOW_REQUESTS = 20;

const K = 1000;
/** 分桶边界（token）：最后一桶不封顶 */
export const BUCKET_EDGES = [0, 50 * K, 100 * K, 150 * K, 200 * K, 300 * K, 500 * K];

const INTERRUPT_PREFIX = '[Request interrupted by user';

export function buckets(): TokenBucket[] {
  return BUCKET_EDGES.map((from, i) => ({ from, to: BUCKET_EDGES[i + 1] ?? null }));
}

export function bucketOf(tokens: number): number {
  let i = 0;
  while (i + 1 < BUCKET_EDGES.length && tokens >= BUCKET_EDGES[i + 1]!) i++;
  return i;
}

const emptyCtx = (b: TokenBucket): ContextBucketStats => ({ ...b, requests: 0, toolCalls: 0, toolErrors: 0, interrupts: 0, inputTokens: 0 });
const emptyCompact = (b: TokenBucket): CompactBucketStats => ({
  ...b, count: 0, auto: 0, post: 0, postCount: 0, callsBefore: 0, errorsBefore: 0, callsAfter: 0, errorsAfter: 0,
  interruptsAfter: 0, requestsAfter: 0, readsAfter: 0, rereads: 0, gap: 0, gapCount: 0,
});

/** 单个文件的汇总（各桶的合计，与 CompactStats 同形） */
export interface FileSummary {
  byContext: ContextBucketStats[];
  byCompact: CompactBucketStats[];
  requests: number;
}

interface Req {
  ctx: number;
  calls: number;
  errors: number;
  interrupts: number;
}

interface Boundary {
  /** 压缩后第一次请求的序号（= 压缩时已有的请求数） */
  at: number;
  pre: number;
  post: number | null;
  auto: boolean;
}

const tok = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('');
}

/** 逐行喂入一个会话记录，最后 summary() 出汇总；纯计算，便于测试 */
export class SessionScanner {
  private reqs: Req[] = [];
  private byMsg = new Map<string, number>();
  private toolReq = new Map<string, number>();
  private errored = new Set<string>();
  /** Read 调用：请求序号与文件路径 */
  private reads: { req: number; file: string }[] = [];
  private bounds: Boundary[] = [];

  line(line: string): void {
    // 绝大多数行（附件、api-request 副本等）与此无关，先用字符串判断，省掉 JSON 解析
    const isA = line.includes('"type":"assistant"');
    const isU = !isA && line.includes('"type":"user"');
    const isB = !isA && !isU && line.includes('compact_boundary');
    if (!isA && !isU && !isB) return;
    const e = parseLine(line);
    if (e) this.entry(e);
  }

  entry(e: Json): void {
    if (e.isSidechain === true) return;
    if (e.type === 'assistant') this.assistant(e);
    else if (e.type === 'user') this.user(e);
    else if (e.type === 'system' && e.subtype === 'compact_boundary') this.boundary(e);
  }

  private assistant(e: Json): void {
    if (e.isApiErrorMessage === true) return;
    const m = e.message;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string') return;
    let idx = this.byMsg.get(m.id);
    if (idx === undefined) {
      const u = m.usage ?? {};
      const ctx = tok(u.input_tokens) + tok(u.cache_creation_input_tokens) + tok(u.cache_read_input_tokens);
      if (ctx <= 0) return;
      idx = this.reqs.length;
      this.reqs.push({ ctx, calls: 0, errors: 0, interrupts: 0 });
      this.byMsg.set(m.id, idx);
    }
    const req = this.reqs[idx]!;
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type !== 'tool_use' || typeof b.id !== 'string' || this.toolReq.has(b.id)) continue;
      this.toolReq.set(b.id, idx);
      req.calls++;
      const file = b.name === 'Read' && typeof b.input?.file_path === 'string' ? b.input.file_path : '';
      if (file) this.reads.push({ req: idx, file: file.replace(/\\/g, '/') });
    }
  }

  private user(e: Json): void {
    if (e.isCompactSummary === true) return;
    const content = e.message?.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type !== 'tool_result' || b.is_error !== true || typeof b.tool_use_id !== 'string') continue;
        const idx = this.toolReq.get(b.tool_use_id);
        if (idx === undefined || this.errored.has(b.tool_use_id)) continue;
        this.errored.add(b.tool_use_id);
        this.reqs[idx]!.errors++;
      }
    }
    if (this.reqs.length && textOf(content).startsWith(INTERRUPT_PREFIX)) this.reqs[this.reqs.length - 1]!.interrupts++;
  }

  private boundary(e: Json): void {
    const md = e.compactMetadata ?? e.compact_metadata;
    if (!md || typeof md !== 'object') return;
    const pre = tok(md.preTokens ?? md.pre_tokens);
    if (!pre) return;
    const post = tok(md.postTokens ?? md.post_tokens);
    this.bounds.push({ at: this.reqs.length, pre, post: post || null, auto: md.trigger !== 'manual' });
  }

  summary(): FileSummary {
    const bs = buckets();
    const byContext = bs.map(emptyCtx);
    const byCompact = bs.map(emptyCompact);
    for (const r of this.reqs) {
      const b = byContext[bucketOf(r.ctx)]!;
      b.requests++;
      b.toolCalls += r.calls;
      b.toolErrors += r.errors;
      b.interrupts += r.interrupts;
      b.inputTokens += r.ctx;
    }
    const N = COMPACT_WINDOW_REQUESTS;
    this.bounds.forEach((c, i) => {
      const prevAt = i > 0 ? this.bounds[i - 1]!.at : 0;
      const next = this.bounds[i + 1];
      const end = Math.min(c.at + N, next ? next.at : this.reqs.length);
      const b = byCompact[bucketOf(c.pre)]!;
      b.count++;
      if (c.auto) b.auto++;
      if (c.post !== null) {
        b.post += c.post;
        b.postCount++;
      }
      for (let k = Math.max(prevAt, c.at - N); k < c.at; k++) {
        b.callsBefore += this.reqs[k]!.calls;
        b.errorsBefore += this.reqs[k]!.errors;
      }
      for (let k = c.at; k < end; k++) {
        b.callsAfter += this.reqs[k]!.calls;
        b.errorsAfter += this.reqs[k]!.errors;
        b.interruptsAfter += this.reqs[k]!.interrupts;
      }
      b.requestsAfter += Math.max(0, end - c.at);
      const before = new Set(this.reads.filter((r) => r.req >= prevAt && r.req < c.at).map((r) => r.file));
      const after = new Set(this.reads.filter((r) => r.req >= c.at && r.req < end).map((r) => r.file));
      b.readsAfter += after.size;
      for (const f of after) if (before.has(f)) b.rereads++;
      if (next) {
        b.gap += next.at - c.at;
        b.gapCount++;
      }
    });
    return { byContext, byCompact, requests: this.reqs.length };
  }
}

/** 汇总一组文件的结果 */
export function mergeSummaries(list: FileSummary[]): FileSummary {
  const bs = buckets();
  const out: FileSummary = { byContext: bs.map(emptyCtx), byCompact: bs.map(emptyCompact), requests: 0 };
  for (const s of list) {
    out.requests += s.requests;
    s.byContext.forEach((b, i) => {
      const o = out.byContext[i];
      if (!o) return;
      o.requests += b.requests;
      o.toolCalls += b.toolCalls;
      o.toolErrors += b.toolErrors;
      o.interrupts += b.interrupts;
      o.inputTokens += b.inputTokens;
    });
    s.byCompact.forEach((b, i) => {
      const o = out.byCompact[i] as unknown as Record<string, number> | undefined;
      if (!o) return;
      for (const [k, v] of Object.entries(b)) if (k !== 'from' && k !== 'to' && typeof v === 'number') o[k] = (o[k] ?? 0) + v;
    });
  }
  return out;
}

async function scanFile(file: string): Promise<FileSummary> {
  const sc = new SessionScanner();
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) sc.line(line);
  return sc.summary();
}

/** projects 下所有主会话记录：<项目>/<会话>.jsonl */
async function listSessions(root: string): Promise<string[]> {
  const files: string[] = [];
  const dirs = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const proj = path.join(root, d.name);
    const items = await fs.promises.readdir(proj, { withFileTypes: true }).catch(() => []);
    for (const it of items) if (it.isFile() && it.name.endsWith('.jsonl')) files.push(path.join(proj, it.name));
  }
  return files;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  sum: FileSummary;
}

interface CacheFile {
  /** 分桶或算法变了就换版本号，旧缓存作废 */
  v: 1;
  edges: number[];
  window: number;
  files: Record<string, CacheEntry>;
}

export class CompactStatsStore {
  private cache: CacheFile | null = null;
  private running: Promise<CompactStats> | null = null;

  constructor(
    private readonly root: () => string = projectsDir,
    private readonly cacheFile: string = path.join(cosyeeHome(), 'compact-stats.json'),
  ) {}

  /** 扫描（文件没变的用缓存）并返回合计；同时只跑一次，并发请求共用结果 */
  get(): Promise<CompactStats> {
    this.running ??= this.scan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async load(): Promise<CacheFile> {
    if (this.cache) return this.cache;
    try {
      const j = JSON.parse(await fs.promises.readFile(this.cacheFile, 'utf8'));
      if (
        j?.v === 1 && j.files && typeof j.files === 'object' && j.window === COMPACT_WINDOW_REQUESTS &&
        Array.isArray(j.edges) && j.edges.join() === BUCKET_EDGES.join()
      ) return (this.cache = j as CacheFile);
    } catch {
      // 没有缓存或已损坏：从头扫
    }
    return (this.cache = { v: 1, edges: BUCKET_EDGES, window: COMPACT_WINDOW_REQUESTS, files: {} });
  }

  private async scan(): Promise<CompactStats> {
    const cache = await this.load();
    const files = await listSessions(this.root());
    const next: Record<string, CacheEntry> = {};
    let changed = files.length !== Object.keys(cache.files).length;
    for (const f of files) {
      const st = await fs.promises.stat(f).catch(() => null);
      if (!st) continue;
      let ent = cache.files[f];
      if (!ent || ent.size !== st.size || ent.mtimeMs !== st.mtimeMs) {
        try {
          ent = { size: st.size, mtimeMs: st.mtimeMs, sum: await scanFile(f) };
          changed = true;
        } catch {
          // 读失败（被占用 / 刚被删）：沿用上次的结果，没有就跳过
          if (!ent) continue;
        }
      }
      next[f] = ent;
    }
    cache.files = next;
    if (changed) await this.save(cache);
    const total = mergeSummaries(Object.values(next).map((e) => e.sum));
    return {
      byContext: total.byContext,
      byCompact: total.byCompact,
      window: COMPACT_WINDOW_REQUESTS,
      sessions: files.length,
      requests: total.requests,
      at: Date.now(),
    };
  }

  private async save(cache: CacheFile): Promise<void> {
    try {
      await fs.promises.mkdir(path.dirname(this.cacheFile), { recursive: true });
      const tmp = `${this.cacheFile}.${process.pid}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(cache));
      await fs.promises.rename(tmp, this.cacheFile);
    } catch {
      // 写缓存失败不影响结果，下次重扫
    }
  }
}
