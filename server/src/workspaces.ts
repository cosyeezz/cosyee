// 工作空间列表与持久化：~/.cosyee/state.json = { workspaces, current, unread }，原子写。
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SUBAGENTS, MODEL_ALIASES, SKILL_MODES, SUBAGENT_KINDS, type AccountMode, type Effort, type ModelAlias, type SessionConfig, type SkillMode, type StopInfo, type StopKind, type StopState, type SubagentConfig, type SubagentKind, type SubagentTypeOverrides, type Workspace } from '@cosyee/shared';
import { cosyeeHome, isSafeId, normalizeDir, pathKey } from './paths.js';

export interface PersistedState {
  workspaces: Workspace[];
  current: string | null;
  unread: Record<string, true>;
  /** 上次选的模型与思考强度（全局），新会话与未改过配置的会话沿用 */
  defaults: SessionConfig | null;
  /** 手动置顶：会话 id -> 所属工作空间与置顶时间；一直保留到取消置顶 */
  pinned: Record<string, { cwd: string; pinnedAt: number }>;
  /** 自动置顶：执行中的会话自动置顶；at = 最近一次处于执行中 / 停止的时间，停止后空闲满 30 分钟失效 */
  autoPinned: Record<string, { cwd: string; at: number }>;
  /** 已删除（软删除）：会话记录文件原样保留，只是从列表隐藏；title 为删除时的快照 */
  deleted: Record<string, { cwd: string; title: string; deletedAt: number }>;
  /** skill 状态（全局）：启动会话时经 --settings、运行中经 apply_flag_settings 下发；不写 ~/.claude 配置 */
  skillOverrides: Record<string, SkillMode>;
  /** 每个会话最近一次使用的配置（模型 / 思考强度 / ultracode）：发送与切换配置时写入，刷新页面后据此还原 */
  sessionConfigs: Record<string, SessionConfig>;
  /**
   * 分支（fork）出来的会话 → 它的来源会话：新会话 id -> { cwd, src, at }。
   * 分支只复制主记录，子代理记录仍在来源会话的 <src>/subagents/ 下，打开分支点之前的子代理面板要顺着这条链去找。
   */
  forks: Record<string, { cwd: string; src: string; at: number }>;
  /** 被关闭的内置工具名（全局）：启动会话时经 --settings permissions.deny 下发，运行中经 apply_flag_settings */
  disabledTools: string[];
  /** 最近一次 system/init 报告的内置工具名：探测进程收不到 init，服务重启后也要能列出工具 */
  knownTools: string[];
  /** 最近一次从会话记录观测到的懒加载工具名：新会话尚未产生记录或已停用工具的分类兜底 */
  knownDeferredTools: string[];
  /** 被关闭的智能体名（全局）：以 Agent(名字) 并入 permissions.deny 下发 */
  disabledAgents: string[];
  /**
   * 自动压缩窗口（全局，token 数）：经 --settings env.CLAUDE_CODE_AUTO_COMPACT_WINDOW 下发，运行中经 apply_flag_settings；
   * null = 不覆盖（沿用 ~/.claude/settings.json 或 CLI 默认）
   */
  compactWindow: number | null;
  /** 子代理配置（全局）：类型（native / claude / agy）及各自的默认模型与强度 */
  subagents: SubagentConfig;
  /**
   * 额外账号（默认账号 = 基础配置目录，不在列表里）；active 为 null 表示默认账号。
   * mode：switch = 切换模式（默认），parallel = 并行模式（只管主代理）。
   * sessions：会话 id → 它最近一次发消息时用的账号 id（'default' 或添加的账号）；并行模式下会话按它启动进程。
   * subagent：子代理按类型选用的账号 id（claude 委派用，与主代理模式和当前账号无关；账号不存在时退回 'default'）。
   */
  accounts: {
    list: StoredAccount[];
    active: string | null;
    mode: AccountMode;
    sessions: Record<string, string>;
    subagent: { claude: string };
  };
  /** Antigravity（agy）额外账号（默认账号 = 本机系统凭据，不在列表里）；active 为 null 表示默认账号 */
  agyAccounts: { list: StoredAccount[]; active: string | null };
  /** 会话因错误停止的记录（自动重试 / 显示错误原因），按 sessionId 索引 */
  stops: Record<string, StopInfo>;
  /** 执行中的轮次，服务关闭/崩溃后启动时据此补记中断 */
  inflight: Record<string, { cwd: string; at: number }>;
}

export interface StoredAccount {
  /** 短 id，同时是 accountsRoot 下的子目录名 */
  id: string;
  /** 用户起的备注名（工作 / 个人…），可为空 */
  label: string;
  /** 配置目录（绝对路径） */
  dir: string;
  createdAt: number;
  /** 仅服务端用于判重的身份哈希（如邮箱 sha256），绝不下发 */
  identityHash?: string;
}

/** 账号 id：只允许短的安全字符（同时是目录名） */
export const ACCOUNT_ID_RE = /^[a-z0-9]{4,32}$/;

/** skill 名（含插件前缀）：只允许常见字符，避免拼进命令行时出问题 */
export const SKILL_NAME_RE = /^[A-Za-z0-9._:@+/-]{1,200}$/;

/**
 * 工具面板管理的工具名：内置工具（Bash / Read / WebFetch …，字母数字下划线）+ Cosyee 自带 MCP 服务器的工具（mcp__cosyee__*）。
 * 其它 mcp__ 工具由 MCP 一节按服务器管理，不在此列（测试见 sessionConfig.test.ts）。
 */
export const TOOL_NAME_RE = /^(?:(?!mcp__)[A-Za-z][A-Za-z0-9_]{0,63}|mcp__cosyee__[A-Za-z][A-Za-z0-9_]{0,63})$/;

/** 智能体名（Explore / my-reviewer / 插件:名字）：不能含括号、空白，拼成 Agent(名字) 规则才不会歧义 */
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$/;

/** 自动压缩窗口的允许范围（触发点 = 窗口 - 33k，窗口太小会一直压缩） */
export const COMPACT_WINDOW_MIN = 50_000;
export const COMPACT_WINDOW_MAX = 1_000_000;

/** 合法的压缩窗口原样返回（取整），否则 null */
export function sanitizeCompactWindow(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  return n >= COMPACT_WINDOW_MIN && n <= COMPACT_WINDOW_MAX ? n : null;
}

const DELEGATE_MODEL_RE = /^[A-Za-z0-9._:/@+-]{1,120}$/;
const MAX_SUBAGENT_OVERRIDES = 200;

function sanitizeAgentOverrides<M extends string>(
  raw: unknown,
  checkModel: (m: unknown) => M | null,
): SubagentTypeOverrides<M> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: SubagentTypeOverrides<M> = {};
  let count = 0;
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_SUBAGENT_OVERRIDES) break;
    if (!AGENT_NAME_RE.test(name)) continue;
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const item = v as Record<string, unknown>;
    let model: M | null = null;
    if (item.model !== null && item.model !== undefined) {
      model = checkModel(item.model);
      if (model === null) continue;
    }
    let effort: Effort | null = null;
    if (item.effort !== null && item.effort !== undefined) {
      if (!EFFORT_IDS.includes(item.effort as Effort)) continue;
      effort = item.effort as Effort;
    }
    if (model === null && effort === null) continue;
    out[name] = { model, effort };
    count++;
  }
  return count > 0 ? out : undefined;
}

/** 接口提交的子代理配置：顶层结构不合法返回 null；agents 内的非法项静默丢弃 */
export function parseSubagents(v: unknown): SubagentConfig | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  if (!isObj(o.native) || !isObj(o.claude) || !isObj(o.agy)) return null;
  if (o.native.agents !== undefined && !isObj(o.native.agents)) return null;
  if (o.claude.agents !== undefined && !isObj(o.claude.agents)) return null;
  if (o.agy.agents !== undefined && !isObj(o.agy.agents)) return null;
  const c = sanitizeSubagents(v);
  const same =
    o.kind === c.kind &&
    o.native.model === c.native.model &&
    o.native.effort === c.native.effort &&
    (o.claude.model ?? null) === c.claude.model &&
    (o.claude.effort ?? null) === c.claude.effort &&
    (o.agy.model ?? null) === c.agy.model &&
    (o.agy.effort ?? null) === c.agy.effort;
  return same ? c : null;
}

/** 子代理配置：非法的字段落回默认值；agents 内的非法项或全 null 项直接丢弃 */
export function sanitizeSubagents(v: unknown): SubagentConfig {
  const obj = (x: unknown): Record<string, unknown> => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {});
  const root = obj(v);
  const native = obj(root.native);
  const claude = obj(root.claude);
  const agy = obj(root.agy);
  const d = DEFAULT_SUBAGENTS;
  const checkAlias = (m: unknown): ModelAlias | null => (MODEL_ALIASES.includes(m as ModelAlias) ? (m as ModelAlias) : null);
  const checkAgyModel = (m: unknown): string | null => (typeof m === 'string' && DELEGATE_MODEL_RE.test(m) ? m : null);
  const nativeAgents = sanitizeAgentOverrides(native.agents, checkAlias);
  const claudeAgents = sanitizeAgentOverrides(claude.agents, checkAlias);
  const agyAgents = sanitizeAgentOverrides(agy.agents, checkAgyModel);
  return {
    kind: SUBAGENT_KINDS.includes(root.kind as SubagentKind) ? (root.kind as SubagentKind) : d.kind,
    native: {
      model: MODEL_ALIASES.includes(native.model as ModelAlias) ? (native.model as ModelAlias) : d.native.model,
      effort: EFFORT_IDS.includes(native.effort as Effort) ? (native.effort as Effort) : d.native.effort,
      ...(nativeAgents ? { agents: nativeAgents } : {}),
    },
    claude: {
      model: MODEL_ALIASES.includes(claude.model as ModelAlias) ? (claude.model as ModelAlias) : d.claude.model,
      effort: EFFORT_IDS.includes(claude.effort as Effort) ? (claude.effort as Effort) : d.claude.effort,
      ...(claudeAgents ? { agents: claudeAgents } : {}),
    },
    agy: {
      model: typeof agy.model === 'string' && DELEGATE_MODEL_RE.test(agy.model) ? agy.model : d.agy.model,
      effort: EFFORT_IDS.includes(agy.effort as Effort) ? (agy.effort as Effort) : d.agy.effort,
      ...(agyAgents ? { agents: agyAgents } : {}),
    },
  };
}

/** 从持久化对象读取子代理配置；没有 subagents 时从旧版 agentModels + nativeAgents 迁移 */
export function migrateSubagents(raw: Record<string, unknown>): SubagentConfig {
  if (raw.subagents && typeof raw.subagents === 'object' && !Array.isArray(raw.subagents)) {
    return sanitizeSubagents(raw.subagents);
  }
  const old = raw.agentModels && typeof raw.agentModels === 'object' && !Array.isArray(raw.agentModels)
    ? (raw.agentModels as Record<string, unknown>)
    : {};
  const kind: SubagentKind = raw.nativeAgents === false ? 'agy' : 'native';
  return sanitizeSubagents({
    kind,
    native: old.claude,
    claude: DEFAULT_SUBAGENTS.claude,
    agy: old.agy,
  });
}

const MODEL_ID_RE = /^[A-Za-z0-9._\[\]-]{1,100}$/;
const IDENTITY_HASH_RE = /^[0-9a-f]{64}$/;

function emptyState(): PersistedState {
  return { workspaces: [], current: null, unread: {}, defaults: null, pinned: {}, autoPinned: {}, deleted: {}, skillOverrides: {}, sessionConfigs: {}, forks: {}, disabledTools: [], knownTools: [], knownDeferredTools: [], disabledAgents: [], compactWindow: null, subagents: structuredClone(DEFAULT_SUBAGENTS), accounts: { list: [], active: null, mode: 'switch', sessions: {}, subagent: { claude: 'default' } }, agyAccounts: { list: [], active: null }, stops: {}, inflight: {} };
}

function entries(v: unknown): [string, Record<string, unknown>][] {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return [];
  const out: [string, Record<string, unknown>][] = [];
  for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
    if (e && typeof e === 'object' && typeof (e as Record<string, unknown>).cwd === 'string') out.push([k, e as Record<string, unknown>]);
  }
  return out;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function sanitize(raw: unknown): PersistedState {
  const s = emptyState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.workspaces)) {
    for (const w of o.workspaces) {
      if (w && typeof (w as Workspace).path === 'string') {
        const p = (w as Workspace).path;
        s.workspaces.push({ path: p, name: typeof (w as Workspace).name === 'string' ? (w as Workspace).name : workspaceName(p) });
      }
    }
  }
  if (typeof o.current === 'string') s.current = o.current;
  if (o.unread && typeof o.unread === 'object') {
    for (const [k, v] of Object.entries(o.unread as Record<string, unknown>)) if (v) s.unread[k] = true;
  }
  const d = o.defaults as Record<string, unknown> | undefined;
  if (d && typeof d.model === 'string' && /^[A-Za-z0-9._\[\]-]{1,100}$/.test(d.model) && EFFORT_IDS.includes(d.effort as Effort)) {
    s.defaults = { model: d.model, effort: d.effort as Effort };
  }
  for (const [id, e] of entries(o.pinned)) s.pinned[id] = { cwd: e.cwd as string, pinnedAt: num(e.pinnedAt, 0) };
  for (const [id, e] of entries(o.autoPinned)) s.autoPinned[id] = { cwd: e.cwd as string, at: num(e.at, 0) };
  for (const [id, e] of entries(o.deleted)) {
    s.deleted[id] = { cwd: e.cwd as string, title: typeof e.title === 'string' ? e.title : '', deletedAt: num(e.deletedAt, 0) };
  }
  if (o.skillOverrides && typeof o.skillOverrides === 'object' && !Array.isArray(o.skillOverrides)) {
    for (const [k, v] of Object.entries(o.skillOverrides as Record<string, unknown>)) {
      if (SKILL_NAME_RE.test(k) && SKILL_MODES.includes(v as SkillMode)) s.skillOverrides[k] = v as SkillMode;
    }
  }
  if (o.sessionConfigs && typeof o.sessionConfigs === 'object' && !Array.isArray(o.sessionConfigs)) {
    for (const [sid, v] of Object.entries(o.sessionConfigs as Record<string, unknown>)) {
      const c = v as Record<string, unknown> | null;
      if (!isSafeId(sid) || !c || typeof c !== 'object') continue;
      if (typeof c.model !== 'string' || !MODEL_ID_RE.test(c.model) || !EFFORT_IDS.includes(c.effort as Effort)) continue;
      s.sessionConfigs[sid] = {
        model: c.model,
        effort: c.effort as Effort,
        ...(c.ultracode === true ? { ultracode: true } : {}),
        ...(c.permissionMode === 'plan' ? { permissionMode: 'plan' as const } : {}), // 只认 plan / auto，auto 是缺省不存
      };
    }
  }
  for (const [id, e] of entries(o.forks)) {
    if (!isSafeId(id) || !isSafeId(e.src) || e.src === id) continue;
    s.forks[id] = { cwd: e.cwd as string, src: e.src, at: num(e.at, 0) };
  }
  if (Array.isArray(o.disabledTools)) {
    for (const t of o.disabledTools) {
      if (typeof t === 'string' && TOOL_NAME_RE.test(t) && !s.disabledTools.includes(t)) s.disabledTools.push(t);
    }
  }
  if (Array.isArray(o.disabledAgents)) {
    for (const t of o.disabledAgents) {
      if (typeof t === 'string' && AGENT_NAME_RE.test(t) && !s.disabledAgents.includes(t)) s.disabledAgents.push(t);
    }
  }
  if (Array.isArray(o.knownTools)) {
    for (const t of o.knownTools) {
      if (typeof t === 'string' && TOOL_NAME_RE.test(t) && !s.knownTools.includes(t)) s.knownTools.push(t);
    }
  }
  if (Array.isArray(o.knownDeferredTools)) {
    for (const t of o.knownDeferredTools) {
      if (typeof t === 'string' && TOOL_NAME_RE.test(t) && !s.knownDeferredTools.includes(t)) s.knownDeferredTools.push(t);
    }
  }
  s.compactWindow = sanitizeCompactWindow(o.compactWindow);
  s.subagents = migrateSubagents(o);
  const acc = o.accounts as Record<string, unknown> | undefined;
  if (acc && typeof acc === 'object') {
    if (Array.isArray(acc.list)) {
      for (const a of acc.list as Record<string, unknown>[]) {
        if (!a || typeof a !== 'object') continue;
        if (typeof a.id !== 'string' || !ACCOUNT_ID_RE.test(a.id) || typeof a.dir !== 'string' || !path.isAbsolute(a.dir)) continue;
        if (s.accounts.list.some((x) => x.id === a.id)) continue;
        s.accounts.list.push({
          id: a.id,
          label: typeof a.label === 'string' ? a.label.slice(0, 40) : '',
          dir: a.dir,
          createdAt: num(a.createdAt, 0),
        });
      }
    }
    if (typeof acc.active === 'string' && s.accounts.list.some((x) => x.id === acc.active)) s.accounts.active = acc.active;
    if (acc.mode === 'parallel') s.accounts.mode = 'parallel';
    if (acc.sessions && typeof acc.sessions === 'object' && !Array.isArray(acc.sessions)) {
      for (const [sid, v] of Object.entries(acc.sessions as Record<string, unknown>)) {
        if (!isSafeId(sid) || typeof v !== 'string') continue;
        if (v === 'default' || s.accounts.list.some((x) => x.id === v)) s.accounts.sessions[sid] = v;
      }
    }
    if (acc.subagent === undefined) {
      // 老数据没有 subagent：迁移当时取主代理的 active 账号，没有就 'default'
      s.accounts.subagent.claude = s.accounts.active ?? 'default';
    } else if (acc.subagent && typeof acc.subagent === 'object' && !Array.isArray(acc.subagent)) {
      const cid = (acc.subagent as Record<string, unknown>).claude;
      if (typeof cid === 'string' && (cid === 'default' || s.accounts.list.some((x) => x.id === cid))) {
        s.accounts.subagent.claude = cid;
      }
    }
  }
  const agy = o.agyAccounts as Record<string, unknown> | undefined;
  if (agy && typeof agy === 'object') {
    if (Array.isArray(agy.list)) {
      for (const a of agy.list as Record<string, unknown>[]) {
        if (!a || typeof a !== 'object') continue;
        if (typeof a.id !== 'string' || !ACCOUNT_ID_RE.test(a.id) || typeof a.dir !== 'string' || !path.isAbsolute(a.dir)) continue;
        const dir = a.dir;
        if (s.agyAccounts.list.some((x) => x.id === a.id || pathKey(x.dir) === pathKey(dir))) continue;
        const hash = typeof a.identityHash === 'string' && IDENTITY_HASH_RE.test(a.identityHash) ? a.identityHash : undefined;
        s.agyAccounts.list.push({
          id: a.id,
          label: typeof a.label === 'string' ? a.label.slice(0, 40) : '',
          dir: a.dir,
          createdAt: num(a.createdAt, 0),
          ...(hash ? { identityHash: hash } : {}),
        });
      }
    }
    if (typeof agy.active === 'string' && s.agyAccounts.list.some((x) => x.id === agy.active)) s.agyAccounts.active = agy.active;
  }
  if (o.stops && typeof o.stops === 'object' && !Array.isArray(o.stops)) {
    for (const [sid, v] of Object.entries(o.stops as Record<string, unknown>)) {
      const e = v as Record<string, unknown> | null;
      if (!isSafeId(sid) || !e || typeof e !== 'object') continue;
      if (!STOP_KINDS.includes(e.kind as StopKind) || !STOP_STATES.includes(e.state as StopState)) continue;
      if (typeof e.reason !== 'string') continue;
      const attempts = Math.max(0, Math.floor(num(e.attempts, 0)));
      const info: StopInfo = {
        kind: e.kind as StopKind,
        reason: e.reason,
        attempts,
        state: e.state as StopState,
        at: num(e.at, 0),
      };
      if (typeof e.retryAt === 'number' && Number.isFinite(e.retryAt)) info.retryAt = e.retryAt;
      s.stops[sid] = info;
    }
  }
  for (const [id, e] of entries(o.inflight)) {
    if (!isSafeId(id)) continue;
    s.inflight[id] = { cwd: e.cwd as string, at: num(e.at, 0) };
  }
  // 已删除的会话不可能同时置顶，也不再保留停止重试记录与执行中标记
  for (const id of Object.keys(s.deleted)) {
    delete s.pinned[id];
    delete s.autoPinned[id];
    delete s.stops[id];
    delete s.inflight[id];
  }
  return s;
}

const EFFORT_IDS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const STOP_KINDS: StopKind[] = ['rate_limit', 'transient', 'fatal', 'interrupted'];
const STOP_STATES: StopState[] = ['waiting', 'retrying', 'gave_up', 'stopped'];

export function workspaceName(p: string): string {
  const base = path.basename(p);
  return base || p;
}

/** 持久化存储：内存缓存 + 原子写（临时文件再 rename），写入串行化。 */
export class StateStore {
  private data: PersistedState;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private tmpSeq = 0;

  constructor(private readonly file: string = path.join(cosyeeHome(), 'state.json')) {
    this.data = this.load();
  }

  private load(): PersistedState {
    try {
      return sanitize(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      return emptyState();
    }
  }

  get state(): PersistedState {
    return this.data;
  }

  /** 修改后调用，异步原子落盘（不阻塞调用方）。 */
  save(): void {
    this.dirty = true;
    this.writing = this.writing.then(() => this.flush()).catch(() => {});
  }

  /** 等待所有挂起的写入完成（退出前 / 测试用）。 */
  async idle(): Promise<void> {
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

export class Workspaces {
  constructor(private readonly store: StateStore) {}

  list(): { current: string | null; list: Workspace[] } {
    const s = this.store.state;
    return { current: s.current, list: s.workspaces.map((w) => ({ ...w })) };
  }

  /** 加入列表（去重、路径规范化）并返回条目；不改 current。 */
  add(p: string): Workspace {
    const norm = normalizeDir(p);
    const s = this.store.state;
    const key = pathKey(norm);
    const hit = s.workspaces.find((w) => pathKey(w.path) === key);
    if (hit) return { ...hit };
    const w: Workspace = { path: norm, name: workspaceName(norm) };
    s.workspaces.push(w);
    this.store.save();
    return { ...w };
  }

  /** 设为当前；不在列表里则要求是现存目录并自动加入。 */
  setCurrent(p: string): void {
    const norm = normalizeDir(p);
    const s = this.store.state;
    const key = pathKey(norm);
    let hit = s.workspaces.find((w) => pathKey(w.path) === key);
    if (!hit) {
      let isDir = false;
      try {
        isDir = fs.statSync(norm).isDirectory();
      } catch { /* 不存在 */ }
      if (!isDir) throw new HttpError(400, `目录不存在: ${p}`);
      hit = this.add(norm);
    }
    s.current = hit.path;
    this.store.save();
  }

  /** 移到列表最前（持久化顺序）。不在列表里则 404。 */
  moveToTop(p: string): void {
    const s = this.store.state;
    const key = pathKey(p);
    const i = s.workspaces.findIndex((w) => pathKey(w.path) === key);
    if (i < 0) throw new HttpError(404, '工作空间不在列表里');
    if (i > 0) {
      const [w] = s.workspaces.splice(i, 1);
      s.workspaces.unshift(w!);
      this.store.save();
    }
  }

  /**
   * 仅从 Cosyee 的最近列表移除，绝不碰磁盘上的任何文件。
   * 移除的是当前工作空间时，current 切到原位置的下一个（没有则上一个），都没有则为 null。
   */
  remove(p: string): void {
    const s = this.store.state;
    const key = pathKey(p);
    const i = s.workspaces.findIndex((w) => pathKey(w.path) === key);
    if (i < 0) throw new HttpError(404, '工作空间不在列表里');
    const wasCurrent = s.current !== null && pathKey(s.current) === key;
    s.workspaces.splice(i, 1);
    if (wasCurrent) s.current = (s.workspaces[i] ?? s.workspaces[i - 1])?.path ?? null;
    this.store.save();
  }

  /** 列表里的工作空间（按路径比较），没有返回 null */
  find(p: string): Workspace | null {
    const key = pathKey(p);
    const w = this.store.state.workspaces.find((x) => pathKey(x.path) === key);
    return w ? { ...w } : null;
  }
}

/** 带状态码的错误，http 层据此返回非 2xx。 */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
