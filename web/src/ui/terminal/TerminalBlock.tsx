// 单条命令执行块：提示符行、截断提示、ANSI 输出、运行状态与计时页脚、悬停操作栏。
import { memo, useEffect, useRef, useState } from 'react';
import type { TermBlock } from '@cosyee/shared';
import { copyText } from '../../core/browser';
import { stripAnsi } from '../../core/terminalAnsi';
import { Icon } from '../icons/Icon';
import { TerminalAnsiView } from './TerminalAnsiView';
import { formatDuration, shortCwd } from './terminalUtil';

export interface TerminalBlockProps {
  block: TermBlock;
  root: string;
  platform: string;
  /** 固定当前时间（预览页截图用，避免计时跳动） */
  fixedNowMs?: number;
  onRerun: (cmd: string) => void;
  onStop: (id: string) => void;
}

export const TerminalBlock = memo(function TerminalBlock({
  block,
  root,
  platform,
  fixedNowMs,
  onRerun,
  onStop,
}: TerminalBlockProps) {
  const [copied, setCopied] = useState<'cmd' | 'out' | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [now, setNow] = useState(() => fixedNowMs ?? Date.now());

  const isRunning = block.state === 'running';

  useEffect(() => {
    if (!isRunning || fixedNowMs !== undefined) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [isRunning, fixedNowMs]);

  useEffect(() => () => {
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
  }, []);

  const doCopy = async (kind: 'cmd' | 'out') => {
    const text = kind === 'cmd' ? block.cmd : stripAnsi(block.output);
    if (!text) return;
    if (!(await copyText(text))) return;
    setCopied(kind);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => {
      copyTimer.current = null;
      setCopied(null);
    }, 1500);
  };

  const elapsed = (block.endedAt ?? now) - block.startedAt;
  const dirLabel = shortCwd(block.cwd, root);
  const promptGlyph = platform === 'win32' && (block.shell === 'cmd' || block.shell === 'powershell' || block.shell === 'pwsh') ? '>' : '❯';
  const failed = block.state === 'error' || (block.state === 'done' && block.exitCode != null && block.exitCode !== 0);
  const stateCls =
    isRunning
      ? ' is-running'
      : block.state === 'stopped'
        ? ' is-stopped'
        : failed
          ? ' is-failed'
          : ' is-ok';

  return (
    <article className={`cz-term-block${stateCls}`} data-block-id={block.id}>
      {isRunning && <div className="cz-term-block__beam" aria-hidden="true" />}

      <div className="cz-term-block__head">
        <div className="cz-term-block__prompt">
          <span className="cz-term-block__dir" title={block.cwd}>{dirLabel}</span>
          <span className="cz-term-block__shell">{block.shell}</span>
          <span className="cz-term-block__glyph" aria-hidden="true">{promptGlyph}</span>
          <code className="cz-term-block__cmd">{block.cmd}</code>
        </div>

        <div className="cz-term-block__acts">
          {isRunning && (
            <button
              type="button"
              className="cz-term-block__act is-danger"
              title="停止运行"
              aria-label="停止运行"
              onClick={() => onStop(block.id)}
            >
              <Icon name="stop" size={12} />
              <span>停止</span>
            </button>
          )}
          <button
            type="button"
            className={`cz-term-block__act${copied === 'cmd' ? ' is-copied' : ''}`}
            title={copied === 'cmd' ? '已复制命令' : '复制命令'}
            aria-label="复制命令"
            onClick={() => void doCopy('cmd')}
          >
            <Icon name={copied === 'cmd' ? 'check' : 'copy'} size={13} />
          </button>
          {block.output.length > 0 && (
            <button
              type="button"
              className={`cz-term-block__act${copied === 'out' ? ' is-copied' : ''}`}
              title={copied === 'out' ? '已复制输出' : '复制输出'}
              aria-label="复制输出"
              onClick={() => void doCopy('out')}
            >
              <Icon name={copied === 'out' ? 'check' : 'file'} size={13} />
            </button>
          )}
          <button
            type="button"
            className="cz-term-block__act"
            title="重新执行"
            aria-label="重新执行"
            onClick={() => onRerun(block.cmd)}
          >
            <Icon name="play" size={12} />
          </button>
        </div>
      </div>

      {block.truncated && (
        <div className="cz-term-block__trunc" role="note">
          <Icon name="info" size={12} />
          <span>输出过长，只保留最后部分</span>
        </div>
      )}

      {block.output.length > 0 && <TerminalAnsiView output={block.output} />}

      <footer className="cz-term-block__foot">
        {isRunning ? (
          <span className="cz-term-block__status is-running">
            <span className="cz-term-block__dot" aria-hidden="true" />
            <span>运行中</span>
          </span>
        ) : block.state === 'stopped' ? (
          <span className="cz-term-block__status is-stopped">
            <Icon name="stopped" size={13} />
            <span>已停止</span>
          </span>
        ) : block.state === 'error' ? (
          <span className="cz-term-block__status is-failed">
            <Icon name="error" size={13} />
            <span>启动失败{block.exitCode != null ? ` (${block.exitCode})` : ''}</span>
          </span>
        ) : block.exitCode != null && block.exitCode !== 0 ? (
          <span className="cz-term-block__status is-failed">
            <Icon name="error" size={13} />
            <span>退出码 {block.exitCode}</span>
          </span>
        ) : (
          <span className="cz-term-block__status is-ok">
            <Icon name="check" size={13} />
            <span>完成</span>
          </span>
        )}
        <span className="cz-term-block__dur">{formatDuration(elapsed)}</span>
      </footer>
    </article>
  );
});
