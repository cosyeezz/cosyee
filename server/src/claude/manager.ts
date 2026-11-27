// 会话进程管理 + WebSocket 订阅分发。一个会话一个 Runner；订阅者按会话分组。
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SUBAGENTS,
  type DelegateNotification,
  type ModelAlias,
  type SubagentAvailability,
  type SubagentConfig,
  type SubagentKind,
  type SubagentState,
  formatDelegateNotification,
  hasModelMapping,
} from '@cosyee/shared';
import type { AppliedSettings, ClientMsg, ContextUsage, QueueMode, ServerMsg, SessionConfig, SkillMode, StopInfo, StopKind } from '@cosyee/shared';
import { readApiConfig } from '../accounts/api-config.js';
import { skillBase, toContextUsage } from '../context.js';
import { TranscriptToolLoadCache } from '../toolLoad.js';
import { listAllAgents, toSubagentTypeInfo } from '../delegate/agents.js';
import type { DelegateBackend } from '../delegate/backend.js';
import { DelegateJobs } from '../delegate/jobs.js';
import { DELEGATE_AUX_TOOL_NAMES, DELEGATE_TOOL_NAME } from '../delegate/mcp.js';
import type { DelegateRecorder } from '../delegate/record.js';
import { baseClaudeHome, claudeJsonPath, cosyeeHome, isSafeId, isSessionUuid, normalizeDir } from '../paths.js';
import type { Pins } from '../pins.js';
import type { Sessions } from '../sessions.js';
import { type DiskSkill, listDiskAgentDescriptions, listDiskSkills, listSyncedSkills, readSkillContent, removeDiskSkill, skillDescription } from '../skillsDisk.js';
import { type MentionedSkill, appendSkills, stripSkillBlock } from '../skillMention.js';
import type { DotState } from '../state.js';
import { MAX_AUTO_RETRIES, RATE_LIMIT_BUFFER_MS, RATE_LIMIT_FALLBACK_MS, type StopStore, transientRetryDelay } from '../stops.js';
import { HttpError, TOOL_NAME_RE } from '../workspaces.js';
import { AutoTitle } from './autotitle.js';
import { type AgentDefaults, Runner, type RunnerStopInfo, type RunnerTimings, validateConfig } from './runner.js';

/** 一个 WebSocket 连接的抽象，便于测试。 */
export interface Client {
  send(msg: ServerMsg): void;
}

export interface ManagerOptions {
  dots: DotState;
  sessions: Sessions;
  /** 置顶：会话开始 / 停止执行时自动置顶、顺延到期时间；不传则不做自动置顶（旧测试） */
  pins?: Pins;
  /** 会话因错误停止的记录与自动重试存储；不传则关闭该功能（旧测试） */
  stops?: StopStore;
  /** 自动重试轮询间隔（毫秒），默认 60 秒；测试可覆盖 */
  retryPollMs?: number;
  /** 当前时间函数（测试可注入），默认 Date.now */
  now?: () => number;
  timings?: Partial<RunnerTimings>;
  claudePath?: string;
  /** skill 状态的存取（全局，Cosyee 自己保存）；不传则不下发 skillOverrides（旧测试） */
  skills?: SkillStore;
  /** 已停用的内置工具名单的存取（全局）；不传则不下发 permissions.deny（旧测试） */
  tools?: ToolStore;
  /** 自动压缩窗口的存取（全局，null = 不覆盖）；不传则不下发（旧测试） */
  compactWindow?: CompactWindowStore;
  /** 子代理配置（类型与各后端默认模型 / 强度）的存取（全局）；不传则使用默认配置（旧测试） */
  subagents?: SubagentStore;
  /** 多账号：会话用哪个账号启动；不传则沿用当前账号（旧测试） */
  accounts?: SessionAccounts;
  /** 每个会话最近一次使用的配置（模型 / 强度）的存取；不传则不记录（旧测试） */
  configs?: SessionConfigStore;
  /** 分支关系（新会话 ← 来源会话）的记录；不传则不记录（旧测试），分支仍可用，只是分支点之前的子代理面板打不开 */
  forks?: ForkStore;
  /** 委派执行过程的落盘；不传则不记（旧测试） */
  delegateRecord?: DelegateRecorder;
  /** 委派后端集合（claude / agy）；不传则由 runner 用默认单例（旧测试） */
  delegateBackends?: Partial<Record<'claude' | 'agy', DelegateBackend>>;
  /** Cosyee 生成的 Claude 插件目录（内置浏览器的 skill），每次启动时读取；返回 null 不带（旧测试） */
  pluginDir?: () => string | null;
}

export interface ForkStore {
  set(sessionId: string, cwd: string, src: string): void;
}

export interface SessionConfigStore {
  get(sessionId: string): SessionConfig | null;
  set(sessionId: string, config: SessionConfig): void;
}

export interface SessionAccounts {
  /** 会话应当用哪个账号启动进程（dir 为 null = 默认账号） */
  resolve(sessionId: string): { id: string; dir: string | null };
  /** 当前活跃主代理账号的配置目录（null = 默认账号）；用于无会话上下文的接口（如 GET /api/subagents） */
  activeDir?(): string | null;
  /** 该账号还没有 claude 进程、即将启动第一个时调用（回写子代理刷新后的凭据、补共享链接、同步 MCP 配置） */
  prepare(accountId: string): void;
  /** 每次启动该账号的主代理进程前，把子代理空间较新的凭据同步回主空间（失败静默不阻断） */
  syncFromSubagent?(accountId: string): void;
  /** 会话发出了消息：记下它用的账号 */
  bind(sessionId: string, accountId: string): void;
}

export interface CompactWindowStore {
  get(): number | null;
  set(window: number | null): void;
}

export interface SubagentStore {
  get(): SubagentConfig;
  set(config: SubagentConfig): void;
}

export interface ToolStore {
  /** 当前已停用的工具名 */
  get(): string[];
  /** 整体替换（调用方保证名字已校验、去重） */
  set(names: string[]): void;
  /** 最近一次 init 报告的内置工具名（落盘；探测进程收不到 init 时用它） */
  known?(): string[];
  setKnown?(names: string[]): void;
  /** 最近一次从会话记录观测到的懒加载工具名（落盘；新会话 / 已停用工具兜底用） */
  knownDeferred?(): string[];
  setKnownDeferred?(names: string[]): void;
  /** 已关闭的智能体名（全局）；以 Agent(名字) 并入 permissions.deny */
  agents?(): string[];
  setAgents?(names: string[]): void;
}

export interface SkillStore {
  get(): Record<string, SkillMode>;
  set(name: string, mode: SkillMode): void;
  /** 一次设置多个（只落盘一次） */
  setMany(modes: Record<string, SkillMode>): void;
  /** 删掉某个 skill 的已存状态（skill 被移除后不再留条目） */
  remove(name: string): void;
}

/** MCP 服务器还在连接（pending）时，隔多久再采一次上下文、最多几次 */
/** 官方的 agent-browser skill：默认关掉，由 Cosyee 的 cosyee:browser 作为内置浏览器的唯一入口（用户在面板里设过就按用户的） */
const OFFICIAL_BROWSER_SKILL = 'agent-browser';
const MCP_PENDING_RETRY_MS = 3000;
const MCP_PENDING_RETRIES = 5;

const TITLE_MAX_INPUT = 500;
/** 回合进行中，上下文用量的最小刷新间隔（毫秒）；节流 + 单飞，避免每条消息都打一次 get_context_usage */
const CONTEXT_LIVE_MS = 3000;
/** delegate.send 的消息长度上限 */
const DELEGATE_SEND_MAX = 100_000;
/** 自动重试轮询默认间隔（毫秒） */
const DEFAULT_RETRY_POLL_MS = 60_000;

/** 根据错误类型构造重试消息文案 */
export function retryPromptText(kind: StopKind): string {
  switch (kind) {
    case 'rate_limit':
      return '【自动重试】上一次请求因额度用尽中断，现已恢复。请从中断处继续，不要重复已完成的步骤。';
    case 'transient':
      return '【自动重试】上一次请求因网络或服务异常中断。请从中断处继续，不要重复已完成的步骤。';
    case 'fatal':
      return '【重试】上一次请求出错中断，请从中断处继续，不要重复已完成的步骤。';
    case 'interrupted':
      return '【重试】上一次请求因服务重启中断，请从中断处继续，不要重复已完成的步骤。';
  }
}

/** initialize 响应里的描述原文：commands（skill 与斜杠命令）与 agents（含内置） */
interface InitDescs {
  commands: [string, string][];
  /** initialize 响应里全部命令名（不含 description 的也保留，供未收到 system/init 时 `/` 菜单兜底） */
  commandNames: string[];
  agents: [string, string][];
}

/** CLI 在 commands 描述末尾追加的来源标记（不在系统提示词里） */
const SOURCE_TAG = /\s+\((?:user|project|plugin|bundled|managed|built-in)\)$/;

function pairs(list: unknown, strip: boolean): [string, string][] {
  const out: [string, string][] = [];
  for (const x of Array.isArray(list) ? list : []) {
    const o = x as { name?: unknown; description?: unknown } | null;
    if (typeof o?.name !== 'string' || typeof o.description !== 'string') continue;
    const d = (strip ? o.description.replace(SOURCE_TAG, '') : o.description).trim();
    if (o.name && d) out.push([o.name, d]);
  }
  return out;
}

function commandNamesOf(list: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of Array.isArray(list) ? list : []) {
    const name = typeof x === 'string' ? x : typeof (x as { name?: unknown } | null)?.name === 'string' ? (x as { name: string }).name : '';
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

/** 取 runner 的 initialize 响应；最多等 3 秒（不拖慢上下文采集），拿不到为 null */
async function initInfoOf(r: Runner): Promise<InitDescs | null> {
  if (typeof r.initInfo !== 'function') return null;
  let timer: NodeJS.Timeout | undefined;
  const raw = await Promise.race([
    r.initInfo().catch(() => null),
    new Promise<null>((res) => { timer = setTimeout(() => res(null), 3000); timer.unref?.(); }),
  ]);
  clearTimeout(timer);
  if (!raw) return null;
  return { commands: pairs(raw.commands, true), commandNames: commandNamesOf(raw.commands), agents: pairs(raw.agents, false) };
}

export class Manager {
  private runners = new Map<string, Runner>();
  private clients = new Set<Client>();
  private subs = new Map<string, Set<Client>>();
  private settingsCache = new Map<string, AppliedSettings>();
  private contextCache = new Map<string, ContextUsage>();
  private cwdOf = new Map<string, string>();
  private probing = new Map<string, Promise<ContextUsage | null>>();
  /** 回合进行中的上下文刷新节流状态（按会话） */
  private ctxLive = new Map<string, { timer: NodeJS.Timeout | null; last: number; busy: boolean }>();
  private readonly dots: DotState;
  private readonly sessions: Sessions;
  private readonly pins?: Pins;
  private readonly stops?: StopStore;
  private readonly retryPollMs: number;
  private readonly now: () => number;
  private readonly timings?: Partial<RunnerTimings>;
  private readonly claudePath?: string;
  private readonly skills?: SkillStore;
  private readonly tools?: ToolStore;
  private readonly compactWindow?: CompactWindowStore;
  private readonly subagents?: SubagentStore;
  private readonly accounts?: SessionAccounts;
  private readonly configs?: SessionConfigStore;
  private readonly forks?: ForkStore;
  /** 会话最近一次 system/init 的 skills（带插件前缀），另按 cwd 存一份给探测进程（探测进程不发消息，收不到 init） */
  private initSkills = new Map<string, string[]>();
  private initSkillsByCwd = new Map<string, string[]>();
  /** 会话最近一次 system/init 的 slash_commands，同样按 cwd 留一份给探测进程 */
  private initSlash = new Map<string, string[]>();
  private initSlashByCwd = new Map<string, string[]>();
  /** 会话最近一次 system/init 的内置工具名 */
  private initTools = new Map<string, string[]>();
  /** 会话记录增量解析缓存（按文件 size + mtime 缓存工具加载方式与实时权重） */
  private toolLoadCache = new TranscriptToolLoadCache();
  /** MCP pending 重采：按会话的计时器与已重试次数 */
  private mcpRetry = new Map<string, { timer: NodeJS.Timeout | null; n: number }>();
  /** 会话的委派任务表（后台任务）：独立于 claude 进程，进程被空闲回收 / 重启后任务继续 */
  private delegateJobs = new Map<string, DelegateJobs>();
  /** 正在补发待送达委派通知的会话 id，避免并发重复投递 */
  private flushing = new Set<string>();
  /** 正在执行重试发送的会话 id，避免轮询与手动重试并发重复触发 */
  private retrying = new Set<string>();
  private retryTimer: NodeJS.Timeout | null = null;
  private unsubStops: (() => void) | null = null;
  private shuttingDown = false;
  /** permissions.deny 下发串行链：防止并发调用导致 apply_flag_settings 与 contextCache 乱序覆盖 */
  private denyChain: Promise<void> = Promise.resolve();
  /** 没有标题的会话：首条消息被接收后立即让 CLI 生成一个（每轮结束时再兜底重试） */
  private readonly autoTitle: AutoTitle;

  private readonly delegateRecord: DelegateRecorder | undefined;
  private readonly delegateBackends: Partial<Record<'claude' | 'agy', DelegateBackend>> | undefined;
  private readonly pluginDir: (() => string | null) | undefined;

  constructor(opts: ManagerOptions) {
    this.dots = opts.dots;
    this.sessions = opts.sessions;
    this.pins = opts.pins;
    this.stops = opts.stops;
    this.retryPollMs = opts.retryPollMs ?? DEFAULT_RETRY_POLL_MS;
    this.now = opts.now ?? Date.now;
    this.timings = opts.timings;
    this.claudePath = opts.claudePath;
    this.skills = opts.skills;
    this.tools = opts.tools;
    this.compactWindow = opts.compactWindow;
    this.subagents = opts.subagents;
    this.accounts = opts.accounts;
    this.configs = opts.configs;
    this.forks = opts.forks;
    this.delegateRecord = opts.delegateRecord;
    this.delegateBackends = opts.delegateBackends;
    this.pluginDir = opts.pluginDir;
    this.autoTitle = new AutoTitle({
      hasTitle: async (id, cwd) => {
        const s = await this.sessions.scan(id, cwd);
        return s ? !!(s.userTitle || s.customTitle || s.agentName || s.aiTitle) : null;
      },
      firstPrompt: async (id, cwd) => (await this.sessions.scan(id, cwd))?.firstPrompt,
      onTitled: (_id, cwd) => {
        // CLI 写 ai-title 是异步追加，稍后再通知一次，保证列表读到新标题
        this.changed(cwd);
        setTimeout(() => this.changed(cwd), 800).unref();
      },
    });
    if (this.stops) {
      this.unsubStops = this.stops.onChange((id, info) => this.emit(id, { t: 'stop', sessionId: id, info }));
      this.startRetryPoller();
    }
    this.recoverInterrupted();
  }

  // ───────────── 连接与订阅 ─────────────

  addClient(c: Client): void {
    this.clients.add(c);
  }

  removeClient(c: Client): void {
    this.clients.delete(c);
    for (const [id, set] of this.subs) {
      set.delete(c);
      if (set.size === 0) this.subs.delete(id);
    }
  }

  private broadcast(m: ServerMsg): void {
    for (const c of this.clients) this.safeSend(c, m);
  }

  private emit(sessionId: string, m: ServerMsg): void {
    const set = this.subs.get(sessionId);
    if (set) for (const c of set) this.safeSend(c, m);
  }

  private safeSend(c: Client, m: ServerMsg): void {
    try {
      c.send(m);
    } catch { /* 连接已断，由 removeClient 清理 */ }
  }

  private changed(cwd: string): void {
    this.broadcast({ t: 'sessions.changed', cwd });
  }

  /** 置顶 / 已删除集合变了（手动置顶、删除、恢复、自动置顶到期）：通知所有前端重取侧栏数据 */
  notifySidebar(): void {
    this.broadcast({ t: 'sidebar.changed' });
  }

  hasSubscribers(sessionId: string): boolean {
    return (this.subs.get(sessionId)?.size ?? 0) > 0;
  }

  /** 处理客户端消息；非法消息回 error，不抛出。 */
  handle(client: Client, msg: ClientMsg): void {
    try {
      switch (msg?.t) {
        case 'subscribe':
          this.requireId(msg.sessionId);
          void this.subscribe(client, msg.sessionId);
          break;
        case 'unsubscribe': {
          const set = this.subs.get(msg.sessionId);
          set?.delete(client);
          if (set && set.size === 0) this.subs.delete(msg.sessionId);
          break;
        }
        case 'send':
          this.send(client, msg);
          break;
        case 'interrupt':
          this.requireId(msg.sessionId);
          this.runners.get(msg.sessionId)?.interrupt();
          break;
        case 'config':
          this.requireId(msg.sessionId);
          validateConfig(msg.config);
          this.configs?.set(msg.sessionId, msg.config); // 没有进程时也要记下：刷新页面后据此还原
          this.runners.get(msg.sessionId)?.setConfig(msg.config);
          break;
        case 'queue.cancel':
          this.requireId(msg.sessionId);
          this.requireMsgId(msg.id);
          void this.queueCancel(client, msg.sessionId, msg.id);
          break;
        case 'queue.sendNow':
          this.requireId(msg.sessionId);
          this.requireMsgId(msg.id);
          void this.queueSendNow(client, msg.sessionId, msg.id);
          break;
        case 'rewind':
          void this.rewind(client, msg);
          break;
        case 'prompt.reply':
          this.promptReply(msg);
          break;
        case 'delegate.stop':
          this.requireId(msg.sessionId);
          if (typeof msg.toolUseId !== 'string' || !msg.toolUseId) throw new Error('toolUseId 不合法');
          this.delegateJobs.get(msg.sessionId)?.stopByToolUse(msg.toolUseId);
          break;
        case 'delegate.send':
          this.requireId(msg.sessionId);
          if (typeof msg.toolUseId !== 'string' || !msg.toolUseId) throw new Error('toolUseId 不合法');
          if (typeof msg.text !== 'string' || msg.text.trim() === '' || msg.text.length > DELEGATE_SEND_MAX) throw new Error('消息不合法');
          if (msg.mode !== undefined && msg.mode !== 'steer' && msg.mode !== 'queue') throw new Error('mode 不合法');
          this.delegateJobs.get(msg.sessionId)?.sendByToolUse(msg.toolUseId, msg.text, msg.mode);
          break;
        case 'retry.now':
          this.requireId(msg.sessionId);
          void this.retryNow(client, msg.sessionId);
          break;
        case 'retry.cancel':
          this.requireId(msg.sessionId);
          this.retryCancel(msg.sessionId);
          break;
        default:
          throw new Error('未知消息类型');
      }
    } catch (e) {
      this.safeSend(client, { t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  private requireId(id: unknown): asserts id is string {
    if (!isSafeId(id)) throw new Error('sessionId 不合法');
  }

  /** 消息 id 必须是 UUID（CLI 要求 user 消息的 uuid 为 UUID 格式） */
  private requireMsgId(id: unknown): asserts id is string {
    if (!isSessionUuid(id)) throw new Error('消息 id 不合法');
  }

  /** 回应 AskUserQuestion / ExitPlanMode。请求已不存在（被取消 / 已回应）时静默忽略 */
  private promptReply(msg: Extract<ClientMsg, { t: 'prompt.reply' }>): void {
    this.requireId(msg.sessionId);
    if (typeof msg.id !== 'string' || !msg.id) throw new Error('请求 id 不合法');
    const rp = msg.reply as unknown as Record<string, unknown> | null;
    if (!rp || typeof rp !== 'object') throw new Error('回应不合法');
    switch (rp.kind) {
      case 'answer': {
        const a = rp.answers as Record<string, unknown> | null;
        if (!a || typeof a !== 'object' || Array.isArray(a) || !Object.values(a).every((v) => typeof v === 'string')) {
          throw new Error('answers 不合法');
        }
        break;
      }
      case 'revise':
        if (typeof rp.feedback !== 'string') throw new Error('feedback 不合法');
        break;
      case 'skip':
      case 'approve':
        break;
      default:
        throw new Error('回应类型不合法');
    }
    const ok = this.runners.get(msg.sessionId)?.reply(msg.id, msg.reply);
    if (ok && msg.reply.kind === 'approve') {
      // 批准计划后会话已切到 auto：记下，刷新页面后据此还原
      const cur = this.configs?.get(msg.sessionId);
      if (cur) this.configs?.set(msg.sessionId, { ...cur, permissionMode: 'auto' });
    }
  }

  private async subscribe(client: Client, id: string): Promise<void> {
    let set = this.subs.get(id);
    if (!set) this.subs.set(id, (set = new Set()));
    set.add(client);

    // 已查看：清除蓝点
    if (this.dots.viewed(id)) {
      const cwd = this.cwdOf.get(id) ?? (await this.sessions.findCwd(id));
      if (cwd) this.changed(cwd);
    }

    const r = this.runners.get(id);
    const status = r ? r.status : 'idle';
    this.safeSend(client, { t: 'status', sessionId: id, status });
    // 停止记录快照（紧跟 status；没有记录发 null）
    this.safeSend(client, { t: 'stop', sessionId: id, info: this.stops?.get(id) ?? null });
    if (r) {
      const snap = r.snapshot();
      if (snap.events.length > 0) this.safeSend(client, { t: 'replay', sessionId: id, events: snap.events, status: snap.status });
    }
    // 排队消息快照（紧跟 replay；没有排队也发空数组，前端据此清掉旧状态）
    this.safeSend(client, { t: 'queue', sessionId: id, items: r ? r.queueItems() : [] });
    // 待回应请求快照（同上，空数组也发）
    this.safeSend(client, { t: 'prompts', sessionId: id, items: r ? r.promptItems() : [] });
    // 委派任务快照（同上，空数组也发；有落盘记录时一并恢复展示）
    this.safeSend(client, { t: 'delegates', sessionId: id, jobs: this.peekJobs(id)?.list() ?? [] });
    const st = this.settingsCache.get(id);
    if (st) this.safeSend(client, { t: 'settings', sessionId: id, applied: st });
    const ctx = this.contextCache.get(id);
    if (ctx) this.safeSend(client, { t: 'context', sessionId: id, usage: ctx });
  }

  // ───────────── 发送 ─────────────

  private send(client: Client, msg: Extract<ClientMsg, { t: 'send' }>): void {
    this.requireId(msg.sessionId);
    if (typeof msg.cwd !== 'string' || !msg.cwd) throw new Error('cwd 不能为空');
    if (typeof msg.text !== 'string' || msg.text.trim() === '') throw new Error('消息不能为空');
    validateConfig(msg.config);
    if (msg.id !== undefined) this.requireMsgId(msg.id); // 没带 id 的旧客户端：runner 自己生成
    const id = msg.sessionId;
    const cwd = normalizeDir(msg.cwd);

    // 发送者自动订阅，保证收到本轮事件
    let set = this.subs.get(id);
    if (!set) this.subs.set(id, (set = new Set()));
    set.add(client);

    // 用户手动发送消息：清除之前的错误停止记录
    this.stops?.clear(id);
    this.sendInternal(id, cwd, msg.text, msg.config, { isNew: !!msg.isNew, msgId: msg.id, mode: msg.mode });
    this.dots.viewed(id);
  }

  /**
   * 内部发送入口（用户 send 与自动/手动重试共用）：不清除 stops、不修改订阅关系。
   * 走正常的 r.send() 路径，会发出 cosyee_user 事件。
   */
  private sendInternal(
    id: string,
    cwd: string,
    text: string,
    config: SessionConfig,
    opts: { isNew?: boolean; msgId?: string; mode?: QueueMode } = {},
  ): void {
    let r = this.runners.get(id);
    // 并行模式：空闲的进程不是这个会话现在该用的账号（例如新会话草稿的探测进程启动后换了账号）→ 换一个进程
    if (r && this.accounts && r.status === 'idle' && r.accountId !== this.accounts.resolve(id).id) {
      const old = r;
      this.runners.delete(id);
      old.shutdown(2000);
      r = undefined;
    }
    const created = !r;
    if (!r) {
      r = this.createRunner(id, cwd, !!opts.isNew, config, false);
      this.runners.set(id, r);
    }
    try {
      r.send(text, config, opts.msgId, opts.mode);
    } catch (e) {
      if (created && !r.alive) this.runners.delete(id);
      throw e;
    }
    this.configs?.set(id, config);
    this.cwdOf.set(id, r.cwd);
    if (this.accounts && r.accountId) this.accounts.bind(id, r.accountId);
    this.changed(r.cwd);
    // 进程刚因发送而就绪（新建或探测转正）：补发待送达的委派通知（含重启恢复的中断通知）
    void this.flushPending(id, { allowSpawn: false });
  }

  // ───────────── 排队消息 / 回退 ─────────────

  /** 撤回一条排队消息：结果只回给发起的连接（text 是原文，前端填回输入框） */
  private async queueCancel(client: Client, sessionId: string, id: string): Promise<void> {
    const r = this.runners.get(sessionId);
    let res: { ok: boolean; text?: string } = { ok: false };
    if (r?.alive) {
      try {
        res = await r.cancelQueued(id);
      } catch { /* 进程退出 / 超时：按失败回复 */ }
    }
    const m: ServerMsg = { t: 'queue.cancelled', sessionId, id, ok: res.ok };
    if (res.ok && res.text !== undefined) m.text = res.text;
    this.safeSend(client, m);
  }

  /** 立即发送一条排队消息：中断当前轮并马上执行它。失败（已不在排队）时重发一次队列快照让前端对齐 */
  private async queueSendNow(client: Client, sessionId: string, id: string): Promise<void> {
    const r = this.runners.get(sessionId);
    try {
      if (!r?.alive) throw new Error('会话没有在运行');
      const res = await r.sendNow(id);
      if (res.ok) return;
    } catch (e) {
      this.safeSend(client, { t: 'error', message: `立即发送失败：${e instanceof Error ? e.message : String(e)}` });
    }
    this.safeSend(client, { t: 'queue', sessionId, items: r ? r.queueItems() : [] });
  }

  /**
   * 回退到某条用户消息。没有进程时用 --resume 拉起一个不发消息的探测进程（CLI 在收到第一条消息前就能响应
   * control_request，runner 启动时的 get_settings 就是这样发的），回退后它按探测进程的规则空闲回收，
   * 之后发消息时直接复用。结果只回给发起的连接。
   */
  private async rewind(client: Client, msg: Extract<ClientMsg, { t: 'rewind' }>): Promise<void> {
    const reply = (ok: boolean, extra: { prefillText?: string; error?: string } = {}): void => {
      const m: ServerMsg = { t: 'rewind.result', sessionId: String(msg?.sessionId), reqId: String(msg?.reqId), targetId: String(msg?.targetId), ok };
      if (extra.prefillText !== undefined) m.prefillText = extra.prefillText;
      if (extra.error !== undefined) m.error = extra.error;
      this.safeSend(client, m);
    };
    try {
      this.requireId(msg.sessionId);
      this.requireMsgId(msg.targetId);
      if (typeof msg.reqId !== 'string' || !msg.reqId) throw new Error('reqId 不能为空');
      const id = msg.sessionId;
      let r = this.runners.get(id);
      if (r && !r.alive) throw new Error('claude 进程正在关闭，请稍后重试');
      if (!r) {
        if (typeof msg.cwd !== 'string' || !msg.cwd) throw new Error('cwd 不能为空');
        validateConfig(msg.config);
        const cwd = normalizeDir(msg.cwd);
        r = this.createRunner(id, cwd, false, msg.config, true);
        this.runners.set(id, r);
        try {
          r.start();
        } catch (e) {
          if (this.runners.get(id) === r) this.runners.delete(id);
          throw e;
        }
        this.cwdOf.set(id, cwd);
      }
      const res = await r.rewind(msg.targetId);
      if (res.rewound === true) {
        this.stops?.clear(id);
        reply(true, { prefillText: typeof res.prefillText === 'string' ? stripSkillBlock(res.prefillText) : '' });
        this.changed(r.cwd);
      } else {
        reply(false, { error: String(res.error ?? res.reason ?? '回退失败') });
      }
    } catch (e) {
      reply(false, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * 原生子代理的默认模型 / 强度。API 账号可能自带子代理模型，或映射表里没有选中的别名（第三方网关不认 Claude 原名），
   * 这两种情况不补 model。设了 CLAUDE_CODE_EFFORT_LEVEL 时 CLI 全局锁定强度，Agent 工具没有 effort 参数，也不补。
   */
  private agentDefaults(accountDir: string | null | undefined): AgentDefaults | null {
    const cfg = this.subagents?.get();
    if (!cfg) return null;
    const map = readApiConfig(accountDir)?.models;
    const canUseModel = (m: ModelAlias): boolean => !(map && (map.subagent || (hasModelMapping(map) && !map.alias?.[m])));
    const canUseEffort = !process.env.CLAUDE_CODE_EFFORT_LEVEL;
    let agents: Record<string, { model?: string; effort?: string }> | undefined;
    if (cfg.native.agents) {
      const out: Record<string, { model?: string; effort?: string }> = {};
      for (const [name, ov] of Object.entries(cfg.native.agents)) {
        const m = ov.model && canUseModel(ov.model) ? ov.model : undefined;
        const e = ov.effort && canUseEffort ? ov.effort : undefined;
        if (m || e) out[name] = { ...(m ? { model: m } : {}), ...(e ? { effort: e } : {}) };
      }
      if (Object.keys(out).length > 0) agents = out;
    }
    return {
      native: {
        ...(canUseModel(cfg.native.model) ? { model: cfg.native.model } : {}),
        ...(canUseEffort ? { effort: cfg.native.effort } : {}),
        ...(agents ? { agents } : {}),
      },
    };
  }

  /** 已在内存或磁盘有 jobs.json 时取会话任务表（用于订阅展示，不为空会话凭空建表） */
  private peekJobs(id: string): DelegateJobs | undefined {
    const existing = this.delegateJobs.get(id);
    if (existing) return existing;
    if (this.delegateRecord?.readJobs(id)) return this.jobsFor(id);
    return undefined;
  }

  /** 会话的委派任务表（懒创建）：事件进 runner 的回合缓冲（没有 runner 就直接广播），完成时通知模型 */
  private jobsFor(id: string): DelegateJobs {
    let jobs = this.delegateJobs.get(id);
    if (!jobs) {
      jobs = new DelegateJobs({
        onEvents: (evs) => {
          this.delegateRecord?.write(id, evs);
          const r = this.runners.get(id);
          for (const e of evs) {
            if (r) r.pushExternal(e);
            else this.emit(id, { t: 'event', sessionId: id, e });
          }
        },
        onChange: (list) => {
          this.emit(id, { t: 'delegates', sessionId: id, jobs: list });
          if (!this.dots) return;
          const active = list.filter((j) => j.state === 'running').length;
          const wasRunning = this.dots.isRunning(id);
          let dotChanged = this.dots.setBackground(id, active, 'delegate');
          // 后台委派全部结束且主进程已空闲：没人订阅时标记未读
          if (wasRunning && !this.dots.isRunning(id) && this.dots.turnFinished(id, this.hasSubscribers(id))) {
            dotChanged = true;
          }
          const cwd = this.cwdOf.get(id);
          if (dotChanged && cwd) this.changed(cwd);
        },
        onFinish: (n) => void this.notifyDelegate(id, n),
        ...(this.delegateRecord
          ? {
              results: this.delegateRecord,
              ids: this.delegateRecord,
              persist: {
                save: (data) => this.delegateRecord!.saveJobs(id, data),
                load: () => this.delegateRecord!.readJobs(id),
              },
            }
          : {}),
      });
      this.delegateJobs.set(id, jobs);
    }
    return jobs;
  }

  /**
   * 后台委派任务结束：把结果作为一条用户消息注入 CLI，模型据此收到通知。
   * 只有 r.inject() 成功后才算送达并移出 pending；任何失败（缺 cwd、进程正在关闭、inject 抛错）都保留在 pending（随 jobs.json 落盘）待重发。
   */
  private async notifyDelegate(id: string, n: DelegateNotification): Promise<void> {
    if (this.shuttingDown) return;
    await this.deliverNotification(id, n, { allowSpawn: true });
  }

  private async deliverNotification(id: string, n: DelegateNotification, opts: { allowSpawn: boolean }): Promise<boolean> {
    if (this.shuttingDown) return false;
    try {
      let cwd = this.cwdOf.get(id);
      if (!cwd && this.sessions?.findCwd) {
        try {
          cwd = (await this.sessions.findCwd(id)) ?? undefined;
          if (cwd) this.cwdOf.set(id, cwd);
        } catch { /* ignore */ }
      }
      if (!cwd) {
        console.warn(`[manager] 委派任务完成但不知道会话 ${id.slice(0, 8)} 的工作目录，通知保留待重发`);
        return false;
      }
      const config = this.configs?.get(id) ?? { model: 'sonnet', effort: 'medium' };
      let r = this.runners.get(id);
      if (r && !r.alive) return false;
      const created = !r;
      if (!r) {
        if (!opts.allowSpawn) return false;
        r = this.createRunner(id, cwd, false, config, false);
        this.runners.set(id, r);
      }
      const text = formatDelegateNotification(n);
      try {
        r.inject(text, config);
      } catch (e) {
        if (created && !r.alive) this.runners.delete(id);
        throw e;
      }
      this.delegateJobs.get(id)?.ackNotification(n);
      this.cwdOf.set(id, r.cwd);
      if (created) {
        if (this.accounts && r.accountId) this.accounts.bind(id, r.accountId);
        this.changed(r.cwd);
      }
      return true;
    } catch (e) {
      console.warn(`[manager] 委派任务完成通知注入失败 (${id.slice(0, 8)}):`, e instanceof Error ? e.message : e);
      return false;
    }
  }

  /** 依次补发该会话待送达的委派通知；onlyLiveSpawn=true 时绝不为服务重启恢复的通知拉起进程 */
  private async flushPending(id: string, opts: { allowSpawn: boolean; onlyLiveSpawn?: boolean }): Promise<void> {
    if (this.shuttingDown || this.flushing.has(id)) return;
    const jobs = this.peekJobs(id);
    if (!jobs) return;
    const list = jobs.pendingNotifications();
    if (list.length === 0) return;
    this.flushing.add(id);
    try {
      for (const item of list) {
        const canSpawn = opts.allowSpawn && (!opts.onlyLiveSpawn || !item.fromRestart);
        const ok = await this.deliverNotification(id, item.n, { allowSpawn: canSpawn });
        if (!ok) {
          if (!canSpawn && !this.runners.get(id)) continue;
          break;
        }
      }
    } finally {
      this.flushing.delete(id);
    }
  }

  private createRunner(id: string, cwd: string, isNew: boolean, config: ClientMsgConfig, probe: boolean): Runner {
    const account = this.accounts?.resolve(id);
    if (account) {
      if (this.processCount(account.id) === 0) {
        try {
          this.accounts!.prepare(account.id);
        } catch { /* 不影响启动 */ }
      } else {
        try {
          this.accounts!.syncFromSubagent?.(account.id);
        } catch { /* 不影响启动 */ }
      }
    }
    const runner: Runner = new Runner({
      sessionId: id,
      cwd,
      account,
      isNew,
      config,
      probe,
      timings: this.timings,
      claudePath: this.claudePath,
      // 探测进程也要传：它收到消息会直接转正成对话进程
      delegateJobs: this.jobsFor(id),
      ...(this.delegateBackends !== undefined ? { delegateBackends: this.delegateBackends } : {}),
      disabledAgents: () => this.tools?.agents?.() ?? [],
      subagents: () => this.subagents?.get() ?? DEFAULT_SUBAGENTS,
      ...(this.subagents ? { agentDefaults: () => this.agentDefaults(account?.dir) } : {}),
      expandText: (text) => appendSkills(text, (name) => this.manualSkill(id, cwd, name)),
      flagSettings: () => ({ ...this.skillFlagSettings(id, cwd), ...this.toolFlagSettings(), ...this.compactFlagSettings() }),
      ...(this.pluginDir ? { pluginDir: this.pluginDir } : {}),
      hooks: {
        onEvent: (e) => {
          this.emit(id, { t: 'event', sessionId: id, e });
          const ev = e as { type?: unknown; subtype?: unknown; skills?: unknown; slash_commands?: unknown; tools?: unknown } | null;
          if (ev?.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.skills)) {
            const list = ev.skills.filter((x): x is string => typeof x === 'string');
            this.initSkills.set(id, list);
            this.initSkillsByCwd.set(cwd, list);
          }
          if (ev?.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.slash_commands)) {
            const list = ev.slash_commands.filter((x): x is string => typeof x === 'string');
            this.initSlash.set(id, list);
            this.initSlashByCwd.set(cwd, list);
          }
          if (ev?.type === 'system' && ev.subtype === 'init' && Array.isArray(ev.tools)) {
            const list = ev.tools.filter((x): x is string => typeof x === 'string' && TOOL_NAME_RE.test(x));
            this.initTools.set(id, list);
            if (list.length) this.tools?.setKnown?.(list);
          }
          this.autoTitle.observe(runner, cwd, e);
          // 一条完整的 assistant / user(tool_result) 消息落地后，上下文用量就变了：节流刷新，让右侧面板实时更新
          const type = (e as { type?: unknown } | null)?.type;
          if (type === 'assistant' || type === 'user') this.scheduleLiveContext(runner);
        },
        onStatus: (status, error) => {
          const running = status === 'running' || status === 'starting';
          const other = this.runners.get(id);
          const replaced = !!other && other !== runner;
          if (!replaced) {
            if (running) this.dots.markInflight(id, cwd);
            else if (!this.shuttingDown) this.dots.clearInflight(id);
          }
          const wasDot = this.dots.setRunning(id, running);
          // 开始执行 → 自动置顶；停止 → 从此刻起计 30 分钟
          const pinChanged = this.pins?.onRunning(id, cwd, running) ?? false;
          this.emit(id, error ? { t: 'status', sessionId: id, status, error } : { t: 'status', sessionId: id, status });
          if (wasDot) this.changed(cwd);
          if (pinChanged) this.notifySidebar();
        },
        onQueue: (items) => this.emit(id, { t: 'queue', sessionId: id, items }),
        onPrompts: (items) => this.emit(id, { t: 'prompts', sessionId: id, items }),
        onBackgroundTasks: (count) => {
          const wasRunning = this.dots.isRunning(id);
          let dotChanged = this.dots.setBackground(id, count, 'claude');
          // 后台子代理全部结束且主进程已空闲：没人订阅时标记未读
          if (wasRunning && !this.dots.isRunning(id) && this.dots.turnFinished(id, this.hasSubscribers(id))) {
            dotChanged = true;
          }
          if (dotChanged) this.changed(cwd);
        },
        onSettings: (applied) => {
          this.settingsCache.set(id, { ...this.settingsCache.get(id), ...applied });
          this.emit(id, { t: 'settings', sessionId: id, applied });
        },
        onTurnEnd: () => {
          this.cancelLiveContext(id);
          this.dots.turnFinished(id, this.hasSubscribers(id));
          this.pins?.touch(id);
          this.changed(cwd);
          if (runner.alive) void this.fetchContext(runner).catch(() => {});
          if (runner.alive) void this.autoTitle.ensure(runner, cwd);
        },
        onStopped: (ev) => this.onRunnerStopped(id, ev),
        onTurnOk: () => {
          this.stops?.clear(id);
        },
        onExit: () => {
          // 已被同一会话的新进程替换（并行模式换账号）：新进程的状态不能被旧进程退出清掉
          const other = this.runners.get(id);
          if (other && other !== runner) {
            // 不丢弃待送达通知：若新进程已活着就顺手送达，否则继续保留在 pending
            if (other.alive) void this.flushPending(id, { allowSpawn: false });
            return;
          }
          this.cancelLiveContext(id);
          this.cancelMcpRetry(id);
          if (other === runner) this.runners.delete(id);
          // 进程退出后 Claude 后台子代理不再存活，清掉；delegate 由 Cosyee 托管，保留其状态
          const d1 = this.dots.setRunning(id, false);
          const d2 = this.dots.setBackground(id, 0, 'claude');
          this.pins?.onRunning(id, cwd, false);
          if (d1 || d2) this.changed(cwd);
          // 关闭期间到达的委派完成通知：实时通知允许重新拉起进程，服务重启恢复的通知绝不主动拉起
          void this.flushPending(id, { allowSpawn: true, onlyLiveSpawn: true });
        },
      },
    });
    return runner;
  }

  // ───────────── 上下文 ─────────────

  /** 启动参数里的 --settings 附加项：Cosyee 保存的 skill 状态 */
  private skillFlagSettings(sessionId: string, cwd: string | null): Record<string, unknown> {
    const map = this.skillModes(sessionId, cwd);
    return Object.keys(map).length ? { skillOverrides: map } : {};
  }

  /**
   * 下发给某个会话的完整 skill 状态：Cosyee 保存的 + 默认关掉的官方 agent-browser skill
   * （只补磁盘上真有的、用户没设过的；不存进设置，用户在面板里打开就以用户的为准）。
   */
  private skillModes(sessionId: string, cwd: string | null): Record<string, SkillMode> {
    const stored = this.skills?.get() ?? {};
    const out: Record<string, SkillMode> = { ...stored };
    if (!this.skills || OFFICIAL_BROWSER_SKILL in stored) return out;
    for (const d of this.scanDiskSkills(sessionId, cwd) ?? []) {
      if (skillBase(d.name) === OFFICIAL_BROWSER_SKILL && !(d.name in stored)) out[d.name] = 'off';
    }
    return out;
  }

  /** 启动参数里的 --settings 附加项：已停用的工具与关闭的智能体（permissions.deny）。启动时下发，模型根本看不到它们 */
  private toolFlagSettings(): Record<string, unknown> {
    const list = this.denyList();
    return list.length ? { permissions: { deny: list } } : {};
  }

  /**
   * 启动参数里的 --settings 附加项：自动压缩窗口。走 flag settings 而不是进程环境变量——
   * 用户 ~/.claude/settings.json 的 env 会盖过进程环境变量，flag settings 则盖过用户设置（实测）。
   */
  private compactFlagSettings(): Record<string, unknown> {
    const w = this.compactWindow?.get() ?? null;
    return w ? { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(w) }, autoCompactEnabled: true } : {};
  }

  /**
   * 采集上下文：get_context_usage 为主，get_settings（只取 effective.skillOverrides）与 mcp_status 失败时忽略。
   * get_settings 的其余内容含个人信息，这里不保留。
   */
  private async fetchContext(r: Runner): Promise<ContextUsage> {
    const [raw, settings, mcp, init, sessionToolLoad] = await Promise.all([
      r.request('get_context_usage'),
      r.request('get_settings').catch(() => null),
      r.request('mcp_status').catch(() => null),
      initInfoOf(r),
      this.toolLoadCache.readSession(r.cwd, r.sessionId).catch(() => null),
    ]);
    if (sessionToolLoad?.seenDelta) {
      const observed = [...sessionToolLoad.deferred].filter((n) => TOOL_NAME_RE.test(n)).sort();
      if (observed.length) this.tools?.setKnownDeferred?.(observed);
    }
    const eff = (settings as { effective?: { skillOverrides?: unknown } } | null)?.effective?.skillOverrides;
    const disk = this.scanDiskSkills(r.sessionId, r.cwd);
    const synced = new Set(this.scanSyncedSkills(r.sessionId).keys());
    const desc = this.descriptions(r, init, disk);
    const usage = toContextUsage(raw, Date.now(), {
      initSkills: this.initSkills.get(r.sessionId) ?? this.initSkillsByCwd.get(r.cwd) ?? null,
      overrides: eff && typeof eff === 'object' ? (eff as Record<string, unknown>) : null,
      cosyeeOverrides: this.skills ? this.skillModes(r.sessionId, r.cwd) : null,
      diskSkills: disk,
      syncedSkills: synced,
      hidden: this.hiddenSkills(disk),
      mcpStatus: mcp,
      disabledTools: this.tools?.get() ?? null,
      disabledAgents: this.tools?.agents?.() ?? null,
      nativeAgents: this.subagents ? r.runningSubagent(this.denyList()) === 'native' : null,
      tools: this.initTools.get(r.sessionId) ?? this.tools?.known?.() ?? null,
      slashCommands: this.initSlash.get(r.sessionId) ?? this.initSlashByCwd.get(r.cwd) ?? (init?.commandNames.length ? init.commandNames : null),
      compactWindow: this.compactWindow?.get() ?? null,
      skillDescriptions: desc.skills,
      agentDescriptions: desc.agents,
      sessionToolLoad,
      cachedDeferredTools: this.tools?.knownDeferred?.() ?? null,
    });
    this.contextCache.set(r.sessionId, usage);
    this.emit(r.sessionId, { t: 'context', sessionId: r.sessionId, usage });
    this.scheduleMcpRetry(r, usage);
    return usage;
  }

  /**
   * skill / 智能体的描述原文：以 CLI initialize 报告的为准（就是放进系统提示词的那段，含内置）；
   * 不在其中的（已关闭、仅手动）读磁盘上 SKILL.md / 智能体定义的 description。
   */
  private descriptions(r: Runner, init: InitDescs | null, disk: DiskSkill[] | null): { skills: Map<string, string>; agents: Map<string, string> } {
    const skills = new Map(init?.commands ?? []);
    for (const d of disk ?? []) {
      if (skills.has(d.name)) continue;
      const text = skillDescription(d.dir);
      if (text) skills.set(d.name, text);
    }
    let agents = new Map<string, string>();
    try {
      agents = listDiskAgentDescriptions(this.accounts?.resolve(r.sessionId)?.dir ?? baseClaudeHome(), r.cwd);
    } catch { /* 读不到磁盘：只用 CLI 报告的 */ }
    for (const [k, v] of init?.agents ?? []) agents.set(k, v);
    return { skills, agents };
  }

  private readonly removedSkills = new Set<string>();

  /** 磁盘上的全部 skill（会话所用账号的配置目录 + 项目目录）；扫描失败当作读不到 */
  private scanDiskSkills(sessionId: string, cwd: string | null): DiskSkill[] | null {
    try {
      const dir = this.accounts?.resolve(sessionId)?.dir ?? null;
      return listDiskSkills(dir ?? baseClaudeHome(), cwd);
    } catch {
      return null;
    }
  }

  /** 当前会话所属账号的云端同步 skill（只用于判断 onDisk 与打开文件位置）；失败返回空 Map */
  private scanSyncedSkills(sessionId: string | null): Map<string, string> {
    try {
      const accDir = sessionId ? this.accounts?.resolve(sessionId)?.dir ?? null : null;
      return listSyncedSkills(accDir ?? baseClaudeHome(), claudeJsonPath(accDir));
    } catch {
      return new Map();
    }
  }

  /** 状态为「手动」、且磁盘上有正文的 skill；其它返回 null（关闭的不给，开着的模型自己会调） */
  private manualSkill(sessionId: string, cwd: string, name: string): MentionedSkill | null {
    const mode = this.skills?.get()[name] ?? this.contextCache.get(sessionId)?.skills.find((s) => s.name === name)?.mode;
    if (mode !== 'user-invocable-only') return null;
    return readSkillContent(name, this.accounts?.resolve(sessionId)?.dir ?? baseClaudeHome(), cwd);
  }

  /** 被移除、且磁盘上确实没有了的 skill 名（磁盘上又出现就不再藏） */
  private hiddenSkills(disk: DiskSkill[] | null): string[] {
    const onDisk = new Set((disk ?? []).map((d) => d.name));
    for (const n of [...this.removedSkills]) if (onDisk.has(n)) this.removedSkills.delete(n);
    return [...this.removedSkills];
  }

  /** 有 MCP 服务器还在连接：过一会儿再采一次，让状态与工具列表跟上 */
  private scheduleMcpRetry(r: Runner, usage: ContextUsage): void {
    const id = r.sessionId;
    const pending = usage.mcpServers.some((s) => s.status === 'pending');
    let st = this.mcpRetry.get(id);
    if (!pending) {
      if (st && !st.timer) this.mcpRetry.delete(id);
      return;
    }
    if (!st) this.mcpRetry.set(id, (st = { timer: null, n: 0 }));
    if (st.timer || st.n >= MCP_PENDING_RETRIES) return;
    const state = st;
    state.n++;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (r.alive && this.runners.get(id) === r) void this.fetchContext(r).catch(() => {});
    }, MCP_PENDING_RETRY_MS);
    state.timer.unref();
  }

  private cancelMcpRetry(id: string): void {
    const st = this.mcpRetry.get(id);
    if (st?.timer) clearTimeout(st.timer);
    this.mcpRetry.delete(id);
  }

  /** 延迟若干毫秒后再采一次（MCP 打开后连接需要时间） */
  private refetchLater(r: Runner, ms: number): void {
    setTimeout(() => {
      if (r.alive && this.runners.get(r.sessionId) === r) void this.fetchContext(r).catch(() => {});
    }, ms).unref();
  }

  /**
   * 回合进行中按事件触发的上下文刷新：没人订阅就不采集；距上次不足 CONTEXT_LIVE_MS 则合并成一次尾部刷新；
   * 同一会话同时只有一个请求在途。回合结束时 onTurnEnd 还会再采一次最终值。
   */
  private scheduleLiveContext(r: Runner): void {
    const id = r.sessionId;
    if (!r.alive || !this.hasSubscribers(id)) return;
    let st = this.ctxLive.get(id);
    if (!st) this.ctxLive.set(id, (st = { timer: null, last: 0, busy: false }));
    if (st.timer || st.busy) return; // 已有待执行的刷新 / 正在采集
    const state = st;
    const run = () => {
      state.timer = null;
      if (!r.alive || !this.hasSubscribers(id)) return;
      state.busy = true;
      state.last = Date.now();
      void this.fetchContext(r)
        .catch(() => { /* 采集失败（进程忙 / 超时）：等下一条消息再试 */ })
        .finally(() => { state.busy = false; });
    };
    const wait = Math.max(0, state.last + CONTEXT_LIVE_MS - Date.now());
    state.timer = setTimeout(run, wait);
    state.timer.unref();
  }

  private cancelLiveContext(id: string): void {
    const st = this.ctxLive.get(id);
    if (st?.timer) clearTimeout(st.timer);
    this.ctxLive.delete(id);
  }

  getContext(id: string): ContextUsage | null {
    return this.contextCache.get(id) ?? null;
  }

  /**
   * 立即重新采集；会话没有进程时拉起一个不发消息的探测进程（已有记录用 --resume）。
   * draft：前端新开、还没发过消息的会话（磁盘上没有记录）——用 --session-id 拉起，之后第一条消息直接复用这个进程。
   */
  async refreshContext(id: string, cwdHint?: string, draft = false): Promise<ContextUsage | null> {
    const r = this.runners.get(id);
    if (r) {
      if (!r.alive) return this.getContext(id);
      try {
        return await this.fetchContext(r);
      } catch {
        return this.getContext(id);
      }
    }
    const running = this.probing.get(id);
    if (running) return running;
    const p = this.probeContext(id, cwdHint, draft).finally(() => this.probing.delete(id));
    this.probing.set(id, p);
    return p;
  }

  private async probeContext(id: string, cwdHint?: string, draft = false): Promise<ContextUsage | null> {
    let probe: Runner;
    try {
      probe = await this.startProbe(id, cwdHint, draft);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      return this.getContext(id);
    }
    try {
      return await this.fetchContext(probe);
    } catch {
      if (!probe.alive && this.runners.get(id) === probe) this.runners.delete(id);
      return this.getContext(id);
    }
  }

  /**
   * 会话没有进程时，拉起一个不发消息的探测进程：有记录用 --resume；没有记录且 draft（新会话草稿）用 --session-id。
   * （实测：不发消息的 --session-id 进程不会写会话文件，探测进程空闲退出后再用 --session-id 新建不冲突。）
   * 会话不存在（且不是草稿）抛 404，启动失败抛原错误。
   */
  private async startProbe(id: string, cwdHint?: string, draft = false): Promise<Runner> {
    const cwd = cwdHint ? normalizeDir(cwdHint) : (this.cwdOf.get(id) ?? (await this.sessions.findCwd(id)));
    if (!cwd) throw new HttpError(404, '会话不存在');
    const loc = await this.sessions.locate(id, cwd);
    if (!loc && !draft) throw new HttpError(404, '会话不存在');
    const existing = this.runners.get(id);
    if (existing?.alive) return existing;
    // 配置只用于启动参数；进程随后可复用，真正发消息时 send 会按需 set_model 等
    const probe = this.createRunner(id, cwd, !loc, this.configs?.get(id) ?? { model: 'sonnet', effort: 'medium' }, true);
    this.runners.set(id, probe);
    try {
      probe.start();
    } catch (e) {
      if (this.runners.get(id) === probe) this.runners.delete(id);
      throw e;
    }
    this.cwdOf.set(id, cwd);
    return probe;
  }

  // ───────────── Skill / MCP 开关 ─────────────

  /**
   * 设置一个 skill 的状态：先存下来（新启动的会话经 --settings 带上），再把完整映射下发给所有运行中的会话
   * （apply_flag_settings 里 skillOverrides 是整体替换，必须发完整映射），然后为有人看的会话重新采集上下文。
   */
  async setSkillMode(name: string, mode: SkillMode): Promise<void> {
    return this.setSkillModes({ [name]: mode });
  }

  /** 批量设置（勾选批量操作 / 撤销用）：只落盘、下发、采集一次 */
  async setSkillModes(modes: Record<string, SkillMode>): Promise<void> {
    if (!this.skills) throw new HttpError(500, '未启用 skill 设置');
    const entries = Object.entries(modes);
    if (entries.length === 0) return;
    this.skills.setMany(modes);
    const alive = [...this.runners.values()].filter((r) => r.alive);
    await Promise.all(
      alive.map(async (r) => {
        try {
          await r.request('apply_flag_settings', { settings: { skillOverrides: this.skillModes(r.sessionId, r.cwd) } });
        } catch { /* 进程忙 / 已退出：下次启动时经 --settings 生效 */ }
        if (this.hasSubscribers(r.sessionId)) void this.fetchContext(r).catch(() => {});
      }),
    );
    // 没有进程、但面板开着的会话：直接改缓存里的状态
    for (const [id, usage] of this.contextCache) {
      if (this.runners.get(id)?.alive || !this.hasSubscribers(id)) continue;
      let skills = usage.skills;
      for (const [name, mode] of entries) {
        skills = skills.some((s) => s.name === name)
          ? skills.map((s) => (s.name === name ? { ...s, mode, tokens: mode === 'on' ? s.tokens : null } : s))
          : [...skills, { name, mode, tokens: null, source: name.includes(':') ? 'plugin' : null }];
      }
      const next = { ...usage, skills };
      this.contextCache.set(id, next);
      this.emit(id, { t: 'context', sessionId: id, usage: next });
    }
  }

  /**
   * 启用 / 停用一个内置工具：先存下来（新启动的会话经 --settings 的 permissions.deny 带上），
   * 再把完整名单下发给所有运行中的进程（apply_flag_settings 对 permissions.deny 是整体替换，实测空数组即清除）。
   * 实测（claude 2.x）：运行中下发立即生效——被停用的工具再被调用会得到 "Permission to use X has been denied."，
   * 但该工具仍留在模型的工具列表里（模型可能还会尝试一次）；重启 / 新会话后才会从列表里消失。
   */
  async setToolEnabled(name: string, enabled: boolean): Promise<string[]> {
    if (!this.tools) throw new HttpError(500, '未启用工具设置');
    if (DELEGATE_AUX_TOOL_NAMES.includes(name) && !enabled) {
      throw new HttpError(400, '委派辅助工具跟随 delegate 一起启停，不能单独停用');
    }
    const cur = this.tools.get();
    const has = cur.includes(name);
    // 重新启用 delegate 时顺手清掉历史残留的委派辅助工具停用项
    const staleAux = name === DELEGATE_TOOL_NAME && enabled && cur.some((n) => DELEGATE_AUX_TOOL_NAMES.includes(n));
    if (enabled === !has && !staleAux) return [...cur];
    const next = enabled
      ? cur.filter((n) => n !== name && !(name === DELEGATE_TOOL_NAME && DELEGATE_AUX_TOOL_NAMES.includes(n)))
      : [...cur, name];
    this.tools.set(next);
    const list = [...this.tools.get()];
    await this.pushDeny({
      disabledTools: list,
      ...(this.subagents ? { nativeAgents: this.subagentState().effective === 'native' } : {}),
    });
    if (name === DELEGATE_TOOL_NAME) this.notifySubagents();
    return list;
  }

  /**
   * 开启 / 关闭一个智能体（子代理）：同工具开关，名单全局保存，以 Agent(名字) 规则并入 permissions.deny。
   * 关闭后模型派发该智能体会被拒绝；新启动的会话里它不再出现在 Agent 工具的可选列表中。
   */
  async setAgentEnabled(name: string, enabled: boolean): Promise<string[]> {
    if (!this.tools?.agents || !this.tools.setAgents) throw new HttpError(500, '未启用智能体设置');
    const cur = this.tools.agents();
    const has = cur.includes(name);
    if (enabled === !has) return [...cur];
    this.tools.setAgents(enabled ? cur.filter((n) => n !== name) : [...cur, name]);
    const list = [...this.tools.agents()];
    await this.pushDeny({ disabledAgents: list });
    this.notifySubagents();
    return list;
  }

  /** 当前子代理状态：配置、各类型可用性、实际生效类型（不可用或手动停用 delegate 时退回 native）、退回原因、代理类型列表与已关闭名单 */
  subagentState(cwd?: string | null): SubagentState {
    const config = this.subagents?.get() ?? DEFAULT_SUBAGENTS;
    const claudeBackend = this.delegateBackends?.claude;
    const agyBackend = this.delegateBackends?.agy;
    const claudeAvail: SubagentAvailability = claudeBackend?.availability
      ? claudeBackend.availability()
      : claudeBackend?.available()
        ? { ok: true }
        : { ok: false, reason: '未安装 Claude CLI' };
    const agyAvail: SubagentAvailability = agyBackend?.availability
      ? agyBackend.availability()
      : agyBackend?.available()
        ? { ok: true }
        : { ok: false, reason: '未安装 Antigravity CLI' };
    const available: Record<SubagentKind, SubagentAvailability> = {
      native: { ok: true },
      claude: claudeAvail,
      agy: agyAvail,
    };
    const delegateDisabled = this.tools?.get().includes(DELEGATE_TOOL_NAME) ?? false;
    let effective: SubagentKind = config.kind;
    let fallbackReason: string | undefined;
    if (config.kind !== 'native') {
      if (delegateDisabled) {
        effective = 'native';
        fallbackReason = '委派工具已在工具面板停用';
      } else if (!available[config.kind].ok) {
        effective = 'native';
        fallbackReason = available[config.kind].reason ?? '委派后端不可用';
      }
    }
    let validCwd = '';
    if (typeof cwd === 'string' && cwd.trim()) {
      try {
        const norm = normalizeDir(cwd);
        if (fs.statSync(norm).isDirectory()) validCwd = norm;
      } catch { /* 非法或不存在的 cwd：退回只列内置与用户级 */ }
    }
    const configDir = this.accounts?.activeDir?.() ?? baseClaudeHome();
    const agents = listAllAgents({ configDir, cwd: validCwd }).map(toSubagentTypeInfo);
    const disabledAgents = [...(this.tools?.agents?.() ?? [])];
    return {
      config: structuredClone(config),
      available,
      effective,
      ...(fallbackReason ? { fallbackReason } : {}),
      agents,
      disabledAgents,
    };
  }

  /**
   * 更新子代理配置：先落盘，再向所有运行中的会话推送最新的 permissions.deny（Agent vs mcp__cosyee__*），
   * 并同步热进程保活。系统提示词里的委派约定仅在新启动会话时按配置决定。
   */
  async setSubagents(config: SubagentConfig, cwd?: string | null): Promise<SubagentState> {
    if (!this.subagents) throw new HttpError(500, '未启用子代理设置');
    this.subagents.set(config);
    const state = this.subagentState(cwd);
    await this.pushDeny({ nativeAgents: state.effective === 'native' });
    this.notifySubagents();
    return state;
  }

  /** 完整的 permissions.deny：停用的工具 + 关闭的智能体（Agent(名字)） */
  private denyList(): string[] {
    return [...(this.tools?.get() ?? []), ...(this.tools?.agents?.() ?? []).map((a) => `Agent(${a})`)];
  }

  /**
   * 把完整的 deny 名单下发给所有运行中的进程，并刷新面板；没有进程、但面板开着的会话直接改缓存里的名单。
   * apply_flag_settings 对 permissions.deny 是整体替换，实测空数组即清除，所以每次都发全量。
   * 内部通过 denyChain 串行化并在 await 之后重读最新状态，避免并发修改导致乱序覆盖。
   */
  private pushDeny(_patch?: Pick<ContextUsage, 'disabledTools' | 'disabledAgents' | 'nativeAgents'>): Promise<void> {
    const run = async () => {
      const deny = this.denyList();
      const alive = [...this.runners.values()].filter((r) => r.alive);
      await Promise.all(
        alive.map(async (r) => {
          r.syncDelegateHold(deny);
          try {
            await r.request('apply_flag_settings', { settings: { permissions: { deny: r.withSubagentDeny(deny) } } });
          } catch { /* 进程忙 / 已退出：下次启动时经 --settings 生效 */ }
          if (this.hasSubscribers(r.sessionId)) void this.fetchContext(r).catch(() => {});
        }),
      );
      const latestPatch: Partial<Pick<ContextUsage, 'disabledTools' | 'disabledAgents' | 'nativeAgents'>> = {
        ...(this.tools ? { disabledTools: [...this.tools.get()] } : {}),
        ...(this.tools?.agents ? { disabledAgents: [...this.tools.agents()] } : {}),
        ...(this.subagents ? { nativeAgents: this.subagentState().effective === 'native' } : {}),
      };
      for (const [id, usage] of this.contextCache) {
        if (this.runners.get(id)?.alive || !this.hasSubscribers(id)) continue;
        const next = { ...usage, ...latestPatch };
        this.contextCache.set(id, next);
        this.emit(id, { t: 'context', sessionId: id, usage: next });
      }
    };
    const next = this.denyChain.then(run, run);
    this.denyChain = next.catch(() => {});
    return next;
  }

  /**
   * 设置自动压缩窗口（null = 不覆盖）：先存下来（新启动的进程经 --settings env 带上），再下发给所有运行中的进程。
   * 实测（claude 2.x）：运行中 apply_flag_settings 的 env 立即生效，get_context_usage 的 autoCompactThreshold 随之变为 窗口 - 33k；
   * 之后再下发 effortLevel / permissions 等其它顶层键不会冲掉它（按顶层键合并）。
   * 设了窗口就同时打开自动压缩（autoCompactEnabled: true 盖过用户 settings.json 的 false，实测启动与运行中都生效）；
   * 恢复默认时 autoCompactEnabled 下发 null，回到用户设置。
   * 恢复默认时下发空 env：进程里已经写入的环境变量未必撤销，重启进程后才确定回到默认。
   */
  async setCompactWindow(window: number | null): Promise<number | null> {
    if (!this.compactWindow) throw new HttpError(500, '未启用压缩窗口设置');
    if (this.compactWindow.get() === window) return window;
    this.compactWindow.set(window);
    const settings = window
      ? { env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(window) }, autoCompactEnabled: true }
      : { env: {}, autoCompactEnabled: null };
    const alive = [...this.runners.values()].filter((r) => r.alive);
    await Promise.all(
      alive.map(async (r) => {
        try {
          await r.request('apply_flag_settings', { settings });
        } catch { /* 进程忙 / 已退出：下次启动时经 --settings 生效 */ }
        if (this.hasSubscribers(r.sessionId)) void this.fetchContext(r).catch(() => {});
      }),
    );
    // 没有进程、但面板开着的会话：只改设置值，触发点要等进程启动后由 CLI 报告
    for (const [id, usage] of this.contextCache) {
      if (this.runners.get(id)?.alive || !this.hasSubscribers(id)) continue;
      const next = { ...usage, compactWindow: window };
      this.contextCache.set(id, next);
      this.emit(id, { t: 'context', sessionId: id, usage: next });
    }
    return window;
  }

  /**
   * 移除一个用户级 / 项目级 skill：目录移到 ~/.cosyee/removed-skills（可手动放回恢复），清掉它的已存状态，
   * 并让正在运行的进程也把它关掉（进程里已加载的内容要到新会话才会真正消失）。
   */
  async removeSkill(sessionId: string | null, name: string, cwd: string | null): Promise<{ backup: string }> {
    const dir = sessionId ? this.accounts?.resolve(sessionId)?.dir ?? null : null;
    let backup: string;
    try {
      backup = removeDiskSkill(name, dir ?? baseClaudeHome(), cwd, path.join(cosyeeHome(), 'removed-skills'));
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : String(e));
    }
    this.removedSkills.add(name);
    this.skills?.remove(name);
    for (const m of [this.initSkills, this.initSkillsByCwd]) {
      for (const [k, list] of m) m.set(k, list.filter((n) => n !== name));
    }
    const alive = [...this.runners.values()].filter((r) => r.alive);
    await Promise.all(
      alive.map(async (r) => {
        try {
          await r.request('apply_flag_settings', { settings: { skillOverrides: { ...this.skillModes(r.sessionId, r.cwd), [name]: 'off' } } });
        } catch { /* 进程忙 / 已退出 */ }
        if (this.hasSubscribers(r.sessionId)) void this.fetchContext(r).catch(() => {});
      }),
    );
    for (const [id, usage] of this.contextCache) {
      if (this.runners.get(id)?.alive || !this.hasSubscribers(id)) continue;
      const next = { ...usage, skills: usage.skills.filter((s) => s.name !== name) };
      this.contextCache.set(id, next);
      this.emit(id, { t: 'context', sessionId: id, usage: next });
    }
    return { backup };
  }

  /** 查找 skill 在磁盘上的目录（用于「打开文件位置」）；找不到返回 null */
  skillDir(sessionId: string | null, name: string, cwd: string | null): string | null {
    const dir = sessionId ? this.accounts?.resolve(sessionId)?.dir ?? null : null;
    return listDiskSkills(dir ?? baseClaudeHome(), cwd).find((s) => s.name === name)?.dir ?? this.scanSyncedSkills(sessionId).get(name) ?? null;
  }

  /**
   * 开关 MCP 服务器（CLI 的 mcp_toggle，按项目写进 ~/.claude.json，与终端 /mcp 相同）。
   * 会话没有进程时先拉起探测进程。打开后服务器异步连接，稍后再采两次。
   */
  async toggleMcp(id: string, server: string, enabled: boolean, cwdHint?: string, draft = false): Promise<ContextUsage | null> {
    let r = this.runners.get(id);
    if (!r?.alive) r = await this.startProbe(id, cwdHint, draft);
    try {
      await r.request('mcp_toggle', { serverName: server, enabled });
    } catch (e) {
      throw new HttpError(502, `切换 MCP 失败：${e instanceof Error ? e.message : String(e)}`);
    }
    const usage = await this.fetchContext(r).catch(() => this.getContext(id));
    if (enabled) {
      this.refetchLater(r, 2000);
      this.refetchLater(r, 6000);
    }
    return usage;
  }

  // ───────────── 改名 / 已读 ─────────────

  async rename(id: string, cwd: string, title: string): Promise<void> {
    const t = String(title ?? '').replace(/[\r\n]+/g, ' ').trim();
    if (!t) throw new HttpError(400, '标题不能为空');
    if (t.length > TITLE_MAX_INPUT) throw new HttpError(400, '标题过长');
    const r = this.runners.get(id);
    let done = false;
    if (r?.alive) {
      try {
        await r.request('rename_session', { title: t, source: 'host', session_id: id });
        done = true;
      } catch { /* 退回直接写文件 */ }
    }
    if (!done) await this.sessions.appendTitle(id, cwd, t);
    this.changed(normalizeDir(cwd));
  }

  viewed(id: string, cwd: string): void {
    if (this.dots.viewed(id)) this.changed(normalizeDir(cwd));
  }

  // ───────────── 分支（fork） ─────────────

  /**
   * 从某条用户消息之前分支出一个新会话（只复制记录文件，不启动进程；源会话与它的进程都不受影响）。
   * 记下「新会话 ← 来源会话」，分支点之前的子代理记录仍在来源会话目录下，打开它们时顺着这条链找。
   */
  async fork(id: string, cwd: string, targetId: string): Promise<{ sessionId: string }> {
    const dir = normalizeDir(cwd);
    const res = await this.sessions.fork(id, dir, targetId);
    this.forks?.set(res.sessionId, dir, id);
    this.changed(dir);
    return res;
  }

  /** 永久删除会话时清理委派任务、待送达通知、停止记录与落盘目录；软删除不调用 */
  forgetSession(id: string): void {
    const jobs = this.delegateJobs.get(id);
    if (jobs) {
      jobs.forget();
      this.delegateJobs.delete(id);
    }
    this.stops?.clear(id);
    this.dots?.setBackground(id, 0, 'delegate');
    void this.delegateRecord?.deleteSession(id);
  }

  // ───────────── 错误停止与自动重试 ─────────────

  /** 服务重启后，把上次关闭/崩溃时尚在执行中的会话补记为中断并标未读 */
  private recoverInterrupted(): void {
    if (!this.dots?.takeInflight) return;
    for (const { id, cwd } of this.dots.takeInflight()) {
      this.cwdOf.set(id, cwd);
      if (this.stops && !this.stops.get(id)) {
        this.stops.set(id, {
          kind: 'interrupted',
          reason: '服务重启，这一轮没有执行完',
          attempts: 0,
          state: 'stopped',
          at: this.now(),
        });
      }
      this.dots.markUnread(id);
    }
  }

  /** Runner 报告本轮因错误停止或进程异常退出：按规则记录并安排自动重试 */
  private onRunnerStopped(id: string, ev: RunnerStopInfo): void {
    if (!this.stops) return;
    const now = this.now();
    const prev = this.stops.get(id);
    // 自动重试发出的那一轮再次失败时沿用已累计的 attempts；其它情况从 0 起算
    const attempts = prev?.state === 'retrying' ? prev.attempts : 0;
    let state: StopInfo['state'];
    let retryAt: number | undefined;
    if (ev.kind === 'fatal') {
      state = 'stopped';
    } else if (ev.kind === 'rate_limit') {
      const hasReset = typeof ev.resetsAt === 'number' && Number.isFinite(ev.resetsAt) && ev.resetsAt > 0;
      if (hasReset) {
        // 拿到新的 resetsAt 时不累计次数上限，等到额度重置后再试
        state = 'waiting';
        retryAt = ev.resetsAt! * 1000 + RATE_LIMIT_BUFFER_MS;
      } else if (attempts >= MAX_AUTO_RETRIES) {
        state = 'gave_up';
      } else {
        state = 'waiting';
        retryAt = now + RATE_LIMIT_FALLBACK_MS;
      }
    } else {
      // transient
      if (attempts >= MAX_AUTO_RETRIES) {
        state = 'gave_up';
      } else {
        state = 'waiting';
        retryAt = now + transientRetryDelay(attempts);
      }
    }
    this.stops.set(id, {
      kind: ev.kind,
      reason: ev.reason,
      ...(retryAt !== undefined ? { retryAt } : {}),
      attempts,
      state,
      at: now,
    });
  }

  /** 判断会话当前是否满足重试的空闲条件 */
  private isSessionIdleForRetry(id: string): boolean {
    const r = this.runners.get(id);
    if (r) {
      if (!r.alive || r.status !== 'idle') return false;
      if (r.queueItems().length > 0) return false;
      if (r.promptItems().length > 0) return false;
    }
    const jobs = this.peekJobs(id);
    if (jobs && jobs.list().some((j) => j.state === 'running')) return false;
    if (this.dots?.hasBackground(id)) return false;
    return true;
  }

  private startRetryPoller(): void {
    if (this.retryTimer || this.retryPollMs <= 0) return;
    this.retryTimer = setInterval(() => {
      void this.pollRetries();
    }, this.retryPollMs);
    this.retryTimer.unref();
  }

  /** 检查所有等待自动重试的记录，到期且空闲则发出重试消息 */
  async pollRetries(): Promise<void> {
    if (this.shuttingDown || !this.stops) return;
    const now = this.now();
    for (const { sessionId, info } of this.stops.list()) {
      if (this.shuttingDown) return;
      if (info.state !== 'waiting' || typeof info.retryAt !== 'number' || info.retryAt > now) continue;
      if (this.retrying.has(sessionId) || !this.isSessionIdleForRetry(sessionId)) continue;
      await this.executeRetry(sessionId, info);
    }
  }

  /** 立即重试一次因错误停止的会话；无记录或会话不空闲时给客户端回 error */
  private async retryNow(client: Client, id: string): Promise<void> {
    if (!this.stops) {
      this.safeSend(client, { t: 'error', message: '未启用重试记录' });
      return;
    }
    const info = this.stops.get(id);
    if (!info) {
      this.safeSend(client, { t: 'error', message: '该会话没有停止记录' });
      return;
    }
    const res = await this.executeRetry(id, info);
    if (!res.ok) this.safeSend(client, { t: 'error', message: res.error ?? '重试失败' });
  }

  /** 取消自动重试：保留记录用于展示原因，state 置为 stopped 并去掉 retryAt */
  private retryCancel(id: string): void {
    if (!this.stops) return;
    const info = this.stops.get(id);
    if (!info) return;
    if (info.state === 'stopped' && info.retryAt === undefined) return;
    this.stops.set(id, {
      kind: info.kind,
      reason: info.reason,
      attempts: info.attempts,
      state: 'stopped',
      at: info.at,
    });
  }

  private async executeRetry(id: string, expected: StopInfo): Promise<{ ok: boolean; error?: string }> {
    if (this.shuttingDown || !this.stops) return { ok: false, error: '服务正在关闭' };
    if (this.retrying.has(id)) return { ok: false, error: '正在重试中' };
    if (!this.isSessionIdleForRetry(id)) return { ok: false, error: '会话正在执行中，无法重试' };
    this.retrying.add(id);
    try {
      let cwd = this.cwdOf.get(id);
      if (!cwd && this.sessions?.findCwd) {
        try {
          cwd = (await this.sessions.findCwd(id)) ?? undefined;
          if (cwd) this.cwdOf.set(id, cwd);
        } catch { /* ignore */ }
      }
      if (!cwd) return { ok: false, error: '找不到会话的工作目录' };
      if (this.shuttingDown) return { ok: false, error: '服务正在关闭' };
      const latest = this.stops.get(id);
      if (!latest || latest.state !== expected.state) return { ok: false, error: '停止记录已变更' };
      if (!this.isSessionIdleForRetry(id)) return { ok: false, error: '会话正在执行中，无法重试' };
      const config = this.configs?.get(id) ?? { model: 'sonnet', effort: 'medium' };
      this.sendInternal(id, cwd, retryPromptText(latest.kind), config);
      this.stops.set(id, {
        kind: latest.kind,
        reason: latest.reason,
        attempts: latest.attempts + 1,
        state: 'retrying',
        at: this.now(),
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.retrying.delete(id);
    }
  }

  // ───────────── 关闭 ─────────────

  /** 优雅关闭：清理重试轮询、关闭所有进程并等待退出（最多 timeoutMs）。 */
  async shutdown(timeoutMs = 4000): Promise<void> {
    // 静默中止所有委派任务（保留磁盘上的 running 状态，下次启动时据此报告中断）
    this.shuttingDown = true;
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.unsubStops?.();
    this.unsubStops = null;
    try {
      for (const [id, j] of this.delegateJobs) {
        j.abortAll();
        this.dots?.setBackground(id, 0, 'delegate');
      }
      await this.stopRunners(timeoutMs);
    } finally {
      this.shuttingDown = false;
    }
  }

  /** 结束所有 claude 进程并等待退出（最多 timeoutMs）。委派任务不受影响 */
  private async stopRunners(timeoutMs: number): Promise<void> {
    const rs = [...this.runners.values()];
    for (const r of rs) r.shutdown(Math.min(2000, timeoutMs));
    const deadline = Date.now() + timeoutMs;
    // 只等这一批：等待期间委派完成通知可能为会话拉起新进程，它不该被杀
    const pending = () => rs.filter((r) => this.runners.get(r.sessionId) === r);
    while (pending().length > 0 && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    for (const r of pending()) r.killSync();
  }

  /**
   * 切换账号：结束所有进程，清掉与账号有关的缓存（设置、上下文、skill 列表…）。
   * 订阅关系保留（前端随后整页刷新会重新订阅）。
   * 后台委派任务继续跑（后端与 Claude 账号无关），完成通知在会话下次启动时送达。
   */
  async resetAll(timeoutMs = 5000): Promise<void> {
    await this.stopRunners(timeoutMs);
    for (const id of [...this.ctxLive.keys()]) this.cancelLiveContext(id);
    for (const id of [...this.mcpRetry.keys()]) this.cancelMcpRetry(id);
    this.settingsCache.clear();
    this.contextCache.clear();
    this.probing.clear();
    this.initSkills.clear();
    this.initSkillsByCwd.clear();
    this.initSlash.clear();
    this.initSlashByCwd.clear();
    this.initTools.clear();
  }

  /**
   * 只结束属于某些账号的进程（并行模式切回切换模式、移除账号），清掉这些会话的缓存；其它会话不受影响。
   * match 收到进程的账号 id（没有账号信息的进程为 null）。
   */
  async stopAccounts(match: (accountId: string | null) => boolean, timeoutMs = 5000): Promise<void> {
    const rs = [...this.runners.values()].filter((r) => match(r.accountId));
    if (!rs.length) return;
    for (const r of rs) r.shutdown(Math.min(2000, timeoutMs));
    const deadline = Date.now() + timeoutMs;
    while (rs.some((r) => this.runners.get(r.sessionId) === r) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    for (const r of rs) {
      if (this.runners.get(r.sessionId) === r) {
        r.killSync();
        this.runners.delete(r.sessionId);
      }
      const id = r.sessionId;
      this.cancelLiveContext(id);
      this.cancelMcpRetry(id);
      this.settingsCache.delete(id);
      this.contextCache.delete(id);
      this.probing.delete(id);
      this.initSkills.delete(id);
      this.initSlash.delete(id);
      this.initTools.delete(id);
    }
  }

  /** 通知所有前端：账号变了（reload = 整页刷新） */
  notifyAccount(reload: boolean): void {
    this.broadcast({ t: 'account.changed', reload });
  }

  /** 通知所有前端：Antigravity 账号列表 / 当前账号 / 登录状态变了 */
  notifyAgy(): void {
    this.broadcast({ t: 'agy.changed' });
  }

  /** 通知所有前端：子代理配置 / 代理类型开关 / 后端可用性变了 */
  notifySubagents(): void {
    this.broadcast({ t: 'subagents.changed' });
  }

  /** 同步强杀（process 'exit' 事件里使用）。 */
  killAllSync(): void {
    for (const r of this.runners.values()) r.killSync();
  }

  /** 会话所在的工作目录：该会话有过进程时的 cwd（文件预览用它划定可读范围）；没有则 undefined，调用方再查会话记录 */
  knownCwd(id: string): string | undefined {
    return this.cwdOf.get(id);
  }

  /** 正在执行（starting / running）的会话数；空闲的探测进程不算。传 accountId 只数该账号的。 */
  runningCount(accountId?: string): number {
    let n = 0;
    for (const r of this.runners.values()) {
      if (accountId !== undefined && r.accountId !== accountId) continue;
      if (r.status === 'running' || r.status === 'starting') n++;
    }
    return n;
  }

  /** 某个账号的 claude 进程数（含空闲的） */
  processCount(accountId: string): number {
    let n = 0;
    for (const r of this.runners.values()) if (r.accountId === accountId) n++;
    return n;
  }

  /** 会话当前进程所属的账号；没有进程为 null */
  runnerAccount(sessionId: string): string | null {
    return this.runners.get(sessionId)?.accountId ?? null;
  }

  get runnerCount(): number {
    return this.runners.size;
  }
}

type ClientMsgConfig = Extract<ClientMsg, { t: 'config' }>['config'];
