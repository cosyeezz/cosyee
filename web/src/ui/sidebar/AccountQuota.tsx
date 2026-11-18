// 账号菜单里每个账号的额度：每条限制一行进度条 + 「会话 32% · 2小时14分后重置」。
// 颜色阈值沿用输入框里的额度面板（severity：normal / warning / critical → 主题色 / 警告色 / 危险色）。
import type { UsageInfo } from '@cosyee/shared';
import { limitLine } from '../usage/format';

/** loading：还没有结果；ok：info 有数据；none：服务端没有额度信息；fail：读取失败 */
export type QuotaState = { status: 'loading' } | { status: 'ok'; info: UsageInfo } | { status: 'none' } | { status: 'fail' };

export function AccountQuota({ state }: { state: QuotaState }) {
  if (state.status === 'loading') {
    return (
      <span className="cz-acctq cz-acctq--loading" aria-hidden="true" data-testid="quota-skeleton">
        <span className="cz-acctq__skel" />
        <span className="cz-acctq__skel cz-acctq__skel--short" />
      </span>
    );
  }
  if (state.status !== 'ok') {
    return <span className="cz-acctq__hint">{state.status === 'fail' ? '额度读取失败' : '暂无额度信息'}</span>;
  }
  return (
    <span className="cz-acctq">
      {state.info.limits.map((l, i) => (
        <span key={`${l.kind}:${l.model ?? ''}:${i}`} className={`cz-acctq__row is-${l.severity}`}>
          <span className="cz-acctq__text">{limitLine(l)}</span>
          <span className="cz-acctq__track" role="progressbar" aria-valuenow={l.percent} aria-valuemin={0} aria-valuemax={100}>
            <span className="cz-acctq__fill" style={{ width: `${l.percent}%` }} />
          </span>
        </span>
      ))}
    </span>
  );
}
