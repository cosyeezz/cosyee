// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_SUBAGENTS, type DelegateModelList, type SubagentConfig, type SubagentState } from '@cosyee/shared';
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
  it('在面板主体最后一节（智能体下方）', () => {
    mount();
    const last = host.querySelector('.cz-ctx__body')!.lastElementChild!;
    expect(last.textContent).toContain('子代理');
    expect(last.previousElementSibling!.textContent).toContain('智能体');
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
});
