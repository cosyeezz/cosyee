// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BUILTIN_PRICES, type CachePoint, type ContextUsage, type Turn } from '@cosyee/shared';
import { ContextPanel, parseCompactWindow } from './ContextPanel';
import { mockContextUsage } from '../../mock/shell';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function render(el: ReactElement) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
function mount(loading: boolean) {
  return render(<ContextPanel usage={null} loading={loading} onRefresh={() => undefined} onCompact={() => undefined} />);
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const click = (el: Element | null | undefined) => {
  if (!el) throw new Error('元素不存在');
  act(() => (el as HTMLElement).click());
};
/** 按标题找到折叠按钮并展开 */
function openFold(el: HTMLElement, title: string) {
  const btn = [...el.querySelectorAll('.cz-ctx__fold')].find((b) => b.querySelector('.cz-ctx__fold-title')?.textContent === title);
  click(btn);
}

describe('ContextPanel 空态', () => {
  it('还没有用量数据时面板照常显示：读取中显示加载提示', () => {
    const el = mount(true);
    expect(el.querySelector('.cz-ctx__title')?.textContent).toBe('上下文');
    expect(el.textContent).toContain('正在读取上下文…');
  });

  it('没有数据且不在读取时显示空态与刷新按钮', () => {
    const el = mount(false);
    expect(el.textContent).toContain('暂无上下文数据');
    expect(el.querySelector('button')?.disabled).toBe(false);
  });
});

describe('ContextPanel Skills', () => {
  const mount2 = (extra: Partial<React.ComponentProps<typeof ContextPanel>> = {}) =>
    render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} {...extra} />);
  const rowOf = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll('.cz-ctx__skill')].find((r) => r.querySelector('.cz-ctx__item-name')?.textContent === name)!;

  it('Skills 在 MCP 上方；每行一个状态按钮，点开下拉选别的状态回调 onSkillMode', () => {
    const onSkillMode = vi.fn();
    const el = mount2({ onSkillMode });
    const titles = [...el.querySelectorAll('.cz-ctx__fold-title')].map((t) => t.textContent);
    expect(titles.indexOf('Skills')).toBeLessThan(titles.indexOf('MCP'));
    expect(el.textContent).toContain('3 开 · 1 手动 · 1 关');

    openFold(el, 'Skills');
    expect(el.querySelectorAll('.cz-ctx__skill').length).toBe(5);
    // 不再有三段按钮；插件前缀不显示；关闭的行变淡
    expect(el.querySelector('.cz-ctx__seg3')).toBeNull();
    const xlsx = rowOf(el, 'xlsx');
    expect(xlsx.classList.contains('is-off')).toBe(true);
    const btn = xlsx.querySelector<HTMLButtonElement>('.cz-ctx__mode')!;
    expect(btn.getAttribute('aria-label')).toContain('关');

    click(btn);
    const opts = [...document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]')];
    const text = (re: RegExp) => opts.find((o) => re.test(o.textContent ?? ''))!;
    // 当前项不回调；点「手动」回调完整名
    click(text(/^关/));
    expect(onSkillMode).not.toHaveBeenCalled();
    click(btn);
    const again = [...document.querySelectorAll('[role^="menuitem"]')].find((o) => /^手动/.test(o.textContent ?? ''))!;
    click(again);
    expect(onSkillMode).toHaveBeenCalledWith('anthropic-skills:xlsx', 'user-invocable-only');
  });

  it('不传 onSkillMode 时状态按钮禁用', () => {
    const el = mount2();
    openFold(el, 'Skills');
    for (const b of el.querySelectorAll<HTMLButtonElement>('.cz-ctx__mode')) expect(b.disabled).toBe(true);
  });

  it('一键推荐配置：只改与推荐不同的已收录 skill；撤销恢复原状态', () => {
    const onSkillModes = vi.fn();
    const el = mount2({ onSkillModes });
    openFold(el, 'Skills');
    const preset = el.querySelector<HTMLButtonElement>('.cz-ctx__preset')!;
    expect(preset.disabled).toBe(false);
    click(preset);
    // mock：docx 开→关，pdf 开→手动，xlsx 已是关→手动；impeccable(开) 与 schedule(手动) 已是推荐
    expect(onSkillModes).toHaveBeenLastCalledWith({
      'anthropic-skills:docx': 'off',
      'anthropic-skills:pdf': 'user-invocable-only',
      'anthropic-skills:xlsx': 'user-invocable-only',
    });
    click(el.querySelector('.cz-ctx__undo'));
    expect(onSkillModes).toHaveBeenLastCalledWith({
      'anthropic-skills:docx': 'on',
      'anthropic-skills:pdf': 'on',
      'anthropic-skills:xlsx': 'off',
    });
    expect(el.querySelector('.cz-ctx__undo')).toBeNull();
  });

  it('下拉里的「移除」：可移除的先行内确认再回调；插件 skill 的移除项禁用', () => {
    const onSkillRemove = vi.fn();
    const el = mount2({ onSkillMode: () => undefined, onSkillRemove });
    openFold(el, 'Skills');
    const items = () => [...document.querySelectorAll('[role^="menuitem"]')];
    const removeItem = () => items().find((o) => /^移除/.test(o.textContent ?? '')) as HTMLElement;

    // 插件 skill（没有 removable）：移除项禁用，点了也不弹确认
    click(rowOf(el, 'pdf').querySelector('.cz-ctx__mode'));
    expect(removeItem().textContent).toContain('不能单独移除');
    click(removeItem());
    expect(el.querySelector('.cz-ctx__confirm')).toBeNull();
    expect(onSkillRemove).not.toHaveBeenCalled();
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

    // 用户级 skill：点移除 → 行内确认 → 取消不回调
    const row = rowOf(el, 'impeccable');
    click(row.querySelector('.cz-ctx__mode'));
    click(removeItem());
    expect(row.querySelector('.cz-ctx__confirm')?.textContent).toContain('移除「impeccable」');
    click([...row.querySelectorAll('.cz-ctx__confirm-btn')].find((b) => b.textContent === '取消'));
    expect(row.querySelector('.cz-ctx__confirm')).toBeNull();
    expect(onSkillRemove).not.toHaveBeenCalled();

    // 再来一次，确认移除
    click(row.querySelector('.cz-ctx__mode'));
    click(removeItem());
    click(row.querySelector('.cz-ctx__confirm-btn.is-danger'));
    expect(onSkillRemove).toHaveBeenCalledWith('impeccable');
  });

  it('悬浮显示中文用途与建议', () => {
    vi.useFakeTimers();
    try {
      const el = mount2({ onSkillMode: () => undefined });
      openFold(el, 'Skills');
      const row = rowOf(el, 'pdf');
      act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
      act(() => { (row as HTMLElement).dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
      act(() => { vi.advanceTimersByTime(400); });
      const tip = document.querySelector('.cz-ctx__tip')!;
      expect(tip.textContent).toContain('PDF');
      expect(tip.textContent).toContain('建议');
      expect(tip.textContent).toContain('手动');
    } finally {
      vi.useRealTimers();
    }
  });

  it('去掉前缀后撞名的 skill 显示完整名，不撞名的仍显示短名', () => {
    const usage: ContextUsage = {
      ...mockContextUsage,
      skills: [
        { name: 'anthropic-skills:skill-creator', mode: 'on', tokens: 80, source: 'plugin' },
        { name: 'skill-creator:skill-creator', mode: 'on', tokens: 90, source: 'plugin' },
        { name: 'anthropic-skills:pdf', mode: 'on', tokens: 50, source: 'plugin' },
      ],
    };
    const el = mount2({ usage });
    openFold(el, 'Skills');
    const names = [...el.querySelectorAll('.cz-ctx__skill .cz-ctx__item-name')].map((n) => n.textContent);
    expect(names).toEqual(['anthropic-skills:skill-creator', 'skill-creator:skill-creator', 'pdf']);
  });
});

describe('ContextPanel MCP', () => {
  it('按服务器显示开关与状态；点开关回调 onMcpToggle(名字, 目标状态)', () => {
    const onMcpToggle = vi.fn();
    const el = render(
      <ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} onMcpToggle={onMcpToggle} />,
    );
    expect(el.textContent).toContain('2 已连接');
    openFold(el, 'MCP');
    const switches = el.querySelectorAll<HTMLButtonElement>('[role="switch"]');
    expect(switches.length).toBe(4);
    expect([...switches].map((s) => s.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false', 'true']);
    expect(el.textContent).toContain('已停用');
    expect(el.textContent).toContain('需登录');

    click(switches[0]);
    expect(onMcpToggle).toHaveBeenLastCalledWith('claude.ai Claude Docs', false);
    click(switches[2]);
    expect(onMcpToggle).toHaveBeenLastCalledWith('github', true);
  });

  it('点服务器名展开工具列表', () => {
    const el = render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} />);
    openFold(el, 'MCP');
    expect(el.querySelector('.cz-ctx__mcp-tools')).toBeNull();
    click(el.querySelector('.cz-ctx__mcp-name'));
    const tools = [...el.querySelectorAll('.cz-ctx__mcp-tools .cz-ctx__item-name')].map((t) => t.textContent);
    expect(tools).toEqual(['batch', 'guide', 'update']);
  });

  it('切换中所有开关禁用并显示「切换中」；状态未知时开关禁用', () => {
    const usage: ContextUsage = {
      ...mockContextUsage,
      mcpServers: [...mockContextUsage.mcpServers, { name: 'mystery', status: 'unknown', tokens: 0, tools: [] }],
    };
    const props = { usage, loading: false, onRefresh: () => undefined, onCompact: () => undefined, onMcpToggle: vi.fn() };
    const el = render(<ContextPanel {...props} mcpBusy="playwright" />);
    openFold(el, 'MCP');
    for (const s of el.querySelectorAll<HTMLButtonElement>('[role="switch"]')) expect(s.disabled).toBe(true);
    expect(el.textContent).toContain('切换中');

    act(() => root!.render(<ContextPanel {...props} mcpBusy={null} />));
    const switches = [...el.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    expect(switches.map((s) => s.disabled)).toEqual([false, false, false, false, true]);
  });

  it('仅有 cosyee 一台 MCP 服务器时，MCP 小节等同没有 MCP', () => {
    const usage: ContextUsage = {
      ...mockContextUsage,
      mcpServers: [{ name: 'cosyee', status: 'connected', tokens: 900, tools: [{ name: 'delegate', tokens: 900 }] }],
    };
    const el = render(<ContextPanel usage={usage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} />);
    const fold = [...el.querySelectorAll<HTMLButtonElement>('.cz-ctx__fold')].find((b) => b.querySelector('.cz-ctx__fold-title')?.textContent === 'MCP')!;
    expect(fold.disabled).toBe(true);
    expect(fold.querySelector('.cz-ctx__fold-count')?.textContent).toBe('0');
    expect(fold.querySelector('.cz-ctx__fold-extra')).toBeNull();
  });
});

describe('ContextPanel 收起与压缩', () => {
  it('传 onCollapse 时空态和有数据时都显示收起按钮，点击回调', () => {
    const onCollapse = vi.fn();
    const el = render(<ContextPanel usage={null} loading={false} onRefresh={() => undefined} onCompact={() => undefined} onCollapse={onCollapse} />);
    click(el.querySelector('[aria-label="收起上下文栏"]'));
    act(() => root!.render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} onCollapse={onCollapse} />));
    click(el.querySelector('[aria-label="收起上下文栏"]'));
    expect(onCollapse).toHaveBeenCalledTimes(2);
    act(() => root!.render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} />));
    expect(el.querySelector('[aria-label="收起上下文栏"]')).toBeNull();
  });

  it('compactDisabled 时压缩按钮禁用', () => {
    const onCompact = vi.fn();
    const el = render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={onCompact} compactDisabled />);
    const btn = el.querySelector('.cz-ctx__btn--block') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    click(btn);
    expect(onCompact).not.toHaveBeenCalled();
  });
});

describe('ContextPanel 自动压缩窗口', () => {
  const typeIn = (input: HTMLInputElement, value: string) => {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const key = (el: Element, k: string) => act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
  const mountCw = (usage: ContextUsage, onCompactWindow?: (w: number | null) => void) =>
    render(<ContextPanel usage={usage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} onCompactWindow={onCompactWindow} />);

  it('parseCompactWindow：k / m 单位、空 = 默认、越界或乱写不合法', () => {
    expect(parseCompactWindow('150')).toBe(150_000);
    expect(parseCompactWindow(' 150k ')).toBe(150_000);
    expect(parseCompactWindow('1m')).toBe(1_000_000);
    expect(parseCompactWindow('')).toBeNull();
    expect(parseCompactWindow('49')).toBeUndefined();
    expect(parseCompactWindow('1001')).toBeUndefined();
    expect(parseCompactWindow('abc')).toBeUndefined();
  });

  it('显示当前窗口；点开输入新值回车保存', () => {
    const on = vi.fn();
    const el = mountCw({ ...mockContextUsage, compactWindow: 150_000 }, on);
    const chip = el.querySelector('.cz-ctx__cw-chip') as HTMLButtonElement;
    expect(chip.textContent).toBe('窗口 150k');
    click(chip);
    const input = el.querySelector('.cz-ctx__cw-input') as HTMLInputElement;
    expect(input.value).toBe('150');
    typeIn(input, '200');
    key(input, 'Enter');
    expect(on).toHaveBeenCalledWith(200_000);
    expect(el.querySelector('.cz-ctx__cw-input')).toBeNull();
  });

  it('不合法时提示且不回调；「默认」回调 null；Esc 取消', () => {
    const on = vi.fn();
    const el = mountCw({ ...mockContextUsage, compactWindow: 150_000 }, on);
    click(el.querySelector('.cz-ctx__cw-chip'));
    const input = el.querySelector('.cz-ctx__cw-input') as HTMLInputElement;
    typeIn(input, '10');
    key(input, 'Enter');
    expect(on).not.toHaveBeenCalled();
    expect(input.classList.contains('is-invalid')).toBe(true);
    key(input, 'Escape');
    expect(el.querySelector('.cz-ctx__cw-input')).toBeNull();
    click(el.querySelector('.cz-ctx__cw-chip'));
    const def = [...el.querySelectorAll('.cz-ctx__cw-line button')].find((b) => b.textContent?.trim() === '默认');
    click(def);
    expect(on).toHaveBeenCalledWith(null);
  });

  it('未覆盖时显示「默认」；不传回调时不可点', () => {
    const el = mountCw({ ...mockContextUsage, compactWindow: null });
    const chip = el.querySelector('.cz-ctx__cw-chip') as HTMLButtonElement;
    expect(chip.textContent).toBe('窗口 默认');
    expect(chip.disabled).toBe(true);
  });
});

describe('ContextPanel 缓存命中率走势', () => {
  const pt = (i: number, read: number, create: number, input: number): CachePoint => ({
    id: 'm' + i, turn: Math.floor(i / 2), read, create, input, rate: (read / (read + create + input)) * 100,
  });
  const series = [pt(0, 0, 9000, 100), pt(1, 9000, 500, 50), pt(2, 9500, 400, 100), pt(3, 9900, 200, 10)];
  const mountCache = (cache?: CachePoint[]) =>
    render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} cache={cache} />);

  it('在 Skills 上方显示；最新值用大号百分比和实心圆点标出，svg 带文字替代', () => {
    const el = mountCache(series);
    const subs = [...el.querySelectorAll('.cz-ctx__sub, .cz-ctx__fold-title')].map((n) => n.textContent);
    expect(subs.indexOf('缓存命中率')).toBeGreaterThanOrEqual(0);
    expect(subs.indexOf('缓存命中率')).toBeLessThan(subs.indexOf('Skills'));
    expect(el.querySelector('[data-testid="cache-now"]')?.textContent).toBe('98%');
    const svg = el.querySelector('svg.cz-ctx__cache-svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toContain('共 4 次请求');
    expect(svg.getAttribute('aria-label')).toContain('最新 98%');
    expect(svg.getAttribute('aria-label')).toContain('最低 0%');
    expect(svg.querySelector('path.cz-ctx__cache-line')).not.toBeNull();
    const dot = svg.querySelector('[data-testid="cache-last"]')!;
    expect(Number(dot.getAttribute('r'))).toBeGreaterThanOrEqual(4); // 直径 >= 8px
    expect(el.querySelector('[data-testid="cache-tip"]')).toBeNull();
  });

  it('悬停吸附到最近的请求并显示命中率与 token 明细；离开后消失', () => {
    const el = mountCache(series);
    const svg = el.querySelector('svg.cz-ctx__cache-svg') as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 76, right: 280, bottom: 76, x: 0, y: 0, toJSON: () => ({}) });
    // viewBox 宽 280 与实际宽度相同：x=95 约在 4 个点的第 2 个（x≈99.3）
    act(() => { svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 95 })); });
    const tip = el.querySelector('[data-testid="cache-tip"]')!;
    expect(tip.textContent).toContain('第 2 次请求');
    expect(tip.textContent).toContain('命中 94.2%');
    expect(tip.textContent).toContain('读缓存 9k');
    expect(tip.textContent).toContain('写缓存 500');
    expect(tip.textContent).toContain('未缓存 50');
    expect(el.querySelector('line.cz-ctx__cache-cross')).not.toBeNull();
    act(() => { svg.dispatchEvent(new MouseEvent('pointerout', { bubbles: true })); });
    expect(el.querySelector('[data-testid="cache-tip"]')).toBeNull();
  });

  it('键盘左右键切换请求，Esc 取消', () => {
    const el = mountCache(series);
    const svg = el.querySelector('svg.cz-ctx__cache-svg') as SVGSVGElement;
    const key = (k: string) => act(() => { svg.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
    key('ArrowLeft');
    expect(el.querySelector('[data-testid="cache-tip"]')?.textContent).toContain('第 3 次请求');
    key('Home');
    expect(el.querySelector('[data-testid="cache-tip"]')?.textContent).toContain('第 1 次请求');
    key('Escape');
    expect(el.querySelector('[data-testid="cache-tip"]')).toBeNull();
  });

  it('只有一个点时不画折线，只标出圆点；没有数据时显示空态', () => {
    const el = mountCache([series[1]]);
    expect(el.querySelector('path.cz-ctx__cache-line')).toBeNull();
    expect(el.querySelector('[data-testid="cache-last"]')).not.toBeNull();
    expect(el.querySelector('[data-testid="cache-now"]')?.textContent).toBe('94%');
    act(() => root!.render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} />));
    expect(el.querySelector('svg.cz-ctx__cache-svg')).toBeNull();
    expect(el.textContent).toContain('发送消息后，这里显示缓存命中率走势');
  });
});

describe('ContextPanel 上下文走势', () => {
  const pt = (i: number, total: number, turn: number, tools?: string[]): CachePoint => ({
    id: 'm' + i, turn, read: total, create: 0, input: 0, rate: 100, ...(tools ? { tools } : {}),
  });
  const turns: Turn[] = [
    {
      id: 't0', userText: '看看代码', attachments: [], status: 'done', statusText: '', answer: '', subagents: [], startedAt: 0,
      steps: [
        { kind: 'tool', id: 'a', name: 'Read', input: { file_path: 'big.ts' }, summary: 'Read: big.ts', result: { content: 'x'.repeat(40_000), isError: false } },
        { kind: 'tool', id: 'b', name: 'Glob', input: { pattern: '*' }, summary: 'Glob: *', result: { content: 'a.ts', isError: false } },
      ],
    },
    { id: 't1', userText: '第二个问题', attachments: [], status: 'done', statusText: '', answer: '', subagents: [], startedAt: 0, steps: [] },
  ];
  // m1 调用了 a、b → m2 涨 10k；m3 是新一轮
  const series = [pt(0, 20_000, 0), pt(1, 21_000, 0, ['b', 'a']), pt(2, 31_000, 0), pt(3, 31_500, 1)];
  const mountCtx = (cache?: CachePoint[]) =>
    render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} cache={cache} turns={turns} />);
  const svgOf = (el: HTMLElement) => {
    const svg = el.querySelector('svg.cz-ctx__ctx-svg') as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 76, right: 280, bottom: 76, x: 0, y: 0, toJSON: () => ({}) });
    return svg;
  };

  it('在缓存命中率上方；每次请求一根柱，涨幅大的标警示色；悬停显示较上次变化', () => {
    const el = mountCtx(series);
    const subs = [...el.querySelectorAll('.cz-ctx__sub')].map((n) => n.textContent);
    expect(subs.indexOf('上下文走势')).toBeLessThan(subs.indexOf('缓存命中率'));
    expect(el.querySelector('[data-testid="ctx-now"]')?.textContent).toBe('31.5k');
    const bars = el.querySelectorAll('.cz-ctx__ctx-bar');
    expect(bars).toHaveLength(4);
    expect([...bars].map((b) => b.classList.contains('is-jump'))).toEqual([false, false, true, false]);
    const svg = svgOf(el);
    // 4 个槽位，每个宽 67：x=170 落在第 3 个
    act(() => { svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 170 })); });
    expect(el.querySelector('[data-testid="ctx-tip"]')?.textContent).toContain('较上次 +10k');
  });

  it('点击柱子列出上一次请求调用的工具（按大小排序）；新一轮显示用户消息；再点收起', () => {
    const el = mountCtx(series);
    const svg = svgOf(el);
    act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 170 })); });
    const g = el.querySelector('[data-testid="ctx-growth"]')!;
    expect(g.textContent).toContain('第 3 次请求');
    const names = [...g.querySelectorAll('.cz-ctx__item-name')].map((n) => n.textContent);
    expect(names).toEqual(['Read: big.ts', 'Glob: *']);
    expect(g.querySelector('.cz-ctx__item-tokens')?.textContent).toMatch(/约 10k/);

    act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 270 })); });
    expect(el.querySelector('[data-testid="ctx-growth"]')?.textContent).toContain('第二个问题');
    act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 270 })); });
    expect(el.querySelector('[data-testid="ctx-growth"]')).toBeNull();
  });

  it('「最大增长」按钮直接打开涨得最多的那次', () => {
    const el = mountCtx(series);
    const btn = el.querySelector('.cz-ctx__grow-top')!;
    expect(btn.textContent).toContain('+10k');
    click(btn);
    expect(el.querySelector('[data-testid="ctx-growth"]')?.textContent).toContain('第 3 次请求');
  });

  it('没有数据时显示空态', () => {
    const el = mountCtx(undefined);
    expect(el.querySelector('svg.cz-ctx__ctx-svg')).toBeNull();
    expect(el.textContent).toContain('这里显示每次请求的上下文大小');
  });
});

describe('ContextPanel 花费', () => {
  const S45 = 'claude-sonnet-4-5';
  const pt = (id: string, turn: number, over: Partial<CachePoint> = {}): CachePoint => ({
    id, turn, input: 0, create: 0, read: 0, rate: 0, output: 0, model: S45, ...over,
  });
  const turn = (id: string, userText: string): Turn => ({
    id, userText, attachments: [], status: 'done', statusText: '', answer: '', subagents: [], startedAt: 0, steps: [],
  });
  const turns = [turn('t0', '第一个问题'), turn('t1', '第二个问题')];
  // 第 1 轮 $0.318，第 2 轮 $0.0375
  const series = [pt('a', 0, { input: 1000, read: 1_000_000, output: 1000 }), pt('b', 1, { create: 10_000 })];
  const panel = (extra: Partial<Parameters<typeof ContextPanel>[0]> = {}) => (
    <ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} cache={series} turns={turns} {...extra} />
  );
  const section = (el: HTMLElement) => el.querySelector('.cz-ctx__cost') as HTMLElement;
  const svgOf = (el: HTMLElement) => {
    const svg = el.querySelector('svg.cz-ctx__cost-svg') as SVGSVGElement;
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 280, height: 76, right: 280, bottom: 76, x: 0, y: 0, toJSON: () => ({}) });
    return svg;
  };

  it('排在缓存命中率之后；显示合计、本轮、每次请求均与缓存已省', () => {
    const el = render(panel());
    const subs = [...el.querySelectorAll('.cz-ctx__sub')].map((n) => n.textContent);
    expect(subs.indexOf('花费')).toBeGreaterThan(subs.indexOf('缓存命中率'));
    expect(el.querySelector('[data-testid="cost-total"]')?.textContent).toBe('$0.36');
    const stats = section(el).querySelector('.cz-ctx__cost-stats')!.textContent!;
    expect(stats).toContain('本轮 $0.04');
    expect(stats).toContain('每次请求均 $0.18');
    expect(stats).toContain('缓存已省 $2.69');
    expect(section(el).querySelectorAll('.cz-ctx__cost-col')).toHaveLength(2);
    expect(section(el).textContent).toContain('价格来自内置价格表');
  });

  it('订阅账号标题标「等价 API 价格」；第三方地址加提示', () => {
    const el = render(panel({ billing: 'subscription' }));
    expect(section(el).querySelector('.cz-ctx__sub')?.textContent).toBe('花费（等价 API 价格）');
    expect(section(el).textContent).toContain('订阅账号按额度计费');
    act(() => root!.render(panel({ billing: 'thirdParty' })));
    expect(section(el).textContent).toContain('第三方接口地址');
  });

  it('官方价格表显示更新时间', () => {
    const at = new Date(2026, 10, 3, 9, 5).getTime();
    const el = render(panel({ pricing: { source: 'official', fetchedAt: at, models: BUILTIN_PRICES.models } }));
    expect(section(el).textContent).toContain('价格来自 Anthropic 官方价格页，11月3日 09:05 更新');
  });

  it('不认识的模型提示没有计入；CLI 花费对不上时提示价格表可能过期', () => {
    const el = render(panel({ cache: [...series, pt('c', 1, { input: 10, model: 'glm-4.6' })] }));
    const warn = [...section(el).querySelectorAll('.cz-ctx__note.is-warn')].map((n) => n.textContent);
    expect(warn).toEqual(['1 次请求的模型不在价格表里（glm-4.6），没有计入']);
    act(() =>
      root!.render(panel({ cliCost: [{ model: S45, input: 1_000_000, output: 0, read: 0, create5m: 0, create1h: 0, costUSD: 6 }] })),
    );
    expect(section(el).querySelector('.cz-ctx__note.is-warn')?.textContent).toContain('价格表可能过期：claude-sonnet-4-5 按价格表算 $3.00，CLI 报告 $6.00');
    act(() =>
      root!.render(panel({ cliCost: [{ model: S45, input: 1_000_000, output: 0, read: 0, create5m: 0, create1h: 0, costUSD: 3 }] })),
    );
    expect(section(el).querySelector('.cz-ctx__note.is-warn')).toBeNull();
  });

  it('下一次请求预估', () => {
    const el = render(panel());
    // 最后一次请求 create 10k → 下一次输入 10k：热 $0.003，冷 $0.0375（显示 $0.04）
    const next = el.querySelector('[data-testid="cost-next"]')!.textContent!;
    expect(next).toContain('下一次请求约 $0.003');
    expect(next).toContain('缓存过期则约 $0.04');
  });

  it('悬停显示这一轮的用户消息与明细；点击 / 回车跳到这一轮', () => {
    const onJumpTurn = vi.fn();
    const el = render(panel({ onJumpTurn }));
    const svg = svgOf(el);
    // 2 个槽位：x=50 在第 1 轮
    act(() => { svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 50 })); });
    const tip = el.querySelector('[data-testid="cost-tip"]')!.textContent!;
    expect(tip).toContain('第 1 轮 · $0.32');
    expect(tip).toContain('「第一个问题」');
    expect(tip).toContain('主线程 $0.32（1 次请求）');
    expect(tip).toContain('读缓存 $0.30');
    act(() => { svg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 250 })); });
    expect(onJumpTurn).toHaveBeenLastCalledWith(1);
    act(() => { svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    act(() => { svg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(onJumpTurn).toHaveBeenLastCalledWith(0);
  });

  it('压缩过的轮画虚线标记，悬停提示压缩', () => {
    const el = render(panel({ compactions: [{ id: 'c', turn: 1, trigger: 'manual', pre: 1e6, post: 2000, durationMs: 1, after: 'a', at: 0 }] }));
    expect(el.querySelectorAll('[data-testid="cost-compact"]')).toHaveLength(1);
    const svg = svgOf(el);
    act(() => { svg.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 250 })); });
    expect(el.querySelector('[data-testid="cost-tip"]')?.textContent).toContain('本轮压缩了会话（手动）');
  });

  it('子代理花费按轮叠加；还没取到时提示', () => {
    const withSub = [turns[0]!, { ...turns[1]!, subagents: [{ toolUseId: 'tu1', title: '查资料', status: 'done' as const, turn: turn('s', '') }] }];
    const el = render(panel({ turns: withSub }));
    expect(section(el).textContent).toContain('子代理的花费还在读取');
    act(() =>
      root!.render(
        panel({
          turns: withSub,
          subCosts: [{ agentId: 'ag', toolUseId: 'tu1', requests: 2, cost: { input: 0, write: 0, read: 0, output: 1 }, uncached: 1, unpriced: 0, models: [S45] }],
        }),
      ),
    );
    expect(section(el).textContent).not.toContain('子代理的花费还在读取');
    expect(section(el).textContent).toContain('含子代理 $1.00');
    expect(section(el).querySelector('rect.cz-ctx__cost-bar.is-sub')).not.toBeNull();
  });

  it('没有请求时显示空态', () => {
    const el = render(panel({ cache: undefined }));
    expect(section(el).textContent).toContain('发送消息后，这里显示这个会话花了多少钱');
    expect(el.querySelector('svg.cz-ctx__cost-svg')).toBeNull();
  });
});

describe('ContextPanel 工具', () => {
  const INIT = ['Bash', 'Glob', 'WebFetch', 'mcp__github__search', 'Read'];
  const mountTools = (extra: Partial<React.ComponentProps<typeof ContextPanel>> = {}) =>
    render(
      <ContextPanel usage={{ ...mockContextUsage, disabledTools: ['WebFetch', 'Notebook'] }} loading={false} onRefresh={() => undefined} onCompact={() => undefined} tools={INIT} {...extra} />,
    );
  const toggles = (el: HTMLElement) => [...el.querySelectorAll<HTMLButtonElement>('.cz-ctx__tool [role="switch"]')];

  it('在 Skills 下方、MCP 上方；只列内置工具（排除 mcp__），已停用的工具即使不在 init 里也保留，便于重新启用', () => {
    const el = mountTools();
    const titles = [...el.querySelectorAll('.cz-ctx__fold-title')].map((t) => t.textContent);
    expect(titles.indexOf('工具')).toBeGreaterThan(titles.indexOf('Skills'));
    expect(titles.indexOf('工具')).toBeLessThan(titles.indexOf('MCP'));
    expect(el.textContent).toContain('2 已停用');
    openFold(el, '工具');
    const names = [...el.querySelectorAll('.cz-ctx__tool .cz-ctx__item-name')].map((n) => n.textContent);
    expect(names).toEqual(['Bash', 'Glob', 'WebFetch', 'Read', 'Notebook']);
    expect(toggles(el).map((b) => b.getAttribute('aria-checked'))).toEqual(['true', 'true', 'false', 'true', 'false']);
    expect(el.querySelector('.cz-ctx__tool.is-off .cz-ctx__item-name')?.textContent).toBe('WebFetch');
    expect([...el.querySelectorAll('.cz-ctx__note')].some((n) => n.textContent?.includes('立即拦截'))).toBe(true);
  });

  it('显示工具定义占用（常驻 / 延迟加载）与每个工具在本会话的调用次数', () => {
    const step = (name: string) => ({ kind: 'tool' as const, id: `${name}-${Math.random()}`, name, input: {}, summary: name });
    const base = { id: 't', userText: '', attachments: [], status: 'done' as const, statusText: '', answer: '', startedAt: 0 };
    const turns: Turn[] = [
      { ...base, steps: [step('Bash'), step('Bash'), step('Read')], subagents: [] },
      { ...base, steps: [], subagents: [{ toolUseId: 'a', title: 'd', status: 'done', turn: { ...base, steps: [step('Read')], subagents: [] } }] },
    ];
    const el = mountTools({ turns });
    const fold = [...el.querySelectorAll('.cz-ctx__fold')].find((b) => b.querySelector('.cz-ctx__fold-title')?.textContent === '工具')!;
    expect(fold.querySelector('.cz-ctx__fold-extra')?.textContent).toBe('9.8k · 2 已停用');
    openFold(el, '工具');
    const stats = el.querySelector('.cz-ctx__tool-stats')!.textContent!;
    expect(stats).toContain('常驻占用9.8k');
    expect(stats).toContain('延迟加载5.7k');
    expect(stats).toContain('本会话调用4 次');
    // 没拿到所有会话的统计：累计显示占位，行内不出累计列
    expect(stats).toContain('累计调用—');
    expect(el.querySelector('.cz-ctx__tool-total')).toBeNull();
    expect(stats).toContain('不提供单个工具的占用');
    const calls = Object.fromEntries(
      [...el.querySelectorAll('.cz-ctx__tool')].map((r) => [r.querySelector('.cz-ctx__item-name')!.textContent, r.querySelector('.cz-ctx__tool-calls')!.textContent]),
    );
    expect(calls).toEqual({ Bash: '×2', Glob: '—', WebFetch: '—', Read: '×2', Notebook: '—' });
  });

  it('拿到所有会话的统计时，分别显示本会话调用与累计调用；Agent / Task 的累计合在一起', () => {
    const step = (name: string) => ({ kind: 'tool' as const, id: `${name}-${Math.random()}`, name, input: {}, summary: name });
    const base = { id: 't', userText: '', attachments: [], status: 'done' as const, statusText: '', answer: '', startedAt: 0 };
    const turns: Turn[] = [{ ...base, steps: [step('Bash')], subagents: [] }];
    const toolStats = { counts: { Bash: 12_345, Read: 7, Task: 3, Agent: 2, mcp__x__y: 9 }, sessions: 40, at: 0 };
    const el = render(
      <ContextPanel
        usage={mockContextUsage}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        tools={['Bash', 'Read', 'Glob', 'Agent']}
        turns={turns}
        toolStats={toolStats}
      />,
    );
    openFold(el, '工具');
    const stats = el.querySelector('.cz-ctx__tool-stats')!.textContent!;
    expect(stats).toContain('本会话调用1 次');
    // 只合计列表里的内置工具：12345 + 7 + 0 + (3 + 2)
    expect(stats).toContain('累计调用12.4k 次');
    const row = (n: string) => [...el.querySelectorAll('.cz-ctx__tool')].find((r) => r.querySelector('.cz-ctx__item-name')!.textContent === n)!;
    const cells = (n: string) => [row(n).querySelector('.cz-ctx__tool-calls')!.textContent, row(n).querySelector('.cz-ctx__tool-total')!.textContent];
    expect(cells('Bash')).toEqual(['×1', '12.3k']);
    expect(cells('Read')).toEqual(['—', '7']);
    expect(cells('Glob')).toEqual(['—', '—']);
    expect(cells('Agent')).toEqual(['—', '5']);
  });

  it('CLI 给了单个工具占用时，行内显示 token，不再提示只有合计', () => {
    const el = render(
      <ContextPanel usage={{ ...mockContextUsage, toolTokens: [{ name: 'Bash', tokens: 1_200 }] }} loading={false} onRefresh={() => undefined} onCompact={() => undefined} tools={['Bash', 'Read']} />,
    );
    openFold(el, '工具');
    const rows = [...el.querySelectorAll('.cz-ctx__tool')];
    expect(rows[0]!.querySelector('.cz-ctx__item-tokens')?.textContent).toBe('1.2k');
    expect(rows[1]!.querySelector('.cz-ctx__item-tokens')).toBeNull();
    expect(el.querySelector('.cz-ctx__tool-stats')!.textContent).not.toContain('不提供单个工具的占用');
  });

  it('点开关回调 onToolToggle(名字, 目标状态)；不传回调时开关禁用', () => {
    const onToolToggle = vi.fn();
    const el = mountTools({ onToolToggle });
    openFold(el, '工具');
    click(toggles(el)[1]);
    expect(onToolToggle).toHaveBeenLastCalledWith('Glob', false);
    click(toggles(el)[2]);
    expect(onToolToggle).toHaveBeenLastCalledWith('WebFetch', true);
    act(() => root!.render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} tools={INIT} />));
    for (const b of toggles(el)) expect(b.disabled).toBe(true);
  });

  it('没有工具信息且没有停用项时，折叠标题禁用', () => {
    const el = render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} />);
    const fold = [...el.querySelectorAll<HTMLButtonElement>('.cz-ctx__fold')].find((b) => b.textContent?.startsWith('工具'))!;
    expect(fold.disabled).toBe(true);
  });

  it('本会话没收到 init（tools 为空）时，用服务端随上下文下发的 usage.tools', () => {
    const usage = { ...mockContextUsage, tools: ['Bash', 'Read'], disabledTools: ['WebFetch'] };
    const el = render(<ContextPanel usage={usage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} tools={[]} />);
    openFold(el, '工具');
    const names = [...el.querySelectorAll('.cz-ctx__tool .cz-ctx__item-name')].map((n) => n.textContent);
    expect(names).toEqual(['Bash', 'Read', 'WebFetch']);
    // 悬浮：中文用途；核心工具提示不建议停用；未收录的给兜底说明
    vi.useFakeTimers();
    try {
      const hover = (name: string) => {
        const row = [...el.querySelectorAll('.cz-ctx__tool')].find((r) => r.querySelector('.cz-ctx__item-name')?.textContent === name)!;
        act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        act(() => { vi.advanceTimersByTime(400); });
        const text = document.querySelector('.cz-ctx__tip')?.textContent ?? '';
        act(() => { row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
        return text;
      };
      expect(hover('Bash')).toContain('shell 命令');
      expect(hover('Bash')).toContain('不建议停用');
      expect(hover('WebFetch')).toContain('已停用');
    } finally {
      vi.useRealTimers();
    }
    // 本会话的 init 优先
    act(() => root!.render(<ContextPanel usage={usage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} tools={['Glob']} />));
    expect([...el.querySelectorAll('.cz-ctx__tool .cz-ctx__item-name')].map((n) => n.textContent)).toEqual(['Glob', 'WebFetch']);
  });

  it('Cosyee 工具的悬浮提示不带 mcp__cosyee__ 原名，未收录工具也不显示为 MCP', () => {
    const usage: ContextUsage = {
      ...mockContextUsage,
      mcpServers: [
        { name: 'cosyee', status: 'connected', tokens: 900, tools: [{ name: 'delegate', tokens: 900 }, { name: 'custom_tool', tokens: 100 }] },
      ],
    };
    const el = render(
      <ContextPanel
        usage={usage}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        tools={['mcp__cosyee__delegate', 'mcp__cosyee__custom_tool']}
      />,
    );
    openFold(el, '工具');
    vi.useFakeTimers();
    try {
      const hover = (name: string) => {
        const row = [...el.querySelectorAll('.cz-ctx__tool')].find((r) => r.querySelector('.cz-ctx__item-name')?.textContent === name)!;
        act(() => { row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
        act(() => { vi.advanceTimersByTime(400); });
        const tip = document.querySelector('.cz-ctx__tip')!;
        const text = tip.textContent ?? '';
        const hasFull = tip.querySelector('.cz-ctx__tip-full') !== null;
        act(() => { row.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
        return { text, hasFull };
      };
      const d = hover('delegate');
      expect(d.hasFull).toBe(false);
      expect(d.text).not.toContain('mcp__cosyee__');
      const c = hover('custom_tool');
      expect(c.hasFull).toBe(false);
      expect(c.text).toContain('Cosyee 自带的工具 custom_tool。');
      expect(c.text).not.toContain('MCP');
      expect(c.text).not.toContain('mcp__cosyee__');
    } finally {
      vi.useRealTimers();
    }
  });
});
