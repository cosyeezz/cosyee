// 会话流：滚动容器 + 每轮（用户气泡 + TurnView），新内容到底时自动贴底。
import { memo, useCallback, useLayoutEffect, useRef } from 'react';
import type { Turn } from '@cosyee/shared';
import { canAnimate } from '../motion/reduced';
import { ScrollNav } from './ScrollNav';
import { SelectionToolbar } from './SelectionToolbar';
import { TurnView } from './TurnView';
import { UserMessage } from './UserMessage';
import { useStickToBottom } from './useStickToBottom';
import './flow.css';

export interface ConversationViewProps {
  turns: Turn[];
  onOpenSubagent: (turnId: string, toolUseId: string) => void;
  /** 子代理浮层里复用时：不显示子代理面板与用户气泡 */
  isSubagentView?: boolean;
  /** 在答复里选中文字后点「回复」：quote 是选中的文字，reply 是弹层里输入的内容。不传则不出现选中浮条 */
  onReply?: (quote: string, reply: string) => void;
  /** 会话标识，变化时关闭选中浮条 */
  sessionKey?: string | null;
  /** 挂载时为 true：从加载骨架过渡过来，视口里的内容自上而下逐块浮现（只在挂载那一刻读取） */
  reveal?: boolean;
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

/** 单轮：按 turn 对象引用比较，流式时只重渲染正在变化的那一轮 */
const TurnItem = memo(function TurnItem({
  turn,
  onOpenSubagent,
  isSubagentView,
}: {
  turn: Turn;
  onOpenSubagent: (turnId: string, toolUseId: string) => void;
  isSubagentView?: boolean;
}) {
  return (
    <section className="cz-flow__item">
      {!isSubagentView && <UserMessage text={turn.userText} attachments={turn.attachments} />}
      <TurnView turn={turn} onOpenSubagent={onOpenSubagent} isSubagentView={isSubagentView} />
    </section>
  );
});

export function ConversationView({ turns, onOpenSubagent, isSubagentView, onReply, sessionKey, reveal = false }: ConversationViewProps) {
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
  const cbRef = useRef(onOpenSubagent);
  cbRef.current = onOpenSubagent;
  const stableOpen = useCallback((turnId: string, toolUseId: string) => cbRef.current(turnId, toolUseId), []);

  const replyRef = useRef(onReply);
  replyRef.current = onReply;
  const stableReply = useCallback((quote: string, reply: string) => replyRef.current?.(quote, reply), []);

  return (
    <div className="cz-flow__wrap">
      <div className="cz-flow cz-flow__scroll" ref={scrollRef} tabIndex={-1}>
        {onReply && <SelectionToolbar scrollRef={scrollRef} resetKey={sessionKey} onReply={stableReply} />}
        <div className="cz-flow__column" ref={contentRef}>
          {turns.map((t) => (
            <TurnItem key={t.id} turn={t} onOpenSubagent={stableOpen} isSubagentView={isSubagentView} />
          ))}
        </div>
      </div>
      <ScrollNav scrollRef={scrollRef} onJumpBottom={pinToBottom} />
    </div>
  );
}
