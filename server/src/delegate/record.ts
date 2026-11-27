// 委派执行过程的落盘：会话记录里 delegate 只有最终结果，刷新 / 重启后想看过程只能靠这里。
// 每个委派一个文件 <dir>/<会话 id>/<toolUseId>.jsonl，条目形状同 claude 的子代理记录，前端用同一套代码还原成子代理的会话流。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type CachePoint,
  COSYEE_USAGE_SUBTYPE,
  type DelegateJobState,
  type DelegateNotification,
  isCosyeeUsageEvent,
  pushCachePoint,
} from '@cosyee/shared';
import { isSafeId } from '../paths.js';
import { parseLine, type Json } from '../transcript.js';
import { ACCOUNT_ID_RE } from '../workspaces.js';

export interface DelegateIdRecord {
  backend: string;
  sessionId?: string;
  /** 创建该委派会话的后端账号 id；旧记录缺失视为 'default' */
  accountId?: string;
  agent: string;
  cwd: string;
  createdAt: number;
}

export interface PersistedJob {
  conversationId: string;
  toolUseId: string;
  description: string;
  agent: string;
  background: boolean;
  state: DelegateJobState;
  startedAt: number;
  endedAt?: number;
  error?: string;
}

export interface PersistedJobs {
  jobs: PersistedJob[];
  pendingNotifications: DelegateNotification[];
}

export type DelegateUsageSource = 'claude' | 'codex' | 'agy';

export interface DelegateUsageRecord {
  /** 委派任务 conversationId；没有 jobs.json 元信息时回退为 toolUseId */
  agentId: string;
  /** 委派工具调用 id */
  toolUseId: string;
  /** 子代理类型（来自 jobs.json 或 ids/<convId>.json）；没有时省略 */
  agentType?: string;
  /** 委派后端来源；未知时省略 */
  source?: DelegateUsageSource;
  /** 按 point.id 去重合并后的逐次请求用量 */
  points: CachePoint[];
}

const DELEGATE_SOURCES = new Set<DelegateUsageSource>(['claude', 'codex', 'agy']);

function asDelegateSource(v: unknown): DelegateUsageSource | undefined {
  return typeof v === 'string' && DELEGATE_SOURCES.has(v as DelegateUsageSource) ? (v as DelegateUsageSource) : undefined;
}

function inferSourceFromPoints(points: readonly CachePoint[]): DelegateUsageSource | undefined {
  for (const p of points) {
    if (p.id.startsWith('codex:')) return 'codex';
    if (p.id.startsWith('agy:')) return 'agy';
    if (p.id.startsWith('msg_')) return 'claude';
  }
  return undefined;
}

export interface DelegateRecorderOptions {
  retentionMs?: number;
  now?: () => number;
}

/** 单个委派的记录上限，超过后不再写 */
const FILE_MAX = 8 * 1024 * 1024;
/** 全局结果与 id 映射保留 30 天 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const JOB_STATES = new Set<DelegateJobState>(['running', 'done', 'error', 'stopped']);

interface Rec {
  file: string;
  /** 已写入（含排队中）的字节数；null = 还没看过文件现有大小 */
  size: number | null;
  /** 当前流式消息的元信息（跨同消息内多个内容块保持，遇到新消息或完整 assistant/user 条目时重置） */
  msg: { id: string; model?: string } | null;
  /** 还在流式输出、没写盘的内容块（文字或思考） */
  open: { id: string; model?: string; kind: 'text' | 'thinking'; text: string; at: string } | null;
  effort?: string;
  chain: Promise<void>;
}

export class DelegateRecorder {
  private readonly recs = new Map<string, Rec>();
  private readonly jobChains = new Map<string, Promise<void>>();
  /** 构造时启动的异步过期清理 Promise（便于测试等待） */
  readonly cleanupDone: Promise<void>;

  constructor(private readonly dir: string, private readonly maxBytes = FILE_MAX, opts: DelegateRecorderOptions = {}) {
    this.cleanupDone = this.cleanupExpired(opts.retentionMs ?? RETENTION_MS, opts.now ?? Date.now);
  }

  /** 记下一批推给前端的过程事件（AcpProgress 产出的 CLI 形状事件） */
  write(sessionId: string, evs: Json[]): void {
    for (const e of evs) {
      if (e?.type === 'system' && e.subtype === 'cosyee_agent_params') {
        const r = this.rec(sessionId, e.tool_use_id);
        if (r && typeof e.effort === 'string') r.effort = e.effort;
        continue;
      }
      const r = this.rec(sessionId, e?.parent_tool_use_id);
      if (!r) continue;
      if (e.type === 'system' && e.subtype === COSYEE_USAGE_SUBTYPE) {
        this.append(r, {
          type: e.type,
          subtype: e.subtype,
          parent_tool_use_id: e.parent_tool_use_id,
          point: e.point,
          ...(e.window !== undefined ? { window: e.window } : {}),
        });
      } else if (e.type === 'stream_event') this.stream(r, e);
      else if (e.type === 'assistant' || e.type === 'user') {
        this.closeBlock(r);
        r.msg = null;
        this.append(r, { type: e.type, message: e.message, ...(e.type === 'assistant' && r.effort ? { effort: r.effort } : {}) });
      }
    }
  }

  /** 一个委派至今的过程（含正在输出的文字或思考）；没有记录返回 null */
  async read(sessionId: string, toolUseId: string): Promise<Json[] | null> {
    const file = this.fileOf(sessionId, toolUseId);
    if (!file) return null;
    const rec = this.recs.get(file);
    if (rec) await rec.chain;
    let raw = '';
    try {
      raw = await fs.promises.readFile(file, 'utf8');
    } catch {
      if (!rec?.open) return null;
    }
    const out = raw.split('\n').map((l) => (l ? parseLine(l) : null)).filter((x): x is Json => !!x);
    if (rec?.open?.text) out.push(this.blockEntry(rec, rec.open));
    return out.length ? out : null;
  }

  /** 读取一个会话下所有委派落盘文件里的 cosyee_usage，按 point.id 去重合并后返回 */
  async listUsage(sessionId: string): Promise<DelegateUsageRecord[]> {
    if (!isSafeId(sessionId)) return [];
    const sessionDir = path.join(this.dir, sessionId);
    const prefix = sessionDir + path.sep;
    // 先等内存中该会话尚未落盘的写链完成
    const waits: Promise<void>[] = [];
    for (const [file, r] of this.recs) {
      if (file.startsWith(prefix)) waits.push(r.chain.catch(() => {}));
    }
    if (waits.length) await Promise.all(waits);

    let names: string[];
    try {
      names = await fs.promises.readdir(sessionDir);
    } catch {
      return [];
    }
    const toolUseIds = names
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => n.slice(0, -'.jsonl'.length))
      .filter((id) => isSafeId(id))
      .sort();
    if (toolUseIds.length === 0) return [];

    const persisted = this.readJobs(sessionId);
    const jobByTool = new Map<string, PersistedJob>();
    if (persisted) {
      for (const j of persisted.jobs) jobByTool.set(j.toolUseId, j);
    }

    const out: DelegateUsageRecord[] = [];
    for (const toolUseId of toolUseIds) {
      let raw: string;
      try {
        raw = await fs.promises.readFile(path.join(sessionDir, `${toolUseId}.jsonl`), 'utf8');
      } catch {
        continue;
      }
      const points: CachePoint[] = [];
      for (const line of raw.split('\n')) {
        if (!line || !line.includes(COSYEE_USAGE_SUBTYPE)) continue;
        const e = parseLine(line);
        if (isCosyeeUsageEvent(e)) pushCachePoint(points, e.point);
      }
      if (points.length === 0) continue;

      const job = jobByTool.get(toolUseId);
      const idRec = job ? await this.readId(job.conversationId) : null;
      const agentId = job?.conversationId ?? toolUseId;
      const agentType = job?.agent || idRec?.agent || undefined;
      const source = asDelegateSource(idRec?.backend) ?? inferSourceFromPoints(points);
      out.push({
        agentId,
        toolUseId,
        ...(agentType ? { agentType } : {}),
        ...(source ? { source } : {}),
        points,
      });
    }
    return out;
  }

  /** 存一份任务结果。放在各会话之外：分支会话也能凭 id 取到来源会话里的结果 */
  async saveResult(id: string, text: string): Promise<void> {
    if (!isSafeId(id)) return;
    const dir = path.join(this.dir, 'results');
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, `${id}.txt`), text);
    } catch (e) {
      console.warn('[delegate] 写任务结果失败:', e instanceof Error ? e.message : e);
    }
  }

  async readResult(id: string): Promise<string | null> {
    if (!isSafeId(id)) return null;
    try {
      return await fs.promises.readFile(path.join(this.dir, 'results', `${id}.txt`), 'utf8');
    } catch {
      return null;
    }
  }

  /** 存一份 conversation_id -> 后端会话的映射（服务重启后仍可续聊） */
  async saveId(id: string, rec: DelegateIdRecord): Promise<void> {
    if (!isSafeId(id)) return;
    const dir = path.join(this.dir, 'ids');
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, `${id}.json`), JSON.stringify(rec));
    } catch (e) {
      console.warn('[delegate] 写会话映射失败:', e instanceof Error ? e.message : e);
    }
  }

  async readId(id: string): Promise<DelegateIdRecord | null> {
    if (!isSafeId(id)) return null;
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(this.dir, 'ids', `${id}.json`), 'utf8')) as Partial<DelegateIdRecord> | null;
      if (!raw || typeof raw.backend !== 'string' || typeof raw.agent !== 'string' || typeof raw.cwd !== 'string' || typeof raw.createdAt !== 'number') {
        return null;
      }
      const accountId =
        typeof raw.accountId === 'string' && (raw.accountId === 'default' || ACCOUNT_ID_RE.test(raw.accountId))
          ? raw.accountId
          : undefined;
      return {
        backend: raw.backend,
        ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
        ...(accountId ? { accountId } : {}),
        agent: raw.agent,
        cwd: raw.cwd,
        createdAt: raw.createdAt,
      };
    } catch {
      return null;
    }
  }

  /** 原子持久化一个会话的委派任务快照与未送达通知（同会话串行写，tmp + rename） */
  saveJobs(sessionId: string, data: PersistedJobs): Promise<void> {
    if (!isSafeId(sessionId)) return Promise.resolve();
    const prev = this.jobChains.get(sessionId) ?? Promise.resolve();
    const next = prev
      .then(async () => {
        const dir = path.join(this.dir, sessionId);
        const file = path.join(dir, 'jobs.json');
        const tmp = path.join(dir, `jobs.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
        try {
          await fs.promises.mkdir(dir, { recursive: true });
          await fs.promises.writeFile(tmp, JSON.stringify(data));
          await fs.promises.rename(tmp, file);
        } catch (e) {
          await fs.promises.unlink(tmp).catch(() => {});
          console.warn('[delegate] 写任务列表失败:', e instanceof Error ? e.message : e);
        }
      })
      .catch(() => {});
    this.jobChains.set(sessionId, next);
    return next;
  }

  /** 同步读取会话的委派任务快照；文件不存在或损坏返回 null */
  readJobs(sessionId: string): PersistedJobs | null {
    if (!isSafeId(sessionId)) return null;
    const file = path.join(this.dir, sessionId, 'jobs.json');
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<PersistedJobs> | null;
      if (!raw || !Array.isArray(raw.jobs)) return null;
      const jobs: PersistedJob[] = [];
      for (const j of raw.jobs) {
        if (
          !j ||
          typeof j.conversationId !== 'string' ||
          typeof j.toolUseId !== 'string' ||
          typeof j.description !== 'string' ||
          typeof j.agent !== 'string' ||
          typeof j.background !== 'boolean' ||
          !JOB_STATES.has(j.state) ||
          typeof j.startedAt !== 'number'
        ) {
          continue;
        }
        jobs.push({
          conversationId: j.conversationId,
          toolUseId: j.toolUseId,
          description: j.description,
          agent: j.agent,
          background: j.background,
          state: j.state,
          startedAt: j.startedAt,
          ...(typeof j.endedAt === 'number' ? { endedAt: j.endedAt } : {}),
          ...(typeof j.error === 'string' ? { error: j.error } : {}),
        });
      }
      const pendingNotifications: DelegateNotification[] = [];
      if (Array.isArray(raw.pendingNotifications)) {
        for (const n of raw.pendingNotifications) {
          if (
            !n ||
            typeof n.conversationId !== 'string' ||
            typeof n.toolUseId !== 'string' ||
            (n.status !== 'done' && n.status !== 'error' && n.status !== 'stopped') ||
            typeof n.description !== 'string' ||
            typeof n.result !== 'string'
          ) {
            continue;
          }
          pendingNotifications.push({
            conversationId: n.conversationId,
            toolUseId: n.toolUseId,
            status: n.status,
            description: n.description,
            ...(typeof n.resultId === 'string' ? { resultId: n.resultId } : {}),
            result: n.result,
          });
        }
      }
      return { jobs, pendingNotifications };
    } catch {
      return null;
    }
  }

  /** 永久删除会话时清除该会话的全部委派落盘目录 <dir>/<sessionId>/ */
  async deleteSession(sessionId: string): Promise<void> {
    if (!isSafeId(sessionId)) return;
    const sessionDir = path.join(this.dir, sessionId);
    const prefix = sessionDir + path.sep;
    const waits: Promise<void>[] = [];
    for (const [file, r] of [...this.recs]) {
      if (file.startsWith(prefix)) {
        this.recs.delete(file);
        waits.push(r.chain.catch(() => {}));
      }
    }
    const jc = this.jobChains.get(sessionId);
    if (jc) {
      this.jobChains.delete(sessionId);
      waits.push(jc.catch(() => {}));
    }
    if (waits.length) await Promise.all(waits);
    await fs.promises.rm(sessionDir, { recursive: true, force: true }).catch(() => {});
  }

  /** 清理超过 retentionMs（默认 30 天）的 results/res_*.txt 与 ids/*.json，出错静默忽略 */
  private async cleanupExpired(retentionMs: number, now: () => number): Promise<void> {
    const cutoff = now() - retentionMs;
    const targets: { sub: string; match: RegExp }[] = [
      { sub: 'results', match: /^res_.*\.txt$/ },
      { sub: 'ids', match: /\.json$/ },
    ];
    for (const { sub, match } of targets) {
      const folder = path.join(this.dir, sub);
      let entries: string[];
      try {
        entries = await fs.promises.readdir(folder);
      } catch {
        continue;
      }
      for (const name of entries) {
        if (!match.test(name)) continue;
        const full = path.join(folder, name);
        try {
          const st = await fs.promises.stat(full);
          if (st.isFile() && st.mtimeMs < cutoff) {
            await fs.promises.unlink(full).catch(() => {});
          }
        } catch { /* ignore */ }
      }
    }
  }

  private fileOf(sessionId: unknown, toolUseId: unknown): string | null {
    if (!isSafeId(sessionId) || !isSafeId(toolUseId)) return null;
    return path.join(this.dir, sessionId, `${toolUseId}.jsonl`);
  }

  private rec(sessionId: string, toolUseId: unknown): Rec | null {
    const file = this.fileOf(sessionId, toolUseId);
    if (!file) return null;
    let r = this.recs.get(file);
    if (!r) this.recs.set(file, (r = { file, size: null, msg: null, open: null, chain: Promise.resolve() }));
    return r;
  }

  private openBlock(r: Rec, kind: 'text' | 'thinking', fallbackId: string, init = ''): void {
    const msg = r.msg ?? { id: fallbackId };
    r.open = { id: msg.id, ...(msg.model ? { model: msg.model } : {}), kind, text: init, at: new Date().toISOString() };
  }

  private stream(r: Rec, e: Json): void {
    const ev = e.event;
    if (ev?.type === 'message_start') {
      this.closeBlock(r);
      const model = typeof ev.message?.model === 'string' ? ev.message.model : undefined;
      r.msg = { id: String(ev.message?.id ?? e.api_message_id ?? ''), ...(model ? { model } : {}) };
    } else if (ev?.type === 'content_block_start') {
      const t = ev.content_block?.type;
      if (t === 'text' || t === 'thinking') {
        this.closeBlock(r);
        const init = t === 'thinking'
          ? (typeof ev.content_block?.thinking === 'string' ? ev.content_block.thinking : '')
          : (typeof ev.content_block?.text === 'string' ? ev.content_block.text : '');
        this.openBlock(r, t, String(e.api_message_id ?? ''), init);
      }
    } else if (ev?.type === 'content_block_delta') {
      const d = ev.delta;
      if (d?.type === 'text_delta') {
        if (!r.open && r.msg) this.openBlock(r, 'text', r.msg.id);
        if (r.open?.kind === 'text') r.open.text += String(d.text ?? '');
      } else if (d?.type === 'thinking_delta') {
        if (!r.open && r.msg) this.openBlock(r, 'thinking', r.msg.id);
        if (r.open?.kind === 'thinking') r.open.text += String(d.thinking ?? '');
      }
    } else if (ev?.type === 'content_block_stop') {
      this.closeBlock(r);
    }
  }

  private blockEntry(r: Rec, o: NonNullable<Rec['open']>): Json {
    const block = o.kind === 'thinking' ? { type: 'thinking', thinking: o.text } : { type: 'text', text: o.text };
    return {
      type: 'assistant',
      timestamp: o.at,
      ...(r.effort ? { effort: r.effort } : {}),
      message: { id: o.id, role: 'assistant', ...(o.model ? { model: o.model } : {}), content: [block] },
    };
  }

  private closeBlock(r: Rec): void {
    const o = r.open;
    r.open = null;
    if (o?.text) this.append(r, this.blockEntry(r, o));
  }

  private append(r: Rec, entry: Json): void {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    const bytes = Buffer.byteLength(line);
    r.chain = r.chain
      .then(async () => {
        if (r.size === null) {
          await fs.promises.mkdir(path.dirname(r.file), { recursive: true });
          r.size = await fs.promises.stat(r.file).then((s) => s.size, () => 0);
        }
        if (r.size + bytes > this.maxBytes) return;
        r.size += bytes;
        await fs.promises.appendFile(r.file, line);
      })
      .catch((e) => console.warn('[delegate] 写过程记录失败:', e instanceof Error ? e.message : e));
  }
}
