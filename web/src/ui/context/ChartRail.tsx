// 上下文栏收起时浮在会话流右上角的几张图：上下文占用、上下文走势、缓存命中率、每轮花费（与上下文栏里的同一套组件）。
// 只在会话流右侧的留白够宽时出现（宽度判断在 ChartRail.css 的容器查询里），高度夹在顶栏和输入框之间，放不下时在里面滚动。
// 动效：收起上下文栏时，等栏的宽度动画走完，各块从右侧依次滑入；展开时各块朝右收进去淡出，播完再卸载（样式见 ChartRail.css）。
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import type { CachePoint, CompactMark, ContextUsage, PriceTable, SubagentCost, Turn } from '@cosyee/shared';
import { leavingProps, usePresence } from '../motion/usePresence';
import { CacheChart } from './CacheChart';
import { ContextChart } from './ContextChart';
import { CostChart } from './CostChart';
import { UsageBar, usageDenom } from './ContextPanel';
import { formatUsd, sessionCost } from './cost';
import { formatPercent, formatTokens } from './formatTokens';
import type { Billing } from './CostSection';
import './ContextPanel.css';
import './ChartRail.css';

export interface ChartRailProps {
  /** 是否显示（上下文栏收起、且不是窄屏抽屉模式）；占用和请求数据都还没有时不显示 */
  open: boolean;
  /** 上下文占用（/context）；没有则不显示占用那一块 */
  usage?: ContextUsage | null;
  cache?: CachePoint[];
  turns?: Turn[];
  compactions?: readonly CompactMark[];
  subCosts?: readonly SubagentCost[] | null;
  pricing: PriceTable;
  model?: string;
  billing?: Billing;
  onJumpTurn?: (turn: number) => void;
}

type Data = Omit<ChartRailProps, 'open'>;

export function ChartRail({ open, ...data }: ChartRailProps) {
  const ref = useRef<HTMLElement>(null);
  const hasPoints = (data.cache?.length ?? 0) > 0;
  const show = open && (!!data.usage || hasPoints);
  const { mounted, leaving } = usePresence(show, ref, 160);
  // 退场途中数据被清空（切到新会话）时，保留最后一份淡出，而不是先变成空图
  const [shown, setShown] = useState<Data>(data);
  const [hot, setHot] = useState<string | null>(null);
  if (show && (shown.usage !== data.usage || shown.cache !== data.cache || shown.turns !== data.turns || shown.subCosts !== data.subCosts || shown.pricing !== data.pricing)) {
    setShown(data);
  }
  const d = show ? data : shown;
  const { usage, cache, turns, compactions, subCosts, pricing, model, billing = 'api', onJumpTurn } = d;
  const cost = useMemo(
    () => sessionCost({ points: cache, turns, compactions, subs: subCosts, table: pricing, fallbackModel: model, historyTokens: null }),
    [cache, turns, compactions, subCosts, pricing, model],
  );

  if (!mounted) return null;
  const costTitle = billing === 'subscription' ? '花费（等价 API 价格）' : '花费';
  return (
    <aside
      ref={ref}
      className={`cz-crail${leaving ? ' is-leaving' : ''}`}
      aria-label="上下文图表"
      {...leavingProps(leaving)}
    >
      <div className="cz-crail__list">
        {usage && (
          <section className="cz-crail__card" style={{ '--i': 0 } as CSSProperties} aria-label="上下文占用">
            <div className="cz-ctx__overview">
              <span className="cz-crail__percent">{formatPercent(usage.percent)}</span>
              <span className="cz-crail__used">{formatTokens(usage.usedTokens)} / {formatTokens(usage.totalTokens)}</span>
            </div>
            <UsageBar usage={usage} denom={usageDenom(usage)} hot={hot} onHot={setHot} />
          </section>
        )}
        {(cache?.length ?? 0) > 0 && (
          <>
            <section className="cz-crail__card" style={{ '--i': 1 } as CSSProperties}>
              <h3 className="cz-ctx__sub">上下文走势</h3>
              <ContextChart points={cache} turns={turns} />
            </section>
            <section className="cz-crail__card" style={{ '--i': 2 } as CSSProperties}>
              <h3 className="cz-ctx__sub">缓存命中率</h3>
              <CacheChart points={cache} />
            </section>
            <section className="cz-crail__card" style={{ '--i': 3 } as CSSProperties} aria-label={costTitle}>
              <h3 className="cz-ctx__sub">{costTitle}</h3>
              <div className="cz-ctx__cache-head">
                <span className="cz-ctx__cache-now" data-testid="crail-cost">{formatUsd(cost.total)}</span>
                <span className="cz-ctx__cache-sub">{cost.sub > 0 ? `含子代理 ${formatUsd(cost.sub)}` : '整个会话'}</span>
              </div>
              <CostChart turns={cost.turns} flow={turns} compactions={compactions} onJump={onJumpTurn} />
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
