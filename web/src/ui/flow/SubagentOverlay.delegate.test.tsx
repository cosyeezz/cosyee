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

const setValue = (el: HTMLInputElement, v: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const q = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel);
const submit = () => act(() => { q<HTMLFormElement>('.cz-flow__append')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });

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

describe('SubagentOverlay：委派任务的停止与追加消息', () => {
  const props = () => ({ onClose: () => {}, delegates: [job()], onDelegateStop: vi.fn(), onDelegateSend: vi.fn() });

  it('运行中且有任务快照：头部有「停止」，底部有输入框', () => {
    const p = props();
    mount(<SubagentOverlay run={run()} {...p} />);
    const stop = [...document.querySelectorAll<HTMLElement>('.cz-flow__head-btn')].find((b) => b.textContent?.includes('停止'))!;
    act(() => stop.click());
    expect(p.onDelegateStop).toHaveBeenCalledWith('D');
    expect(q('.cz-flow__append-input')).not.toBeNull();
    expect(q('.cz-flow__panel-meta')!.textContent).toContain('后台');
  });

  it('提交（Enter）= steer；「排队」= queue；发送后清空，空消息不发', () => {
    const p = props();
    mount(<SubagentOverlay run={run()} {...p} />);
    const input = q<HTMLInputElement>('.cz-flow__append-input')!;
    submit();
    expect(p.onDelegateSend).not.toHaveBeenCalled();
    setValue(input, '  再加个单测 ');
    submit();
    expect(p.onDelegateSend).toHaveBeenLastCalledWith('D', '再加个单测', 'steer');
    expect(input.value).toBe('');
    setValue(input, '之后再说');
    act(() => q<HTMLButtonElement>('.cz-flow__append-btn')!.click());
    expect(p.onDelegateSend).toHaveBeenLastCalledWith('D', '之后再说', 'queue');
  });

  it('显示排队中的条数', () => {
    mount(<SubagentOverlay run={run()} {...props()} delegates={[job({ pending: 2 })]} />);
    expect(q('.cz-flow__panel-meta')!.textContent).toContain('排队 2 条');
  });

  it('已结束 / 没有任务快照 / 普通子代理：不显示停止与输入框', () => {
    mount(<SubagentOverlay run={run({ status: 'done' })} {...props()} />);
    expect(q('.cz-flow__head-btn')).toBeNull();
    expect(q('.cz-flow__append')).toBeNull();
    mount(<SubagentOverlay run={run()} {...props()} delegates={[]} />);
    expect(q('.cz-flow__head-btn')).toBeNull();
    expect(q('.cz-flow__append')).toBeNull();
    mount(<SubagentOverlay run={run({ delegate: undefined, subagentType: 'general-purpose' })} {...props()} />);
    expect(q('.cz-flow__append')).toBeNull();
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
