// get_context_usage 响应 -> 前端的 ContextUsage（换算规则见 shared/src/protocol.ts 与 spike/FINDINGS2.md B1 §4）。
// skills / mcpServers 另外合并 system/init 的 skills、get_settings 的 effective.skillOverrides 与 mcp_status。
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
  /** 内置工具名（init.tools 去掉 mcp__ 工具） */
  tools?: string[] | null;
  /** Cosyee 保存的自动压缩窗口（null = 不覆盖） */
  compactWindow?: number | null;
}

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
  for (const n of Object.keys(extra.cosyeeOverrides ?? {})) {
    if (seen.has(n)) continue;
    const f = findFm(n);
    // 设成「开」却既不在 init 也不在 frontmatter：多半已被删掉，不再列出
    if (!f && modeOf(n) === 'on') continue;
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
        tools.push({ name: short, tokens: tokenOf.get(full) ?? null });
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

  const mcpTools = (Array.isArray(raw.mcpTools) ? (raw.mcpTools as Raw[]) : []).map((t) => ({
    name: String(t.name ?? ''),
    server: String(t.serverName ?? t.server ?? ''),
    tokens: num(t.tokens),
  }));

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
    mcpServers: buildMcpServers(mcpTools, extra.mcpStatus),
    ...(extra.disabledTools ? { disabledTools: [...extra.disabledTools] } : {}),
    ...(extra.disabledAgents ? { disabledAgents: [...extra.disabledAgents] } : {}),
    ...(extra.tools ? { tools: [...extra.tools] } : {}),
    ...(toolTokens.length ? { toolTokens } : {}),
    untilAutocompact,
    ...(raw.isAutoCompactEnabled !== false && typeof threshold === 'number' ? { autoCompactThreshold: threshold } : {}),
    compactWindow: extra.compactWindow ?? null,
    at,
  };
}
