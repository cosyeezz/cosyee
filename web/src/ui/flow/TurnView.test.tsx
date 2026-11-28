// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Turn } from '@cosyee/shared';
import { TurnView } from './TurnView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base: Turn = {
  id: 't',
  userText: '',
  attachments: [],
  status: 'running',
  statusText: '模型的中间文字',
  steps: [],
  answer: '',
  subagents: [],
  startedAt: Date.now(),
};

const toolSteps: Turn['steps'] = [
  { kind: 'text', text: '第一段说明' },
  { kind: 'tool', id: 'a', name: 'Bash', input: { command: 'ls' }, summary: 'Bash: ls' },
  { kind: 'text', text: '第二段说明' },
  { kind: 'tool', id: 'b', name: 'Read', input: {}, summary: 'Read: a.ts' },
];

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(turn: Turn, container?: HTMLElement) {
  host = container ?? document.createElement('div');
  if (!container) document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<TurnView turn={turn} />));
  const status = () => host!.querySelector('.cz-flow__status') as HTMLElement;
  return {
    host: host!,
    status,
    answer: () => host!.querySelector('.cz-flow__answer')?.textContent ?? '',
    steps: () => host!.querySelector('.cz-flow__steps'),
    click: () => act(() => status().click()),
  };
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('TurnView 首行：进行中', () => {
  it('还没有模型文本：星轨图标 + 「正在理解问题」（三色流光），不显示 statusText，无箭头', () => {
    const v = mount(base);
    expect(v.status().textContent).toContain('正在理解问题');
    expect(v.host.querySelector('.cz-st-thinking')?.textContent).toBe('正在理解问题');
    expect(v.host.querySelector('.cz-ss-thinking')).not.toBeNull();
    expect(v.host.querySelector('.cz-ss-tool')).toBeNull();
    expect(v.host.textContent).not.toContain('模型的中间文字');
    expect(v.host.querySelector('.icon-chevron')).toBeNull();
  });

  it('只有思考 / 工具调用时仍是「正在理解问题」', () => {
    const v = mount({
      ...base,
      steps: [
        { kind: 'thinking', text: '想一想', streaming: true },
        { kind: 'tool', id: 'a', name: 'Bash', input: {}, summary: 'Bash: ls' },
      ],
    });
    expect(v.status().textContent).toContain('正在理解问题');
    expect(v.host.querySelector('.cz-ss-thinking')).not.toBeNull();
  });

  it('模型有文本：神经脉冲图标 + 最近一段文本首行（青色流光、去 markdown）；之后的工具不改变它', () => {
    const v = mount({
      ...base,
      steps: [
        { kind: 'text', text: '**先读一下** reducer\n再看测试' },
        { kind: 'tool', id: 'a', name: 'Bash', input: {}, summary: 'Bash: ls' },
      ],
    });
    expect(v.host.querySelector('.cz-st-tool')?.textContent).toBe('先读一下 reducer');
    expect(v.host.querySelector('.cz-ss-tool')).not.toBeNull();
    expect(v.host.querySelector('.cz-ss-thinking')).toBeNull();
    expect(v.status().textContent).not.toContain('正在理解问题');
    // 执行中下方只放交付，过程文字不出现（它在状态行首行与展开区里）
    expect(v.host.querySelector('.cz-flow__answer')).toBeNull();
  });

  it('进行中正在写 answer：首行跟随 answer，下方仍不显示正文', () => {
    const v = mount({ ...base, answer: '最终结论如下\n细节' });
    expect(v.host.querySelector('.cz-st-tool')?.textContent).toBe('最终结论如下');
    expect(v.host.querySelector('.cz-flow__answer')).toBeNull();
  });

  it('回合结束：交付文字出现在下方', () => {
    const v = mount({ ...base, status: 'done', answer: '最终结论如下\n细节', endedAt: base.startedAt + 1000 });
    expect(v.answer()).toContain('细节');
  });

  it('等待后台任务（awaited）：雷达脉冲图标 + 等待文字，不提前交付正文', () => {
    const v = mount({
      ...base,
      steps: [{ kind: 'text', text: '已启动监听，完成后汇报' }],
      waitingTasks: [{ id: 'gh1', kind: 'awaited', description: '盯发版 CI' }],
    });
    expect(v.host.querySelector('.cz-ss-waiting')).not.toBeNull();
    expect(v.host.querySelector('.cz-st-waiting')?.textContent).toBe('等待后台：盯发版 CI');
    expect(v.host.querySelector('.cz-flow__answer')).toBeNull();
  });

  it('已完成但有常驻后台任务：状态行 meta 末尾显示轻量提示', () => {
    const start = Date.now();
    const v = mount({
      ...base,
      status: 'done',
      startedAt: start,
      endedAt: start + 2000,
      answer: '已启动',
      persistentTasks: [{ id: 'd1', kind: 'persistent', description: 'npm run dev' }],
    });
    expect(v.status().textContent).toContain('已完成');
    expect(v.status().textContent).toContain('后台：npm run dev 运行中');
    expect(v.answer()).toContain('已启动');
  });

  it('无步骤时状态行不可点击', () => {
    const v = mount(base);
    expect(v.status().tagName).toBe('DIV');
    expect(v.status().hasAttribute('aria-expanded')).toBe(false);
  });
});

describe('TurnView 首行：结束态', () => {
  it('已完成：绿色完成图标 + 「已完成 · 时间 · 共 N 步 · 用时」，文字渐显类，答复保留', () => {
    const start = Date.now();
    const v = mount({ ...base, status: 'done', steps: toolSteps, startedAt: start, endedAt: start + 3000, answer: '最终答复' });
    const text = v.status().textContent!;
    expect(text).toMatch(/^已完成 · (\d{1,2}月\d{1,2}日 )?\d{2}:\d{2} · 共 4 步 · 用时 3 秒$/);
    expect(v.host.querySelector('.cz-ss-done')).not.toBeNull();
    expect(v.host.querySelector('.cz-st-done')?.textContent).toBe('已完成');
    expect(v.answer()).toContain('最终答复');
    expect(v.host.querySelector('.is-streaming')).toBeNull();
  });

  it('已完成：非今天的时间带日期', () => {
    const start = new Date(2020, 0, 2, 9, 0, 0).getTime();
    const v = mount({ ...base, status: 'done', startedAt: start, endedAt: start + 18_000 });
    expect(v.status().textContent).toBe('已完成 · 2020年1月2日 09:00 · 用时 18 秒');
  });

  it('中断：停止图标与文字样式', () => {
    const v = mount({ ...base, status: 'interrupted', reason: '已中断', endedAt: base.startedAt + 1000 });
    expect(v.host.querySelector('.cz-ss-stopped')).not.toBeNull();
    expect(v.host.querySelector('.cz-st-stopped')?.textContent).toBe('已中断');
  });

  it('出错：错误图标、文字样式与原因', () => {
    const v = mount({ ...base, status: 'error', reason: 'API 超时', endedAt: base.startedAt + 1000 });
    expect(v.host.querySelector('.cz-ss-error')).not.toBeNull();
    expect(v.host.querySelector('.cz-st-error')?.textContent).toBe('出错了');
    expect(v.status().textContent).toContain('API 超时');
  });
});

describe('TurnView 展开 / 吸顶 / 收起滚回', () => {
  it('结束后折叠：只显示最后一段文字，不显示工具行；点击整行展开后只显示 answer', () => {
    const v = mount({ ...base, status: 'done', steps: toolSteps, endedAt: base.startedAt + 1000 });
    expect(v.status().tagName).toBe('BUTTON');
    expect(v.status().getAttribute('aria-expanded')).toBe('false');
    expect(v.status().classList.contains('is-open')).toBe(false);
    expect(v.answer()).toContain('第二段说明');
    expect(v.host.textContent).not.toContain('第一段说明');
    expect(v.host.textContent).not.toContain('Bash: ls');

    v.click();
    expect(v.status().getAttribute('aria-expanded')).toBe('true');
    // is-open 即吸顶（position: sticky 见 flow.css）
    expect(v.status().classList.contains('is-open')).toBe(true);
    expect(v.steps()).not.toBeNull();
    expect(v.steps()!.textContent).toContain('第一段说明');
    expect(v.host.querySelector('.cz-flow__answer')).toBeNull();

    v.click();
    expect(v.steps()).toBeNull();
  });

  describe('收起时首行已被顶出视口', () => {
    const rect = (top: number) => ({ top, bottom: top + 100, left: 0, right: 0, width: 0, height: 100, x: 0, y: top, toJSON: () => ({}) });
    const original = Element.prototype.scrollIntoView;
    afterEach(() => {
      Element.prototype.scrollIntoView = original;
    });

    function setup(turnTop: number) {
      const scroller = document.createElement('div');
      scroller.className = 'cz-flow__scroll';
      scroller.getBoundingClientRect = () => rect(100) as DOMRect;
      document.body.appendChild(scroller);
      const spy = vi.fn();
      Element.prototype.scrollIntoView = spy;
      const v = mount({ ...base, status: 'done', steps: toolSteps, endedAt: base.startedAt + 1000 }, scroller);
      v.click();
      const turnEl = v.host.querySelector('.cz-flow__turn') as HTMLElement;
      turnEl.getBoundingClientRect = () => rect(turnTop) as DOMRect;
      return { v, spy };
    }

    it('回合顶部已滚出可视区：收起后把首行滚回视口', () => {
      const { v, spy } = setup(-300);
      v.click();
      expect(v.steps()).toBeNull();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.instances[0]).toBe(v.status());
    });

    it('回合顶部仍在可视区：收起不滚动', () => {
      const { v, spy } = setup(150);
      v.click();
      expect(v.steps()).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

describe('TurnView 面板可见性', () => {
  const sub = (status: 'running' | 'done', id: string) => ({ toolUseId: id, title: '查一下', status, turn: base });
  const withAll: Turn = {
    ...base,
    steps: [{ kind: 'tool', id: 'm1', name: 'mcp__pw__nav', input: {}, summary: 'nav', result: { content: 'ok', isError: false } }],
    subagents: [sub('running', 'a'), sub('done', 'b')],
    skills: [{ id: 's1', name: 'verify', source: 'model', status: 'loaded' }],
  };

  it('不再内联渲染子代理 / 技能 / MCP 面板，状态行保留子代理进度', () => {
    const v = mount(withAll);
    expect(v.host.querySelector('.cz-flow__agents-list')).toBeNull();
    expect(v.host.querySelector('.cz-flow__pitem')).toBeNull();
    expect(v.host.querySelector('.cz-flow__agent-item')).toBeNull();
    expect(v.status().textContent).toContain('子代理 1/2');
  });
});
