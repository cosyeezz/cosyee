// 窗口明细表：按 模型 × 层级 × agent 展示 token（输入 / 缓存写 5m / 缓存写 1h / 缓存读 / 输出（含推理））、请求数与等效花费。
// 点击任意 token 表头或数值可在 自动 → M → B → 完整 间循环切换；悬停始终显示完整千分位 token 数。
// 窄容器（@container max-width: 580px）自动折叠为紧凑卡片结构，避免横向滚动与截断。
import type { LedgerBreakdownRow } from '@cosyee/shared';
import { formatUsd } from '../context/cost';
import {
  formatFullTokens,
  formatLedgerTokens,
  formatModelName,
  LAYER_LABEL,
  type TokenUnitMode,
} from './format';

export interface BreakdownTableProps {
  rows: readonly LedgerBreakdownRow[];
  tokenUnit: TokenUnitMode;
  onCycleTokenUnit: () => void;
}

function TokenHeader({ label, onCycle }: { label: string; onCycle: () => void }) {
  return (
    <th scope="col" className="cz-ledger-tbl__num">
      <button
        type="button"
        className="cz-ledger-tok-th"
        title="点击切换 token 单位（自动 / M / B / 完整）"
        onClick={onCycle}
      >
        {label}
      </button>
    </th>
  );
}

function TokenCell({
  value,
  label,
  unit,
  onCycle,
  reasoning,
}: {
  value: number;
  label: string;
  unit: TokenUnitMode;
  onCycle: () => void;
  reasoning?: number;
}) {
  const full = formatFullTokens(value);
  const tip = value === 0 ? '0 tokens（点击切换单位）' : `${full} tokens（点击切换单位）`;
  const hasReasoning = reasoning !== undefined && reasoning > 0;
  const reasoningTip = hasReasoning ? `含推理 ${formatFullTokens(reasoning)} tokens（点击切换单位）` : undefined;
  return (
    <td className="cz-ledger-tbl__num" data-label={label}>
      <button
        type="button"
        className={`cz-ledger-tok-btn${value === 0 ? ' is-zero' : ''}`}
        title={tip}
        onClick={onCycle}
      >
        <span key={unit} className="cz-ledger-tok-val">
          {value === 0 ? '—' : formatLedgerTokens(value, unit)}
        </span>
      </button>
      {hasReasoning && (
        <button
          type="button"
          className="cz-ledger-tbl__sub cz-ledger-tok-btn"
          title={reasoningTip}
          onClick={onCycle}
        >
          <span key={unit} className="cz-ledger-tok-val">
            含推理 {formatLedgerTokens(reasoning, unit)}
          </span>
        </button>
      )}
    </td>
  );
}

export function BreakdownTable({ rows, tokenUnit, onCycleTokenUnit }: BreakdownTableProps) {
  if (rows.length === 0) {
    return <div className="cz-ledger-tbl__empty">本窗口暂无按模型分类的请求明细</div>;
  }

  return (
    <div className="cz-ledger-tbl-wrap" data-unit={tokenUnit}>
      <table className="cz-ledger-tbl">
        <thead>
          <tr>
            <th scope="col" className="cz-ledger-tbl__col-main">模型 / 层级</th>
            <TokenHeader label="输入" onCycle={onCycleTokenUnit} />
            <TokenHeader label="写 5m" onCycle={onCycleTokenUnit} />
            <TokenHeader label="写 1h" onCycle={onCycleTokenUnit} />
            <TokenHeader label="读缓存" onCycle={onCycleTokenUnit} />
            <TokenHeader label="输出" onCycle={onCycleTokenUnit} />
            <th scope="col" className="cz-ledger-tbl__num">请求</th>
            <th scope="col" className="cz-ledger-tbl__num cz-ledger-tbl__col-cost">花费</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const modelName = formatModelName(r.model);
            const allUnpriced = r.unpricedRequests >= r.requests && r.costUsd <= 0;
            return (
              <tr key={`${r.model ?? 'unknown'}:${r.layer}:${r.agent ?? ''}:${i}`}>
                <td className="cz-ledger-tbl__main">
                  <div className="cz-ledger-tbl__model-line">
                    <span className="cz-ledger-tbl__model" title={r.model ?? '未知模型'}>{modelName}</span>
                    <span className={`cz-ledger-tag cz-ledger-tag--layer is-${r.layer}`}>
                      {LAYER_LABEL[r.layer]}
                    </span>
                    {r.agent && (
                      <span className="cz-ledger-tag cz-ledger-tag--agent" title={`子代理：${r.agent}`}>
                        {r.agent}
                      </span>
                    )}
                    {r.estimated && (
                      <span
                        className="cz-ledger-tag cz-ledger-tag--est"
                        title="含按比例分摊的估算请求（单轮多次模型调用）"
                      >
                        估算
                      </span>
                    )}
                    {r.unpricedRequests > 0 && (
                      <span
                        className="cz-ledger-tag cz-ledger-tag--warn"
                        title={`有 ${r.unpricedRequests} 次请求未在价格表中找到定价，未计入花费`}
                      >
                        无价格
                      </span>
                    )}
                  </div>
                </td>
                <TokenCell value={r.tokens.input} label="输入" unit={tokenUnit} onCycle={onCycleTokenUnit} />
                <TokenCell value={r.tokens.create5m} label="写 5m" unit={tokenUnit} onCycle={onCycleTokenUnit} />
                <TokenCell value={r.tokens.create1h} label="写 1h" unit={tokenUnit} onCycle={onCycleTokenUnit} />
                <TokenCell value={r.tokens.read} label="读缓存" unit={tokenUnit} onCycle={onCycleTokenUnit} />
                <TokenCell
                  value={r.tokens.output}
                  label="输出"
                  unit={tokenUnit}
                  onCycle={onCycleTokenUnit}
                  reasoning={r.tokens.reasoning}
                />
                <td className="cz-ledger-tbl__num" data-label="请求">{r.requests}</td>
                <td className="cz-ledger-tbl__num cz-ledger-tbl__cost" data-label="花费">
                  {allUnpriced ? (
                    <span className="is-zero" title="价格表暂无该模型定价">—</span>
                  ) : (
                    formatUsd(r.costUsd)
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
