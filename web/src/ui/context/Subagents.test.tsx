// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  DEFAULT_SUBAGENTS,
  type DelegateModelList,
  type SubagentAccountOption,
  type SubagentConfig,
  type SubagentState,
  type SubagentTypeInfo,
} from '@cosyee/shared';
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

const agyList: DelegateModelList = {
  models: [
    { value: 'neon', displayName: 'Gemini Neon', efforts: ['low', 'high'] },
    { value: 'orch', displayName: 'Orchestrator', efforts: [] },
  ],
  current: { model: 'neon', effort: 'high' },
  at: 0,
};

const sampleAccounts: SubagentAccountOption[] = [
  { backend: 'claude', id: 'default', label: 'cosyeey', group: 'claude' },
  { backend: 'claude', id: 'api-1', label: '官方 API', group: 'api' },
  { backend: 'claude', id: 'kiro-1', label: 'Kiro 代理', group: 'kiro' },
  { backend: 'agy', id: 'agy-1', label: 'alex@example.com', group: 'agy' },
];

const sampleTypes: SubagentTypeInfo[] = [
  { name: 'Explore', description: 'Fast search agent', source: 'builtin', readOnly: true, model: 'haiku' },
  { name: 'Plan', description: 'Architect agent', source: 'builtin', readOnly: true },
  { name: 'code-reviewer', description: '审查 PR 变更', source: 'projectSettings', model: 'opus', effort: 'high' },
  { name: 'sec-scan', description: '安全扫描插件', source: 'plugin' },
];

const withCfg = (patch: Partial<SubagentConfig>): SubagentConfig => ({ ...DEFAULT_SUBAGENTS, ...patch });

const mkState = (over: Partial<SubagentState> = {}): SubagentState => {
  const config = over.config ?? DEFAULT_SUBAGENTS;
  return {
    config,
    effective: over.effective ?? config.mode,
    accounts: over.accounts ?? sampleAccounts,
    routeFallbacks: over.routeFallbacks ?? {},
    ...over,
  };
};

type Props = ComponentProps<typeof Subagents>;
const fold = () => host.querySelector<HTMLElement>('.cz-ctx__agents .cz-ctx__fold')!;
function mount(p: Partial<Props> = {}, expand = true) {
  const props: Props = {
    state: mkState(),
    onChange: vi.fn(),
    delegateModels: { 'agy:agy-1': { list: agyList, error: null, loading: false } },
    onLoadDelegateModels: vi.fn(),
    onLoadClaudeModels: vi.fn(),
    ...p,
  };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(
    <ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} subagents={props} />,
  ));
  if (expand) act(() => fold().click());
  return props;
}

const radios = () => [...host.querySelectorAll<HTMLButtonElement>('[role="radiogroup"] [role="radio"]')];
const radioBy = (name: string) => radios().find((b) => b.textContent?.includes(name))!;
const open = (name: string) => act(() => host.querySelector<HTMLElement>(`[aria-label^="${name}："]`)!.click());
const rows = () => [...document.querySelectorAll<HTMLElement>('.cz-menu__row')];
const menuTexts = () => [...document.querySelectorAll<HTMLElement>('.cz-menu__text')].map((el) => el.textContent);
const labels = () => rows().map((r) => r.querySelector('.cz-menu__label')!.textContent);
const pick = (label: string) => act(() => rows().find((r) => r.querySelector('.cz-menu__label')!.textContent === label)!.click());
const agentRow = (name: string) =>
  [...host.querySelectorAll<HTMLLIElement>('.cz-sub__agent')].find(
    (li) => li.querySelector('.cz-sub__agent-name')?.textContent === name,
  )!;

describe('子代理 · 原生与委派切换', () => {
  it('在面板主体最后一节（MCP 下方），默认折叠，展开为「原生 / 委派」两项切换', () => {
    mount({}, false);
    const last = host.querySelector('.cz-ctx__body')!.lastElementChild!;
    expect(last.textContent).toContain('子代理');
    expect(last.previousElementSibling!.textContent).toContain('MCP');
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(fold().textContent).toBe('子代理原生 · Sonnet 5.5');
    expect(host.querySelector('[role="radiogroup"]')).toBeNull();

    act(() => fold().click());
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    expect(radios().map((r) => r.textContent)).toEqual(['原生', '委派']);
    expect(host.querySelector('.cz-sub__acct')?.textContent).toBe('账号：跟随主会话账号');
    expect(host.textContent).toContain('Agent 工具 开');
    expect(host.textContent).toContain('委派工具 关');
  });

  it('切到委派且 default 为 null 时，自动选 state.accounts 第一个可用账号作为默认路线；键盘方向键也可切换', () => {
    const p = mount();
    act(() => radioBy('委派').click());
    expect(p.onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBAGENTS,
      mode: 'delegate',
      delegate: {
        default: { backend: 'claude', accountId: 'default', model: null, effort: null },
      },
    });

    // 键盘方向键切换
    const group = host.querySelector<HTMLElement>('[role="radiogroup"]')!;
    act(() => {
      group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(p.onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBAGENTS,
      mode: 'delegate',
      delegate: {
        default: { backend: 'claude', accountId: 'default', model: null, effort: null },
      },
    });
  });

  it('没有可用委派账号时，切到委派仍提交 mode: delegate 且保持原生生效并给出提示', () => {
    const p = mount({
      state: mkState({
        accounts: [],
      }),
    });
    act(() => radioBy('委派').click());
    expect(p.onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_SUBAGENTS,
      mode: 'delegate',
    });

    // 渲染回落态：effective === 'native'，展示提示且工具状态按原生显示
    act(() => root!.render(
      <ContextPanel
        usage={mockContextUsage}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        subagents={{
          ...p,
          state: mkState({
            config: withCfg({ mode: 'delegate' }),
            effective: 'native',
            accounts: [],
            fallbackReason: '还没有选择委派账号',
          }),
        }}
      />,
    ));
    const banner = host.querySelector('.cz-sub__banner')!;
    expect(banner.textContent).toContain('已退回原生');
    expect(banner.textContent).toContain('还没有选择委派账号');
    expect(host.textContent).toContain('当前没有可用的委派账号');
    expect(host.textContent).toContain('Agent 工具 开');
    expect(host.textContent).toContain('委派工具 关');
  });

  it('委派整体回落原生时显示 fallbackReason；切回原生保存 mode: native', () => {
    const p = mount({
      state: mkState({
        config: withCfg({
          mode: 'delegate',
          delegate: { default: { backend: 'agy', accountId: 'agy-1', model: 'neon', effort: 'high' } },
        }),
        effective: 'native',
        fallbackReason: '委派工具已在工具面板停用',
      }),
    }, false);
    expect(fold().textContent).toBe('子代理已退回原生 · Sonnet 5.5');
    act(() => fold().click());
    expect(host.querySelector('.cz-sub__banner')?.textContent).toContain('委派工具已在工具面板停用');
    expect(host.textContent).toContain('Agent 工具 开');
    expect(host.textContent).toContain('委派工具 关');

    act(() => radioBy('原生').click());
    expect(p.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'native' }));
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
});

describe('子代理 · 委派默认路线与账号分组', () => {
  const delegateCfg = (over?: Partial<SubagentConfig['delegate']>): SubagentConfig => ({
    ...DEFAULT_SUBAGENTS,
    mode: 'delegate',
    delegate: {
      default: { backend: 'claude', accountId: 'default', model: 'opus', effort: 'high' },
      ...over,
    },
  });

  it('账号菜单按 group 分组并只列出 state.accounts；换到不同后端账号时 model / effort 置为 null', () => {
    const p = mount({
      state: mkState({
        config: delegateCfg(),
        accounts: [
          { backend: 'claude', id: 'default', label: 'cosyeey', group: 'claude' },
          { backend: 'claude', id: 'api-1', label: '官方 API', group: 'api' },
          { backend: 'agy', id: 'agy-1', label: 'alex@example.com', group: 'agy' },
        ],
      }),
    });
    expect(host.textContent).toContain('委派工具 开');
    expect(host.textContent).toContain('Agent 工具 关');

    open('默认委派账号');
    // 只出现有账号的分组（没有 Kiro），且只列 state.accounts
    expect(menuTexts()).toEqual(['Claude 订阅', 'API', 'Antigravity']);
    expect(labels()).toEqual(['cosyeey', '官方 API', 'alex@example.com']);

    // 换到 Antigravity 账号：后端不同，model / effort 置 null
    pick('alex@example.com');
    expect(p.onChange).toHaveBeenLastCalledWith(
      delegateCfg({
        default: { backend: 'agy', accountId: 'agy-1', model: null, effort: null },
      }),
    );
  });

  it('Claude 委派默认行：选模型与强度（含「跟随主会话」），打开菜单按需拉取该账号模型', () => {
    const p = mount({
      state: mkState({
        config: delegateCfg({ default: { backend: 'claude', accountId: 'api-1', model: null, effort: null } }),
      }),
    });
    open('默认委派模型');
    expect(p.onLoadClaudeModels).toHaveBeenCalledWith('api-1', false);
    expect(labels()).toContain('跟随主会话');
    expect(labels()).toContain('Opus 5.5');
    pick('Opus 5.5');
    expect(p.onChange).toHaveBeenLastCalledWith(
      delegateCfg({ default: { backend: 'claude', accountId: 'api-1', model: 'opus', effort: null } }),
    );

    open('默认委派思考强度');
    expect(labels()[0]).toBe('跟随主会话');
    pick('高');
    expect(p.onChange).toHaveBeenLastCalledWith(
      delegateCfg({ default: { backend: 'claude', accountId: 'api-1', model: null, effort: 'high' } }),
    );
  });

  it('Antigravity 委派默认行：选模型；模型无 efforts 时隐藏思考强度菜单；打开未缓存菜单时按需拉取并可刷新', () => {
    const p = mount({
      state: mkState({
        config: delegateCfg({ default: { backend: 'agy', accountId: 'agy-1', model: 'neon', effort: 'high' } }),
      }),
    });
    expect(host.querySelector('[aria-label^="默认委派思考强度："]')).not.toBeNull();
    open('默认委派模型');
    expect(labels()).toEqual(['默认', 'Gemini Neon', 'Orchestrator', '刷新模型列表']);
    expect(rows()[0]!.textContent).toContain('跟随后端默认：Gemini Neon');
    pick('Orchestrator');
    expect(p.onChange).toHaveBeenLastCalledWith(
      delegateCfg({ default: { backend: 'agy', accountId: 'agy-1', model: 'orch', effort: null } }),
    );

    // 切到无 efforts 的 Orchestrator 后，强度下拉隐藏
    act(() => root!.render(
      <ContextPanel
        usage={mockContextUsage}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        subagents={{
          ...p,
          state: mkState({
            config: delegateCfg({ default: { backend: 'agy', accountId: 'agy-1', model: 'orch', effort: null } }),
          }),
        }}
      />,
    ));
    expect(host.querySelector('[aria-label^="默认委派思考强度："]')).toBeNull();

    // 未缓存时打开菜单才拉取，失败显示原因，点击刷新不关菜单
    act(() => root!.unmount());
    host.remove();
    const p2 = mount({
      state: mkState({
        config: delegateCfg({ default: { backend: 'agy', accountId: 'agy-1', model: 'old-model', effort: null } }),
      }),
      delegateModels: { 'agy:agy-1': { list: null, error: '未安装 agy', loading: false } },
    });
    expect(p2.onLoadDelegateModels).not.toHaveBeenCalled();
    open('默认委派模型');
    expect(p2.onLoadDelegateModels).toHaveBeenLastCalledWith('agy', 'agy-1', false);
    expect(menuTexts().join(' ')).toContain('未安装 agy');
    pick('刷新模型列表');
    expect(p2.onLoadDelegateModels).toHaveBeenLastCalledWith('agy', 'agy-1', true);
    expect(rows().length).toBeGreaterThan(0);
  });
});

describe('子代理 · 代理类型列表与单独路线', () => {
  it('原生模式合并会话类型并排除 fork；委派模式不合并会话额外类型；支持启用/停用开关', () => {
    const onToggleAgent = vi.fn();
    const p = mount({
      state: mkState({ agents: sampleTypes, disabledAgents: ['sec-scan'] }),
      sessionAgents: ['Explore', 'statusline-setup', 'fork'],
      onToggleAgent,
    });
    const names = () => [...host.querySelectorAll('.cz-sub__agent-name')].map((el) => el.textContent);
    expect(names()).toEqual(['Explore', 'Plan', 'code-reviewer', 'sec-scan', 'statusline-setup']);
    expect(agentRow('Explore').textContent).toContain('只读');
    expect(agentRow('code-reviewer').textContent).toContain('项目');
    expect(agentRow('sec-scan').classList.contains('is-off')).toBe(true);

    // 点开关只切开关不展开
    const sw = agentRow('Explore').querySelector<HTMLButtonElement>('[role="switch"]')!;
    act(() => sw.click());
    expect(onToggleAgent).toHaveBeenCalledWith('Explore', false);
    expect(agentRow('Explore').querySelector('.cz-sub__agent-body')).toBeNull();

    // 切到委派模式：只列 state.agents，不合并 statusline-setup
    act(() => root!.render(
      <ContextPanel
        usage={mockContextUsage}
        loading={false}
        onRefresh={() => undefined}
        onCompact={() => undefined}
        subagents={{
          ...p,
          state: mkState({
            config: withCfg({
              mode: 'delegate',
              delegate: { default: { backend: 'claude', accountId: 'default', model: null, effort: null } },
            }),
            agents: sampleTypes,
            disabledAgents: ['sec-scan'],
          }),
        }}
      />,
    ));
    expect(names()).toEqual(['Explore', 'Plan', 'code-reviewer', 'sec-scan']);
  });

  it('委派类型行：选择独立账号与模型；选「跟随默认」删掉该类型覆盖；显示 routeFallbacks 回落标注', () => {
    const cfg: SubagentConfig = {
      ...DEFAULT_SUBAGENTS,
      mode: 'delegate',
      delegate: {
        default: { backend: 'claude', accountId: 'default', model: null, effort: null },
        agents: {
          Explore: { backend: 'agy', accountId: 'agy-1', model: 'neon', effort: 'low' },
          Plan: { backend: 'agy', accountId: 'missing-acc', model: null, effort: null },
        },
      },
    };
    const p = mount({
      state: mkState({
        config: cfg,
        agents: sampleTypes,
        disabledAgents: [],
        routeFallbacks: { Plan: 'Antigravity 账号未登录' },
      }),
    });

    // Plan 显示回落提示
    expect(agentRow('Plan').textContent).toContain('已用默认路线：Antigravity 账号未登录');
    // Explore 收起时显示独立路线摘要
    expect(agentRow('Explore').querySelector('.cz-sub__agent-ov')?.textContent).toContain('alex@example.com · Gemini Neon · 低');

    // 展开 Explore，在账号菜单里选「跟随默认」→ 删掉 delegate.agents.Explore
    act(() => agentRow('Explore').querySelector<HTMLButtonElement>('.cz-sub__agent-toggle')!.click());
    open('Explore 账号');
    expect(labels()[0]).toBe('跟随默认');
    pick('跟随默认');
    const afterFollow = (p.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as SubagentConfig;
    expect(afterFollow.delegate.agents).toEqual({ Plan: { backend: 'agy', accountId: 'missing-acc', model: null, effort: null } });

    // 展开 code-reviewer（当前跟随默认），选一个账号 → 新增独立路线
    act(() => agentRow('code-reviewer').querySelector<HTMLButtonElement>('.cz-sub__agent-toggle')!.click());
    expect(host.querySelector('[aria-label="code-reviewer 账号：跟随默认"]')).not.toBeNull();
    open('code-reviewer 账号');
    pick('官方 API');
    const afterAssign = (p.onChange as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as SubagentConfig;
    expect(afterAssign.delegate.agents?.['code-reviewer']).toEqual({
      backend: 'claude',
      accountId: 'api-1',
      model: null,
      effort: null,
    });
  });

  it('原生类型行：单独覆盖模型/强度，两项都回到「跟随默认」时删掉覆盖及空 agents 字段', () => {
    const p = mount({
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
    expect(agentRow('Explore').querySelector('.cz-sub__agent-ov')?.textContent).toBe('Haiku 5.5 · 低');
    act(() => agentRow('Explore').querySelector<HTMLButtonElement>('.cz-sub__agent-toggle')!.click());
    open('Explore 模型');
    pick('跟随默认');
    expect(p.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        native: { model: 'sonnet', effort: 'medium', agents: { Explore: { model: null, effort: 'low' } } },
      }),
    );

    const midCfg = withCfg({
      native: { model: 'sonnet', effort: 'medium', agents: { Explore: { model: null, effort: 'low' } } },
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
  });

  it('委派路线支持 Codex 后端：使用 codex 品牌图标、按 backend=codex 拉取模型并支持 DelegateEffort', () => {
    const codexList: DelegateModelList = {
      models: [
        { value: 'gpt-5.3-codex', displayName: 'GPT-5.3 Codex', efforts: ['none', 'minimal', 'low', 'medium', 'high', 'ultra'] },
      ],
      current: { model: 'gpt-5.3-codex', effort: 'medium' },
      at: 0,
    };
    const accounts: SubagentAccountOption[] = [
      ...sampleAccounts,
      { backend: 'codex', id: 'default', label: 'dev@openai.com', group: 'codex' },
    ];
    const p = mount({
      state: mkState({
        accounts,
        config: withCfg({
          mode: 'delegate',
          delegate: { default: { backend: 'codex', accountId: 'default', model: 'gpt-5.3-codex', effort: 'medium' } },
        }),
      }),
      delegateModels: { 'codex:default': { list: codexList, error: null, loading: false } },
    });

    expect(host.querySelector('[data-brand="codex"]')).toBeTruthy();
    open('默认委派思考强度');
    expect(labels()).toEqual(['默认', '关闭', '极低', '低', '中等', '高', '极高']);
    pick('极低');
    expect(p.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        delegate: { default: { backend: 'codex', accountId: 'default', model: 'gpt-5.3-codex', effort: 'minimal' } },
      }),
    );

    open('默认委派模型');
    pick('刷新模型列表');
    expect(p.onLoadDelegateModels).toHaveBeenCalledWith('codex', 'default', true);
  });
});
