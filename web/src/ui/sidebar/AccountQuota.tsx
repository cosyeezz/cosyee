// 账号的额度显示。所有额度先换成统一的「窗口」（名称、百分比、颜色、重置时间），再按两种样式画：
// - QuotaBrief：账号弹层里每个账号一行「5h ━━━ 94%」，只显示最先重置的那个窗口，全部额度在悬浮详情卡（AccountCard）里；
// - QuotaLines：管理面板卡片里的全部窗口，一条一行「5h ━━━ 71% 2小时30分后重置」，Antigravity 按模型组分段。
// 名称统一：Claude 的会话窗口和 Antigravity 的 5 小时窗口都叫「5h」，周额度叫「本周」，Kiro 的月度额度叫「本月」。
// 颜色阈值沿用输入框里的额度面板（severity：normal / warning / critical → 主题色 / 警告色 / 危险色）。
// 进度条第一次出现时从 0 长到目标值（transform: scaleX + @starting-style），数据刷新时从当前值平滑过渡，减少动态效果时不动。
import type { CSSProperties, ReactNode } from 'react';
import type { AgyQuota, KiroBalance, UsageInfo, UsageSeverity } from '@cosyee/shared';
import { limitShortTitle, resetShort } from '../usage/format';

/** loading：还没有结果；ok：info 有数据；none：服务端没有额度信息；fail：读取失败 */
export type QuotaState = { status: 'loading' } | { status: 'ok'; info: UsageInfo } | { status: 'none' } | { status: 'fail' };

/** Kiro 额度状态 */
export type KiroBalanceState = { status: 'loading' } | { status: 'ok'; info: KiroBalance } | { status: 'fail' };

/** 一个额度窗口 */
export interface QuotaWindow {
  key: string;
  /** 进度条左边的短名：5h / 本周 / 本月 / 模型名 */
  label: string;
  percent: number;
  severity: UsageSeverity;
  resetsAt: number | null;
  /** Antigravity 的模型组名（Gemini / Claude · GPT） */
  group?: string;
  /** 右侧显示的值，默认「N%」（Kiro 显示「已用 / 总额度」） */
  value?: string;
}

const WINDOW_SHORT: Record<string, string> = { '5h': '5h', weekly: '本周' };

/** Claude 订阅的各条限制 */
export function claudeWindows(info: UsageInfo): QuotaWindow[] {
  return info.limits.map((l, i) => ({
    key: `${l.kind}:${l.model ?? ''}:${i}`,
    label: l.kind === 'session' ? '5h' : limitShortTitle(l),
    percent: l.percent,
    severity: l.severity,
    resetsAt: l.resetsAt,
  }));
}

/** Antigravity 各模型组的各窗口 */
export function agyWindows(q: AgyQuota): QuotaWindow[] {
  return q.groups.flatMap((g) =>
    g.buckets.map((b) => ({
      key: `${g.name}:${b.window}`,
      label: WINDOW_SHORT[b.window] ?? b.window,
      percent: b.percent,
      severity: b.severity,
      resetsAt: b.resetsAt,
      group: g.name,
    })),
  );
}

const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1))));

/** Kiro 的月度额度 */
export function kiroWindow(info: KiroBalance): QuotaWindow {
  const percent = info.limit > 0 ? Math.min(100, Math.round((info.used / info.limit) * 100)) : 0;
  return {
    key: 'kiro',
    label: '本月',
    percent,
    severity: percent >= 100 ? 'critical' : percent >= 80 ? 'warning' : 'normal',
    resetsAt: info.resetsAt,
    value: `${fmtNum(info.used)} / ${fmtNum(info.limit)}`,
  };
}

/** 最先重置的窗口（没有重置时间的排最后；同时重置时取靠前的） */
export function nearestWindow(ws: QuotaWindow[]): QuotaWindow | null {
  let best: QuotaWindow | null = null;
  for (const w of ws) {
    if (!best || (w.resetsAt ?? Infinity) < (best.resetsAt ?? Infinity)) best = w;
  }
  return best;
}

/** 读屏用的完整说明：「Claude · GPT 5h 63% · 1小时30分后重置」 */
export function windowTip(w: QuotaWindow, now?: number): string {
  const r = resetShort(w.resetsAt, now);
  return `${w.group ? `${w.group} ` : ''}${w.label} ${w.value ?? `${w.percent}%`}${r ? ` · ${r}` : ''}`;
}

function Bar({ percent, label, text }: { percent: number; label: string; text?: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <span
      className="cz-acctq__track"
      role="progressbar"
      aria-label={label}
      aria-valuenow={p}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={text}
    >
      <span className="cz-acctq__fill" style={{ '--p': p / 100 } as CSSProperties} />
    </span>
  );
}

/** 弹层里的一行：窗口名 ━━━ 百分比；loading 时是一条细骨架 */
export function QuotaBrief({ win, loading, now }: { win: QuotaWindow | null; loading?: boolean; now?: number }) {
  if (loading) return <span className="cz-acctq-brief cz-acctq-brief--loading" aria-hidden="true" data-testid="quota-skeleton" />;
  if (!win) return null;
  return (
    <span className={`cz-acctq-brief cz-acctq__line is-${win.severity}`}>
      <span className="cz-acctq__name">{win.label}</span>
      <Bar percent={win.percent} label={`${win.group ? `${win.group} ` : ''}${win.label}已用`} text={windowTip(win, now)} />
      <span className="cz-acctq__pct">{win.percent}%</span>
    </span>
  );
}

function Line({ w, now }: { w: QuotaWindow; now?: number }) {
  const reset = resetShort(w.resetsAt, now);
  return (
    <span className={`cz-acctq__line is-${w.severity}${w.value ? ' is-value' : ''}`}>
      <span className="cz-acctq__name" title={w.label}>{w.label}</span>
      <Bar percent={w.percent} label={`${w.group ? `${w.group} ` : ''}${w.label}已用`} />
      <span className="cz-acctq__pct">{w.value ?? `${w.percent}%`}</span>
      <span className="cz-acctq__reset" title={reset || undefined}>
        <span className="cz-acctq__dot"> · </span>
        {reset}
      </span>
    </span>
  );
}

/** 管理面板卡片里的全部窗口，一条一行；有模型组时按组加小标题 */
export function QuotaLines({ windows, now }: { windows: QuotaWindow[]; now?: number }) {
  const out: ReactNode[] = [];
  let group: string | undefined;
  for (const w of windows) {
    if (w.group && w.group !== group) out.push(<span key={`g:${w.group}`} className="cz-acctq__grp-name">{w.group}</span>);
    group = w.group;
    out.push(<Line key={w.key} w={w} now={now} />);
  }
  return <span className="cz-acctq-lines">{out}</span>;
}

function LinesSkeleton() {
  return (
    <span className="cz-acctq-lines cz-acctq-lines--loading" aria-hidden="true" data-testid="quota-skeleton">
      <span className="cz-acctq__skel" />
      <span className="cz-acctq__skel" />
    </span>
  );
}

/** Claude 订阅账号的全部额度（管理面板） */
export function AccountQuota({ state, now }: { state: QuotaState; now?: number }) {
  if (state.status === 'loading') return <LinesSkeleton />;
  if (state.status !== 'ok') {
    return <span className="cz-acctq__hint">{state.status === 'fail' ? '额度读取失败' : '暂无额度信息'}</span>;
  }
  return <QuotaLines windows={claudeWindows(state.info)} now={now} />;
}

/** Antigravity 账号的全部额度（管理面板） */
export function AgyQuotaView({ quota, now }: { quota: AgyQuota; now?: number }) {
  return <QuotaLines windows={agyWindows(quota)} now={now} />;
}

/** Kiro 账号的额度（管理面板）；失败时显示「额度读取失败」 */
export function KiroQuotaView({ state, now }: { state: KiroBalanceState; now?: number }) {
  if (state.status === 'loading') return <LinesSkeleton />;
  if (state.status !== 'ok') return <span className="cz-acctq__hint">额度读取失败</span>;
  return <QuotaLines windows={[kiroWindow(state.info)]} now={now} />;
}
