// 账号菜单里每个账号的额度，排成两列（额度区太窄时一列）。每条额度统一排成一行「名称 ━━━ 百分比」，
// 重置时间作为它下面的一行小字直接显示（resetsAt 为 null 时不渲染该行）：
// - Claude：每条限制一块，进度行 + 重置时间行；
// - Antigravity：每组共享额度的模型一块（Gemini / Claude · GPT），组名下面 5 小时与本周各自带进度行 + 重置时间行。
// 颜色阈值沿用输入框里的额度面板（severity：normal / warning / critical → 主题色 / 警告色 / 危险色）。
// 进度条第一次出现时从 0 长到目标值（transform: scaleX + @starting-style），数据刷新时从当前值平滑过渡，减少动态效果时不动。
// 读屏和复制得到的仍是「会话 32% · 2小时14分后重置」：中间的空格与「 · 」视觉上隐藏，重置说明直接可见。
import type { CSSProperties } from 'react';
import type { AgyQuota, AgyQuotaBucket, KiroBalance, UsageInfo, UsageSeverity } from '@cosyee/shared';
import { limitShortTitle, resetShort } from '../usage/format';

/** loading：还没有结果；ok：info 有数据；none：服务端没有额度信息；fail：读取失败 */
export type QuotaState = { status: 'loading' } | { status: 'ok'; info: UsageInfo } | { status: 'none' } | { status: 'fail' };

/** Kiro 额度状态 */
export type KiroBalanceState = { status: 'loading' } | { status: 'ok'; info: KiroBalance } | { status: 'fail' };

function Bar({ percent, label }: { percent: number; label: string }) {
  const p = Math.max(0, Math.min(100, percent));
  return (
    <span
      className="cz-acctq__track"
      role="progressbar"
      aria-label={label}
      aria-valuenow={p}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className="cz-acctq__fill" style={{ '--p': p / 100 } as CSSProperties} />
    </span>
  );
}

export function AccountQuota({ state, now }: { state: QuotaState; now?: number }) {
  if (state.status === 'loading') {
    return (
      <span className="cz-acctq cz-acctq--loading" aria-hidden="true" data-testid="quota-skeleton">
        <span className="cz-acctq__skel" />
        <span className="cz-acctq__skel" />
      </span>
    );
  }
  if (state.status !== 'ok') {
    return <span className="cz-acctq__hint">{state.status === 'fail' ? '额度读取失败' : '暂无额度信息'}</span>;
  }
  return (
    <span className="cz-acctq">
      {state.info.limits.map((l, i) => {
        const name = limitShortTitle(l);
        const reset = resetShort(l.resetsAt, now);
        return (
          <span
            key={`${l.kind}:${l.model ?? ''}:${i}`}
            className={`cz-acctq__row is-${l.severity}`}
          >
            <span className="cz-acctq__line">
              <span className="cz-acctq__name" title={name}>{name}</span>
              <span className="cz-acctq__gap"> </span>
              <Bar percent={l.percent} label={`${name}已用`} />
              <span className="cz-acctq__pct">{l.percent}%</span>
            </span>
            {reset && (
              <span className="cz-acctq__reset">
                <span className="cz-acctq__dot"> · </span>
                {reset}
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

const WINDOW_SHORT: Record<string, string> = { '5h': '5h', weekly: '本周' };
const WINDOW_LONG: Record<string, string> = { '5h': '5 小时', weekly: '本周' };
const SEV_RANK: Record<UsageSeverity, number> = { normal: 0, warning: 1, critical: 2 };

const worst = (bs: AgyQuotaBucket[]): UsageSeverity =>
  bs.reduce<UsageSeverity>((a, b) => (SEV_RANK[b.severity] > SEV_RANK[a] ? b.severity : a), 'normal');

/** Antigravity 一个账号的额度：每组一块，5h / 本周各自一行进度条并在下方显示重置说明 */
export function AgyQuotaView({ quota, now }: { quota: AgyQuota; now?: number }) {
  return (
    <span className="cz-acctq cz-acctq--agy">
      {quota.groups.map((g) => (
        <span key={g.name} className={`cz-acctq__row cz-acctq__grp is-${worst(g.buckets)}`}>
          <span className="cz-acctq__name cz-acctq__grp-name" title={g.name}>{g.name}</span>
          {g.buckets.map((b) => {
            const w = WINDOW_SHORT[b.window] ?? b.window;
            const reset = resetShort(b.resetsAt, now);
            return (
              <span key={b.window} className="cz-acctq__win-item">
                <span className={`cz-acctq__line cz-acctq__win is-${b.severity}`}>
                  <span className="cz-acctq__win-name">{w}</span>
                  <Bar percent={b.percent} label={`${g.name} ${WINDOW_LONG[b.window] ?? b.window}已用`} />
                  <span className="cz-acctq__pct">{b.percent}%</span>
                </span>
                {reset && <span className="cz-acctq__reset">{reset}</span>}
              </span>
            );
          })}
        </span>
      ))}
    </span>
  );
}

const fmtBalanceNum = (n: number) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(1))));

/** Kiro 账号的额度：显示已用 / 总额度与重置时间；失败时静默显示「额度读取失败」 */
export function KiroQuotaView({ state, now }: { state: KiroBalanceState; now?: number }) {
  if (state.status === 'loading') {
    return (
      <span className="cz-acctq cz-acctq--loading" aria-hidden="true" data-testid="quota-skeleton">
        <span className="cz-acctq__skel" />
      </span>
    );
  }
  if (state.status !== 'ok') {
    return <span className="cz-acctq__hint">额度读取失败</span>;
  }
  const { used, limit, resetsAt } = state.info;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const severity: UsageSeverity = percent >= 100 ? 'critical' : percent >= 80 ? 'warning' : 'normal';
  const reset = resetShort(resetsAt, now);
  return (
    <span className="cz-acctq">
      <span className={`cz-acctq__row is-${severity}`}>
        <span className="cz-acctq__line cz-acctq__line--kiro">
          <span className="cz-acctq__name">额度</span>
          <span className="cz-acctq__gap"> </span>
          <Bar percent={percent} label="Kiro 额度已用" />
          <span className="cz-acctq__pct">{fmtBalanceNum(used)} / {fmtBalanceNum(limit)}</span>
        </span>
        {reset && (
          <span className="cz-acctq__reset">
            <span className="cz-acctq__dot"> · </span>
            {reset}
          </span>
        )}
      </span>
    </span>
  );
}
