// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BUILTIN_PRICES, type CachePoint, type SubagentCost, type Turn } from '@cosyee/shared';
import { CostSection } from './CostSection';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

function render(node: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

const S45 = 'claude-sonnet-4-5-20250929';
const points: CachePoint[] = [
  { id: 'm1', turn: 0, input: 100_000, create: 0, read: 0, rate: 0, output: 0, model: S45 }, // $0.30
];
const turns: Turn[] = [
  {
    id: 't0',
    userText: '帮我查代码',
    attachments: [],
    status: 'done',
    statusText: '',
    steps: [],
    answer: '',
    startedAt: 0,
    subagents: [
      { toolUseId: 'tu_e1', title: '查目录结构', subagentType: 'Explore', status: 'done', turn: {} as Turn },
      { toolUseId: 'tu_e2', title: '查测试配置', subagentType: 'Explore', status: 'done', turn: {} as Turn },
      { toolUseId: 'tu_agy', title: '前端调研', subagentType: 'Plan', delegate: true, status: 'done', turn: {} as Turn },
    ],
  },
];
const subs: SubagentCost[] = [
  { agentId: 'a1', toolUseId: 'tu_e1', agentType: 'Explore', source: 'native', requests: 2, cost: { input: 0.1, write: 0, read: 0, output: 0.1 }, uncached: 0.2, unpriced: 0, models: [S45] },
  { agentId: 'a2', toolUseId: 'tu_e2', agentType: 'Explore', source: 'native', requests: 1, cost: { input: 0.05, write: 0, read: 0, output: 0.05 }, uncached: 0.1, unpriced: 0, models: [S45] },
  { agentId: 'a3', toolUseId: 'tu_agy', agentType: 'Plan', source: 'agy', requests: 2, cost: { input: 0.12, write: 0, read: 0, output: 0.03 }, uncached: 0.15, unpriced: 0, models: ['gemini-4-neon'] },
];

describe('CostSection 来源成分与切换', () => {
  it('默认按来源显示且只列出有值的来源；支持切换到按类别；混合计费标等价与提示', () => {
    const onOpenSubagent = vi.fn();
    const el = render(
      <CostSection
        points={points}
        turns={turns}
        subs={subs}
        table={BUILTIN_PRICES}
        billing="api"
        onOpenSubagent={onOpenSubagent}
      />,
    );

    // 合计 = 0.30 + 0.20 + 0.10 + 0.15 = $0.75，副标题「整个会话」
    expect(el.querySelector('[data-testid="cost-total"]')?.textContent).toBe('$0.75');
    expect(el.querySelector('.cz-ctx__cache-sub')?.textContent).toBe('整个会话');

    // 默认按来源：只显示有值的 主线程 / 原生子代理 / Antigravity
    const rows = [...el.querySelectorAll('.cz-ctx__list--cats > li')];
    expect(rows.map((r) => r.querySelector('.cz-ctx__item-name')?.textContent)).toEqual([
      '主线程',
      '原生子代理',
      'Antigravity等价',
    ]);
    // 混合计费说明
    expect(el.textContent).toContain('订阅账号部分按等价 API 价格计');

    // 点击原生子代理行展开类型明细（Explore ×2），点击具体子代理打开浮层
    act(() => (rows[1] as HTMLElement).click());
    const detail = el.querySelector('[data-testid="cost-source-detail"]')!;
    expect(detail).not.toBeNull();
    expect(detail.textContent).toContain('Explore ×2');
    expect(detail.textContent).toContain('$0.30');

    const runBtns = [...detail.querySelectorAll<HTMLButtonElement>('.cz-ctx__cost-run')];
    expect(runBtns).toHaveLength(2);
    act(() => runBtns[0]!.click());
    expect(onOpenSubagent).toHaveBeenCalledWith('t0', 'tu_e1');

    // 切换到「按类别」
    const tabs = [...el.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent)).toEqual(['按来源', '按类别']);
    act(() => tabs[1]!.click());
    expect(el.textContent).toContain('读缓存');
    expect(el.textContent).toContain('写缓存');
    expect(el.textContent).toContain('未缓存输入');

    // 切回「按来源」
    act(() => tabs[0]!.click());
    expect(el.querySelectorAll('.cz-ctx__list--cats > li')).toHaveLength(3);
  });
});
