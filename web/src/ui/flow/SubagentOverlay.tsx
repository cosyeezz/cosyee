// 子代理浮层：右侧滑出的大面板，复用 TurnView 展示子代理自己的会话流。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SubagentRun } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { useMorph } from '../motion/morph';
import { SUBAGENT_TITLE_CLASS, TurnView } from './TurnView';
import { effortText, prettyModel } from './format';
import './status.css';
import { useStickToBottom } from './useStickToBottom';
import './flow.css';

const STATUS_ICON: Record<SubagentRun['status'], IconName> = { running: 'agent-running', done: 'done', error: 'error' };
const STATUS_LABEL: Record<SubagentRun['status'], string> = { running: '执行中', done: '已完成', error: '出错' };

export interface SubagentOverlayProps {
  run: SubagentRun | null;
  onClose: () => void;
  /** 主会话当前的思考等级：子代理未单独指定时显示为继承值 */
  sessionEffort?: string;
}

/** 面板主体：只在 run 存在时挂载，这样贴底逻辑的 ref 一定有值 */
function OverlayPanel({ run, onClose, sessionEffort }: { run: SubagentRun; onClose: () => void; sessionEffort?: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [taskOpen, setTaskOpen] = useState(true);
  useStickToBottom(scrollRef, contentRef);
  // 从被点击的子代理卡片原位展开，关闭时缩回那张卡片
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true });
  const close = useCallback(() => requestClose(onClose), [requestClose, onClose]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

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
              {[run.subagentType, prettyModel(run.model), effortText(run.effort, sessionEffort), STATUS_LABEL[run.status]]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          <button type="button" className="cz-flow__icon-btn" onClick={close} aria-label="关闭" title="关闭 (Esc)">
            <Icon name="close" size={16} />
          </button>
        </header>
        <div className="cz-flow__panel-scroll" ref={scrollRef}>
          <div className="cz-flow__panel-body" ref={contentRef}>
            <div className={`cz-flow__task${taskOpen ? ' is-open' : ''}`}>
              <button type="button" className="cz-flow__row-btn" aria-expanded={taskOpen} onClick={() => setTaskOpen((v) => !v)}>
                <span className="cz-flow__task-label">任务</span>
                <Icon name="chevron" size={16} open={taskOpen} className="cz-flow__chev" />
              </button>
              {taskOpen && <div className="cz-flow__task-body">{run.turn.userText}</div>}
            </div>
            <TurnView turn={run.turn} isSubagentView />
          </div>
        </div>
      </aside>
    </div>
  );
}

export function SubagentOverlay({ run, onClose, sessionEffort }: SubagentOverlayProps) {
  if (!run) return null;
  // 以 toolUseId 作 key：切换子代理时状态（任务区折叠、贴底）重置
  return <OverlayPanel key={run.toolUseId} run={run} onClose={onClose} sessionEffort={sessionEffort} />;
}
