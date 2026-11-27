// 委派路线：每个代理类型由哪个后端的哪个账号、用什么模型执行（SubagentConfig.delegate）。
// 这里只做纯计算：给定配置与后端集合，算出某个类型实际走哪条路线、委派模式整体能不能生效。
import type { Effort, SubagentAvailability, SubagentConfig, SubagentRoute } from '@cosyee/shared';
import type { BackendDefaults, DelegateBackend } from './backend.js';

const LABEL: Record<string, string> = { claude: 'Claude', agy: 'Antigravity', codex: 'Codex' };

export interface RouteDeps {
  backendFor(id: string): DelegateBackend | null;
}

/** 一条路线现在能不能用：后端已安装、账号存在且已登录（不起进程不联网） */
export function routeAvailability(route: SubagentRoute | null | undefined, deps: RouteDeps): SubagentAvailability {
  if (!route) return { ok: false, reason: '还没有选择委派账号' };
  const backend = deps.backendFor(route.backend);
  if (!backend) return { ok: false, reason: `${LABEL[route.backend] ?? route.backend} 委派不可用` };
  if (backend.accountAvailability) return backend.accountAvailability(route.accountId);
  if (backend.availability) return backend.availability();
  return backend.available() ? { ok: true } : { ok: false, reason: `${backend.label} 不可用` };
}

/** 委派模式整体能否生效：看默认路线（类型自己的路线不可用时都要退回它） */
export function delegateAvailability(cfg: SubagentConfig, deps: RouteDeps): SubagentAvailability {
  return routeAvailability(cfg.delegate.default, deps);
}

export interface ResolvedRoute {
  backend: DelegateBackend;
  route: SubagentRoute;
  /** true = 该类型自己配置了路线（且可用）；false = 跟随默认路线 */
  own: boolean;
  /** 自己的路线不可用、退回默认路线的原因 */
  fallbackReason?: string;
}

/**
 * 某个代理类型实际走的路线：自己的路线（可用）> 默认路线（可用）> null（委派不可用）。
 */
export function resolveRoute(cfg: SubagentConfig, agentName: string, deps: RouteDeps): ResolvedRoute | null {
  const ownRoute = cfg.delegate.agents?.[agentName];
  let fallbackReason: string | undefined;
  if (ownRoute) {
    const a = routeAvailability(ownRoute, deps);
    const backend = deps.backendFor(ownRoute.backend);
    if (a.ok && backend) return { backend, route: ownRoute, own: true };
    fallbackReason = a.reason ?? '路线不可用';
  }
  const def = cfg.delegate.default;
  const a = routeAvailability(def, deps);
  const backend = def ? deps.backendFor(def.backend) : null;
  if (!def || !a.ok || !backend) return null;
  return { backend, route: def, own: false, ...(fallbackReason ? { fallbackReason } : {}) };
}

/** 各类型自己的路线不可用、改用默认路线的原因（给界面显示） */
export function routeFallbacks(cfg: SubagentConfig, deps: RouteDeps): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, route] of Object.entries(cfg.delegate.agents ?? {})) {
    const a = routeAvailability(route, deps);
    if (!a.ok) out[name] = a.reason ?? '路线不可用';
  }
  return out;
}

/** 配置里所有路线用到的后端 id（去重，默认路线在前） */
export function routeBackendIds(cfg: SubagentConfig): string[] {
  const ids: string[] = [];
  const add = (r: SubagentRoute | null | undefined) => {
    if (r && !ids.includes(r.backend)) ids.push(r.backend);
  };
  add(cfg.delegate.default);
  for (const r of Object.values(cfg.delegate.agents ?? {})) add(r);
  return ids;
}

/**
 * 把路线换成后端认的默认值：
 * - 类型自己的路线：放进 agents[类型名]，优先于智能体定义里的 model / effort；
 * - 跟随默认：放在 model / effort，排在智能体定义之后。
 * Claude 后端另带主会话当前的模型 / 强度（路线为 null 时跟随主会话）。
 */
export function routeDefaults(
  r: ResolvedRoute,
  agentName: string,
  parent: { model?: string | null; effort?: Effort | null },
): BackendDefaults {
  const claude = r.backend.id === 'claude';
  const out: BackendDefaults = r.own
    ? { model: null, effort: null, agents: { [agentName]: { model: r.route.model, effort: r.route.effort } } }
    : { model: r.route.model, effort: r.route.effort };
  if (claude) {
    out.parentModel = parent.model ?? null;
    out.parentEffort = parent.effort ?? null;
  }
  return out;
}
