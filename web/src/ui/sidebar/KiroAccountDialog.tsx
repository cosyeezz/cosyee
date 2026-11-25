// 添加 / 重新登录 Kiro 账号：通过本机 kiro.rs 服务（ZyphrZero/kiro.rs 预编译版本）把 Claude Code 接到 Kiro 订阅。
// 没有引擎时先下载 kiro.rs；已有引擎时选择登录方式（AWS Builder ID / IAM Identity Center / 从 Kiro IDE 或 CLI 导入 / Kiro API Key）。
// 设备码登录给出验证码与登录页链接并轮询进度；只有点「取消」才会终止登录。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AccountLogin, ComponentStatus, KiroLoginMethod, KiroStatus } from '@cosyee/shared';
import { api, ApiError } from '../../core/api';
import { Icon } from '../icons/Icon';
import { useMorph } from '../motion/morph';
import { AddKindSeg, type AddKind } from './ApiAccountDialog';
import { useFocusTrap } from './useFocusTrap';

export interface KiroAccountDialogProps {
  /** 重新登录的账号；不传 = 添加新账号 */
  relogin?: { id: string; title: string; active: boolean };
  /** 打开时已有进行中的登录（来自 KiroStatus.login）：接着显示它 */
  resume?: AccountLogin | null;
  onClose: () => void;
  /** 登录成功（列表需要刷新） */
  onDone: (accountId: string | null) => void;
  /** 成功后点「切换到该账号」 */
  onSwitch: (accountId: string) => void;
  /** 添加时切换其它方式（Claude 账号登录 / API Key） */
  onChangeKind?: (kind: AddKind) => void;
  /** 顶部的「添加到」分组选择（添加新账号且未开始登录时显示） */
  targetSeg?: ReactNode;
  /** false = 不播入场（从其它方式或分组切换过来时） */
  enter?: boolean;
}

const POLL_MS = 1000;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const pending = (l: AccountLogin | null | undefined): boolean =>
  !!l && (l.status === 'starting' || l.status === 'waiting');

const METHODS: { value: KiroLoginMethod; label: string; desc: string }[] = [
  { value: 'builderId', label: 'AWS Builder ID', desc: '通过设备码在浏览器登录个人 AWS Builder ID' },
  { value: 'idc', label: 'IAM Identity Center', desc: '填写企业 Start URL 与 Region 进行设备码登录' },
  { value: 'kiroIde', label: '从 Kiro IDE 导入', desc: '复用本机 Kiro IDE 已有的登录凭据' },
  { value: 'kiroCli', label: '从 Kiro CLI 导入', desc: '复用本机 kiro-cli 已有的登录凭据' },
  { value: 'apiKey', label: 'Kiro API Key', desc: '使用 ksk_… 格式的 API Key' },
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

export function KiroAccountDialog({
  relogin, resume, onClose, onDone, onSwitch, onChangeKind, targetSeg, enter,
}: KiroAccountDialogProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true, enter });
  useFocusTrap(panelRef);
  const close = (fn: () => void = onClose) => requestClose(fn);

  const reloginId = relogin?.id ?? (resume && pending(resume) && resume.accountId ? resume.accountId : null);
  const reloginTitle = relogin?.title ?? reloginId;

  const [status, setStatus] = useState<KiroStatus | null>(null);
  /** 组件列表里的 kiro.rs（是否已装、安装进度） */
  const [comp, setComp] = useState<ComponentStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [login, setLogin] = useState<AccountLogin | null>(resume ?? null);
  const [method, setMethod] = useState<KiroLoginMethod>('builderId');
  const [label, setLabel] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollTick, setPollTick] = useState(0);
  const [buildTick, setBuildTick] = useState(0);
  const [copied, setCopied] = useState(false);

  const doneFired = useRef(false);
  const copyTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);

  const loadStatus = useCallback(() => {
    setStatusLoading(true);
    setStatusError(null);
    // 组件列表读不到不挡登录：只是看不到「未安装」的提示
    Promise.all([api.kiroStatus(), api.components().catch(() => null)]).then(
      ([s, c]) => {
        setStatus(s);
        setComp(c?.list.find((x) => x.id === 'kiro') ?? null);
        setStatusLoading(false);
        if (pending(s.login)) {
          setLogin((cur) => cur ?? s.login);
        }
      },
      (e) => {
        setStatusError(msg(e));
        setStatusLoading(false);
      },
    );
  }, []);

  useEffect(() => {
    loadStatus();
  }, [loadStatus]);

  // kiro.rs 安装中：轮询组件状态
  const buildRunning = comp?.job?.state === 'running';
  useEffect(() => {
    if (!buildRunning) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.components().then(
        (list) => {
          if (!alive) return;
          setPollError(null);
          const next = list.list.find((x) => x.id === 'kiro') ?? null;
          setComp(next);
          if (next?.job?.state === 'running') setBuildTick((n) => n + 1);
        },
        (e) => {
          if (!alive) return;
          setPollError(msg(e));
          setBuildTick((n) => n + 1);
        },
      );
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [buildRunning, buildTick]);

  // 设备码登录轮询：瞬时网络错误重试，404 进入失败态
  useEffect(() => {
    if (!login || !pending(login)) return;
    let alive = true;
    const t = window.setTimeout(() => {
      api.kiroLoginStatus(login.loginId).then(
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

  const startBuild = async () => {
    setBusy(true);
    setError(null);
    setPollError(null);
    try {
      setComp(await api.updateComponent('kiro'));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const methodDisabled = (m: KiroLoginMethod): boolean => {
    if (!status) return false;
    if (m === 'kiroIde') return !status.imports.kiroIde;
    if (m === 'kiroCli') return !status.imports.kiroCli;
    return false;
  };

  const canSubmit = !busy
    && !methodDisabled(method)
    && (method !== 'idc' || !!startUrl.trim())
    && (method !== 'apiKey' || !!apiKey.trim());

  const startLogin = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setPollError(null);
    doneFired.current = false;
    try {
      const payload: Parameters<typeof api.kiroLogin>[0] = {
        method,
        ...(reloginId ? { accountId: reloginId } : { label: label.trim() }),
      };
      if (method === 'idc') {
        payload.startUrl = startUrl.trim();
        payload.region = region.trim() || 'us-east-1';
      }
      if (method === 'apiKey') {
        payload.apiKey = apiKey.trim();
      }
      const l = await api.kiroLogin(payload);
      if (method === 'apiKey') setApiKey('');
      setLogin(l);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    if (login && pending(login)) void api.kiroLoginCancel(login.loginId).catch(() => {});
    close();
  };

  const onCopyCode = async () => {
    if (!login?.userCode) return;
    if (await copyText(login.userCode)) {
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1800);
    }
  };

  const onMethodKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1
      : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1
      : 0;
    if (!dir) return;
    e.preventDefault();
    const enabled = METHODS.filter((m) => !methodDisabled(m.value));
    if (!enabled.length) return;
    const cur = enabled.findIndex((m) => m.value === method);
    const next = enabled[(cur + dir + enabled.length) % enabled.length]!;
    setMethod(next.value);
    const btn = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-method="${next.value}"]`);
    btn?.focus();
  };

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && canSubmit) void startLogin();
  };

  const title = reloginTitle ? `重新登录 Kiro：${reloginTitle}` : '添加账号';
  let body: ReactNode;
  let buttons: ReactNode;

  if (login && pending(login)) {
    body = login.status === 'starting' ? (
      <p className="cz-acct-dlg__text">正在启动登录…</p>
    ) : (
      <div className="cz-agy-steps">
        {login.userCode && (
          <div className="cz-agy-step">
            <div className="cz-agy-step__head">验证码</div>
            <div className="cz-kiro-code">
              <code className="cz-kiro-code__val">{login.userCode}</code>
              <button type="button" className="cz-acct-dlg__btn cz-agy-step__copy" onClick={() => void onCopyCode()}>
                <Icon name={copied ? 'check' : 'copy'} size={14} />
                <span>{copied ? '已复制' : '复制验证码'}</span>
              </button>
            </div>
          </div>
        )}
        <div className="cz-agy-step">
          <p className="cz-acct-dlg__text">
            请在浏览器中打开登录页{login.userCode ? '，核对上方验证码' : ''}并完成授权，授权完成后此窗口会自动更新。
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
            </div>
          )}
        </div>
      </div>
    );
    buttons = <button type="button" className="cz-acct-dlg__btn" onClick={cancel}>取消</button>;
  } else if (login?.status === 'done') {
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
  } else if (login?.status === 'failed') {
    body = <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">登录失败：{login.error ?? '未知原因'}</p>;
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
  } else if (statusLoading && !status) {
    body = (
      <>
        {!reloginId && targetSeg}
        <div className={`cz-acct-dlg__pane${enter === false ? ' cz-acct-dlg__swap' : ''}`}>
          {!reloginId && onChangeKind && <AddKindSeg kind="kiro" onChange={onChangeKind} />}
          <p className="cz-acct-dlg__text">正在检查 kiro.rs 引擎状态…</p>
        </div>
      </>
    );
    buttons = <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>取消</button>;
  } else if (statusError && !status) {
    body = (
      <>
        {!reloginId && targetSeg}
        <div className={`cz-acct-dlg__pane${enter === false ? ' cz-acct-dlg__swap' : ''}`}>
          {!reloginId && onChangeKind && <AddKindSeg kind="kiro" onChange={onChangeKind} />}
          <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">读取 Kiro 状态失败：{statusError}</p>
        </div>
      </>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>关闭</button>
        <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" onClick={loadStatus}>重试</button>
      </>
    );
  } else if (status && comp && !comp.installed) {
    const isBuilding = comp.job?.state === 'running';
    const failed = comp.job?.state === 'failed';
    const disabled = busy || isBuilding;
    body = (
      <>
        {!reloginId && targetSeg}
        <div className={`cz-acct-dlg__pane${enter === false ? ' cz-acct-dlg__swap' : ''}`}>
          {!reloginId && onChangeKind && <AddKindSeg kind="kiro" onChange={onChangeKind} />}
          <p className="cz-acct-dlg__text">
            使用 Kiro 账号需要先下载 kiro.rs：将从 ZyphrZero/kiro.rs 的 GitHub Release 下载预编译包并校验 SHA256，无需本机编译。
          </p>
          {isBuilding && (
            <p className="cz-acct-dlg__text" role="status">
              正在下载 kiro.rs…
            </p>
          )}
          {failed && (
            <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">
              下载失败：{comp.job?.error ?? '未知错误'}
            </p>
          )}
        </div>
      </>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>取消</button>
        <button
          type="button"
          className="cz-acct-dlg__btn cz-acct-dlg__btn--primary"
          disabled={disabled}
          onClick={() => void startBuild()}
        >
          {isBuilding ? '正在下载…' : failed ? '重试下载' : '下载 kiro.rs'}
        </button>
      </>
    );
  } else {
    const isImport = method === 'kiroIde' || method === 'kiroCli';
    const submitLabel = busy
      ? '正在提交…'
      : isImport
        ? '导入'
        : method === 'apiKey'
          ? (reloginId ? '保存' : '添加')
          : '登录';
    body = (
      <>
        {!reloginId && targetSeg}
        <div className={`cz-acct-dlg__pane${enter === false ? ' cz-acct-dlg__swap' : ''}`}>
          {!reloginId && onChangeKind && <AddKindSeg kind="kiro" onChange={onChangeKind} />}
          {status && !status.service.enabled && (
            <div className="cz-kiro-warn" role="note">
              kiro.rs 服务已停止，请先到客户端的「组件」里启动。
            </div>
          )}
          <p className="cz-acct-dlg__text">
            通过本机 kiro.rs 服务将 Claude Code 接入你的 Kiro 订阅。使用 Google / GitHub 登录的用户，请先在 Kiro IDE 或运行 <code>kiro-cli login</code> 登录后选择导入。
          </p>
          <div className="cz-acct-dlg__field">
            <span>登录方式</span>
            <div className="cz-kiro-methods" role="radiogroup" aria-label="登录方式">
              {METHODS.map((m) => {
                const dis = methodDisabled(m.value);
                const checked = method === m.value;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    data-method={m.value}
                    aria-checked={checked}
                    disabled={dis}
                    className={`cz-kiro-method${checked ? ' is-on' : ''}`}
                    onClick={() => !dis && setMethod(m.value)}
                    onKeyDown={onMethodKeyDown}
                  >
                    <span className="cz-kiro-method__head">
                      <span className="cz-kiro-method__label">{m.label}</span>
                      {dis && <span className="cz-kiro-method__miss">未找到本机登录</span>}
                    </span>
                    <span className="cz-kiro-method__desc">{m.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {!reloginId && (
            <label className="cz-acct-dlg__field">
              <span>备注名（可选）</span>
              <input
                className="cz-acct-dlg__input"
                value={label}
                maxLength={40}
                placeholder="例如：Kiro 个人 / 工作"
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={onEnter}
              />
            </label>
          )}

          {method === 'idc' && (
            <>
              <label className="cz-acct-dlg__field">
                <span>Start URL</span>
                <input
                  className="cz-acct-dlg__input"
                  value={startUrl}
                  maxLength={500}
                  placeholder="https://d-xxxxxxxxxx.awsapps.com/start"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                  onChange={(e) => setStartUrl(e.target.value)}
                  onKeyDown={onEnter}
                />
              </label>
              <label className="cz-acct-dlg__field">
                <span>Region</span>
                <input
                  className="cz-acct-dlg__input"
                  value={region}
                  maxLength={64}
                  placeholder="us-east-1"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setRegion(e.target.value)}
                  onKeyDown={onEnter}
                />
              </label>
            </>
          )}

          {isImport && (
            <div className="cz-kiro-warn" role="note">
              导入后两边共用同一个登录，刷新令牌可能使 Kiro IDE / CLI 需要重新登录
            </div>
          )}

          {method === 'apiKey' && (
            <label className="cz-acct-dlg__field">
              <span>Kiro API Key</span>
              <input
                className="cz-acct-dlg__input"
                type="password"
                value={apiKey}
                maxLength={1000}
                placeholder="ksk_…"
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={onEnter}
              />
            </label>
          )}
        </div>
      </>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>取消</button>
        <button
          type="button"
          className="cz-acct-dlg__btn cz-acct-dlg__btn--primary"
          disabled={!canSubmit}
          onClick={() => void startLogin()}
        >
          {submitLabel}
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
        {pollError && <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="status">读取进度失败：{pollError}</p>}
        <div className="cz-acct-dlg__btns">{buttons}</div>
      </div>
    </div>,
    document.body,
  );
}
