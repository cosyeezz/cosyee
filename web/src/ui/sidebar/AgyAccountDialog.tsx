// 添加 Antigravity（agy）账号 / 重新登录：后端运行 agy acp --login，不打开本机浏览器，只给登录链接。
// 第 1 步打开或复制链接（可粘贴到无痕窗口登录另一个 Google 账号）；第 2 步粘贴授权码或回调后的完整网址。
// 授权码错误时 agy 会直接退出（status='failed'），提示旧链接已失效，可点「重新获取登录链接」保留已填备注名 / relogin 目标重新发起。
// 轮询遇到瞬时网络错误会继续按间隔重试，恢复后自动清除该提示；只有 404（登录不存在 / 已结束）才停止并转失败态。
// 只有点「取消」才会终止登录；重新打开能接续进行中的登录。所有关闭出口走 useMorph 的 requestClose。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AccountLogin } from '@cosyee/shared';
import { api, ApiError } from '../../core/api';
import { Icon } from '../icons/Icon';
import { useMorph } from '../motion/morph';
import { useFocusTrap } from './useFocusTrap';

export interface AgyAccountDialogProps {
  /** 重新登录的账号；不传 = 添加新账号 */
  relogin?: { id: string; title: string; active: boolean };
  /** 打开时已有进行中的登录：接着显示它 */
  resume?: AccountLogin | null;
  onClose: () => void;
  /** 登录成功（列表需要刷新） */
  onDone: (accountId: string | null) => void;
  /** 成功后点「用于新的委派任务」 */
  onSwitch: (accountId: string) => void;
  /** 顶部的「添加到」分段选择（添加新账号且未开始登录时显示） */
  targetSeg?: ReactNode;
  /** false = 不播入场（在添加对话框里切换分组时） */
  enter?: boolean;
}

const POLL_MS = 1000;
const VERIFY_POLL_MS = 350;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pending = (l: AccountLogin | null) => !!l && (l.status === 'starting' || l.status === 'waiting');

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 降级 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function AgyAccountDialog({ relogin, resume, onClose, onDone, onSwitch, targetSeg, enter }: AgyAccountDialogProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true, enter });
  useFocusTrap(panelRef);
  const close = (fn: () => void = onClose) => requestClose(fn);

  // 接续某个账号的重新登录时，即使未显式传 relogin 也保留其 accountId，确保标题与失败重试都指向原账号
  const reloginId = relogin?.id ?? (resume && pending(resume) && resume.accountId ? resume.accountId : null);
  const reloginTitle = relogin?.title ?? reloginId;

  const [label, setLabel] = useState('');
  const [login, setLogin] = useState<AccountLogin | null>(resume ?? null);
  /** 启动登录或提交授权码产生的错误（不会被轮询恢复清掉） */
  const [error, setError] = useState<string | null>(null);
  /** 轮询瞬时网络错误（下次轮询成功时自动清除） */
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [copied, setCopied] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const started = useRef(false);
  const doneFired = useRef(false);
  const labelRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const start = async () => {
    setBusy(true);
    setError(null);
    setPollError(null);
    setVerifying(false);
    setCode('');
    doneFired.current = false;
    try {
      const l = await api.startAgyLogin(reloginId ? { accountId: reloginId } : { label: label.trim() });
      setLogin(l);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  // 重新登录不需要填备注名：打开就开始
  useEffect(() => {
    if (started.current || resume) return;
    started.current = true;
    if (reloginId) void start();
    else labelRef.current?.focus();
  }, []);

  // 轮询进度：瞬时网络错误后继续按间隔重试，恢复后清掉 pollError；只有 404（登录不存在 / 已结束）才停止并进入失败态
  useEffect(() => {
    if (!login || !pending(login)) return;
    let alive = true;
    const waitMs = verifying && !pollError ? VERIFY_POLL_MS : POLL_MS;
    const t = window.setTimeout(() => {
      api.agyLogin(login.loginId).then(
        (next) => {
          if (!alive) return;
          setPollError(null);
          setLogin(next);
          if (!pending(next)) setVerifying(false);
        },
        (e) => {
          if (!alive) return;
          if (e instanceof ApiError && e.status === 404) {
            setPollError(null);
            setVerifying(false);
            setLogin((cur) => (cur ? { ...cur, status: 'failed', error: msg(e) || '登录不存在或已结束' } : cur));
          } else {
            setPollError(msg(e));
            setPollTick((n) => n + 1);
          }
        },
      );
    }, waitMs);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [login, verifying, pollError, pollTick]);

  useEffect(() => {
    if (login?.status === 'done' && !doneFired.current) {
      doneFired.current = true;
      onDone(login.accountId);
    }
  }, [login, onDone]);

  const cancel = () => {
    if (login && pending(login)) void api.cancelAgyLogin(login.loginId).catch(() => {});
    close();
  };

  const sendCode = async () => {
    if (!login || verifying || !code.trim()) return;
    setVerifying(true);
    setError(null);
    try {
      await api.submitAgyCode(login.loginId, code.trim());
      setPollTick((n) => n + 1);
    } catch (e) {
      setError(msg(e));
      setVerifying(false);
    }
  };

  const onCopyUrl = async () => {
    if (!login?.url) return;
    if (await copyText(login.url)) {
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    }
  };

  const title = reloginTitle ? `重新登录：${reloginTitle}` : '添加账号';
  let body: ReactNode;
  let buttons: ReactNode;

  if (!login) {
    body = reloginId ? (
      <p className="cz-acct-dlg__text">{busy ? '正在启动登录…' : '登录没有启动。'}</p>
    ) : (
      <>
        {targetSeg}
        <div className={`cz-acct-dlg__pane${enter === false ? ' cz-acct-dlg__swap' : ''}`}>
          <p className="cz-acct-dlg__text">
            点「登录」后会生成登录链接，可在无痕窗口中登录另一个 Google 账号，再把页面上的授权码粘贴回来。
          </p>
          <label className="cz-acct-dlg__field">
            <span>备注名（建议填写，用来区分账号）</span>
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
        </div>
      </>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={cancel}>取消</button>
        <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" disabled={busy} onClick={() => void start()}>
          {reloginId ? '重试' : '登录'}
        </button>
      </>
    );
  } else if (pending(login)) {
    body = login.status === 'starting' ? (
      <p className="cz-acct-dlg__text">正在启动登录…</p>
    ) : (
      <div className="cz-agy-steps">
        <div className="cz-agy-step">
          <div className="cz-agy-step__head">第 1 步：打开登录页完成 Google 授权</div>
          {login.url && (
            <div className="cz-agy-step__actions">
              <a
                href={login.url}
                target="_blank"
                rel="noreferrer noopener"
                className="cz-acct-dlg__btn cz-acct-dlg__btn--primary cz-agy-step__link"
              >
                打开登录页
              </a>
              <button type="button" className="cz-acct-dlg__btn cz-agy-step__copy" onClick={() => void onCopyUrl()}>
                <Icon name={copied ? 'check' : 'copy'} size={14} />
                <span>{copied ? '已复制' : '复制链接'}</span>
              </button>
            </div>
          )}
          <p className="cz-acct-dlg__text cz-acct-dlg__text--muted">
            可复制链接粘贴到无痕窗口，以登录另一个 Google 账号。
          </p>
        </div>

        <div className="cz-agy-step">
          <label className="cz-acct-dlg__field">
            <span className="cz-agy-step__head">第 2 步：粘贴授权码或完整网址</span>
            <span className="cz-acct-dlg__row">
              <input
                className="cz-acct-dlg__input"
                value={code}
                placeholder="授权码或回调后的完整网址"
                autoComplete="off"
                spellCheck={false}
                disabled={verifying}
                onChange={(e) => {
                  setCode(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !verifying && code.trim()) void sendCode();
                }}
              />
              <button
                type="button"
                className="cz-acct-dlg__btn cz-acct-dlg__btn--primary"
                disabled={verifying || !code.trim()}
                onClick={() => void sendCode()}
              >
                {verifying ? '正在验证…' : '提交'}
              </button>
            </span>
          </label>
        </div>
      </div>
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
          用于新的委派任务
        </button>
      </>
    );
  } else {
    body = (
      <>
        <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">
          登录失败：{login.error ?? '未知原因'}
        </p>
        <p className="cz-acct-dlg__text cz-acct-dlg__text--muted">
          旧的登录链接已失效，请重新获取登录链接后再授权。
        </p>
      </>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>关闭</button>
        <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" disabled={busy} onClick={() => void start()}>
          重新获取登录链接
        </button>
      </>
    );
  }

  return createPortal(
    <div ref={scrimRef} className="cz-acct-dlg__scrim cz-modal-scrim">
      <div ref={panelRef} className="cz-acct-dlg cz-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="cz-acct-dlg__title">{title}</div>
        {body}
        {error && <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">{error}</p>}
        {pollError && <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="status">读取登录进度失败：{pollError}</p>}
        <div className="cz-acct-dlg__btns">{buttons}</div>
      </div>
    </div>,
    document.body,
  );
}
