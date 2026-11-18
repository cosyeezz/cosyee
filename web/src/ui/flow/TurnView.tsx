// 一轮回复：状态行 + 展开区 + 子代理面板 + 模型文字。
// 状态行只由「模型有没有文本、最近一段文本是什么」决定（见 format.ts 的 getStatusLine）：
//   没有文本 → 星轨 + 「正在理解问题」；有文本 → 神经脉冲 + 最近一段文本（单行省略号）；
//   结束 → 完成 / 中断 / 出错图标 + 「已完成 · 14:32 · 共 N 步 · 用时 18 秒」。
// 整行可点击展开；展开后状态行吸顶，点击吸顶的行收起并滚回原位。工具行只在展开区出现。
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import type { SubagentRun, Turn } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { Markdown } from './Markdown';
import { NeuralIcon } from './NeuralIcon';
import { CompactingIcon, DoneIcon, ErrorIcon, OrbitIcon, StoppedIcon } from './StatusIcons';
import { StepView } from './Steps';
import { getLiveText, getStatusLine, isTurnActive, subagentProgress, type StatusLine } from './format';
import './flow.css';
import './status.css';

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
  // 头部：液滴图标 + 紫粉慢速流光；全部完成后动画停下（文字不变）
  return (
    <div className="cz-flow__agents">
      <div className="cz-flow__agents-head">
        <CompactingIcon size={16} className={allDone ? 'is-still' : undefined} />
        <span className={allDone ? undefined : 'cz-st cz-st-compacting'}>
          {allDone ? `${total} 个子代理已完成` : `${total} 个子代理执行中 ${finished}/${total}`}
        </span>
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

  // 进行中：最近一段文字已在首行显示，下方只给正在写的 answer；
  // 结束后折叠：answer 或最后一段文字；展开：只给 answer（其余文字已在展开区里）
  const live = getLiveText(turn, open, active);

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
