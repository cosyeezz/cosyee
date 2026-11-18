// 右侧上下文面板：已用占比 / 分段条 / 分类明细 / deferred / Skills（三态）/ MCP（按服务器开关）/ 智能体 / 压缩。
// 约定：ContextUsage.percent 与 categories[].percent 均按 0–100 解释（22.6 表示 22.6%）。
import { useState, type ReactNode } from 'react';
import type { ContextMcpServer, ContextSkill, ContextUsage, SkillMode } from '@cosyee/shared';
import { Icon } from '../icons/Icon';
import { formatPercent, formatTokens } from './formatTokens';
import './ContextPanel.css';

export interface ContextPanelProps {
  usage: ContextUsage | null;
  loading: boolean;
  onRefresh: () => void;
  onCompact: () => void;
  /** 设置 skill 状态；不传则只读 */
  onSkillMode?: (name: string, mode: SkillMode) => void;
  /** 开关 MCP 服务器；不传则只读 */
  onMcpToggle?: (server: string, enabled: boolean) => void;
  /** 正在切换的 MCP 服务器名（切换期间所有 MCP 开关禁用） */
  mcpBusy?: string | null;
  /** 「压缩会话」不可用（例如还没发过消息的新会话、回合进行中） */
  compactDisabled?: boolean;
  /** 收起面板；不传则不显示收起按钮 */
  onCollapse?: () => void;
}

const SKILL_MODES: { mode: SkillMode; label: string; hint: string }[] = [
  { mode: 'on', label: '开', hint: '开：模型能看到，会按需自动调用' },
  { mode: 'user-invocable-only', label: '手动', hint: '手动：模型看不到，只能输入 /名字 手动调用（不占上下文）' },
  { mode: 'off', label: '关', hint: '关：模型和 / 菜单都看不到' },
];

const MCP_STATUS: Record<string, string> = {
  disabled: '已停用',
  pending: '连接中',
  failed: '连接失败',
  'needs-auth': '需登录',
  unknown: '状态未知',
};

/** 插件 skill 去掉前缀显示：anthropic-skills:pdf -> pdf */
const skillLabel = (name: string) => name.slice(name.lastIndexOf(':') + 1);

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
  usage, loading, onRefresh, onCompact, onSkillMode, onMcpToggle, mcpBusy = null, compactDisabled = false, onCollapse,
}: ContextPanelProps) {
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [agentsOpen, setAgentsOpen] = useState(false);

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

  return (
    <div className={`cz-ctx${loading ? ' is-loading' : ''}`}>
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
          <div className="cz-ctx__percent">{formatPercent(usage.percent)}</div>
          <div className="cz-ctx__used">
            {formatTokens(usage.usedTokens)} / {formatTokens(usage.totalTokens)}
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

        {/* 可展开：Skills（开 / 手动 / 关 三态） */}
        <Collapsible
          title="Skills"
          count={skills.length}
          extra={`${skills.filter((s) => s.mode === 'on').length} 开`}
          open={skillsOpen}
          onToggle={() => setSkillsOpen((v) => !v)}
        >
          {skills.map((s) => (
            <SkillRow key={s.name} skill={s} onMode={onSkillMode} />
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

        {/* 可展开：自定义智能体 */}
        <Collapsible
          title="自定义智能体"
          count={usage.agents.length}
          open={agentsOpen}
          onToggle={() => setAgentsOpen((v) => !v)}
        >
          {usage.agents.map((a) => (
            <li key={a.name} className="cz-ctx__item">
              <span className="cz-ctx__item-name" title={a.name}>
                {a.name}
              </span>
              <span className="cz-ctx__item-tokens">{formatTokens(a.tokens)}</span>
            </li>
          ))}
        </Collapsible>
      </div>

      {/* 底部：自动压缩 */}
      <div className="cz-ctx__foot">
        {usage.untilAutocompact !== null && (
          <div className="cz-ctx__autocompact">距自动压缩还剩 {formatTokens(usage.untilAutocompact)}</div>
        )}
        <button type="button" className="cz-ctx__btn cz-ctx__btn--block" onClick={onCompact} disabled={compactDisabled}>
          <Icon name="compact" size={14} />
          <span>压缩会话</span>
        </button>
      </div>
    </div>
  );
}

function SkillRow({ skill, onMode }: { skill: ContextSkill; onMode?: (name: string, mode: SkillMode) => void }) {
  const label = skillLabel(skill.name);
  return (
    <li className={`cz-ctx__item cz-ctx__skill${skill.mode === 'on' ? '' : ' is-off'}`}>
      <span className="cz-ctx__item-name" title={skill.source ? `${skill.name}（${skill.source}）` : skill.name}>
        {label}
      </span>
      <span className="cz-ctx__item-tokens">{skill.tokens === null ? '—' : formatTokens(skill.tokens)}</span>
      <span className="cz-ctx__seg3" role="radiogroup" aria-label={`${label} 的状态`}>
        {SKILL_MODES.map((m) => (
          <button
            key={m.mode}
            type="button"
            role="radio"
            aria-checked={skill.mode === m.mode}
            className={`cz-ctx__seg3-btn${skill.mode === m.mode ? ' is-on' : ''}`}
            title={m.hint}
            disabled={!onMode}
            onClick={() => {
              if (skill.mode !== m.mode) onMode?.(skill.name, m.mode);
            }}
          >
            {m.label}
          </button>
        ))}
      </span>
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
  children,
}: {
  title: string;
  count: number;
  /** 标题右侧的补充说明（如「3 开」） */
  extra?: string;
  open: boolean;
  onToggle: () => void;
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
      {open && count > 0 && <ul className="cz-ctx__list cz-ctx__list--plain">{children}</ul>}
    </section>
  );
}
