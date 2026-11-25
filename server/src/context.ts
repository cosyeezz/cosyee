// get_context_usage 响应 -> 前端的 ContextUsage（换算规则见 shared/src/protocol.ts 与 spike/FINDINGS2.md B1 §4）。
// skills / mcpServers 另外合并 system/init 的 skills、get_settings 的 effective.skillOverrides 与 mcp_status。
import { DELEGATE_TOOLS, MCP_SERVER } from './delegate/mcp.js';
import type { DiskSkill } from './skillsDisk.js';
import type { ContextMcpServer, ContextSkill, ContextUsage, SkillMode } from '@cosyee/shared';

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const SKILL_NAME_RE = /^[A-Za-z0-9._:@+/-]{1,200}$/;
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export interface ContextExtra {
  /** 最近一次 system/init 的 skills（带插件前缀；不含已关闭的） */
  initSkills?: string[] | null;
  /** get_settings 的 effective.skillOverrides（用户设置与 Cosyee 下发的合并结果） */
  overrides?: Record<string, unknown> | null;
  /** Cosyee 自己保存的 skill 状态；已关闭的 skill 不在 init 里，靠它留在列表上 */
  cosyeeOverrides?: Record<string, SkillMode> | null;
  /** 磁盘扫描到的全部 skill（含没加载 / 已关闭的）：保证它们都列在面板上，并标出哪些能移除 */
  diskSkills?: DiskSkill[] | null;
  /** 刚被移除的 skill（正在运行的进程里还加载着它，列表里要藏起来） */
  hidden?: string[] | null;
  /** mcp_status 的响应 */
  mcpStatus?: Raw | null;
  /** Cosyee 保存的已停用内置工具 */
  disabledTools?: string[] | null;
  /** Cosyee 保存的已关闭智能体 */
  disabledAgents?: string[] | null;
  /** Cosyee 保存的「原生子代理」开关 */
  nativeAgents?: boolean | null;
  /** 内置工具名（init.tools 去掉 mcp__ 工具） */
  tools?: string[] | null;
  /** 斜杠命令名（system/init 的 slash_commands 或 initialize 的 commands） */
  slashCommands?: string[] | null;
  /** Cosyee 保存的自动压缩窗口（null = 不覆盖） */
  compactWindow?: number | null;
  /** skill 名 → 描述原文（键为完整名或去掉插件前缀的名字） */
  skillDescriptions?: ReadonlyMap<string, string> | null;
  /** 智能体名 → 描述原文 */
  agentDescriptions?: ReadonlyMap<string, string> | null;
}

/** 描述原文的长度上限（防止异常大的 frontmatter 撑大每次下发的上下文数据） */
export const DESC_MAX = 4000;
const clip = (s: string): string => (s.length > DESC_MAX ? `${s.slice(0, DESC_MAX)}…` : s);

/** 插件 skill 名去掉前缀：anthropic-skills:pdf -> pdf */
export const skillBase = (name: string): string => name.slice(name.lastIndexOf(':') + 1);

/** CLI 拼 MCP 工具名时对服务器名的规范化（mcp__<server>__<tool>） */
export const normMcpName = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, '_');

const toMode = (v: unknown): SkillMode | null =>
  v === 'off' ? 'off' : v === 'user-invocable-only' ? 'user-invocable-only' : v === 'on' || v === 'name-only' ? 'on' : null;

function buildSkills(raw: Raw, extra: ContextExtra): ContextSkill[] {
  const fm: Raw[] = Array.isArray(raw.skills?.skillFrontmatter) ? raw.skills.skillFrontmatter : [];
  const overrides: Record<string, unknown> = {
    ...(extra.overrides && typeof extra.overrides === 'object' ? extra.overrides : {}),
    ...(extra.cosyeeOverrides ?? {}),
  };
  const modeOf = (name: string): SkillMode => toMode(overrides[name]) ?? toMode(overrides[skillBase(name)]) ?? 'on';

  const descOf = (name: string): { description?: string } => {
    const d = extra.skillDescriptions?.get(name) ?? extra.skillDescriptions?.get(skillBase(name));
    return d ? { description: clip(d) } : {};
  };
  const hidden = new Set(extra.hidden ?? []);
  const disk = new Map((extra.diskSkills ?? []).map((d) => [d.name, d]));
  const out: ContextSkill[] = [];
  const seen = new Set<string>();
  const used = new Set<number>();
  const push = (name: string, f: Raw | null): void => {
    if (!name || seen.has(name) || hidden.has(name)) return;
    seen.add(name);
    const mode = modeOf(name);
    out.push({
      name,
      mode,
      tokens: f && mode === 'on' ? num(f.tokens) : null,
      source: typeof f?.source === 'string' ? f.source : (disk.get(name)?.source ?? (name.includes(':') ? 'plugin' : null)),
      ...(extra.diskSkills ? { removable: disk.get(name)?.removable === true } : {}),
      ...descOf(name),
    });
  };
  const findFm = (name: string): Raw | null => {
    const base = skillBase(name);
    const i = fm.findIndex((f, k) => !used.has(k) && (f.name === name || f.name === base));
    if (i < 0) return null;
    used.add(i);
    return fm[i]!;
  };

  // 先 init 里的（带前缀的全名），再 Cosyee 设过状态的（已关闭的不在 init 里），各自按 base 名匹配 frontmatter 取 token
  for (const n of extra.initSkills ?? []) if (typeof n === 'string') push(n, findFm(n));
  const cosyeeKeys = Object.keys(extra.cosyeeOverrides ?? {});
  const prefixedBases = new Set<string>();
  for (const n of extra.initSkills ?? []) if (typeof n === 'string' && n.includes(':')) prefixedBases.add(skillBase(n));
  for (const n of cosyeeKeys) if (n.includes(':')) prefixedBases.add(skillBase(n));
  for (const n of cosyeeKeys) {
    if (seen.has(n)) continue;
    // 裸名已有带插件前缀的同名 skill 时，不作为独立条目列出（modeOf 仍会回退读取它的设置）
    if (!n.includes(':') && prefixedBases.has(n)) continue;
    const f = findFm(n);
    // 设成「开」却既不在 init 也不在 frontmatter：多半已被删掉，不再列出
    // 但 init 数据还没到（initSkills 为 null）时不能下此结论，保留以免误漏
    if (!f && modeOf(n) === 'on' && extra.initSkills !== null) continue;
    push(n, f);
  }
  fm.forEach((f, k) => {
    if (used.has(k) || typeof f.name !== 'string') return;
    used.add(k);
    push(f.name, f);
  });
  // 磁盘上有、但没加载（已关闭、或本会话还没启动过）的 skill
  for (const d of extra.diskSkills ?? []) push(d.name, findFm(d.name));
  // settings.json 里设成「手动 / 关」、但上面都没找到的（例如别的项目 / 已卸载的插件留下的条目）
  const seenBase = new Set(out.map((s) => skillBase(s.name)));
  for (const [k, v] of Object.entries(extra.overrides ?? {})) {
    const m = toMode(v);
    if (m && m !== 'on' && SKILL_NAME_RE.test(k) && !seen.has(k) && !seenBase.has(skillBase(k))) push(k, null);
  }
  // 按名字排序：开关后 init 里的顺序会变，排序让列表位置稳定
  return out.sort((x, y) => skillBase(x.name).localeCompare(skillBase(y.name)) || x.name.localeCompare(y.name));
}

function buildMcpServers(mcpTools: { name: string; server: string; tokens: number }[], status: Raw | null | undefined): ContextMcpServer[] {
  const tokenOf = new Map(mcpTools.map((t) => [t.name, t.tokens]));
  const list: Raw[] | null = Array.isArray(status?.mcpServers) ? status!.mcpServers : null;

  if (!list) {
    const by = new Map<string, ContextMcpServer>();
    for (const t of mcpTools) {
      let s = by.get(t.server);
      if (!s) by.set(t.server, (s = { name: t.server, status: 'unknown', tokens: 0, tools: [] }));
      const prefix = `mcp__${t.server}__`;
      s.tools.push({ name: t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name, tokens: t.tokens });
      s.tokens += t.tokens;
    }
    return [...by.values()];
  }

  return list
    .filter((s) => typeof s?.name === 'string')
    .map((s) => {
      const norm = normMcpName(s.name);
      const prefix = `mcp__${norm}__`;
      const tools: ContextMcpServer['tools'] = [];
      const names = new Set<string>();
      for (const t of Array.isArray(s.tools) ? (s.tools as Raw[]) : []) {
        const raw = typeof t === 'string' ? t : typeof t?.name === 'string' ? t.name : null;
        if (!raw) continue;
        const full = raw.startsWith('mcp__') ? raw : prefix + raw;
        const short = full.startsWith(prefix) ? full.slice(prefix.length) : raw;
        if (names.has(short)) continue;
        names.add(short);
        const desc = typeof t === 'object' && typeof t?.description === 'string' ? t.description.trim() : '';
        tools.push({ name: short, tokens: tokenOf.get(full) ?? null, ...(desc ? { description: clip(desc) } : {}) });
      }
      // mcp_status 没列出、但上下文里有的工具
      for (const t of mcpTools) {
        if (t.server !== norm) continue;
        const short = t.name.startsWith(prefix) ? t.name.slice(prefix.length) : t.name;
        if (names.has(short)) continue;
        names.add(short);
        tools.push({ name: short, tokens: t.tokens });
      }
      return {
        name: s.name as string,
        status: typeof s.status === 'string' ? s.status : 'unknown',
        tokens: tools.reduce((a, t) => a + (t.tokens ?? 0), 0),
        tools,
      };
    });
}

/** Cosyee 自带 MCP 工具的定义原文（描述 + 参数 schema）：就是注册给 CLI 的那份，mcp_status 不带描述时用它 */
const COSYEE_DEFS = new Map(
  DELEGATE_TOOLS.map((t) => [t.name, `${t.description}

input_schema: ${JSON.stringify(t.inputSchema, null, 2)}`]),
);

function withCosyeeDefs(servers: ContextMcpServer[]): ContextMcpServer[] {
  return servers.map((s) =>
    s.name !== MCP_SERVER
      ? s
      : { ...s, tools: s.tools.map((t) => (t.description || !COSYEE_DEFS.has(t.name) ? t : { ...t, description: COSYEE_DEFS.get(t.name)! })) },
  );
}

/** 不下发 path 等本机路径字段，只取名字与 token 数。 */
export function toContextUsage(raw: Raw, at: number = Date.now(), extra: ContextExtra = {}): ContextUsage {
  const max = num(raw.maxTokens);
  const used = num(raw.totalTokens);
  const cats: Raw[] = Array.isArray(raw.categories) ? raw.categories : [];

  const categories: ContextUsage['categories'] = cats
    .filter((c) => c.kind === 'used' || c.kind === 'buffer' || c.kind === 'free')
    .map((c) => ({
      name: String(c.name ?? ''),
      tokens: num(c.tokens),
      percent: max > 0 ? (num(c.tokens) / max) * 100 : null,
      ...(typeof c.color === 'string' ? { color: c.color } : {}),
    }));

  const deferred = cats
    .filter((c) => c.kind === 'deferred')
    .map((c) => ({ name: String(c.name ?? ''), tokens: num(c.tokens) }));

  const rawMcpTools: Raw[] = Array.isArray(raw.mcpTools) ? (raw.mcpTools as Raw[]) : [];
  const mcpTools = rawMcpTools.map((t) => ({
    name: String(t.name ?? ''),
    server: String(t.serverName ?? t.server ?? ''),
    tokens: num(t.tokens),
  }));

  // CLI 把 Cosyee 内置服务器（cosyee）的工具 token 算进 MCP tools / MCP tools (deferred)，
  // 界面上它们属于自带工具而非 MCP：把这部分 token 挪回 System tools / System tools (deferred)，保持总和不变。
  let cosyeeResident = 0;
  let cosyeeDeferred = 0;
  for (const t of rawMcpTools) {
    if (String(t.serverName ?? t.server ?? '') !== MCP_SERVER) continue;
    const tok = Math.max(0, num(t.tokens));
    if (t.isLoaded === false) cosyeeDeferred += tok;
    else cosyeeResident += tok;
  }
  if (cosyeeResident > 0) {
    const srcIdx = categories.findIndex((c) => c.name === 'MCP tools');
    if (srcIdx >= 0 && categories[srcIdx]!.tokens > 0) {
      const src = categories[srcIdx]!;
      const move = Math.min(cosyeeResident, src.tokens);
      src.tokens -= move;
      src.percent = max > 0 ? (src.tokens / max) * 100 : null;
      const dst = categories.find((c) => c.name === 'System tools');
      if (dst) {
        dst.tokens += move;
        dst.percent = max > 0 ? (dst.tokens / max) * 100 : null;
        if (src.tokens <= 0) categories.splice(srcIdx, 1);
      } else {
        const created: ContextUsage['categories'][number] = {
          name: 'System tools',
          tokens: move,
          percent: max > 0 ? (move / max) * 100 : null,
          ...(src.color ? { color: src.color } : {}),
        };
        categories.splice(srcIdx, src.tokens <= 0 ? 1 : 0, created);
      }
    }
  }
  if (cosyeeDeferred > 0) {
    const srcIdx = deferred.findIndex((d) => d.name === 'MCP tools (deferred)');
    if (srcIdx >= 0 && deferred[srcIdx]!.tokens > 0) {
      const src = deferred[srcIdx]!;
      const move = Math.min(cosyeeDeferred, src.tokens);
      src.tokens -= move;
      const dst = deferred.find((d) => d.name === 'System tools (deferred)');
      if (dst) {
        dst.tokens += move;
        if (src.tokens <= 0) deferred.splice(srcIdx, 1);
      } else {
        const created = { name: 'System tools (deferred)', tokens: move };
        deferred.splice(srcIdx, src.tokens <= 0 ? 1 : 0, created);
      }
    }
  }

  const agents = (Array.isArray(raw.agents) ? (raw.agents as Raw[]) : []).map((a) => ({
    name: String(a.agentType ?? a.name ?? ''),
    tokens: num(a.tokens),
  }));

  // 单个内置工具的占用：当前 CLI 恒不给（只有合计），给了就带上；同名以常驻的为准
  const toolTokens: NonNullable<ContextUsage['toolTokens']> = [];
  const seenTool = new Set<string>();
  const pushTools = (list: unknown, deferred: boolean): void => {
    for (const t of Array.isArray(list) ? (list as Raw[]) : []) {
      const name = typeof t?.name === 'string' ? t.name : '';
      if (!name || seenTool.has(name)) continue;
      seenTool.add(name);
      toolTokens.push({ name, tokens: num(t.tokens), ...(deferred && t.isLoaded !== true ? { deferred: true as const } : {}) });
    }
  };
  pushTools(raw.systemTools, false);
  pushTools(raw.deferredBuiltinTools, true);

  const threshold = raw.autoCompactThreshold;
  const untilAutocompact =
    raw.isAutoCompactEnabled === false || typeof threshold !== 'number' ? null : Math.max(0, threshold - used);

  return {
    usedTokens: used,
    totalTokens: max,
    percent: typeof raw.percentage === 'number' ? raw.percentage : max > 0 ? (used / max) * 100 : 0,
    categories,
    deferred,
    mcpTools,
    agents,
    skills: buildSkills(raw, extra),
    mcpServers: withCosyeeDefs(buildMcpServers(mcpTools, extra.mcpStatus)),
    ...(extra.disabledTools ? { disabledTools: [...extra.disabledTools] } : {}),
    ...(extra.disabledAgents ? { disabledAgents: [...extra.disabledAgents] } : {}),
    ...(typeof extra.nativeAgents === 'boolean' ? { nativeAgents: extra.nativeAgents } : {}),
    ...(extra.agentDescriptions?.size
      ? { agentDescriptions: Object.fromEntries([...extra.agentDescriptions].map(([k, v]) => [k, clip(v)])) }
      : {}),
    ...(extra.tools ? { tools: [...extra.tools] } : {}),
    ...(extra.slashCommands?.length ? { slashCommands: [...extra.slashCommands] } : {}),
    ...(toolTokens.length ? { toolTokens } : {}),
    untilAutocompact,
    ...(raw.isAutoCompactEnabled !== false && typeof threshold === 'number' ? { autoCompactThreshold: threshold } : {}),
    compactWindow: extra.compactWindow ?? null,
    at,
  };
}
