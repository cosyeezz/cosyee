// 上下文栏最底部的「子代理」：原生 / 委派两种模式互斥。
// 原生 = Claude 自带 Agent 工具（跟随主会话账号，按别名设默认模型 / 强度及按类型覆盖）；
// 委派 = 自定义委派工具（默认路线 + 每个代理类型可单独指定账号、模型与思考强度）。
// 全局设置（GET / POST /api/subagents），改动对运行中的会话立即生效。
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  DELEGATE_EFFORTS, EFFORTS, SUBAGENT_MODES, clampEffort, effortsFor, menuModelLabel, menuModels,
  type ApiModelMap, type CliModel, type DelegateBackendId, type DelegateEffort, type DelegateModelList,
  type Effort, type ModelAlias, type SubagentAccountOption, type SubagentConfig, type SubagentMode,
  type SubagentRoute, type SubagentState, type SubagentTypeInfo, type SubagentTypeOverride,
} from '@cosyee/shared';
import { BrandIcon, type BrandKind } from '../icons/BrandIcon';
import { Icon } from '../icons/Icon';
import { Menu, type MenuEntry } from '../menus/Menu';
import { LiquidCapsule } from '../motion/LiquidCapsule';
import { Chevron, Fold, Reveal } from './Fold';
import { Switch } from './Switch';

export interface ClaudeAccountModels {
  list: readonly CliModel[] | null;
  map: ApiModelMap | null;
  loading?: boolean;
}

export interface DelegateModelsEntry {
  list: DelegateModelList | null;
  error: string | null;
  loading: boolean;
}

export interface SubagentsProps {
  state: SubagentState;
  onChange: (c: SubagentConfig) => void;
  /** 当前主会话账号的 Claude 模型列表 / 映射表（原生面板与 Claude 账号兜底） */
  modelList?: readonly CliModel[] | null;
  modelMap?: ApiModelMap | null;
  /** 按 Claude 账号 id 缓存的模型列表与映射表（委派 Claude 后端按账号读取） */
  claudeModels?: Record<string, ClaudeAccountModels>;
  /** 打开某个 Claude 账号的模型菜单时按需拉取 */
  onLoadClaudeModels?: (accountId: string, refresh: boolean) => void;
  /** 按 `${backend}:${accountId}` 缓存的委派模型列表（agy / codex） */
  delegateModels?: Record<string, DelegateModelsEntry>;
  /** 打开 agy / codex 菜单时按需拉取；refresh = 强制重新拉 */
  onLoadDelegateModels?: (backend: DelegateBackendId, accountId: string, refresh: boolean) => void;
  /** 当前会话 CLI 报告的智能体名（SessionMeta.agents）：原生模式额外合并，老服务端兜底；排除 fork */
  sessionAgents?: readonly string[];
  /** 老服务端没给 state.disabledAgents 时兜底（来自 usage.disabledAgents） */
  fallbackDisabledAgents?: readonly string[];
  /** 开关代理类型（POST /api/agents）；不传则开关只读 */
  onToggleAgent?: (name: string, enabled: boolean) => void;
  /** 初始展开状态（调试页使用） */
  defaultOpen?: boolean;
}

interface ModeMeta {
  label: string;
  desc: string;
  agentToolOn: boolean;
  delegateToolOn: boolean;
}

const MODE_META: Record<SubagentMode, ModeMeta> = {
  native: {
    label: '原生',
    desc: '使用 Claude 自带的 Agent 工具派发子代理。',
    agentToolOn: true,
    delegateToolOn: false,
  },
  delegate: {
    label: '委派',
    desc: '通过自定义委派工具派发子代理，可按代理类型分别指定账号与模型。',
    agentToolOn: false,
    delegateToolOn: true,
  },
};

const ACCOUNT_GROUPS: { group: SubagentAccountOption['group']; label: string; brand: BrandKind }[] = [
  { group: 'claude', label: 'Claude 订阅', brand: 'claude' },
  { group: 'api', label: 'API', brand: 'api' },
  { group: 'kiro', label: 'Kiro', brand: 'kiro' },
  { group: 'agy', label: 'Antigravity', brand: 'agy' },
  { group: 'codex', label: 'Codex', brand: 'codex' },
];

const brandOf = (group: SubagentAccountOption['group']): BrandKind =>
  ACCOUNT_GROUPS.find((g) => g.group === group)?.brand ?? 'api';

const delegateCacheKey = (backend: DelegateBackendId, accountId: string) => `${backend}:${accountId}`;

/** 内置智能体的中文说明（自定义智能体用它自己的描述） */
const BUILTIN_AGENTS: Record<string, string> = {
  'general-purpose': '通用子智能体：调研复杂问题、搜索代码、执行多步骤任务。',
  Explore: '只读的快速搜索子智能体：按模式找文件、搜关键字，回答「X 定义在哪」。',
  Plan: '架构师子智能体：设计实现方案，列出步骤与关键文件。',
  'statusline-setup': '配置 Claude Code 状态栏（statusLine）的子智能体。',
  'output-style-setup': '创建 Claude Code 输出风格（output style）的子智能体。',
  'claude-code-guide': '解答 Claude Code / Agent SDK / API 用法问题的子智能体。',
  claude: '兜底子智能体：没有更合适的智能体时使用。',
  'web-fetch': '抓取并阅读网页的子智能体（没有 WebFetch 工具时代替它）。',
};

const SOURCE_TAG: Partial<Record<SubagentTypeInfo['source'], { label: string; title: string }>> = {
  projectSettings: { label: '项目', title: '项目级自定义智能体' },
  userSettings: { label: '用户', title: '用户级自定义智能体' },
  plugin: { label: '插件', title: '插件提供的智能体' },
};

const EXTRA_EFFORT_LABELS: Record<string, string> = { none: '关闭', minimal: '极低', ultra: '极高' };
const effortLabel = (e: Effort | DelegateEffort) =>
  EFFORTS.find((x) => x.id === e)?.label ?? EXTRA_EFFORT_LABELS[e] ?? e;

/** 换模型后强度落到支持的档位；模型不分强度就回到默认；不知道支持哪些时保留 */
function fitEffort(effort: Effort | null, efforts: readonly Effort[] | null | undefined): Effort | null {
  if (!effort || efforts === undefined) return effort;
  if (!efforts || !efforts.length) return null;
  return clampEffort(effort, efforts);
}

/** 委派后端的思考强度适配（支持 DelegateEffort） */
function fitDelegateEffort(
  effort: DelegateEffort | null,
  efforts: readonly DelegateEffort[] | null | undefined,
): DelegateEffort | null {
  if (!effort || efforts === undefined) return effort;
  if (!efforts || !efforts.length) return null;
  if (efforts.includes(effort)) return effort;
  const idx = DELEGATE_EFFORTS.indexOf(effort);
  if (idx < 0) return efforts[0] ?? null;
  for (let j = idx - 1; j >= 0; j--) if (efforts.includes(DELEGATE_EFFORTS[j]!)) return DELEGATE_EFFORTS[j]!;
  for (let j = idx + 1; j < DELEGATE_EFFORTS.length; j++) if (efforts.includes(DELEGATE_EFFORTS[j]!)) return DELEGATE_EFFORTS[j]!;
  return efforts[0] ?? null;
}

const asClaudeEffort = (e: DelegateEffort | null): Effort | null =>
  e && EFFORTS.some((x) => x.id === e) ? (e as Effort) : null;

const findAccount = (
  accounts: readonly SubagentAccountOption[],
  route: SubagentRoute | null | undefined,
): SubagentAccountOption | undefined =>
  route ? accounts.find((a) => a.backend === route.backend && a.id === route.accountId) : undefined;

/** 合并可配置的代理类型：state.agents 优先，原生额外合并会话报告的类型，老服务端用会话列表兜底，始终排除 fork */
function resolveAgentTypes(
  stateAgents: readonly SubagentTypeInfo[] | undefined,
  sessionAgents: readonly string[] | undefined,
  mode: SubagentMode,
): SubagentTypeInfo[] {
  const out: SubagentTypeInfo[] = [];
  const seen = new Set<string>();
  const add = (info: SubagentTypeInfo) => {
    if (!info.name || info.name === 'fork' || seen.has(info.name)) return;
    seen.add(info.name);
    out.push(info);
  };
  if (stateAgents) {
    for (const a of stateAgents) add(a);
    if (mode === 'native' && sessionAgents) {
      for (const name of sessionAgents) add({ name, description: BUILTIN_AGENTS[name] ?? '', source: 'builtin' });
    }
  } else if (sessionAgents) {
    for (const name of sessionAgents) add({ name, description: BUILTIN_AGENTS[name] ?? '', source: 'builtin' });
  }
  return out;
}

/** 换账号时生成新路线：换了后端或原模型不在新账号的模型列表里时，model / effort 置为 null */
function switchRouteAccount(
  prev: SubagentRoute | null,
  nextAcc: SubagentAccountOption,
  claudeModels?: Record<string, ClaudeAccountModels>,
  delegateModels?: Record<string, DelegateModelsEntry>,
): SubagentRoute {
  if (prev && prev.backend === nextAcc.backend && prev.accountId === nextAcc.id) return prev;
  if (!prev || prev.backend !== nextAcc.backend || !prev.model) {
    return { backend: nextAcc.backend, accountId: nextAcc.id, model: null, effort: null };
  }
  if (nextAcc.backend === 'claude') {
    const accData = claudeModels?.[nextAcc.id];
    if (!accData) return { backend: nextAcc.backend, accountId: nextAcc.id, model: null, effort: null };
    const mm = menuModels(accData.list, accData.map);
    const exists = mm.primary.some((m) => m.id === prev.model) || mm.more.some((m) => m.id === prev.model);
    if (!exists) return { backend: nextAcc.backend, accountId: nextAcc.id, model: null, effort: null };
    const levels = effortsFor(prev.model, accData.list);
    return {
      backend: nextAcc.backend,
      accountId: nextAcc.id,
      model: prev.model,
      effort: fitEffort(asClaudeEffort(prev.effort), levels),
    };
  }
  const entry = delegateModels?.[delegateCacheKey(nextAcc.backend, nextAcc.id)];
  const found = entry?.list?.models.find((m) => m.value === prev.model);
  if (!found) return { backend: nextAcc.backend, accountId: nextAcc.id, model: null, effort: null };
  return {
    backend: nextAcc.backend,
    accountId: nextAcc.id,
    model: prev.model,
    effort: fitDelegateEffort(prev.effort, found.efforts),
  };
}

/** 构建按 group 分组的账号下拉菜单项（只列 state.accounts） */
function buildAccountMenuItems(o: {
  accounts: readonly SubagentAccountOption[];
  currentRoute: SubagentRoute | null;
  allowFollowDefault?: boolean;
  followDefaultNote?: string;
  onFollowDefault?: () => void;
  onSelect: (acc: SubagentAccountOption) => void;
}): MenuEntry[] {
  const items: MenuEntry[] = [];
  if (o.allowFollowDefault) {
    items.push({
      key: 'follow',
      label: '跟随默认',
      note: o.followDefaultNote,
      checked: o.currentRoute === null,
      onSelect: o.onFollowDefault,
    });
    if (o.accounts.length > 0) items.push({ kind: 'sep', key: 'sep-follow' });
  }
  let groupCount = 0;
  for (const g of ACCOUNT_GROUPS) {
    const list = o.accounts.filter((a) => a.group === g.group);
    if (!list.length) continue;
    if (groupCount > 0) items.push({ kind: 'sep', key: `sep-${g.group}` });
    groupCount += 1;
    items.push({ kind: 'text', key: `grp-${g.group}`, text: g.label });
    for (const acc of list) {
      items.push({
        key: `acc:${acc.backend}:${acc.id}`,
        label: (
          <span className="cz-sub__menu-acct">
            <BrandIcon kind={g.brand} size={14} />
            <span>{acc.label}</span>
          </span>
        ),
        checked: !!o.currentRoute && o.currentRoute.backend === acc.backend && o.currentRoute.accountId === acc.id,
        onSelect: () => o.onSelect(acc),
      });
    }
  }
  if (!o.accounts.length) {
    items.push({ kind: 'text', key: 'empty', text: '暂无可用委派账号' });
  }
  return items;
}

interface RouteControls {
  modelLabel: string;
  effortText: string;
  modelItems: MenuEntry[];
  effortItems: MenuEntry[];
  showEffort: boolean;
  onOpenModel?: () => void;
  onOpenEffort?: () => void;
}

/** 为某条委派路线（默认路线或某代理类型的独立路线）构造模型与思考强度下拉 */
function buildRouteControls(o: {
  route: SubagentRoute;
  onChangeRoute: (next: SubagentRoute) => void;
  claudeModels?: Record<string, ClaudeAccountModels>;
  onLoadClaudeModels?: (accountId: string, refresh: boolean) => void;
  delegateModels?: Record<string, DelegateModelsEntry>;
  onLoadDelegateModels?: (backend: DelegateBackendId, accountId: string, refresh: boolean) => void;
  fallbackModelList?: readonly CliModel[] | null;
  fallbackModelMap?: ApiModelMap | null;
}): RouteControls {
  const { route, onChangeRoute, claudeModels, onLoadClaudeModels, delegateModels, onLoadDelegateModels, fallbackModelList, fallbackModelMap } = o;

  if (route.backend === 'claude') {
    const accData = claudeModels?.[route.accountId];
    const accList = accData ? accData.list : fallbackModelList;
    const accMap = accData ? accData.map : fallbackModelMap;
    const accLoading = !!accData?.loading;
    const mm = menuModels(accList, accMap);
    const levels = route.model ? effortsFor(route.model, accList) : EFFORTS.map((e) => e.id);
    const showEffort = !!levels && levels.length > 0;
    const modelLabel = route.model ? menuModelLabel(route.model, accList, accMap) : '跟随主会话';
    const curEffort = asClaudeEffort(route.effort);
    const effortText = curEffort ? effortLabel(curEffort) : '跟随主会话';

    const selectClaudeModel = (id: string) => {
      const nextLevels = effortsFor(id, accList);
      onChangeRoute({ ...route, model: id, effort: fitEffort(curEffort, nextLevels) });
    };

    const allKnown = new Set([...mm.primary.map((m) => m.id), ...mm.more.map((m) => m.id)]);
    const modelItems: MenuEntry[] = [
      {
        key: 'cm:follow',
        label: '跟随主会话',
        note: '使用主会话当前的模型',
        checked: route.model === null,
        onSelect: () => onChangeRoute({ ...route, model: null, effort: curEffort }),
      },
      ...mm.primary.map((m): MenuEntry => ({
        key: `cm:${m.id}`,
        label: m.label,
        note: m.note,
        checked: route.model === m.id,
        onSelect: () => selectClaudeModel(m.id),
      })),
    ];
    if (mm.more.length > 0) {
      modelItems.push({
        key: 'cm:more',
        label: mm.moreLabel,
        submenu: mm.more.map((m): MenuEntry => ({
          key: `cm:${m.id}`,
          label: m.label,
          note: m.note,
          checked: route.model === m.id,
          onSelect: () => selectClaudeModel(m.id),
        })),
      });
    }
    if (route.model && !allKnown.has(route.model)) {
      modelItems.push({ key: 'cm:gone', label: route.model, note: '不在当前模型列表里', checked: true, disabled: true });
    }
    if (onLoadClaudeModels) {
      modelItems.push(
        { kind: 'sep', key: 'cm:sep' },
        {
          key: 'cm:refresh',
          label: accLoading ? '正在刷新模型列表…' : '刷新模型列表',
          disabled: accLoading,
          keepOpen: true,
          onSelect: () => onLoadClaudeModels(route.accountId, true),
        },
      );
    }

    const effortItems: MenuEntry[] = [
      {
        key: 'ce:follow',
        label: '跟随主会话',
        note: '使用主会话当前的思考强度',
        checked: route.effort === null,
        onSelect: () => onChangeRoute({ ...route, effort: null }),
      },
      ...EFFORTS.filter((e) => levels?.includes(e.id)).map((e): MenuEntry => ({
        key: `ce:${e.id}`,
        label: e.label,
        checked: curEffort === e.id,
        onSelect: () => onChangeRoute({ ...route, effort: e.id }),
      })),
    ];

    const openClaude = onLoadClaudeModels
      ? () => {
          if (!accData?.list && !accLoading) onLoadClaudeModels(route.accountId, false);
        }
      : undefined;

    return { modelLabel, effortText, modelItems, effortItems, showEffort, onOpenModel: openClaude, onOpenEffort: openClaude };
  }

  // agy / codex 委派后端：按需拉取模型列表
  const entry = delegateModels?.[delegateCacheKey(route.backend, route.accountId)];
  const list = entry?.list ?? null;
  const error = entry?.error ?? null;
  const loading = !!entry?.loading;
  const models = list?.models ?? [];
  const cur = list?.current ?? null;
  const nameOf = (v: string) => models.find((m) => m.value === v)?.displayName ?? v;
  const effortsOf = (v: string | undefined) => models.find((m) => m.value === v)?.efforts;
  const effortsList = effortsOf(route.model ?? cur?.model);
  // 模型列表已加载且该模型没有 efforts 时隐藏强度菜单
  const showEffort = !(effortsList && effortsList.length === 0);

  const statusEntries: MenuEntry[] = [];
  if (error) statusEntries.push({ kind: 'text', key: 'err', text: `读取模型列表失败：${error}` });
  else if (!list) statusEntries.push({ kind: 'text', key: 'load', text: '正在读取模型列表…' });

  const modelItems: MenuEntry[] = [
    {
      key: 'default',
      label: '默认',
      note: cur ? `跟随后端默认：${nameOf(cur.model)}` : '跟随后端自己的设置',
      checked: route.model === null,
      onSelect: () => onChangeRoute({ ...route, model: null, effort: fitDelegateEffort(route.effort, effortsOf(cur?.model)) }),
    },
    ...models.map((m): MenuEntry => ({
      key: `m:${m.value}`,
      label: m.displayName,
      checked: route.model === m.value,
      onSelect: () => onChangeRoute({ ...route, model: m.value, effort: fitDelegateEffort(route.effort, m.efforts) }),
    })),
  ];
  if (route.model && list && !effortsOf(route.model)) {
    modelItems.push({ key: 'gone', label: route.model, note: '不在当前模型列表里', checked: true, disabled: true });
  }
  modelItems.push(
    ...statusEntries,
    { kind: 'sep', key: 'sep' },
    {
      key: 'refresh',
      label: loading ? '正在刷新模型列表…' : '刷新模型列表',
      disabled: loading,
      keepOpen: true,
      onSelect: () => onLoadDelegateModels?.(route.backend, route.accountId, true),
    },
  );

  const effortItems: MenuEntry[] = [
    {
      key: 'default',
      label: '默认',
      note: route.model === null && cur?.effort ? `跟随后端默认：${effortLabel(cur.effort)}` : undefined,
      checked: route.effort === null,
      onSelect: () => onChangeRoute({ ...route, effort: null }),
    },
    ...(effortsList ?? []).map((e): MenuEntry => ({
      key: `e:${e}`,
      label: effortLabel(e),
      checked: route.effort === e,
      onSelect: () => onChangeRoute({ ...route, effort: e }),
    })),
    ...statusEntries,
  ];

  const openDelegate = () => {
    if (!list && !loading) onLoadDelegateModels?.(route.backend, route.accountId, false);
  };

  return {
    modelLabel: route.model ? nameOf(route.model) : '默认',
    effortText: route.effort ? effortLabel(route.effort) : '默认',
    modelItems,
    effortItems,
    showEffort,
    onOpenModel: openDelegate,
    onOpenEffort: openDelegate,
  };
}

/** 把某条委派路线格式化成简短摘要（收起行或标题栏用） */
function formatRouteSummary(
  route: SubagentRoute | null,
  accounts: readonly SubagentAccountOption[],
  claudeModels?: Record<string, ClaudeAccountModels>,
  delegateModels?: Record<string, DelegateModelsEntry>,
  fallbackModelList?: readonly CliModel[] | null,
  fallbackModelMap?: ApiModelMap | null,
): { account: SubagentAccountOption | undefined; accountLabel: string; modelText: string | null; effortText: string | null } {
  if (!route) return { account: undefined, accountLabel: '未选择账号', modelText: null, effortText: null };
  const account = findAccount(accounts, route);
  const accountLabel = account?.label ?? route.accountId;
  let modelText: string | null = null;
  if (route.model) {
    if (route.backend === 'claude') {
      const accData = claudeModels?.[route.accountId];
      modelText = menuModelLabel(route.model, accData ? accData.list : fallbackModelList, accData ? accData.map : fallbackModelMap);
    } else {
      const list = delegateModels?.[delegateCacheKey(route.backend, route.accountId)]?.list;
      modelText = list?.models.find((m) => m.value === route.model)?.displayName ?? route.model;
    }
  }
  const effortStr = route.effort ? effortLabel(route.effort) : null;
  return { account, accountLabel, modelText, effortText: effortStr };
}

export function Subagents({
  state, onChange, modelList, modelMap, claudeModels, onLoadClaudeModels, delegateModels, onLoadDelegateModels,
  sessionAgents, fallbackDisabledAgents, onToggleAgent, defaultOpen = false,
}: SubagentsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [expandedAgents, setExpandedAgents] = useState<ReadonlySet<string>>(() => new Set());
  const { config, effective, accounts, routeFallbacks } = state;
  const fallback = effective !== config.mode;

  // 记录切换方向（-1 向左、+1 向右、0 首次渲染）与高度平滑过渡（不随 prefers-reduced-motion 关闭）
  const prevMode = useRef<SubagentMode>(config.mode);
  const dirRef = useRef<number>(0);
  if (prevMode.current !== config.mode) {
    dirRef.current = SUBAGENT_MODES.indexOf(config.mode) > SUBAGENT_MODES.indexOf(prevMode.current) ? 1 : -1;
    prevMode.current = config.mode;
  }
  const panelRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const lastHeight = useRef<number | null>(null);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const stage = stageRef.current;
    if (!open || !panel || !stage) {
      lastHeight.current = null;
      return;
    }
    const toH = stage.scrollHeight;
    const fromH = lastHeight.current;
    lastHeight.current = toH;
    if (fromH === null || Math.abs(toH - fromH) < 1) {
      panel.style.height = '';
      panel.style.overflow = '';
      return;
    }
    panel.style.height = `${fromH}px`;
    panel.style.overflow = 'hidden';
    void panel.offsetHeight;
    panel.style.height = `${toH}px`;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      panel.style.height = '';
      panel.style.overflow = '';
      lastHeight.current = stage.scrollHeight;
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.target === panel && e.propertyName === 'height') finish();
    };
    panel.addEventListener('transitionend', onEnd);
    const timer = window.setTimeout(finish, 240);
    return () => {
      panel.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timer);
      const curH = panel.getBoundingClientRect().height;
      if (curH > 0) lastHeight.current = curH;
    };
  }, [config.mode, open, fallback]);

  useEffect(() => {
    if (open && stageRef.current && panelRef.current && !panelRef.current.style.height) {
      lastHeight.current = stageRef.current.scrollHeight;
    }
  });

  const btnRefs = useRef<Partial<Record<SubagentMode, HTMLButtonElement | null>>>({});

  const setMode = (mode: SubagentMode) => {
    if (mode === config.mode) return;
    if (mode === 'delegate' && !config.delegate.default && accounts.length > 0) {
      const first = accounts[0]!;
      onChange({
        ...config,
        mode: 'delegate',
        delegate: {
          ...config.delegate,
          default: { backend: first.backend, accountId: first.id, model: null, effort: null },
        },
      });
      return;
    }
    onChange({ ...config, mode });
  };

  const setNative = (p: Partial<SubagentConfig['native']>) =>
    onChange({ ...config, native: { ...config.native, ...p } });

  const setNativeAgentOverride = (name: string, next: SubagentTypeOverride<ModelAlias>) => {
    const prevAgents = config.native.agents ?? {};
    const nextAgents: Record<string, SubagentTypeOverride<ModelAlias>> = { ...prevAgents };
    if (next.model === null && next.effort === null) {
      delete nextAgents[name];
    } else {
      nextAgents[name] = next;
    }
    const { agents: _a, ...rest } = config.native;
    onChange({
      ...config,
      native: Object.keys(nextAgents).length > 0 ? { ...rest, agents: nextAgents } : rest,
    });
  };

  const setDelegateDefault = (route: SubagentRoute) =>
    onChange({ ...config, delegate: { ...config.delegate, default: route } });

  const setDelegateAgentRoute = (name: string, route: SubagentRoute | null) => {
    const prevAgents = config.delegate.agents ?? {};
    const nextAgents: Record<string, SubagentRoute> = { ...prevAgents };
    if (route === null) {
      delete nextAgents[name];
    } else {
      nextAgents[name] = route;
    }
    const { agents: _a, ...rest } = config.delegate;
    onChange({
      ...config,
      delegate: Object.keys(nextAgents).length > 0 ? { ...rest, agents: nextAgents } : rest,
    });
  };

  // 原生：只有别名可选（Agent 工具的 model 参数是枚举）
  const primaryModels = menuModels(modelList, modelMap).primary;
  const nativeLevels = effortsFor(config.native.model, modelList);
  const nativeModels: MenuEntry[] = primaryModels.map((m) => ({
    key: `nm:${m.id}`,
    label: m.label,
    note: m.note,
    checked: config.native.model === m.id,
    onSelect: () => setNative({ model: m.id as ModelAlias, effort: clampEffort(config.native.effort, effortsFor(m.id, modelList)) }),
  }));
  const nativeEfforts: MenuEntry[] = EFFORTS.filter((e) => nativeLevels?.includes(e.id)).map((e) => ({
    key: `ne:${e.id}`,
    label: e.label,
    checked: config.native.effort === e.id,
    onSelect: () => setNative({ effort: e.id }),
  }));

  // 委派默认路线
  const defaultRoute = config.delegate.default;
  const defaultSummary = formatRouteSummary(defaultRoute, accounts, claudeModels, delegateModels, modelList, modelMap);
  const defaultAccountItems = buildAccountMenuItems({
    accounts,
    currentRoute: defaultRoute,
    onSelect: (acc) => setDelegateDefault(switchRouteAccount(defaultRoute, acc, claudeModels, delegateModels)),
  });
  const defaultRouteControls = defaultRoute
    ? buildRouteControls({
        route: defaultRoute,
        onChangeRoute: setDelegateDefault,
        claudeModels,
        onLoadClaudeModels,
        delegateModels,
        onLoadDelegateModels,
        fallbackModelList: modelList,
        fallbackModelMap: modelMap,
      })
    : null;

  // 收起时标题右侧摘要
  const nativeLabel = menuModelLabel(config.native.model, modelList, modelMap);
  const delegateExtraParts = [defaultSummary.accountLabel, defaultSummary.modelText].filter(Boolean);
  const extra = fallback
    ? `已退回原生 · ${nativeLabel}`
    : effective === 'native'
      ? `原生 · ${nativeLabel}`
      : `委派 · ${delegateExtraParts.join(' · ')}`;

  const onRadioKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const focused = SUBAGENT_MODES.find((m) => btnRefs.current[m] === document.activeElement);
    const curIdx = Math.max(0, SUBAGENT_MODES.indexOf(focused ?? config.mode));
    const len = SUBAGENT_MODES.length;
    let next: SubagentMode | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = SUBAGENT_MODES[(curIdx + 1) % len];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = SUBAGENT_MODES[(curIdx - 1 + len) % len];
    else if (e.key === 'Home') next = SUBAGENT_MODES[0];
    else if (e.key === 'End') next = SUBAGENT_MODES[len - 1];
    if (!next) return;
    e.preventDefault();
    setMode(next);
    btnRefs.current[next]?.focus();
  };

  const meta = MODE_META[config.mode];
  const effMeta = MODE_META[effective];
  const fallbackText =
    state.fallbackReason
    || (accounts.length === 0 ? '暂无可用委派账号' : '默认路线不可用');

  // 代理类型列表与开关状态
  const agentTypes = resolveAgentTypes(state.agents, sessionAgents, config.mode);
  const disabledSet = new Set(state.disabledAgents ?? fallbackDisabledAgents ?? []);
  const offTypesCount = agentTypes.filter((a) => disabledSet.has(a.name)).length;
  const toggleAgentExpand = (name: string) => {
    setExpandedAgents((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <Fold
      title="子代理"
      className="cz-ctx__agents"
      extra={extra}
      open={open}
      onToggle={() => setOpen((v) => !v)}
    >
      <div className="cz-sub">
        <div
          className={`cz-sub__seg${fallback ? ' is-fallback' : ''}`}
          role="radiogroup"
          aria-label="子代理模式"
          onKeyDown={onRadioKeyDown}
        >
          <LiquidCapsule activeKey={config.mode} selector=".cz-sub__opt.is-active" axis="x" />
          {SUBAGENT_MODES.map((m) => {
            const active = config.mode === m;
            const isEff = effective === m;
            const info = MODE_META[m];
            return (
              <button
                key={m}
                ref={(el) => { btnRefs.current[m] = el; }}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                className={`cz-sub__opt${active ? ' is-active' : ''}`}
                title={info.desc}
                onClick={() => setMode(m)}
              >
                {m === 'native' ? <BrandIcon kind="api" size={14} /> : <Icon name="tool-agent" size={14} />}
                <span className="cz-sub__opt-label">{info.label}</span>
                {fallback && isEff && (
                  <span className="cz-sub__opt-eff" title="当前实际生效" aria-hidden="true" />
                )}
              </button>
            );
          })}
        </div>

        {fallback && (
          <div className="cz-sub__banner" role="status">
            <Icon name="info" size={14} />
            <span className="cz-sub__banner-text">
              <strong>已退回原生</strong>
              <span>{' · '}{fallbackText}</span>
            </span>
          </div>
        )}

        <div ref={panelRef} className="cz-sub__panel">
          <div
            key={config.mode}
            ref={stageRef}
            className="cz-sub__stage"
            style={{ '--sub-dir': dirRef.current } as React.CSSProperties}
          >
            <div className={`cz-sub__card${fallback ? ' is-dim' : ''}`}>
              <p className="cz-sub__desc">{meta.desc}</p>
              <div className="cz-sub__tools" aria-label="工具状态">
                {/* 工具开关按实际生效的模式显示：退回原生时这里要和提示条一致 */}
                <span className={`cz-sub__pill${effMeta.agentToolOn ? ' is-on' : ' is-off'}`}>
                  <span className="cz-sub__dot" aria-hidden="true" />
                  Agent 工具 {effMeta.agentToolOn ? '开' : '关'}
                </span>
                <span className={`cz-sub__pill${effMeta.delegateToolOn ? ' is-on' : ' is-off'}`}>
                  <span className="cz-sub__dot" aria-hidden="true" />
                  委派工具 {effMeta.delegateToolOn ? '开' : '关'}
                </span>
              </div>

              {config.mode === 'native' && (
                <>
                  <div className="cz-sub__acct">
                    <span className="cz-sub__acct-k">账号：</span>
                    <span className="cz-sub__acct-v" title="跟随主会话账号">跟随主会话账号</span>
                  </div>
                  <div className="cz-sub__fields">
                    <div className={`cz-sub__field${nativeLevels ? '' : ' is-full'}`}>
                      <span className="cz-sub__field-label">默认模型</span>
                      <Pick name="原生子代理模型" label={nativeLabel} items={nativeModels} />
                    </div>
                    {nativeLevels && (
                      <div className="cz-sub__field">
                        <span className="cz-sub__field-label">默认思考强度</span>
                        <Pick name="原生子代理思考强度" label={effortLabel(config.native.effort)} items={nativeEfforts} effort />
                      </div>
                    )}
                  </div>
                </>
              )}

              {config.mode === 'delegate' && (
                <div className="cz-sub__route">
                  <div className="cz-sub__route-head">
                    <span className="cz-sub__route-title">默认路线</span>
                  </div>
                  {accounts.length === 0 && !defaultRoute ? (
                    <p className="cz-sub__route-empty">当前没有可用的委派账号，请先在账号管理中添加或登录，目前保持原生模式生效。</p>
                  ) : (
                    <>
                      <div className="cz-sub__field is-full">
                        <span className="cz-sub__field-label">账号</span>
                        <Pick
                          name="默认委派账号"
                          label={defaultSummary.accountLabel}
                          icon={defaultSummary.account ? <BrandIcon kind={brandOf(defaultSummary.account.group)} size={14} /> : undefined}
                          items={defaultAccountItems}
                        />
                      </div>
                      {defaultRouteControls && (
                        <div className="cz-sub__fields">
                          <div className={`cz-sub__field${defaultRouteControls.showEffort ? '' : ' is-full'}`}>
                            <span className="cz-sub__field-label">模型</span>
                            <Pick
                              name="默认委派模型"
                              label={defaultRouteControls.modelLabel}
                              items={defaultRouteControls.modelItems}
                              onOpen={defaultRouteControls.onOpenModel}
                            />
                          </div>
                          {defaultRouteControls.showEffort && (
                            <div className="cz-sub__field">
                              <span className="cz-sub__field-label">思考强度</span>
                              <Pick
                                name="默认委派思考强度"
                                label={defaultRouteControls.effortText}
                                items={defaultRouteControls.effortItems}
                                onOpen={defaultRouteControls.onOpenEffort}
                                effort
                              />
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {agentTypes.length > 0 && (
              <div className={`cz-sub__types${fallback ? ' is-dim' : ''}`}>
                <div className="cz-sub__types-head">
                  <span className="cz-sub__types-title">代理类型</span>
                  <span className="cz-sub__types-meta">
                    {offTypesCount > 0 ? `${agentTypes.length} 个 · ${offTypesCount} 已关闭` : `${agentTypes.length} 个`}
                  </span>
                </div>
                <ul className="cz-sub__types-list">
                  {agentTypes.map((agent) =>
                    config.mode === 'native' ? (
                      <NativeAgentRow
                        key={agent.name}
                        agent={agent}
                        config={config}
                        enabled={!disabledSet.has(agent.name)}
                        expanded={expandedAgents.has(agent.name)}
                        onToggleExpand={() => toggleAgentExpand(agent.name)}
                        onToggleAgent={onToggleAgent}
                        onOverride={(next) => setNativeAgentOverride(agent.name, next)}
                        primaryModels={primaryModels}
                        modelList={modelList}
                        modelMap={modelMap}
                        nativeLabel={nativeLabel}
                      />
                    ) : (
                      <DelegateAgentRow
                        key={agent.name}
                        agent={agent}
                        route={config.delegate.agents?.[agent.name] ?? null}
                        defaultRoute={defaultRoute}
                        defaultSummaryText={[defaultSummary.accountLabel, defaultSummary.modelText, defaultSummary.effortText].filter(Boolean).join(' · ')}
                        routeFallback={routeFallbacks[agent.name]}
                        accounts={accounts}
                        enabled={!disabledSet.has(agent.name)}
                        expanded={expandedAgents.has(agent.name)}
                        onToggleExpand={() => toggleAgentExpand(agent.name)}
                        onToggleAgent={onToggleAgent}
                        onChangeRoute={(next) => setDelegateAgentRoute(agent.name, next)}
                        claudeModels={claudeModels}
                        onLoadClaudeModels={onLoadClaudeModels}
                        delegateModels={delegateModels}
                        onLoadDelegateModels={onLoadDelegateModels}
                        fallbackModelList={modelList}
                        fallbackModelMap={modelMap}
                      />
                    ),
                  )}
                </ul>
              </div>
            )}
          </div>
        </div>

        <p className="cz-ctx__note cz-sub__foot-note">对所有会话生效；派发时点名的模型优先。</p>
      </div>
    </Fold>
  );
}

interface NativeAgentRowProps {
  agent: SubagentTypeInfo;
  config: SubagentConfig;
  enabled: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleAgent?: (name: string, enabled: boolean) => void;
  onOverride: (next: SubagentTypeOverride<ModelAlias>) => void;
  primaryModels: ReturnType<typeof menuModels>['primary'];
  modelList?: readonly CliModel[] | null;
  modelMap?: ApiModelMap | null;
  nativeLabel: string;
}

function NativeAgentRow({
  agent, config, enabled, expanded, onToggleExpand, onToggleAgent, onOverride,
  primaryModels, modelList, modelMap, nativeLabel,
}: NativeAgentRowProps) {
  const detailId = useId();
  const ov: SubagentTypeOverride<ModelAlias> = config.native.agents?.[agent.name] ?? { model: null, effort: null };
  const desc = BUILTIN_AGENTS[agent.name] || agent.description || '';
  const sourceTag = SOURCE_TAG[agent.source];

  const followModelNote = `跟随默认：${nativeLabel}${agent.model ? `（定义里写的是 ${agent.model}）` : ''}`;
  const followEffortNote = `跟随默认：${effortLabel(config.native.effort)}${agent.effort ? `（定义里写的是 ${effortLabel(agent.effort)}）` : ''}`;

  let overrideSummary = '';
  if (ov.model !== null || ov.effort !== null) {
    const mStr = ov.model !== null ? menuModelLabel(ov.model, modelList, modelMap) : null;
    const eStr = ov.effort !== null ? effortLabel(ov.effort) : null;
    if (mStr && eStr) overrideSummary = `${mStr} · ${eStr}`;
    else if (mStr) overrideSummary = mStr;
    else if (eStr) overrideSummary = `默认 · ${eStr}`;
  }

  const effModel = ov.model ?? config.native.model;
  const levels = effortsFor(effModel, modelList);
  const defaultLevels = effortsFor(config.native.model, modelList);
  const showEffort = !!levels && levels.length > 0;
  const modelLabel = ov.model ? menuModelLabel(ov.model, modelList, modelMap) : '跟随默认';
  const effortText = ov.effort ? effortLabel(ov.effort) : '跟随默认';

  const modelItems: MenuEntry[] = [
    {
      key: 'follow',
      label: '跟随默认',
      note: followModelNote,
      checked: ov.model === null,
      onSelect: () => onOverride({ model: null, effort: fitEffort(ov.effort, defaultLevels) }),
    },
    ...primaryModels.map((m): MenuEntry => ({
      key: `m:${m.id}`,
      label: m.label,
      note: m.note,
      checked: ov.model === m.id,
      onSelect: () => onOverride({ model: m.id as ModelAlias, effort: fitEffort(ov.effort, effortsFor(m.id, modelList)) }),
    })),
  ];
  const effortItems: MenuEntry[] = [
    {
      key: 'follow',
      label: '跟随默认',
      note: followEffortNote,
      checked: ov.effort === null,
      onSelect: () => onOverride({ model: ov.model, effort: null }),
    },
    ...EFFORTS.filter((e) => levels?.includes(e.id)).map((e): MenuEntry => ({
      key: `e:${e.id}`,
      label: e.label,
      checked: ov.effort === e.id,
      onSelect: () => onOverride({ model: ov.model, effort: e.id }),
    })),
  ];

  const defHints: string[] = [];
  if (agent.model) defHints.push(`模型 ${agent.model}`);
  if (agent.effort) defHints.push(`思考强度 ${effortLabel(agent.effort)}`);

  return (
    <li className={`cz-sub__agent${enabled ? '' : ' is-off'}${expanded ? ' is-open' : ''}`}>
      <div className="cz-sub__agent-head">
        <button
          type="button"
          className="cz-sub__agent-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggleExpand}
        >
          <Chevron open={expanded} size={11} />
          <span className="cz-sub__agent-main">
            <span className="cz-sub__agent-top">
              <span className="cz-sub__agent-name" title={agent.name}>{agent.name}</span>
              {agent.readOnly && <span className="cz-sub__tag is-ro" title="只读类型：不能修改文件">只读</span>}
              {sourceTag && <span className={`cz-sub__tag is-${agent.source}`} title={sourceTag.title}>{sourceTag.label}</span>}
            </span>
            {desc && <span className="cz-sub__agent-desc" title={desc}>{desc}</span>}
            {!expanded && overrideSummary && (
              <span className="cz-sub__agent-ov" title={`单独配置：${overrideSummary}`}>
                <span className="cz-sub__agent-ov-text">{overrideSummary}</span>
              </span>
            )}
          </span>
        </button>
        <div
          className="cz-sub__agent-sw"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            on={enabled}
            label={`${enabled ? '关闭' : '开启'}代理类型 ${agent.name}`}
            disabled={!onToggleAgent}
            onChange={() => onToggleAgent?.(agent.name, !enabled)}
          />
        </div>
      </div>
      <Reveal open={expanded} id={detailId}>
        <div className="cz-sub__agent-body">
          <div className="cz-sub__fields">
            <div className={`cz-sub__field${showEffort ? '' : ' is-full'}`}>
              <span className="cz-sub__field-label">模型</span>
              <Pick name={`${agent.name} 模型`} label={modelLabel} items={modelItems} />
            </div>
            {showEffort && (
              <div className="cz-sub__field">
                <span className="cz-sub__field-label">思考强度</span>
                <Pick name={`${agent.name} 思考强度`} label={effortText} items={effortItems} effort />
              </div>
            )}
          </div>
          {defHints.length > 0 && (
            <p className="cz-sub__agent-def">定义里写的是 {defHints.join(' · ')}</p>
          )}
        </div>
      </Reveal>
    </li>
  );
}

interface DelegateAgentRowProps {
  agent: SubagentTypeInfo;
  route: SubagentRoute | null;
  defaultRoute: SubagentRoute | null;
  defaultSummaryText: string;
  routeFallback?: string;
  accounts: readonly SubagentAccountOption[];
  enabled: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleAgent?: (name: string, enabled: boolean) => void;
  onChangeRoute: (next: SubagentRoute | null) => void;
  claudeModels?: Record<string, ClaudeAccountModels>;
  onLoadClaudeModels?: (accountId: string, refresh: boolean) => void;
  delegateModels?: Record<string, DelegateModelsEntry>;
  onLoadDelegateModels?: (backend: DelegateBackendId, accountId: string, refresh: boolean) => void;
  fallbackModelList?: readonly CliModel[] | null;
  fallbackModelMap?: ApiModelMap | null;
}

function DelegateAgentRow({
  agent, route, defaultRoute, defaultSummaryText, routeFallback, accounts, enabled, expanded,
  onToggleExpand, onToggleAgent, onChangeRoute, claudeModels, onLoadClaudeModels,
  delegateModels, onLoadDelegateModels, fallbackModelList, fallbackModelMap,
}: DelegateAgentRowProps) {
  const detailId = useId();
  const desc = BUILTIN_AGENTS[agent.name] || agent.description || '';
  const sourceTag = SOURCE_TAG[agent.source];

  const summary = route
    ? formatRouteSummary(route, accounts, claudeModels, delegateModels, fallbackModelList, fallbackModelMap)
    : null;
  const summaryParts = summary ? [summary.accountLabel, summary.modelText, summary.effortText].filter(Boolean) : [];
  const summaryText = summaryParts.join(' · ');

  const followNote = defaultRoute ? `跟随默认：${defaultSummaryText}` : '跟随默认路线';
  const accountItems = buildAccountMenuItems({
    accounts,
    currentRoute: route,
    allowFollowDefault: true,
    followDefaultNote: followNote,
    onFollowDefault: () => onChangeRoute(null),
    onSelect: (acc) => onChangeRoute(switchRouteAccount(route, acc, claudeModels, delegateModels)),
  });

  const controls = route
    ? buildRouteControls({
        route,
        onChangeRoute: (next) => onChangeRoute(next),
        claudeModels,
        onLoadClaudeModels,
        delegateModels,
        onLoadDelegateModels,
        fallbackModelList,
        fallbackModelMap,
      })
    : null;

  const defHints: string[] = [];
  if (agent.model) defHints.push(`模型 ${agent.model}`);
  if (agent.effort) defHints.push(`思考强度 ${effortLabel(agent.effort)}`);

  return (
    <li className={`cz-sub__agent${enabled ? '' : ' is-off'}${expanded ? ' is-open' : ''}`}>
      <div className="cz-sub__agent-head">
        <button
          type="button"
          className="cz-sub__agent-toggle"
          aria-expanded={expanded}
          aria-controls={detailId}
          onClick={onToggleExpand}
        >
          <Chevron open={expanded} size={11} />
          <span className="cz-sub__agent-main">
            <span className="cz-sub__agent-top">
              <span className="cz-sub__agent-name" title={agent.name}>{agent.name}</span>
              {agent.readOnly && <span className="cz-sub__tag is-ro" title="只读类型：不能修改文件">只读</span>}
              {sourceTag && <span className={`cz-sub__tag is-${agent.source}`} title={sourceTag.title}>{sourceTag.label}</span>}
            </span>
            {desc && <span className="cz-sub__agent-desc" title={desc}>{desc}</span>}
            {routeFallback && (
              <span className="cz-sub__agent-fb" role="status">
                <Icon name="info" size={12} />
                <span>已用默认路线：{routeFallback}</span>
              </span>
            )}
            {!expanded && summary && !routeFallback && (
              <span className="cz-sub__agent-ov" title={`单独路线：${summaryText}`}>
                {summary.account && <BrandIcon kind={brandOf(summary.account.group)} size={12} />}
                <span className="cz-sub__agent-ov-text">{summaryText}</span>
              </span>
            )}
          </span>
        </button>
        <div
          className="cz-sub__agent-sw"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <Switch
            on={enabled}
            label={`${enabled ? '关闭' : '开启'}代理类型 ${agent.name}`}
            disabled={!onToggleAgent}
            onChange={() => onToggleAgent?.(agent.name, !enabled)}
          />
        </div>
      </div>
      <Reveal open={expanded} id={detailId}>
        <div className="cz-sub__agent-body">
          <div className="cz-sub__field is-full">
            <span className="cz-sub__field-label">账号</span>
            <Pick
              name={`${agent.name} 账号`}
              label={summary ? summary.accountLabel : '跟随默认'}
              icon={summary?.account ? <BrandIcon kind={brandOf(summary.account.group)} size={14} /> : undefined}
              items={accountItems}
            />
          </div>
          {controls && (
            <div className="cz-sub__fields">
              <div className={`cz-sub__field${controls.showEffort ? '' : ' is-full'}`}>
                <span className="cz-sub__field-label">模型</span>
                <Pick
                  name={`${agent.name} 模型`}
                  label={controls.modelLabel}
                  items={controls.modelItems}
                  onOpen={controls.onOpenModel}
                />
              </div>
              {controls.showEffort && (
                <div className="cz-sub__field">
                  <span className="cz-sub__field-label">思考强度</span>
                  <Pick
                    name={`${agent.name} 思考强度`}
                    label={controls.effortText}
                    items={controls.effortItems}
                    onOpen={controls.onOpenEffort}
                    effort
                  />
                </div>
              )}
            </div>
          )}
          {defHints.length > 0 && (
            <p className="cz-sub__agent-def">定义里写的是 {defHints.join(' · ')}</p>
          )}
        </div>
      </Reveal>
    </li>
  );
}

function Pick({
  name, label, icon, items, onOpen, effort,
}: {
  name: string;
  label: string;
  icon?: ReactNode;
  items: MenuEntry[];
  onOpen?: () => void;
  effort?: boolean;
}) {
  const [at, setAt] = useState<HTMLElement | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={`cz-ctx__mode cz-ctx__pick${effort ? ' is-effort' : ''}${at ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!at}
        aria-label={`${name}：${label}`}
        title={label}
        onClick={() => {
          if (!at) onOpen?.();
          setAt(at ? null : ref.current);
        }}
      >
        <span className="cz-ctx__pick-label">
          {icon}
          <span className="cz-ctx__pick-text">{label}</span>
        </span>
        <Icon name="chevron-down" size={11} />
      </button>
      {at && <Menu anchor={at} items={items} onClose={() => setAt(null)} placement="top" align="end" minWidth={196} />}
    </>
  );
}
