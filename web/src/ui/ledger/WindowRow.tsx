// 单个额度窗口行：展示时间范围、当前进行中标记、起→止百分比小进度条、等效花费、100% 推算、请求数；
// 点击平滑展开明细（grid-template-rows 0fr ↔ 1fr），按需加载 /api/ledger/windows/:id 并渲染曲线与明细表。
import type { CSSProperties } from 'react';
import type { LedgerWindowDetail, LedgerWindowSummary } from '@cosyee/shared';
import { formatUsd } from '../context/cost';
import { Icon } from '../icons/Icon';
import { Reveal } from '../motion/Reveal';
import { BreakdownTable } from './BreakdownTable';
import {
  barRatios,
  estimateHint,
  formatKiroCredits,
  formatPercentRange,
  formatWindowRange,
  percentTone,
  type TokenUnitMode,
} from './format';
import { SnapshotChart } from './SnapshotChart';

export type DetailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok'; detail: LedgerWindowDetail }
  | { status: 'error'; message: string };

export interface WindowRowProps {
  win: LedgerWindowSummary;
  index: number;
  expanded: boolean;
  detail: DetailState;
  now: number;
  tokenUnit: TokenUnitMode;
  onCycleTokenUnit: () => void;
  onToggle: () => void;
  onRetryDetail: () => void;
}

export function WindowRow({
  win,
  index,
  expanded,
  detail,
  now,
  tokenUnit,
  onCycleTokenUnit,
  onToggle,
  onRetryDetail,
}: WindowRowProps) {
  const { start, end } = barRatios(win);
  const tone = percentTone(win.endPercent ?? win.startPercent);
  const kiroCredits = formatKiroCredits(win.used, win.limit);
  const estHint = estimateHint(win);
  const usd100 = win.estimate.usdPer100;
  const estUnreliable = usd100 !== null && !win.estimate.reliable;
  const delayMs = Math.min(index, 6) * 36;

  return (
    <div
      className={`cz-ledger-row${win.current ? ' is-current' : ''}${expanded ? ' is-open' : ''}`}
      style={{ '--row-delay': `${delayMs}ms` } as CSSProperties}
    >
      <button
        type="button"
        className="cz-ledger-row__head"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <div className="cz-ledger-row__title">
          <span className="cz-ledger-row__range">
            {formatWindowRange(win.start, win.end, win.kind, now)}
          </span>
          {win.current && (
            <span className="cz-ledger-pill is-live">
              <i className="cz-ledger-pill__dot" aria-hidden="true" />
              进行中
            </span>
          )}
          {win.group && (
            <span className="cz-ledger-pill is-group" title={`分组：${win.group}`}>
              {win.group}
            </span>
          )}
          {win.external && (
            <span
              className="cz-ledger-pill is-warn"
              title="检测到 Cosyee 外部用量：相邻快照之间百分比上涨 ≥ 2 个百分点，但账本里没有该账号的请求"
            >
              外部用量
            </span>
          )}
        </div>

        <div className="cz-ledger-row__metrics">
          <div className={`cz-ledger-row__pct is-${tone}`}>
            <span className="cz-ledger-row__pct-text">
              {formatPercentRange(win.startPercent, win.endPercent)}
            </span>
            <span className="cz-ledger-bar" aria-hidden="true">
              <span className="cz-ledger-bar__end" style={{ '--p': end } as CSSProperties} />
              {start > 0 && (
                <span className="cz-ledger-bar__start" style={{ '--p': start } as CSSProperties} />
              )}
            </span>
            {kiroCredits && <span className="cz-ledger-row__credits">{kiroCredits}</span>}
          </div>

          <div className="cz-ledger-row__metric">
            <span className="cz-ledger-row__mk">等效花费</span>
            <span className="cz-ledger-row__mv">
              <span>{formatUsd(win.costUsd)}</span>
              {win.unpricedRequests > 0 && (
                <span
                  className="cz-ledger-row__unpriced"
                  title={`含 ${win.unpricedRequests} 个无价格请求，未计入等效花费`}
                >
                  含无价格
                </span>
              )}
            </span>
          </div>

          <div
            className={`cz-ledger-row__metric cz-ledger-row__est${estUnreliable ? ' is-unreliable' : ''}${usd100 === null ? ' is-null' : ''}`}
            title={estHint}
          >
            <span className="cz-ledger-row__mk">100% 推算</span>
            <span className="cz-ledger-row__mv">
              {usd100 === null ? (
                <span>—</span>
              ) : (
                <>
                  <span>≈ {formatUsd(usd100)}</span>
                  {estUnreliable && <Icon name="alert" size={11} className="cz-ledger-row__warn-ico" />}
                </>
              )}
            </span>
          </div>

          <div className="cz-ledger-row__metric cz-ledger-row__reqs">
            <span className="cz-ledger-row__mk">请求</span>
            <span className="cz-ledger-row__mv">{win.requests}</span>
          </div>
        </div>

        <span className="cz-ledger-row__chev" aria-hidden="true">
          <Icon name="chevron" size={13} open={expanded} />
        </span>
      </button>

      <Reveal open={expanded} className="cz-ledger-row__reveal">
        <div className="cz-ledger-detail">
          {estUnreliable && (
            <div className="cz-ledger-detail__notice" role="note">
              <Icon name="alert" size={13} />
              <span>检测到 Cosyee 外部用量，100% 额度推算仅供参考。</span>
            </div>
          )}

          {detail.status === 'loading' || detail.status === 'idle' ? (
            <div className="cz-ledger-detail__skel" aria-busy="true" aria-label="正在加载窗口明细">
              <div className="cz-ledger-skel cz-ledger-skel--chart" />
              <div className="cz-ledger-skel cz-ledger-skel--line" />
              <div className="cz-ledger-skel cz-ledger-skel--line is-short" />
            </div>
          ) : detail.status === 'error' ? (
            <div className="cz-ledger-detail__err" role="alert">
              <span>明细加载失败：{detail.message}</span>
              <button type="button" className="cz-ledger-btn" onClick={onRetryDetail}>
                重试
              </button>
            </div>
          ) : (
            <>
              <SnapshotChart
                start={detail.detail.start}
                end={detail.detail.end}
                current={detail.detail.current}
                snapshots={detail.detail.snapshots}
                now={now}
              />
              <BreakdownTable
                rows={detail.detail.rows}
                tokenUnit={tokenUnit}
                onCycleTokenUnit={onCycleTokenUnit}
              />
            </>
          )}
        </div>
      </Reveal>
    </div>
  );
}
