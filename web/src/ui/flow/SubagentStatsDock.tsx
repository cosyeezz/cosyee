// 子代理浮层底部固定统计区：标题行展示模型 / 思考强度 / 账号(后端) / 请求数 / 耗时 / 状态等元信息，
// 整行可点击展开 / 收起（默认展开），展开内容复用 UsageBoard(layout="dock") 展示四块统计卡片。
import { useEffect, useId, useMemo, useState } from 'react';
import {
  BUILTIN_PRICES,
  type AccountEntry, type ApiModelMap, type CliModelCost, type DelegateBackendId, type DelegateJobInfo,
  type PriceTable, type SubagentAccountOption, type SubagentConfig, type SubagentRoute, type SubagentRun,
  type Turn, type UsageBilling, type UsageTrack,
} from '@cosyee/shared';
import { Chevron } from '../context/Fold';
import { UsageBoard } from '../context/UsageBoard';
import { resolveSubagentContextWindow } from '../context/usageStats';
import { effortText, formatDuration, prettyModel, runParams } from './format';
import './SubagentStatsDock.css';

const STATUS_LABEL: Record<SubagentRun['status'], string> = {
  running: '执行中',
  done: '已完成',
  error: '出错',
};

const BACKEND_LABEL: Record<DelegateBackendId, string> = {
  claude: 'Claude',
  agy: 'Antigravity',
  codex: 'Codex',
};

/** 查找委派子代理对应的配置路线 */
export function resolveDelegateRoute(run: SubagentRun, cfg?: SubagentConfig | null): SubagentRoute | null {
  if (run.delegate !== true || !cfg) return null;
  return (run.subagentType ? cfg.delegate.agents?.[run.subagentType] : undefined) ?? cfg.delegate.default ?? null;
}

/** 根据 AccountEntry 判断计费方式（与主会话 MainApp 一致） */
export function billingOfAccount(acc: AccountEntry | undefined): UsageBilling {
  if (!acc?.api) return 'subscription';
  const base = acc.api.baseUrl.trim();
  return !base || /^https?:\/\/api\.anthropic\.com(\/|$)/i.test(base) ? 'api' : 'thirdParty';
}

/** 推算子代理的计费方式：原生跟随主会话；委派按路线账号类型（Claude 订阅/agy/codex/kiro → subscription，API → api/thirdParty） */
export function resolveSubagentBilling(opts: {
  run: SubagentRun;
  subagents?: SubagentConfig | null;
  subagentAccounts?: readonly SubagentAccountOption[];
  accounts?: readonly AccountEntry[];
  sessionBilling?: UsageBilling;
}): UsageBilling {
  const { run, subagents, subagentAccounts, accounts, sessionBilling = 'subscription' } = opts;
  if (run.delegate !== true) return sessionBilling;
  const route = resolveDelegateRoute(run, subagents);
  if (!route) return sessionBilling;
  if (route.backend === 'agy' || route.backend === 'codex') return 'subscription';
  // claude 委派：优先查完整 AccountEntry（可区分官方 API 与第三方地址），否则退回 SubagentAccountOption.group
  const acc = accounts?.find((a) => a.id === route.accountId);
  if (acc) return billingOfAccount(acc);
  const opt = subagentAccounts?.find((a) => a.backend === 'claude' && a.id === route.accountId);
  if (opt) return opt.group === 'api' ? 'api' : 'subscription';
  return sessionBilling;
}

/** 推算子代理的账号与后端展示文案 */
export function resolveSubagentAccountText(opts: {
  run: SubagentRun;
  subagents?: SubagentConfig | null;
  subagentAccounts?: readonly SubagentAccountOption[];
}): string {
  const { run, subagents, subagentAccounts } = opts;
  if (run.delegate !== true) return '主会话账号';
  const route = resolveDelegateRoute(run, subagents);
  if (!route) return '委派账号';
  const backend = BACKEND_LABEL[route.backend];
  const label = subagentAccounts?.find((a) => a.backend === route.backend && a.id === route.accountId)?.label;
  return label ? `${label} (${backend})` : backend;
}

export interface SubagentStatsDockProps {
  run: SubagentRun;
  turns: Turn[];
  subagents?: SubagentConfig | null;
  subagentAccounts?: readonly SubagentAccountOption[];
  accounts?: readonly AccountEntry[];
  sessionBilling?: UsageBilling;
  pricing?: PriceTable;
  cliCost?: readonly CliModelCost[];
  modelMap?: ApiModelMap | null;
  job?: DelegateJobInfo;
  /** 默认是否展开（默认 true） */
  defaultOpen?: boolean;
}

export function SubagentStatsDock({
  run,
  turns,
  subagents,
  subagentAccounts,
  accounts,
  sessionBilling = 'subscription',
  pricing = BUILTIN_PRICES,
  cliCost,
  modelMap,
  job,
  defaultOpen = true,
}: SubagentStatsDockProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  const running = run.status === 'running';

  // 运行中每秒刷新耗时
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  const params = runParams(run, subagents);
  const points = run.cache ?? [];

  const billing = useMemo(
    () => resolveSubagentBilling({ run, subagents, subagentAccounts, accounts, sessionBilling }),
    [run, subagents, subagentAccounts, accounts, sessionBilling],
  );

  const windowTokens = useMemo(
    () => resolveSubagentContextWindow({ run, cliCost, modelMap, fallbackModel: params.model }),
    [run, cliCost, modelMap, params.model],
  );

  const track = useMemo<UsageTrack>(
    () => ({
      points,
      window: windowTokens,
      breakdown: null,
      billing,
    }),
    [points, windowTokens, billing],
  );

  const accountText = resolveSubagentAccountText({ run, subagents, subagentAccounts });
  const startedAt = job?.startedAt ?? (run.turn.startedAt > 0 ? run.turn.startedAt : undefined);
  const endedAt = job?.endedAt ?? run.turn.endedAt;
  const durationMs = startedAt != null ? (running ? Math.max(0, now - startedAt) : endedAt != null ? Math.max(0, endedAt - startedAt) : null) : null;

  const metaItems = [
    prettyModel(params.model),
    effortText(params.effort),
    accountText,
    `${points.length} 次请求`,
    durationMs !== null ? formatDuration(durationMs) : '',
    STATUS_LABEL[run.status],
    run.subagentType,
    run.background && running ? '后台' : '',
    job && job.pending > 0 ? `排队 ${job.pending} 条` : '',
  ].filter(Boolean);

  const summary = metaItems.join(' · ');

  return (
    <section className={`cz-subdock${open ? ' is-open' : ''}`} aria-label="子代理用量统计">
      <button
        type="button"
        className="cz-subdock__head"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
        title={summary}
      >
        <Chevron open={open} size={13} />
        <span className="cz-subdock__meta">{summary}</span>
      </button>
      <div id={bodyId} className={`cz-subdock__wrap${open ? ' is-open' : ''}`} aria-hidden={!open}>
        <div className="cz-subdock__inner">
          <div className="cz-subdock__body">
            {points.length > 0 ? (
              <UsageBoard
                track={track}
                pricing={pricing}
                layout="dock"
                turns={turns}
                model={params.model}
              />
            ) : (
              <div className="cz-subdock__empty">
                {running ? '等待首次模型请求后显示用量统计…' : '暂无用量统计数据'}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
