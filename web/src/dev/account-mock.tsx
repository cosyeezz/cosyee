// 账号模块改版效果图（纯静态，不连后端）：http://127.0.0.1:5173/?dev=account-mock
// view=all|switcher|manager；w = 侧栏宽度（默认 260）；mw = 管理面板宽度（默认 760）；theme=light|dark
import { useState, type CSSProperties } from 'react';
import type { UsageSeverity } from '@cosyee/shared';
import '../styles/tokens.css';
import '../styles/motion.css';
import '../ui/layout/AppShell.css';
import '../ui/sidebar/Sidebar.css';
import './account-mock.css';
import { Icon } from '../ui/icons/Icon';
import { GooeyIndicator } from '../ui/motion/GooeyIndicator';
import { ThemeSwitch } from '../ui/sidebar/ThemeSwitch';
import { avatarColor, avatarInitial } from '../ui/sidebar/avatar';
import { planChip } from '../ui/sidebar/AccountMenu';
import { limitShortTitle, loginExpiry, resetShort, subscriptionEstimate } from '../ui/usage/format';
import { ACCOUNTS, GROUPS, NOW, usable, type MockAccount } from './account-mock-data';

const params = new URLSearchParams(location.search);
const theme = params.get('theme');
if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;

function Av({ title, on = true, size = 'sm' }: { title: string; on?: boolean; size?: 'sm' | 'md' }) {
  return (
    <span
      className={`cz-sidebar__avatar cz-sidebar__avatar--${size}${on ? '' : ' cz-sidebar__avatar--empty'}`}
      style={on ? ({ '--av': avatarColor(title) } as CSSProperties) : undefined}
      aria-hidden="true"
    >
      {on ? avatarInitial(title) : '?'}
    </span>
  );
}

const Chip = ({ plan }: { plan?: string }) => {
  const c = planChip(plan);
  return c ? <span className="cz-acct-chip" title={plan}>{c}</span> : null;
};

interface Nearest { label: string; percent: number; severity: UsageSeverity; tip: string }

/** 最先重置的那个额度窗口：Claude 各条限制 / Antigravity 各组的各窗口 / Kiro 唯一一条 */
function nearest(a: MockAccount): Nearest | null {
  if (a.usage?.limits.length) {
    const l = [...a.usage.limits].sort((x, y) => (x.resetsAt ?? Infinity) - (y.resetsAt ?? Infinity))[0]!;
    const label = l.kind === 'session' ? '5h' : limitShortTitle(l);
    return { label, percent: l.percent, severity: l.severity, tip: `${limitShortTitle(l)} ${l.percent}% · ${resetShort(l.resetsAt, NOW)}` };
  }
  if (a.quota?.groups.length) {
    const all = a.quota.groups.flatMap((g) => g.buckets.map((b) => ({ g: g.name, b })));
    const { g, b } = all.sort((x, y) => (x.b.resetsAt ?? Infinity) - (y.b.resetsAt ?? Infinity))[0]!;
    const label = b.window === '5h' ? '5h' : '本周';
    return { label, percent: b.percent, severity: b.severity, tip: `${g} ${label} ${b.percent}% · ${resetShort(b.resetsAt, NOW)}` };
  }
  if (a.kiro) {
    const p = a.kiro.limit > 0 ? Math.min(100, Math.round((a.kiro.used / a.kiro.limit) * 100)) : 0;
    return { label: '本月', percent: p, severity: p >= 100 ? 'critical' : p >= 80 ? 'warning' : 'normal', tip: `${a.kiro.used} / ${a.kiro.limit} · ${resetShort(a.kiro.resetsAt, NOW)}` };
  }
  return null;
}
const MODES = [
  { key: 'switch', label: '切换模式', tip: '同一时间只用一个账号，换账号时停止执行中的会话' },
  { key: 'parallel', label: '并行模式', tip: '每个会话用自己的账号，多个账号可以同时运行；切换只影响新会话' },
];

/** 弹层：模式切换 + 已登录账号分组列表（每个账号一条最近额度）+ 管理账号入口 + 外观 */
function Switcher({ onManage }: { onManage: () => void }) {
  const [mode, setMode] = useState('parallel');
  return (
    <div className="mk-pop cz-sidebar__menu--up">
      <div className="cz-sidebar__mode">
        <div className="cz-sidebar__seg" role="radiogroup" aria-label="账号模式">
          <GooeyIndicator activeKey={mode} selector=".cz-sidebar__seg-btn.is-on" />
          {MODES.map((m) => (
            <button key={m.key} type="button" role="radio" aria-checked={mode === m.key} title={m.tip}
              className={`cz-sidebar__seg-btn${mode === m.key ? ' is-on' : ''}`} onClick={() => setMode(m.key)}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mk-list">
        {GROUPS.map((g) => {
          const rows = ACCOUNTS.filter((a) => a.kind === g.kind && usable(a));
          if (!rows.length) return null;
          return (
            <div key={g.kind}>
              <div className="mk-grp" title={g.tip}>{g.title}</div>
              {rows.map((a) => {
                const n = nearest(a);
                return (
                  <button key={a.id} type="button" className={`mk-row${a.active ? ' is-active' : ''}${n ? '' : ' is-single'}`}>
                    <Av title={a.title} />
                    <span className="mk-name">
                      <b title={a.title}>{a.title}</b>
                      {a.kind !== 'kiro' && <Chip plan={a.plan} />}
                    </span>
                    {a.active ? <span className="mk-check"><Icon name="check" size={10} /></span> : <span />}
                    {n && (
                      <span className={`mk-bar cz-acctq__line is-${n.severity}`} title={n.tip}>
                        <span>{n.label}</span>
                        <span className="cz-acctq__track"><span className="cz-acctq__fill" style={{ '--p': n.percent / 100 } as CSSProperties} /></span>
                        <span className="cz-acctq__pct">{n.percent}%</span>
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="mk-sep" />
      <button type="button" className="mk-manage" onClick={onManage}>
        <Icon name="settings" size={14} />
        <span>管理账号</span>
        <Icon name="chevron-right" size={12} />
      </button>
      <ThemeSwitch />
    </div>
  );
}
/** 进度条一行：窗口名 ━━━ 百分比 重置时间 */
function QLine({ label, percent, severity, value, reset, kiro }: { label: string; percent: number; severity: UsageSeverity; value?: string; reset: string; kiro?: boolean }) {
  return (
    <span className={`cz-acctq__line is-${severity}${kiro ? ' is-kiro' : ''}`}>
      <span>{label}</span>
      <span className="cz-acctq__track"><span className="cz-acctq__fill" style={{ '--p': Math.min(100, percent) / 100 } as CSSProperties} /></span>
      <span className="cz-acctq__pct">{value ?? `${percent}%`}</span>
      <span className="mk-q__reset" title={reset}>{reset}</span>
    </span>
  );
}

const WIN: Record<string, string> = { '5h': '5h', weekly: '本周' };

/** 管理面板卡片里的全部额度，一条一行；Claude 的会话窗口也叫 5h，和弹层一致 */
function FullQuota({ a }: { a: MockAccount }) {
  if (a.usage?.limits.length) {
    return (
      <div className="mk-q">
        {a.usage.limits.map((l, i) => (
          <QLine key={i} label={l.kind === 'session' ? '5h' : limitShortTitle(l)} percent={l.percent} severity={l.severity} reset={resetShort(l.resetsAt, NOW)} />
        ))}
      </div>
    );
  }
  if (a.quota?.groups.length) {
    return (
      <div className="mk-q">
        {a.quota.groups.map((g) => (
          <div key={g.name} style={{ display: 'contents' }}>
            <span className="mk-q__grp">{g.name}</span>
            {g.buckets.map((b) => (
              <QLine key={b.window} label={WIN[b.window] ?? b.window} percent={b.percent} severity={b.severity} reset={resetShort(b.resetsAt, NOW)} />
            ))}
          </div>
        ))}
      </div>
    );
  }
  if (a.kiro) {
    const p = a.kiro.limit > 0 ? Math.round((a.kiro.used / a.kiro.limit) * 100) : 0;
    return (
      <div className="mk-q">
        <QLine kiro label="本月" percent={p} severity={p >= 100 ? 'critical' : p >= 80 ? 'warning' : 'normal'} value={`${a.kiro.used} / ${a.kiro.limit}`} reset={resetShort(a.kiro.resetsAt, NOW)} />
      </div>
    );
  }
  return null;
}

/** 管理面板里一张账号卡片：全部信息 + 操作 */
function Card({ a }: { a: MockAccount }) {
  const ok = usable(a);
  const exp = a.kind === 'claude' && a.loggedIn ? loginExpiry(a.loginExpiresAt, NOW) : null;
  const subEst = a.kind === 'claude' && a.loggedIn && a.plan ? subscriptionEstimate(a.subscribedAt, NOW) : null;
  const sub = [a.sub, a.host, a.running ? `${a.running} 个委派执行中` : null].filter(Boolean).join(' · ');
  const removeBlock = a.isDefault ? '默认账号不能移除' : a.active ? '不能移除当前账号' : a.running ? '有委派任务正在执行' : null;
  const status = a.active
    ? <span className="mk-badge">当前</span>
    : !a.loggedIn ? <span className="mk-badge is-danger">需要登录</span>
      : exp?.tone === 'danger' ? <span className="mk-badge is-danger">登录已失效</span> : null;
  return (
    <div className={`mk-card${a.active ? ' is-active' : ''}${ok ? '' : ' is-off'}`}>
      <div className="mk-card__top">
        <Av title={a.title} on={a.loggedIn} size="md" />
        <div style={{ minWidth: 0 }}>
          <div className="mk-card__name"><b title={a.title}>{a.title}</b><Chip plan={a.plan} /></div>
          {sub && <div className="mk-card__sub" title={sub}>{sub}</div>}
        </div>
        {status}
      </div>
      {(subEst || (exp && exp.tone !== 'danger') || a.kind === 'api') && (
        <div className="mk-meta">
          {subEst && <span title={subEst.title}>{subEst.text}</span>}
          {exp && exp.tone !== 'danger' && <span className={exp.tone === 'warn' ? 'is-warn' : undefined}>{exp.text}</span>}
          {a.kind === 'api' && <span>按量计费 · {a.mapped ? `已映射 ${a.mapped} 个模型` : '未配置模型映射'}</span>}
        </div>
      )}
      {ok && <FullQuota a={a} />}
      <div className="mk-acts">
        {!ok ? <button type="button" className="mk-btn is-primary">重新登录</button>
          : !a.active && <button type="button" className="mk-btn">切换</button>}
        {a.kind === 'api' && <button type="button" className="mk-btn">编辑</button>}
        {a.kind === 'kiro' && ok && <button type="button" className="mk-btn">重新登录</button>}
        {!a.isDefault && a.kind !== 'api' && <button type="button" className="mk-btn">改名</button>}
        <button type="button" className="mk-btn is-danger" disabled={!!removeBlock} title={removeBlock ?? undefined}>移除</button>
      </div>
    </div>
  );
}

function Manager({ width, onClose }: { width: number; onClose?: () => void }) {
  return (
    <div className="mk-dlg" style={{ width }} role="dialog" aria-label="管理账号">
      <div className="mk-dlg__head">
        <h2>管理账号</h2>
        <button type="button" className="mk-x" aria-label="关闭" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      {GROUPS.map((g) => {
        const rows = ACCOUNTS.filter((a) => a.kind === g.kind);
        return (
          <section key={g.kind} className="mk-sec">
            <div className="mk-sec__head">
              <h3>{g.title}</h3>
              <span className="mk-count">{rows.length}</span>
              <span className="mk-sec__tip" title={g.tip}>{g.tip}</span>
              <button type="button" className="mk-add"><Icon name="plus" size={12} />{g.add}</button>
            </div>
            <div className="mk-cards">{rows.map((a) => <Card key={a.id} a={a} />)}</div>
            {g.kind === 'claude' && (
              <div className="mk-note"><span>有 2 个重复的账号已隐藏</span><button type="button" className="mk-btn">清理</button></div>
            )}
            {g.kind === 'kiro' && (
              <div className="mk-note">
                <span>kiro.rs 引擎 a1b2c3d · <span style={{ color: 'var(--warn)' }}>有更新</span></span>
                <button type="button" className="mk-btn is-primary">更新</button>
                <button type="button" className="mk-btn">检查更新</button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export default function AccountMock() {
  const view = params.get('view') ?? 'all';
  const w = Number(params.get('w')) || 260;
  const mw = Number(params.get('mw')) || 760;
  const [manage, setManage] = useState(view !== 'switcher');
  const me = ACCOUNTS[0]!;
  return (
    <div className="mk-page" style={view === 'manager' ? { alignItems: 'flex-start' } : undefined}>
      {view !== 'manager' && (
        <div className="mk-side" style={{ width: w }}>
          <Switcher onManage={() => setManage(true)} />
          <div className="mk-me"><Av title={me.title} size="md" /><div><b>{me.title}</b><small>{me.plan}</small></div></div>
        </div>
      )}
      {view !== 'switcher' && manage && <Manager width={mw} onClose={() => setManage(false)} />}
    </div>
  );
}
