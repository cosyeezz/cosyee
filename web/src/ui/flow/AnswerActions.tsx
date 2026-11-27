// 交付文字下方的操作行：朗读 / 复制 / 分支。
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { copyText } from '../../core/browser';
import { getState, speak, subscribe } from '../../core/speech/player';
import { Icon } from '../icons/Icon';
import { ForkButton } from './ForkButton';

export function AnswerActions({
  turnId,
  text,
  onFork,
}: {
  turnId: string;
  text: string;
  /** 从这条回复之后分支：stay=true 表示分支完留在当前会话；不传则不显示分支按钮 */
  onFork?: (stay: boolean) => void;
}) {
  const sp = useSyncExternalStore(subscribe, getState);
  const mine = sp.key === turnId;
  const phase = mine ? sp.phase : 'idle';
  const error = mine ? sp.error : undefined;
  const playing = phase === 'playing';
  const busy = phase !== 'idle';

  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onCopy = async () => {
    if (!(await copyText(text))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  };

  const label = busy ? '停止朗读' : '朗读';
  return (
    <div className="cz-flow__actions">
      <button
        type="button"
        className={`cz-flow__action${playing ? ' is-playing' : ''}`}
        title={label}
        aria-label={label}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => speak(turnId, text)} // speak 内部：同一条再点 = 停止
      >
        <Icon name={busy ? 'stop' : 'volume'} size={busy ? 12 : 15} />
      </button>
      <button
        type="button"
        className="cz-flow__action"
        title="复制"
        aria-label="复制"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void onCopy()}
      >
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
      {onFork && (
        <ForkButton
          onFork={onFork}
          className="cz-flow__action"
          iconSize={15}
          title="从这条回复分支"
          goNote="保留到这条回复，在新会话里接着聊"
          onMouseDown={(e) => e.preventDefault()}
        />
      )}
      {phase === 'downloading' && (
        <span className="cz-flow__action-hint">{sp.pct != null ? `下载语音模型 ${sp.pct}%` : '下载语音模型…'}</span>
      )}
      {phase === 'preparing' && <span className="cz-flow__action-hint">准备中…</span>}
      {error && <span className="cz-flow__action-hint is-error" title={error}>{error}</span>}
    </div>
  );
}

