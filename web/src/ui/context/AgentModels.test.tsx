// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DEFAULT_AGENT_MODELS, type AgentModelConfig, type DelegateModelList } from '@cosyee/shared';
import { mockContextUsage } from '../../mock/shell';
import { ContextPanel } from './ContextPanel';
import type { AgentModels } from './AgentModels';

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
type Props = ComponentProps<typeof AgentModels>;
const fold = () => host.querySelector<HTMLElement>('.cz-ctx__agents .cz-ctx__fold')!;
function mount(p: Partial<Props> = {}, expand = true) {
  const props: Props = { config: DEFAULT_AGENT_MODELS, onChange: vi.fn(), delegate, onLoadDelegate: vi.fn(), ...p };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<ContextPanel usage={mockContextUsage} loading={false} onRefresh={() => undefined} onCompact={() => undefined} agentModels={props} />));
  if (expand) act(() => fold().click());
  return props;
}
const open = (name: string) => act(() => host.querySelector<HTMLElement>(`[aria-label^="${name}："]`)!.click());
const rows = () => [...document.querySelectorAll<HTMLElement>('.cz-menu__row')];
const labels = () => rows().map((r) => r.querySelector('.cz-menu__label')!.textContent);
const pick = (label: string) => act(() => rows().find((r) => r.querySelector('.cz-menu__label')!.textContent === label)!.click());
const withAgy = (agy: AgentModelConfig['agy']): AgentModelConfig => ({ ...DEFAULT_AGENT_MODELS, agy });

describe('子代理模型', () => {
  it('在面板主体最后一节（智能体下方）', () => {
    mount();
    const last = host.querySelector('.cz-ctx__body')!.lastElementChild!;
    expect(last.textContent).toContain('子代理模型');
    expect(last.previousElementSibling!.textContent).toContain('智能体');
  });

  it('默认折叠，标题右侧显示当前模型；点开才有下拉，再点收起', () => {
    mount({ config: withAgy({ model: 'neon', effort: null }) }, false);
    expect(fold().getAttribute('aria-expanded')).toBe('false');
    expect(fold().textContent).toBe('子代理模型Sonnet 5.5 · Gemini Neon');
    expect(host.querySelector('.cz-ctx__pick')).toBeNull();
    act(() => fold().click());
    expect(fold().getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('.cz-ctx__pick')).toHaveLength(4);
    act(() => fold().click());
    expect(host.querySelector('.cz-ctx__pick')).toBeNull();
  });

  it('Claude：选别名与强度', () => {
    const p = mount();
    open('Claude 子代理模型');
    expect(labels()).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Fable 5.2', 'Haiku 5.5']);
    pick('Opus 5.5');
    expect(p.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_AGENT_MODELS, claude: { model: 'opus', effort: 'medium' } });
    open('Claude 子代理思考强度');
    pick('最高');
    expect(p.onChange).toHaveBeenLastCalledWith({ ...DEFAULT_AGENT_MODELS, claude: { model: 'sonnet', effort: 'max' } });
  });

  it('委派：默认跟随后端默认；换到不分强度的模型时强度回到默认', () => {
    const p = mount({ config: withAgy({ model: 'neon', effort: 'high' }) });
    open('委派模型');
    expect(labels()).toEqual(['默认', 'Gemini Neon', 'Orchestrator', '刷新模型列表']);
    expect(rows()[0]!.textContent).toContain('跟随后端默认：Gemini Neon');
    pick('Orchestrator');
    expect(p.onChange).toHaveBeenLastCalledWith(withAgy({ model: 'orch', effort: null }));
    open('委派思考强度');
    expect(labels()).toEqual(['默认', '低', '高']);
    expect(p.onLoadDelegate).not.toHaveBeenCalled();
  });

  it('打开菜单时才拉列表；失败显示原因；可刷新且菜单不关', () => {
    const p = mount({ delegate: null, delegateError: '没有安装委派后端（agy）' });
    expect(p.onLoadDelegate).not.toHaveBeenCalled();
    open('委派模型');
    expect(p.onLoadDelegate).toHaveBeenLastCalledWith(false);
    expect(document.querySelector('.cz-menu__text')!.textContent).toContain('没有安装');
    pick('刷新模型列表');
    expect(p.onLoadDelegate).toHaveBeenLastCalledWith(true);
    expect(rows().length).toBeGreaterThan(0);
  });

  it('存着的模型不在列表里：仍显示', () => {
    mount({ config: withAgy({ model: 'old-model', effort: null }) });
    open('委派模型');
    expect(labels()).toContain('old-model');
  });

  it('原生子代理开关：未传时隐藏，传入后显示状态并回调取反值', () => {
    mount();
    expect(host.querySelector('[role="switch"][aria-label="原生子代理"]')).toBeNull();
    act(() => root?.unmount());
    host.remove();

    const onNativeAgents = vi.fn();
    mount({ nativeAgents: true, onNativeAgents });
    const swOn = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="原生子代理"]')!;
    expect(swOn.getAttribute('aria-checked')).toBe('true');
    act(() => swOn.click());
    expect(onNativeAgents).toHaveBeenLastCalledWith(false);
    act(() => root?.unmount());
    host.remove();

    mount({ nativeAgents: false, onNativeAgents });
    const swOff = host.querySelector<HTMLButtonElement>('[role="switch"][aria-label="原生子代理"]')!;
    expect(swOff.getAttribute('aria-checked')).toBe('false');
    act(() => swOff.click());
    expect(onNativeAgents).toHaveBeenLastCalledWith(true);
  });
});
