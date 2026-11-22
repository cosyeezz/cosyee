// 上下文面板的「花费」一节：合计 + 本轮 / 每次请求均 / 缓存已省、四类明细条、每轮柱状图、下一次请求预估、价格来源与提示。
import { useMemo } from 'react';
import {
  cliCostMismatches, costTotal,
  type CachePoint, type CliModelCost, type CompactMark, type PriceTable, type SubagentCost, type Turn,
} from '@cosyee/shared';
import { CountUp } from '../motion/CountUp';
import { CostChart } from './CostChart';
import { COST_KINDS, formatUsd, sessionCost } from './cost';
import { formatPercent, formatTokens } from './formatTokens';

/** 计费方式：API 密钥（官方地址）/ 订阅账号（按额度，显示等价 API 价）/ 第三方接口地址（按官方价估算） */
export type Billing = 'api' | 'subscription' | 'thirdParty';

export interface CostSectionProps {
  points?: readonly CachePoint[];
  turns?: readonly Turn[];
  compactions?: readonly CompactMark[];
  /** 子代理花费（GET /api/sessions/:id/subagent-costs）；还没取到为 null */
  subs?: readonly SubagentCost[] | null;
  table: PriceTable;
  /** 点里没带模型时按这个模型算（会话的模型） */
  fallbackModel?: string;
  /** 当前上下文里消息历史的 token；不知道为 null */
  historyTokens?: number | null;
  /** CLI result 报告的按模型花费，用来核对价格表 */
  cliCost?: readonly CliModelCost[];
  billing?: Billing;
  intro?: boolean;
  onJumpTurn?: (turn: number) => void;
}

const KIND_COLOR: Record<string, string> = {
  read: 'var(--cz-ctx-messages)',
  write: 'var(--cz-ctx-sys-prompt)',
  output: 'var(--cz-ctx-sys-tools)',
  input: 'var(--cz-ctx-other)',
};

const pad = (n: number) => String(n).padStart(2, '0');
function formatWhen(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CostSection({
  points, turns, compactions, subs, table, fallbackModel, historyTokens = null, cliCost, billing = 'api', intro = false, onJumpTurn,
}: CostSectionProps) {
  const c = useMemo(
    () => sessionCost({ points, turns, compactions, subs, table, fallbackModel, historyTokens }),
    [points, turns, compactions, subs, table, fallbackModel, historyTokens],
  );
  const mismatches = useMemo(() => (cliCost?.length ? cliCostMismatches(table, cliCost) : []), [table, cliCost]);

  const title = billing === 'subscription' ? '花费（等价 API 价格）' : '花费';
  const lastTurn = c.turns[c.turns.length - 1];
  const thisTurn = lastTurn ? costTotal(lastTurn.main) + costTotal(lastTurn.sub) : 0;
  const perReq = c.requests > 0 ? c.total / c.requests : 0;
  const hasSubs = (turns ?? []).some((t) => t.subagents.length > 0);
  const other = costTotal(c.other);

  const stats = [
    lastTurn && `本轮 ${formatUsd(thisTurn)}`,
    c.requests > 0 && `每次请求均 ${formatUsd(perReq)}`,
    c.saved > 0 && `缓存已省 ${formatUsd(c.saved)}`,
  ].filter(Boolean);

  const notes: { key: string; text: string; warn?: boolean }[] = [];
  if (mismatches.length > 0) {
    const m = mismatches[0]!;
    notes.push({
      key: 'stale',
      warn: true,
      text: `价格表可能过期：${m.model} 按价格表算 ${formatUsd(m.ours)}，CLI 报告 ${formatUsd(m.cli)}${mismatches.length > 1 ? `（另有 ${mismatches.length - 1} 个模型对不上）` : ''}`,
    });
  }
  if (c.unpriced > 0) {
    notes.push({ key: 'unpriced', warn: true, text: `${c.unpriced} 次请求的模型不在价格表里（${c.unpricedModels.join('、')}），没有计入` });
  }
  if (hasSubs && subs == null) notes.push({ key: 'subs', text: '子代理的花费还在读取，暂未计入' });
  if (other > 0) notes.push({ key: 'other', text: `其中 ${formatUsd(other)} 来自不属于某一轮的子代理（如压缩摘要），只计入合计` });
  if (billing === 'subscription') notes.push({ key: 'bill', text: '订阅账号按额度计费，不按 token 扣钱；这里是同样用量按 API 价格算的金额。' });
  if (billing === 'thirdParty') notes.push({ key: 'bill', text: '当前账号使用第三方接口地址，这里按 Anthropic 官方价估算，实际以服务商账单为准。' });
  notes.push({
    key: 'src',
    text:
      table.source === 'official' && table.fetchedAt !== null
        ? `价格来自 Anthropic 官方价格页，${formatWhen(table.fetchedAt)} 更新`
        : '价格来自内置价格表（暂时取不到官方最新价）',
  });

  const empty = c.requests === 0 && c.unpriced === 0;

  return (
    <section className="cz-ctx__section cz-ctx__cost" aria-label={title}>
      <h3 className="cz-ctx__sub">{title}</h3>
      {empty ? (
        <div className="cz-ctx__cache-empty">发送消息后，这里显示这个会话花了多少钱</div>
      ) : (
        <>
          <div className="cz-ctx__cache-head">
            <CountUp className="cz-ctx__cache-now" testId="cost-total" value={c.total} format={formatUsd} play={intro} delay={240} />
            <span className="cz-ctx__cache-sub">{c.sub > 0 ? `含子代理 ${formatUsd(c.sub)}` : '整个会话'}</span>
          </div>
          {stats.length > 0 && <div className="cz-ctx__cost-stats">{stats.join(' · ')}</div>}

          {c.total > 0 && (
            <>
              <div className="cz-ctx__bar cz-ctx__cost-mix" role="img" aria-label={`花费构成：${COST_KINDS.map((k) => `${k.label} ${formatUsd(c.parts[k.key])}`).join('，')}`}>
                {COST_KINDS.map((k) =>
                  c.parts[k.key] > 0 ? (
                    <span
                      key={k.key}
                      className="cz-ctx__seg"
                      style={{ width: `${(c.parts[k.key] / c.total) * 100}%`, background: KIND_COLOR[k.key] }}
                      title={`${k.label}：${formatUsd(c.parts[k.key])}`}
                    />
                  ) : null,
                )}
              </div>
              <ul className="cz-ctx__list">
                {COST_KINDS.map((k) => (
                  <li key={k.key} className={`cz-ctx__item${c.parts[k.key] > 0 ? '' : ' is-free'}`} title={k.hint}>
                    <span className="cz-ctx__swatch" style={{ background: KIND_COLOR[k.key] }} />
                    <span className="cz-ctx__item-name">{k.label}</span>
                    <span className="cz-ctx__item-tokens">{formatUsd(c.parts[k.key])}</span>
                    <span className="cz-ctx__item-pct">{formatPercent((c.parts[k.key] / c.total) * 100)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <CostChart turns={c.turns} flow={turns} compactions={compactions} intro={intro} onJump={onJumpTurn} />

          {c.next && (
            <div className="cz-ctx__cost-next" data-testid="cost-next">
              <div>
                下一次请求约 <b>{formatUsd(c.next.warm)}</b>
                <span className="cz-ctx__cost-dim">（输入 {formatTokens(c.next.prompt)}；缓存过期则约 {formatUsd(c.next.cold)}）</span>
              </div>
              {c.next.history !== null && c.next.warm > 0 && c.next.history > 0 && (
                <div className="cz-ctx__cost-dim">
                  其中消息历史约 {formatUsd(c.next.history)}（{formatPercent((c.next.history / c.next.warm) * 100)}），压缩会话能省下大部分
                </div>
              )}
            </div>
          )}
        </>
      )}
      {notes.map((n) => (
        <p key={n.key} className={`cz-ctx__note${n.warn ? ' is-warn' : ''}`}>
          {n.text}
        </p>
      ))}
    </section>
  );
}
