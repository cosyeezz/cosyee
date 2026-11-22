// 添加账号 / 重新登录：后端在后台运行 `claude auth login`，会自动打开浏览器；这里轮询进度。
// 浏览器没打开时给出登录页链接；浏览器回调失败时可以把页面上的授权码粘贴进来。
// 只有点「取消」才会终止登录（误点遮罩不会丢掉正在浏览器里进行的登录）。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AccountLogin } from '@cosyee/shared';
import { api } from '../../core/api';
import { useMorph } from '../motion/morph';
import { AddKindSeg } from './ApiAccountDialog';

export interface AccountDialogProps {
  /** 重新登录的账号；不传 = 添加新账号 */
  relogin?: { id: string; title: string; active: boolean };
  /** 打开时已有进行中的登录（之前关掉过对话框）：接着显示它 */
  resume?: AccountLogin | null;
  onClose: () => void;
  /** 登录成功（列表需要刷新） */
  onDone: (accountId: string | null) => void;
  /** 成功后点「切换到该账号」 */
  onSwitch: (accountId: string) => void;
  /** 添加时改用 API Key（还没开始登录时显示切换） */
  onUseApi?: () => void;
  /** false = 不播入场（从 API Key 方式切换过来时） */
  enter?: boolean;
}

const POLL_MS = 1000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pending = (l: AccountLogin | null) => !!l && (l.status === 'starting' || l.status === 'waiting');

export function AccountDialog({ relogin, resume, onClose, onDone, onSwitch, onUseApi, enter }: AccountDialogProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 从触发它的按钮原位长出，关闭时缩回去；fn 在收回动画播完后执行
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true, enter });
  const close = (fn: () => void = onClose) => requestClose(fn);
  const [label, setLabel] = useState('');
  const [login, setLogin] = useState<AccountLogin | null>(resume ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const started = useRef(false);
  const doneFired = useRef(false);
  const labelRef = useRef<HTMLInputElement>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    setCodeSent(false);
    setCode('');
    doneFired.current = false;
    try {
      const l = await api.startAccountLogin(relogin ? { accountId: relogin.id } : { label: label.trim() });
      setLogin(l);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  // 重新登录不需要填备注名：打开就开始（StrictMode 下 effect 会跑两次，用 ref 只启动一次）
  useEffect(() => {
    if (started.current || resume) return;
    started.current = true;
    if (relogin) void start();
    else labelRef.current?.focus();
  }, []);

  // 轮询进度
  useEffect(() => {
    if (!login || !pending(login)) return;
    const t = window.setTimeout(() => {
      api.accountLogin(login.loginId).then(setLogin, (e) => setError(msg(e)));
    }, POLL_MS);
    return () => window.clearTimeout(t);
  }, [login]);

  useEffect(() => {
    if (login?.status === 'done' && !doneFired.current) {
      doneFired.current = true;
      onDone(login.accountId);
    }
  }, [login, onDone]);

  const cancel = () => {
    if (login && pending(login)) void api.cancelAccountLogin(login.loginId).catch(() => {});
    close();
  };

  const sendCode = async () => {
    if (!login || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.submitAccountCode(login.loginId, code.trim());
      setCodeSent(true);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const title = relogin ? `重新登录：${relogin.title}` : '添加账号';
  let body: ReactNode;
  let buttons: ReactNode;

  if (!login) {
    // 填备注名（添加）或正在启动（重新登录）
    body = relogin ? (
      <p className="cz-acct-dlg__text">{busy ? '正在启动登录…' : '登录没有启动。'}</p>
    ) : (
      <>
        {onUseApi && <AddKindSeg kind="login" onChange={onUseApi} />}
        <p className="cz-acct-dlg__text">
          点「登录」后会打开浏览器，用另一个账号登录即可。skill、MCP、设置、CLAUDE.md 和会话历史所有账号通用。
        </p>
        <label className="cz-acct-dlg__field">
          <span>备注名（可选）</span>
          <input
            ref={labelRef}
            className="cz-acct-dlg__input"
            value={label}
            maxLength={40}
            placeholder="例如：工作 / 个人"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void start();
            }}
          />
        </label>
      </>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={cancel}>取消</button>
        <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" disabled={busy} onClick={() => void start()}>
          {relogin ? '重试' : '登录'}
        </button>
      </>
    );
  } else if (pending(login)) {
    body = (
      <>
        <p className="cz-acct-dlg__text">
          {login.status === 'starting' ? '正在启动登录…' : '已在浏览器中打开登录页，请在浏览器里完成登录。'}
        </p>
        {login.url && (
          <p className="cz-acct-dlg__text cz-acct-dlg__text--muted">
            浏览器没有打开？
            <a href={login.url} target="_blank" rel="noreferrer noopener">点此打开登录页</a>
          </p>
        )}
        {login.status === 'waiting' && (
          <label className="cz-acct-dlg__field">
            <span>浏览器里显示了授权码？粘贴到这里</span>
            <span className="cz-acct-dlg__row">
              <input
                className="cz-acct-dlg__input"
                value={code}
                placeholder="授权码"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setCode(e.target.value);
                  setCodeSent(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy) void sendCode();
                }}
              />
              <button type="button" className="cz-acct-dlg__btn" disabled={busy || !code.trim()} onClick={() => void sendCode()}>
                {codeSent ? '已提交' : '提交'}
              </button>
            </span>
          </label>
        )}
      </>
    );
    buttons = <button type="button" className="cz-acct-dlg__btn" onClick={cancel}>取消</button>;
  } else if (login.status === 'done') {
    body = <p className="cz-acct-dlg__text">登录成功。</p>;
    const id = login.accountId;
    buttons = relogin?.active || !id ? (
      <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" onClick={() => close()}>完成</button>
    ) : (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>完成</button>
        <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" onClick={() => close(() => onSwitch(id))}>
          切换到该账号
        </button>
      </>
    );
  } else {
    body = <p className="cz-acct-dlg__text cz-acct-dlg__text--error">登录失败：{login.error ?? '未知原因'}</p>;
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>关闭</button>
        <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" disabled={busy} onClick={() => void start()}>
          重试
        </button>
      </>
    );
  }

  return createPortal(
    <div ref={scrimRef} className="cz-acct-dlg__scrim cz-modal-scrim">
      <div ref={panelRef} className="cz-acct-dlg cz-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cz-acct-dlg__title">{title}</div>
        {body}
        {error && <p className="cz-acct-dlg__text cz-acct-dlg__text--error">{error}</p>}
        <div className="cz-acct-dlg__btns">{buttons}</div>
      </div>
    </div>,
    document.body,
  );
}
