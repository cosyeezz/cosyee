// 订阅用量统计面板：按「账号 × 额度窗口（5 小时 / 每周 / 按模型 / 每月）」展示 Cosyee 账本统计。
//
// 动效规划（参考 interaction-motion skill，且不跟随 prefers-reduced-motion，始终开启）：
// 1. 面板进入/退出：沿用 Cosyee 模态原位展开/原地缩放淡出（220ms cubic-bezier(.16, 1, .3, 1)），遮罩同步淡入淡出。
// 2. 分段切换指示器：复用 liquidFramesX 弹簧液态玻璃胶囊（320–440ms，前沿先冲、后沿滞后 14% 跟上，支持连点无缝打断）。
// 3. 数字变化：汇总区等效花费 / 请求数 / 最新推算使用 rAF easeOutQuart 平滑滚到新值（420ms，tabular-nums 防抖动）。
// 4. 列表项入场与展开：行错开 36ms 淡入上移 6px；点击行用 Reveal（grid-template-rows 0fr↔1fr + opacity 220ms）平滑展开。
// 5. 进度条与曲线绘制：进度条 scaleX(@starting-style 0 → 目标, 540ms ease-out)；SVG 走势曲线 stroke-dashoffset 从左向右绘制（560ms）。
// 6. 骨架屏加载：共用视口坐标斜向光带（1.5s 循环），数据到达后平滑过渡到真实列表。
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type {
  LedgerBackend,
  LedgerWindowDetail,
  LedgerWindowKind,
  LedgerWindowList,
  LedgerWindowSummary,
} from '@cosyee/shared';
import { api } from '../../core/api';
import { formatUsd } from '../context/cost';
import { BrandIcon, type BrandKind } from '../icons/BrandIcon';
import { Icon } from '../icons/Icon';
import { liquidFramesX } from '../motion/LiquidCapsule';
import { canAnimate } from '../motion/reduced';
import { PlanChip } from '../sidebar/accountParts';
import { useDismiss } from '../sidebar/useDismiss';
import { useFocusTrap } from '../sidebar/useFocusTrap';
import {
  availableKinds,
  KIND_LABEL,
  loadTokenUnit,
  nextTokenUnit,
  saveTokenUnit,
  TOKEN_UNIT_LABEL,
  type TokenUnitMode,
} from './format';
import { WindowRow, type DetailState } from './WindowRow';
import './LedgerPanel.css';

export interface LedgerTarget {
  backend: LedgerBackend;
  account: string;
  accountName: string;
  brand?: BrandKind;
  plan?: string | null;
}

export interface LedgerPanelProps {
  target: LedgerTarget;
  onClose: () => void;
  /** 可选：用于 dev 预览或测试的初始展开窗口 id */
  defaultExpandedId?: string | null;
  /** 可选：指定当前时间（测试与 dev 预览可固定时间） */
  now?: number;
  /** true = 内嵌渲染（不包遮罩、不 portal），便于 dev 调试页直接展示多场景；默认 false 为模态弹层 */
  inline?: boolean;
}

const easeOutQuart = (t: number) => 1 - (1 - t) ** 4;

/** 汇总区数字平滑滚动：不跟随 prefers-reduced-motion；jsdom 下无 element.animate 时直接显示终值 */
function AnimatedMetric({
  value,
  format,
  duration = 420,
}: {
  value: number;
  format: (n: number) => string;
  duration?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const mounted = useRef(false);
  const rafRef = useRef<number | null>(null);
  const formatRef = useRef(format);
  formatRef.current = format;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !canAnimate(el) || typeof requestAnimationFrame !== 'function') {
      shown.current = value;
      if (el) el.textContent = formatRef.current(value);
      mounted.current = true;
      return;
    }
    const from = mounted.current ? shown.current : 0;
    mounted.current = true;
    if (Math.abs(from - value) < 1e-6) {
      shown.current = value;
      el.textContent = formatRef.current(value);
      return;
    }
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    const start = performance.now();
    const tick = (nowTs: number) => {
      const t = Math.min(1, Math.max(0, (nowTs - start) / duration));
      const cur = t >= 1 ? value : from + (value - from) * easeOutQuart(t);
      shown.current = cur;
      el.textContent = formatRef.current(cur);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else rafRef.current = null;
    };
    el.textContent = formatRef.current(from);
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [value, duration]);

  return <span ref={ref}>{format(value)}</span>;
}

interface SegBox { x: number; y: number; w: number; h: number }

/** 横向液态玻璃分段切换器：复用 liquidFramesX，始终开启动效，支持方向键与快速打断 */
function KindSegmented({
  kinds,
  active,
  onChange,
}: {
  kinds: readonly LedgerWindowKind[];
  active: LedgerWindowKind;
  onChange: (k: LedgerWindowKind) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLSpanElement>(null);
  const lastRef = useRef<{ key: string | null; box: SegBox | null }>({ key: null, box: null });
  const animRef = useRef<Animation | null>(null);

  const measure = useCallback((): SegBox | null => {
    const host = hostRef.current;
    const btn = host?.querySelector<HTMLElement>('.cz-ledger-seg__btn.is-active');
    if (!host || !btn) return null;
    const hr = host.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    if (br.width === 0 || br.height === 0) return null;
    return {
      x: br.left - hr.left + host.scrollLeft,
      y: br.top - hr.top + host.scrollTop,
      w: br.width,
      h: br.height,
    };
  }, []);

  const sync = useCallback(
    (force = false) => {
      const el = capRef.current;
      const host = hostRef.current;
      if (!el || !host) return;
      const target = measure();
      const prev = lastRef.current;
      const keyChanged = active !== prev.key;
      if (!force && !keyChanged && target && prev.box &&
          Math.abs(target.x - prev.box.x) < 0.5 && Math.abs(target.w - prev.box.w) < 0.5) {
        return;
      }
      const from = prev.box;
      prev.key = active;
      prev.box = target;

      if (!target) {
        animRef.current?.cancel();
        animRef.current = null;
        el.classList.remove('is-on');
        return;
      }

      const wasShown = el.classList.contains('is-on') && from !== null;
      let start = from;
      if (animRef.current && animRef.current.playState === 'running' && from) {
        const hr = host.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          start = {
            x: r.left - hr.left + host.scrollLeft,
            y: r.top - hr.top + host.scrollTop,
            w: r.width,
            h: r.height,
          };
        }
      }
      animRef.current?.cancel();
      animRef.current = null;
      el.style.transform = `translate3d(${target.x}px, ${target.y}px, 0) scale(1, 1)`;
      el.style.width = `${target.w}px`;
      el.style.height = `${target.h}px`;
      el.classList.add('is-on');

      if (!keyChanged || force || !wasShown || !start || !canAnimate(el)) return;
      const dist = Math.abs(target.x - start.x);
      const dur = Math.round(Math.min(440, Math.max(320, 300 + dist * 0.4)));
      animRef.current = el.animate(liquidFramesX(start, target), { duration: dur, easing: 'linear' });
    },
    [active, measure],
  );

  useLayoutEffect(() => {
    sync();
  }, [sync, kinds]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const onResize = () => sync(true);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
    ro?.observe(host);
    window.addEventListener('resize', onResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', onResize);
      animRef.current?.cancel();
      animRef.current = null;
    };
  }, [sync]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const idx = kinds.indexOf(active);
    if (idx < 0) return;
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % kinds.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + kinds.length) % kinds.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = kinds.length - 1;
    else return;
    e.preventDefault();
    onChange(kinds[next]!);
    const btns = hostRef.current?.querySelectorAll<HTMLButtonElement>('.cz-ledger-seg__btn');
    btns?.[next]?.focus();
  };

  return (
    <div
      ref={hostRef}
      className="cz-ledger-seg"
      role="tablist"
      aria-label="额度窗口类型"
      onKeyDown={onKeyDown}
    >
      <span ref={capRef} className="cz-capsule cz-ledger-seg__cap" aria-hidden="true" />
      {kinds.map((k) => {
        const isActive = k === active;
        return (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            className={`cz-ledger-seg__btn${isActive ? ' is-active' : ''}`}
            onClick={() => onChange(k)}
          >
            {KIND_LABEL[k]}
          </button>
        );
      })}
    </div>
  );
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function LedgerPanel({
  target,
  onClose,
  defaultExpandedId = null,
  now: nowProp,
  inline = false,
}: LedgerPanelProps) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closingRef = useRef(false);
  const [leaving, setLeaving] = useState(false);

  const [listState, setListState] = useState<
    | { status: 'loading' }
    | { status: 'ok'; data: LedgerWindowList }
    | { status: 'error'; message: string }
  >({ status: 'loading' });

  const [activeKind, setActiveKind] = useState<LedgerWindowKind | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(defaultExpandedId);
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const [tokenUnit, setTokenUnit] = useState<TokenUnitMode>(() => loadTokenUnit());
  const [now, setNow] = useState(() => nowProp ?? Date.now());

  const cycleTokenUnit = useCallback(() => {
    setTokenUnit((cur) => {
      const next = nextTokenUnit(cur);
      saveTokenUnit(next);
      return next;
    });
  }, []);

  useEffect(() => {
    if (nowProp !== undefined) {
      setNow(nowProp);
      return;
    }
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, [nowProp]);

  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    if (inline) {
      onClose();
      return;
    }
    const panel = panelRef.current;
    if (!panel || !canAnimate(panel)) {
      onClose();
      return;
    }
    closingRef.current = true;
    setLeaving(true);
    const done = () => onClose();
    const anim = panel.animate(
      [
        { opacity: 1, transform: 'translateY(0) scale(1)' },
        { opacity: 0, transform: 'translateY(6px) scale(.97)' },
      ],
      { duration: 170, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' },
    );
    const scrim = scrimRef.current;
    if (scrim) {
      scrim.animate(
        [{}, { backgroundColor: 'transparent', backdropFilter: 'blur(0px) saturate(1)' }],
        { duration: 170, easing: 'ease-in', fill: 'forwards' },
      );
    }
    anim.onfinish = done;
    anim.oncancel = done;
  }, [inline, onClose]);

  useFocusTrap(panelRef, !inline && !leaving);
  useDismiss(!inline && !leaving, panelRef, requestClose);

  const loadList = useCallback(() => {
    setListState({ status: 'loading' });
    setDetails({});
    let alive = true;
    api.ledgerWindows({ backend: target.backend, account: target.account }).then(
      (data) => {
        if (!alive) return;
        setListState({ status: 'ok', data });
        const kinds = availableKinds(data.windows);
        setActiveKind((prev) => (prev && kinds.includes(prev) ? prev : kinds[0] ?? null));
      },
      (e) => {
        if (!alive) return;
        setListState({ status: 'error', message: errText(e) });
      },
    );
    return () => {
      alive = false;
    };
  }, [target.backend, target.account]);

  useEffect(() => loadList(), [loadList]);

  const fetchDetail = useCallback((id: string) => {
    setDetails((prev) => ({ ...prev, [id]: { status: 'loading' } }));
    api.ledgerWindowDetail(id).then(
      (detail: LedgerWindowDetail) => {
        setDetails((prev) => ({ ...prev, [id]: { status: 'ok', detail } }));
      },
      (e) => {
        setDetails((prev) => ({ ...prev, [id]: { status: 'error', message: errText(e) } }));
      },
    );
  }, []);

  // 如果指定了初始展开 id 且列表加载成功包含该窗口，自动拉取明细
  useEffect(() => {
    if (!expandedId || listState.status !== 'ok') return;
    if (!listState.data.windows.some((w) => w.id === expandedId)) return;
    const cur = details[expandedId];
    if (!cur || cur.status === 'idle') fetchDetail(expandedId);
  }, [expandedId, listState, details, fetchDetail]);

  const windows = listState.status === 'ok' ? listState.data.windows : [];
  const enabled = listState.status === 'ok' ? listState.data.enabled : true;
  const kinds = useMemo(() => availableKinds(windows), [windows]);
  const selectedKind = activeKind && kinds.includes(activeKind) ? activeKind : kinds[0] ?? null;

  const visibleWindows = useMemo(
    () => (selectedKind ? windows.filter((w) => w.kind === selectedKind) : windows),
    [windows, selectedKind],
  );

  const summary = useMemo(() => {
    let totalCost = 0;
    let totalReqs = 0;
    let latestEst: LedgerWindowSummary | null = null;
    for (const w of visibleWindows) {
      totalCost += w.costUsd;
      totalReqs += w.requests;
      if (!latestEst && w.estimate.usdPer100 !== null) latestEst = w;
    }
    return {
      count: visibleWindows.length,
      totalCost,
      totalReqs,
      latestEst,
    };
  }, [visibleWindows]);

  const toggleRow = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    const cur = details[id];
    if (!cur || cur.status === 'idle' || cur.status === 'error') {
      fetchDetail(id);
    }
  };

  const brand: BrandKind = target.brand ?? (target.backend === 'claude' ? 'claude' : target.backend);

  const panelBody = (
    <div
      ref={panelRef}
      className={`cz-ledger${inline ? ' is-inline' : ' cz-ledger-modal'}${leaving ? ' is-leaving' : ''}`}
      role={inline ? 'region' : 'dialog'}
      aria-modal={inline ? undefined : 'true'}
      aria-label={`${target.accountName} 用量统计`}
    >
      <div className="cz-ledger__head">
        <div className="cz-ledger__ident">
          <span className="cz-ledger__brand">
            <BrandIcon kind={brand} size={16} />
          </span>
          <div className="cz-ledger__title-wrap">
            <div className="cz-ledger__title-row">
              <h2 className="cz-ledger__title" title={target.accountName}>
                {target.accountName}
              </h2>
              <PlanChip plan={target.plan} />
              <span className="cz-ledger__subtitle-tag">用量统计</span>
            </div>
          </div>
        </div>
        <div className="cz-ledger__head-acts">
          <button
            type="button"
            className="cz-ledger__icon-btn"
            aria-label="刷新用量统计"
            title="刷新"
            disabled={listState.status === 'loading'}
            onClick={() => loadList()}
          >
            <Icon name="refresh" size={14} />
          </button>
          {!inline && (
            <button
              type="button"
              className="cz-ledger__icon-btn"
              aria-label="关闭"
              title="关闭"
              onClick={requestClose}
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      </div>

      {listState.status === 'ok' && !enabled && (
        <div className="cz-ledger__banner is-warn" role="alert">
          <Icon name="alert" size={14} />
          <div>
            <strong>账本统计已停用</strong>
            <p>服务端写入用量数据库失败时会自动停用账本，避免影响正常对话。请检查磁盘空间或服务日志后重启服务。</p>
          </div>
        </div>
      )}

      {listState.status === 'loading' && (
        <div className="cz-ledger__loading" aria-busy="true" aria-label="正在读取用量统计">
          <div className="cz-ledger__skel-bar">
            <div className="cz-ledger-skel cz-ledger-skel--seg" />
          </div>
          <div className="cz-ledger__skel-summary">
            <div className="cz-ledger-skel cz-ledger-skel--card" />
            <div className="cz-ledger-skel cz-ledger-skel--card" />
            <div className="cz-ledger-skel cz-ledger-skel--card" />
          </div>
          <div className="cz-ledger__skel-rows">
            <div className="cz-ledger-skel cz-ledger-skel--row" />
            <div className="cz-ledger-skel cz-ledger-skel--row" />
            <div className="cz-ledger-skel cz-ledger-skel--row" />
          </div>
        </div>
      )}

      {listState.status === 'error' && (
        <div className="cz-ledger__state is-error" role="alert">
          <Icon name="alert" size={18} />
          <div className="cz-ledger__state-title">读取用量统计失败</div>
          <div className="cz-ledger__state-desc">{listState.message}</div>
          <button type="button" className="cz-ledger-btn is-primary" onClick={() => loadList()}>
            重试
          </button>
        </div>
      )}

      {listState.status === 'ok' && windows.length === 0 && (
        <div className="cz-ledger__state">
          <Icon name="chart" size={20} />
          <div className="cz-ledger__state-title">暂无用量记录</div>
          <div className="cz-ledger__state-desc">
            从现在开始记录 Cosyee 发出的请求，不含历史；额度数据在使用时自动更新。
          </div>
        </div>
      )}

      {listState.status === 'ok' && windows.length > 0 && selectedKind && (
        <>
          <div className="cz-ledger__toolbar">
            <KindSegmented
              kinds={kinds}
              active={selectedKind}
              onChange={(k) => {
                setActiveKind(k);
                setExpandedId(null);
              }}
            />
            <div className="cz-ledger__toolbar-right">
              <button
                type="button"
                className="cz-ledger-unit-btn"
                onClick={cycleTokenUnit}
                title="点击切换 token 单位：自动 → M → B → 完整"
                aria-label={`切换 token 单位，当前：${TOKEN_UNIT_LABEL[tokenUnit]}`}
              >
                <span className="cz-ledger-unit-btn__k">单位</span>
                <span key={tokenUnit} className="cz-ledger-unit-btn__v">
                  {TOKEN_UNIT_LABEL[tokenUnit]}
                </span>
              </button>
              <span className="cz-ledger__count-note">共 {summary.count} 个窗口</span>
            </div>
          </div>

          <div className="cz-ledger__summary" aria-label="当前分组汇总">
            <div className="cz-ledger__stat">
              <span className="cz-ledger__stat-k">累计等效花费</span>
              <span className="cz-ledger__stat-v">
                <AnimatedMetric value={summary.totalCost} format={formatUsd} />
              </span>
            </div>
            <div className="cz-ledger__stat">
              <span className="cz-ledger__stat-k">最新 100% 推算</span>
              <span
                className={`cz-ledger__stat-v${
                  summary.latestEst && !summary.latestEst.estimate.reliable ? ' is-unreliable' : ''
                }`}
                title={
                  summary.latestEst
                    ? summary.latestEst.estimate.reliable
                      ? '取最近一个有效推算窗口的 100% 额度等效花费'
                      : '最近有效推算窗口检测到 Cosyee 外部用量，仅供参考'
                    : '各窗口百分比增量均不足 5%，暂无法推算'
                }
              >
                {summary.latestEst?.estimate.usdPer100 != null ? (
                  <>
                    ≈{' '}
                    <AnimatedMetric
                      value={summary.latestEst.estimate.usdPer100}
                      format={formatUsd}
                    />
                  </>
                ) : (
                  <span className="is-muted">—</span>
                )}
              </span>
            </div>
            <div className="cz-ledger__stat">
              <span className="cz-ledger__stat-k">累计请求</span>
              <span className="cz-ledger__stat-v">
                <AnimatedMetric
                  value={summary.totalReqs}
                  format={(n) => Math.round(n).toLocaleString('en-US')}
                />
              </span>
            </div>
          </div>

          <div className="cz-ledger__list" role="tabpanel" aria-label={`${KIND_LABEL[selectedKind]}窗口列表`}>
            {visibleWindows.map((win, idx) => (
              <WindowRow
                key={win.id}
                win={win}
                index={idx}
                expanded={expandedId === win.id}
                detail={details[win.id] ?? { status: 'idle' }}
                now={now}
                tokenUnit={tokenUnit}
                onCycleTokenUnit={cycleTokenUnit}
                onToggle={() => toggleRow(win.id)}
                onRetryDetail={() => fetchDetail(win.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );

  if (inline) return panelBody;

  return createPortal(
    <div ref={scrimRef} className="cz-ledger__scrim">
      {panelBody}
    </div>,
    document.body,
  );
}
