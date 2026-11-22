// 右侧上下文面板：已用占比 / 分段条 / 分类明细 / deferred / Skills（三态）/ MCP（按服务器开关）/ 智能体 / 压缩。
// 约定：ContextUsage.percent 与 categories[].percent 均按 0–100 解释（22.6 表示 22.6%）。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  BUILTIN_PRICES,
  type CachePoint, type CliModelCost, type CompactMark, type ContextMcpServer, type ContextSkill, type ContextUsage, type PriceTable,
  type SkillMode, type SubagentCost, type ToolStats as ToolStatsData, type Turn,
} from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { Menu, type MenuEntry } from '../menus/Menu';
import { CountUp } from '../motion/CountUp';
import { useWake } from '../motion/useWake';
import { useHeld } from '../motion/useHeld';
import { CacheChart } from './CacheChart';
import { ContextChart } from './ContextChart';
import { CostSection, type Billing } from './CostSection';
import { toolInfo } from './toolCatalog';
import {
  agentRows, callsOf, skillCallCounts, skillCallsOf, toolCallCounts, toolRows, totalCallsOf, totalSkillCallsOf,
  type AgentRow, type SkillCalls, type ToolCalls, type ToolRow,
} from './tools';
import { formatPercent, formatTokens } from './formatTokens';
import { presetChanges, skillBaseName, skillInfo } from './skillCatalog';
import './ContextPanel.css';

export interface ContextPanelProps {
  usage: ContextUsage | null;
  loading: boolean;
  onRefresh: () => void;
  onCompact: () => void;
  /** 设置 skill 状态；不传则只读 */
  onSkillMode?: (name: string, mode: SkillMode) => void;
  /** 批量设置 skill 状态（一键推荐配置 / 撤销）；不传则这两个按钮不可用 */
  onSkillModes?: (modes: Record<string, SkillMode>) => void;
  /** 移除用户级 / 项目级 skill（目录移到备份，不直接删除） */
  onSkillRemove?: (name: string) => void;
  /** 开关 MCP 服务器；不传则只读 */
  onMcpToggle?: (server: string, enabled: boolean) => void;
  /** 正在切换的 MCP 服务器名（切换期间所有 MCP 开关禁用） */
  mcpBusy?: string | null;
  /** 本会话 init 报告的工具名（SessionMeta.tools）；为空时退回 usage.tools。MCP 工具（mcp__ 开头）不在这里列出 */
  tools?: string[];
  /** 启用 / 停用内置工具；不传则只读 */
  onToolToggle?: (name: string, enabled: boolean) => void;
  /** 本会话 init 报告的智能体名（SessionMeta.agents，含内置）；没有时只列 usage.agents 里的自定义智能体 */
  agents?: string[];
  /** 开启 / 关闭智能体；不传则只读 */
  onAgentToggle?: (name: string, enabled: boolean) => void;
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
  usage: liveUsage, loading, onRefresh, onCompact, onSkillMode, onSkillModes, onSkillRemove, onMcpToggle, mcpBusy = null, tools: liveTools, onToolToggle, agents: liveAgents, onAgentToggle, cache: liveCache, turns: liveTurns, toolStats = null, compactDisabled = false, onCompactWindow, onCollapse,
  compactions: liveCompactions, pricing = BUILTIN_PRICES, subCosts: liveSubCosts = null, cliCost: liveCliCost, model: liveModel, billing = 'api', onJumpTurn,
}: ContextPanelProps) {
  // 切换会话时新会话的上下文要晚到一点：这期间留着上一份（变淡），不闪成空态，也不从 0 重新滚一遍
  const live = useMemo(
    () =>
      liveUsage
        ? {
            usage: liveUsage, cache: liveCache, turns: liveTurns, tools: liveTools, agents: liveAgents,
            compactions: liveCompactions, subCosts: liveSubCosts, cliCost: liveCliCost, model: liveModel,
          }
        : null,
    [liveUsage, liveCache, liveTurns, liveTools, liveAgents, liveCompactions, liveSubCosts, liveCliCost, liveModel],
  );
  const held = useHeld(live);
  const usage = held.value?.usage ?? null;
  const { cache, turns, tools, agents, compactions, subCosts, cliCost, model } = held.value ?? {};
  const stale = held.stale;
  const [skillsOpen, setSkillsOpen] = useState(false);
  // 一键推荐配置之前的状态，用于撤销；手动改任何一个 skill 后失效
  const [undo, setUndo] = useState<Record<string, SkillMode> | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);
  // 数据第一次到达时：数字滚动、条形擦出、走势描出、各块依次出现
  const waking = useWake(!!usage);
  // 每个工具在本会话里的调用次数（会话流每次更新都会变，按 turns 记忆）
  const callCounts = useMemo(() => toolCallCounts(turns), [turns]);
  const skillCounts = useMemo(() => skillCallCounts(turns), [turns]);

  const refreshBtn = (
    <button type="button" className="cz-ctx__link" onClick={onRefresh} disabled={loading}>
      {loading ? '刷新中…' : '刷新'}
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

  const { totalTokens } = usage;
  const catSum = usage.categories.reduce((s, c) => s + Math.max(0, c.tokens), 0);
  // 分母：通常是总量；若分类合计超过总量（数据不一致）就按合计，避免条溢出
  const denom = Math.max(totalTokens, catSum, 1);
  const pctOf = (tokens: number, given: number | null) => given ?? (tokens / denom) * 100;
  const segments = usage.categories.filter((c) => c.tokens > 0);
  const skills = usage.skills ?? [];
  const servers = usage.mcpServers ?? [];
  // 本会话收到过 init 就用它；没收到（探测进程不发消息 / 页面重开错过了 init）用服务端记下的
  const toolList = toolRows(tools?.length ? tools : usage.tools, usage.disabledTools);
  const toolTok = toolTokenSummary(usage);
  const toolTokOf = new Map((usage.toolTokens ?? []).map((t) => [t.name, t]));
  const sessionCalls = toolList.reduce((n, t) => {
    const c = callsOf(callCounts, t.name);
    return n + c.main + c.sub;
  }, 0);
  const allCounts = toolStats?.counts;
  const allCalls = allCounts ? toolList.reduce((n, t) => n + totalCallsOf(allCounts, t.name), 0) : null;
  const offCount = toolList.filter((t) => !t.enabled).length;
  const agentList = agentRows(agents, usage.agents, usage.disabledAgents);
  const agentOff = agentList.filter((a) => !a.enabled).length;

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

        {/* 分段条 */}
        <div className="cz-ctx__bar" role="img" aria-label={`已用 ${formatPercent(usage.percent)}`}>
          {segments.map((c) => (
            <span
              key={c.name}
              className="cz-ctx__seg"
              style={{ width: `${(c.tokens / denom) * 100}%`, background: categoryColor(c.name) }}
              title={`${c.name}：${formatTokens(c.tokens)}`}
            />
          ))}
        </div>

        {/* 分类明细 */}
        <ul className="cz-ctx__list">
          {usage.categories.map((c) => (
            <li key={c.name} className={`cz-ctx__item${isFree(c.name) ? ' is-free' : ''}`}>
              <span className="cz-ctx__swatch" style={{ background: categoryColor(c.name) }} />
              <span className="cz-ctx__item-name" title={c.name}>
                {c.name}
              </span>
              <span className="cz-ctx__item-tokens">{formatTokens(c.tokens)}</span>
              <span className="cz-ctx__item-pct">{formatPercent(pctOf(c.tokens, c.percent))}</span>
            </li>
          ))}
        </ul>

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
                <li key={d.name} className="cz-ctx__item">
                  <span className="cz-ctx__item-name" title={d.name}>
                    {d.name}
                  </span>
                  <span className="cz-ctx__item-tokens">{formatTokens(d.tokens)}</span>
                </li>
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
          open={skillsOpen}
          onToggle={() => setSkillsOpen((v) => !v)}
          toolbar={
            <SkillToolbar
              skills={skills}
              undo={undo}
              enabled={!!onSkillModes}
              onApply={(changes) => {
                // 记下被改动的 skill 的原状态，供撤销
                setUndo(Object.fromEntries(skills.filter((s) => s.name in changes).map((s) => [s.name, s.mode])));
                onSkillModes?.(changes);
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
              calls={skillCallsOf(skillCounts, s.name)}
              total={totalSkillCallsOf(toolStats?.skills, s.name)}
              onRemove={
                onSkillRemove &&
                ((name) => {
                  setUndo(null);
                  onSkillRemove(name);
                })
              }
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

        {/* 可展开：内置工具（按工具开关；停用名单全局保存） */}
        <Collapsible
          title="工具"
          count={toolList.length}
          extra={[toolTok.resident !== null && formatTokens(toolTok.resident), offCount > 0 && `${offCount} 已停用`].filter(Boolean).join(' · ') || undefined}
          open={toolsOpen}
          onToggle={() => setToolsOpen((v) => !v)}
          toolbar={
            <>
              <ToolStats
                resident={toolTok.resident}
                deferred={toolTok.deferred}
                perTool={toolTokOf.size > 0}
                session={sessionCalls}
                all={allCalls}
                sessions={toolStats?.sessions ?? 0}
              />
              <p className="cz-ctx__note">停用后当前会话立即拦截调用；新会话里模型将看不到该工具。设置对所有会话生效。</p>
            </>
          }
        >
          {toolList.map((t) => (
            <ToolItem
              key={t.name}
              tool={t}
              calls={callsOf(callCounts, t.name)}
              total={allCounts ? totalCallsOf(allCounts, t.name) : null}
              tokens={toolTokOf.get(t.name)}
              onToggle={onToolToggle}
            />
          ))}
        </Collapsible>

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

        {/* 可展开：智能体（含内置；按智能体开关，名单全局保存） */}
        <Collapsible
          title="智能体"
          count={agentList.length}
          extra={agentOff > 0 ? `${agentOff} 已关闭` : undefined}
          open={agentsOpen}
          onToggle={() => setAgentsOpen((v) => !v)}
          toolbar={<p className="cz-ctx__note">关闭后模型不能再派发该智能体（当前会话立即拦截，新会话里看不到它）。设置对所有会话生效。</p>}
        >
          {agentList.map((a) => (
            <AgentItem key={a.name} agent={a} onToggle={onAgentToggle} />
          ))}
        </Collapsible>
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
          <button type="button" className="cz-ctx__link" onClick={commit}>保存</button>
          <button type="button" className="cz-ctx__link" onClick={() => finish(null)} disabled={value === null} title="不覆盖，沿用 ~/.claude/settings.json 或 CLI 默认">
            默认
          </button>
          <button type="button" className="cz-ctx__link" onClick={() => setEditing(false)}>取消</button>
        </div>
        <p className={`cz-ctx__note${invalid ? ' is-error' : ''}`}>
          {invalid
            ? `需在 ${WINDOW_MIN_K}–${WINDOW_MAX_K}k 之间（留空 = 默认）`
            : '上下文达到「窗口 − 约 33k」时自动压缩。对所有会话生效，运行中的会话立即生效。'}
        </p>
      </div>
    );
  }

  const tip = [
    '自动压缩窗口：上下文达到「窗口 − 约 33k」时自动压缩',
    threshold !== undefined && `当前触发点 ${formatTokens(threshold)}`,
    value === null && '未覆盖，沿用 ~/.claude/settings.json 或 CLI 默认',
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
        窗口 {value ? formatTokens(value) : '默认'}
      </button>
    </div>
  );
}

function skillSummary(skills: readonly ContextSkill[]): string {
  const n = (m: SkillMode) => skills.filter((s) => s.mode === m).length;
  return `${n('on')} 开 · ${n('user-invocable-only')} 手动 · ${n('off')} 关`;
}

/** Skills 列表上方：一键推荐配置 + 撤销 */
function SkillToolbar({
  skills, undo, enabled, onApply, onUndo,
}: {
  skills: readonly ContextSkill[];
  undo: Record<string, SkillMode> | null;
  enabled: boolean;
  onApply: (changes: Record<string, SkillMode>) => void;
  onUndo: () => void;
}) {
  const changes = presetChanges(skills);
  const n = Object.keys(changes).length;
  return (
    <div className="cz-ctx__skill-bar">
      <button
        type="button"
        className="cz-ctx__preset"
        disabled={!enabled || n === 0}
        onClick={() => onApply(changes)}
        title="按推荐状态一次设好所有已收录的 skill（高频的开，偶尔用的手动，用不到的关）；可撤销"
      >
        <Icon name="wand" size={14} />
        <span>一键推荐配置</span>
        <span className="cz-ctx__preset-n">{n === 0 ? '已是推荐' : `${n} 项待调整`}</span>
      </button>
      {undo && (
        <button type="button" className="cz-ctx__undo" onClick={onUndo} disabled={!enabled} title="恢复到一键配置之前的状态">
          <Icon name="undo" size={13} />
          <span>撤销</span>
        </button>
      )}
    </div>
  );
}

function SkillRow({
  skill, calls, total, onMode, onRemove,
}: {
  skill: ContextSkill;
  /** 本会话的加载次数 */
  calls: SkillCalls;
  /** 所有会话累计；取不到为 null */
  total: number | null;
  onMode?: (name: string, mode: SkillMode) => void;
  onRemove?: (name: string) => void;
}) {
  const label = skillLabel(skill.name);
  const info = skillInfo(skill.name);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const cur = MODE_INFO[skill.mode];
  const here = calls.model + calls.user + calls.sub;
  const tip = useSkillTip(skill, calls, total);

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
    <li ref={tip.ref} className={`cz-ctx__item cz-ctx__skill${skill.mode === 'on' ? '' : ' is-off'}`} {...tip.handlers}>
      <span className="cz-ctx__item-name cz-ctx__skill-name">{label}</span>
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
  return (
    <li className="cz-ctx__mcp">
      <div className={`cz-ctx__item${enabled ? '' : ' is-off'}`}>
        <button
          type="button"
          className="cz-ctx__mcp-name"
          onClick={() => setOpen((v) => !v)}
          disabled={!hasTools}
          aria-expanded={hasTools ? open : undefined}
          title={server.name}
        >
          <Icon name={open && hasTools ? 'chevron-down' : 'chevron-right'} size={12} />
          <span className="cz-ctx__mcp-label">{server.name}</span>
          {badge && <span className={`cz-ctx__badge is-${switching ? 'pending' : server.status}`}>{badge}</span>}
        </button>
        <span className="cz-ctx__item-tokens">{hasTools ? formatTokens(server.tokens) : '—'}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? '停用' : '启用'} ${server.name}`}
          title={
            server.status === 'unknown'
              ? '读不到 MCP 状态，刷新后再试'
              : enabled
                ? '停用（按项目记在 ~/.claude.json，与终端 /mcp 相同）'
                : '启用'
          }
          className={`cz-ctx__switch${enabled ? ' is-on' : ''}`}
          disabled={!canToggle}
          onClick={() => onToggle?.(server.name, !enabled)}
        >
          <span className="cz-ctx__knob" />
        </button>
      </div>
      {open && hasTools && (
        <ul className="cz-ctx__list cz-ctx__list--plain cz-ctx__mcp-tools">
          {server.tools.map((t) => (
            <li key={t.name} className="cz-ctx__item">
              <span className="cz-ctx__item-name" title={t.name}>
                {t.name}
              </span>
              <span className="cz-ctx__item-tokens">{t.tokens === null ? '—' : formatTokens(t.tokens)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Collapsible({
  title,
  count,
  extra,
  open,
  onToggle,
  toolbar,
  children,
}: {
  title: string;
  count: number;
  /** 标题右侧的补充说明（如「3 开」） */
  extra?: string;
  open: boolean;
  onToggle: () => void;
  /** 展开后显示在列表上方的操作条 */
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="cz-ctx__section">
      <button
        type="button"
        className="cz-ctx__fold"
        onClick={onToggle}
        aria-expanded={open}
        disabled={count === 0}
      >
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
        <span className="cz-ctx__fold-title">{title}</span>
        {extra && count > 0 && <span className="cz-ctx__fold-extra">{extra}</span>}
        <span className="cz-ctx__fold-count">{count}</span>
      </button>
      {open && count > 0 && toolbar}
      {open && count > 0 && <ul className="cz-ctx__list cz-ctx__list--plain">{children}</ul>}
    </section>
  );
}

/**
 * 行的悬浮提示。面板主体是滚动容器，提示用 portal + fixed 定位，
 * 显示在面板左侧（面板贴右边）；键盘聚焦到行内按钮时同样显示。
 * 返回要挂到 <li> 上的 ref / 事件，以及要渲染的提示节点（content 只在显示时调用）。
 */
function useRowTip(content: () => ReactNode) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const ref = useRef<HTMLLIElement>(null);

  const show = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const left = (el.closest('.cz-ctx') ?? el).getBoundingClientRect().left;
      setPos({ top: r.top, right: Math.max(8, window.innerWidth - left + 8) });
    }, 280);
  }, []);
  const hide = useCallback(() => {
    window.clearTimeout(timer.current);
    setPos(null);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const node = pos
    ? createPortal(
        <div className='cz-ctx__tip' role='tooltip' style={{ top: pos.top, right: pos.right }}>
          {content()}
        </div>,
        document.body,
      )
    : null;
  return { ref, node, hide, handlers: { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide } };
}

/** Skill 行的悬浮提示：中文用途 + 当前状态 + 推荐 + 调用次数 */
function useSkillTip(skill: ContextSkill, calls: SkillCalls, total: number | null) {
  const here = calls.model + calls.user + calls.sub;
  const parts = [
    calls.model > 0 && `模型 ${calls.model}`,
    calls.user > 0 && `手动 ${calls.user}`,
    calls.sub > 0 && `子智能体 ${calls.sub}`,
  ].filter(Boolean);
  const info = skillInfo(skill.name);
  const rec = info ? MODE_INFO[info.mode] : null;
  const cur = MODE_INFO[skill.mode];
  return useRowTip(() => (
    <>
      <div className='cz-ctx__tip-name'>
        {skillLabel(skill.name)}
        <span className='cz-ctx__tip-full'>
          {skill.name}
          {skill.source ? ` · ${skill.source}` : ''}
        </span>
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

/** 工具列表上方的统计：定义占用（常驻 / 延迟加载）与调用次数（本会话 / 所有会话累计） */
function ToolStats({
  resident, deferred, perTool, session, all, sessions,
}: {
  resident: number | null;
  deferred: number | null;
  perTool: boolean;
  session: number;
  /** 所有会话累计；取不到为 null */
  all: number | null;
  sessions: number;
}) {
  return (
    <div className="cz-ctx__tool-stats">
      <dl>
        <div title="每次请求都随提示词发送的内置工具定义">
          <dt>常驻占用</dt>
          <dd>{resident === null ? '—' : formatTokens(resident)}</dd>
        </div>
        <div title="平时只列名字（几乎不占上下文），模型用 ToolSearch 加载后才放入完整定义">
          <dt>延迟加载</dt>
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
      {!perTool && <p className="cz-ctx__note">CLI 只报告工具定义的合计，不提供单个工具的占用。</p>}
    </div>
  );
}

/** 调用次数：一万以下写全数，以上用 k / m 缩写 */
function formatCount(n: number): string {
  return n < 10_000 ? String(n) : formatTokens(n);
}

function ToolItem({
  tool, calls, total, tokens, onToggle,
}: {
  tool: ToolRow;
  /** 本会话的调用次数 */
  calls: ToolCalls;
  /** 所有会话累计；取不到为 null */
  total: number | null;
  tokens?: { tokens: number; deferred?: true };
  onToggle?: (name: string, enabled: boolean) => void;
}) {
  const here = calls.main + calls.sub;
  const info = toolInfo(tool.name);
  const tip = useRowTip(() => (
    <>
      <div className='cz-ctx__tip-name'>{tool.name}</div>
      <div className='cz-ctx__tip-purpose'>{info?.purpose ?? '暂无中文说明（未收录的工具）。'}</div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>当前</span>
        <span className={`cz-ctx__tip-mode is-${tool.enabled ? 'on' : 'off'}`}>{tool.enabled ? '启用' : '已停用'}</span>
        {tokens && (
          <span className='cz-ctx__tip-tok'>
            {tokens.deferred ? `延迟加载，定义 ${formatTokens(tokens.tokens)} token` : `占 ${formatTokens(tokens.tokens)} token`}
          </span>
        )}
      </div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>调用</span>
        <span className='cz-ctx__tip-why'>
          {here === 0 ? '本会话还没有调用过' : `本会话 ${here} 次${calls.sub > 0 ? `（其中子智能体 ${calls.sub} 次）` : ''}`}
          {total !== null && <><br />{total === 0 ? '所有会话里都没有调用过' : `所有会话累计 ${total} 次`}</>}
        </span>
      </div>
      {(info?.core || info?.note) && (
        <div className='cz-ctx__tip-row'>
          <span className='cz-ctx__tip-k'>停用</span>
          <span className='cz-ctx__tip-why'>{info.core ? '核心工具，停用后模型多数任务都做不了，不建议停用。' : info.note}</span>
        </div>
      )}
    </>
  ));
  return (
    <li ref={tip.ref} className={`cz-ctx__item cz-ctx__tool${tool.enabled ? '' : ' is-off'}`} {...tip.handlers}>
      <span className="cz-ctx__item-name">{tool.name}</span>
      <span className={`cz-ctx__tool-calls${here === 0 ? ' is-zero' : ''}`} aria-label={`本会话调用 ${here} 次`}>
        {here > 0 ? `×${here}` : '—'}
      </span>
      {total !== null && (
        <span className={`cz-ctx__tool-total${total === 0 ? ' is-zero' : ''}`} aria-label={`累计调用 ${total} 次`}>
          {total > 0 ? formatCount(total) : '—'}
        </span>
      )}
      {tokens && <span className="cz-ctx__item-tokens">{formatTokens(tokens.tokens)}</span>}
      <button
        type="button"
        role="switch"
        aria-checked={tool.enabled}
        aria-label={`${tool.enabled ? '停用' : '启用'}工具 ${tool.name}`}
        className={`cz-ctx__switch${tool.enabled ? ' is-on' : ''}`}
        disabled={!onToggle}
        onClick={() => {
          tip.hide();
          onToggle?.(tool.name, !tool.enabled);
        }}
      >
        <span className="cz-ctx__knob" />
      </button>
      {tip.node}
    </li>
  );
}

function AgentItem({ agent, onToggle }: { agent: AgentRow; onToggle?: (name: string, enabled: boolean) => void }) {
  return (
    <li className={`cz-ctx__item cz-ctx__tool${agent.enabled ? '' : ' is-off'}`}>
      <span className="cz-ctx__item-name" title={agent.name}>
        {agent.name}
      </span>
      <span className="cz-ctx__item-tokens">{agent.tokens === null ? '—' : formatTokens(agent.tokens)}</span>
      <button
        type="button"
        role="switch"
        aria-checked={agent.enabled}
        aria-label={`${agent.enabled ? '关闭' : '开启'}智能体 ${agent.name}`}
        title={agent.enabled ? '关闭：模型不能再派发这个智能体' : '开启'}
        className={`cz-ctx__switch${agent.enabled ? ' is-on' : ''}`}
        disabled={!onToggle}
        onClick={() => onToggle?.(agent.name, !agent.enabled)}
      >
        <span className="cz-ctx__knob" />
      </button>
    </li>
  );
}
