// 动效演示页：http://127.0.0.1:5173/?dev=motion
// 把十种交互动效放在一页里看：其中停靠栏、拖动网格、3D 轮播在主界面里没有对应位置，只在这里演示；
// 其余几种（胶囊、聚光、流光、原位展开、数据唤醒、骨架、粘性融合）主界面已经在用，这里是同一份实现。
// 「弹窗卡片」一节：模态卡片（原位展开）、锚定气泡、提问 / 计划面板的出现与消失，用的都是主界面的组件和样式。
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import type { PendingPrompt, Turn } from '@cosyee/shared';
import '../styles/tokens.css';
import { doneTurn, interruptedTurn } from '../mock/flow';
import { ConversationView } from '../ui/flow/ConversationView';
import { FlowSkeleton, useFlowSkeleton } from '../ui/flow/FlowSkeleton';
import { Icon, type IconName } from '../ui/icons/Icon';
import { CountUp } from '../ui/motion/CountUp';
import { GooeyIndicator } from '../ui/motion/GooeyIndicator';
import { LiquidCapsule } from '../ui/motion/LiquidCapsule';
import { useMorph } from '../ui/motion/morph';
import { PromptPanel } from '../ui/prompt/PromptPanel';
import { ConfirmActionButton } from '../ui/sidebar/ActionButtons';
import '../ui/sidebar/Sidebar.css';
import { motionOK } from '../ui/motion/reduced';
import './motion.css';

/* ───────── 公用：阻尼弹簧 → CSS linear() 缓动 ───────── */

function spring(t: number, zeta: number) {
  const w = 4 / zeta;
  const wd = w * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + ((zeta * w) / wd) * Math.sin(wd * t));
}
const SPRING_EASE = (() => {
  const pts = Array.from({ length: 41 }, (_, i) => (i === 40 ? 1 : spring(i / 40, 0.55)).toFixed(4));
  const css = `linear(${pts.join(', ')})`;
  return typeof CSS !== 'undefined' && CSS.supports('transition-timing-function', css) ? css : 'cubic-bezier(.2, .9, .3, 1.25)';
})();

/* ───────── 顶栏：两组粘性融合分段（主题、动效） ───────── */

function Seg<T extends string>({ label, value, options, onChange }: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="mx-seg" role="radiogroup" aria-label={label}>
      <GooeyIndicator activeKey={value} selector=".mx-seg__btn.is-on" />
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          className={`mx-seg__btn${value === o.value ? ' is-on' : ''}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ───────── 1. 液态玻璃胶囊 ───────── */

const LIST = ['今日概览', '会话记录', '工作区', '技能', '账号与额度'];

function CapsuleList() {
  const [active, setActive] = useState(1);
  return (
    <div className="mx-list" role="listbox" aria-label="液态玻璃胶囊演示">
      <LiquidCapsule activeKey={String(active)} selector=".mx-list__row.is-active" />
      {LIST.map((t, i) => (
        <button
          key={t}
          type="button"
          role="option"
          aria-selected={i === active}
          className={`mx-list__row${i === active ? ' is-active' : ''}`}
          onClick={() => setActive(i)}
        >
          {t}
        </button>
      ))}
    </div>
  );
}

/* ───────── 2–4. 聚光卡片（含倾斜）、边缘流光、原位展开 ───────── */

const CARDS = [
  { id: 'a', title: '上下文用量', body: '本轮已用 31.5k / 200k，缓存命中 94%。', more: '上下文窗口接近上限时会自动压缩历史；命中缓存的部分按更低的价格计费。' },
  { id: 'b', title: '工作区', body: 'F:/Cosyee · 3 个会话执行中。', more: '每个工作区独立记录会话与权限设置，可以在侧栏里拖动排序或固定到顶部。' },
  { id: 'c', title: '正在执行', body: '重构 reducer，读取 14 个文件…', more: '边缘流光表示这张卡片对应的任务仍在运行，结束后流光淡出，边框回到静止色。' },
];

function Detail({ card, onClose }: { card: (typeof CARDS)[number]; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true });
  const close = useCallback(() => requestClose(onClose), [requestClose, onClose]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    panelRef.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div ref={scrimRef} className="mx-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panelRef} className="mx-detail" role="dialog" aria-modal="true" aria-label={card.title}>
        <div className="mx-detail__head">
          <h3>{card.title}</h3>
          <button type="button" className="mx-icon-btn" aria-label="关闭" onClick={close}><Icon name="close" size={16} /></button>
        </div>
        <p>{card.body}</p>
        <p className="mx-muted">{card.more}</p>
      </div>
    </div>
  );
}

function SpotCards() {
  const [open, setOpen] = useState<string | null>(null);
  const [running, setRunning] = useState(true);
  const card = CARDS.find((c) => c.id === open);
  return (
    <>
      <div className="mx-cards">
        {CARDS.map((c) => (
          <button key={c.id} type="button" className="mx-card cz-spot cz-tilt" onClick={() => setOpen(c.id)}>
            {c.id === 'c' && <span className={`cz-beam${running ? ' is-on' : ''}`} aria-hidden="true" />}
            <span className="mx-card__title">{c.title}</span>
            <span className="mx-card__body">{c.body}</span>
            <span className="mx-card__more">点开看详情</span>
          </button>
        ))}
      </div>
      <label className="mx-check">
        <input type="checkbox" checked={running} onChange={(e) => setRunning(e.target.checked)} /> 第三张卡片「执行中」（边缘流光）
      </label>
      {card && <Detail card={card} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ───────── 弹窗卡片 ───────── */

/** 模态卡片：和「添加账号」对话框同一套样式与原位展开 */
function DemoDialog({ onClose }: { onClose: () => void }) {
  const scrimRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const { requestClose } = useMorph(panelRef, { scrimRef, restoreFocus: true });
  const close = useCallback(() => requestClose(onClose), [requestClose, onClose]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    panelRef.current?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
    return () => document.removeEventListener('keydown', onKey);
  }, [close]);
  return (
    <div ref={scrimRef} className="cz-acct-dlg__scrim cz-modal-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div ref={panelRef} className="cz-acct-dlg cz-modal" role="dialog" aria-modal="true" aria-label="添加账号">
        <div className="cz-acct-dlg__title">添加账号</div>
        <p className="cz-acct-dlg__text">点「登录」后会打开浏览器，用另一个账号登录即可。skill、MCP、设置和会话历史所有账号通用。</p>
        <label className="cz-acct-dlg__field">
          <span>备注名（可选）</span>
          <input className="cz-acct-dlg__input" placeholder="例如：工作 / 个人" />
        </label>
        <div className="cz-acct-dlg__btns">
          <button type="button" className="cz-acct-dlg__btn" onClick={close}>取消</button>
          <button type="button" className="cz-acct-dlg__btn cz-acct-dlg__btn--primary" onClick={close}>登录</button>
        </div>
      </div>
    </div>
  );
}

let promptSeq = 0;
function fakePrompt(kind: 'question' | 'plan'): PendingPrompt {
  const id = `p${++promptSeq}`;
  if (kind === 'plan') {
    return { kind: 'plan', id, at: Date.now(), plan: ['## 计划', '1. 给弹窗加入场 / 退场动效', '2. 在演示页里逐个检查', '3. 跑测试'].join('\n'), planFilePath: 'C:/Users/me/.claude/plans/demo.md' };
  }
  return {
    kind: 'question',
    id,
    at: Date.now(),
    questions: [{
      question: `第 ${promptSeq} 个问题：先改哪一块？`,
      header: '范围',
      options: [
        { label: '模态对话框', description: '账号登录、文件选择' },
        { label: '小气泡', description: '删除确认、额度面板' },
        { label: '提问面板', description: '就是这一块' },
      ],
    }],
  };
}

function PopupCards() {
  const [dlg, setDlg] = useState(false);
  const [prompts, setPrompts] = useState<PendingPrompt[]>([]);
  const add = (kind: 'question' | 'plan') => setPrompts((ps) => [...ps, fakePrompt(kind)]);
  return (
    <>
      <div className="mx-row">
        <button type="button" className="mx-btn" onClick={() => setDlg(true)}>打开对话框</button>
        <span className="mx-row mx-muted">
          删除确认气泡
          <ConfirmActionButton icon="close" label="删除会话" confirmText="删除这个会话？" note="删除后可以在回收站里恢复" onConfirm={() => {}} />
        </span>
        <button type="button" className="mx-btn" onClick={() => add('question')}>来一个提问</button>
        <button type="button" className="mx-btn" onClick={() => add('plan')}>来一个计划</button>
      </div>
      <div className="mx-prompt">
        <PromptPanel items={prompts} onReply={(id) => setPrompts((ps) => ps.filter((p) => p.id !== id))} />
        <div className="mx-prompt__composer mx-muted">（输入框位置）</div>
      </div>
      {dlg && <DemoDialog onClose={() => setDlg(false)} />}
    </>
  );
}

/* ───────── 6. 数据唤醒 ───────── */

const SERIES = [12, 18, 15, 24, 22, 31, 28, 36, 34, 42, 39, 48];
const ROWS = [
  { name: 'Opus', v: 62 },
  { name: 'Sonnet', v: 28 },
  { name: 'Haiku', v: 10 },
];
const int = (n: number) => Math.round(n).toLocaleString('zh-CN');
const pct = (n: number) => `${Math.round(n)}%`;
const usd = (n: number) => `$${n.toFixed(2)}`;

/** 挂载即播放一次；换 key 重新挂载就是重播 */
function WakeStats() {
  const play = true;
  // 和卡片内容宽度一致，按比例缩放即可，不用 preserveAspectRatio="none"（会把圆点压扁、让描边粗细不均）
  const w = 470;
  const h = 72;
  const max = Math.max(...SERIES);
  const pts = SERIES.map((v, i) => [(i / (SERIES.length - 1)) * w, h - (v / max) * (h - 6) - 3] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <div className="mx-wake">
      <div className="mx-wake__kpis">
        <div className="mx-wake__kpi"><span className="mx-muted">本周会话</span><CountUp className="mx-wake__num" value={1284} format={int} play={play} duration={1100} /></div>
        <div className="mx-wake__kpi"><span className="mx-muted">缓存命中</span><CountUp className="mx-wake__num" value={94} format={pct} play={play} duration={1100} delay={80} /></div>
        <div className="mx-wake__kpi"><span className="mx-muted">花费</span><CountUp className="mx-wake__num" value={37.42} format={usd} play={play} duration={1100} delay={160} /></div>
      </div>
      <svg className="mx-wake__chart" viewBox={`0 0 ${w} ${h}`} aria-label="近 12 天会话数，持续上升" role="img">
        <path className="mx-wake__area" d={area} />
        <path className="mx-wake__line" d={line} pathLength={1} />
        <circle className="mx-wake__dot" cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={3.5} />
      </svg>
      <ul className="mx-wake__rows">
        {ROWS.map((r, i) => (
          <li key={r.name} style={{ '--i': i } as CSSProperties}>
            <span>{r.name}</span>
            <span className="mx-wake__bar"><i style={{ width: `${r.v}%` }} /></span>
            <CountUp className="mx-wake__val" value={r.v} format={pct} play={play} duration={900} delay={420 + i * 90} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────── 7. 模块拖动 ───────── */

const MODULES: { id: string; title: string; icon: IconName }[] = [
  { id: 'm1', title: '会话', icon: 'new-chat' },
  { id: 'm2', title: '工作区', icon: 'folder' },
  { id: 'm3', title: '技能', icon: 'wand' },
  { id: 'm4', title: '终端', icon: 'terminal' },
  { id: 'm5', title: '搜索', icon: 'search' },
  { id: 'm6', title: '分支', icon: 'branch' },
  { id: 'm7', title: '图片', icon: 'image' },
  { id: 'm8', title: '设置', icon: 'settings' },
];
const COLS = 4;

function move<T>(list: T[], from: number, to: number): T[] {
  const next = list.slice();
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x);
  return next;
}

// DOM 顺序固定不动，排列靠 CSS order：重排时不移动节点，指针捕获和焦点都不会丢
function DragGrid() {
  const [order, setOrder] = useState(() => MODULES.map((m) => m.id));
  const [dragId, setDragId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const els = useRef(new Map<string, HTMLElement>());
  const before = useRef<Map<string, DOMRect> | null>(null);
  const drag = useRef<{ id: string; gx: number; gy: number; cx: number; cy: number } | null>(null);
  // 一帧里可能来好几次 pointermove，用 ref 拿最新顺序，避免基于旧顺序重排
  const orderRef = useRef(order);
  orderRef.current = order;

  const reorder = (id: string, to: number) => {
    const cur = orderRef.current;
    const from = cur.indexOf(id);
    if (from === to || to < 0 || to >= cur.length) return;
    snapshot();
    const next = move(cur, from, to);
    orderRef.current = next;
    setOrder(next);
  };

  /** 让被拖的那块跟着指针（相对它当前所在的格子） */
  const follow = useCallback(() => {
    const d = drag.current;
    const grid = gridRef.current;
    const el = d && els.current.get(d.id);
    if (!d || !grid || !el) return;
    const g = grid.getBoundingClientRect();
    const x = d.cx - g.left - grid.clientLeft - d.gx - el.offsetLeft;
    const y = d.cy - g.top - grid.clientTop - d.gy - el.offsetTop;
    el.style.transform = `translate(${x}px, ${y}px)`;
  }, []);

  const snapshot = () => {
    const m = new Map<string, DOMRect>();
    for (const [id, el] of els.current) m.set(id, el.getBoundingClientRect());
    before.current = m;
  };

  // 顺序变了：其它模块从原来看到的位置弹到新格子（FLIP），被拖的那块继续跟手
  useLayoutEffect(() => {
    const prev = before.current;
    before.current = null;
    if (!prev) return;
    for (const [id, el] of els.current) {
      if (id === drag.current?.id) { follow(); continue; }
      const p = prev.get(id);
      if (!p) continue;
      for (const a of el.getAnimations()) a.cancel();
      const n = el.getBoundingClientRect();
      const dx = p.left - n.left;
      const dy = p.top - n.top;
      if ((Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) || !motionOK()) continue;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 460, easing: SPRING_EASE });
    }
  }, [order, follow]);

  const onDown = (id: string) => (e: RPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    const el = els.current.get(id);
    if (!el) return;
    for (const a of el.getAnimations()) a.cancel();
    const r = el.getBoundingClientRect();
    drag.current = { id, gx: e.clientX - r.left, gy: e.clientY - r.top, cx: e.clientX, cy: e.clientY };
    el.setPointerCapture(e.pointerId);
    setDragId(id);
    follow();
  };

  const onMove = (e: RPointerEvent<HTMLElement>) => {
    const d = drag.current;
    const grid = gridRef.current;
    if (!d || !grid) return;
    d.cx = e.clientX;
    d.cy = e.clientY;
    follow();
    // 指针落在哪个格子上（按布局位置判断，不受动画中的 transform 影响）
    const g = grid.getBoundingClientRect();
    const px = e.clientX - g.left - grid.clientLeft;
    const py = e.clientY - g.top - grid.clientTop;
    for (const [id, el] of els.current) {
      if (id === d.id) continue;
      if (px >= el.offsetLeft && px < el.offsetLeft + el.offsetWidth && py >= el.offsetTop && py < el.offsetTop + el.offsetHeight) {
        reorder(d.id, orderRef.current.indexOf(id));
        break;
      }
    }
  };

  const onUp = () => {
    const d = drag.current;
    if (!d) return;
    const el = els.current.get(d.id);
    drag.current = null;
    setDragId(null);
    if (!el) return;
    const from = el.style.transform;
    el.style.transform = '';
    // 松手：从当前位置弹回格子
    if (from && motionOK()) el.animate([{ transform: from }, { transform: 'none' }], { duration: 520, easing: SPRING_EASE });
  };

  // 键盘：方向键在格子间移动
  const onKey = (id: string) => (e: KeyboardEvent<HTMLElement>) => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -COLS, ArrowDown: COLS }[e.key];
    if (!step) return;
    e.preventDefault();
    reorder(id, orderRef.current.indexOf(id) + step);
  };

  return (
    <div ref={gridRef} className="mx-grid" style={{ '--cols': COLS } as CSSProperties}>
      {MODULES.map((m) => {
        const id = m.id;
        const pos = order.indexOf(id);
        return (
          <div
            key={id}
            ref={(el) => { if (el) els.current.set(id, el); else els.current.delete(id); }}
            className={`mx-grid__slot${dragId === id ? ' is-dragging' : ''}`}
            style={{ order: pos }}
            tabIndex={0}
            role="button"
            aria-roledescription="可拖动模块"
            aria-label={`${m.title}，第 ${pos + 1} 位`}
            onPointerDown={onDown(id)}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            onLostPointerCapture={onUp}
            onKeyDown={onKey(id)}
          >
            <div className="mx-tile">
              <Icon name={m.icon} size={18} />
              <span>{m.title}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────── 8. 信息流加载 ───────── */

const SKEL_TURNS: Turn[] = [interruptedTurn, doneTurn];

function FeedLoading() {
  const [loading, setLoading] = useState(true);
  const skeleton = useFlowSkeleton(loading);
  useEffect(() => {
    if (!loading) return;
    const t = window.setTimeout(() => setLoading(false), 1800);
    return () => window.clearTimeout(t);
  }, [loading]);
  return (
    <>
      <div className="mx-feed">
        {!loading && <ConversationView turns={SKEL_TURNS} reveal={skeleton.reveal} />}
        {skeleton.phase !== 'off' && <FlowSkeleton leaving={skeleton.phase === 'leaving'} />}
      </div>
      <button type="button" className="mx-btn" disabled={loading} onClick={() => setLoading(true)}>重新加载</button>
    </>
  );
}

/* ───────── 9. 3D Cover Flow ───────── */

const COVERS = [
  { title: '晨雾', sub: '早上 7:40 · 西湖', glyph: '雾', hue: 210 },
  { title: '旧书店', sub: '下午 3:15 · 南山路', glyph: '书', hue: 40 },
  { title: '雨后', sub: '傍晚 6:02 · 龙井村', glyph: '雨', hue: 160 },
  { title: '灯火', sub: '晚上 9:30 · 河坊街', glyph: '灯', hue: 20 },
  { title: '夜航', sub: '凌晨 1:12 · 钱塘江', glyph: '航', hue: 250 },
  { title: '茶山', sub: '上午 10:20 · 梅家坞', glyph: '茶', hue: 120 },
  { title: '归途', sub: '晚上 8:05 · 杭州东站', glyph: '归', hue: 330 },
];

function coverStyle(o: number): CSSProperties {
  const a = Math.abs(o);
  const s = Math.sign(o);
  if (a === 0) return { transform: 'translate3d(0, 0, 60px)', zIndex: 10 };
  return {
    transform: `translate3d(${s * (128 + (a - 1) * 64)}px, 0, -${80 + a * 40}px) rotateY(${-s * 52}deg)`,
    zIndex: 10 - a,
    opacity: a > 3 ? 0 : 1,
    filter: `brightness(${1 - a * 0.14})`,
  };
}

function CoverFlow() {
  const [active, setActive] = useState(3);
  const go = (i: number) => setActive(Math.max(0, Math.min(COVERS.length - 1, i)));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(active - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); go(active + 1); }
  };
  return (
    <div className="mx-flow" role="group" aria-roledescription="轮播" aria-label="3D Cover Flow">
      {COVERS.map((c, i) => (
        <div key={c.title} className={`mx-flow__bg${i === active ? ' is-on' : ''}`} style={{ '--h': c.hue } as CSSProperties} aria-hidden="true" />
      ))}
      <div className="mx-flow__stage" tabIndex={0} onKeyDown={onKey} aria-label="左右方向键切换">
        {COVERS.map((c, i) => (
          <button
            key={c.title}
            type="button"
            tabIndex={-1}
            className={`mx-flow__cover${i === active ? ' is-on' : ''}`}
            style={{ ...coverStyle(i - active), '--h': c.hue } as CSSProperties}
            aria-label={c.title}
            aria-current={i === active || undefined}
            onClick={() => go(i)}
          >
            <span className="mx-flow__glyph">{c.glyph}</span>
          </button>
        ))}
      </div>
      <div className="mx-flow__caption" aria-live="polite">
        {COVERS.map((c, i) => (
          <div key={c.title} className={`mx-flow__title${i === active ? ' is-on' : i < active ? ' is-before' : ''}`} aria-hidden={i !== active}>
            <strong>{c.title}</strong>
            <span>{c.sub}</span>
          </div>
        ))}
      </div>
      <div className="mx-flow__nav">
        <button type="button" className="mx-icon-btn" aria-label="上一张" disabled={active === 0} onClick={() => go(active - 1)}>
          <Icon name="chevron-right" size={16} className="mx-flip" />
        </button>
        <span className="mx-muted">{active + 1} / {COVERS.length}</span>
        <button type="button" className="mx-icon-btn" aria-label="下一张" disabled={active === COVERS.length - 1} onClick={() => go(active + 1)}>
          <Icon name="chevron-right" size={16} />
        </button>
      </div>
    </div>
  );
}

/* ───────── 5. 玻璃停靠栏 ───────── */

const DOCK: { id: string; label: string; icon: IconName }[] = [
  { id: 'sec-capsule', label: '液态胶囊', icon: 'check' },
  { id: 'sec-cards', label: '聚光卡片', icon: 'maximize' },
  { id: 'sec-wake', label: '数据唤醒', icon: 'refresh' },
  { id: 'sec-drag', label: '模块拖动', icon: 'folder' },
  { id: 'sec-feed', label: '信息流加载', icon: 'file' },
  { id: 'sec-flow', label: '3D 轮播', icon: 'image' },
  { id: 'sec-goo', label: '粘性融合', icon: 'wand' },
  { id: 'sec-popup', label: '弹窗卡片', icon: 'new-chat' },
];
const DOCK_BASE = 44;
const DOCK_GAP = 6;
const DOCK_MAX = 1.55;
const DOCK_RANGE = 150;

function Dock() {
  const ref = useRef<HTMLElement>(null);
  const raf = useRef(0);
  const px = useRef<number | null>(null);

  const apply = () => {
    raf.current = 0;
    const dock = ref.current;
    if (!dock) return;
    const btns = Array.from(dock.querySelectorAll<HTMLElement>('.mx-dock__btn'));
    const x = px.current;
    // 以停靠栏中心为原点、按未放大时的位置算距离（放大后整体变宽，但中心不动），避免越放越偏
    const r = dock.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const n = btns.length;
    btns.forEach((b, i) => {
      let s = 1;
      if (x !== null) {
        const d = Math.abs(x - (cx + (i - (n - 1) / 2) * (DOCK_BASE + DOCK_GAP)));
        if (d < DOCK_RANGE) s = 1 + (DOCK_MAX - 1) * (Math.cos((Math.PI * d) / DOCK_RANGE) + 1) / 2;
      }
      b.style.setProperty('--s', s.toFixed(3));
    });
    dock.classList.toggle('is-hover', x !== null);
  };

  const onMove = (e: RPointerEvent) => {
    if (e.pointerType === 'touch' || !motionOK()) return;
    px.current = e.clientX;
    if (!raf.current) raf.current = requestAnimationFrame(apply);
  };
  const onLeave = () => {
    px.current = null;
    if (!raf.current) raf.current = requestAnimationFrame(apply);
  };
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  return (
    <nav ref={ref} className="mx-dock" aria-label="演示目录" onPointerMove={onMove} onPointerLeave={onLeave}>
      {DOCK.map((d) => (
        <a key={d.id} href={`#${d.id}`} className="mx-dock__btn" aria-label={d.label}>
          <span className="mx-dock__label" aria-hidden="true">{d.label}</span>
          <span className="mx-dock__icon"><Icon name={d.icon} size={20} /></span>
        </a>
      ))}
    </nav>
  );
}

/* ───────── 页面 ───────── */

type Theme = 'dark' | 'light';
type Motion = 'full' | 'reduce';

function Section({ id, n, title, note, children }: { id: string; n: string; title: string; note: string; children: React.ReactNode }) {
  return (
    <section id={id} className="mx-sec">
      <header className="mx-sec__head">
        <span className="mx-sec__n">{n}</span>
        <h2>{title}</h2>
        <p className="mx-muted">{note}</p>
      </header>
      {children}
    </section>
  );
}

export default function MotionDev() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'));
  const [motion, setMotion] = useState<Motion>(() => (document.documentElement.dataset.motion === 'reduce' ? 'reduce' : 'full'));
  const [wakeSeed, setWakeSeed] = useState(0);
  const [tab, setTab] = useState<'day' | 'week' | 'month'>('week');

  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  useLayoutEffect(() => {
    if (motion === 'reduce') document.documentElement.dataset.motion = 'reduce';
    else delete document.documentElement.dataset.motion;
  }, [motion]);

  return (
    <div className="mx-page">
      <header className="mx-top">
        <h1>交互动效</h1>
        <div className="mx-top__ctl">
          <Seg label="主题" value={theme} onChange={setTheme} options={[{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }]} />
          <Seg label="动效" value={motion} onChange={setMotion} options={[{ value: 'full', label: '完整动效' }, { value: 'reduce', label: '减少动效' }]} />
        </div>
      </header>

      <Section id="sec-capsule" n="01" title="液态玻璃胶囊" note="切换选中项时，胶囊前沿先拉向新项，后沿跟上，两端轻轻回弹。主界面：侧栏会话列表。">
        <CapsuleList />
      </Section>

      <Section id="sec-cards" n="02–04" title="聚光卡片 · 边缘流光 · 原位展开" note="指针处有一团柔光并照亮附近边框，卡片朝指针倾斜不超过 4°；第三张带流光；点开从卡片原位长出，关闭收回原处。">
        <SpotCards />
      </Section>

      <Section id="sec-wake" n="06" title="数据唤醒" note="数字从 0 缓出滚到目标值，折线从左到右画出，各行依次出现，之后保持静止。主界面：右侧上下文面板。">
        <WakeStats key={wakeSeed} />
        <button type="button" className="mx-btn" onClick={() => setWakeSeed((s) => s + 1)}>重播</button>
      </Section>

      <Section id="sec-drag" n="07" title="模块拖动" note="按住抬起放大，拖到别的格子上其它模块让位重排，松手弹回格子；可以跨行跨列。键盘：聚焦后用方向键移动。">
        <DragGrid />
      </Section>

      <Section id="sec-feed" n="08" title="信息流加载" note="骨架按真实内容的形状排布，共用一道每 1.5 秒扫过的斜光；数据到达后骨架淡出，内容自上而下每块间隔 60ms 浮现。主界面：打开历史会话时。">
        <FeedLoading />
      </Section>

      <Section id="sec-flow" n="09" title="3D Cover Flow" note="中间一张放大居前，两侧向内转；背景色和标题随中心项同步过渡。">
        <CoverFlow />
      </Section>

      <Section id="sec-goo" n="10" title="粘性融合" note="指示器从旧位置拉出，中间有一道液桥，约 0.6 秒收拢成圆角胶囊，文字始终清晰。主界面：账号菜单里的模式切换；本页顶部两组切换也是它。">
        <Seg label="时间范围" value={tab} onChange={setTab} options={[{ value: 'day', label: '今天' }, { value: 'week', label: '本周' }, { value: 'month', label: '本月' }]} />
      </Section>

      <Section id="sec-popup" n="04+" title="弹窗卡片" note="对话框从按钮原位长出、关闭缩回，遮罩模糊同步淡入淡出；气泡从按钮那一角长出；提问面板从输入框上沿浮起，换项交叉淡入，回答完下沉淡出。快速连点时从当前状态接续。">
        <PopupCards />
      </Section>

      <Dock />
    </div>
  );
}
