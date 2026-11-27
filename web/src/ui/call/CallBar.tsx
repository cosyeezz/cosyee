// 通话条：通话模式下浮在输入框上方，显示两维状态（用户 / 对方），可以打断朗读、停止执行、挂断。
import type { CallState } from '../../core/speech/call';
import { Icon } from '../icons/Icon';
import './CallBar.css';

export interface CallBarProps {
  state: CallState;
  /** 有待你在屏幕上回答的问题 / 确认 */
  needsAttention?: boolean;
  /** 会话是否正在执行（即便同时在朗读，也允许点「停止执行」） */
  running?: boolean;
  onHangup: () => void;
  onSkip: () => void;
  onInterrupt: () => void;
}

function statusLabel(state: CallState, needsAttention?: boolean): string {
  if (state.phase === 'connecting') {
    if (state.note) return state.pct != null ? `${state.note} ${state.pct}%` : `${state.note}…`;
    return '正在接通…';
  }
  if (state.user === 'talking') return '你在说…';
  if (state.user === 'recognizing') return '识别中…';
  if (needsAttention) return '需要你在屏幕上确认';
  if (state.agent === 'speaking') return '正在说 · 开口即可打断';
  if (state.agent === 'working') return '执行中 · 可以随时插话';
  return '在听';
}

export function CallBar({ state, needsAttention, running, onHangup, onSkip, onInterrupt }: CallBarProps) {
  if (state.phase === 'off') return null;
  const { phase, agent, user } = state;
  const label = statusLabel(state, needsAttention);
  const visual =
    phase === 'connecting' ? 'connecting'
    : user === 'talking' ? 'talking'
    : user === 'recognizing' ? 'recognizing'
    : agent === 'speaking' ? 'speaking'
    : agent === 'working' ? 'working'
    : 'listening';
  const live = phase === 'active' && (visual === 'listening' || visual === 'talking' || visual === 'working');
  const canSkip = phase === 'active' && agent === 'speaking';
  const canStop = phase === 'active' && (agent === 'working' || (!!running && agent === 'speaking'));

  return (
    <div className={`cz-call cz-call--${visual}`} role="status" aria-live="polite">
      <span className={`cz-call__dot${live ? ' is-live' : ''}`} aria-hidden="true" />
      <div className="cz-call__text">
        <span className="cz-call__label">{label}</span>
        {phase === 'active' && state.heard && <span className="cz-call__heard">「{state.heard}」</span>}
        {state.error && phase !== 'connecting' && <span className="cz-call__error">{state.error}</span>}
      </div>
      {canSkip && (
        <button type="button" className="cz-call__btn" onClick={onSkip}>
          打断
        </button>
      )}
      {canStop && (
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
