// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SubagentRun, Turn } from '@cosyee/shared';
import { DelegateContext } from './delegateContext';
import { SessionDock } from './SessionDock';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mkTurn = (over: Partial<Turn> = {}): Turn => ({
  id: 't1',
  userText: 'hi',
  attachments: [],
  status: 'done',
  statusText: '',
  steps: [],
  answer: '',
  subagents: [],
  startedAt: 1,
  ...over,
});

const mkRun = (toolUseId: string, over: Partial<SubagentRun> = {}): SubagentRun => ({
  toolUseId,
  title: `子代理 ${toolUseId}`,
  status: 'done',
  turn: mkTurn({ id: `sub-${toolUseId}` }),
  ...over,
});

let root: Root | null = null;
let host: HTMLElement | null = null;
function render(node: ReactNode) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(node));
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const head = (cls = '.cz-flow__agents') => host!.querySelector<HTMLButtonElement>(`${cls} .cz-flow__agents-head`)!;
const isOpen = (cls?: string) => head(cls).getAttribute('aria-expanded') === 'true';
const tap = (cls?: string) => act(() => head(cls).click());
const skill = (id: string, name: string) => ({ id, name, source: 'model' as const, status: 'loaded' as const, body: '正文' });
const mcpStep = (id: string) => ({ kind: 'tool' as const, id, name: 'mcp__docs__search', input: {}, summary: '', result: { content: 'ok', isError: false } });

describe('SessionDock：进行中展开，交付后收起', () => {
  const busy = mkTurn({ id: 't1', status: 'running', subagents: [mkRun('a')], skills: [skill('k1', 'verify')], steps: [mcpStep('m1')] });
  const opened = () => ['.cz-flow__agents', '.cz-flow__skills', '.cz-flow__mcp'].map((c) => isOpen(c));

  it('进行中的轮用到的面板展开（调用已返回也不收），轮结束只剩标题行', () => {
    render(<SessionDock turns={[busy]} sessionKey="s1" />);
    expect(opened()).toEqual([true, true, true]);
    expect(host!.querySelectorAll('.cz-flow__agents-list')).toHaveLength(3);
    for (const status of ['done', 'error'] as const) {
      render(<SessionDock turns={[{ ...busy, status }]} sessionKey="s1" />);
      expect(opened()).toEqual([false, false, false]);
      expect(host!.querySelectorAll('.cz-flow__agents-list')).toHaveLength(0);
      expect(head('.cz-flow__skills').textContent).toBe('已加载 1 个技能');
    }
  });

  it('可手动开合；进行状态翻转后回到默认', () => {
    const done = { ...busy, status: 'done' as const };
    render(<SessionDock turns={[done]} sessionKey="s1" />);
    tap('.cz-flow__skills');
    expect(opened()).toEqual([false, true, false]);
    render(<SessionDock turns={[busy]} sessionKey="s1" />);
    expect(isOpen('.cz-flow__skills')).toBe(true);
    tap('.cz-flow__skills');
    render(<SessionDock turns={[{ ...busy, answer: '流式' }]} sessionKey="s1" />);
    expect(isOpen('.cz-flow__skills')).toBe(false); // 进行中手动收起后不再强制展开
    render(<SessionDock turns={[done]} sessionKey="s1" />);
    render(<SessionDock turns={[busy]} sessionKey="s1" />);
    expect(isOpen('.cz-flow__skills')).toBe(true);
  });

  it('只发新消息不重新展开旧面板；新轮用到哪类才展开哪类', () => {
    const done = { ...busy, status: 'done' as const };
    render(<SessionDock turns={[done, mkTurn({ id: 't2', status: 'understanding' })]} sessionKey="s1" />);
    expect(opened()).toEqual([false, false, false]);
    render(<SessionDock turns={[done, mkTurn({ id: 't2', status: 'running', steps: [mcpStep('m2')] })]} sessionKey="s1" />);
    expect(opened()).toEqual([false, false, true]);
  });

  it('后台子代理在主轮结束后仍展开，跑完才收起', () => {
    const t = (status: 'running' | 'done') => mkTurn({ id: 't1', subagents: [mkRun('a', { status, delegate: true, background: true })] });
    render(<SessionDock turns={[t('running')]} sessionKey="s1" />);
    expect(isOpen()).toBe(true);
    render(<SessionDock turns={[t('done')]} sessionKey="s1" />);
    expect(isOpen()).toBe(false);
  });

  it('切换会话复位手动展开', () => {
    const done = { ...busy, status: 'done' as const };
    render(<SessionDock turns={[done]} sessionKey="s1" />);
    tap('.cz-flow__mcp');
    render(<SessionDock turns={[done]} sessionKey="s2" />);
    expect(isOpen('.cz-flow__mcp')).toBe(false);
  });
});

describe('SessionDock', () => {
  it('三类都没有数据时返回 null', () => {
    render(<SessionDock turns={[mkTurn()]} sessionKey="s1" />);
    expect(host!.innerHTML).toBe('');
  });

  it('进行中的面板独立展示列表与原文案，无汇总条；执行中才带动画与流光', () => {
    const turns = [
      mkTurn({
        id: 't1',
        status: 'running',
        subagents: [mkRun('a', { status: 'running' }), mkRun('b', { status: 'done' })],
        skills: [{ id: 'sk1', name: 'verify', source: 'model', status: 'loaded', body: '# verify' }],
      }),
    ];
    render(<SessionDock turns={turns} sessionKey="s1" />);

    // 没有汇总条
    expect(host!.querySelector('.cz-dock__bar')).toBeNull();

    // 有数据的两个面板独立渲染，无数据的 MCP 面板不出现
    const panels = [...host!.querySelectorAll('.cz-flow__agents')];
    expect(panels).toHaveLength(2);
    expect(host!.querySelector('.cz-flow__skills')).not.toBeNull();
    expect(host!.querySelector('.cz-flow__mcp')).toBeNull();

    // 无需点击即可见原文案与列表项
    expect(panels[0].querySelector('.cz-flow__agents-head')!.textContent).toBe('2 个子代理执行中 1/2');
    expect(panels[1].querySelector('.cz-flow__agents-head')!.textContent).toBe('已加载 1 个技能');
    expect([...host!.querySelectorAll('.cz-flow__agent-item .cz-flow__agent-title')].map((el) => el.textContent)).toEqual([
      '子代理 a',
      '子代理 b',
    ]);
    expect(host!.querySelector('.cz-flow__skills .cz-flow__pitem-row')!.textContent).toContain('verify');

    // 子代理在执行：图标不静止、文字流光；技能已完成：图标静止、无流光
    expect(panels[0].querySelector('.cz-ss-agent')!.classList.contains('is-still')).toBe(false);
    expect(panels[0].querySelector('.cz-st-compacting')).not.toBeNull();
    expect(panels[1].querySelector('.cz-ss-skill')!.classList.contains('is-still')).toBe(true);
    expect(panels[1].querySelector('.cz-st-compacting')).toBeNull();
  });

  it('同会话新增轮与压缩后仍展示旧条目；三类各自独立显示原文案', () => {
    const t1 = mkTurn({
      id: 't1',
      subagents: [mkRun('a')],
      skills: [{ id: 'sk0', name: 'impeccable', source: 'model', status: 'loaded', body: '旧技能' }],
      steps: [
        {
          kind: 'tool',
          id: 'm0',
          name: 'mcp__docs__search',
          input: {},
          summary: '',
          result: { content: 'ok', isError: false },
        },
      ],
    });
    render(<SessionDock turns={[t1]} sessionKey="s1" />);
    expect(host!.querySelectorAll('.cz-flow__agents')).toHaveLength(3);
    expect(host!.querySelector('.cz-flow__agents .cz-flow__agents-head')!.textContent).toBe('1 个子代理已完成');
    expect(host!.querySelector('.cz-flow__skills .cz-flow__agents-head')!.textContent).toBe('已加载 1 个技能');
    expect(host!.querySelector('.cz-flow__mcp .cz-flow__agents-head')!.textContent).toBe('调用了 1 个 MCP 服务');

    // 同会话追加压缩轮与新轮：旧条目保留，新条目追加在末尾
    const tCompact = mkTurn({ id: 't-compact', local: true, userText: '/compact' });
    const t2 = mkTurn({
      id: 't2',
      status: 'running',
      subagents: [mkRun('b', { status: 'running' })],
      skills: [{ id: 'sk1', name: 'debug', source: 'model', status: 'loading' }],
      steps: [{ kind: 'tool', id: 'm1', name: 'mcp__pw__nav', input: {}, summary: '' }],
    });
    render(<SessionDock turns={[t1, tCompact, t2]} sessionKey="s1" />);
    expect(host!.querySelectorAll('.cz-flow__agents')).toHaveLength(3);
    expect(host!.querySelector('.cz-flow__agents .cz-flow__agents-head')!.textContent).toBe('2 个子代理执行中 1/2');
    expect(host!.querySelector('.cz-flow__skills .cz-flow__agents-head')!.textContent).toBe('正在加载技能 … 共 2 个');
    expect(host!.querySelector('.cz-flow__mcp .cz-flow__agents-head')!.textContent).toBe('调用了 2 个 MCP 服务');
    expect([...host!.querySelectorAll('.cz-flow__agent-item .cz-flow__agent-title')].map((el) => el.textContent)).toEqual([
      '子代理 a',
      '子代理 b',
    ]);
    expect([...host!.querySelectorAll('.cz-flow__skills .cz-flow__pitem-row')].map((el) => el.textContent)).toEqual([
      expect.stringContaining('impeccable'),
      expect.stringContaining('debug'),
    ]);
    expect([...host!.querySelectorAll('.cz-flow__mcp .cz-flow__mcp-name')].map((el) => el.textContent)).toEqual([
      'docs',
      'pw',
    ]);
  });

  it('切换 sessionKey 时行内详情展开状态复位', () => {
    const turns = [
      mkTurn({
        id: 't1',
        skills: [{ id: 'sk1', name: 'verify', source: 'model', status: 'loaded', body: '技能正文内容' }],
        steps: [
          {
            kind: 'tool',
            id: 'm1',
            name: 'mcp__docs__search',
            input: { q: 'hello' },
            summary: '',
            result: { content: 'MCP 结果文本', isError: false },
          },
        ],
      }),
    ];
    render(<SessionDock turns={turns} sessionKey="s1" />);

    // 已交付：先点开面板，再展开技能详情与 MCP 工具详情
    tap('.cz-flow__skills');
    tap('.cz-flow__mcp');
    act(() => host!.querySelector<HTMLButtonElement>('.cz-flow__skills .cz-flow__pitem-row')!.click());
    act(() => host!.querySelector<HTMLButtonElement>('.cz-flow__mcp-tool')!.click());
    expect(host!.textContent).toContain('技能正文内容');
    expect(host!.textContent).toContain('MCP 结果文本');

    // 切换 sessionKey：重新点开面板后，行内详情仍是收起的
    render(<SessionDock turns={turns} sessionKey="s2" />);
    tap('.cz-flow__skills');
    tap('.cz-flow__mcp');
    expect(host!.textContent).not.toContain('技能正文内容');
    expect(host!.textContent).not.toContain('MCP 结果文本');
    expect(host!.querySelector('.cz-flow__pdetail')).toBeNull();
  });

  it('点击子代理回调传最新副本的 turnId 和 toolUseId；委派停止按钮不触发打开', () => {
    const onOpen = vi.fn();
    const stop = vi.fn();
    const turns = [
      mkTurn({ id: 't1', subagents: [mkRun('D', { status: 'error', delegate: true })] }),
      mkTurn({ id: 't2', status: 'running', subagents: [mkRun('D', { status: 'running', delegate: true, background: true })] }),
    ];
    render(
      <DelegateContext.Provider value={{ stop }}>
        <SessionDock turns={turns} sessionKey="s1" onOpenSubagent={onOpen} />
      </DelegateContext.Provider>,
    );
    act(() => host!.querySelector<HTMLButtonElement>('.cz-flow__agent-stop')!.click());
    expect(stop).toHaveBeenCalledWith('D');
    expect(onOpen).not.toHaveBeenCalled();

    act(() => host!.querySelector<HTMLButtonElement>('.cz-flow__agent-row')!.click());
    expect(onOpen).toHaveBeenCalledWith('t2', 'D');
  });
});
