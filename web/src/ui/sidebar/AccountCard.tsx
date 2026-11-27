// 账号弹层里的悬浮详情卡：鼠标停在某个账号上（或键盘 Tab 到它）时，在侧栏右侧显示这个账号的全部信息。
// 样式、延时、定位和动效都沿用会话悬浮卡片（SessionCard）：首次停留 400ms 打开，卡片开着时换行很快跟过去，
// 移开 220ms 内可以把鼠标移进卡片；触屏不弹。点击账号、滚动列表、窗口失焦、Esc 时关闭。
import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type CSSProperties, type FocusEvent, type PointerEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import type { AccountEntry, AgyAccountEntry, ApiModelMap, ApiModelTarget, CodexAccountEntry } from '@cosyee/shared';
import { BrandIcon, type BrandKind } from '../icons/BrandIcon';
import { viewportBounds } from '../layout/viewport';
import { reducedMotion } from '../motion/reduced';
import { leavingProps, usePresence } from '../motion/usePresence';
import { loginExpiry, subscriptionEstimate } from '../usage/format';
import { AccountQuota, AgyQuotaView, CodexQuotaView, codexWindows, KiroQuotaView, type KiroBalanceState, type QuotaState } from './AccountQuota';
import { agyTitle, claudeKind, codexPlan, codexTitle, entryTitle, PlanChip, planChip } from './accountParts';
import { formatFullTime } from './formatTime';
import {
  COLD_DELAY_MS, computePosition, ensureModalityListeners, isKeyboardFocus, LEAVE_GRACE_MS, WARM_DELAY_MS, WARM_WINDOW_MS,
  type CardPos,
} from './SessionCard';
import { useDismiss } from './useDismiss';

interface HoverState {
  open: boolean;
  key: string;
  el: HTMLElement | null;
  /** 每次换到另一个账号递增：内容交叉淡化 */
  seq: number;
}

/** 悬停状态机：enabled 变假（弹层关了）时立即关闭 */
export function useAccountCard(enabled: boolean) {
  const [hover, setHover] = useState<HoverState>({ open: false, key: '', el: null, seq: 0 });
  const id = useId();
  const openTimer = useRef<number>();
  const closeTimer = useRef<number>();
  const isOpen = useRef(false);
  const closedAt = useRef(0);

  const closeNow = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    if (!isOpen.current) return;
    isOpen.current = false;
    closedAt.current = Date.now();
    setHover((h) => ({ ...h, open: false }));
  }, []);
  const keep = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  }, []);
  const closeSoon = useCallback(() => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    if (isOpen.current) closeTimer.current = window.setTimeout(closeNow, LEAVE_GRACE_MS);
  }, [closeNow]);
  const openSoon = useCallback((key: string, el: HTMLElement) => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
    const warm = isOpen.current || Date.now() - closedAt.current <= WARM_WINDOW_MS;
    openTimer.current = window.setTimeout(() => {
      if (!el.isConnected) return;
      isOpen.current = true;
      setHover((h) => (h.open && h.key === key ? h : { open: true, key, el, seq: h.open ? h.seq + 1 : 0 }));
    }, warm ? WARM_DELAY_MS : COLD_DELAY_MS);
  }, []);

  useEffect(ensureModalityListeners, []);
  useEffect(() => {
    if (!enabled) closeNow();
  }, [enabled, closeNow]);
  useEffect(() => closeNow, [closeNow]);

  /** 绑到账号行按钮上 */
  const bind = (key: string) => ({
    'aria-describedby': hover.open && hover.key === key ? id : undefined,
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (!e.pointerType || e.pointerType === 'mouse') openSoon(key, e.currentTarget);
    },
    onPointerLeave: (e: PointerEvent<HTMLElement>) => {
      if (!e.pointerType || e.pointerType === 'mouse') closeSoon();
    },
    // 按下就收起，也取消还没打开的：点击是要切换账号，不要卡片
    onPointerDown: closeNow,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (isKeyboardFocus(e.currentTarget)) openSoon(key, e.currentTarget);
    },
    onBlur: closeNow,
  });

  return { id, hover, bind, closeNow, closeSoon, keep };
}

/** 卡片外壳：定位、高度过渡、入场退场；children 是当前账号的内容 */
export function AccountCardLayer({ ctrl, children }: { ctrl: ReturnType<typeof useAccountCard>; children: ReactNode }) {
  const { id, hover, closeNow, closeSoon, keep } = ctrl;
  const cardRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const { mounted, leaving } = usePresence(hover.open, cardRef, 120);
  const [pos, setPos] = useState<CardPos | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  /** 已经落位：之后换账号才平滑移动 */
  const [ready, setReady] = useState(false);
  useDismiss(hover.open, cardRef, closeNow);

  useEffect(() => {
    if (mounted) return;
    setPos(null);
    setHeight(null);
    setReady(false);
  }, [mounted]);

  // 账号被移除等原因没有内容了：关掉，别留一个看不见的层
  const empty = !children;
  useEffect(() => {
    if (hover.open && empty) closeNow();
  }, [hover.open, empty, closeNow]);

  const place = useCallback(() => {
    const card = cardRef.current;
    const inner = innerRef.current;
    if (!hover.el?.isConnected || !card || !inner) return;
    const vb = viewportBounds();
    const maxH = Math.min(vb.bottom - vb.top - 16, window.innerHeight * 0.76, 620);
    const h = Math.min(inner.offsetHeight, maxH);
    if (h > 0) setHeight(h);
    setPos(computePosition(hover.el, card.offsetWidth, h > 0 ? h + 2 : 180, 'side'));
  }, [hover.el]);

  useLayoutEffect(() => {
    if (!mounted) return;
    place();
    let raf = window.requestAnimationFrame(() => {
      raf = window.requestAnimationFrame(() => setReady(true));
    });
    return () => window.cancelAnimationFrame(raf);
  }, [mounted, place]);

  // 内容变高变矮（额度读回来、换了账号）时跟着调整
  useEffect(() => {
    const inner = innerRef.current;
    if (!mounted || !inner || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(place);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [mounted, place]);

  useEffect(() => {
    if (!hover.open) return;
    const onScroll = (e: Event) => {
      if (hover.el && (e.target as Node).contains(hover.el)) closeNow();
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeNow);
    window.addEventListener('blur', closeNow);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', closeNow);
      window.removeEventListener('blur', closeNow);
    };
  }, [hover.open, hover.el, closeNow]);

  if (!mounted || empty) return null;
  const smooth = ready && pos !== null && !reducedMotion();
  return createPortal(
    <div
      className={`cz-scard-pos${smooth ? ' is-moving' : ''}`}
      style={{ transform: `translate3d(${Math.round(pos?.x ?? -9999)}px, ${Math.round(pos?.y ?? -9999)}px, 0)` }}
    >
      <div
        ref={cardRef}
        id={id}
        role="tooltip"
        className={`cz-scard cz-scard--${pos?.side ?? 'side'} cz-acard${leaving ? ' is-leaving' : ''}`}
        style={{ transformOrigin: pos?.origin } as CSSProperties}
        onPointerEnter={keep}
        onPointerLeave={closeSoon}
        {...leavingProps(leaving)}
      >
        <div className={`cz-scard__scroll${smooth ? ' is-height-anim' : ''}`} style={height !== null ? { height } : undefined}>
          <div ref={innerRef} className="cz-scard__inner">
            <div key={hover.seq} className={`cz-scard__content${hover.seq > 0 ? ' is-crossfade' : ''}`}>{children}</div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ───────────── 卡片内容 ─────────────

type Fact = { label: string; value: ReactNode; tone?: 'warn' | 'danger'; title?: string };

function Body({
  brand, group, title, plan, active, status, quota, facts,
}: {
  brand: BrandKind;
  group: string;
  title: string;
  plan: string | null;
  active: boolean;
  status: string;
  quota?: ReactNode;
  facts: Fact[];
}) {
  return (
    <>
      <div className="cz-scard__head">
        <div className="cz-scard__title">
          {title}
          <PlanChip plan={plan} tip={false} />
        </div>
        <div className="cz-scard__status-row">
          <span className="cz-scard__status">
            <span className={`cz-scard__dot ${active ? 'cz-acard__dot' : 'cz-scard__dot--idle'}`} />
            <span>{status}</span>
          </span>
          <span className="cz-acard__group"><BrandIcon kind={brand} size={12} />{group}</span>
        </div>
      </div>
      {quota && <div className="cz-scard__section">{quota}</div>}
      {facts.length > 0 && (
        <div className="cz-scard__section">
          <dl className="cz-scard__facts">
            {facts.map((f) => (
              <div key={f.label} className="cz-scard__fact">
                <dt className="cz-scard__fact-k">{f.label}</dt>
                <dd className={`cz-scard__fact-v${f.tone ? ` is-${f.tone}` : ''}`} title={f.title}>{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

const targetText = (t: ApiModelTarget) => (t.label && t.label !== t.id ? `${t.label}（${t.id}）` : t.id);

/** 模型映射：别名 → 实际模型，一行一个 */
function modelFact(m: ApiModelMap | undefined): Fact | null {
  const lines = [
    ...Object.entries(m?.alias ?? {}).flatMap(([k, t]) => (t ? [`${k} → ${targetText(t)}`] : [])),
    ...(m?.extra ?? []).map(targetText),
    ...(m?.subagent ? [`子代理 → ${m.subagent}`] : []),
    ...(m?.fallback ? [`其它 → ${m.fallback}`] : []),
  ];
  if (!lines.length) return null;
  return { label: '模型映射', value: lines.map((l, i) => <span key={i} className="cz-acard__line">{l}</span>) };
}

/** Kiro 账号「状态」一行：服务没在跑时说服务，在跑时说凭据 */
export function kiroStateFact(k: NonNullable<AccountEntry['kiro']>, balance: KiroBalanceState | undefined): Fact {
  if (k.proxy === 'failed') return { label: '状态', value: k.error ? `kiro.rs 启动失败：${k.error}` : 'kiro.rs 启动失败', tone: 'danger' };
  if (k.proxy === 'stopped') return { label: '状态', value: 'kiro.rs 未运行', tone: 'danger' };
  if (k.proxy === 'starting') return { label: '状态', value: 'kiro.rs 启动中' };
  switch (k.credential) {
    case 'ok': return { label: '状态', value: '可用' };
    case 'quota': {
      const at = balance?.status === 'ok' ? balance.info.resetsAt : null;
      const d = at ? new Date(at) : null;
      const when = d ? `，${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 重置` : '';
      return { label: '状态', value: `额度已用完${when}`, tone: 'danger' };
    }
    case 'disabled': return { label: '状态', value: `已被 kiro.rs 停用${k.credentialReason ? `：${k.credentialReason}` : ''}`, tone: 'danger' };
    case 'missing': return { label: '状态', value: '服务里找不到凭据，请重新登录', tone: 'danger' };
    default: return { label: '状态', value: '读取中…' };
  }
}
const KIRO_METHOD = {
  builderId: 'Builder ID', idc: 'IAM Identity Center', kiroIde: '导入自 Kiro IDE', kiroCli: '导入自 Kiro CLI', apiKey: 'API Key',
} as const;

export function ClaudeCardBody({
  a, quota, balance, parallel, now,
}: {
  a: AccountEntry;
  quota: QuotaState | undefined;
  balance: KiroBalanceState | undefined;
  parallel: boolean;
  now: number;
}) {
  const kind = claudeKind(a);
  const title = entryTitle(a);
  const facts: Fact[] = [];
  if (a.label && a.label !== title) facts.push({ label: '备注', value: a.label });
  if (kind === 'claude') {
    const sub = a.plan ? subscriptionEstimate(a.subscribedAt, now) : null;
    if (sub) facts.push({ label: '订阅', value: sub.text.replace(/^订阅/, ''), title: sub.title });
    const exp = loginExpiry(a.loginExpiresAt, now);
    if (exp) facts.push({ label: '登录', value: exp.text.replace(/^登录\s*/, ''), tone: exp.tone === 'normal' ? undefined : exp.tone });
    if (quota?.status === 'ok') facts.push({ label: '额度更新', value: formatFullTime(quota.info.at, now) });
  }
  if (a.api) {
    facts.push({ label: '地址', value: a.api.baseUrl || 'https://api.anthropic.com' });
    facts.push({ label: '认证', value: a.api.authType === 'authToken' ? 'Bearer' : 'x-api-key' });
    if (a.api.keyHint) facts.push({ label: '密钥', value: `•••• ${a.api.keyHint}` });
    facts.push({ label: '计费', value: '按量计费' });
    facts.push(modelFact(a.api.models) ?? { label: '模型映射', value: '未配置' });
  }
  if (a.kiro) {
    if (a.kiro.email && a.kiro.email !== title) facts.push({ label: '邮箱', value: a.kiro.email });
    const sub = balance?.status === 'ok' ? balance.info.subscription : null;
    if (sub) facts.push({ label: '订阅', value: sub });
    facts.push({ label: '登录方式', value: KIRO_METHOD[a.kiro.method] });
    facts.push(kiroStateFact(a.kiro, balance));
  }
  return (
    <Body
      brand={kind}
      group={kind === 'claude' ? 'Claude 订阅' : kind === 'api' ? 'API' : 'Kiro'}
      title={title}
      plan={kind === 'kiro' && planChip(a.plan)?.toLowerCase() === 'kiro' ? null : a.plan}
      active={a.active}
      status={a.active ? (parallel ? '新会话使用' : '当前账号') : '可切换'}
      quota={kind === 'claude' ? <AccountQuota state={quota ?? { status: 'loading' }} now={now} />
        : kind === 'kiro' ? <KiroQuotaView state={balance ?? { status: 'loading' }} now={now} /> : null}
      facts={facts}
    />
  );
}

export function AgyCardBody({ a, now }: { a: AgyAccountEntry; now: number }) {
  const title = agyTitle(a);
  const facts: Fact[] = [];
  if (a.email && a.email !== title) facts.push({ label: '邮箱', value: a.email });
  if (a.plan) facts.push({ label: '套餐', value: a.plan });
  facts.push({ label: '委派任务', value: a.running > 0 ? `${a.running} 个执行中` : '没有执行中的' });
  if (a.quota) facts.push({ label: '额度更新', value: formatFullTime(a.quota.at, now) });
  return (
    <Body
      brand="agy"
      group="Antigravity"
      title={title}
      plan={a.plan}
      active={a.active}
      status={a.active ? '新委派使用' : '可切换'}
      quota={a.quota && a.quota.groups.length > 0
        ? <AgyQuotaView quota={a.quota} now={now} />
        : <span className="cz-acctq__hint">暂无额度信息</span>}
      facts={facts}
    />
  );
}

export function CodexCardBody({ a, now }: { a: CodexAccountEntry; now: number }) {
  const title = codexTitle(a);
  const plan = codexPlan(a);
  const facts: Fact[] = [];
  if (a.email && a.email !== title) facts.push({ label: '邮箱', value: a.email });
  if (a.authMode) facts.push({ label: '登录方式', value: a.authMode === 'apiKey' ? 'API Key' : 'ChatGPT 账号' });
  if (plan && plan !== 'API Key') facts.push({ label: '套餐', value: plan });
  facts.push({ label: '委派任务', value: a.running > 0 ? `${a.running} 个执行中` : '没有执行中的' });
  if (a.quota) facts.push({ label: '额度更新', value: formatFullTime(a.quota.fetchedAt, now) });
  const quota = a.authMode === 'apiKey'
    ? <span className="cz-acctq__hint">按量计费（API Key）</span>
    : a.quota && codexWindows(a.quota).length > 0
      ? <CodexQuotaView quota={a.quota} now={now} />
      : <span className="cz-acctq__hint">暂无额度信息</span>;
  return (
    <Body
      brand="codex"
      group="Codex"
      title={title}
      plan={plan}
      active={a.active}
      status={a.active ? '新委派使用' : '可切换'}
      quota={quota}
      facts={facts}
    />
  );
}
