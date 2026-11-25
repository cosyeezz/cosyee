// 子代理列表：每行一个子代理（状态图标 + 标题 + 后台标 + 运行中委派的停止按钮），点击打开子代理浮层。
import { memo } from 'react';
import type { SubagentRun } from '@cosyee/shared';
import { Icon, type IconName } from '../icons/Icon';
import { useDelegateActions } from './delegateContext';
import type { ActivityRun } from './sessionActivity';

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

const SubagentRow = memo(function SubagentRow({
  turnId,
  run,
  onOpenSubagent,
  onStop,
}: {
  turnId: string;
  run: SubagentRun;
  onOpenSubagent?: (turnId: string, toolUseId: string) => void;
  onStop?: (toolUseId: string) => void;
}) {
  return (
    <li className="cz-flow__agent-item">
      <button
        type="button"
        className="cz-flow__agent-row"
        title={`${run.title}（点击查看子代理会话）`}
        onClick={() => onOpenSubagent?.(turnId, run.toolUseId)}
      >
        <Icon name={SUBAGENT_ICON[run.status]} size={14} />
        <span className="cz-flow__agent-title">
          <span className={SUBAGENT_TITLE_CLASS[run.status]}>{run.title}</span>
        </span>
        {run.background && run.status === 'running' && <span className="cz-flow__ptag cz-flow__agent-bg">后台</span>}
      </button>
      {/* 执行中的委派：行尾停止按钮（与整行的按钮并列，不嵌套） */}
      {onStop && run.delegate === true && run.status === 'running' && (
        <button
          type="button"
          className="cz-flow__icon-btn cz-flow__agent-stop"
          aria-label="停止委派任务"
          title="停止"
          onClick={() => onStop(run.toolUseId)}
        >
          <Icon name="stop" size={12} />
        </button>
      )}
    </li>
  );
});

export const SubagentList = memo(function SubagentList({
  runs,
  onOpenSubagent,
}: {
  runs: readonly ActivityRun[];
  onOpenSubagent?: (turnId: string, toolUseId: string) => void;
}) {
  const delegate = useDelegateActions();
  return (
    <ul className="cz-flow__agents-list">
      {runs.map(({ turnId, run }) => (
        <SubagentRow
          key={run.toolUseId}
          turnId={turnId}
          run={run}
          onOpenSubagent={onOpenSubagent}
          onStop={delegate?.stop}
        />
      ))}
    </ul>
  );
});
