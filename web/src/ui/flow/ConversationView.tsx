// 会话流：滚动容器 + 每轮（用户气泡 + TurnView），新内容到底时自动贴底。
import { memo, useCallback, useRef } from 'react';
import type { Turn } from '@cosyee/shared';
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

export function ConversationView({ turns, onOpenSubagent, isSubagentView, onReply, sessionKey }: ConversationViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const { pinToBottom } = useStickToBottom(scrollRef, contentRef);

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
