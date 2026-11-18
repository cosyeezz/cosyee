// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ContextUsage } from '@cosyee/shared';
import { ContextPanel } from './ContextPanel';
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
  it('Skills 在 MCP 上方；展开后每个 skill 有三态，点别的状态回调 onSkillMode', () => {
    const onSkillMode = vi.fn();
    const el = render(
      <ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} onSkillMode={onSkillMode} />,
    );
    const titles = [...el.querySelectorAll('.cz-ctx__fold-title')].map((t) => t.textContent);
    expect(titles.indexOf('Skills')).toBeLessThan(titles.indexOf('MCP'));
    expect(el.textContent).toContain('3 开');

    openFold(el, 'Skills');
    const rows = el.querySelectorAll('.cz-ctx__skill');
    expect(rows.length).toBe(5);
    // 插件前缀不显示；关闭的行变淡
    const xlsx = [...rows].find((r) => r.querySelector('.cz-ctx__item-name')?.textContent === 'xlsx')!;
    expect(xlsx.classList.contains('is-off')).toBe(true);
    expect(xlsx.querySelector('[aria-checked="true"]')?.textContent).toBe('关');

    // 点当前状态不回调；点「手动」回调完整名
    click(xlsx.querySelector('[aria-checked="true"]'));
    expect(onSkillMode).not.toHaveBeenCalled();
    click([...xlsx.querySelectorAll('[role="radio"]')].find((b) => b.textContent === '手动'));
    expect(onSkillMode).toHaveBeenCalledWith('anthropic-skills:xlsx', 'user-invocable-only');
  });

  it('不传 onSkillMode 时三态按钮只读', () => {
    const el = render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} />);
    openFold(el, 'Skills');
    for (const b of el.querySelectorAll<HTMLButtonElement>('.cz-ctx__seg3-btn')) expect(b.disabled).toBe(true);
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
