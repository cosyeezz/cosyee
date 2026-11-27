// 子代理浮层：右侧滑出的面板外壳，主体复用 ConversationView 与 SessionDock 展示单轮子代理会话，
// 底部固定 SubagentStatsDock 展示与主会话统一的四块用量统计。
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type {
  AccountEntry, ApiModelMap, CliModelCost, DelegateJobInfo, PriceTable,
  SubagentAccountOption, SubagentConfig, SubagentRun, UsageBilling,
} from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { useMorph } from '../motion/morph';
import { ConversationView } from './ConversationView';
import { SessionDock } from './SessionDock';
import { SubagentStatsDock } from './SubagentStatsDock';
import { SUBAGENT_TITLE_CLASS } from './TurnView';
import './status.css';
import './flow.css';

const STATUS_ICON: Record<SubagentRun['status'], IconName> = { running: 'agent-running', done: 'done', error: 'error' };

export interface SubagentOverlayProps {
  run: SubagentRun | null;
  onClose: () => void;
  /** 「子代理」设置：还不知道实际模型 / 思考等级 / 委派路线时使用 */
  subagents?: SubagentConfig | null;
  /** 委派路线可选账号（展示账号名与后端） */
  subagentAccounts?: readonly SubagentAccountOption[];
  /** 主会话账号列表（用于判断 Claude 委派账号的计费方式） */
  accounts?: readonly AccountEntry[];
  /** 主会话的计费方式（原生子代理或查不到账号时兜底） */
  sessionBilling?: UsageBilling;
  /** 价格表（默认内置价格表） */
  pricing?: PriceTable;
  /** 本会话 CLI modelUsage（补全原生子代理上下文窗口） */
  cliCost?: readonly CliModelCost[];
  /** 主会话模型映射（判断 [1m] / m1） */
  modelMap?: ApiModelMap | null;
  /** 本会话的委派任务快照：运行中的委派子代理按 toolUseId 找到对应任务，显示停止按钮与耗时/排队信息 */
  delegates?: readonly DelegateJobInfo[];
  onDelegateStop?: (toolUseId: string) => void;
}

/** 面板主体：只在 run 存在时挂载，切换子代理时由外层 key 重置 */
function OverlayPanel({
  run,
  onClose,
  subagents,
  subagentAccounts,
  accounts,
  sessionBilling,
  pricing,
  cliCost,
  modelMap,
  delegates,
  onDelegateStop,
}: SubagentOverlayProps & { run: SubagentRun }) {
  // 运行中的委派任务（有对应的任务快照）才能停止
  const job = run.delegate === true ? delegates?.find((j) => j.toolUseId === run.toolUseId) : undefined;
  const canStop = run.status === 'running' && !!job && !!onDelegateStop;
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const turns = useMemo(() => [run.turn], [run.turn]);
  // 从被点击的子代理卡片原位展开，关闭时缩回那张卡片
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true });
  const close = useCallback(() => requestClose(onClose), [requestClose, onClose]);

  // Esc 关闭（已被内层弹层处理过的事件不再触发）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const noRecord =
    run.delegate === true && run.status !== 'running' && run.turn.steps.length === 0 ? (
      <div className="cz-flow__no-record">{run.turn.answer ? '没有其它执行过程' : '没有执行过程记录'}</div>
    ) : undefined;

  return (
    <div
      ref={scrimRef}
      className="cz-flow cz-flow__overlay"
      role="presentation"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <aside ref={panelRef} className="cz-flow__panel" role="dialog" aria-modal="true" aria-label={run.title}>
        <header className="cz-flow__panel-head">
          <Icon name={STATUS_ICON[run.status]} size={18} />
          <div className="cz-flow__panel-title">
            <span className="cz-flow__panel-name" title={run.title}>
              <span className={SUBAGENT_TITLE_CLASS[run.status]}>{run.title}</span>
            </span>
          </div>
          {canStop && (
            <button type="button" className="cz-flow__head-btn" onClick={() => onDelegateStop!(run.toolUseId)} title="停止这个委派任务">
              <Icon name="stop" size={12} />
              停止
            </button>
          )}
          <button type="button" className="cz-flow__icon-btn" onClick={close} aria-label="关闭" title="关闭 (Esc)">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="cz-flow__panel-flow">
          <ConversationView
            turns={turns}
            sessionKey={run.toolUseId}
            footer={<>{noRecord}<SessionDock turns={turns} sessionKey={run.toolUseId} /></>}
          />
        </div>
        <SubagentStatsDock
          run={run}
          turns={turns}
          subagents={subagents}
          subagentAccounts={subagentAccounts}
          accounts={accounts}
          sessionBilling={sessionBilling}
          pricing={pricing}
          cliCost={cliCost}
          modelMap={modelMap}
          job={job}
        />
      </aside>
    </div>
  );
}

export function SubagentOverlay(props: SubagentOverlayProps) {
  if (!props.run) return null;
  // 以 toolUseId 作 key：切换子代理时重置面板内部状态
  return <OverlayPanel key={props.run.toolUseId} {...props} run={props.run} />;
}
