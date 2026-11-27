// 上下文栏收起时浮在会话流右上角的几张图：上下文占用、上下文走势、缓存命中率、每轮花费（复用 UsageBoard）。
// 只在会话流右侧的留白够宽时出现（宽度判断在 ChartRail.css 的容器查询里），高度夹在顶栏和输入框之间，放不下时在里面滚动。
// 动效：收起上下文栏时，等栏的宽度动画走完，各块从右侧依次滑入；展开时各块朝右收进去淡出，播完再卸载（样式见 ChartRail.css）。
import { useMemo, useRef, useState } from 'react';
import type { AccountEntry, CachePoint, CompactMark, ContextUsage, PriceTable, SubagentAccountOption, SubagentConfig, SubagentCost, Turn, UsageTrack } from '@cosyee/shared';
import { leavingProps, usePresence } from '../motion/usePresence';
import { UsageBoard } from './UsageBoard';
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
  subagents?: SubagentConfig | null;
  subagentAccounts?: readonly SubagentAccountOption[];
  accounts?: readonly AccountEntry[];
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
  if (show && (shown.usage !== data.usage || shown.cache !== data.cache || shown.turns !== data.turns || shown.subCosts !== data.subCosts || shown.pricing !== data.pricing)) {
    setShown(data);
  }
  const d = show ? data : shown;
  const { usage, cache, turns, compactions, subCosts, subagents, subagentAccounts, accounts, pricing, model, billing = 'api', onJumpTurn } = d;

  const track = useMemo<UsageTrack>(() => ({
    points: cache ?? [],
    window: usage?.totalTokens ?? null,
    breakdown: usage ?? null,
    compactions,
    billing,
  }), [cache, usage, compactions, billing]);

  if (!mounted) return null;
  return (
    <aside
      ref={ref}
      className={`cz-crail${leaving ? ' is-leaving' : ''}`}
      aria-label="上下文图表"
      {...leavingProps(leaving)}
    >
      <UsageBoard
        track={track}
        pricing={pricing}
        layout="rail"
        turns={turns}
        subCosts={subCosts}
        subagents={subagents}
        subagentAccounts={subagentAccounts}
        accounts={accounts}
        model={model}
        onJumpTurn={onJumpTurn}
      />
    </aside>
  );
}
