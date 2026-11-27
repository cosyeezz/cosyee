// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_SUBAGENTS, type DelegateModelList, type SubagentConfig, type SubagentState, type SubagentTypeInfo } from '@cosyee/shared';
import { mockContextUsage } from '../../mock/shell';
import { ContextPanel } from './ContextPanel';
import type { Subagents } from './Subagents';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  host.remove();
});

const delegate: DelegateModelList = {
  models: [
    { value: 'neon', displayName: 'Gemini Neon', efforts: ['low', 'high'] },
    { value: 'orch', displayName: 'Orchestrator', efforts: [] },
  ],
  current: { model: 'neon', effort: 'high' },
  at: 0,
};

const allAvailable: SubagentState['available'] = {
  native: { ok: true },
  claude: { ok: true },
  agy: { ok: true },
};

const mkState = (over: Partial<SubagentState> = {}): SubagentState => ({
  config: DEFAULT_SUBAGENTS,
  available: allAvailable,
  effective: over.config?.kind ?? DEFAULT_SUBAGENTS.kind,
  ...over,
});

type Props = ComponentProps<typeof Subagents>;
const fold = () => host.querySelector<HTMLElement>('.cz-ctx__agents .cz-ctx__fold')!;
function mount(p: Partial<Props> = {}, expand = true) {
  const props: Props = { state: mkState(), onChange: vi.fn(), delegate, onLoadDelegate: vi.fn(), ...p };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} subagents={props} />));
  if (expand) act(() => fold().click());
  return props;
}

const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')];
const radioBy = (name: string) => radios().find((b) => b.textContent?.includes(name))!;
const open = (name: string) => act(() => host.querySelector<HTMLElement>(`[aria-label^="${name}："]`)!.click());
const rows = () => [...document.querySelectorAll<HTMLElement>('.cz-menu__row')];
const labels = () => rows().map((r) => r.querySelector('.cz-menu__label')!.textContent);
const pick = (label: string) => act(() => rows().find((r) => r.querySelector('.cz-menu__label')!.textContent === label)!.click());
const withCfg = (patch: Partial<SubagentConfig>): SubagentConfig => ({ ...DEFAULT_SUBAGENTS, ...patch });

describe('子代理', () => {
  it('在面板主体最后一节（MCP 下方），不再有独立的智能体模块', () => {
    mount();
    const last = host.querySelector('.cz-ctx__body')!.lastElementChild!;
    expect(last.textContent).toContain('子代理');
    expect(last.previousElementSibling!.textContent).toContain('MCP');
    const titles = [...host.querySelectorAll('.cz-ctx__fold-title')].map((t) => t.textContent);
    expect(titles).not.toContain('智能体');
  });

  it('默认折叠，标题右侧显示「类型 · 模型」；点开后展示单选与下拉，再点收起', () => {
    mount({ state: mkState({ config: withCfg({ kind: 'agy', agy: { model: 'neon', effort: null } }) }) }, false);
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(fold().textContent).toBe('子代理Antigravity · Gemini Neon');
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
    act(() => fold().click());
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    expect(radios().map((r) => r.textContent)).toEqual(['原生', 'Claude', 'Antigravity']);
    expect(host.querySelectorAll('.cz-ctx__pick')).toHaveLength(2);
    act(() => fold().click());
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('点击与键盘方向键切换类型，调用 onChange 且 kind 正确', () => {
    const p = mount();
    expect(radioBy('原生').getAttribute('aria-checked')).toBe('true');
    expect(host.textContent).toContain('Agent 工具 开');
    expect(host.textContent).toContain('委派工具 关');

    act(() => radioBy('Claude').click());
    expect(p.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENTS, kind: 'claude' });

    act(() => radioBy('Antigravity').click());
    expect(p.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENTS, kind: 'agy' });

    const group = host.querySelector<HTMLElement>('[role="radiogroup"]')!;
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(p.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENTS, kind: 'claude' });
  });

  it('不可用项禁用并显示原因；方向键自动跳过不可用项', () => {
    const p = mount({
      state: mkState({
        available: { native: { ok: true }, claude: { ok: true }, agy: { ok: false, reason: '未安装 Antigravity CLI' } },
      }),
    });
    const agyBtn = radioBy('Antigravity');
    expect(agyBtn.disabled).toBe(true);
    expect(agyBtn.title).toBe('未安装 Antigravity CLI');
    expect(host.textContent).toContain('未安装 Antigravity CLI');
    act(() => agyBtn.click());
    expect(p.onChange).not.toHaveBeenCalled();

    // 从原生按 ArrowLeft 应跳过禁用的 Antigravity 落到 Claude
    const group = host.querySelector<HTMLElement>('[role="radiogroup"]')!;
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(p.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENTS, kind: 'claude' });
  });

  it('当前选中类型不可用（effective !== config.kind）时提示「已退回原生」', () => {
    mount(
      {
        state: {
          config: withCfg({ kind: 'agy', agy: { model: 'neon', effort: 'high' } }),
          available: { native: { ok: true }, claude: { ok: true }, agy: { ok: false, reason: '未登录 Antigravity' } },
          effective: 'native',
        },
      },
      false,
    );
    expect(fold().textContent).toBe('子代理已退回原生 · Sonnet 5.5');
    act(() => fold().click());
    const banner = host.querySelector('.cz-sub__banner')!;
    expect(banner.textContent).toContain('已退回原生');
    expect(banner.textContent).toContain('未登录 Antigravity');
    // 工具开关按实际生效的原生显示，和提示条一致
    expect(host.textContent).toContain('Agent 工具 开');
    expect(host.textContent).toContain('委派工具 关');
  });

  it('原生：选别名与思考强度', () => {
    const p = mount();
    open('原生子代理模型');
    expect(labels()).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Fable 5.2', 'Haiku 5.5']);
    pick('Opus 5.5');
    expect(p.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENTS, native: { model: 'opus', effort: 'medium' } });
    open('原生子代理思考强度');
    pick('最高');
    expect(p.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_SUBAGENTS, native: { model: 'sonnet', effort: 'max' } });
  });

  it('Claude 委派：模型与强度都含「跟随主会话」选项', () => {
    const p = mount({ state: mkState({ config: withCfg({ kind: 'claude' }) }) });
    expect(host.textContent).toContain('委派工具 开');
    expect(host.textContent).toContain('Agent 工具 关');
    open('Claude 委派模型');
    expect(labels()).toEqual(['跟随主会话', 'Opus 5.5', 'Sonnet 5.5', 'Fable 5.2', 'Haiku 5.5']);
    pick('Opus 5.5');
    expect(p.onChange).toHaveBeenLastCalledWith(withCfg({ kind: 'claude', claude: { model: 'opus', effort: null } }));
    open('Claude 委派思考强度');
    expect(labels()[0]).toBe('跟随主会话');
    pick('高');
    expect(p.onChange).toHaveBeenLastCalledWith(withCfg({ kind: 'claude', claude: { model: null, effort: 'high' } }));
  });

  it('Antigravity：默认跟随后端默认；换到不分强度的模型时强度回到默认', () => {
    const p = mount({ state: mkState({ config: withCfg({ kind: 'agy', agy: { model: 'neon', effort: 'high' } }) }) });
    open('Antigravity 模型');
    expect(labels()).toEqual(['默认', 'Gemini Neon', 'Orchestrator', '刷新模型列表']);
    expect(rows()[0]!.textContent).toContain('跟随后端默认：Gemini Neon');
    pick('Orchestrator');
    expect(p.onChange).toHaveBeenLastCalledWith(withCfg({ kind: 'agy', agy: { model: 'orch', effort: null } }));
    open('Antigravity 思考强度');
    expect(labels()).toEqual(['默认', '低', '高']);
    expect(p.onLoadDelegate).not.toHaveBeenCalled();
  });

  it('Antigravity：打开菜单时才拉列表；失败显示原因；可刷新且菜单不关；旧模型仍显示', () => {
    const p = mount({
      state: mkState({ config: withCfg({ kind: 'agy', agy: { model: 'old-model', effort: null } }) }),
      delegate: null,
      delegateError: '没有安装委派后端（agy）',
    });
    expect(p.onLoadDelegate).not.toHaveBeenCalled();
    open('Antigravity 模型');
    expect(p.onLoadDelegate).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('.cz-menu__text')!.textContent).toContain('没有安装');
    pick('刷新模型列表');
    expect(p.onLoadDelegate).toHaveBeenLastCalledWith(true);
    expect(rows().length).toBeGreaterThan(0);

    act(() => root?.unmount());
    host.remove();
    mount({ state: mkState({ config: withCfg({ kind: 'agy', agy: { model: 'old-model', effort: null } }) }) });
    open('Antigravity 模型');
    expect(labels()).toContain('old-model');
  });

  it('卡片账号行：原生显示「跟随主代理账号」，Claude / Antigravity 按传入的 accounts 显示，拿不到就不显示', () => {
    mount({ state: mkState({ config: withCfg({ kind: 'native' }) }) });
    expect(host.querySelector('.cz-sub__acct')?.textContent).toBe('账号：跟随主代理账号');

    act(() => root?.unmount());
    host.remove();
    mount({ state: mkState({ config: withCfg({ kind: 'claude' }) }), accounts: { claude: 'cosyeex', agy: 'alex@example.com' } });
    expect(host.querySelector('.cz-sub__acct')?.textContent).toBe('账号：cosyeex');

    act(() => root?.unmount());
    host.remove();
    mount({ state: mkState({ config: withCfg({ kind: 'agy' }) }), accounts: { claude: 'cosyeex', agy: 'alex@example.com' } });
    expect(host.querySelector('.cz-sub__acct')?.textContent).toBe('账号：alex@example.com');

    act(() => root?.unmount());
    host.remove();
    mount({ state: mkState({ config: withCfg({ kind: 'claude' }) }) });
    expect(host.querySelector('.cz-sub__acct')).toBeNull();
  });

  it('退回原生时，焦点在可用项「原生」上按左右方向键应切到「Claude」而非卡在「原生」', () => {
    const p = mount({
      state: {
        config: withCfg({ kind: 'agy' }),
        available: { native: { ok: true }, claude: { ok: true }, agy: { ok: false, reason: '未安装 Antigravity CLI' } },
        effective: 'native',
      },
    });
    const nativeBtn = radioBy('原生');
    expect(nativeBtn.tabIndex).toBe(0);
    expect(radioBy('Claude').tabIndex).toBe(-1);
    expect(radioBy('Antigravity').tabIndex).toBe(-1);

    act(() => nativeBtn.focus());
    const group = host.querySelector<HTMLElement>('[role="radiogroup"]')!;
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(p.onChange).toHaveBeenLastCalledWith(withCfg({ kind: 'claude' }));

    act(() => nativeBtn.focus());
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(p.onChange).toHaveBeenLastCalledWith(withCfg({ kind: 'claude' }));
  });

  it('后端可用但委派工具被手动停用导致退回原生时，提示「委派工具已停用」而非误报后端不可用', () => {
    mount({
      state: {
        config: withCfg({ kind: 'claude' }),
        available: allAvailable,
        effective: 'native',
      },
    });
    const banner = host.querySelector('.cz-sub__banner')!;
    expect(banner.textContent).toContain('已退回原生');
    expect(banner.textContent).toContain('委派工具已停用');
    expect(banner.textContent).not.toContain('Claude 不可用');
  });

  it('服务端给了 fallbackReason 时，退回横幅直接显示它', () => {
    mount({
      state: {
        config: withCfg({ kind: 'claude' }),
        available: allAvailable,
        effective: 'native',
        fallbackReason: 'Claude 子代理账号未登录',
      },
    });
    const banner = host.querySelector('.cz-sub__banner')!;
    expect(banner.textContent).toContain('已退回原生');
    expect(banner.textContent).toContain('Claude 子代理账号未登录');
    expect(banner.textContent).not.toContain('委派工具已停用');
  });

  it('不可用后端恢复可用后：按钮恢复启用、退回横幅消失、工具状态同步更新', () => {
    const p = mount({
      state: {
        config: withCfg({ kind: 'agy' }),
        available: { native: { ok: true }, claude: { ok: true }, agy: { ok: false, reason: '未安装 Antigravity CLI' } },
        effective: 'native',
      },
    });
    expect(radioBy('Antigravity').disabled).toBe(true);
    expect(host.querySelector('.cz-sub__banner')).not.toBeNull();

    const recovered: SubagentState = {
      config: withCfg({ kind: 'agy' }),
      available: allAvailable,
      effective: 'agy',
    };
    act(() => root!.render(
      <ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} subagents={{ ...p, state: recovered }} />,
    ));
    expect(radioBy('Antigravity').disabled).toBe(false);
    expect(host.querySelector('.cz-sub__banner')).toBeNull();
    expect(host.textContent).toContain('委派工具 开');
    expect(host.textContent).toContain('Agent 工具 关');
  });

  it('快速来回切换类型时只存在一份内容 stage，不重叠不卡在中间态', () => {
    const p = mount();
    for (const kind of ['claude', 'agy', 'native', 'claude'] as const) {
      act(() => root!.render(
        <ContextPanel
          usage={mockContextUsage}
          loading={false}
          onRefresh={() => undefined}
          onCompact={() => undefined}
          subagents={{ ...p, state: mkState({ config: withCfg({ kind }) }) }}
        />,
      ));
    }
    expect(host.querySelectorAll('.cz-sub__stage')).toHaveLength(1);
    expect(host.textContent).toContain('委派工具 开');
  });
});

describe('子代理 · 代理类型列表与单独配置', () => {
  const sampleTypes: SubagentTypeInfo[] = [
    { name: 'Explore', description: 'Fast search agent', source: 'builtin', readOnly: true, model: 'haiku' },
    { name: 'Plan', description: 'Architect agent', source: 'builtin', readOnly: true },
    { name: 'code-reviewer', description: '审查 PR 变更', source: 'projectSettings', model: 'opus', effort: 'high' },
    { name: 'sec-scan', description: '安全扫描插件', source: 'plugin' },
  ];

  const agentRow = (name: string) =>
    [...host.querySelectorAll<HTMLLIElement>('.cz-sub__agent')].find(
      (li) => li.querySelector('.cz-sub__agent-name')?.textContent === name,
    )!;

  it('渲染代理类型列表：原生合并会话报告的类型并排除 fork；非原生不合并；老服务端用会话列表和 usage.disabledAgents 兜底', () => {
    mount({
      state: mkState({ agents: sampleTypes, disabledAgents: ['sec-scan'] }),
      sessionAgents: ['Explore', 'statusline-setup', 'fork'],
    });
    const names = () => [...host.querySelectorAll('.cz-sub__agent-name')].map((el) => el.textContent);
    expect(names()).toEqual(['Explore', 'Plan', 'code-reviewer', 'sec-scan', 'statusline-setup']);
    // 标签：只读 / 项目 / 插件
    expect(agentRow('Explore').textContent).toContain('只读');
    expect(agentRow('code-reviewer').textContent).toContain('项目');
    expect(agentRow('sec-scan').textContent).toContain('插件');
    // 已关闭行变暗
    expect(agentRow('sec-scan').classList.contains('is-off')).toBe(true);
    expect(agentRow('Explore').classList.contains('is-off')).toBe(false);

    // 切到 Claude 委派后端：不再合并会话报告的 statusline-setup
    act(() => root!.render(
      <ContextPanel
        usage={mockContextUsage}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        subagents={{
          state: mkState({ config: withCfg({ kind: 'claude' }), agents: sampleTypes, disabledAgents: ['sec-scan'] }),
          onChange: vi.fn(),
          delegate,
          onLoadDelegate: vi.fn(),
          sessionAgents: ['Explore', 'statusline-setup', 'fork'],
        }}
      />,
    ));
    expect(names()).toEqual(['Explore', 'Plan', 'code-reviewer', 'sec-scan']);

    // 老服务端没给 state.agents / state.disabledAgents：用 sessionAgents（排除 fork）与 usage.disabledAgents 兜底
    act(() => root!.render(
      <ContextPanel
        usage={{ ...mockContextUsage, disabledAgents: ['Plan'] }}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        subagents={{
          state: mkState({}),
          onChange: vi.fn(),
          delegate,
          onLoadDelegate: vi.fn(),
          sessionAgents: ['Explore', 'Plan', 'fork'],
        }}
      />,
    ));
    expect(names()).toEqual(['Explore', 'Plan']);
    expect(agentRow('Plan').classList.contains('is-off')).toBe(true);
    expect(agentRow('Explore').classList.contains('is-off')).toBe(false);
  });

  it('点开关只切换开关不展开行；点行展开/收起，可同时展开多行', () => {
    const onToggleAgent = vi.fn();
    mount({
      state: mkState({ agents: sampleTypes, disabledAgents: ['sec-scan'] }),
      onToggleAgent,
    });
    const explore = agentRow('Explore');
    const plan = agentRow('Plan');
    const toggleBtn = (li: HTMLLIElement) => li.querySelector<HTMLButtonElement>('.cz-sub__agent-toggle')!;
    const sw = (li: HTMLLIElement) => li.querySelector<HTMLButtonElement>('[role="switch"]')!;

    expect(toggleBtn(explore).getAttribute('aria-expanded')).toBe('false');
    // 点开关：触发回调但不展开
    act(() => sw(explore).click());
    expect(onToggleAgent).toHaveBeenCalledWith('Explore', false);
    expect(toggleBtn(explore).getAttribute('aria-expanded')).toBe('false');
    expect(explore.querySelector('.cz-sub__agent-body')).toBeNull();

    // 点行其余部分：展开 Explore 和 Plan（可同时展开多行）
    act(() => toggleBtn(explore).click());
    act(() => toggleBtn(plan).click());
    expect(toggleBtn(explore).getAttribute('aria-expanded')).toBe('true');
    expect(toggleBtn(plan).getAttribute('aria-expanded')).toBe('true');
    expect(explore.querySelector('.cz-sub__agent-body')).not.toBeNull();
    expect(plan.querySelector('.cz-sub__agent-body')).not.toBeNull();
  });

  it('收起状态显示单独配置摘要；展开后第一项为「跟随默认」并注明默认值与定义里写的值', () => {
    mount({
      state: mkState({
        config: withCfg({
          native: {
            model: 'sonnet',
            effort: 'medium',
            agents: { Explore: { model: 'haiku', effort: 'low' } },
          },
        }),
        agents: sampleTypes,
        disabledAgents: [],
      }),
    });
    const explore = agentRow('Explore');
    expect(explore.querySelector('.cz-sub__agent-ov')?.textContent).toBe('Haiku 5.5 · 低');

    // 展开 Explore：摘要隐藏，显示定义提示，下拉第一项注明默认值和定义里写的值
    act(() => explore.querySelector<HTMLButtonElement>('.cz-sub__agent-toggle')!.click());
    expect(explore.querySelector('.cz-sub__agent-ov')).toBeNull();
    expect(explore.querySelector('.cz-sub__agent-def')?.textContent).toContain('模型 haiku');

    open('Explore 模型');
    expect(labels()[0]).toBe('跟随默认');
    expect(rows()[0]!.textContent).toContain('跟随默认：Sonnet 5.5');
    expect(rows()[0]!.textContent).toContain('定义里写的是 haiku');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

    // 展开 code-reviewer：定义里写了 model 和 effort
    const reviewer = agentRow('code-reviewer');
    act(() => reviewer.querySelector<HTMLButtonElement>('.cz-sub__agent-toggle')!.click());
    open('code-reviewer 思考强度');
    expect(rows()[0]!.textContent).toContain('跟随默认：中');
    expect(rows()[0]!.textContent).toContain('定义里写的是 高');
  });

  it('改模型/强度提交正确的 config；两项都回到「跟随默认」时删掉该项；切换后端显示该后端自己的单独配置', () => {
    const p = mount({
      state: mkState({
        config: withCfg({
          native: {
            model: 'sonnet',
            effort: 'medium',
            agents: { Explore: { model: 'haiku', effort: 'low' } },
          },
          agy: {
            model: 'neon',
            effort: 'high',
            agents: { Explore: { model: 'neon', effort: 'high' } },
          },
        }),
        agents: sampleTypes,
        disabledAgents: [],
      }),
    });
    // 展开 Explore，先把模型改回「跟随默认」：保留 effort: 'low'
    act(() => agentRow('Explore').querySelector<HTMLButtonElement>('.cz-sub__agent-toggle')!.click());
    open('Explore 模型');
    pick('跟随默认');
    expect(p.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        native: { model: 'sonnet', effort: 'medium', agents: { Explore: { model: null, effort: 'low' } } },
      }),
    );

    // 模拟已更新为 model: null, effort: 'low'，再把思考强度改回「跟随默认」：应删除 Explore 项及空的 agents 字段
    const midCfg = withCfg({
      native: { model: 'sonnet', effort: 'medium', agents: { Explore: { model: null, effort: 'low' } } },
      agy: { model: 'neon', effort: 'high', agents: { Explore: { model: 'neon', effort: 'high' } } },
    });
    act(() => root!.render(
      <ContextPanel
        usage={mockContextUsage}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        subagents={{ ...p, state: mkState({ config: midCfg, agents: sampleTypes, disabledAgents: [] }) }}
      />,
    ));
    open('Explore 思考强度');
    pick('跟随默认');
    const lastCall = (p.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as SubagentConfig;
    expect(lastCall.native).toEqual({ model: 'sonnet', effort: 'medium' });
    expect('agents' in lastCall.native).toBe(false);

    // 切换到 Antigravity 后端：应显示 agy 自己的单独配置，换到不分强度的 Orchestrator 时强度回到 null
    act(() => root!.render(
      <ContextPanel
        usage={mockContextUsage}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        subagents={{
          ...p,
          state: mkState({ config: { ...midCfg, kind: 'agy' }, agents: sampleTypes, disabledAgents: [] }),
        }}
      />,
    ));
    expect(host.querySelector('[aria-label="Explore 模型：Gemini Neon"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Explore 思考强度：高"]')).not.toBeNull();
    open('Explore 模型');
    pick('Orchestrator');
    const agyCall = (p.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as SubagentConfig;
    expect(agyCall.agy.agents).toEqual({ Explore: { model: 'orch', effort: null } });
  });
});
