// 工作空间列表与持久化：~/.cosyee/state.json = { workspaces, current, unread }，原子写。
import fs from 'node:fs';
import path from 'node:path';
import { SKILL_MODES, type AccountMode, type Effort, type SessionConfig, type SkillMode, type Workspace } from '@cosyee/shared';
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
  /** 被关闭的智能体名（全局）：以 Agent(名字) 并入 permissions.deny 下发 */
  disabledAgents: string[];
  /**
   * 自动压缩窗口（全局，token 数）：经 --settings env.CLAUDE_CODE_AUTO_COMPACT_WINDOW 下发，运行中经 apply_flag_settings；
   * null = 不覆盖（沿用 ~/.claude/settings.json 或 CLI 默认）
   */
  compactWindow: number | null;
  /**
   * 额外账号（默认账号 = 基础配置目录，不在列表里）；active 为 null 表示默认账号。
   * mode：switch = 切换模式（默认），parallel = 并行模式。
   * sessions：会话 id → 它最近一次发消息时用的账号 id（'default' 或添加的账号）；并行模式下会话按它启动进程
   */
  accounts: { list: StoredAccount[]; active: string | null; mode: AccountMode; sessions: Record<string, string> };
}

export interface StoredAccount {
  /** 短 id，同时是 accountsRoot 下的子目录名 */
  id: string;
  /** 用户起的备注名（工作 / 个人…），可为空 */
  label: string;
  /** 配置目录（绝对路径） */
  dir: string;
  createdAt: number;
}

/** 账号 id：只允许短的安全字符（同时是目录名） */
export const ACCOUNT_ID_RE = /^[a-z0-9]{4,32}$/;

/** skill 名（含插件前缀）：只允许常见字符，避免拼进命令行时出问题 */
export const SKILL_NAME_RE = /^[A-Za-z0-9._:@+/-]{1,200}$/;

/** 内置工具名（Bash / Read / WebFetch …）：字母数字下划线；mcp__ 工具不在此列 */
export const TOOL_NAME_RE = /^(?!mcp__)[A-Za-z][A-Za-z0-9_]{0,63}$/;

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

const MODEL_ID_RE = /^[A-Za-z0-9._\[\]-]{1,100}$/;

function emptyState(): PersistedState {
  return { workspaces: [], current: null, unread: {}, defaults: null, pinned: {}, autoPinned: {}, deleted: {}, skillOverrides: {}, sessionConfigs: {}, forks: {}, disabledTools: [], knownTools: [], disabledAgents: [], compactWindow: null, accounts: { list: [], active: null, mode: 'switch', sessions: {} } };
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
  if (!raw || typeof raw !== 'object') return s;
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
  s.compactWindow = sanitizeCompactWindow(o.compactWindow);
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
  }
  // 已删除的会话不可能同时置顶
  for (const id of Object.keys(s.deleted)) {
    delete s.pinned[id];
    delete s.autoPinned[id];
  }
  return s;
}

const EFFORT_IDS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function workspaceName(p: string): string {
  const base = path.basename(p);
  return base || p;
}

/** 持久化存储：内存缓存 + 原子写（临时文件再 rename），写入串行化。 */
export class StateStore {
  private data: PersistedState;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

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
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
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
