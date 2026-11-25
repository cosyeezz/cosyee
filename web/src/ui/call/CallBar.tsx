// 通话条：通话模式下浮在输入框上方，显示现在在干什么，可以打断朗读、停止执行、挂断。
import type { CallState } from '../../core/speech/call';
import { Icon } from '../icons/Icon';
import './CallBar.css';

const LABEL: Record<Exclude<CallState['phase'], 'off'>, string> = {
  connecting: '正在接通…',
  listening: '请说话，说完停一下就会发送',
  hearing: '正在听…',
  recognizing: '识别中…',
  waiting: '执行中…',
  speaking: '正在朗读结果',
};

export interface CallBarProps {
  state: CallState;
  /** 有待你在屏幕上回答的问题 / 确认 */
  needsAttention?: boolean;
  onHangup: () => void;
  onSkip: () => void;
  onInterrupt: () => void;
}

export function CallBar({ state, needsAttention, onHangup, onSkip, onInterrupt }: CallBarProps) {
  if (state.phase === 'off') return null;
  const { phase } = state;
  let label = LABEL[phase];
  if (phase === 'connecting' && state.note) label = state.pct != null ? `${state.note} ${state.pct}%` : `${state.note}…`;
  if (phase === 'waiting' && needsAttention) label = '需要你在屏幕上确认';
  const live = phase === 'listening' || phase === 'hearing';
  return (
    <div className={`cz-call cz-call--${phase}`} role="status" aria-live="polite">
      <span className={`cz-call__dot${live ? ' is-live' : ''}`} aria-hidden="true" />
      <div className="cz-call__text">
        <span className="cz-call__label">{label}</span>
        {phase === 'waiting' && state.heard && <span className="cz-call__heard">「{state.heard}」</span>}
        {state.error && phase !== 'connecting' && <span className="cz-call__error">{state.error}</span>}
      </div>
      {phase === 'speaking' && (
        <button type="button" className="cz-call__btn" onClick={onSkip}>
          打断
        </button>
      )}
      {phase === 'waiting' && (
        <button type="button" className="cz-call__btn" onClick={onInterrupt}>
          停止执行
        </button>
      )}
      <button type="button" className="cz-call__btn cz-call__btn--hangup" onClick={onHangup} aria-label="挂断" title="挂断">
        <Icon name="phone" size={16} />
        挂断
      </button>
    </div>
  );
}
