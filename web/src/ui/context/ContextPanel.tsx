// 右侧上下文面板：已用占比 / 分段条 / 分类明细 / deferred / Skills（三态）/ MCP（按服务器开关）/ 智能体 / 压缩。
// 约定：ContextUsage.percent 与 categories[].percent 均按 0–100 解释（22.6 表示 22.6%）。
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { CachePoint, ContextMcpServer, ContextSkill, ContextUsage, SkillMode } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { Menu, type MenuEntry } from '../menus/Menu';
import { CacheChart } from './CacheChart';
import { toolInfo } from './toolCatalog';
import { toolRows, type ToolRow } from './tools';
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
  /** 缓存命中率走势（SessionMeta.cache）；不传或为空则显示空态 */
  cache?: CachePoint[];
  /** 「压缩会话」不可用（例如还没发过消息的新会话、回合进行中） */
  compactDisabled?: boolean;
  /** 收起面板；不传则不显示收起按钮 */
  onCollapse?: () => void;
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
  usage, loading, onRefresh, onCompact, onSkillMode, onSkillModes, onSkillRemove, onMcpToggle, mcpBusy = null, tools, onToolToggle, cache, compactDisabled = false, onCollapse,
}: ContextPanelProps) {
  const [skillsOpen, setSkillsOpen] = useState(false);
  // 一键推荐配置之前的状态，用于撤销；手动改任何一个 skill 后失效
  const [undo, setUndo] = useState<Record<string, SkillMode> | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
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
  // 本会话收到过 init 就用它；没收到（探测进程不发消息 / 页面重开错过了 init）用服务端记下的
  const toolList = toolRows(tools?.length ? tools : usage.tools, usage.disabledTools);

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

        {/* 缓存命中率走势 */}
        <section className="cz-ctx__section">
          <h3 className="cz-ctx__sub">缓存命中率</h3>
          <CacheChart points={cache} />
        </section>

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
          extra={toolList.some((t) => !t.enabled) ? `${toolList.filter((t) => !t.enabled).length} 已停用` : undefined}
          open={toolsOpen}
          onToggle={() => setToolsOpen((v) => !v)}
          toolbar={<p className="cz-ctx__note">停用后当前会话立即拦截调用；新会话里模型将看不到该工具。设置对所有会话生效。</p>}
        >
          {toolList.map((t) => (
            <ToolItem key={t.name} tool={t} onToggle={onToolToggle} />
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
  skill, onMode, onRemove,
}: {
  skill: ContextSkill;
  onMode?: (name: string, mode: SkillMode) => void;
  onRemove?: (name: string) => void;
}) {
  const label = skillLabel(skill.name);
  const info = skillInfo(skill.name);
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const cur = MODE_INFO[skill.mode];
  const tip = useSkillTip(skill);

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

/** Skill 行的悬浮提示：中文用途 + 当前状态 + 推荐 */
function useSkillTip(skill: ContextSkill) {
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
    </>
  ));
}

function ToolItem({ tool, onToggle }: { tool: ToolRow; onToggle?: (name: string, enabled: boolean) => void }) {
  const info = toolInfo(tool.name);
  const tip = useRowTip(() => (
    <>
      <div className='cz-ctx__tip-name'>{tool.name}</div>
      <div className='cz-ctx__tip-purpose'>{info?.purpose ?? '暂无中文说明（未收录的工具）。'}</div>
      <div className='cz-ctx__tip-row'>
        <span className='cz-ctx__tip-k'>当前</span>
        <span className={`cz-ctx__tip-mode is-${tool.enabled ? 'on' : 'off'}`}>{tool.enabled ? '启用' : '已停用'}</span>
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
