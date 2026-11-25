// 账号菜单里的「本机组件」：Claude CLI、kiro.rs、Antigravity CLI、Cosyee 服务端的版本、检查更新、立即更新和自动更新开关。
// 写操作只允许本机连接（服务端对非本机返回 403），非本机时按钮置灰并提示「仅本机可操作」。
// 有更新任务在跑时每秒轮询状态并追加更新日志；cosyee 服务端自己不能在运行中替换自己，由桌面客户端更新。
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ComponentId, ComponentStatus } from '@cosyee/shared';
import { api } from '../../core/api';
import { useMorph } from '../motion/morph';
import { formatRelativeTime } from './formatTime';
import { useFocusTrap } from './useFocusTrap';
import './ComponentsDialog.css';

export interface ComponentsDialogProps {
  onClose: () => void;
}

const POLL_MS = 1000;
const LOG_SHOWN = 12;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Tone = 'ok' | 'warn' | 'error' | 'plain';

/** 一个组件当前的状态标签；优先级：更新任务 > 没安装 > 自定义 > 检查失败 > 有新版 > 已是最新 */
export function componentStatusLabel(c: ComponentStatus): { tone: Tone; text: string } {
  if (c.job?.state === 'running') return { tone: 'warn', text: '正在更新…' };
  if (c.job?.state === 'failed') return { tone: 'error', text: '更新失败' };
  if (!c.installed) return { tone: 'plain', text: '未安装' };
  if (c.custom) return { tone: 'plain', text: '自定义路径，不自动更新' };
  if (c.updateAvailable) {
    return c.pending
      ? { tone: 'warn', text: '有新版本，等任务结束后自动更新' }
      : { tone: 'warn', text: '有新版本' };
  }
  if (c.checkError) return { tone: 'error', text: '检查失败' };
  if (c.latest) return { tone: 'ok', text: '已是最新' };
  return { tone: 'plain', text: '还没检查过' };
}

function ComponentCard({
  c, local, busy, error, log, onCheck, onUpdate, onAuto,
}: {
  c: ComponentStatus;
  local: boolean;
  busy: boolean;
  error: string | null;
  log: string[];
  onCheck: () => void;
  onUpdate: () => void;
  onAuto: () => void;
}) {
  const label = componentStatusLabel(c);
  const running = c.job?.state === 'running';
  const lock = !local || busy || running;
  const clientUpdate = c.updatedBy === 'client';
  const shownLog = log.slice(-LOG_SHOWN);
  return (
    <div className="cz-comp" data-component={c.id}>
      <div className="cz-comp__head">
        <span className="cz-comp__name">{c.name}</span>
        <span className={`cz-comp__tag cz-comp__tag--${label.tone}`} data-role="status">{label.text}</span>
      </div>
      <p className="cz-comp__meta">
        <span>当前版本 <b>{c.version ?? '—'}</b></span>
        <span>最新版本 <b>{c.latest ?? '—'}</b></span>
        <span>{c.checkedAt ? `上次检查 ${formatRelativeTime(c.checkedAt)}` : '还没检查过'}</span>
      </p>
      {c.checkError && !c.custom && (
        <p className="cz-comp__note cz-comp__note--error" role="note">检查失败：{c.checkError}</p>
      )}
      {c.job?.state === 'failed' && (
        <p className="cz-comp__note cz-comp__note--error" role="note">更新失败：{c.job.error ?? '未知错误'}</p>
      )}
      {c.busy > 0 && c.updateAvailable && !c.custom && (
        <p className="cz-comp__note">有 {c.busy} 个任务正在使用，更新会等它们结束</p>
      )}
      {error && <p className="cz-comp__note cz-comp__note--error" role="alert">{error}</p>}
      <div className="cz-comp__acts">
        <button type="button" className="cz-acct-dlg__btn" disabled={lock} onClick={onCheck}>检查更新</button>
        {clientUpdate ? (
          <span className="cz-comp__note">由桌面客户端更新</span>
        ) : (
          <button
            type="button"
            className="cz-acct-dlg__btn cz-acct-dlg__btn--primary"
            disabled={lock || !c.installed || c.custom || !c.updateAvailable}
            onClick={onUpdate}
          >
            立即更新
          </button>
        )}
        <span className="cz-comp__auto">
          自动更新
          <button
            type="button"
            role="switch"
            aria-checked={c.autoUpdate}
            aria-label={`${c.name}自动更新`}
            className={`cz-comp__switch${c.autoUpdate ? ' is-on' : ''}`}
            disabled={!local || busy || c.custom}
            onClick={onAuto}
          />
        </span>
      </div>
      {shownLog.length > 0 && (running || c.job?.state === 'failed') && (
        <pre className="cz-comp__log" aria-label={`${c.name}更新日志`}>{shownLog.join('\n')}</pre>
      )}
    </div>
  );
}

export function ComponentsDialog({ onClose }: ComponentsDialogProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true });
  useFocusTrap(panelRef);

  const [list, setList] = useState<ComponentStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** null = 还没读到；true = 经远程访问，写操作都不可用 */
  const [remote, setRemote] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<Partial<Record<ComponentId, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<ComponentId, string>>>({});
  const [logs, setLogs] = useState<Partial<Record<ComponentId, string[]>>>({});
  const logNext = useRef<Partial<Record<ComponentId, number>>>({});
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    api.components().then(
      (r) => alive && setList(r.list),
      (e) => alive && setLoadError(msg(e)),
    );
    api.bootstrap().then(
      (b) => alive && setRemote(!!b.remote),
      () => alive && setRemote(true),
    );
    return () => { alive = false; };
  }, []);

  const replace = useCallback((s: ComponentStatus) => {
    setList((l) => (l ? l.map((x) => (x.id === s.id ? s : x)) : l));
  }, []);

  /** 拉一次日志增量并追加到该组件的日志里 */
  const pullLog = useCallback(async (id: ComponentId) => {
    const r = await api.componentLog(id, logNext.current[id] ?? 0);
    logNext.current[id] = r.next;
    if (r.lines.length) setLogs((m) => ({ ...m, [id]: [...(m[id] ?? []), ...r.lines] }));
  }, []);

  // 有更新任务在跑：每秒读一次状态，并读运行中（以及刚结束）任务的日志
  const runningIds = (list ?? []).filter((c) => c.job?.state === 'running').map((c) => c.id);
  const running = runningIds.length > 0;
  const runningKey = runningIds.join(',');
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const t = window.setTimeout(() => {
      void (async () => {
        try {
          const next = await api.components();
          if (!alive) return;
          const ids = new Set<ComponentId>([
            ...(runningKey ? (runningKey.split(',') as ComponentId[]) : []),
            ...next.list.filter((c) => c.job?.state === 'running').map((c) => c.id),
          ]);
          await Promise.all([...ids].map((id) => pullLog(id).catch(() => {})));
          if (!alive) return;
          setList(next.list);
        } catch {
          /* 瞬时失败：下一轮再读 */
        } finally {
          if (alive) setTick((n) => n + 1);
        }
      })();
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [running, runningKey, tick, pullLog]);

  const act = async (id: ComponentId, run: () => Promise<ComponentStatus>, resetLog = false) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setErrors((e) => ({ ...e, [id]: undefined }));
    if (resetLog) {
      logNext.current[id] = 0;
      setLogs((m) => ({ ...m, [id]: [] }));
    }
    try {
      replace(await run());
    } catch (e) {
      setErrors((m) => ({ ...m, [id]: msg(e) }));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  const local = remote === false;
  return createPortal(
    <div ref={scrimRef} className="cz-acct-dlg__scrim cz-modal-scrim">
      <div ref={panelRef} className="cz-acct-dlg cz-comp-dlg cz-modal" role="dialog" aria-modal="true" aria-label="本机组件">
        <div className="cz-acct-dlg__title">本机组件</div>
        {remote === true && (
          <p className="cz-acct-dlg__text cz-acct-dlg__text--muted" role="note">仅本机可操作</p>
        )}
        {list === null && !loadError && <p className="cz-acct-dlg__text cz-acct-dlg__text--muted">正在读取…</p>}
        {loadError && <p className="cz-acct-dlg__text cz-acct-dlg__text--error" role="alert">读取失败：{loadError}</p>}
        {list && (
          <div className="cz-comp-list">
            {list.map((c) => (
              <ComponentCard
                key={c.id}
                c={c}
                local={local}
                busy={!!busy[c.id]}
                error={errors[c.id] ?? null}
                log={logs[c.id] ?? []}
                onCheck={() => void act(c.id, () => api.checkComponent(c.id))}
                onUpdate={() => void act(c.id, () => api.updateComponent(c.id), true)}
                onAuto={() => void act(c.id, () => api.setComponentAuto(c.id, !c.autoUpdate))}
              />
            ))}
          </div>
        )}
        <div className="cz-acct-dlg__btns">
          <button type="button" className="cz-acct-dlg__btn" onClick={() => requestClose(onClose)}>关闭</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
