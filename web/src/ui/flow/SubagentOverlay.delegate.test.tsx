// @vitest-environment jsdom
// 委派子代理：浮层里的停止 / 追加消息，以及会话流子代理行上的停止按钮。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DelegateJobInfo, SubagentRun, Turn } from '@cosyee/shared';
import { withRecord } from '../../core/reducer';
import { SessionDock } from './SessionDock';
import { SubagentOverlay } from './SubagentOverlay';
import { DelegateContext } from './delegateContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom 没有 ResizeObserver（贴底逻辑用到）
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const turn = (over: Partial<Turn> = {}): Turn => ({
  id: 'sub-D', userText: '拆组件', attachments: [], status: 'running', statusText: '', steps: [], answer: '', subagents: [], startedAt: 1, ...over,
});
const run = (over: Partial<SubagentRun> = {}): SubagentRun => ({
  toolUseId: 'D', title: '重构登录页', status: 'running', afterStep: 0, delegate: true, subagentType: 'general-purpose', background: true, turn: turn(), ...over,
});
const job = (over: Partial<DelegateJobInfo> = {}): DelegateJobInfo => ({
  toolUseId: 'D', conversationId: 'c1', description: '重构登录页', background: true, state: 'running', startedAt: 1, pending: 0, tail: '', ...over,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(node: ReactNode) {
  if (root) {
    act(() => root!.unmount());
    host!.remove();
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  document.body.innerHTML = '';
});

const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);

describe('SubagentOverlay：委派的执行过程', () => {
  const done = run({ status: 'done', turn: turn({ status: 'done', answer: '最终结果', endedAt: 2 }) });

  it('历史里只有结果：提示没有记录；补上过程记录后点「完成」能展开步骤', () => {
    mount(<SubagentOverlay run={done} onClose={() => {}} />);
    expect(q('.cz-flow__no-record')?.textContent).toBe('没有其它执行过程');
    const rec = turn({ status: 'done', steps: [{ kind: 'text', text: '先看看目录' }], answer: '记录里的' });
    mount(<SubagentOverlay run={withRecord(done, rec)} onClose={() => {}} />);
    expect(q('.cz-flow__no-record')).toBeNull();
    expect(document.body.textContent).not.toContain('先看看目录');
    const row = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')].find((b) => b.textContent?.includes('完成'))!;
    act(() => row.click());
    expect(document.body.textContent).toContain('先看看目录');
    expect(document.body.textContent).toContain('最终结果');
  });

  it('整轮被 isHiddenTurn 隐藏时，仍保留无执行过程记录提示', () => {
    const hidden = run({
      status: 'done',
      turn: turn({ userText: '/compact', local: true, status: 'done', steps: [], answer: '', endedAt: 2 }),
    });
    mount(<SubagentOverlay run={hidden} onClose={() => {}} />);
    expect(q('.cz-flow__item')).toBeNull();
    expect(q('.cz-flow__no-record')?.textContent).toBe('没有执行过程记录');
  });
});

describe('SubagentOverlay：Esc 分层关闭', () => {
  it('浮层内打开附件预览后，第一次 Esc 只关预览，第二次 Esc 才关浮层；输入法组合中不关', () => {
    const onClose = vi.fn();
    const withAtt = run({
      status: 'done',
      turn: turn({
        userText: '看 file1',
        attachments: [{ kind: 'file', label: 'file1', path: '/a/b.ts' }],
        status: 'done',
        endedAt: 2,
      }),
    });
    mount(<SubagentOverlay run={withAtt} onClose={onClose} />);
    const tag = q<HTMLElement>('.cz-flow__tag')!;
    act(() => tag.click());
    expect(q('.cz-preview')).not.toBeNull();

    // 输入法组合态的 Esc 不应关闭任何层
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }));
    });
    expect(q('.cz-preview')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // 第一次 Esc：只关最内层 ChipPreview，浮层保持打开
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(q('.cz-preview')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    // 第二次 Esc：关闭浮层
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('SubagentOverlay：委派停止与底部统计区', () => {
  const props = () => ({ onClose: () => {}, delegates: [job()], onDelegateStop: vi.fn() });

  it('运行中且有任务快照：头部保留「停止」，不再渲染追加输入框，统计区标题行含后台 / 排队信息', () => {
    const p = props();
    mount(<SubagentOverlay run={run({ model: 'gpt-5.3-codex', effort: 'high' })} {...p} delegates={[job({ pending: 2 })]} />);
    const stop = [...document.querySelectorAll<HTMLElement>('.cz-flow__head-btn')].find((b) => b.textContent?.includes('停止'))!;
    act(() => stop.click());
    expect(p.onDelegateStop).toHaveBeenCalledWith('D');
    expect(q('.cz-flow__append')).toBeNull();
    expect(q('.cz-flow__append-input')).toBeNull();
    // 顶栏不再有 meta 行
    expect(q('.cz-flow__panel-meta')).toBeNull();
    const meta = q('.cz-subdock__meta')!.textContent!;
    expect(meta).toContain('后台');
    expect(meta).toContain('排队 2 条');
    expect(meta).toContain('0 次请求');
    expect(meta).toContain('执行中');
  });

  it('底部统计区默认展开，点击标题行可收起再展开，有数据时展示四块卡片', () => {
    const withStats = run({
      status: 'done',
      model: 'claude-sonnet-4-5-20250929',
      effort: 'medium',
      contextWindow: 200_000,
      cache: [
        { id: 'p1', turn: 0, input: 1000, create: 4000, read: 15_000, rate: 75, output: 300, model: 'claude-sonnet-4-5-20250929' },
      ],
      turn: turn({ status: 'done', startedAt: 1000, endedAt: 13_000 }),
    });
    mount(<SubagentOverlay run={withStats} onClose={() => {}} sessionBilling="subscription" />);

    const head = q<HTMLButtonElement>('.cz-subdock__head')!;
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(q('.cz-subdock__wrap')!.classList.contains('is-open')).toBe(true);
    expect(q('.cz-subdock__meta')!.textContent).toContain('1 次请求');
    expect(q('.cz-subdock__meta')!.textContent).toContain('12 秒');
    expect(q('.cz-subdock__meta')!.textContent).toContain('已完成');
    expect(document.querySelectorAll('.cz-ub-dock__card')).toHaveLength(4);
    expect(q('[data-testid="dock-percent"]')!.textContent).toBe('10%');
    expect(q('[data-testid="dock-cost"]')).not.toBeNull();
    expect(document.body.textContent).toContain('花费（等价 API 价格）');

    // 点击标题行收起
    act(() => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(q('.cz-subdock__wrap')!.classList.contains('is-open')).toBe(false);

    // 再次点击展开
    act(() => head.click());
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(q('.cz-subdock__wrap')!.classList.contains('is-open')).toBe(true);
  });

  it('已结束 / 没有任务快照 / 普通子代理：不显示停止按钮，不渲染追加输入框', () => {
    mount(<SubagentOverlay run={run({ status: 'done' })} {...props()} />);
    expect(q('.cz-flow__head-btn')).toBeNull();
    expect(q('.cz-flow__append')).toBeNull();
    mount(<SubagentOverlay run={run()} {...props()} delegates={[]} />);
    expect(q('.cz-flow__head-btn')).toBeNull();
    expect(q('.cz-flow__append')).toBeNull();
    mount(<SubagentOverlay run={run({ delegate: undefined, subagentType: 'general-purpose' })} {...props()} />);
    expect(q('.cz-flow__append')).toBeNull();
    expect(q('.cz-subdock__meta')!.textContent).toContain('主会话账号');
  });
});

describe('SessionDock 子代理行：委派的停止按钮', () => {
  const t = (runs: SubagentRun[]): Turn => turn({ id: 't1', status: 'done', subagents: runs });

  it('执行中的委派行有停止按钮，点击只停止、不打开浮层；带「后台」标', () => {
    const stop = vi.fn();
    const open = vi.fn();
    mount(
      <DelegateContext.Provider value={{ stop }}>
        <SessionDock turns={[t([run()])]} sessionKey="s1" onOpenSubagent={open} />
      </DelegateContext.Provider>,
    );
    expect(q('.cz-flow__agent-bg')!.textContent).toBe('后台');
    act(() => q<HTMLButtonElement>('.cz-flow__agent-stop')!.click());
    expect(stop).toHaveBeenCalledWith('D');
    expect(open).not.toHaveBeenCalled();
    act(() => q<HTMLButtonElement>('.cz-flow__agent-row')!.click());
    expect(open).toHaveBeenCalledWith('t1', 'D');
  });

  it('已结束的委派、普通子代理、没有 Provider：不显示停止按钮', () => {
    const stop = vi.fn();
    mount(
      <DelegateContext.Provider value={{ stop }}>
        <SessionDock turns={[t([run({ status: 'done' }), run({ toolUseId: 'E', delegate: undefined, subagentType: 'Explore' })])]} sessionKey="s1" />
      </DelegateContext.Provider>,
    );
    expect(q('.cz-flow__agent-stop')).toBeNull();
    mount(<SessionDock turns={[t([run()])]} sessionKey="s2" />);
    expect(q('.cz-flow__agent-stop')).toBeNull();
  });
});
