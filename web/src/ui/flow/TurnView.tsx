// 一轮回复：状态行 + 展开区 + 模型文字（子代理 / 技能 / MCP 面板移至会话流末尾的 SessionDock 展示）。
// 状态行只由模型最近一次「输出」决定，委派子代理与文字同等对待、谁新显示谁（见 format.ts 的 getStatusLine）：
//   没有输出 → 星轨 + 「正在理解问题」；
//   有输出 → 神经脉冲 + 最近一段文本或「委派子代理：…」（单行省略号）；
//   结束 → 完成 / 中断 / 出错图标 + 「已完成 · 14:32 · 共 N 步 · 用时 18 秒」。
// 整行可点击展开；展开后状态行吸顶，点击吸顶的行收起并滚回原位。工具行只在展开区出现。
// 状态行下方只放交付：执行中不显示任何正文（过程全部在状态行与展开区里），回合结束才出现最终答复（见 getLiveText）。
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { Turn } from '@cosyee/shared';
import { AnswerActions } from './AnswerActions';
import { Markdown } from './Markdown';
import { NeuralIcon } from './NeuralIcon';
import { DoneIcon, ErrorIcon, OrbitIcon, StoppedIcon } from './StatusIcons';
import { StepView } from './Steps';
import { getLiveText, getStatusLine, isTurnActive, type StatusLine } from './format';
import './flow.css';
import './status.css';

export { SUBAGENT_TITLE_CLASS } from './SubagentList';

const STATUS_SIZE = 20;

function statusIcon(status: StatusLine): ReactNode {
  const className = 'cz-flow__status-icon';
  switch (status.kind) {
    case 'active':
      return status.phase === 'text' ? (
        <NeuralIcon size={STATUS_SIZE} className={className} />
      ) : (
        <OrbitIcon size={STATUS_SIZE} className={className} />
      );
    case 'done':
      return <DoneIcon size={STATUS_SIZE} className={className} />;
    case 'interrupted':
      return <StoppedIcon size={STATUS_SIZE} className={className} />;
    case 'error':
      return <ErrorIcon size={STATUS_SIZE} className={className} />;
  }
}

// 主短语文字特效（status.css）：理解中三色流光；有文本时青色流光；完成 / 出错上色；中断变淡
function statusTextClass(status: StatusLine): string {
  switch (status.kind) {
    case 'active':
      return status.phase === 'text' ? 'cz-st cz-st-tool' : 'cz-st cz-st-thinking';
    case 'done':
      return 'cz-st cz-st-done';
    case 'interrupted':
      return 'cz-st cz-st-stopped';
    case 'error':
      return 'cz-st cz-st-error';
  }
}

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
  rowRef,
}: {
  turn: Turn;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
  rowRef: RefObject<HTMLElement>;
}) {
  const active = isTurnActive(turn);
  const now = useTicker(active);
  const status = getStatusLine(turn, now);
  const content = (
    <>
      {statusIcon(status)}
      <span className="cz-flow__status-text" title={status.title}>
        <span className={`${statusTextClass(status)} cz-flow__status-main`}>{status.text}</span>
        {status.meta && <span className="cz-st-meta">{` · ${status.meta}`}</span>}
      </span>
    </>
  );
  if (!expandable) {
    return (
      <div ref={rowRef as RefObject<HTMLDivElement>} className="cz-flow__status" data-static="">
        {content}
      </div>
    );
  }
  return (
    <button
      ref={rowRef as RefObject<HTMLButtonElement>}
      type="button"
      className={`cz-flow__status${open ? ' is-open' : ''}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      {content}
    </button>
  );
});

export interface TurnViewProps {
  turn: Turn;
}

export const TurnView = memo(function TurnView({ turn }: TurnViewProps) {
  const [expanded, setExpanded] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLElement>(null);
  const active = isTurnActive(turn);
  const expandable = turn.steps.length > 0;
  const open = expandable && expanded;
  const openRef = useRef(open);
  openRef.current = open;
  // 收起时首行若已被顶出视口（吸顶状态），收起后要把它滚回视口
  const scrollBack = useRef(false);
  const toggle = useCallback(() => {
    if (openRef.current) {
      const turnEl = rootRef.current;
      const sc = turnEl?.closest('.cz-flow__scroll');
      if (turnEl && sc && turnEl.getBoundingClientRect().top < sc.getBoundingClientRect().top - 1) {
        scrollBack.current = true;
      }
    }
    setExpanded((v) => !v);
  }, []);
  useLayoutEffect(() => {
    if (open || !scrollBack.current) return;
    scrollBack.current = false;
    // 瞬时滚动：内容刚收缩，平滑滚动会与自动贴底互相抢滚动条
    rowRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
  }, [open]);

  // 交付文字：执行中为空，回合结束（或只剩后台任务）才出现（见 getLiveText）
  const delivered = getLiveText(turn, open);

  return (
    <div ref={rootRef} className={`cz-flow__turn is-${turn.status}`}>
      <StatusRow turn={turn} expandable={expandable} open={open} onToggle={toggle} rowRef={rowRef} />

      {open && (
        <div className="cz-flow__steps">
          {turn.steps.map((s, i) => (
            <StepView key={s.kind === 'tool' ? s.id : i} step={s} turnActive={active} />
          ))}
        </div>
      )}

      {delivered && <Markdown text={delivered} className="cz-flow__answer" />}
      {delivered && (!active || turn.awaitingBackground) && <AnswerActions turnId={turn.id} text={delivered} />}
    </div>
  );
});
