// Claude 主会话账本采集器（每个主会话 Runner 一个实例）：
// - 主代理（无 parent_tool_use_id）：复用 ClaudeUsageAdapter 消费 stream_event / assistant / result，按 message.id upsert；
// - 原生子代理（带 parent_tool_use_id）：按 parent_tool_use_id 分组记录，layer='native'；
//   子代理结束后（tool_result 或 result 到达），低优先级异步读 subagents/agent-<agentId>.jsonl 补齐最终 output_tokens；
// - 内部调用兜底（layer='internal'）：result 帧里的 model_usage_since_last_result 减去本轮已入账（主 + 原生子代理），
//   差额为正记一条 internal；
//   【防重复计费口径】原生子代理 stdout 不转发 stream_event，result 到达时其已入账 output 可能只是流式初始值、偏小，
//   若此时把纯 output 差额记为 internal，随后子代理 jsonl 异步补齐又会把子代理 output 补大，导致同一批 output 被记两遍。
//   因此：若某模型本轮有原生子代理参与且输入/缓存差额之和为 0（仅 output 有差额），视为子代理输出滞后，不记 internal；
//   只有存在新增输入/缓存（dInput + dCreate + dRead > 0），或该模型本轮无原生子代理且 dOutput > 0 时，才记 internal。
// - 额度快照：rate_limit_event 写订阅快照；Kiro 账号每轮结束触发节流查余额。
//
// 所有公开方法内部均包 try/catch，绝不抛错、绝不阻塞主会话事件流。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { type CachePoint, type LedgerAccountKind, cachePointOf, pushCachePoint } from '@cosyee/shared';
import { ClaudeUsageAdapter } from '../../delegate/usage/claudeUsage.js';
import { isSafeId } from '../../paths.js';
import { parseLine } from '../../transcript.js';
import { recordClaudeRateLimitEvent } from './claudeSnapshots.js';
import { cachePointToRequest, emitLedgerRequest, isObj, posNum, str } from './common.js';

export interface ClaudeSessionCollectorOptions {
  sessionId: string;
  cwd: string;
  account: string;
  accountKind: LedgerAccountKind;
  /** 动态读取当前主会话 effort（例如 runner / settingsCache） */
  getEffort?: () => string | null;
  /** 定位会话所在 projects 子目录（用于异步补齐原生子代理 jsonl） */
  locateSession?: (sessionId: string, cwd: string) => Promise<{ file: string; dir: string } | null>;
  /** Kiro 账号每轮结束回调（内部节流查余额，不 await） */
  onKiroTurnEnd?: (accountId: string) => void;
  /** 测试可替换时间源 */
  now?: () => number;
  /** 原生子代理 jsonl 异步补齐延迟（毫秒），默认 200 */
  subagentBackfillDelayMs?: number;
}

interface SubagentMeta {
  adapter: ClaudeUsageAdapter;
  subagentType: string | null;
  agentId: string | null;
  effort: string | null;
  backfillScheduled: boolean;
}

interface RecordedMsgTotals {
  model: string;
  input: number;
  create: number;
  read: number;
  output: number;
}

const DEFAULT_BACKFILL_DELAY_MS = 200;

/** 读单个原生子代理 jsonl，按 message.id 汇总最终 CachePoint（与 sessions.ts costOfAgent 同口径） */
async function readSubagentPoints(file: string): Promise<CachePoint[]> {
  const points: CachePoint[] = [];
  let anon = 0;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      const e = parseLine(line);
      if (!e || e.type !== 'assistant') continue;
      const msg = e.message;
      if (!isObj(msg) || msg.model === '<synthetic>') continue;
      if (!isObj(msg.usage)) continue;
      const rawId = str(msg.id);
      const target = rawId ? msg : { ...msg, id: `#${anon++}` };
      const pt = cachePointOf(target, 0);
      if (pt) pushCachePoint(points, pt);
    }
  } finally {
    rl.close();
  }
  return points;
}

/** 在 subagents 目录的 agent-*.meta.json 里按 toolUseId 查找 agentId */
async function findAgentIdByMeta(subDir: string, toolUseId: string): Promise<string | null> {
  let names: string[];
  try {
    names = await fs.promises.readdir(subDir);
  } catch {
    return null;
  }
  for (const n of names) {
    const m = /^agent-(.+)\.meta\.json$/.exec(n);
    if (!m || !m[1]) continue;
    try {
      const raw = await fs.promises.readFile(path.join(subDir, n), 'utf8');
      const meta = JSON.parse(raw) as unknown;
      if (isObj(meta) && meta.toolUseId === toolUseId && isSafeId(m[1])) {
        return m[1];
      }
    } catch { /* 忽略坏文件 */ }
  }
  return null;
}

export class ClaudeSessionCollector {
  private readonly mainAdapter = new ClaudeUsageAdapter();
  private readonly subagents = new Map<string, SubagentMeta>();
  /** 本轮已入账的请求（按 message.id 去重，含主代理 + 原生子代理），result 后清空 */
  private readonly turnMessages = new Map<string, RecordedMsgTotals>();
  /** 本轮有原生子代理参与过的模型集合，用于避免将子代理滞后 output 误记为 internal */
  private readonly turnNativeModels = new Set<string>();
  /** 本轮涉及到的原生子代理 toolUseId，result 到达时兜底补齐 */
  private readonly turnSubagents = new Set<string>();
  private internalSeq = 0;
  private disposed = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private readonly backfillDelayMs: number;

  constructor(private readonly opts: ClaudeSessionCollectorOptions) {
    this.now = opts.now ?? Date.now;
    this.backfillDelayMs = opts.subagentBackfillDelayMs ?? DEFAULT_BACKFILL_DELAY_MS;
  }

  /** 观察主会话 Runner 收到的一条事件；同步返回，永不抛错 */
  onEvent(raw: unknown): void {
    try {
      if (this.disposed || !isObj(raw)) return;
      const type = str(raw.type);

      // 1. 额度事件
      if (type === 'rate_limit_event') {
        recordClaudeRateLimitEvent(raw, this.opts.account, this.opts.accountKind, this.now());
        return;
      }

      // 2. Cosyee 注入的 agent_params（记录原生子代理的实际 effort / model）
      if (type === 'system' && raw.subtype === 'agent_params') {
        const tid = str(raw.tool_use_id);
        if (tid) {
          const sub = this.ensureSubagent(tid);
          const eff = str(raw.effort);
          if (eff) sub.effort = eff;
        }
        return;
      }

      // 3. 原生子代理事件（带 parent_tool_use_id）
      const parentToolUseId = str(raw.parent_tool_use_id);
      if (parentToolUseId) {
        // 忽略 Cosyee 委派注入的合成事件（委派由 jobs.ts 独立采集）
        if (type === 'system' && raw.subtype === 'cosyee_usage') return;
        this.onSubagentEvent(parentToolUseId, raw);
        return;
      }

      // 4. 主代理 assistant 帧里启动原生子代理的 Agent/Task tool_use
      if (type === 'assistant') {
        this.inspectMainAssistantTools(raw.message);
      }

      // 5. 主代理 user 帧里 tool_result 到达：若命中原生子代理，记录 agentId 并调度 jsonl 补齐
      if (type === 'user') {
        this.inspectMainUserToolResults(raw);
      }

      // 6. 主代理用量采集（system/init、stream_event、assistant、result）
      if (type === 'system' || type === 'stream_event' || type === 'assistant' || type === 'result') {
        const points = this.mainAdapter.push(raw);
        if (points.length) {
          const at = this.now();
          const effort = this.opts.getEffort?.() ?? null;
          for (const pt of points) {
            this.recordPoint(pt, {
              at,
              layer: 'main',
              agent: null,
              toolUseId: null,
              effort,
            });
          }
        }
      }

      // 7. result 帧：计算 internal 差额、兜底调度子代理补齐、Kiro 余额触发
      if (type === 'result') {
        this.onResult(raw);
      }
    } catch { /* 绝不影响正常请求 */ }
  }

  /** 进程退出时清理未触发的定时器 */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private ensureSubagent(toolUseId: string): SubagentMeta {
    let sub = this.subagents.get(toolUseId);
    if (!sub) {
      sub = {
        adapter: new ClaudeUsageAdapter(),
        subagentType: null,
        agentId: null,
        effort: null,
        backfillScheduled: false,
      };
      this.subagents.set(toolUseId, sub);
    }
    return sub;
  }

  private inspectMainAssistantTools(message: unknown): void {
    if (!isObj(message) || !Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (!isObj(block) || block.type !== 'tool_use') continue;
      const name = str(block.name);
      if (name !== 'Agent' && name !== 'Task') continue;
      const tid = str(block.id);
      if (!tid) continue;
      const sub = this.ensureSubagent(tid);
      if (isObj(block.input)) {
        const st = str(block.input.subagent_type);
        if (st) sub.subagentType = st;
        const eff = str(block.input.effort);
        if (eff && !sub.effort) sub.effort = eff;
      }
    }
  }

  private inspectMainUserToolResults(raw: Record<string, unknown>): void {
    const msg = raw.message;
    if (!isObj(msg) || !Array.isArray(msg.content)) return;
    const toolUseResult = isObj(raw.toolUseResult) ? raw.toolUseResult : null;
    const resultAgentId = toolUseResult ? str(toolUseResult.agentId) : '';
    for (const block of msg.content) {
      if (!isObj(block) || block.type !== 'tool_result') continue;
      const tid = str(block.tool_use_id);
      if (!tid) continue;
      const sub = this.subagents.get(tid);
      if (!sub) continue;
      if (resultAgentId && !sub.agentId) sub.agentId = resultAgentId;
      this.scheduleSubagentBackfill(tid, sub);
    }
  }

  private onSubagentEvent(parentToolUseId: string, raw: Record<string, unknown>): void {
    const sub = this.ensureSubagent(parentToolUseId);
    const st = str(raw.subagent_type);
    if (st) sub.subagentType = st;
    const aid = str(raw.agent_id);
    if (aid) sub.agentId = aid;
    this.turnSubagents.add(parentToolUseId);

    const points = sub.adapter.push(raw);
    if (!points.length) return;
    const at = this.now();
    for (const pt of points) {
      if (pt.model) this.turnNativeModels.add(pt.model);
      this.recordPoint(pt, {
        at,
        layer: 'native',
        agent: sub.subagentType,
        toolUseId: parentToolUseId,
        effort: sub.effort,
      });
    }
  }

  private recordPoint(
    pt: CachePoint,
    meta: { at: number; layer: 'main' | 'native'; agent: string | null; toolUseId: string | null; effort: string | null },
  ): void {
    const req = cachePointToRequest(pt, {
      backend: 'claude',
      id: pt.id,
      at: meta.at,
      account: this.opts.account,
      accountKind: this.opts.accountKind,
      session: this.opts.sessionId,
      layer: meta.layer,
      agent: meta.agent,
      toolUseId: meta.toolUseId,
      effort: meta.effort,
    });
    emitLedgerRequest(req);

    // 按 message.id 跟踪本轮已入账最大值，用于 result 帧计算 internal 差额
    if (req.model) {
      const prev = this.turnMessages.get(pt.id);
      this.turnMessages.set(pt.id, {
        model: req.model,
        input: Math.max(prev?.input ?? 0, req.input),
        create: Math.max(prev?.create ?? 0, req.create5m + req.create1h),
        read: Math.max(prev?.read ?? 0, req.read),
        output: Math.max(prev?.output ?? 0, req.output),
      });
    }
  }

  private onResult(raw: Record<string, unknown>): void {
    // 1. 计算 model_usage_since_last_result 的 internal 差额
    const delta = raw.model_usage_since_last_result;
    if (isObj(delta)) {
      const recordedByModel = new Map<string, { input: number; create: number; read: number; output: number }>();
      for (const m of this.turnMessages.values()) {
        const cur = recordedByModel.get(m.model) ?? { input: 0, create: 0, read: 0, output: 0 };
        cur.input += m.input;
        cur.create += m.create;
        cur.read += m.read;
        cur.output += m.output;
        recordedByModel.set(m.model, cur);
      }

      const entries = Object.entries(delta).filter(([model, v]) => model && !model.startsWith('<') && isObj(v));
      const resultTag = str(raw.uuid) || String(++this.internalSeq);
      const at = this.now();

      for (const [model, v] of entries) {
        if (!isObj(v)) continue;
        const totInput = posNum(v.inputTokens ?? v.input_tokens);
        const totCreate = posNum(v.cacheCreationInputTokens ?? v.cache_creation_input_tokens);
        const totRead = posNum(v.cacheReadInputTokens ?? v.cache_read_input_tokens);
        const totOutput = posNum(v.outputTokens ?? v.output_tokens);

        const rec = recordedByModel.get(model) ?? { input: 0, create: 0, read: 0, output: 0 };
        const dInput = Math.max(0, totInput - rec.input);
        const dCreate = Math.max(0, totCreate - rec.create);
        const dRead = Math.max(0, totRead - rec.read);
        const dOutput = Math.max(0, totOutput - rec.output);

        const hasInputDiff = dInput + dCreate + dRead > 0;
        const hasOutputDiff = dOutput > 0;
        if (!hasInputDiff && !hasOutputDiff) continue;
        // 若本轮该模型有原生子代理且无新增输入/缓存，纯 output 差额大概率属于子代理流式滞后，留给 jsonl 异步补齐
        if (!hasInputDiff && this.turnNativeModels.has(model)) continue;

        const id = entries.length > 1
          ? `${this.opts.sessionId}:internal:${resultTag}:${model}`
          : `${this.opts.sessionId}:internal:${resultTag}`;

        emitLedgerRequest({
          backend: 'claude',
          id,
          at,
          account: this.opts.account,
          accountKind: this.opts.accountKind,
          session: this.opts.sessionId,
          layer: 'internal',
          agent: null,
          toolUseId: null,
          model,
          effort: null,
          input: dInput,
          create5m: dCreate,
          create1h: 0,
          read: dRead,
          output: dOutput,
          reasoning: 0,
          fast: false,
          usGeo: false,
          estimated: false,
        });
      }
    }

    // 2. 对本轮出现过但尚未调度补齐的原生子代理做一次兜底调度
    for (const tid of this.turnSubagents) {
      const sub = this.subagents.get(tid);
      if (sub) this.scheduleSubagentBackfill(tid, sub);
    }

    // 3. 清空本轮追踪状态，准备下一轮
    this.turnMessages.clear();
    this.turnNativeModels.clear();
    this.turnSubagents.clear();

    // 4. Kiro 账号每轮结束触发节流查余额
    if (this.opts.accountKind === 'kiro') {
      try {
        this.opts.onKiroTurnEnd?.(this.opts.account);
      } catch { /* ignore */ }
    }
  }

  private scheduleSubagentBackfill(toolUseId: string, sub: SubagentMeta): void {
    if (this.disposed || sub.backfillScheduled || !this.opts.locateSession) return;
    sub.backfillScheduled = true;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.disposed) return;
      void this.backfillSubagent(toolUseId, sub).catch(() => {});
    }, this.backfillDelayMs);
    timer.unref?.();
    this.timers.add(timer);
  }

  private async backfillSubagent(toolUseId: string, sub: SubagentMeta): Promise<void> {
    if (!this.opts.locateSession) return;
    const loc = await this.opts.locateSession(this.opts.sessionId, this.opts.cwd);
    if (!loc) return;
    const subDir = path.join(loc.dir, this.opts.sessionId, 'subagents');
    let agentId = sub.agentId;
    if (!agentId) {
      agentId = await findAgentIdByMeta(subDir, toolUseId);
      if (agentId) sub.agentId = agentId;
    }
    if (!agentId || !isSafeId(agentId)) return;

    const file = path.join(subDir, `agent-${agentId}.jsonl`);
    let points: CachePoint[];
    try {
      points = await readSubagentPoints(file);
    } catch {
      return;
    }
    if (!points.length) return;
    const at = this.now();
    for (const pt of points) {
      const req = cachePointToRequest(pt, {
        backend: 'claude',
        id: pt.id,
        at,
        account: this.opts.account,
        accountKind: this.opts.accountKind,
        session: this.opts.sessionId,
        layer: 'native',
        agent: sub.subagentType,
        toolUseId,
        effort: sub.effort,
      });
      emitLedgerRequest(req);
    }
  }
}
