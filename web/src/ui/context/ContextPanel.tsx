// 右侧上下文面板：已用占比 / 分段条 / 分类明细 / deferred / Skills（三态）/ MCP（按服务器开关）/ 子代理 / 压缩。
// 约定：ContextUsage.percent 与 categories[].percent 均按 0–100 解释（22.6 表示 22.6%）。
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BUILTIN_PRICES,
  type CachePoint, type CliModelCost, type CompactMark, type ContextMcpServer, type ContextSkill, type ContextUsage, type PriceTable,
  type SkillMode, type SubagentCost, type ToolLoadClass, type ToolLoadEntry, type ToolStats as ToolStatsData, type ToolTokenEntry, type Turn,
} from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { viewportBounds } from '../layout/viewport';
import { Menu, type MenuEntry } from '../menus/Menu';
import { CountUp } from '../motion/CountUp';
import { useWake } from '../motion/useWake';
import { useHeld } from '../motion/useHeld';
import { Subagents, type SubagentsProps } from './Subagents';
import { CacheChart } from './CacheChart';
import { ContextChart } from './ContextChart';
import { CostSection, type Billing } from './CostSection';
import { Chevron, Fold, Reveal } from './Fold';
import { Switch } from './Switch';
import { toolInfo } from './toolCatalog';
import { COSYEE_TOOL_PREFIX, isCosyeeTool } from '../../core/reducer/util';
import {
  callsOf, COSYEE_MCP_SERVER, DELEGATE_TOOL, delegateAuxItems, groupToolRows, skillCallCounts, skillCallsOf, toolCallCounts, toolLabel, toolRows, totalCallsOf, totalSkillCallsOf,
  type DelegateAuxItem, type SkillCalls, type ToolCalls, type ToolGroup, type ToolRow,
} from './tools';
import { formatPercent, formatTokens } from './formatTokens';
import { skillBaseName, skillInfo } from './skillCatalog';
import './ContextPanel.css';

export interface ContextPanelProps {
  usage: ContextUsage | null;
  loading: boolean;
  onRefresh: () => void;
  onCompact: () => void;
  /** 设置 skill 状态；不传则只读 */
  onSkillMode?: (name: string, mode: SkillMode) => void;
  /** 批量设置 skill 状态（勾选批量操作 / 撤销）；不传则批量操作不可用 */
  onSkillModes?: (modes: Record<string, SkillMode>) => void;
  /** 移除用户级 / 项目级 skill（目录移到备份，不直接删除） */
  onSkillRemove?: (name: string) => void;
  /** 在文件管理器中打开 skill 的位置；远程连接不传，不显示该菜单项 */
  onSkillReveal?: (name: string) => void;
  /** 开关 MCP 服务器；不传则只读 */
  onMcpToggle?: (server: string, enabled: boolean) => void;
  /** 正在切换的 MCP 服务器名（切换期间所有 MCP 开关禁用） */
  mcpBusy?: string | null;
  /** 本会话 init 报告的工具名（SessionMeta.tools）；为空时退回 usage.tools。MCP 工具（mcp__ 开头）不在这里列出 */
  tools?: string[];
  /** 启用 / 停用内置工具；不传则只读 */
  onToolToggle?: (name: string, enabled: boolean) => void;
  /** 缓存命中率走势（SessionMeta.cache）；不传或为空则显示空态 */
  cache?: CachePoint[];
  /** 会话流（上下文走势点开某次请求时，按 tool_use id 找工具摘要与结果大小） */
  turns?: Turn[];
  /** 所有会话的工具累计调用次数（GET /api/tools/stats）；不传或为 null 时只显示本会话的次数 */
  toolStats?: ToolStatsData | null;
  /** 「压缩会话」不可用（例如还没发过消息的新会话、回合进行中） */
  compactDisabled?: boolean;
  /** 设置自动压缩窗口（全局，token 数；null = 恢复默认）；不传则只显示不可改 */
  onCompactWindow?: (window: number | null) => void;
  /** 收起面板；不传则不显示收起按钮 */
  onCollapse?: () => void;
  /** 压缩记录（SessionMeta.compactions）：花费图上画成虚线，并用于预估下一次请求 */
  compactions?: CompactMark[];
  /** 价格表（GET /api/pricing）；不传用内置表 */
  pricing?: PriceTable;
  /** 子代理花费；还没取到为 null */
  subCosts?: SubagentCost[] | null;
  /** CLI result 报告的按模型花费（SessionMeta.cliCost），用来核对价格表 */
  cliCost?: CliModelCost[];
  /** 会话的模型（请求里没带模型时按它定价） */
  model?: string;
  /** 计费方式，决定花费一节的标题与说明 */
  billing?: Billing;
  /** 「子代理」（智能体下方）；不传则不显示 */
  subagents?: SubagentsProps | null;
  /** 点花费图的柱子跳到会话流里的这一轮 */
  onJumpTurn?: (turn: number) => void;
}

const SKILL_MODES: { mode: SkillMode; label: string; hint: string; icon: IconName }[] = [
  { mode: 'on', label: '开', hint: '模型能看到，会按需自动调用', icon: 'skill-on' },
  { mode: 'user-invocable-only', label: '手动', hint: '模型看不到，只能输入 /名字 手动调用（不占上下文）', icon: 'skill-manual' },
  { mode: 'off', label: '关', hint: '模型和 / 菜单都看不到', icon: 'skill-off' },
];
const MODE_INFO = Object.fromEntries(SKILL_MODES.map((m) => [m.mode, m])) as Record<SkillMode, (typeof SKILL_MODES)[number]>;

const MCP_STATUS: Record<string, string> = {
  disabled: '已停用',
  pending: '连接中',
  failed: '连接失败',
  'needs-auth': '需登录',
  unknown: '状态未知',
};

/** 插件 skill 去掉前缀显示：anthropic-skills:pdf -> pdf */
const skillLabel = skillBaseName;

/** 分类名 → 颜色变量（局部变量定义在 ContextPanel.css；未识别的归入 other） */
function categoryColor(name: string): string {
  const k = name.trim().toLowerCase();
  if (k.includes('free')) return 'var(--cz-ctx-free)';
  if (k.includes('autocompact') || k.includes('buffer')) return 'var(--cz-ctx-buffer)';
  if (k.includes('mcp') && k.includes('instruction')) return 'var(--cz-ctx-mcp-instr)';
  if (k.includes('mcp')) return 'var(--cz-ctx-mcp-tools)';
  if (k.includes('system tools')) return 'var(--cz-ctx-sys-tools)';
  if (k.includes('system prompt')) return 'var(--cz-ctx-sys-prompt)';
  if (k.includes('message')) return 'var(--cz-ctx-messages)';
  if (k.includes('skill')) return 'var(--cz-ctx-skills)';
  if (k.includes('agent')) return 'var(--cz-ctx-agents)';
  return 'var(--cz-ctx-other)';
}

const isFree = (name: string) => name.toLowerCase().includes('free');

export function ContextPanel({
  usage: liveUsage, loading, onRefresh, onCompact, onSkillMode, onSkillModes, onSkillRemove, onSkillReveal, onMcpToggle, mcpBusy = null, tools: liveTools, onToolToggle, cache: liveCache, turns: liveTurns, toolStats = null, compactDisabled = false, onCompactWindow, onCollapse,
  compactions: liveCompactions, pricing = BUILTIN_PRICES, subCosts: liveSubCosts = null, cliCost: liveCliCost, model: liveModel, billing = 'api', onJumpTurn, subagents,
}: ContextPanelProps) {
  // 切换会话时新会话的上下文要晚到一点：这期间留着上一份（变淡），不闪成空态，也不从 0 重新滚一遍
  const live = useMemo(
    () =>
      liveUsage
        ? {
            usage: liveUsage, cache: liveCache, turns: liveTurns, tools: liveTools,
            compactions: liveCompactions, subCosts: liveSubCosts, cliCost: liveCliCost, model: liveModel,
          }
        : null,
    [liveUsage, liveCache, liveTurns, liveTools, liveCompactions, liveSubCosts, liveCliCost, liveModel],
  );
  const held = useHeld(live);
  const usage = held.value?.usage ?? null;
  const { cache, turns, tools, compactions, subCosts, cliCost, model } = held.value ?? {};
  const stale = held.stale;
  const [skillsOpen, setSkillsOpen] = useState(false);
  // 批量设置之前的状态，用于撤销；手动改任何一个 skill 或移除后失效
  const [undo, setUndo] = useState<Record<string, SkillMode> | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    if (!onSkillModes) {
      setSelecting(false);
      setSelected(new Set());
    }
  }, [onSkillModes]);
  const validSelected = useMemo(() => {
    if (!selecting || selected.size === 0) return new Set<string>();
    const names = new Set((usage?.skills ?? []).map((s) => s.name));
    const out = new Set<string>();
    for (const n of selected) if (names.has(n)) out.add(n);
    return out;
  }, [selecting, selected, usage?.skills]);
  const exitSelecting = useCallback(() => {
    setSelecting(false);
    setSelected(new Set());
  }, []);
  const toggleSelect = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  // 数据第一次到达时：数字滚动、条形擦出、走势描出、各块依次出现
  const waking = useWake(!!usage);
  // 每个工具在本会话里的调用次数（会话流每次更新都会变，按 turns 记忆）
  const callCounts = useMemo(() => toolCallCounts(turns), [turns]);
  const skillCounts = useMemo(() => skillCallCounts(turns), [turns]);
  // 去掉插件前缀后撞名的 skill 集合：撞名项改用完整名显示以消歧
  const dupSkillBases = useMemo(() => {
    const counts = new Map<string, number>();
    for (const s of usage?.skills ?? []) {
      const b = skillLabel(s.name);
      counts.set(b, (counts.get(b) ?? 0) + 1);
    }
    const dup = new Set<string>();
    for (const [b, n] of counts) if (n > 1) dup.add(b);
    return dup;
  }, [usage?.skills]);

  const refreshBtn = (
    <button
      type="button"
      className={`cz-ctx__icon-btn${loading ? ' is-busy' : ''}`}
      onClick={onRefresh}
      disabled={loading}
      title={loading ? '刷新中…' : '刷新'}
      aria-label={loading ? '刷新中' : '刷新上下文'}
    >
      <Icon name="refresh" size={16} />
    </button>
  );

  const collapseBtn = onCollapse && (
    <button type="button" className="cz-ctx__icon-btn" onClick={onCollapse} title="收起上下文栏" aria-label="收起上下文栏">
      <Icon name="panel-collapse" size={18} />
    </button>
  );

  if (!usage) {
    return (
      <div className="cz-ctx">
        <div className="cz-ctx__head">
          <h2 className="cz-ctx__title">上下文</h2>
          <div className="cz-ctx__head-actions">{collapseBtn}</div>
        </div>
        <div className="cz-ctx__empty">
          <div className="cz-ctx__empty-text">{loading ? '正在读取上下文…' : '暂无上下文数据'}</div>
          <button type="button" className="cz-ctx__btn" onClick={onRefresh} disabled={loading}>
            {loading ? '刷新中…' : '刷新'}
          </button>
        </div>
      </div>
    );
  }

  const denom = usageDenom(usage);
  const skills = usage.skills ?? [];
  // Cosyee 自带的 MCP 服务器不在这里列：它的工具（delegate 等）归到「工具」一节，按工具开关
  const servers = (usage.mcpServers ?? []).filter((s) => s.name !== COSYEE_MCP_SERVER);
  // 本会话收到过 init 就用它；没收到（探测进程不发消息 / 页面重开错过了 init）用服务端记下的
  const activeInitTools = tools?.length ? tools : usage.tools;
  const toolList = toolRows(activeInitTools, usage.disabledTools);
  const toolTok = toolTokenSummary(usage);
  const toolTokOf = new Map((usage.toolTokens ?? []).map((t) => [t.name, t]));
  const hasEstimatedTools = (usage.toolTokens ?? []).some((t) => t.estimated === true);
  const toolGroups = usage.toolLoad ? groupToolRows(toolList, usage.toolLoad) : null;
  // Cosyee 自带工具（mcp__cosyee__*）挂在 cosyee 这台 MCP 服务器下：定义原文与 token 从那里取
  const cosyeeDefs = new Map<string, ContextMcpServer['tools'][number]>(
    (usage.mcpServers ?? [])
      .find((s) => s.name === COSYEE_MCP_SERVER)
      ?.tools.map((t) => [`${COSYEE_TOOL_PREFIX}${t.name}`, t]) ?? [],
  );
  const delegateRow = toolList.find((t) => t.name === DELEGATE_TOOL);
  const delegateAux = delegateRow
    ? delegateAuxItems({
        initTools: activeInitTools,
        cosyeeTools: cosyeeDefs,
        mcpTools: usage.mcpTools,
        toolTokens: toolTokOf,
        toolLoad: usage.toolLoad,
        delegateEnabled: delegateRow.enabled,
      })
    : [];
  const sessionCalls = toolList.reduce((n, t) => {
    const c = callsOf(callCounts, t.name);
    return n + c.main + c.sub;
  }, 0);
  const allCounts = toolStats?.counts;
  const allCalls = allCounts ? toolList.reduce((n, t) => n + totalCallsOf(allCounts, t.name), 0) : null;
  const offCount = toolList.filter((t) => !t.enabled).length;

  return (
    <div className={`cz-ctx${loading ? ' is-loading' : ''}${waking ? ' is-waking' : ''}${stale ? ' is-stale' : ''}`} aria-busy={stale || undefined}>
      <div className="cz-ctx__head">
        <h2 className="cz-ctx__title">上下文</h2>
        <div className="cz-ctx__head-actions">
          {refreshBtn}
          {collapseBtn}
        </div>
      </div>

      <div className="cz-ctx__body">
        {/* 概览 */}
        <section className="cz-ctx__overview">
          <CountUp className="cz-ctx__percent" value={usage.percent} format={formatPercent} play={waking} duration={1000} />
          <div className="cz-ctx__used">
            <CountUp value={usage.usedTokens} format={formatTokens} play={waking} duration={1000} /> / {formatTokens(usage.totalTokens)}
          </div>
        </section>

        <Breakdown usage={usage} denom={denom} />

        {/* 上下文走势：每次请求的输入大小，点柱子看增长来自哪些工具 */}
        <section className="cz-ctx__section">
          <h3 className="cz-ctx__sub">上下文走势</h3>
          <ContextChart points={cache} turns={turns} intro={waking} />
        </section>

        {/* deferred：延迟加载项的占用，单独一节 */}
        {usage.deferred.length > 0 && (
          <section className="cz-ctx__section">
            <h3 className="cz-ctx__sub">延迟加载（deferred）</h3>
            <ul className="cz-ctx__list cz-ctx__list--plain">
              {usage.deferred.map((d) => (
                <DeferredRow key={d.name} name={d.name} tokens={d.tokens} />
              ))}
            </ul>
          </section>
        )}

        {/* 缓存命中率走势 */}
        <section className="cz-ctx__section">
          <h3 className="cz-ctx__sub">缓存命中率</h3>
          <CacheChart points={cache} intro={waking} />
        </section>

        {/* 花费：按价格表算的会话金额 */}
        <CostSection
          points={cache}
          turns={turns}
          compactions={compactions}
          subs={subCosts}
          table={pricing}
          fallbackModel={model}
          historyTokens={usage.categories.find((c) => c.name.trim().toLowerCase().includes('message'))?.tokens ?? null}
          cliCost={cliCost}
          billing={billing}
          intro={waking}
          onJumpTurn={onJumpTurn}
        />

        {/* 可展开：Skills（开 / 手动 / 关 三态） */}
        <Collapsible
          title="Skills"
          count={skills.length}
          extra={skillSummary(skills)}
          cols={{ total: !!toolStats?.skills, tokens: true }}
          open={skillsOpen}
          onToggle={() => {
            if (skillsOpen) exitSelecting();
            setSkillsOpen((v) => !v);
          }}
          toolbar={
            <SkillToolbar
              skills={skills}
              selecting={selecting}
              selected={validSelected}
              undo={undo}
              enabled={!!onSkillModes}
              onEnter={() => setSelecting(true)}
              onExit={exitSelecting}
              onToggleAll={() => {
                if (skills.length > 0 && validSelected.size === skills.length) setSelected(new Set());
                else setSelected(new Set(skills.map((s) => s.name)));
              }}
              onApplyMode={(mode) => {
                const changes: Record<string, SkillMode> = {};
                const prev: Record<string, SkillMode> = {};
                for (const s of skills) {
                  if (!validSelected.has(s.name) || s.mode === mode) continue;
                  changes[s.name] = mode;
                  prev[s.name] = s.mode;
                }
                if (Object.keys(changes).length === 0) return;
                setUndo(prev);
                onSkillModes?.(changes);
                setSelected(new Set());
              }}
              onUndo={() => {
                if (undo) onSkillModes?.(undo);
                setUndo(null);
              }}
            />
          }
        >
          {skills.map((s) => (
            <SkillRow
              key={s.name}
              skill={s}
              ambiguous={dupSkillBases.has(skillLabel(s.name))}
              calls={skillCallsOf(skillCounts, s.name)}
              total={totalSkillCallsOf(toolStats?.skills, s.name)}
              selecting={selecting}
              checked={validSelected.has(s.name)}
              onToggleSelect={toggleSelect}
              onRemove={
                onSkillRemove &&
                ((name) => {
                  setUndo(null);
                  onSkillRemove(name);
                })
              }
              onReveal={onSkillReveal}
              onMode={
                onSkillMode &&
                ((name, mode) => {
                  setUndo(null);
                  onSkillMode(name, mode);
                })
              }
            />
          ))}
        </Collapsible>

        {/* 可展开：内置工具（按常驻 / 懒加载 / 未确定分组；停用名单全局保存） */}
        <Fold
          title="工具"
          count={toolList.length}
          extra={[toolTok.resident !== null && formatTokens(toolTok.resident), offCount > 0 && `${offCount} 已停用`].filter(Boolean).join(' · ') || undefined}
          open={toolsOpen}
          onToggle={() => setToolsOpen((v) => !v)}
        >
          <ToolStats
            resident={toolTok.resident}
            deferred={toolTok.deferred}
            perTool={toolTokOf.size > 0}
            estimated={hasEstimatedTools}
            session={sessionCalls}
            all={allCalls}
            sessions={toolStats?.sessions ?? 0}
          />
          <p className="cz-ctx__note">停用后当前会话立即拦截调用；新会话里模型将看不到该工具。设置对所有会话生效。</p>
          {toolGroups ? (
            <div className="cz-ctx__tgroups">
              {toolGroups.map((g) => (
                <ToolGroupSection
                  key={g.load}
                  group={g}
                  toolLoad={usage.toolLoad}
                  toolTokOf={toolTokOf}
                  cosyeeDefs={cosyeeDefs}
                  delegateAux={delegateAux}
                  callCounts={callCounts}
                  allCounts={allCounts}
                  sums={toolTok}
                  showTokens={toolTokOf.size > 0}
                  onToggle={onToolToggle}
                />
              ))}
            </div>
          ) : (
            <ul className="cz-ctx__list cz-ctx__list--plain cz-ctx__list--cols">
              <li className="cz-ctx__cols" aria-hidden="true">
                <span className="cz-ctx__tool-calls" title="本会话的调用次数">本会话</span>
                {!!allCounts && <span className="cz-ctx__tool-total" title="所有会话累计的调用次数">累计</span>}
                {toolTokOf.size > 0 && <span className="cz-ctx__item-tokens" title="占用的 token">占用</span>}
              </li>
              {toolList.map((t) => (
                <ToolItem
                  key={t.name}
                  tool={t}
                  calls={callsOf(callCounts, t.name)}
                  total={allCounts ? totalCallsOf(allCounts, t.name) : null}
                  tokens={toolTokOf.get(t.name)}
                  loadEntry={usage.toolLoad?.[t.name]}
                  showTokenCol={toolTokOf.size > 0}
                  def={cosyeeDefs.get(t.name)}
                  auxTools={t.name === DELEGATE_TOOL ? delegateAux : undefined}
                  sums={toolTok}
                  onToggle={onToolToggle}
                />
              ))}
            </ul>
          )}
        </Fold>

        {/* 可展开：MCP（按服务器开关，点名字展开工具） */}
        <Collapsible
          title="MCP"
          count={servers.length}
          extra={`${servers.filter((s) => s.status === 'connected').length} 已连接`}
          open={mcpOpen}
          onToggle={() => setMcpOpen((v) => !v)}
        >
          {servers.map((s) => (
            <McpRow key={s.name} server={s} busy={mcpBusy} onToggle={onMcpToggle} />
          ))}
        </Collapsible>

        {subagents && <Subagents {...subagents} fallbackDisabledAgents={subagents.fallbackDisabledAgents ?? usage.disabledAgents} />}
      </div>

      {/* 底部：自动压缩 */}
      <div className="cz-ctx__foot">
        <CompactWindowRow
          until={usage.untilAutocompact}
          value={usage.compactWindow ?? null}
          threshold={usage.autoCompactThreshold}
          onChange={onCompactWindow}
        />
        <button type="button" className="cz-ctx__btn cz-ctx__btn--block" onClick={onCompact} disabled={compactDisabled}>
          <Icon name="compact" size={14} />
          <span>压缩会话</span>
        </button>
      </div>
    </div>
  );
}

/** 分段条的分母：通常是总量；若分类合计超过总量（数据不一致）就按合计，避免条溢出 */
export function usageDenom(usage: ContextUsage): number {
  const catSum = usage.categories.reduce((s, c) => s + Math.max(0, c.tokens), 0);
  return Math.max(usage.totalTokens, catSum, 1);
}

/** 上下文占用的分段条（上下文栏和收起后的图表浮层共用）：hot 是被指着的那一类，条上只亮这一段 */
export function UsageBar({ usage, denom, hot, onHot }: { usage: ContextUsage; denom: number; hot: string | null; onHot: (name: string | null) => void }) {
  const on = hot !== null && usage.categories.some((c) => c.name === hot && c.tokens > 0);
  return (
    <div className={`cz-ctx__bar${on ? ' has-hot' : ''}`} role="img" aria-label={`已用 ${formatPercent(usage.percent)}`}>
      {usage.categories.filter((c) => c.tokens > 0).map((c) => (
        <span
          key={c.name}
          className={`cz-ctx__seg${c.name === hot ? ' is-hot' : ''}`}
          style={{ width: `${(c.tokens / denom) * 100}%`, background: categoryColor(c.name) }}
          title={`${c.name}：${formatTokens(c.tokens)}`}
          onMouseEnter={() => onHot(c.name)}
          onMouseLeave={() => onHot(null)}
        />
      ))}
    </div>
  );
}

/** 分段条 + 分类明细：指着某一类时，条上只亮这一段（反过来也一样） */
function Breakdown({ usage, denom }: { usage: ContextUsage; denom: number }) {
  const [hot, setHot] = useState<string | null>(null);
  return (
    <>
      <UsageBar usage={usage} denom={denom} hot={hot} onHot={setHot} />
      <ul className="cz-ctx__list cz-ctx__list--cats">
        {usage.categories.map((c) => (
          <CategoryRow key={c.name} cat={c} denom={denom} hot={c.name === hot} onHot={setHot} />
        ))}
      </ul>
    </>
  );
}

/** 与服务端 COMPACT_WINDOW_MIN / MAX 一致（单位 k token） */
const WINDOW_MIN_K = 50;
const WINDOW_MAX_K = 1000;

/** 输入框内容 → token 数：空 = 恢复默认（null）；接受「150」「150k」「1m」；不合法返回 undefined */
export function parseCompactWindow(text: string): number | null | undefined {
  const t = text.trim().toLowerCase().replace(/,/g, '');
  if (!t) return null;
  const m = /^(\d+(?:\.\d+)?)\s*(k|m)?$/.exec(t);
  if (!m) return undefined;
  const k = Number(m[1]) * (m[2] === 'm' ? 1000 : 1);
  if (!Number.isFinite(k) || k < WINDOW_MIN_K || k > WINDOW_MAX_K) return undefined;
  return Math.round(k * 1000);
}

/** 底部一行：距自动压缩还剩多少 + 自动压缩窗口（点开就地编辑，单位 k token） */
function CompactWindowRow({
  until, value, threshold, onChange,
}: {
  until: number | null;
  /** Cosyee 设置的窗口；null = 不覆盖 */
  value: number | null;
  /** CLI 报告的触发点 */
  threshold?: number;
  onChange?: (window: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const finish = (w: number | null) => {
    setEditing(false);
    if (w !== value) onChange?.(w);
  };
  const commit = () => {
    const w = parseCompactWindow(text);
    if (w === undefined) setInvalid(true);
    else finish(w);
  };

  if (editing) {
    return (
      <div className="cz-ctx__cw-edit">
        <div className="cz-ctx__cw-line">
          <span className="cz-ctx__cw-field">
            <label className="cz-ctx__cw-label" htmlFor="cz-ctx-cw">压缩窗口</label>
            <input
              id="cz-ctx-cw"
              ref={inputRef}
              className={`cz-ctx__cw-input${invalid ? ' is-invalid' : ''}`}
              inputMode="numeric"
              placeholder="默认"
              value={text}
              aria-invalid={invalid || undefined}
              onChange={(e) => {
                setText(e.target.value);
                setInvalid(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commit();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(false);
                }
              }}
            />
            <span className="cz-ctx__cw-unit">k</span>
          </span>
          <span className="cz-ctx__cw-acts">
            <button type="button" className="cz-ctx__link" onClick={() => finish(null)} disabled={value === null} title="不覆盖，窗口与自动压缩开关都沿用 ~/.claude/settings.json 或 CLI 默认">
              默认
            </button>
            <button type="button" className="cz-ctx__link" onClick={() => setEditing(false)}>取消</button>
            <button type="button" className="cz-ctx__link is-primary" onClick={commit}>保存</button>
          </span>
        </div>
        <p className={`cz-ctx__note${invalid ? ' is-error' : ''}`}>
          {invalid
            ? `需在 ${WINDOW_MIN_K}–${WINDOW_MAX_K}k 之间（留空 = 默认）`
            : '保存后自动开启自动压缩，上下文达到「窗口 − 约 33k」时触发。对所有会话生效，运行中的会话立即生效。'}
        </p>
      </div>
    );
  }

  const tip = [
    '自动压缩窗口：上下文达到「窗口 − 约 33k」时自动压缩',
    threshold !== undefined && `当前触发点 ${formatTokens(threshold)}`,
    value === null && '未覆盖，沿用 ~/.claude/settings.json 或 CLI 默认',
    value === null && until === null && '设置窗口会同时开启自动压缩',
    onChange && '点击修改（对所有会话生效）',
  ].filter(Boolean).join('\n');
  return (
    <div className="cz-ctx__cw-row">
      <span className="cz-ctx__autocompact">
        {until !== null ? `距自动压缩还剩 ${formatTokens(until)}` : '自动压缩未开启'}
      </span>
      <button
        type="button"
        className="cz-ctx__link cz-ctx__cw-chip"
        title={tip}
        disabled={!onChange}
        onClick={() => {
          setText(value ? String(Math.round(value / 1000)) : '');
          setInvalid(false);
          setEditing(true);
        }}
      >
        <span>窗口 {value ? formatTokens(value) : '默认'}</span>
        {onChange && <Icon name="pencil" size={12} />}
      </button>
    </div>
  );
}

function skillSummary(skills: readonly ContextSkill[]): string {
  const n = (m: SkillMode) => skills.filter((s) => s.mode === m).length;
  return `${n('on')} 开 · ${n('user-invocable-only')} 手动 · ${n('off')} 关`;
}

/** Skills 列表上方：批量操作 + 撤销；进入勾选模式后显示全选、计数、状态按钮与完成 */
function SkillToolbar({
  skills, selecting, selected, undo, enabled, onEnter, onExit, onToggleAll, onApplyMode, onUndo,
}: {
  skills: readonly ContextSkill[];
  selecting: boolean;
  selected: ReadonlySet<string>;
  undo: Record<string, SkillMode> | null;
  enabled: boolean;
  onEnter: () => void;
  onExit: () => void;
  onToggleAll: () => void;
  onApplyMode: (mode: SkillMode) => void;
  onUndo: () => void;
}) {
  const allRef = useRef<HTMLInputElement>(null);
  const count = selected.size;
  const allSelected = skills.length > 0 && count === skills.length;
  const someSelected = count > 0 && count < skills.length;
  useEffect(() => {
    if (allRef.current) allRef.current.indeterminate = someSelected;
  }, [someSelected, selecting]);

  const undoBtn = undo && (
    <button type="button" className="cz-ctx__undo" onClick={onUndo} disabled={!enabled} title="恢复到批量设置之前的状态">
      <Icon name="undo" size={13} />
      <span>撤销</span>
    </button>
  );

  if (!selecting) {
    return (
      <div className="cz-ctx__skill-bar">
        <button
          type="button"
          className="cz-ctx__batch-btn"
          disabled={!enabled || skills.length === 0}
          onClick={onEnter}
        >
          批量操作
        </button>
        {undoBtn}
      </div>
    );
  }

  return (
    <div className="cz-ctx__skill-bar is-selecting">
      <div className="cz-ctx__batch-head">
        <label className="cz-ctx__select-all">
          <input
            ref={allRef}
            type="checkbox"
            className="cz-ctx__check"
            checked={allSelected}
            disabled={skills.length === 0}
            onChange={onToggleAll}
          />
          <span>全选</span>
        </label>
        <span className="cz-ctx__select-count" aria-live="polite">已选 {count} 项</span>
        <button type="button" className="cz-ctx__batch-done" onClick={onExit}>完成</button>
      </div>
      <div className="cz-ctx__batch-acts">
        <div className="cz-ctx__batch-modes" role="group" aria-label="把所选 skill 设为">
          {SKILL_MODES.map((m) => {
            const none = count === 0;
            const same = !none && skills.every((s) => !selected.has(s.name) || s.mode === m.mode);
            return (
              <button
                key={m.mode}
                type="button"
                className={`cz-ctx__batch-mode is-${m.mode}`}
                disabled={!enabled || none || same}
                title={same ? '所选已全部是此状态' : `将所选 skill 设为「${m.label}」`}
                onClick={() => onApplyMode(m.mode)}
              >
                <Icon name={m.icon} size={14} />
                <span>{m.label}</span>
              </button>
            );
          })}
        </div>
        {undoBtn}
      </div>
    </div>
  );
}

function SkillRow({
  skill, ambiguous, calls, total, selecting = false, checked = false, onToggleSelect, onMode, onRemove, onReveal,
}: {
  skill: ContextSkill;
  /** 与列表中其他 skill 去掉前缀后同名：显示完整名消歧 */
  ambiguous: boolean;
  /** 本会话的加载次数 */
  calls: SkillCalls;
  /** 所有会话累计；取不到为 null */
  total: number | null;
  selecting?: boolean;
  checked?: boolean;
  onToggleSelect?: (name: string) => void;
  onMode?: (name: string, mode: SkillMode) => void;
  onRemove?: (name: string) => void;
  onReveal?: (name: string) => void;
}) {
  const label = ambiguous ? skill.name : skillLabel(skill.name);
  const info = skillInfo(skill.name);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const cur = MODE_INFO[skill.mode];
  const here = calls.model + calls.user + calls.sub;
  const tip = useSkillTip(skill, label, calls, total);
  const [open, setOpen] = useState(false);
  const detailId = useId();

  const items: MenuEntry[] = [
    { kind: 'text', key: 'hd', text: `${label} 的状态` },
    ...SKILL_MODES.map((m): MenuEntry => ({
      key: m.mode,
      label: (
        <span className={`cz-ctx__mode-label is-${m.mode}`}>
          <Icon name={m.icon} size={15} />
          {m.label}
        </span>
      ),
      note: m.hint,
      checked: skill.mode === m.mode,
      badge: info?.mode === m.mode ? '推荐' : undefined,
      onSelect: () => {
        if (skill.mode !== m.mode) onMode?.(skill.name, m.mode);
      },
    })),
    { kind: 'sep', key: 'sep-remove' },
    ...(onReveal
      ? [{
          key: 'reveal',
          label: (
            <span className="cz-ctx__mode-label">
              <Icon name="folder-reveal" size={15} />
              打开文件位置
            </span>
          ),
          note: skill.onDisk ? '在文件管理器中选中 SKILL.md' : '磁盘上没有找到这个 skill 的文件（可能是内置的）',
          disabled: !skill.onDisk,
          onSelect: () => onReveal(skill.name),
        }]
      : []),
    {
      key: 'remove',
      label: (
        <span className="cz-ctx__mode-label is-remove">
          <Icon name="trash" size={15} />
          移除
        </span>
      ),
      note: skill.removable ? '移到备份目录，可手动放回恢复' : '插件 / 内置 skill 不能单独移除，请用「关」',
      disabled: !skill.removable || !onRemove,
      onSelect: () => setConfirming(true),
    },
  ];

  return (
    <li ref={tip.ref} className={`cz-ctx__item cz-ctx__skill${skill.mode === 'on' ? '' : ' is-off'}${selecting && checked ? ' is-checked' : ''}`} {...tip.handlers}>
      {selecting ? (
        <label className="cz-ctx__item-name cz-ctx__row-name cz-ctx__skill-name cz-ctx__skill-check">
          <input
            type="checkbox"
            className="cz-ctx__check"
            aria-label={`选择 ${label}`}
            checked={checked}
            onChange={() => {
              tip.hide();
              onToggleSelect?.(skill.name);
            }}
          />
          <span className="cz-ctx__row-label">{label}</span>
        </label>
      ) : (
        <RowName label={label} open={open} controls={detailId} onToggle={() => { tip.hide(); setOpen((v) => !v); }} className="cz-ctx__skill-name" />
      )}
      <span className={`cz-ctx__tool-calls${here === 0 ? ' is-zero' : ''}`} aria-label={`本会话调用 ${here} 次`}>
        {here > 0 ? `×${here}` : '—'}
      </span>
      {total !== null && (
        <span className={`cz-ctx__tool-total${total === 0 ? ' is-zero' : ''}`} aria-label={`累计调用 ${total} 次`}>
          {total > 0 ? formatCount(total) : '—'}
        </span>
      )}
      <span className="cz-ctx__item-tokens">{skill.tokens === null ? '—' : formatTokens(skill.tokens)}</span>
      <button
        ref={btnRef}
        type="button"
        className={`cz-ctx__mode is-${skill.mode}${menuAt ? ' is-open' : ''}`}
        aria-haspopup="menu"
        aria-expanded={!!menuAt}
        aria-label={`${label}：当前「${cur.label}」，点击更改`}
        disabled={!onMode}
        onClick={() => {
          tip.hide();
          setMenuAt((v) => (v ? null : btnRef.current));
        }}
      >
        <Icon name={cur.icon} size={15} />
        <Icon name="chevron-down" size={11} />
      </button>
      {menuAt && <Menu anchor={menuAt} items={items} onClose={() => setMenuAt(null)} placement="bottom" align="end" minWidth={230} />}
      {!menuAt && !confirming && tip.node}
      <Reveal open={!selecting && open} id={detailId}>
        <PromptDetail
          where="Skill 清单（系统提示词）"
          tokens={skill.mode === 'on' ? skill.tokens : null}
          tokenNote={skill.mode === 'on' ? undefined : '不在系统提示词里'}
          text={skill.description ? `- ${skill.name}: ${skill.description}` : undefined}
          empty="CLI 没有报告这个 skill 的描述，磁盘上也读不到它的 SKILL.md。"
          note={
            skill.mode === 'on'
              ? '模型看到的只是这一行；真正调用时才把 SKILL.md 正文作为消息加载（计入 Messages）。'
              : skill.mode === 'user-invocable-only'
                ? '仅手动：这一行不发给模型；你输入 /名字 时才加载 SKILL.md 正文。改成「开」后会加进 Skill 清单。'
                : '已关闭：这一行不发给模型，/ 菜单里也没有。改成「开」后会加进 Skill 清单。'
          }
        />
      </Reveal>
      {confirming && (
        <div className="cz-ctx__confirm" role="alertdialog" aria-label={`移除 ${label}`}>
          <span className="cz-ctx__confirm-text">移除「{label}」？目录会移到备份，新会话起不再加载</span>
          <button type="button" className="cz-ctx__confirm-btn" onClick={() => setConfirming(false)}>取消</button>
          <button
            type="button"
            className="cz-ctx__confirm-btn is-danger"
            onClick={() => {
              setConfirming(false);
              onRemove?.(skill.name);
            }}
          >
            移除
          </button>
        </div>
      )}
    </li>
  );
}

/** MCP 状态的中文说明（悬浮提示） */
const MCP_STATUS_HINT: Record<string, string> = {
  connected: '已连接，工具可用。',
  disabled: '已停用：工具不会发给模型。',
  pending: '正在连接，稍后会自动刷新。',
  failed: '连接失败：检查服务器命令 / 地址，或在终端运行 /mcp 查看原因。',
  'needs-auth': '需要登录授权：在终端运行 /mcp 完成登录后才能使用。',
  unknown: '读不到 MCP 状态，刷新后再试。',
};

function McpRow({
  server,
  busy,
  onToggle,
}: {
  server: ContextMcpServer;
  busy: string | null;
  onToggle?: (server: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const enabled = server.status !== 'disabled';
  const switching = busy === server.name;
  const badge = switching ? '切换中' : MCP_STATUS[server.status];
  const canToggle = !!onToggle && server.status !== 'unknown' && busy === null;
  const hasTools = server.tools.length > 0;
  const tip = useRowTip<HTMLDivElement>(() => (
    <>
      <div className='cz-ctx__tip-name'>
        {server.name}
        <span className='cz-ctx__tip-full'>MCP 服务器</span>
      </div>
      <div className='cz-ctx__tip-purpose'>
        {hasTools ? `提供 ${server.tools.length} 个工具，定义合计占 ${formatTokens(server.tokens)} token。` : '目前没有报告任何工具。'}
      </div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>状态</span>
        <span className='cz-ctx__tip-why'>{MCP_STATUS_HINT[server.status] ?? `CLI 报告的状态：${server.status}`}</span>
      </div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>开关</span>
        <span className='cz-ctx__tip-why'>按项目记在 ~/.claude.json，与终端 /mcp 相同。</span>
      </div>
      {hasTools && <div className='cz-ctx__tip-hint'>点击名字展开工具列表</div>}
    </>
  ));
  return (
    <li className="cz-ctx__mcp">
      <div ref={tip.ref} className={`cz-ctx__item${enabled ? '' : ' is-off'}`} {...tip.handlers}>
        <button
          type="button"
          className="cz-ctx__mcp-name"
          onClick={() => {
            tip.hide();
            setOpen((v) => !v);
          }}
          disabled={!hasTools}
          aria-expanded={hasTools ? open : undefined}
        >
          <Chevron open={open && hasTools} size={11} />
          <span className="cz-ctx__mcp-label">{server.name}</span>
          {badge && <span className={`cz-ctx__badge is-${switching ? 'pending' : server.status}`}>{badge}</span>}
        </button>
        <span className="cz-ctx__item-tokens">{hasTools ? formatTokens(server.tokens) : '—'}</span>
        <Switch
          on={enabled}
          label={`${enabled ? '停用' : '启用'} ${server.name}`}
          disabled={!canToggle}
          onChange={() => {
            tip.hide();
            onToggle?.(server.name, !enabled);
          }}
        />
        {tip.node}
      </div>
      <Reveal open={open && hasTools}>
        <ul className="cz-ctx__list cz-ctx__list--plain cz-ctx__mcp-tools">
          {server.tools.map((t) => (
            <McpToolItem key={t.name} server={server.name} tool={t} enabled={enabled} />
          ))}
        </ul>
      </Reveal>
    </li>
  );
}

function McpToolItem({
  server, tool, enabled,
}: {
  server: string;
  tool: ContextMcpServer['tools'][number];
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const tip = useRowTip(() => (
    <>
      <div className='cz-ctx__tip-name'>
        {tool.name}
        <span className='cz-ctx__tip-full'>MCP 服务器「{server}」的工具</span>
      </div>
      <div className='cz-ctx__tip-purpose cz-ctx__tip-clamp'>{tool.description ?? `由「${server}」提供；CLI 没有报告它的描述。`}</div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>占用</span>
        <span className='cz-ctx__tip-tok'>{tool.tokens === null ? 'CLI 没有单独报告' : `${tool.tokens.toLocaleString()} token`}</span>
      </div>
      <div className='cz-ctx__tip-hint'>点击名字展开它在上下文里的定义</div>
    </>
  ));
  return (
    <li ref={tip.ref} className="cz-ctx__item cz-ctx__mcp-tool" {...tip.handlers}>
      <RowName label={tool.name} open={open} controls={detailId} onToggle={() => { tip.hide(); setOpen((v) => !v); }} />
      <span className="cz-ctx__item-tokens">{tool.tokens === null ? '—' : formatTokens(tool.tokens)}</span>
      {tip.node}
      <Reveal open={open} id={detailId}>
        <PromptDetail
          where={`工具定义 · MCP「${server}」`}
          tokens={enabled ? tool.tokens : null}
          tokenNote={enabled ? undefined : '服务器已停用，不在上下文里'}
          text={tool.description}
          empty="CLI 没有报告这个工具的描述原文。"
          note="工具定义 = 名字 + 描述 + 参数 schema；token 数含参数 schema。"
        />
      </Reveal>
    </li>
  );
}

function Collapsible({
  title, count, extra, open, onToggle, toolbar, cols, children,
}: {
  title: string;
  count: number;
  extra?: string;
  open: boolean;
  onToggle: () => void;
  /** 展开后显示在列表上方的操作条 */
  toolbar?: ReactNode;
  /** 各列的表头（调用次数等）；传了就按列对齐 */
  cols?: { total: boolean; tokens: boolean };
  children: ReactNode;
}) {
  return (
    <Fold title={title} count={count} extra={extra} open={open} onToggle={onToggle}>
      {toolbar}
      <ul className={`cz-ctx__list cz-ctx__list--plain${cols ? ' cz-ctx__list--cols' : ''}`}>
        {cols && (
          <li className="cz-ctx__cols" aria-hidden="true">
            <span className="cz-ctx__tool-calls" title="本会话的调用次数">本会话</span>
            {cols.total && <span className="cz-ctx__tool-total" title="所有会话累计的调用次数">累计</span>}
            {cols.tokens && <span className="cz-ctx__item-tokens" title="占用的 token">占用</span>}
          </li>
        )}
        {children}
      </ul>
    </Fold>
  );
}

/**
 * 行的悬浮提示。面板主体是滚动容器，提示用 portal + fixed 定位，
 * 优先显示在面板左侧；键盘聚焦到行内按钮时同样显示。
 * 返回要挂到 <li> 上的 ref / 事件，以及要渲染的提示节点（content 只在显示时调用）。
 */
function useRowTip<T extends HTMLElement = HTMLLIElement>(content: () => ReactNode) {
  const [shown, setShown] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const ref = useRef<T>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setShown(true), 280);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setShown(false);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // 量完再定位：面板左侧放得下就放左侧；放不下（手机抽屉）放在行的下方 / 上方，四边都不出可视区
  useLayoutEffect(() => {
    const el = ref.current;
    const tip = tipRef.current;
    if (!shown || !el || !tip) return;
    const m = 8;
    const vb = viewportBounds();
    const r = el.getBoundingClientRect();
    const panel = (el.closest('.cz-ctx') ?? el).getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const beside = panel.left - m - w >= vb.left + m;
    const left = beside ? panel.left - m - w : Math.max(vb.left + m, Math.min(panel.left + m, vb.right - m - w));
    let top = beside ? r.top : r.bottom + 4;
    if (!beside && top + h > vb.bottom - m) top = r.top - 4 - h;
    top = Math.max(vb.top + m, Math.min(top, vb.bottom - m - h));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });
  // 滚动后行已经不在原处
  useEffect(() => {
    if (!shown) return;
    document.addEventListener('scroll', hide, true);
    return () => document.removeEventListener('scroll', hide, true);
  }, [shown, hide]);

  const node = shown
    ? createPortal(
        <div ref={tipRef} className='cz-ctx__tip' role='tooltip'>
          {content()}
        </div>,
        document.body,
      )
    : null;
  return { ref, node, hide, handlers: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide } };
}

/** Skill 行的悬浮提示：中文用途 + 当前状态 + 推荐 + 调用次数 */
function useSkillTip(skill: ContextSkill, label: string, calls: SkillCalls, total: number | null) {
  const here = calls.model + calls.user + calls.sub;
  const parts = [
    calls.model > 0 && `模型 ${calls.model}`,
    calls.user > 0 && `手动 ${calls.user}`,
    calls.sub > 0 && `子智能体 ${calls.sub}`,
  ].filter(Boolean);
  const info = skillInfo(skill.name);
  const rec = info ? MODE_INFO[info.mode] : null;
  const cur = MODE_INFO[skill.mode];
  const fullMeta = [label !== skill.name && skill.name, skill.source].filter(Boolean).join(' · ');
  return useRowTip(() => (
    <>
      <div className='cz-ctx__tip-name'>
        {label}
        {fullMeta && <span className='cz-ctx__tip-full'>{fullMeta}</span>}
      </div>
      <div className='cz-ctx__tip-purpose'>{info?.purpose ?? '暂无中文说明（未收录的 skill）。'}</div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>当前</span>
        <span className={`cz-ctx__tip-mode is-${skill.mode}`}>
          <Icon name={cur.icon} size={13} />
          {cur.label}
        </span>
        <span className='cz-ctx__tip-tok'>{skill.tokens === null ? '不占上下文' : `占 ${formatTokens(skill.tokens)} token`}</span>
      </div>
      {info && rec && (
        <div className='cz-ctx__tip-row'>
          <span className='cz-ctx__tip-k'>建议</span>
          <span className={`cz-ctx__tip-mode is-${info.mode}`}>
            <Icon name={rec.icon} size={13} />
            {rec.label}
          </span>
          <span className='cz-ctx__tip-why'>{info.reason}</span>
        </div>
      )}
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>调用</span>
        <span className='cz-ctx__tip-why'>
          {here === 0 ? '本会话还没有调用过' : `本会话 ${here} 次（${parts.join('，')}）`}
          {total !== null && <><br />{total === 0 ? '所有会话里都没有调用过' : `所有会话累计 ${total} 次`}</>}
        </span>
      </div>
    </>
  ));
}

/** 工具定义的 token 合计：分类里的「System tools」与延迟加载里的「System tools (deferred)」；没有该项为 null */
function toolTokenSummary(usage: ContextUsage): { resident: number | null; deferred: number | null } {
  const isSys = (n: string) => n.trim().toLowerCase().startsWith('system tools');
  const isDef = (n: string) => n.toLowerCase().includes('deferred');
  const resident = usage.categories.find((c) => isSys(c.name) && !isDef(c.name));
  const deferred = usage.deferred.find((d) => isSys(d.name)) ?? usage.categories.find((c) => isSys(c.name) && isDef(c.name));
  return { resident: resident ? resident.tokens : null, deferred: deferred ? deferred.tokens : null };
}

/** 工具列表上方的统计：定义占用（常驻 / 懒加载）与调用次数（本会话 / 所有会话累计） */
function ToolStats({
  resident, deferred, perTool, estimated, session, all, sessions,
}: {
  resident: number | null;
  deferred: number | null;
  perTool: boolean;
  estimated: boolean;
  session: number;
  /** 所有会话累计；取不到为 null */
  all: number | null;
  sessions: number;
}) {
  return (
    <div className="cz-ctx__tool-stats">
      <dl>
        <div title="每次请求都随提示词发送的内置工具定义（CLI 精确合计）">
          <dt>常驻占用</dt>
          <dd>{resident === null ? '—' : formatTokens(resident)}</dd>
        </div>
        <div title="平时只列名字（几乎不占上下文），模型用 ToolSearch 加载后才放入完整定义（CLI 精确合计）">
          <dt>懒加载</dt>
          <dd>{deferred === null ? '—' : formatTokens(deferred)}</dd>
        </div>
        <div title="本会话（含历史与子智能体）调用内置工具的总次数">
          <dt>本会话调用</dt>
          <dd>{session} 次</dd>
        </div>
        <div title={all === null ? '暂时取不到所有会话的统计' : `所有会话（${sessions} 个，含子智能体）调用内置工具的总次数；已删除的会话不计`}>
          <dt>累计调用</dt>
          <dd>{all === null ? '—' : `${formatCount(all)} 次`}</dd>
        </div>
      </dl>
      {estimated ? (
        <p className="cz-ctx__note">带 ~ 的单工具 token 按定义长度权重从 CLI 合计中分摊估算；Cosyee 自带工具为精确值。</p>
      ) : (
        !perTool && <p className="cz-ctx__note">暂无单工具 token 数据，上方常驻 / 懒加载为 CLI 报告的合计。</p>
      )}
    </div>
  );
}

const TOOL_GROUP_META: Record<ToolLoadClass, { title: string; tip: string }> = {
  resident: {
    title: '常驻',
    tip: '每次请求都随提示词发送完整定义。',
  },
  deferred: {
    title: '懒加载',
    tip: '平时只列名字，模型用 ToolSearch 加载后才放入完整定义；括号里显示本会话已加载的个数。',
  },
  unknown: {
    title: '未确定',
    tip: '本会话尚未观测到这些工具的加载方式，且不在 CLI 静态默认表中。',
  },
};

function ToolGroupSection({
  group, toolLoad, toolTokOf, cosyeeDefs, delegateAux, callCounts, allCounts, sums, showTokens, onToggle,
}: {
  group: ToolGroup;
  toolLoad: Readonly<Record<string, ToolLoadEntry>> | undefined;
  toolTokOf: ReadonlyMap<string, ToolTokenEntry>;
  cosyeeDefs: ReadonlyMap<string, ContextMcpServer['tools'][number]>;
  delegateAux: readonly DelegateAuxItem[];
  callCounts: ReadonlyMap<string, ToolCalls>;
  allCounts: Readonly<Record<string, number>> | undefined;
  sums: { resident: number | null; deferred: number | null };
  showTokens: boolean;
  onToggle?: (name: string, enabled: boolean) => void;
}) {
  const [open, setOpen] = useState(true);
  const bodyId = useId();
  const meta = TOOL_GROUP_META[group.load];
  const auxInGroup = delegateAux.filter((a) => a.load === group.load);

  let tokenSum = 0;
  let hasAnyTok = false;
  let anyEstimated = false;
  let loadedCount = 0;
  for (const r of group.rows) {
    const info = toolLoad?.[r.name];
    const t = toolTokOf.get(r.name);
    if (group.load === 'deferred' && r.enabled && (info?.loaded || t?.loaded)) loadedCount++;
    if (!r.enabled) continue;
    const tok = t?.tokens ?? cosyeeDefs.get(r.name)?.tokens ?? null;
    if (tok !== null) {
      tokenSum += tok;
      hasAnyTok = true;
      if (t?.estimated) anyEstimated = true;
    }
  }
  // 委派辅助工具按自身加载方式并入所在分组的 token 合计（delegate 停用时 a.tokens 为 null，不计入）
  for (const a of auxInGroup) {
    if (a.tokens !== null) {
      tokenSum += a.tokens;
      hasAnyTok = true;
    }
  }

  const countLabel =
    group.load === 'deferred' && loadedCount > 0 ? `${group.rows.length}（已加载 ${loadedCount}）` : String(group.rows.length);
  const tokenLabel = hasAnyTok ? `${anyEstimated ? '~' : ''}${formatTokens(tokenSum)}` : null;

  const tip = useRowTip<HTMLButtonElement>(() => (
    <>
      <div className="cz-ctx__tip-name">{meta.title}</div>
      <div className="cz-ctx__tip-purpose">{meta.tip}</div>
      <div className="cz-ctx__tip-row">
        <span className="cz-ctx__tip-k">工具</span>
        <span className="cz-ctx__tip-why">
          共 {group.rows.length} 个（启用 {group.rows.filter((r) => r.enabled).length} 个
          {group.load === 'deferred' ? `，已加载 ${loadedCount} 个` : ''}）
          {auxInGroup.length > 0 && (
            <>
              <br />
              含委派辅助工具 {auxInGroup.length} 个（在 delegate 行展开里）
            </>
          )}
        </span>
      </div>
      {hasAnyTok && (
        <div className="cz-ctx__tip-row">
          <span className="cz-ctx__tip-k">启用合计</span>
          <span className="cz-ctx__tip-tok">
            {anyEstimated ? `约 ${tokenSum.toLocaleString()} token` : `${tokenSum.toLocaleString()} token`}
          </span>
        </div>
      )}
    </>
  ));

  return (
    <div className={`cz-ctx__tgrp${open ? ' is-open' : ''}`} data-tool-group={group.load}>
      <button
        ref={tip.ref}
        type="button"
        className="cz-ctx__tgrp-head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          tip.hide();
          setOpen((v) => !v);
        }}
        {...tip.handlers}
      >
        <Chevron open={open} size={12} />
        <span className="cz-ctx__tgrp-title">{meta.title}</span>
        <span className="cz-ctx__tgrp-count">{countLabel}</span>
        {tokenLabel && <span className="cz-ctx__tgrp-tok">{tokenLabel}</span>}
      </button>
      {tip.node}
      <Reveal open={open} id={bodyId}>
        <ul className="cz-ctx__list cz-ctx__list--plain cz-ctx__list--cols">
          <li className="cz-ctx__cols" aria-hidden="true">
            <span className="cz-ctx__tool-calls" title="本会话的调用次数">本会话</span>
            {!!allCounts && <span className="cz-ctx__tool-total" title="所有会话累计的调用次数">累计</span>}
            {showTokens && <span className="cz-ctx__item-tokens" title="占用的 token">占用</span>}
          </li>
          {group.rows.map((t) => (
            <ToolItem
              key={t.name}
              tool={t}
              calls={callsOf(callCounts, t.name)}
              total={allCounts ? totalCallsOf(allCounts, t.name) : null}
              tokens={toolTokOf.get(t.name)}
              loadEntry={toolLoad?.[t.name]}
              showTokenCol={showTokens}
              def={cosyeeDefs.get(t.name)}
              auxTools={t.name === DELEGATE_TOOL ? delegateAux : undefined}
              sums={sums}
              onToggle={onToggle}
            />
          ))}
        </ul>
      </Reveal>
    </div>
  );
}

/** 调用次数：一万以下写全数，以上用 k / m 缩写 */
function formatCount(n: number): string {
  return n < 10_000 ? String(n) : formatTokens(n);
}

const AUX_LOAD_LABEL: Record<ToolLoadClass, string> = {
  resident: '常驻',
  deferred: '懒加载',
  unknown: '未确定',
};

/** delegate 行展开后的只读配套辅助工具子列表 + 整套合计 */
function DelegateAuxList({
  aux, delegateEnabled, delegateTokens,
}: {
  aux: readonly DelegateAuxItem[];
  delegateEnabled: boolean;
  delegateTokens: number | null;
}) {
  if (aux.length === 0) return null;
  let resSum = delegateEnabled && delegateTokens !== null ? delegateTokens : 0;
  let defSum = 0;
  let hasTok = delegateEnabled && delegateTokens !== null;
  for (const a of aux) {
    if (!delegateEnabled || a.tokens === null) continue;
    hasTok = true;
    if (a.load === 'deferred') defSum += a.tokens;
    else resSum += a.tokens;
  }
  const setTotal = resSum + defSum;
  const totalParts = [resSum > 0 && `常驻 ${resSum.toLocaleString()}`, defSum > 0 && `懒加载 ${defSum.toLocaleString()}`].filter(Boolean);

  return (
    <div className={`cz-ctx__aux${delegateEnabled ? '' : ' is-off'}`}>
      <div className="cz-ctx__aux-head">
        <span className="cz-ctx__aux-title">配套辅助工具（{aux.length} 个）</span>
        {!delegateEnabled && <span className="cz-ctx__aux-status">随 delegate 停用</span>}
      </div>
      <div className="cz-ctx__aux-total">
        {delegateEnabled
          ? hasTok
            ? `整套 ${1 + aux.length} 个工具共 ${setTotal.toLocaleString()} token${totalParts.length > 1 ? `（${totalParts.join(' · ')}）` : ''}`
            : `整套 ${1 + aux.length} 个工具，随 delegate 一并启停`
          : `整套 ${1 + aux.length} 个工具已随 delegate 停用，不在上下文里`}
      </div>
      <ul className="cz-ctx__aux-list">
        {aux.map((a) => {
          const label = toolLabel(a.name);
          const purpose = toolInfo(a.name)?.purpose ?? genericToolPurpose(a.name);
          return (
            <li key={a.name} className="cz-ctx__aux-item">
              <div className="cz-ctx__aux-top">
                <span className="cz-ctx__aux-name" title={label}>{label}</span>
                <span className={`cz-ctx__aux-tag is-${a.load}`}>{AUX_LOAD_LABEL[a.load]}</span>
                {a.loaded && <span className="cz-ctx__tool-tag">已加载</span>}
                <span className="cz-ctx__aux-tok" aria-label={delegateEnabled ? undefined : '随 delegate 停用'}>
                  {delegateEnabled ? (a.tokens === null ? '—' : formatTokens(a.tokens)) : '—'}
                </span>
              </div>
              <div className="cz-ctx__aux-purpose" title={purpose}>{purpose}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ToolItem({
  tool, calls, total, tokens, loadEntry, showTokenCol = false, def, auxTools, sums, onToggle,
}: {
  tool: ToolRow;
  /** 本会话的调用次数 */
  calls: ToolCalls;
  /** 所有会话累计；取不到为 null */
  total: number | null;
  tokens?: ToolTokenEntry;
  loadEntry?: ToolLoadEntry;
  showTokenCol?: boolean;
  /** Cosyee 自带工具：cosyee MCP 服务器报告的定义原文与 token */
  def?: { tokens: number | null; description?: string };
  /** 仅 mcp__cosyee__delegate：随它一起启停的配套辅助工具 */
  auxTools?: readonly DelegateAuxItem[];
  /** 内置工具定义的合计（常驻 / 懒加载） */
  sums: { resident: number | null; deferred: number | null };
  onToggle?: (name: string, enabled: boolean) => void;
}) {
  const here = calls.main + calls.sub;
  const info = toolInfo(tool.name);
  const label = toolLabel(tool.name);
  const own = isCosyeeTool(tool.name);
  const hasAux = tool.name === DELEGATE_TOOL && !!auxTools && auxTools.length > 0;
  const tok = tool.enabled ? (tokens?.tokens ?? def?.tokens ?? null) : null;
  const isDeferred = loadEntry ? loadEntry.load === 'deferred' : !!tokens?.deferred;
  const isLoaded = tool.enabled && isDeferred && (loadEntry?.loaded === true || tokens?.loaded === true);
  const isEstimated = tokens?.estimated === true;
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const tipTokText =
    tok === null
      ? null
      : isDeferred
        ? isEstimated
          ? `懒加载，定义约 ${tok.toLocaleString()} token（未加载时只占名字）`
          : `懒加载，定义 ${formatTokens(tok)} token（未加载时只占名字）`
        : isEstimated
          ? `约 ${tok.toLocaleString()} token（按定义长度从 CLI 合计中分摊的估算）`
          : `占 ${formatTokens(tok)} token`;
  const tip = useRowTip(() => (
    <>
      <div className='cz-ctx__tip-name'>{label}</div>
      <div className='cz-ctx__tip-purpose'>{info?.purpose ?? genericToolPurpose(tool.name)}</div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>当前</span>
        <span className={`cz-ctx__tip-mode is-${tool.enabled ? 'on' : 'off'}`}>{tool.enabled ? '启用' : '已停用'}</span>
        {isLoaded && <span className='cz-ctx__tool-tag'>已加载</span>}
        {tipTokText && <span className='cz-ctx__tip-tok'>{tipTokText}</span>}
      </div>
      {hasAux && (
        <div className='cz-ctx__tip-row'>
          <span className='cz-ctx__tip-k'>整套</span>
          <span className='cz-ctx__tip-why'>
            此开关代表整套 {1 + auxTools!.length} 个委派工具（含 {auxTools!.map((a) => toolLabel(a.name)).join(' / ')}），同开同关。
          </span>
        </div>
      )}
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>调用</span>
        <span className='cz-ctx__tip-why'>
          {here === 0 ? '本会话还没有调用过' : `本会话 ${here} 次${calls.sub > 0 ? `（其中子智能体 ${calls.sub} 次）` : ''}`}
          {total !== null && <><br />{total === 0 ? '所有会话里都没有调用过' : `所有会话累计 ${total} 次`}</>}
        </span>
      </div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>停用</span>
        <span className='cz-ctx__tip-why'>
          {info?.core ? '核心工具，停用后模型多数任务都做不了，不建议停用。' : (info?.note ?? '停用后当前会话立即拦截调用，新会话里模型看不到它。')}
        </span>
      </div>
      <div className='cz-ctx__tip-hint'>{hasAux ? '点击名字展开定义与配套辅助工具' : '点击名字展开它在上下文里的定义'}</div>
    </>
  ));
  return (
    <li ref={tip.ref} className={`cz-ctx__item cz-ctx__tool${tool.enabled ? '' : ' is-off'}`} {...tip.handlers}>
      <RowName
        label={label}
        badge={isLoaded ? <span className="cz-ctx__tool-tag">已加载</span> : undefined}
        open={open}
        controls={detailId}
        onToggle={() => { tip.hide(); setOpen((v) => !v); }}
      />
      <span className={`cz-ctx__tool-calls${here === 0 ? ' is-zero' : ''}`} aria-label={`本会话调用 ${here} 次`}>
        {here > 0 ? `×${here}` : '—'}
      </span>
      {total !== null && (
        <span className={`cz-ctx__tool-total${total === 0 ? ' is-zero' : ''}`} aria-label={`累计调用 ${total} 次`}>
          {total > 0 ? formatCount(total) : '—'}
        </span>
      )}
      {showTokenCol && (
        <span className={`cz-ctx__item-tokens${tok === null ? ' is-empty' : ''}`}>
          {tok === null ? '—' : `${isEstimated ? '~' : ''}${formatTokens(tok)}`}
        </span>
      )}
      <Switch
        on={tool.enabled}
        label={`${tool.enabled ? '停用' : '启用'}工具 ${label}`}
        disabled={!onToggle}
        onChange={() => {
          tip.hide();
          onToggle?.(tool.name, !tool.enabled);
        }}
      />
      {tip.node}
      <Reveal open={open} id={detailId}>
        {own ? (
          <div className="cz-ctx__detail-stack">
            {hasAux && <DelegateAuxList aux={auxTools!} delegateEnabled={tool.enabled} delegateTokens={tok} />}
            <PromptDetail
              where="工具定义 · Cosyee 注册"
              tokens={tool.enabled ? tok : null}
              tokenNote={tool.enabled ? undefined : '已停用，不在上下文里'}
              text={def?.description}
              empty="这次没有读到 Cosyee 工具的定义，刷新上下文后再试。"
              note="工具定义 = 名字 + 描述 + 参数 schema，每次请求随工具列表发给模型。"
            />
          </div>
        ) : (
          <PromptDetail
            where="工具定义 · Claude Code 内置"
            tokens={tok !== null && !isEstimated ? tok : null}
            tokenNote={
              !tool.enabled
                ? '已停用，不在上下文里'
                : tok !== null && isEstimated
                  ? `约 ${tok.toLocaleString()} token（估算）`
                  : `内置工具合计 常驻 ${sums.resident === null ? '—' : formatTokens(sums.resident)} · 懒加载 ${sums.deferred === null ? '—' : formatTokens(sums.deferred)}`
            }
            empty={`CLI 只报告全部内置工具定义的合计 token，不提供单个工具的定义原文。${info ? `\n用途：${info.purpose}` : ''}`}
            note={
              isDeferred
                ? '懒加载：平时只列名字，模型用 ToolSearch 加载后才放入完整定义。'
                : '工具定义 = 名字 + 描述 + 参数 schema，每次请求随工具列表发给模型。'
            }
          />
        )}
      </Reveal>
    </li>
  );
}

/** 没收录的工具：按名字给一句能用的说明 */
function genericToolPurpose(name: string): string {
  if (isCosyeeTool(name)) return `Cosyee 自带的工具 ${toolLabel(name)}。`;
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return `MCP 服务器「${m[1]}」提供的工具 ${m[2]}。`;
  return `Claude Code 内置工具 ${name}（Cosyee 尚未收录中文说明）。停用后模型不能再调用它。`;
}

/** 可展开行的名字：箭头 + 名字（单行省略），点击展开 / 收起下方详情 */
function RowName({
  label, badge, open, controls, onToggle, className = '',
}: {
  label: string;
  badge?: ReactNode;
  open: boolean;
  controls: string;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`cz-ctx__item-name cz-ctx__row-name ${className}`}
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
    >
      <Chevron open={open} size={11} />
      <span className="cz-ctx__row-label">{label}</span>
      {badge}
    </button>
  );
}

/** 展开后的详情：放进系统提示词 / 工具定义里的原文 + 占用的 token */
function PromptDetail({
  where, tokens, tokenNote, text, empty, note,
}: {
  /** 这段内容在上下文里的位置 */
  where: string;
  tokens: number | null;
  /** 没有 token 数时显示在右上角的说明 */
  tokenNote?: string;
  text?: string;
  /** 没有原文时的说明 */
  empty: string;
  note?: string;
}) {
  return (
    <div className="cz-ctx__prompt">
      <div className="cz-ctx__prompt-head">
        <span className="cz-ctx__prompt-where">{where}</span>
        {tokens !== null ? (
          <span className="cz-ctx__prompt-tok">{tokens.toLocaleString()} token</span>
        ) : (
          tokenNote && <span className="cz-ctx__prompt-tok is-muted">{tokenNote}</span>
        )}
      </div>
      {text ? (
        <pre className="cz-ctx__prompt-text" tabIndex={0}>{text}</pre>
      ) : (
        <p className="cz-ctx__prompt-empty">{empty}</p>
      )}
      {note && <p className="cz-ctx__prompt-note">{note}</p>}
    </div>
  );
}

/** 上下文分类（CLI 英文原名）的中文说明 */
function categoryInfo(name: string): string {
  const k = name.trim().toLowerCase();
  const deferred = k.includes('deferred');
  if (k.includes('free')) return '剩余可用空间。';
  if (k.includes('autocompact') || k.includes('buffer')) return '为自动压缩预留的空间：上下文涨到这里之前就会压缩会话，这部分不能用来放内容。';
  if (k.includes('mcp') && k.includes('instruction')) return 'MCP 服务器附带的使用说明，随系统提示词发送。';
  if (k.includes('mcp')) {
    return deferred
      ? '延迟加载的 MCP 工具：平时只列名字（几乎不占上下文），模型用 ToolSearch 加载后才放入完整定义。这里是全部加载时的大小。'
      : 'MCP 服务器提供的工具定义（名字、描述、参数 schema），每次请求都随工具列表发送。';
  }
  if (k.includes('system tools')) {
    return deferred
      ? '延迟加载的内置工具：平时只列名字，模型用 ToolSearch 加载后才放入完整定义。这里是全部加载时的大小。'
      : 'Claude Code 内置工具的定义（名字、描述、参数 schema），每次请求都随工具列表发送。';
  }
  if (k.includes('system prompt')) return 'Claude Code 的基础系统提示词：行为规范、环境信息（目录、平台、git 状态等）。';
  if (k.includes('memory')) return '记忆文件：CLAUDE.md 与自动记忆（MEMORY.md）等，随系统提示词加载。';
  if (k.includes('skill')) return '已开启的 skill 清单：每个 skill 一行「名字: 描述」，模型据此决定何时调用。';
  if (k.includes('agent')) return '自定义智能体清单：每个一行「名字: 描述」，列在 Agent 工具里供模型派发。';
  if (k.includes('slash') || k.includes('command')) return '模型可以调用的斜杠命令清单。';
  if (k.includes('message')) return '对话内容：你的消息、模型回复、工具调用与结果、附件等。会话越长占用越多，压缩会话可以减少。';
  return `CLI 报告的上下文分类「${name}」。`;
}

function CategoryRow({
  cat, denom, hot, onHot,
}: {
  cat: ContextUsage['categories'][number];
  denom: number;
  hot: boolean;
  onHot: (name: string | null) => void;
}) {
  const pct = cat.percent ?? (cat.tokens / denom) * 100;
  const tip = useRowTip(() => (
    <>
      <div className='cz-ctx__tip-name'>{cat.name}</div>
      <div className='cz-ctx__tip-purpose'>{categoryInfo(cat.name)}</div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>占用</span>
        <span className='cz-ctx__tip-tok'>{cat.tokens.toLocaleString()} token · {formatPercent(pct)}</span>
      </div>
    </>
  ));
  return (
    <li
      ref={tip.ref}
      className={`cz-ctx__item${isFree(cat.name) ? ' is-free' : ''}${hot ? ' is-hot' : ''}`}
      onMouseEnter={() => {
        onHot(cat.name);
        tip.handlers.onMouseEnter();
      }}
      onMouseLeave={() => {
        onHot(null);
        tip.handlers.onMouseLeave();
      }}
      onFocus={() => {
        onHot(cat.name);
        tip.handlers.onFocus();
      }}
      onBlur={() => {
        onHot(null);
        tip.handlers.onBlur();
      }}
      tabIndex={0}
    >
      <span className="cz-ctx__swatch" style={{ background: categoryColor(cat.name) }} />
      <span className="cz-ctx__item-name">{cat.name}</span>
      <span className="cz-ctx__item-tokens">{formatTokens(cat.tokens)}</span>
      <span className="cz-ctx__item-pct">{formatPercent(pct)}</span>
      {tip.node}
    </li>
  );
}

function DeferredRow({ name, tokens }: { name: string; tokens: number }) {
  const tip = useRowTip(() => (
    <>
      <div className='cz-ctx__tip-name'>{name}</div>
      <div className='cz-ctx__tip-purpose'>{categoryInfo(name)}</div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>全部加载</span>
        <span className='cz-ctx__tip-tok'>{tokens.toLocaleString()} token（不计入上面的已用）</span>
      </div>
    </>
  ));
  return (
    <li ref={tip.ref} className="cz-ctx__item cz-ctx__deferred" tabIndex={0} {...tip.handlers}>
      <span className="cz-ctx__item-name">{name}</span>
      <span className="cz-ctx__item-tokens">{formatTokens(tokens)}</span>
      {tip.node}
    </li>
  );
}
