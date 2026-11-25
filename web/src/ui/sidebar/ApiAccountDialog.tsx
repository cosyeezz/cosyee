// 添加 / 修改 API 账号：API Key + 可选的自定义 Base URL（第三方兼容服务 / 代理），不走 claude.ai 登录。
// 密钥只提交给本机服务端、存在该账号的私有配置目录里，之后不会再下发回来（修改时留空 = 不变）。
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { AccountApiInfo, ApiAuthType, ApiModelMap } from '@cosyee/shared';
import { api } from '../../core/api';
import { useMorph } from '../motion/morph';
import { useFocusTrap } from './useFocusTrap';
import { ModelMapTable } from './ModelMapTable';

export type AddKind = 'login' | 'api' | 'kiro';

/** 添加账号时的方式选择：claude.ai 登录 / API Key / Kiro（三个对话框顶部共用） */
export function AddKindSeg({ kind, onChange }: { kind: AddKind; onChange: (k: AddKind) => void }) {
  const opts: { kind: AddKind; label: string }[] = [
    { kind: 'login', label: 'Claude 账号登录' },
    { kind: 'api', label: 'API Key' },
    { kind: 'kiro', label: 'Kiro' },
  ];
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
      : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1
      : 0;
    if (!dir) return;
    e.preventDefault();
    const cur = opts.findIndex((o) => o.kind === kind);
    const next = opts[(cur + dir + opts.length) % opts.length]!;
    const btn = e.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-kind="${next.kind}"]`);
    btn?.focus();
    onChange(next.kind);
  };
  return (
    <div className="cz-sidebar__seg" role="radiogroup" aria-label="添加方式">
      {opts.map((o) => (
        <button
          key={o.kind}
          type="button"
          role="radio"
          data-kind={o.kind}
          aria-checked={kind === o.kind}
          className={`cz-sidebar__seg-btn${kind === o.kind ? ' is-on' : ''}`}
          onClick={() => kind !== o.kind && onChange(o.kind)}
          onKeyDown={onKeyDown}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const AUTH_OPTIONS: { type: ApiAuthType; label: string; tip: string }[] = [
  { type: 'apiKey', label: 'x-api-key', tip: 'ANTHROPIC_API_KEY：官方 API Key 用这个' },
  { type: 'authToken', label: 'Bearer', tip: 'ANTHROPIC_AUTH_TOKEN：多数第三方兼容服务 / 代理用这个' },
];

export interface ApiAccountDialogProps {
  /** 修改的账号；不传 = 添加 */
  edit?: { id: string; label: string; title: string; api: AccountApiInfo };
  onClose: () => void;
  /** 保存成功（列表需要刷新） */
  onDone: (accountId: string) => void;
  /** 添加成功后点「切换到该账号」 */
  onSwitch: (accountId: string) => void;
  /** 添加时改用其它方式 */
  onChangeKind?: (kind: AddKind) => void;
  /** 添加时改用 claude.ai 登录（旧回调，优先用 onChangeKind） */
  onUseLogin?: () => void;
  /** 顶部的「添加到」分组选择（添加新账号时显示） */
  targetSeg?: ReactNode;
  /** false = 不播入场（从 claude.ai 登录方式或分组切换过来时） */
  enter?: boolean;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 对话框内容区的滚动状态：上面滚走了内容 → 标题下画分隔线；下面还有内容 → 按钮栏上画分隔线 */
function useScrollEdges(ref: RefObject<HTMLElement>): { top: boolean; bottom: boolean } {
  const [edges, setEdges] = useState({ top: false, bottom: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const top = el.scrollTop > 1;
      const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setEdges((p) => (p.top === top && p.bottom === bottom ? p : { top, bottom }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(measure); };
    measure();
    el.addEventListener('scroll', schedule, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(schedule) : null;
    ro?.observe(el);
    for (const c of Array.from(el.children)) ro?.observe(c);
    return () => {
      el.removeEventListener('scroll', schedule);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);
  return edges;
}

export function ApiAccountDialog({ edit, onClose, onDone, onSwitch, onChangeKind, onUseLogin, targetSeg, enter }: ApiAccountDialogProps) {
  const changeKind = onChangeKind ?? (onUseLogin ? (k: AddKind) => { if (k === 'login') onUseLogin(); } : undefined);
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // 从触发它的按钮原位长出，关闭时缩回去；fn 在收回动画播完后执行
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true, enter });
  const close = (fn: () => void = onClose) => requestClose(fn);
  const [label, setLabel] = useState(edit?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(edit?.api.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [authType, setAuthType] = useState<ApiAuthType>(edit?.api.authType ?? 'apiKey');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 添加成功后的账号 id */
  const [added, setAdded] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const edges = useScrollEdges(bodyRef);
  useFocusTrap(panelRef);
  const errorRef = useRef<HTMLParagraphElement>(null);
  // 错误在长表单的最下面：出现时滚到能看见
  useEffect(() => {
    if (error) errorRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [error]);
  // 模型映射：全部留空时保存成 null（= 不介入）
  const [models, setModels] = useState<ApiModelMap>(edit?.api.models ?? {});
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchHint, setFetchHint] = useState<{ text: string; error: boolean } | null>(null);

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const canSave = !busy && (!!edit || !!apiKey.trim());

  const fetchModels = async () => {
    setFetching(true);
    setFetchHint(null);
    try {
      const r = await api.apiModelList({
        id: edit?.id,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        authType,
      });
      setModelOptions(r.models);
      setFetchHint({ text: `从 ${r.url} 拉到 ${r.models.length} 个模型。`, error: false });
    } catch (e) {
      setFetchHint({ text: msg(e), error: true });
    } finally {
      setFetching(false);
    }
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveApiAccount({
        id: edit?.id,
        label: label.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        authType,
        // 映射表是这个对话框里的唯一来源：一项都没填就显式清掉原来的映射
        models: Object.keys(models).length ? models : null,
      });
      onDone(r.id);
      if (edit) close();
      else setAdded(r.id);
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (e: KeyboardEvent) => {
    if (e.key === 'Enter') void save();
  };

  const title = edit ? `修改 API 账号：${edit.title}` : '添加账号';
  let body: ReactNode;
  let buttons: ReactNode;

  if (added) {
    body = <p className="cz-acct-dlg__text">已添加。</p>;
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>完成</button>
        <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" onClick={() => close(() => onSwitch(added))}>
          切换到该账号
        </button>
      </>
    );
  } else {
    body = (
      <>
        {!edit && targetSeg}
        {!edit && changeKind && <AddKindSeg kind="api" onChange={changeKind} />}
        <p className="cz-acct-dlg__text">
          用 API Key 调用模型，按量计费、没有订阅额度。Base URL 可以换成第三方兼容服务或代理的地址。skill、MCP、设置和会话历史与其它账号通用。
        </p>
        {/* 宽时两列：备注名 | Base URL，API Key | 认证方式（DOM 顺序 = 阅读顺序，Tab 也按这个走）；窄时一列 */}
        <div className="cz-acct-dlg__grid">
          <label className="cz-acct-dlg__field">
            <span>备注名（可选）</span>
            <input
              ref={firstRef}
              className="cz-acct-dlg__input"
              value={label}
              maxLength={40}
              placeholder="例如：官方 API / 公司代理"
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={onEnter}
            />
          </label>
          <label className="cz-acct-dlg__field">
            <span>Base URL（留空 = 官方地址）</span>
            <input
              className="cz-acct-dlg__input"
              value={baseUrl}
              maxLength={500}
              placeholder="https://api.anthropic.com"
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              onChange={(e) => setBaseUrl(e.target.value)}
              onKeyDown={onEnter}
            />
          </label>
          <label className="cz-acct-dlg__field">
            <span>API Key</span>
            <input
              className="cz-acct-dlg__input"
              type="password"
              value={apiKey}
              maxLength={1000}
              placeholder={edit ? `留空则不修改${edit.api.keyHint ? `（当前 …${edit.api.keyHint}）` : ''}` : 'sk-ant-…'}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={onEnter}
            />
          </label>
          <div className="cz-acct-dlg__field">
            <span>认证方式</span>
            <div className="cz-sidebar__seg" role="radiogroup" aria-label="认证方式">
              {AUTH_OPTIONS.map((o) => (
                <button
                  key={o.type}
                  type="button"
                  role="radio"
                  aria-checked={authType === o.type}
                  title={o.tip}
                  className={`cz-sidebar__seg-btn${authType === o.type ? ' is-on' : ''}`}
                  onClick={() => setAuthType(o.type)}
                >
                  {o.label}
                </button>
              ))}
            </div>
            <span>{AUTH_OPTIONS.find((o) => o.type === authType)!.tip}</span>
          </div>
        </div>
        <ModelMapTable
          value={models}
          onChange={setModels}
          options={modelOptions}
          onFetch={() => void fetchModels()}
          fetching={fetching}
          hint={fetchHint?.text ?? null}
          hintError={fetchHint?.error}
        />
      </>
    );
    buttons = (
      <>
        <button type="button" className="cz-acct-dlg__btn" onClick={() => close()}>取消</button>
        <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" disabled={!canSave} onClick={() => void save()}>
          {busy ? '正在保存…' : edit ? '保存' : '添加'}
        </button>
      </>
    );
  }

  return createPortal(
    <div ref={scrimRef} className="cz-acct-dlg__scrim cz-modal-scrim">
      <div
        ref={panelRef}
        className={`cz-acct-dlg cz-modal cz-acct-dlg--split${added ? '' : ' cz-acct-dlg--wide'}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* 标题和按钮栏固定，只有中间内容滚动：映射表很长时也随时能点保存 */}
        <div className={`cz-acct-dlg__title${edges.top ? ' is-scrolled' : ''}`}>{title}</div>
        <div ref={bodyRef} className="cz-acct-dlg__body">
          {body}
          {error && <p ref={errorRef} className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">{error}</p>}
        </div>
        <div className={`cz-acct-dlg__btns${edges.bottom ? ' is-scrolled' : ''}`}>{buttons}</div>
      </div>
    </div>,
    document.body,
  );
}
