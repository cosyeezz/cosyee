// 一轮回复：状态行 + 展开区 + 子代理面板 + 模型文字。
// 状态行措辞固定（正在处理 / 已完成 / 已中断 / 出错了），整行可点击展开；
// 下方只显示模型说的话（新的一段替换上一段），工具行只在展开区出现。
import { memo, useCallback, useEffect, useState } from 'react';
import type { SubagentRun, Turn } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { Markdown } from './Markdown';
import { NeuralIcon } from './NeuralIcon';
import { StepView } from './Steps';
import { getLiveText, getStatusLine, isTurnActive, subagentProgress, type StatusLine } from './format';
import './flow.css';
import './status.css';

const END_ICON: Record<Exclude<StatusLine['kind'], 'active'>, IconName> = {
  done: 'done',
  interrupted: 'stopped',
  error: 'error',
};

// 主短语文字特效（status.css）：进行中流光；完成 / 出错上色；中断保持原色
const STATUS_TEXT_CLASS: Record<StatusLine['kind'], string> = {
  active: 'cz-st cz-st-tool',
  done: 'cz-st cz-st-done',
  interrupted: 'cz-st',
  error: 'cz-st cz-st-error',
};

/** 进行中每秒刷新一次的当前时间；结束后停表 */
function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/** 状态行。单独成组件：每秒的计时只重渲染这一行，不碰下方的 Markdown */
const StatusRow = memo(function StatusRow({
  turn,
  expandable,
  open,
  onToggle,
}: {
  turn: Turn;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const active = isTurnActive(turn);
  const now = useTicker(active);
  const status = getStatusLine(turn, now);
  const content = (
    <>
      {status.kind === 'active' ? (
        <NeuralIcon size={20} className="cz-flow__status-icon" />
      ) : (
        <Icon name={END_ICON[status.kind]} size={20} className="cz-flow__status-icon" />
      )}
      <span className="cz-flow__status-text" title={status.title}>
        <span className={STATUS_TEXT_CLASS[status.kind]}>{status.text}</span>
        {status.meta && <span className="cz-st-meta"> · {status.meta}</span>}
      </span>
    </>
  );
  if (!expandable) {
    return (
      <div className="cz-flow__status" data-static="">
        {content}
      </div>
    );
  }
  return (
    <button type="button" className="cz-flow__status" aria-expanded={open} onClick={onToggle}>
      {content}
    </button>
  );
});

const SUBAGENT_ICON: Record<SubagentRun['status'], IconName> = {
  running: 'agent-running',
  done: 'done',
  error: 'error',
};

// 子代理标题文字特效：执行中流光（同状态行）；出错标红；完成保持正文色（图标已表示完成）
export const SUBAGENT_TITLE_CLASS: Record<SubagentRun['status'], string> = {
  running: 'cz-st-tool',
  done: '',
  error: 'cz-st-error',
};

const SubagentPanel = memo(function SubagentPanel({
  turnId,
  subagents,
  onOpenSubagent,
}: {
  turnId: string;
  subagents: SubagentRun[];
  onOpenSubagent?: (turnId: string, toolUseId: string) => void;
}) {
  const { total, finished, allDone } = subagentProgress(subagents);
  return (
    <div className="cz-flow__agents">
      <div className="cz-flow__agents-head">
        <Icon name={allDone ? 'done' : 'agent-running'} size={16} />
        <span>{allDone ? `${total} 个子代理已完成` : `${total} 个子代理执行中 ${finished}/${total}`}</span>
      </div>
      <ul className="cz-flow__agents-list">
        {subagents.map((s) => (
          <li key={s.toolUseId}>
            <button
              type="button"
              className="cz-flow__agent-row"
              title={`${s.title}（点击查看子代理会话）`}
              onClick={() => onOpenSubagent?.(turnId, s.toolUseId)}
            >
              <Icon name={SUBAGENT_ICON[s.status]} size={14} />
              <span className="cz-flow__agent-title">
                <span className={SUBAGENT_TITLE_CLASS[s.status]}>{s.title}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});

export interface TurnViewProps {
  turn: Turn;
  onOpenSubagent?: (turnId: string, toolUseId: string) => void;
  /** 子代理浮层里复用：不显示子代理面板 */
  isSubagentView?: boolean;
}

export const TurnView = memo(function TurnView({ turn, onOpenSubagent, isSubagentView }: TurnViewProps) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useCallback(() => setExpanded((v) => !v), []);
  const active = isTurnActive(turn);
  const expandable = turn.steps.length > 0;
  const open = expandable && expanded;
  // 折叠：answer 或最后一段文字；展开：只给 answer（其余文字已在展开区里）
  const live = getLiveText(turn, open);

  return (
    <div className={`cz-flow__turn is-${turn.status}`}>
      <StatusRow turn={turn} expandable={expandable} open={open} onToggle={toggle} />

      {open && (
        <div className="cz-flow__steps">
          {turn.steps.map((s, i) => (
            <StepView key={s.kind === 'tool' ? s.id : i} step={s} turnActive={active} />
          ))}
        </div>
      )}

      {!isSubagentView && turn.subagents.length > 0 && (
        <SubagentPanel turnId={turn.id} subagents={turn.subagents} onOpenSubagent={onOpenSubagent} />
      )}

      {live.text && (
        <Markdown
          text={live.text}
          className={`cz-flow__answer${active && live.isAnswer ? ' is-streaming' : ''}`}
        />
      )}
    </div>
  );
});
