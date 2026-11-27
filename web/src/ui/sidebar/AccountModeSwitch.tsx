// 账号菜单顶部（第一个账号上方）的模式切换：分段选择，不是开关。
// 切换模式（默认）：同一时间只用一个账号；并行模式：每个会话用自己的账号，多个账号可以同时运行。
// 回到切换模式时，其它账号有执行中的会话会被拦下，确认后强制切换（停止它们并整页刷新）。
import { useRef, useState, type KeyboardEvent } from 'react';
import type { AccountMode } from '@cosyee/shared';
import { api, ApiError } from '../../core/api';
import { GooeyIndicator } from '../motion/GooeyIndicator';
import { accountPage } from './AccountMenu';

export interface AccountModeSwitchProps {
  /** 当前模式；null = 还没读到 */
  mode: AccountMode | null;
  /** 切到并行模式成功（不刷新页面）：让菜单重读账号列表 */
  onChanged: () => void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const OPTIONS: { mode: AccountMode; label: string; tip: string }[] = [
  { mode: 'switch', label: '切换模式', tip: '同一时间只用一个账号，换账号时停止执行中的会话' },
  { mode: 'parallel', label: '并行模式', tip: '每个会话用自己的账号，多个账号可以同时运行' },
];

export function AccountModeSwitch({ mode, onChanged }: AccountModeSwitchProps) {
  const [busy, setBusy] = useState(false);
  /** 回到切换模式被执行中的会话拦下：执行中的数量 */
  const [confirm, setConfirm] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 点下去就先把选中块移过去（乐观），失败或被拦下时退回；读到新模式后清掉 */
  const [pending, setPending] = useState<AccountMode | null>(null);
  if (pending !== null && pending === mode) setPending(null);
  const shown = pending ?? mode;
  const btnRefs = useRef<Partial<Record<AccountMode, HTMLButtonElement | null>>>({});

  const apply = async (next: AccountMode, force = false) => {
    if (busy || next === mode) return;
    setBusy(true);
    setError(null);
    setConfirm(null);
    setPending(next);
    try {
      await api.setAccountMode(next, force);
      // 回到切换模式：其它账号的进程已停，整页刷新让所有信息都回到当前账号
      if (next === 'switch') accountPage.reload();
      else onChanged();
    } catch (e) {
      setPending(null);
      if (e instanceof ApiError && e.status === 409 && typeof e.data.running === 'number') setConfirm(e.data.running);
      else setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const focusMode: AccountMode = shown ?? OPTIONS[0].mode;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (busy || mode === null) return;
    let next: AccountMode | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      next = focusMode === 'switch' ? 'parallel' : 'switch';
    } else if (e.key === 'Home') {
      next = 'switch';
    } else if (e.key === 'End') {
      next = 'parallel';
    }
    if (!next) return;
    e.preventDefault();
    btnRefs.current[next]?.focus();
    void apply(next);
  };

  return (
    <div className="cz-sidebar__mode">
      <div className="cz-sidebar__seg" role="radiogroup" aria-label="账号模式" onKeyDown={onKeyDown}>
        <GooeyIndicator activeKey={shown} selector=".cz-sidebar__seg-btn.is-on" />
        {OPTIONS.map((o) => {
          const on = mode === o.mode;
          return (
            <button
              key={o.mode}
              ref={(el) => { btnRefs.current[o.mode] = el; }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={focusMode === o.mode ? 0 : -1}
              title={o.tip}
              className={`cz-sidebar__seg-btn${shown === o.mode ? ' is-on' : ''}`}
              disabled={busy || mode === null}
              onClick={() => void apply(o.mode)}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {confirm !== null && (
        <div className="cz-sidebar__acct-confirm" role="alert">
          <div className="cz-sidebar__confirm-text">
            其它账号有 {confirm} 个会话正在执行，切回切换模式会停止它们。
          </div>
          <div className="cz-sidebar__confirm-btns">
            <button type="button" className="cz-sidebar__confirm-btn" onClick={() => setConfirm(null)}>取消</button>
            <button
              type="button"
              className="cz-sidebar__confirm-btn cz-sidebar__confirm-btn--danger"
              onClick={() => void apply('switch', true)}
            >
              强制切换
            </button>
          </div>
        </div>
      )}
      {error && <div className="cz-sidebar__acct-note cz-sidebar__acct-note--error">{error}</div>}
    </div>
  );
}
