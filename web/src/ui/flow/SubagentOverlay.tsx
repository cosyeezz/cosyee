// 子代理浮层：右侧滑出的面板外壳，主体直接复用 ConversationView 与 SessionDock 展示单轮子代理会话。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DelegateJobInfo, DelegateSendMode, SubagentConfig, SubagentRun } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { useMorph } from '../motion/morph';
import { ConversationView } from './ConversationView';
import { SessionDock } from './SessionDock';
import { SUBAGENT_TITLE_CLASS } from './TurnView';
import { effortText, prettyModel, runParams } from './format';
import './status.css';
import './flow.css';

const STATUS_ICON: Record<SubagentRun['status'], IconName> = { running: 'agent-running', done: 'done', error: 'error' };
const STATUS_LABEL: Record<SubagentRun['status'], string> = { running: '执行中', done: '已完成', error: '出错' };

export interface SubagentOverlayProps {
  run: SubagentRun | null;
  onClose: () => void;
  /** 「子代理」设置：还不知道实际模型 / 思考等级时显示设置里的值 */
  subagents?: SubagentConfig | null;
  /** 本会话的委派任务快照：运行中的委派子代理按 toolUseId 在其中找到对应任务，才显示停止 / 追加消息 */
  delegates?: readonly DelegateJobInfo[];
  onDelegateStop?: (toolUseId: string) => void;
  onDelegateSend?: (toolUseId: string, text: string, mode: DelegateSendMode) => void;
}

/** 面板底部：给运行中的委派任务追加消息。Enter = 插话（steer，立即送进当前这一轮）；「排队」= 等当前这一轮做完再处理 */
function AppendBar({ onSend }: { onSend: (text: string, mode: DelegateSendMode) => void }) {
  const [text, setText] = useState('');
  const send = (mode: DelegateSendMode) => {
    const t = text.trim();
    if (!t) return;
    onSend(t, mode);
    setText('');
  };
  return (
    <form
      className="cz-flow__append"
      onSubmit={(e) => {
        e.preventDefault();
        send('steer');
      }}
    >
      <input
        className="cz-flow__append-input"
        type="text"
        value={text}
        placeholder="追加消息…"
        aria-label="追加消息"
        onChange={(e) => setText(e.target.value)}
      />
      <button type="button" className="cz-flow__append-btn" disabled={!text.trim()} onClick={() => send('queue')} title="排在当前这一轮之后处理">
        排队
      </button>
      <button type="submit" className="cz-flow__icon-btn cz-flow__append-send" disabled={!text.trim()} aria-label="发送（插话）" title="发送（Enter，立即插话）">
        <Icon name="send" size={16} />
      </button>
    </form>
  );
}

/** 面板主体：只在 run 存在时挂载，切换子代理时由外层 key 重置 */
function OverlayPanel({ run, onClose, subagents, delegates, onDelegateStop, onDelegateSend }: SubagentOverlayProps & { run: SubagentRun }) {
  const params = runParams(run, subagents);
  // 运行中的委派任务（有对应的任务快照）才能停止 / 追加消息
  const job = run.delegate === true && run.status === 'running' ? delegates?.find((j) => j.toolUseId === run.toolUseId) : undefined;
  const canStop = !!job && !!onDelegateStop;
  const canSend = !!job && !!onDelegateSend;
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
            <span className="cz-flow__panel-meta">
              {[
                run.subagentType,
                prettyModel(params.model),
                effortText(params.effort),
                STATUS_LABEL[run.status],
                run.background && run.status === 'running' ? '后台' : '',
                job && job.pending > 0 ? `排队 ${job.pending} 条` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
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
        {canSend && <AppendBar onSend={(text, mode) => onDelegateSend!(run.toolUseId, text, mode)} />}
      </aside>
    </div>
  );
}

export function SubagentOverlay({ run, onClose, subagents, delegates, onDelegateStop, onDelegateSend }: SubagentOverlayProps) {
  if (!run) return null;
  // 以 toolUseId 作 key：切换子代理时重置面板内部状态
  return <OverlayPanel key={run.toolUseId} run={run} onClose={onClose} subagents={subagents} delegates={delegates} onDelegateStop={onDelegateStop} onDelegateSend={onDelegateSend} />;
}
