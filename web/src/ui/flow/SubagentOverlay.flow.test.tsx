// @vitest-environment jsdom
// 校验子代理浮层与主画面共用同一套 ConversationView 会话流渲染代码，
// 包括 DOM 结构一致、字号缩放同步、SessionDock 展示技能/MCP、不渲染分支按钮与选中浮条。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SubagentRun, Turn } from '@cosyee/shared';
import { ConversationView } from './ConversationView';
import { SubagentOverlay } from './SubagentOverlay';
import { SessionDock } from './SessionDock';
import { setFlowZoom } from './flowZoom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const startedAt = new Date(2025, 5, 1, 10, 30, 0).getTime();
const sampleTurn: Turn = {
  id: 'turn-unify',
  userId: 'u-1',
  userText: '请检查仓库里的配置与测试',
  attachments: [],
  status: 'done',
  statusText: '',
  steps: [
    { kind: 'thinking', text: '先查看一下 package.json 再跑测试。' },
    { kind: 'text', text: '我先读取配置文件。' },
    {
      kind: 'tool',
      id: 't-read',
      name: 'Read',
      input: { file_path: '/repo/package.json' },
      summary: 'Read: /repo/package.json',
      result: { content: '{"name":"demo"}', isError: false },
    },
    {
      kind: 'tool',
      id: 't-bash',
      name: 'Bash',
      input: { command: 'npm test' },
      summary: 'Bash: npm test',
      result: { content: 'All passed', isError: false },
    },
    {
      kind: 'tool',
      id: 't-mcp',
      name: 'mcp__docs__search',
      input: { q: 'vitest' },
      summary: 'search',
      result: { content: [{ type: 'text', text: 'hit' }], isError: false },
    },
  ],
  answer: '配置正常，测试全部通过。',
  subagents: [],
  skills: [{ id: 'sk-1', name: 'verify', source: 'model', status: 'loaded', body: '# verify\n\n检查项' }],
  startedAt,
  endedAt: startedAt + 12_000,
};

const sampleRun: SubagentRun = {
  toolUseId: 'sub-unify',
  title: '检查配置与测试',
  status: 'done',
  subagentType: 'Explore',
  turn: sampleTurn,
};

const roots: Array<{ root: Root; host: HTMLElement }> = [];

function mount(node: JSX.Element): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(node));
  roots.push({ root, host });
  return host;
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  while (roots.length) {
    const { root, host } = roots.pop()!;
    act(() => root.unmount());
    host.remove();
  }
  setFlowZoom(1);
});

/** useId 生成的 SVG 渐变 id 每个 React root 各不相同，比较前统一掉 */
const html = (el: HTMLElement) => el.outerHTML.replace(/\br\d+-/g, 'r-');
describe('SubagentOverlay 与 ConversationView 会话流统一', () => {
  it('同一个 Turn 在主画面与浮层中，展开状态行前后 .cz-flow__wrap 的 outerHTML 完全相等', () => {
    // 主画面同样把会话活动区放在会话流末尾（footer）
    const mainHost = mount(
      <ConversationView turns={[sampleTurn]} sessionKey="sub-unify" footer={<SessionDock turns={[sampleTurn]} sessionKey="sub-unify" />} />,
    );
    const overlayHost = mount(<SubagentOverlay run={sampleRun} onClose={() => {}} />);

    const mainWrap = mainHost.querySelector<HTMLElement>('.cz-flow__wrap')!;
    const overlayWrap = overlayHost.querySelector<HTMLElement>('.cz-flow__wrap')!;
    expect(mainWrap).not.toBeNull();
    expect(overlayWrap).not.toBeNull();

    // 折叠状态行前：outerHTML 逐字一致
    expect(html(overlayWrap)).toBe(html(mainWrap));

    // 展开状态行后：outerHTML 依然逐字一致
    act(() => mainWrap.querySelector<HTMLButtonElement>('.cz-flow__status')!.click());
    act(() => overlayWrap.querySelector<HTMLButtonElement>('.cz-flow__status')!.click());
    expect(overlayWrap.querySelector('.cz-flow__steps')).not.toBeNull();
    expect(html(overlayWrap)).toBe(html(mainWrap));
  });

  it('浮层 .cz-flow__wrap 的 --cz-flow-zoom 随 setFlowZoom(1.3) 同步变化', () => {
    const overlayHost = mount(<SubagentOverlay run={sampleRun} onClose={() => {}} />);
    const wrap = overlayHost.querySelector<HTMLElement>('.cz-flow__wrap')!;
    expect(wrap.style.getPropertyValue('--cz-flow-zoom')).toBe('1');

    act(() => setFlowZoom(1.3));
    expect(wrap.style.getPropertyValue('--cz-flow-zoom')).toBe('1.3');
  });

  it('浮层通过 SessionDock 显示技能与 MCP，且不出现分支按钮与选中浮条', () => {
    const overlayHost = mount(<SubagentOverlay run={sampleRun} onClose={() => {}} />);

    // SessionDock 独立展示技能与 MCP 面板；已交付的收起成标题行，点开可见列表
    act(() => overlayHost.querySelectorAll<HTMLButtonElement>('.cz-dock__head').forEach((b) => b.click()));
    const skillPanel = overlayHost.querySelector('.cz-dock .cz-flow__skills')!;
    const mcpPanel = overlayHost.querySelector('.cz-dock .cz-flow__mcp')!;
    expect(skillPanel).not.toBeNull();
    expect(mcpPanel).not.toBeNull();
    expect(skillPanel.textContent).toContain('已加载 1 个技能');
    expect(skillPanel.textContent).toContain('verify');
    expect(mcpPanel.textContent).toContain('调用了 1 个 MCP 服务');
    expect(mcpPanel.textContent).toContain('docs');

    // 不出现分支按钮（只有复制原文按钮）
    const actLabels = [...overlayHost.querySelectorAll<HTMLButtonElement>('.cz-flow__acts .cz-flow__icon-btn')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(actLabels).toEqual(['复制原文']);

    // 不挂载选中浮条
    expect(overlayHost.querySelector('.cz-sel')).toBeNull();
  });
});
