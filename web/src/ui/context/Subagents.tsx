// 上下文栏最底部的「子代理」：三种后端互斥（原生 / Claude / Antigravity），选中后展开说明卡片、默认模型 / 思考强度，以及下方可开关与单独配置的代理类型列表。
// 全局设置（GET / POST /api/subagents），改动对运行中的会话立即生效。
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  EFFORTS, SUBAGENT_KINDS, clampEffort, effortsFor, menuModelLabel, menuModels,
  type ApiModelMap, type CliModel, type DelegateModelList, type Effort, type ModelAlias,
  type SubagentConfig, type SubagentKind, type SubagentState, type SubagentTypeInfo, type SubagentTypeOverride,
} from '@cosyee/shared';
import { BrandIcon, type BrandKind } from '../icons/BrandIcon';
import { Icon } from '../icons/Icon';
import { Menu, type MenuEntry } from '../menus/Menu';
import { LiquidCapsule } from '../motion/LiquidCapsule';
import { reducedMotion } from '../motion/reduced';
import { Chevron, Fold, Reveal } from './Fold';
import { Switch } from './Switch';

export interface SubagentsProps {
  state: SubagentState;
  onChange: (c: SubagentConfig) => void;
  /** 当前账号的 Claude 模型列表 / 映射表（与模型菜单同源） */
  modelList?: readonly CliModel[] | null;
  modelMap?: ApiModelMap | null;
  /** agy 报告的模型；null = 还没拉到 */
  delegate: DelegateModelList | null;
  /** 拉取失败的原因（未安装 / 未登录） */
  delegateError?: string | null;
  delegateLoading?: boolean;
  /** 打开 agy 菜单时按需拉取；refresh = 强制重新拉 */
  onLoadDelegate: (refresh: boolean) => void;
  /** 各类型子代理当前使用的账号名（只读展示）；拿不到时不传或对应项为 null */
  accounts?: { claude?: string | null; agy?: string | null };
  /** 当前会话 CLI 报告的智能体名（SessionMeta.agents）：原生后端额外合并，老服务端兜底；排除 fork */
  sessionAgents?: readonly string[];
  /** 老服务端没给 state.disabledAgents 时兜底（来自 usage.disabledAgents） */
  fallbackDisabledAgents?: readonly string[];
  /** 开关代理类型（POST /api/agents）；不传则开关只读 */
  onToggleAgent?: (name: string, enabled: boolean) => void;
  /** 初始展开状态（调试页使用） */
  defaultOpen?: boolean;
}

interface KindMeta {
  label: string;
  /** 官方品牌图标：原生用 Anthropic 标志（Claude Code 自带的 Agent 工具） */
  icon: BrandKind;
  desc: string;
  agentToolOn: boolean;
  delegateToolOn: boolean;
}

const KIND_META: Record<SubagentKind, KindMeta> = {
  native: {
    label: '原生',
    icon: 'api',
    desc: '使用 Claude 自带的 Agent 工具派发子代理。',
    agentToolOn: true,
    delegateToolOn: false,
  },
  claude: {
    label: 'Claude',
    icon: 'claude',
    desc: '通过自定义委派工具调用 Claude CLI（独立执行环境）。',
    agentToolOn: false,
    delegateToolOn: true,
  },
  agy: {
    label: 'Antigravity',
    icon: 'agy',
    desc: '通过自定义委派工具调用 Antigravity（agy）。',
    agentToolOn: false,
    delegateToolOn: true,
  },
};

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

const effortLabel = (e: Effort) => EFFORTS.find((x) => x.id === e)?.label ?? e;

/** 换模型后强度落到支持的档位；模型不分强度就回到默认；不知道支持哪些时保留 */
function fit(effort: Effort | null, efforts: Effort[] | null | undefined): Effort | null {
  if (!effort || efforts === undefined) return effort;
  if (!efforts || !efforts.length) return null;
  return clampEffort(effort, efforts);
}

/** 合并可配置的代理类型：state.agents 优先，原生额外合并会话报告的类型，老服务端用会话列表兜底，始终排除 fork */
function resolveAgentTypes(
  stateAgents: readonly SubagentTypeInfo[] | undefined,
  sessionAgents: readonly string[] | undefined,
  kind: SubagentKind,
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
    if (kind === 'native' && sessionAgents) {
      for (const name of sessionAgents) add({ name, description: BUILTIN_AGENTS[name] ?? '', source: 'builtin' });
    }
  } else if (sessionAgents) {
    for (const name of sessionAgents) add({ name, description: BUILTIN_AGENTS[name] ?? '', source: 'builtin' });
  }
  return out;
}

export function Subagents({
  state, onChange, modelList, modelMap, delegate, delegateError, delegateLoading, onLoadDelegate, accounts,
  sessionAgents, fallbackDisabledAgents, onToggleAgent, defaultOpen = false,
}: SubagentsProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [expandedAgents, setExpandedAgents] = useState<ReadonlySet<string>>(() => new Set());
  const { config, available, effective } = state;
  const fallback = effective !== config.kind;

  // 记录切换方向（-1 向左、+1 向右、0 首次渲染）与高度平滑过渡
  const prevKind = useRef<SubagentKind>(config.kind);
  const dirRef = useRef<number>(0);
  if (prevKind.current !== config.kind) {
    dirRef.current = SUBAGENT_KINDS.indexOf(config.kind) > SUBAGENT_KINDS.indexOf(prevKind.current) ? 1 : -1;
    prevKind.current = config.kind;
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
    if (fromH === null || Math.abs(toH - fromH) < 1 || reducedMotion()) {
      panel.style.height = '';
      panel.style.overflow = '';
      return;
    }
    panel.style.height = `${fromH}px`;
    panel.style.overflow = 'hidden';
    // 强制同步起始高度，随后过渡到目标高度
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
      // 中途被打断时，记录此刻真实视觉高度作为下一次起点
      const curH = panel.getBoundingClientRect().height;
      if (curH > 0) lastHeight.current = curH;
    };
  }, [config.kind, open, fallback]);

  // 每次展开且同类型内容尺寸改变（如 agy 模型加载完、代理类型展开）时同步最新高度基准（过渡期间不覆盖）
  useEffect(() => {
    if (open && stageRef.current && panelRef.current && !panelRef.current.style.height) {
      lastHeight.current = stageRef.current.scrollHeight;
    }
  });

  const btnRefs = useRef<Partial<Record<SubagentKind, HTMLButtonElement | null>>>({});

  const setKind = (kind: SubagentKind) => {
    if (kind === config.kind || !available[kind]?.ok) return;
    onChange({ ...config, kind });
  };
  const setNative = (p: Partial<SubagentConfig['native']>) => onChange({ ...config, native: { ...config.native, ...p } });
  const setClaude = (p: Partial<SubagentConfig['claude']>) => onChange({ ...config, claude: { ...config.claude, ...p } });
  const setAgy = (p: Partial<SubagentConfig['agy']>) => onChange({ ...config, agy: { ...config.agy, ...p } });

  const setAgentOverride = (kind: SubagentKind, name: string, next: SubagentTypeOverride) => {
    const prevAgents = config[kind].agents ?? {};
    const nextAgents: Record<string, SubagentTypeOverride> = { ...prevAgents };
    if (next.model === null && next.effort === null) {
      delete nextAgents[name];
    } else {
      nextAgents[name] = next;
    }
    const hasAny = Object.keys(nextAgents).length > 0;
    if (kind === 'native') {
      const { agents: _a, ...rest } = config.native;
      onChange({ ...config, native: hasAny ? { ...rest, agents: nextAgents as Record<string, SubagentTypeOverride<ModelAlias>> } : rest });
    } else if (kind === 'claude') {
      const { agents: _a, ...rest } = config.claude;
      onChange({ ...config, claude: hasAny ? { ...rest, agents: nextAgents as Record<string, SubagentTypeOverride<ModelAlias>> } : rest });
    } else {
      const { agents: _a, ...rest } = config.agy;
      onChange({ ...config, agy: hasAny ? { ...rest, agents: nextAgents } : rest });
    }
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

  // Claude 委派：别名 + 「跟随主会话」(= null)
  const claudeLevels = config.claude.model ? effortsFor(config.claude.model, modelList) : EFFORTS.map((e) => e.id);
  const claudeModels: MenuEntry[] = [
    {
      key: 'cm:follow',
      label: '跟随主会话',
      note: '使用主会话当前的模型',
      checked: config.claude.model === null,
      onSelect: () => setClaude({ model: null }),
    },
    ...primaryModels.map((m): MenuEntry => ({
      key: `cm:${m.id}`,
      label: m.label,
      note: m.note,
      checked: config.claude.model === m.id,
      onSelect: () => {
        const nextLevels = effortsFor(m.id, modelList);
        setClaude({ model: m.id as ModelAlias, effort: fit(config.claude.effort, nextLevels) });
      },
    })),
  ];
  const claudeEfforts: MenuEntry[] = [
    {
      key: 'ce:follow',
      label: '跟随主会话',
      note: '使用主会话当前的思考强度',
      checked: config.claude.effort === null,
      onSelect: () => setClaude({ effort: null }),
    },
    ...EFFORTS.filter((e) => claudeLevels?.includes(e.id)).map((e): MenuEntry => ({
      key: `ce:${e.id}`,
      label: e.label,
      checked: config.claude.effort === e.id,
      onSelect: () => setClaude({ effort: e.id }),
    })),
  ];

  // Antigravity 委派：按需拉取模型列表
  const agyList = delegate?.models ?? [];
  const cur = delegate?.current ?? null;
  const nameOf = (v: string) => agyList.find((m) => m.value === v)?.displayName ?? v;
  const effortsOf = (v: string | undefined) => agyList.find((m) => m.value === v)?.efforts;
  const agyEffortsList = effortsOf(config.agy.model ?? cur?.model);
  const agyStatus: MenuEntry[] = [];
  if (delegateError) agyStatus.push({ kind: 'text', key: 'err', text: `读取模型列表失败：${delegateError}` });
  else if (!delegate) agyStatus.push({ kind: 'text', key: 'load', text: '正在读取模型列表…' });
  const agyModels: MenuEntry[] = [
    {
      key: 'default',
      label: '默认',
      note: cur ? `跟随后端默认：${nameOf(cur.model)}` : '跟随后端自己的设置',
      checked: config.agy.model === null,
      onSelect: () => setAgy({ model: null, effort: fit(config.agy.effort, effortsOf(cur?.model)) }),
    },
    ...agyList.map((m): MenuEntry => ({
      key: `m:${m.value}`,
      label: m.displayName,
      checked: config.agy.model === m.value,
      onSelect: () => setAgy({ model: m.value, effort: fit(config.agy.effort, m.efforts) }),
    })),
  ];
  if (config.agy.model && delegate && !effortsOf(config.agy.model)) {
    agyModels.push({ key: 'gone', label: config.agy.model, note: '不在当前模型列表里', checked: true, disabled: true });
  }
  agyModels.push(
    ...agyStatus,
    { kind: 'sep', key: 'sep' },
    {
      key: 'refresh',
      label: delegateLoading ? '正在刷新模型列表…' : '刷新模型列表',
      disabled: delegateLoading,
      keepOpen: true,
      onSelect: () => onLoadDelegate(true),
    },
  );
  const agyEfforts: MenuEntry[] = [
    {
      key: 'default',
      label: '默认',
      note: config.agy.model === null && cur?.effort ? `跟随后端默认：${effortLabel(cur.effort)}` : undefined,
      checked: config.agy.effort === null,
      onSelect: () => setAgy({ effort: null }),
    },
    ...(agyEffortsList ?? []).map((e): MenuEntry => ({
      key: `e:${e}`,
      label: effortLabel(e),
      checked: config.agy.effort === e,
      onSelect: () => setAgy({ effort: e }),
    })),
  ];
  if (agyEffortsList && !agyEffortsList.length) agyEfforts.push({ kind: 'text', key: 'none', text: '该模型不分思考强度' });
  agyEfforts.push(...agyStatus);
  const loadAgy = () => {
    if (!delegate && !delegateLoading) onLoadDelegate(false);
  };

  // 收起时标题右侧的摘要：类型 · 模型
  const nativeLabel = menuModelLabel(config.native.model, modelList, modelMap);
  const claudeLabel = config.claude.model ? menuModelLabel(config.claude.model, modelList, modelMap) : '跟随主会话';
  const agyLabel = config.agy.model ? nameOf(config.agy.model) : '默认';
  const modelOfKind: Record<SubagentKind, string> = { native: nativeLabel, claude: claudeLabel, agy: agyLabel };
  const extra = fallback
    ? `已退回原生 · ${nativeLabel}`
    : `${KIND_META[effective].label} · ${modelOfKind[effective]}`;

  // 键盘 roving tabindex：若当前配置项已不可用，焦点落到实际生效项或首个可用项
  const enabledKinds = SUBAGENT_KINDS.filter((k) => available[k]?.ok);
  const focusKind = available[config.kind]?.ok ? config.kind : (available[effective]?.ok ? effective : enabledKinds[0] ?? 'native');

  const onRadioKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!enabledKinds.length) return;
    let next: SubagentKind | undefined;
    const focused = enabledKinds.find((k) => btnRefs.current[k] === document.activeElement);
    const baseKind = focused ?? (enabledKinds.includes(config.kind) ? config.kind : focusKind);
    const curIdx = Math.max(0, enabledKinds.indexOf(baseKind));
    const len = enabledKinds.length;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      next = enabledKinds[(curIdx + 1) % len];
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = enabledKinds[(curIdx - 1 + len) % len];
    } else if (e.key === 'Home') {
      next = enabledKinds[0];
    } else if (e.key === 'End') {
      next = enabledKinds[len - 1];
    }
    if (!next) return;
    e.preventDefault();
    setKind(next);
    btnRefs.current[next]?.focus();
  };

  // 其他不可用项的原因说明（已被退回横幅说明的不重复列）
  const unavailNotes = SUBAGENT_KINDS.filter((k) => !available[k]?.ok && !(fallback && k === config.kind));
  const meta = KIND_META[config.kind];
  const effMeta = KIND_META[effective];
  const availReason = available[config.kind]?.reason;
  const fallbackText =
    state.fallbackReason
    || (available[config.kind]?.ok
      ? '委派工具已停用'
      : `${KIND_META[config.kind].label} 不可用${availReason ? `（${availReason}）` : ''}`);
  const accountLabel =
    config.kind === 'native'
      ? '跟随主代理账号'
      : config.kind === 'claude'
        ? (accounts?.claude || null)
        : (accounts?.agy || null);

  // 代理类型列表与开关状态
  const agentTypes = resolveAgentTypes(state.agents, sessionAgents, config.kind);
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
          aria-label="子代理类型"
          onKeyDown={onRadioKeyDown}
        >
          <LiquidCapsule activeKey={config.kind} selector=".cz-sub__opt.is-active" axis="x" />
          {SUBAGENT_KINDS.map((k) => {
            const avail = available[k] ?? { ok: false };
            const active = config.kind === k;
            const m = KIND_META[k];
            return (
              <button
                key={k}
                ref={(el) => { btnRefs.current[k] = el; }}
                type="button"
                role="radio"
                aria-checked={active}
                tabIndex={k === focusKind ? 0 : -1}
                disabled={!avail.ok}
                className={`cz-sub__opt${active ? ' is-active' : ''}`}
                title={!avail.ok ? (avail.reason || `${m.label} 不可用`) : m.desc}
                onClick={() => setKind(k)}
              >
                <BrandIcon kind={m.icon} size={15} />
                <span className="cz-sub__opt-label">{m.label}</span>
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

        {unavailNotes.length > 0 && (
          <div className="cz-sub__unavail">
            {unavailNotes.map((k) => (
              <div key={k} className="cz-sub__unavail-item">
                {KIND_META[k].label} 不可用：{available[k]?.reason || '当前环境不可用'}
              </div>
            ))}
          </div>
        )}

        <div ref={panelRef} className="cz-sub__panel">
          <div
            key={config.kind}
            ref={stageRef}
            className="cz-sub__stage"
            style={{ '--sub-dir': dirRef.current } as React.CSSProperties}
          >
            <div className={`cz-sub__card${fallback ? ' is-dim' : ''}`}>
              <p className="cz-sub__desc">{meta.desc}</p>
              <div className="cz-sub__tools" aria-label="工具状态">
                {/* 工具开关按实际生效的类型显示：退回原生时这里要和提示条一致 */}
                <span className={`cz-sub__pill${effMeta.agentToolOn ? ' is-on' : ' is-off'}`}>
                  <span className="cz-sub__dot" aria-hidden="true" />
                  Agent 工具 {effMeta.agentToolOn ? '开' : '关'}
                </span>
                <span className={`cz-sub__pill${effMeta.delegateToolOn ? ' is-on' : ' is-off'}`}>
                  <span className="cz-sub__dot" aria-hidden="true" />
                  委派工具 {effMeta.delegateToolOn ? '开' : '关'}
                </span>
              </div>

              {accountLabel && (
                <div className="cz-sub__acct">
                  <span className="cz-sub__acct-k">账号：</span>
                  <span className="cz-sub__acct-v" title={accountLabel}>{accountLabel}</span>
                </div>
              )}

              <div className="cz-sub__fields">
                {config.kind === 'native' && (
                  <>
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
                  </>
                )}

                {config.kind === 'claude' && (
                  <>
                    <div className={`cz-sub__field${claudeLevels ? '' : ' is-full'}`}>
                      <span className="cz-sub__field-label">默认模型</span>
                      <Pick name="Claude 委派模型" label={claudeLabel} items={claudeModels} />
                    </div>
                    {claudeLevels && (
                      <div className="cz-sub__field">
                        <span className="cz-sub__field-label">默认思考强度</span>
                        <Pick name="Claude 委派思考强度" label={config.claude.effort ? effortLabel(config.claude.effort) : '跟随主会话'} items={claudeEfforts} effort />
                      </div>
                    )}
                  </>
                )}

                {config.kind === 'agy' && (
                  <>
                    <div className="cz-sub__field">
                      <span className="cz-sub__field-label">默认模型</span>
                      <Pick name="Antigravity 模型" label={agyLabel} items={agyModels} onOpen={loadAgy} />
                    </div>
                    <div className="cz-sub__field">
                      <span className="cz-sub__field-label">默认思考强度</span>
                      <Pick name="Antigravity 思考强度" label={config.agy.effort ? effortLabel(config.agy.effort) : '默认'} items={agyEfforts} onOpen={loadAgy} effort />
                    </div>
                  </>
                )}
              </div>
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
                  {agentTypes.map((agent) => (
                    <AgentTypeRow
                      key={agent.name}
                      agent={agent}
                      kind={config.kind}
                      config={config}
                      enabled={!disabledSet.has(agent.name)}
                      expanded={expandedAgents.has(agent.name)}
                      onToggleExpand={() => toggleAgentExpand(agent.name)}
                      onToggleAgent={onToggleAgent}
                      onOverride={(next) => setAgentOverride(config.kind, agent.name, next)}
                      primaryModels={primaryModels}
                      modelList={modelList}
                      modelMap={modelMap}
                      delegate={delegate}
                      delegateError={delegateError}
                      delegateLoading={delegateLoading}
                      onLoadDelegate={onLoadDelegate}
                      loadAgy={loadAgy}
                      nativeLabel={nativeLabel}
                      claudeLabel={claudeLabel}
                    />
                  ))}
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

interface AgentTypeRowProps {
  agent: SubagentTypeInfo;
  kind: SubagentKind;
  config: SubagentConfig;
  enabled: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onToggleAgent?: (name: string, enabled: boolean) => void;
  onOverride: (next: SubagentTypeOverride) => void;
  primaryModels: ReturnType<typeof menuModels>['primary'];
  modelList?: readonly CliModel[] | null;
  modelMap?: ApiModelMap | null;
  delegate: DelegateModelList | null;
  delegateError?: string | null;
  delegateLoading?: boolean;
  onLoadDelegate: (refresh: boolean) => void;
  loadAgy: () => void;
  nativeLabel: string;
  claudeLabel: string;
}

function AgentTypeRow({
  agent, kind, config, enabled, expanded, onToggleExpand, onToggleAgent, onOverride,
  primaryModels, modelList, modelMap, delegate, delegateError, delegateLoading, onLoadDelegate, loadAgy,
  nativeLabel, claudeLabel,
}: AgentTypeRowProps) {
  const detailId = useId();
  const ov: SubagentTypeOverride = config[kind].agents?.[agent.name] ?? { model: null, effort: null };
  const desc = BUILTIN_AGENTS[agent.name] || agent.description || '';
  const sourceTag = SOURCE_TAG[agent.source];

  const agyList = delegate?.models ?? [];
  const cur = delegate?.current ?? null;
  const nameOf = (v: string) => agyList.find((m) => m.value === v)?.displayName ?? v;
  const effortsOf = (v: string | undefined) => agyList.find((m) => m.value === v)?.efforts;

  // 当前后端默认值说明（供「跟随默认」选项 note 使用）
  const defaultModelText =
    kind === 'native'
      ? nativeLabel
      : kind === 'claude'
        ? claudeLabel
        : (config.agy.model ? nameOf(config.agy.model) : (cur ? nameOf(cur.model) : '后端默认'));
  const defaultEffortText =
    kind === 'native'
      ? effortLabel(config.native.effort)
      : kind === 'claude'
        ? (config.claude.effort ? effortLabel(config.claude.effort) : '跟随主会话')
        : (config.agy.effort ? effortLabel(config.agy.effort) : (config.agy.model === null && cur?.effort ? effortLabel(cur.effort) : '后端默认'));

  const followModelNote = `跟随默认：${defaultModelText}${agent.model ? `（定义里写的是 ${agent.model}）` : ''}`;
  const followEffortNote = `跟随默认：${defaultEffortText}${agent.effort ? `（定义里写的是 ${effortLabel(agent.effort)}）` : ''}`;

  // 收起时的单独配置摘要
  let overrideSummary = '';
  if (ov.model !== null || ov.effort !== null) {
    const mStr = ov.model !== null
      ? (kind === 'agy' ? nameOf(ov.model) : menuModelLabel(ov.model, modelList, modelMap))
      : null;
    const eStr = ov.effort !== null ? effortLabel(ov.effort) : null;
    if (mStr && eStr) overrideSummary = `${mStr} · ${eStr}`;
    else if (mStr) overrideSummary = mStr;
    else if (eStr) overrideSummary = `默认 · ${eStr}`;
  }

  // 构建当前后端下的模型与思考强度下拉项
  let modelLabel = '跟随默认';
  let effortText = '跟随默认';
  let modelItems: MenuEntry[] = [];
  let effortItems: MenuEntry[] = [];
  let showEffort = true;
  let onOpenMenu: (() => void) | undefined;

  if (kind === 'native' || kind === 'claude') {
    const baseModel = kind === 'native' ? config.native.model : config.claude.model;
    const effModel = ov.model ?? baseModel;
    const levels = effModel ? effortsFor(effModel, modelList) : EFFORTS.map((e) => e.id);
    const defaultLevels = baseModel ? effortsFor(baseModel, modelList) : EFFORTS.map((e) => e.id);
    showEffort = !!levels;
    if (ov.model) modelLabel = menuModelLabel(ov.model, modelList, modelMap);
    if (ov.effort) effortText = effortLabel(ov.effort);

    modelItems = [
      {
        key: 'follow',
        label: '跟随默认',
        note: followModelNote,
        checked: ov.model === null,
        onSelect: () => onOverride({ model: null, effort: fit(ov.effort, defaultLevels) }),
      },
      ...primaryModels.map((m): MenuEntry => ({
        key: `m:${m.id}`,
        label: m.label,
        note: m.note,
        checked: ov.model === m.id,
        onSelect: () => onOverride({ model: m.id as ModelAlias, effort: fit(ov.effort, effortsFor(m.id, modelList)) }),
      })),
    ];
    effortItems = [
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
  } else {
    onOpenMenu = loadAgy;
    const effModel = ov.model ?? config.agy.model ?? cur?.model;
    const agyEffortsList = effortsOf(effModel);
    const agyStatus: MenuEntry[] = [];
    if (delegateError) agyStatus.push({ kind: 'text', key: 'err', text: `读取模型列表失败：${delegateError}` });
    else if (!delegate) agyStatus.push({ kind: 'text', key: 'load', text: '正在读取模型列表…' });

    if (ov.model) modelLabel = nameOf(ov.model);
    if (ov.effort) effortText = effortLabel(ov.effort);

    modelItems = [
      {
        key: 'follow',
        label: '跟随默认',
        note: followModelNote,
        checked: ov.model === null,
        onSelect: () => onOverride({ model: null, effort: fit(ov.effort, effortsOf(config.agy.model ?? cur?.model)) }),
      },
      ...agyList.map((m): MenuEntry => ({
        key: `m:${m.value}`,
        label: m.displayName,
        checked: ov.model === m.value,
        onSelect: () => onOverride({ model: m.value, effort: fit(ov.effort, m.efforts) }),
      })),
    ];
    if (ov.model && delegate && !effortsOf(ov.model)) {
      modelItems.push({ key: 'gone', label: ov.model, note: '不在当前模型列表里', checked: true, disabled: true });
    }
    modelItems.push(
      ...agyStatus,
      { kind: 'sep', key: 'sep' },
      {
        key: 'refresh',
        label: delegateLoading ? '正在刷新模型列表…' : '刷新模型列表',
        disabled: delegateLoading,
        keepOpen: true,
        onSelect: () => onLoadDelegate(true),
      },
    );

    effortItems = [
      {
        key: 'follow',
        label: '跟随默认',
        note: followEffortNote,
        checked: ov.effort === null,
        onSelect: () => onOverride({ model: ov.model, effort: null }),
      },
      ...(agyEffortsList ?? []).map((e): MenuEntry => ({
        key: `e:${e}`,
        label: effortLabel(e),
        checked: ov.effort === e,
        onSelect: () => onOverride({ model: ov.model, effort: e }),
      })),
    ];
    if (agyEffortsList && !agyEffortsList.length) effortItems.push({ kind: 'text', key: 'none', text: '该模型不分思考强度' });
    effortItems.push(...agyStatus);
  }

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
              <span className="cz-sub__agent-ov" title={`单独配置：${overrideSummary}`}>{overrideSummary}</span>
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
              <Pick name={`${agent.name} 模型`} label={modelLabel} items={modelItems} onOpen={onOpenMenu} />
            </div>
            {showEffort && (
              <div className="cz-sub__field">
                <span className="cz-sub__field-label">思考强度</span>
                <Pick name={`${agent.name} 思考强度`} label={effortText} items={effortItems} onOpen={onOpenMenu} effort />
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

function Pick({ name, label, items, onOpen, effort }: { name: string; label: string; items: MenuEntry[]; onOpen?: () => void; effort?: boolean }) {
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
        <span className="cz-ctx__pick-label">{label}</span>
        <Icon name="chevron-down" size={11} />
      </button>
      {at && <Menu anchor={at} items={items} onClose={() => setAt(null)} placement="top" align="end" minWidth={180} />}
    </>
  );
}
