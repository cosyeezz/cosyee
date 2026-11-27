// 添加 OpenAI Codex 账号 / 重新登录：支持三种方式（设备码登录 / 浏览器登录 / API Key）。
// 默认方式根据是否远程访问（bootstrap.remote）决定：远程默认设备码，本机默认浏览器登录。
// API Key 提交后立即清空本地 state；设备码与浏览器登录轮询进度，瞬时错误继续重试，404 停止并转失败态。
// 只有点「取消」才会终止登录；重新打开可接续进行中的登录。所有关闭出口走 useMorph 的 requestClose。
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AccountLogin, CodexLoginMethod } from '@cosyee/shared';
import { api, ApiError } from '../../core/api';
import { Icon } from '../icons/Icon';
import { useMorph } from '../motion/morph';
import { useFocusTrap } from './useFocusTrap';

export interface CodexAccountDialogProps {
  /** 重新登录的账号；不传 = 添加新账号 */
  relogin?: { id: string; title: string; active: boolean };
  /** 打开时已有进行中的登录：接着显示它 */
  resume?: AccountLogin | null;
  /** 是否远程访问（bootstrap.remote）：远程默认设备码登录，本机默认浏览器登录 */
  remote?: boolean;
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
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pending = (l: AccountLogin | null | undefined): boolean =>
  !!l && (l.status === 'starting' || l.status === 'waiting');

const METHODS: { value: CodexLoginMethod; label: string; desc: string }[] = [
  { value: 'deviceAuth', label: '设备码登录', desc: '在任意设备的浏览器打开链接并输入验证码，适合远程访问' },
  { value: 'chatgpt', label: '浏览器登录', desc: '在本机浏览器用 ChatGPT 账号完成 OAuth 授权' },
  { value: 'apiKey', label: 'API Key', desc: '使用 OpenAI API Key 按量计费' },
];

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

export function CodexAccountDialog({
  relogin, resume, remote = false, onClose, onDone, onSwitch, targetSeg, enter,
}: CodexAccountDialogProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true, enter });
  useFocusTrap(panelRef);
  const close = (fn: () => void = onClose) => requestClose(fn);

  const reloginId = relogin?.id ?? (resume && pending(resume) && resume.accountId ? resume.accountId : null);
  const reloginTitle = relogin?.title ?? reloginId;

  const [method, setMethod] = useState<CodexLoginMethod>(() => resume?.method ?? (remote ? 'deviceAuth' : 'chatgpt'));
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [login, setLogin] = useState<AccountLogin | null>(resume ?? null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [pollTick, setPollTick] = useState(0);

  const doneFired = useRef(false);
  const codeCopyTimer = useRef<number | undefined>(undefined);
  const urlCopyTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    window.clearTimeout(codeCopyTimer.current);
    window.clearTimeout(urlCopyTimer.current);
  }, []);

  // 轮询进度：瞬时网络错误后继续按间隔重试，恢复后清掉 pollError；404 停止并进入失败态
  useEffect(() => {
    if (!login || !pending(login)) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.codexLogin(login.loginId).then(
        (next) => {
          if (!alive) return;
          setPollError(null);
          setLogin(next);
        },
        (e) => {
          if (!alive) return;
          if (e instanceof ApiError && e.status === 404) {
            setPollError(null);
            setLogin((cur) => (cur ? { ...cur, status: 'failed', error: msg(e) || '登录不存在或已结束' } : cur));
          } else {
            setPollError(msg(e));
            setPollTick((n) => n + 1);
          }
        },
      );
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [login, pollTick]);

  useEffect(() => {
    if (login?.status === 'done' && !doneFired.current) {
      doneFired.current = true;
      onDone(login.accountId);
    }
  }, [login, onDone]);

  const canSubmit = !busy && (method !== 'apiKey' || !!apiKey.trim());

  const start = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setPollError(null);
    doneFired.current = false;
    const key = method === 'apiKey' ? apiKey.trim() : undefined;
    // API Key 提交后立即清空 state，避免密钥留在内存 / 输入框里
    if (method === 'apiKey') setApiKey('');
    try {
      const payload: Parameters<typeof api.startCodexLogin>[0] = {
        method,
        ...(reloginId ? { accountId: reloginId } : { label: label.trim() }),
        ...(key ? { apiKey: key } : {}),
      };
      const l = await api.startCodexLogin(payload);
      setLogin(l);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (login && pending(login)) void api.cancelCodexLogin(login.loginId).catch(() => {});
    close();
  };

  const onCopyCode = async () => {
    if (!login?.userCode) return;
    if (await copyText(login.userCode)) {
      setCopiedCode(true);
      window.clearTimeout(codeCopyTimer.current);
      codeCopyTimer.current = window.setTimeout(() => setCopiedCode(false), 1800);
    }
  };

  const onCopyUrl = async () => {
    if (!login?.url) return;
    if (await copyText(login.url)) {
      setCopiedUrl(true);
      window.clearTimeout(urlCopyTimer.current);
      urlCopyTimer.current = window.setTimeout(() => setCopiedUrl(false), 1800);
    }
  };

  const onMethodKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1
      : 0;
    if (!dir) return;
    e.preventDefault();
    const cur = METHODS.findIndex((m) => m.value === method);
    const next = METHODS[(cur + dir + METHODS.length) % METHODS.length]!;
    setMethod(next.value);
    const btn = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-method="${next.value}"]`);
    btn?.focus();
  };

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && canSubmit) void start();
  };

  const title = reloginTitle ? `重新登录 Codex：${reloginTitle}` : '添加 Codex 账号';
  let body: ReactNode;
  let buttons: ReactNode;

  if (!login) {
    const submitLabel = busy
      ? '正在提交…'
      : method === 'apiKey'
        ? (reloginId ? '保存' : '添加')
        : '登录';
    body = (
      <>
        {!reloginId && targetSeg}
        <div className={`cz-acct-dlg__pane${enter === false ? ' cz-acct-dlg__swap' : ''}`}>
          <div className="cz-acct-dlg__field">
            <span>登录方式</span>
            <div className="cz-kiro-methods" role="radiogroup" aria-label="登录方式">
              {METHODS.map((m) => {
                const checked = method === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    data-method={m.value}
                    aria-checked={checked}
                    className={`cz-kiro-method${checked ? ' is-on' : ''}`}
                    onClick={() => {
                      setMethod(m.value);
                      if (error) setError(null);
                    }}
                    onKeyDown={onMethodKeyDown}
                  >
                    <span className="cz-kiro-method__head">
                      <span className="cz-kiro-method__label">{m.label}</span>
                    </span>
                    <span className="cz-kiro-method__desc">{m.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {method === 'chatgpt' && remote && (
            <div className="cz-kiro-warn" role="note">
              需在运行 Cosyee 的电脑上打开浏览器完成回调（127.0.0.1:1455）；远程设备建议改用「设备码登录」。
            </div>
          )}

          {!reloginId && (
            <label className="cz-acct-dlg__field">
              <span>备注名（可选）</span>
              <input
                className="cz-acct-dlg__input"
                value={label}
                maxLength={40}
                placeholder="例如：工作 / 个人"
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={onEnter}
              />
            </label>
          )}

          {method === 'apiKey' && (
            <label className="cz-acct-dlg__field">
              <span>OpenAI API Key</span>
              <input
                className="cz-acct-dlg__input"
                type="password"
                value={apiKey}
                maxLength={1000}
                placeholder="sk-…"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={onEnter}
              />
            </label>
          )}
        </div>
      </>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={cancel}>取消</button>
        <button
          type="button"
          className="cz-acct-dlg__btn cz-acct-dlg__btn--primary"
          disabled={!canSubmit}
          onClick={() => void start()}
        >
          {submitLabel}
        </button>
      </>
    );
  } else if (pending(login)) {
    const isDevice = login.method === 'deviceAuth' || !!login.userCode;
    body = login.status === 'starting' ? (
      <p className="cz-acct-dlg__text">正在启动登录…</p>
    ) : isDevice ? (
      <div className="cz-agy-steps">
        {login.userCode && (
          <div className="cz-agy-step">
            <div className="cz-agy-step__head">验证码</div>
            <div className="cz-kiro-code">
              <code className="cz-kiro-code__val">{login.userCode}</code>
              <button type="button" className="cz-acct-dlg__btn cz-agy-step__copy" onClick={() => void onCopyCode()}>
                <Icon name={copiedCode ? 'check' : 'copy'} size={14} />
                <span>{copiedCode ? '已复制' : '复制验证码'}</span>
              </button>
            </div>
          </div>
        )}
        <div className="cz-agy-step">
          <p className="cz-acct-dlg__text">
            请在任意设备的浏览器打开验证页并输入上方验证码，授权完成后此窗口会自动更新。
          </p>
          {login.url && (
            <div className="cz-agy-step__actions">
              <a
                href={login.url}
                target="_blank"
                rel="noreferrer noopener"
                className="cz-acct-dlg__btn cz-acct-dlg__btn--primary cz-agy-step__link"
              >
                打开验证页
              </a>
              <button type="button" className="cz-acct-dlg__btn cz-agy-step__copy" onClick={() => void onCopyUrl()}>
                <Icon name={copiedUrl ? 'check' : 'copy'} size={14} />
                <span>{copiedUrl ? '已复制' : '复制链接'}</span>
              </button>
            </div>
          )}
          <p className="cz-acct-dlg__text cz-acct-dlg__text--muted">
            若提示未开启设备码登录，请在 ChatGPT 设置 → 安全 中开启。
          </p>
        </div>
      </div>
    ) : (
      <div className="cz-agy-steps">
        <div className="cz-agy-step">
          <div className="cz-agy-step__head">在浏览器完成 ChatGPT 授权</div>
          {remote && (
            <div className="cz-kiro-warn" role="note">
              需在运行 Cosyee 的电脑上打开下方链接（回调地址 127.0.0.1:1455）。
            </div>
          )}
          <p className="cz-acct-dlg__text">
            {remote
              ? '请复制链接到运行 Cosyee 的电脑上打开并完成登录，授权完成后此窗口会自动更新。'
              : '请在浏览器中打开下方链接完成登录，授权完成后此窗口会自动更新。'}
          </p>
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
                <Icon name={copiedUrl ? 'check' : 'copy'} size={14} />
                <span>{copiedUrl ? '已复制' : '复制链接'}</span>
              </button>
            </div>
          )}
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
      <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">
        登录失败：{login.error ?? '未知原因'}
      </p>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>关闭</button>
        <button
          type="button"
          className="cz-acct-dlg__btn cz-acct-dlg__btn--primary"
          disabled={busy}
          onClick={() => {
            setError(null);
            setPollError(null);
            setLogin(null);
          }}
        >
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
        {error && <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">{error}</p>}
        {pollError && <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="status">读取登录进度失败：{pollError}</p>}
        <div className="cz-acct-dlg__btns">{buttons}</div>
      </div>
    </div>,
    document.body,
  );
}
