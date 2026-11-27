// 统一用量统计看板：主会话右侧悬浮轨（layout="rail"）与子代理浮层底部统计区（layout="dock"）共用。
// 渲染四块卡片：上下文占用、上下文走势、缓存命中率、花费。
import { useMemo, useState, type CSSProperties } from 'react';
import type { AccountEntry, PriceTable, SubagentAccountOption, SubagentConfig, SubagentCost, Turn, UsageTrack } from '@cosyee/shared';
import { CountUp } from '../motion/CountUp';
import { CacheChart } from './CacheChart';
import { ContextChart } from './ContextChart';
import { CostChart } from './CostChart';
import { UsageBar, usageDenom } from './ContextPanel';
import { COST_SOURCES, formatUsd } from './cost';
import { formatPercent, formatTokens } from './formatTokens';
import { requestCostRows, useUsageStats } from './usageStats';
import './ContextPanel.css';
import './UsageBoard.css';

export interface UsageBoardProps {
  track: UsageTrack;
  pricing: PriceTable;
  layout: 'rail' | 'dock';
  turns?: Turn[];
  subCosts?: readonly SubagentCost[] | null;
  subagents?: SubagentConfig | null;
  subagentAccounts?: readonly SubagentAccountOption[];
  accounts?: readonly AccountEntry[];
  model?: string;
  onJumpTurn?: (turn: number) => void;
  onJumpStep?: (index: number) => void;
}

export function UsageBoard({
  track,
  pricing,
  layout,
  turns,
  subCosts,
  subagents,
  subagentAccounts,
  accounts,
  model,
  onJumpTurn,
  onJumpStep,
}: UsageBoardProps) {
  const isDock = layout === 'dock';
  const [hot, setHot] = useState<string | null>(null);
  const stats = useUsageStats(track, {
    pricing,
    fallbackModel: model,
    turns,
    subs: subCosts,
    subagents,
    subagentAccounts,
    accounts,
    mode: isDock ? 'subagent' : 'session',
  });

  const reqCost = useMemo(
    () => (stats.perRequest ? requestCostRows(stats.trend, pricing, model) : null),
    [stats.perRequest, stats.trend, pricing, model],
  );

  const hasPoints = stats.trend.length > 0;
  const showOccupancy = track.breakdown ? true : isDock && hasPoints;
  const costTitle = track.billing === 'subscription' && !stats.cost.mixedBilling ? '花费（等价 API 价格）' : '花费';
  const cardCls = isDock ? 'cz-ub-dock__card' : 'cz-crail__card';
  const listCls = isDock ? 'cz-ub-dock' : 'cz-crail__list';
  const railSources = !isDock && stats.cost.sub > 0 && stats.cost.total > 0
    ? COST_SOURCES.filter((s) => stats.cost.bySource[s.key] > 0)
    : [];

  // 分段条分母：有 breakdown 沿用 usageDenom；无 breakdown 有窗口按 max(window, used)，无窗口按 max(used, 1)
  const occDenom = track.breakdown
    ? usageDenom(track.breakdown)
    : stats.occupancy.window !== null
      ? Math.max(stats.occupancy.window, stats.occupancy.used, 1)
      : Math.max(stats.occupancy.used, 1);

  return (
    <div className={listCls}>
      {showOccupancy && (
        <section className={cardCls} style={{ '--i': 0 } as CSSProperties} aria-label="上下文占用">
          {isDock && <h3 className="cz-ctx__sub">上下文占用</h3>}
          <div className="cz-ctx__overview">
            {stats.occupancy.percent !== null ? (
              <>
                <CountUp
                  className={isDock ? 'cz-ub-dock__percent' : 'cz-crail__percent'}
                  testId={isDock ? 'dock-percent' : undefined}
                  value={stats.occupancy.percent}
                  format={formatPercent}
                  play={false}
                />
                <span className={isDock ? 'cz-ub-dock__used' : 'cz-crail__used'}>
                  {formatTokens(stats.occupancy.used)} / {formatTokens(stats.occupancy.window!)}
                </span>
              </>
            ) : (
              <>
                <CountUp
                  className={isDock ? 'cz-ub-dock__percent' : 'cz-crail__percent'}
                  testId={isDock ? 'dock-used' : undefined}
                  value={stats.occupancy.used}
                  format={formatTokens}
                  play={false}
                />
                <span className={isDock ? 'cz-ub-dock__used' : 'cz-crail__used'}>窗口未知</span>
              </>
            )}
          </div>
          {track.breakdown ? (
            <UsageBar usage={track.breakdown} denom={occDenom} hot={hot} onHot={setHot} />
          ) : (
            <>
              <UsageBar
                segments={stats.occupancy.segments}
                denom={occDenom}
                hot={hot}
                onHot={setHot}
                ariaLabel={
                  stats.occupancy.percent !== null
                    ? `已用 ${formatPercent(stats.occupancy.percent)}`
                    : `已用 ${formatTokens(stats.occupancy.used)}`
                }
              />
              {stats.occupancy.segments.length > 0 && (
                <div className="cz-ub-dock__legend">
                  {stats.occupancy.segments.map((s) => (
                    <span
                      key={s.key}
                      className={`cz-ub-dock__leg${hot === s.key ? ' is-hot' : ''}`}
                      onMouseEnter={() => setHot(s.key)}
                      onMouseLeave={() => setHot(null)}
                    >
                      <span className="cz-ub-dock__dot" style={{ background: s.color }} />
                      <span>{s.label}</span>
                      <span className="cz-ub-dock__leg-val">{formatTokens(s.tokens)}</span>
                    </span>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {hasPoints && (
        <>
          <section className={cardCls} style={{ '--i': 1 } as CSSProperties}>
            <h3 className="cz-ctx__sub">上下文走势</h3>
            <ContextChart points={stats.trend} turns={turns} singleTurn={isDock} />
          </section>

          <section className={cardCls} style={{ '--i': 2 } as CSSProperties}>
            <h3 className="cz-ctx__sub">缓存命中率</h3>
            <CacheChart points={stats.trend} singleTurn={isDock} />
          </section>

          <section className={cardCls} style={{ '--i': 3 } as CSSProperties} aria-label={costTitle}>
            <h3 className="cz-ctx__sub">{costTitle}</h3>
            <div className="cz-ctx__cache-head">
              <CountUp
                className="cz-ctx__cache-now"
                testId={isDock ? 'dock-cost' : 'crail-cost'}
                value={stats.cost.total}
                format={formatUsd}
                play={false}
              />
              <span className="cz-ctx__cache-sub">
                {isDock
                  ? stats.cost.unpriced > 0 && stats.cost.requests === 0
                    ? '未定价模型'
                    : stats.cost.saved > 0
                      ? `缓存省 ${formatUsd(stats.cost.saved)}`
                      : '本次任务'
                  : stats.cost.sub > 0
                    ? `含子代理 ${formatUsd(stats.cost.sub)}`
                    : '整个会话'}
              </span>
            </div>
            {railSources.length > 0 && (
              <div
                className="cz-ctx__bar cz-ctx__cost-mix cz-crail__cost-bar"
                role="img"
                aria-label={`花费来源：${railSources.map((s) => `${s.label} ${formatUsd(stats.cost.bySource[s.key])}`).join('，')}`}
              >
                {railSources.map((s) => (
                  <span
                    key={s.key}
                    className="cz-ctx__seg"
                    style={{ width: `${(stats.cost.bySource[s.key] / stats.cost.total) * 100}%`, background: s.color }}
                    title={`${s.label}：${formatUsd(stats.cost.bySource[s.key])}`}
                  />
                ))}
              </div>
            )}
            {stats.perRequest && reqCost ? (
              <CostChart mode="request" turns={reqCost.rows} estimated={reqCost.estimated} onJump={onJumpStep} />
            ) : (
              <CostChart turns={stats.cost.turns} flow={turns} compactions={track.compactions} onJump={onJumpTurn} />
            )}
          </section>
        </>
      )}
    </div>
  );
}
