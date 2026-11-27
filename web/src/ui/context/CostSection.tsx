// 上下文面板的「花费」一节：合计（主线程 + 全部子代理）+ 本轮 / 每次请求均 / 缓存已省、
// 「按来源 / 按类别」分段切换与明细条（悬停来源展开子代理类型明细，点击子代理打开浮层）、每轮堆叠柱状图、下一次请求预估、价格来源与提示。
import { useMemo, useState } from 'react';
import {
  cliCostMismatches, costTotal,
  type AccountEntry, type CachePoint, type CliModelCost, type CompactMark, type PriceTable,
  type SubagentAccountOption, type SubagentConfig, type SubagentCost, type Turn,
} from '@cosyee/shared';
import { CountUp } from '../motion/CountUp';
import { LiquidCapsule } from '../motion/LiquidCapsule';
import { CostChart } from './CostChart';
import { COST_KINDS, COST_SOURCES, formatUsd, sessionCost, type CostSource } from './cost';
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
  /** 子代理配置（推断实时委派子代理的来源与计费） */
  subagents?: SubagentConfig | null;
  /** 委派可选账号列表（判断 Claude 委派账号计费） */
  subagentAccounts?: readonly SubagentAccountOption[];
  /** 主会话账号列表（判断 Claude 委派账号计费） */
  accounts?: readonly AccountEntry[];
  intro?: boolean;
  onJumpTurn?: (turn: number) => void;
  /** 点击明细里的具体子代理打开浮层 */
  onOpenSubagent?: (turnId: string, toolUseId: string) => void;
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
  points,
  turns,
  compactions,
  subs,
  table,
  fallbackModel,
  historyTokens = null,
  cliCost,
  billing = 'api',
  subagents,
  subagentAccounts,
  accounts,
  intro = false,
  onJumpTurn,
  onOpenSubagent,
}: CostSectionProps) {
  const [view, setView] = useState<'source' | 'kind'>('source');
  const [hotSource, setHotSource] = useState<CostSource | null>(null);

  const c = useMemo(
    () =>
      sessionCost({
        points,
        turns,
        compactions,
        subs,
        table,
        fallbackModel,
        historyTokens,
        subagents,
        subagentAccounts,
        accounts,
        billing,
      }),
    [points, turns, compactions, subs, table, fallbackModel, historyTokens, subagents, subagentAccounts, accounts, billing],
  );
  const mismatches = useMemo(() => (cliCost?.length ? cliCostMismatches(table, cliCost) : []), [table, cliCost]);

  const title = billing === 'subscription' && !c.mixedBilling ? '花费（等价 API 价格）' : '花费';
  const lastTurn = c.turns[c.turns.length - 1];
  const thisTurn = lastTurn ? costTotal(lastTurn.main) + costTotal(lastTurn.sub) : 0;
  const perReq = c.requests > 0 ? c.total / c.requests : 0;
  const hasUncachedSubs = (turns ?? []).some((t) => t.subagents.some((r) => !r.cache?.length));
  const other = costTotal(c.other);

  const activeSources = useMemo(
    () => COST_SOURCES.filter((s) => c.bySource[s.key] > 0),
    [c.bySource],
  );
  const subSourceSet = useMemo(() => new Set(c.subscriptionSources), [c.subscriptionSources]);
  const hotTypes = useMemo(
    () => (hotSource && hotSource !== 'main' ? c.byType.filter((t) => t.source === hotSource) : []),
    [hotSource, c.byType],
  );

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
  if (hasUncachedSubs && subs == null) notes.push({ key: 'subs', text: '子代理的花费还在读取，暂未计入' });
  if (other > 0) notes.push({ key: 'other', text: `其中 ${formatUsd(other)} 来自不属于某一轮的子代理（如压缩摘要），只计入合计` });
  if (c.mixedBilling) {
    notes.push({ key: 'bill', text: '订阅账号部分按等价 API 价格计' });
  } else if (billing === 'subscription') {
    notes.push({ key: 'bill', text: '订阅账号按额度计费，不按 token 扣钱；这里是同样用量按 API 价格算的金额。' });
  } else if (billing === 'thirdParty') {
    notes.push({ key: 'bill', text: '当前账号使用第三方接口地址，这里按 Anthropic 官方价估算，实际以服务商账单为准。' });
  }
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
      <div className="cz-ctx__cost-top">
        <h3 className="cz-ctx__sub">{title}</h3>
        {!empty && c.total > 0 && (
          <div className="cz-ctx__cost-seg" role="tablist" aria-label="花费明细维度">
            <LiquidCapsule activeKey={view} selector=".cz-ctx__cost-opt.is-active" axis="x" />
            <button
              type="button"
              role="tab"
              aria-selected={view === 'source'}
              className={`cz-ctx__cost-opt${view === 'source' ? ' is-active' : ''}`}
              onClick={() => setView('source')}
            >
              按来源
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'kind'}
              className={`cz-ctx__cost-opt${view === 'kind' ? ' is-active' : ''}`}
              onClick={() => setView('kind')}
            >
              按类别
            </button>
          </div>
        )}
      </div>

      {empty ? (
        <div className="cz-ctx__cache-empty">发送消息后，这里显示这个会话花了多少钱</div>
      ) : (
        <>
          <div className="cz-ctx__cache-head">
            <CountUp className="cz-ctx__cache-now" testId="cost-total" value={c.total} format={formatUsd} play={intro} delay={240} />
            <span className="cz-ctx__cache-sub">整个会话</span>
          </div>
          {stats.length > 0 && <div className="cz-ctx__cost-stats">{stats.join(' · ')}</div>}

          {c.total > 0 && view === 'source' && (
            <div className="cz-ctx__cost-sources" onMouseLeave={() => setHotSource(null)}>
              <div
                className={`cz-ctx__bar cz-ctx__cost-mix${hotSource ? ' has-hot' : ''}`}
                role="img"
                aria-label={`花费来源：${activeSources.map((s) => `${s.label} ${formatUsd(c.bySource[s.key])}`).join('，')}`}
              >
                {activeSources.map((s) => (
                  <span
                    key={s.key}
                    className={`cz-ctx__seg${hotSource === s.key ? ' is-hot' : ''}`}
                    style={{ width: `${(c.bySource[s.key] / c.total) * 100}%`, background: s.color }}
                    title={`${s.label}：${formatUsd(c.bySource[s.key])}`}
                    onMouseEnter={() => setHotSource(s.key)}
                    onClick={() => setHotSource((cur) => (cur === s.key ? null : s.key))}
                  />
                ))}
              </div>
              <ul className="cz-ctx__list cz-ctx__list--cats">
                {activeSources.map((s) => {
                  const val = c.bySource[s.key];
                  const isSub = s.key !== 'main';
                  const isHot = hotSource === s.key;
                  const showEq = c.mixedBilling && subSourceSet.has(s.key);
                  return (
                    <li
                      key={s.key}
                      className={`cz-ctx__item${isHot ? ' is-hot' : ''}`}
                      onMouseEnter={() => setHotSource(s.key)}
                      onClick={isSub ? () => setHotSource((cur) => (cur === s.key ? null : s.key)) : undefined}
                    >
                      <span className="cz-ctx__swatch" style={{ background: s.color }} />
                      <span className="cz-ctx__item-name">
                        {s.label}
                        {showEq && <span className="cz-ctx__cost-eq">等价</span>}
                      </span>
                      <span className="cz-ctx__item-tokens">{formatUsd(val)}</span>
                      <span className="cz-ctx__item-pct">{formatPercent((val / c.total) * 100)}</span>
                    </li>
                  );
                })}
              </ul>
              {hotTypes.length > 0 && (
                <div className="cz-ctx__cost-detail" data-testid="cost-source-detail">
                  {hotTypes.map((t) => {
                    const clickableRuns = t.runs.filter((r) => !!r.turnId && !!r.toolUseId && !!onOpenSubagent);
                    const single = clickableRuns.length === 1 && t.runs.length === 1 ? clickableRuns[0]! : null;
                    return (
                      <div key={`${t.source}:${t.agentType}`} className="cz-ctx__cost-type">
                        {single ? (
                          <button
                            type="button"
                            className="cz-ctx__cost-type-btn"
                            onClick={() => onOpenSubagent!(single.turnId!, single.toolUseId!)}
                            title={`打开子代理：${single.title}`}
                          >
                            <span className="cz-ctx__cost-type-name">
                              {t.agentType} ×{t.count}
                            </span>
                            <span className="cz-ctx__cost-type-val">{formatUsd(t.cost)}</span>
                          </button>
                        ) : (
                          <>
                            <div className="cz-ctx__cost-type-head">
                              <span className="cz-ctx__cost-type-name">
                                {t.agentType} ×{t.count}
                              </span>
                              <span className="cz-ctx__cost-type-val">{formatUsd(t.cost)}</span>
                            </div>
                            {clickableRuns.length > 0 && (
                              <div className="cz-ctx__cost-runs">
                                {clickableRuns.map((r) => (
                                  <button
                                    key={r.toolUseId}
                                    type="button"
                                    className="cz-ctx__cost-run"
                                    onClick={() => onOpenSubagent!(r.turnId!, r.toolUseId!)}
                                    title={r.title}
                                  >
                                    <span className="cz-ctx__cost-run-title">{r.title}</span>
                                    <span className="cz-ctx__cost-run-val">{formatUsd(r.cost)}</span>
                                  </button>
                                ))}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {c.total > 0 && view === 'kind' && (
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
