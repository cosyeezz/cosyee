// @vitest-environment jsdom
// 模型映射表：拉取列表、从下拉里挑、一键设置、自定义条目；以及映射如何影响模型菜单。
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ApiModelMap } from '@cosyee/shared';
import { hasModelMapping, mappedExtraModels, mappedPrimaryModels, modelLabelFor } from '@cosyee/shared';
import { buildModelMenu, modelSummary } from '../menus/modelMenuItems';
import type { MenuItem } from '../menus/Menu';
import { ModelMapTable } from './ModelMapTable';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(el: React.ReactElement) {
  act(() => root?.unmount());
  host?.remove();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
}
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const type = (el: HTMLInputElement, v: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  document.body.innerHTML = '';
});

const OPTIONS = ['grok-4.7', 'minimax-m2.5', 'qwen3-coder-next', 'gpt-5.6-sol'];

describe('ModelMapTable', () => {
  const table = (value: ApiModelMap, onChange: (m: ApiModelMap) => void, options = OPTIONS, fetching = false, onFetch = () => {}) =>
    mount(<ModelMapTable value={value} onChange={onChange} options={options} onFetch={onFetch} fetching={fetching} hint={null} />);
  const row = (label: string) => document.querySelector<HTMLElement>(`[role="group"][aria-label="${label}"]`)!;
  const field = (label: string) => document.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;

  it('手输模型名写进别名；清空则把该别名整条删掉', () => {
    let last: ApiModelMap = {};
    table({}, (v) => (last = v), []);
    type(field('Sonnet 5.5 实际请求模型'), 'minimax-m2.5');
    expect(last).toEqual({ alias: { sonnet: { id: 'minimax-m2.5' } } });

    table(last, (v) => (last = v), []);
    type(field('Sonnet 5.5 实际请求模型'), '');
    expect(hasModelMapping(last)).toBe(false);
  });

  it('没拉到列表时下拉按钮禁用，提示先去拉取', () => {
    table({}, () => {}, []);
    const caret = row('Sonnet 5.5').querySelector<HTMLButtonElement>('.cz-mmap__caret')!;
    expect(caret.disabled).toBe(true);
    expect(caret.title).toContain('获取模型列表');
  });

  it('拉到列表后可从下拉里搜索并选中', () => {
    let last: ApiModelMap = {};
    table({}, (v) => (last = v));
    click(row('Opus 5.5').querySelector('.cz-mmap__caret')!);
    expect(row('Opus 5.5').querySelectorAll('[role="option"]').length).toBe(4);
    type(field('搜索模型'), 'qwen');
    const hits = [...row('Opus 5.5').querySelectorAll('[role="option"]')];
    expect(hits.map((h) => h.textContent)).toEqual(['qwen3-coder-next']);
    click(hits[0]!);
    expect(last.alias?.opus).toEqual({ id: 'qwen3-coder-next' });
  });

  it('「获取模型列表」点一下就回调；fetching 时禁用', () => {
    let n = 0;
    table({}, () => {}, [], false, () => n++);
    click([...document.querySelectorAll('button')].find((b) => b.textContent === '获取模型列表')!);
    expect(n).toBe(1);

    table({}, () => {}, [], true, () => n++);
    const busy = [...document.querySelectorAll('button')].find((b) => b.textContent?.includes('获取'))!;
    expect((busy as HTMLButtonElement).disabled).toBe(true);
  });

  it('一键设置：4 个别名都填上，haiku 挑到小模型；没拉到列表时按钮禁用', () => {
    table({}, () => {}, []);
    expect([...document.querySelectorAll('button')].find((b) => b.textContent === '一键设置')!.disabled).toBe(true);

    let last: ApiModelMap = {};
    table({}, (v) => (last = v));
    click([...document.querySelectorAll('button')].find((b) => b.textContent === '一键设置')!);
    expect(Object.keys(last.alias ?? {}).sort()).toEqual(['fable', 'haiku', 'opus', 'sonnet']);
    expect(last.alias?.haiku?.id).toBe('minimax-m2.5'); // mini/flash/lite/small/air 一类
    for (const t of Object.values(last.alias ?? {})) expect(OPTIONS).toContain(t.id);
  });

  it('自定义模型：加一条、再移除', () => {
    let last: ApiModelMap = {};
    table({}, (x) => (last = x));
    type(field('要添加的模型'), 'gpt-5.6-sol');
    click([...document.querySelectorAll('button')].find((b) => b.textContent === '添加')!);
    expect(last.extra).toEqual([{ id: 'gpt-5.6-sol' }]);

    table(last, (x) => (last = x));
    click(document.querySelector('[aria-label="移除 gpt-5.6-sol"]')!);
    expect(hasModelMapping(last)).toBe(false);
  });

  it('「添加一个模型…」里按回车直接添加', () => {
    let last: ApiModelMap = {};
    table({}, (x) => (last = x), []);
    const input = field('要添加的模型');
    type(input, 'grok-4.7');
    act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(last.extra).toEqual([{ id: 'grok-4.7' }]);
  });

  it('下拉：搜索框里 ↓ 进入候选，Esc 收起并把焦点还给下拉按钮', () => {
    table({}, () => {});
    const caret = row('Opus 5.5').querySelector<HTMLButtonElement>('.cz-mmap__caret')!;
    click(caret);
    const search = document.querySelector<HTMLInputElement>('[aria-label="搜索模型"]')!;
    act(() => { search.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); });
    expect(document.activeElement?.textContent).toBe(OPTIONS[0]);
    act(() => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('[aria-label="搜索模型"]')).toBeNull();
    expect(document.activeElement).toBe(caret);
  });

  it('先填显示名称、后填模型：名称不丢；两者都清空才删掉条目', () => {
    let last: ApiModelMap = {};
    table({}, (x) => (last = x));
    type(field('Sonnet 5.5 显示名称'), 'MiniMax');
    table(last, (x) => (last = x));
    expect(field('Sonnet 5.5 显示名称').value).toBe('MiniMax');
    type(field('Sonnet 5.5 实际请求模型'), 'minimax-m2.5');
    expect(last.alias?.sonnet).toEqual({ id: 'minimax-m2.5', label: 'MiniMax' });
  });

  it('编辑自定义模型的 id 不会重挂输入框', () => {
    let last: ApiModelMap = { extra: [{ id: 'a' }] };
    const render = () => root!.render(<ModelMapTable value={last} onChange={(x) => (last = x)} options={[]} onFetch={() => {}} fetching={false} hint={null} />);
    table(last, (x) => (last = x), []);
    const input = field('a 实际请求模型');
    type(input, 'ab');
    act(render);
    expect(field('ab 实际请求模型')).toBe(input);
  });

  it('显示名称与 1M 勾选写进同一条目；没填模型时 1M 不可勾', () => {
    table({}, () => {});
    expect(field('Sonnet 5.5 支持 1M 上下文').disabled).toBe(true);

    let last: ApiModelMap = { alias: { sonnet: { id: 'minimax-m2.5' } } };
    table(last, (x) => (last = x));
    type(field('Sonnet 5.5 显示名称'), 'MiniMax');
    expect(last.alias?.sonnet).toEqual({ id: 'minimax-m2.5', label: 'MiniMax' });
    table(last, (x) => (last = x));
    click(field('Sonnet 5.5 支持 1M 上下文'));
    expect(last.alias?.sonnet).toEqual({ id: 'minimax-m2.5', label: 'MiniMax', m1: true });
  });
});

describe('映射对模型菜单的影响', () => {
  const map: ApiModelMap = {
    alias: {
      sonnet: { id: 'minimax-m2.5', label: 'MiniMax M2.5', m1: true },
      haiku: { id: 'grok-4.7' },
    },
    extra: [{ id: 'gpt-5.6-sol', label: 'Sol' }, { id: 'qwen3-coder-next' }],
  };
  const cfg = { model: 'sonnet', effort: 'medium' } as never;

  it('hasModelMapping：只有 subagent / fallback 不算配了映射', () => {
    expect(hasModelMapping(null)).toBe(false);
    expect(hasModelMapping({})).toBe(false);
    expect(hasModelMapping({ subagent: 'x', fallback: 'y' })).toBe(false);
    expect(hasModelMapping(map)).toBe(true);
  });

  it('常用项只剩配了映射的别名，标签与 1M 备注跟着映射走', () => {
    const primary = mappedPrimaryModels(map);
    expect(primary.map((m) => m.id)).toEqual(['sonnet', 'haiku']);
    expect(primary[0]).toMatchObject({ label: 'MiniMax M2.5', note: '1M 上下文' });
    expect(primary[1]!.note).toBeUndefined();
    expect(primary[1]!.label).toBe('Haiku 5.5'); // 没写显示名就沿用内置名
  });

  it('自定义条目没写显示名时用模型 id 本身', () => {
    expect(mappedExtraModels(map)).toEqual([
      { id: 'gpt-5.6-sol', label: 'Sol', note: undefined },
      { id: 'qwen3-coder-next', label: 'qwen3-coder-next', note: undefined },
    ]);
  });

  it('modelLabelFor：别名查映射，自定义 id 查 extra，查不到退回内置表', () => {
    expect(modelLabelFor('sonnet', map)).toBe('MiniMax M2.5');
    expect(modelLabelFor('gpt-5.6-sol', map)).toBe('Sol');
    expect(modelLabelFor('qwen3-coder-next', map)).toBe('qwen3-coder-next');
    expect(modelLabelFor('opus', map)).toBe(modelLabelFor('opus', null));
  });

  it('菜单：「更多模型」变成「自定义模型」；不传 map 时与原来一致', () => {
    const mapped = buildModelMenu(cfg, () => {}, true, { map }) as MenuItem[];
    expect(mapped.filter((e) => e.key.startsWith('m:')).map((e) => e.label)).toEqual(['MiniMax M2.5', 'Haiku 5.5']);
    expect(mapped.find((e) => e.key === 'more')?.label).toBe('自定义模型');

    const plain = buildModelMenu(cfg, () => {}, true) as MenuItem[];
    expect(plain.find((e) => e.key === 'more')?.label).toBe('更多模型');
    expect(plain.filter((e) => e.key.startsWith('m:')).length).toBeGreaterThan(2);
  });

  it('菜单：映射里没有自定义条目时不显示那个子菜单', () => {
    const only = buildModelMenu(cfg, () => {}, true, { map: { alias: { sonnet: { id: 'x' } } } });
    expect(only.find((e) => e.key === 'more')).toBeUndefined();
  });

  it('触发按钮文字用映射后的名字', () => {
    expect(modelSummary(cfg, { map })).toBe('MiniMax M2.5 · 中等');
    expect(modelSummary(cfg)).toBe('Sonnet 5.5 · 中等');
  });
});
