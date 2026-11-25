// 出错轮下方的停止提示条：显示自动重试倒计时 / 失败或停止原因，以及立即重试 / 取消按钮。
import { memo } from 'react';
import type { StopInfo } from '@cosyee/shared';
import { formatStamp } from './format';
import './flow.css';

export interface StopNoticeProps {
  stop: StopInfo;
  onRetryNow?: () => void;
  onRetryCancel?: () => void;
  /** 当前时间（毫秒时间戳，主要用于测试跨天格式） */
  now?: number;
}

/** 单行化原因文本（压平换行与多余空白，省略号交给 CSS） */
function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export const StopNotice = memo(function StopNotice({ stop, onRetryNow, onRetryCancel, now }: StopNoticeProps) {
  // retrying 时新一轮已经开始，不再显示提示条
  if (stop.state === 'retrying') return null;

  const rawReason = stop.reason.trim();
  const reasonLine = singleLine(rawReason);

  let text = '';
  let title: string | undefined;

  if (stop.state === 'waiting') {
    const time = stop.retryAt != null ? formatStamp(stop.retryAt, now) : '';
    if (stop.kind === 'rate_limit') {
      text = time ? `已达额度上限 · ${time} 自动重试` : '已达额度上限 · 等待自动重试';
    } else {
      const nth = stop.attempts + 1;
      text = time ? `请求异常中断 · ${time} 自动重试（第 ${nth} 次）` : `请求异常中断 · 等待自动重试（第 ${nth} 次）`;
    }
    title = rawReason || text;
  } else if (stop.state === 'gave_up') {
    text = reasonLine ? `多次自动重试失败 · ${reasonLine}` : '多次自动重试失败';
    title = rawReason || text;
  } else {
    // stopped（fatal、interrupted 或用户取消自动重试）
    text = reasonLine || (stop.kind === 'interrupted' ? '服务重启，这一轮没有执行完' : '已停止自动重试');
    title = rawReason || text;
  }

  return (
    <div className={`cz-flow__stop is-${stop.state}${stop.kind === 'interrupted' ? ' is-interrupted' : ''}`} role="status">
      <span className="cz-flow__stop-dot" aria-hidden />
      <span className="cz-flow__stop-text" title={title}>
        {text}
      </span>
      <span className="cz-flow__stop-actions">
        {stop.state === 'waiting' ? (
          <>
            {onRetryNow && (
              <button type="button" className="cz-flow__stop-btn cz-flow__stop-btn--primary" onClick={onRetryNow}>
                立即重试
              </button>
            )}
            {onRetryCancel && (
              <button type="button" className="cz-flow__stop-btn" onClick={onRetryCancel}>
                取消
              </button>
            )}
          </>
        ) : (
          onRetryNow && (
            <button type="button" className="cz-flow__stop-btn cz-flow__stop-btn--primary" onClick={onRetryNow}>
              重试
            </button>
          )
        )}
      </span>
    </div>
  );
});
