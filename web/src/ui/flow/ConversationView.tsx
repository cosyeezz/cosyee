// 会话流：滚动容器 + 每轮（用户气泡 + TurnView），新内容到底时自动贴底。
// 未交付就被插话接上的几轮合成一组，只显示一个状态行，见 mergeSteer.ts。
// 本地命令（/compact、/model 等 CLI 自己处理、不产生模型回复的输入）整轮不渲染，见 isHiddenTurn。
import { memo, useCallback, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import type { StopInfo, Turn } from '@cosyee/shared';
import { canAnimate } from '../motion/reduced';
import { isHiddenTurn } from './format';
import { groupSteered, type TurnGroup } from './mergeSteer';
import { setFlowZoom, useFlowZoomControls } from './flowZoom';
import { ScrollNav } from './ScrollNav';
import { SelectionToolbar } from './SelectionToolbar';
import { StopNotice } from './StopNotice';
import { TurnView } from './TurnView';
import { UserMessage } from './UserMessage';
import { useStickToBottom } from './useStickToBottom';
import './flow.css';

export interface ConversationViewProps {
  turns: Turn[];
  /** 在答复里选中文字后点「回复」：quote 是选中的文字，reply 是弹层里输入的内容。不传则不出现选中浮条 */
  onReply?: (quote: string, reply: string) => void;
  /** 会话标识，变化时关闭选中浮条 */
  sessionKey?: string | null;
  /** 挂载时为 true：从加载骨架过渡过来，视口里的内容自上而下逐块浮现（只在挂载那一刻读取） */
  reveal?: boolean;
  /** 用户气泡的「分支」：targetId 是这条用户消息的 id，stay=true 表示分支完留在当前会话。不传则不显示分支按钮 */
  onFork?: (targetId: string, stay: boolean) => void;
  /** 渲染在内容列末尾的附加区域（不传则不渲染） */
  footer?: ReactNode;
  /** 会话因错误停止与自动重试状态（仅在最后一轮 status === 'error' 时展示） */
  stop?: StopInfo | null;
  /** 立即重试一次 */
  onRetryNow?: () => void;
  /** 取消自动重试 */
  onRetryCancel?: () => void;
}

/** 逐块浮现：每块间隔 60ms，淡入并上移 8px */
const REVEAL_STEP = 60;
const REVEAL_MAX = 12;
const REVEAL_BLOCKS = ':scope > .cz-flow__item > .cz-flow__user, :scope > .cz-flow__item > .cz-flow__turn > *';

function revealVisible(scroll: HTMLElement, column: HTMLElement) {
  // 先贴到底（useStickToBottom 也会做，但它在 useEffect 里，晚于这里），再挑出视口里的块
  scroll.scrollTop = scroll.scrollHeight;
  const view = scroll.getBoundingClientRect();
  const blocks = Array.from(column.querySelectorAll<HTMLElement>(REVEAL_BLOCKS)).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.bottom > view.top && r.top < view.bottom;
  });
  blocks.slice(-REVEAL_MAX).forEach((el, i) => {
    el.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], {
      duration: 380,
      delay: i * REVEAL_STEP,
      easing: 'cubic-bezier(.16, 1, .3, 1)',
      fill: 'backwards',
    });
  });
}

/** 一组（通常就是一轮）：按 group 对象引用比较，流式时只重渲染正在变化的那一组 */
const TurnItem = memo(function TurnItem({
  group,
  onFork,
  stop,
  onRetryNow,
  onRetryCancel,
}: {
  group: TurnGroup;
  /** 只给组里的第一条：后面的都是插话，不能分支 */
  onFork?: (stay: boolean) => void;
  stop?: StopInfo | null;
  onRetryNow?: () => void;
  onRetryCancel?: () => void;
}) {
  const { parts, turn } = group;
  return (
    // 合并的组带上全部轮 id：花费图按原来的轮跳转，用 ~= 匹配
    <section className="cz-flow__item" data-turn-id={parts.map((p) => p.id).join(' ')}>
      {parts.map((p, i) => (
        <UserMessage key={p.id} text={p.userText} attachments={p.attachments} onFork={i === 0 ? onFork : undefined} />
      ))}
      <TurnView turn={turn} />
      {stop && turn.status === 'error' && (
        <StopNotice stop={stop} onRetryNow={onRetryNow} onRetryCancel={onRetryCancel} />
      )}
    </section>
  );
});

export function ConversationView({
  turns: allTurns,
  onReply,
  sessionKey,
  reveal = false,
  onFork,
  footer,
  stop = null,
  onRetryNow,
  onRetryCancel,
}: ConversationViewProps) {
  // 本地命令轮不渲染；轮的下标仍按原数组计（压缩标记 / 花费图的跳转用的是 turn.id）
  const turns = useMemo(() => allTurns.filter((t) => !isHiddenTurn(t)), [allTurns]);
  const groups = useMemo(() => groupSteered(turns), [turns]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { pinToBottom, followIfStuck } = useStickToBottom(scrollRef, contentRef);

  useLayoutEffect(() => {
    const sc = scrollRef.current;
    const col = contentRef.current;
    if (reveal && sc && col && canAnimate(col)) revealVisible(sc, col);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 每次提交（流式文本增长等）后、绘制前同步贴底；ResizeObserver 负责图片 / 展开等异步高度变化
  useLayoutEffect(() => { followIfStuck(); });

  // 出现新的一轮（用户刚发出消息）：滚到底并恢复跟随
  const lastId = turns[turns.length - 1]?.id;
  const prevLastId = useRef(lastId);
  useLayoutEffect(() => {
    if (lastId !== prevLastId.current) {
      prevLastId.current = lastId;
      if (lastId !== undefined) pinToBottom('auto');
    }
  }, [lastId, pinToBottom]);

  // 回调稳定化，避免父组件每次传新函数导致所有轮重渲染
  const replyRef = useRef(onReply);
  replyRef.current = onReply;
  const stableReply = useCallback((quote: string, reply: string) => replyRef.current?.(quote, reply), []);

  // 每轮一个固定引用的分支回调（TurnItem 按引用比较，内联箭头函数会让所有轮重渲染）。
  // 可分支的轮：有 userId、不是插话（插话不是独立的一问）、也不是第一轮（它之前没有内容，服务端会拒）
  const forkRef = useRef(onFork);
  forkRef.current = onFork;
  const firstId = allTurns[0]?.id;
  const canFork = !!onFork;
  const forkCbs = useMemo(() => {
    const m = new Map<string, (stay: boolean) => void>();
    if (!canFork) return m;
    for (const t of turns) {
      if (!t.userId || t.steer || t.id === firstId) continue;
      const target = t.userId;
      m.set(t.id, (stay: boolean) => forkRef.current?.(target, stay));
    }
    return m;
  }, [turns, firstId, canFork]);

  const wrapRef = useRef<HTMLDivElement>(null);
  const { zoom, hint } = useFlowZoomControls(wrapRef, scrollRef, contentRef);

  return (
    <div className="cz-flow__wrap" ref={wrapRef} style={{ '--cz-flow-zoom': zoom } as CSSProperties}>
      <button
        type="button"
        className={`cz-flow__zoom${hint ? ' is-shown' : ''}`}
        onClick={() => setFlowZoom(1)}
        tabIndex={-1}
        aria-hidden={!hint}
        title="恢复默认字号（Ctrl + 0）"
      >
        {Math.round(zoom * 100)}%
      </button>
      <div className="cz-flow cz-flow__scroll" ref={scrollRef} tabIndex={-1}>
        {onReply && <SelectionToolbar scrollRef={scrollRef} resetKey={sessionKey} onReply={stableReply} />}
        <div className="cz-flow__column" ref={contentRef}>
          {groups.map((g, i) => {
            const isLast = i === groups.length - 1;
            return (
              <TurnItem
                key={g.turn.id}
                group={g}
                onFork={forkCbs.get(g.turn.id)}
                stop={isLast ? stop : null}
                onRetryNow={isLast ? onRetryNow : undefined}
                onRetryCancel={isLast ? onRetryCancel : undefined}
              />
            );
          })}
          {footer}
        </div>
      </div>
      <ScrollNav scrollRef={scrollRef} onJumpBottom={pinToBottom} />
    </div>
  );
}
