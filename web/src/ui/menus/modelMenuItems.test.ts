import { describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@cosyee/shared';
import type { CliModel } from '@cosyee/shared';
import { clampEffort, effortsFor, findModel, menuModels } from '@cosyee/shared';
import { buildModelMenu, modelHotkeys, modelSummary } from './modelMenuItems';
import type { MenuItem } from './Menu';

const cfg: SessionConfig = { model: 'sonnet', effort: 'medium' };

describe('modelSummary', () => {
  it('模型名 · 强度', () => {
    expect(modelSummary(cfg)).toBe('Sonnet 5.5 · 中等');
    expect(modelSummary({ ...cfg, effort: 'xhigh', ultracode: true })).toBe('Sonnet 5.5 · 超高 · Ultracode');
  });
  it('未知模型显示原 id', () => {
    expect(modelSummary({ model: 'foo', effort: 'low' })).toBe('foo · 低');
  });
});

describe('buildModelMenu', () => {
  const find = (items: ReturnType<typeof buildModelMenu>, key: string) => items.find((i) => i.key === key) as MenuItem;
  it('前 4 项是常用模型，带快捷键 / 默认 / 勾选 / 备注', () => {
    const items = buildModelMenu(cfg, () => {});
    expect(items.slice(0, 4).map((i) => (i as MenuItem).shortcut)).toEqual(['1', '2', '3', '4']);
    expect(find(items, 'm:sonnet').badge).toBe('默认');
    expect(find(items, 'm:sonnet').checked).toBe(true);
    expect(find(items, 'm:opus').checked).toBe(false);
    expect(find(items, 'm:fable').note).toContain('November 16');
  });
  it('选择模型 / 强度 / Ultracode 会产生新 config', () => {
    const onChange = vi.fn();
    const items = buildModelMenu(cfg, onChange);
    find(items, 'm:opus').onSelect!();
    expect(onChange).toHaveBeenLastCalledWith({ model: 'opus', effort: 'medium' });
    const eff = find(items, 'effort').submenu!.filter((e) => e.kind === undefined) as MenuItem[];
    expect(eff.map((e) => e.label)).toEqual(['低', '中等', '高', '超高', '最高', 'Ultracode']);
    eff[3].onSelect!();
    expect(onChange).toHaveBeenLastCalledWith({ model: 'sonnet', effort: 'xhigh' });
    eff[5].onSelect!();
    expect(onChange).toHaveBeenLastCalledWith({ model: 'sonnet', effort: 'medium', ultracode: true });
    expect(eff[1].checked).toBe(true);
  });
  it('更多模型子菜单：每行可复制模型 id', () => {
    const more = find(buildModelMenu(cfg, () => {}), 'more').submenu! as MenuItem[];
    expect(more.length).toBeGreaterThan(5);
    expect(more.every((e) => e.kind === undefined && e.copy === e.key.slice('m:'.length))).toBe(true);
  });
  it('常用项不带复制按钮', () => {
    expect(buildModelMenu(cfg, () => {}).slice(0, 4).map((i) => (i as MenuItem).copy)).toEqual([undefined, undefined, undefined, undefined]);
  });
  it('数字热键 1–4', () => {
    const onChange = vi.fn();
    const done = vi.fn();
    modelHotkeys(cfg, onChange, done)['4']();
    expect(onChange).toHaveBeenCalledWith({ model: 'haiku', effort: 'medium' });
    expect(done).toHaveBeenCalled();
  });
});

// 订阅账号 initialize 报告的列表（节选，与 shared/fixtures/control-probe.jsonl 一致）
const ALL5 = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const SUB: CliModel[] = [
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', efforts: [...ALL5] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', efforts: [...ALL5] },
  { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', efforts: [...ALL5] },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', efforts: [...ALL5] },
  { value: 'claude-fable-5-1', displayName: 'Fable 5.1', efforts: [...ALL5] },
  { value: 'claude-haiku-4-5-20251001', displayName: 'Haiku 4.5' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', efforts: ['low', 'medium', 'high', 'max'] },
];

describe('CLI 列表驱动的菜单', () => {
  const find = (items: ReturnType<typeof buildModelMenu>, key: string) => items.find((i) => i.key === key) as MenuItem | undefined;

  it('常用项 = 列表里的别名，其余进「更多模型」，备注沿用内置表', () => {
    const { primary, more, moreLabel } = menuModels(SUB, null);
    expect(primary.map((m) => [m.id, m.key])).toEqual([['opus', '1'], ['sonnet', '2'], ['fable', '3'], ['haiku', '4']]);
    expect(primary.find((m) => m.id === 'sonnet')!.isDefault).toBe(true);
    expect(primary.find((m) => m.id === 'fable')!.note).toContain('November 16');
    expect(more.map((m) => m.id)).toEqual(['claude-fable-5-1', 'claude-haiku-4-5-20251001', 'claude-opus-4-6']);
    expect(moreLabel).toBe('更多模型');
  });

  it('列表里缺的别名不显示，热键按顺序补位', () => {
    const { primary } = menuModels(SUB.filter((m) => m.value !== 'opus'), null);
    expect(primary.map((m) => [m.id, m.key])).toEqual([['sonnet', '1'], ['fable', '2'], ['haiku', '3']]);
    const onChange = vi.fn();
    modelHotkeys(cfg, onChange, () => {}, { list: SUB.filter((m) => m.value !== 'opus') })['3']();
    expect(onChange).toHaveBeenCalledWith({ model: 'haiku', effort: 'medium' });
  });

  it('第三方 Base URL：displayName 只有「Opus」时从 description 取带版本的名字', () => {
    const list: CliModel[] = [{ value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · Best for complex work · $4/$20 per Mtok', efforts: [...ALL5] }];
    expect(menuModels(list, null).primary[0]!.label).toBe('Opus 5.5');
    expect(modelSummary({ model: 'opus', effort: 'low' }, { list })).toBe('Opus 5.5 · 低');
  });

  it('会话里的全名 / 去掉日期的 id 也能勾到对应项', () => {
    expect(findModel('claude-haiku-4-5', SUB)?.value).toBe('claude-haiku-4-5-20251001');
    expect(findModel('claude-opus-5-5', SUB)?.value).toBe('opus');
    expect(findModel('claude-sonnet-5-5[1m]', SUB)?.value).toBe('sonnet');
    const more = find(buildModelMenu({ model: 'claude-haiku-4-5', effort: 'low' }, () => {}, true, { list: SUB }), 'more')!.submenu!;
    expect((more.find((e) => e.key === 'm:claude-haiku-4-5-20251001') as MenuItem).checked).toBe(true);
  });

  it('强度子菜单按模型裁剪；不支持强度的模型隐藏整项，触发文字也不带强度', () => {
    const eff = (model: string) => find(buildModelMenu({ model, effort: 'medium' }, () => {}, true, { list: SUB }), 'effort');
    const labels = (model: string) => (eff(model)!.submenu!.filter((e) => e.kind === undefined && e.key.startsWith('e:')) as MenuItem[]).map((e) => e.label);
    expect(labels('opus')).toEqual(['低', '中等', '高', '超高', '最高']);
    expect(labels('claude-opus-4-6')).toEqual(['低', '中等', '高', '最高']);
    expect(eff('claude-haiku-4-5-20251001')).toBeUndefined();
    expect(modelSummary({ model: 'claude-haiku-4-5-20251001', effort: 'medium' }, { list: SUB })).toBe('Haiku 4.5');
  });

  it('换模型时强度落到最接近的支持档位', () => {
    expect(clampEffort('xhigh', ['low', 'medium', 'high', 'max'])).toBe('high');
    expect(clampEffort('low', ['high', 'max'])).toBe('high');
    expect(clampEffort('medium', null)).toBe('medium');
    expect(effortsFor('whatever', null)).toEqual([...ALL5]);
    expect(effortsFor('claude-haiku-4-5-20251001', SUB)).toBeNull();
    const onChange = vi.fn();
    const items = buildModelMenu({ model: 'opus', effort: 'xhigh' }, onChange, true, { list: SUB });
    (find(items, 'more')!.submenu!.find((e) => e.key === 'm:claude-opus-4-6') as MenuItem).onSelect!();
    expect(onChange).toHaveBeenLastCalledWith({ model: 'claude-opus-4-6', effort: 'high' });
  });

  it('有映射：只留映射过的别名，显示名 映射 label → CLI displayName；「自定义模型」= 映射的自定义条目', () => {
    const list: CliModel[] = [
      { value: 'opus', displayName: 'Opus', description: 'Opus 5.5 · …' },
      { value: 'sonnet', displayName: 'minimax-m2.5', resolvedModel: 'minimax-m2.5[1m]', efforts: [...ALL5] },
      { value: 'haiku', displayName: 'Grok', resolvedModel: 'grok-4.7', efforts: [...ALL5] },
    ];
    const map = { alias: { sonnet: { id: 'minimax-m2.5', m1: true }, haiku: { id: 'grok-4.7', label: '小 Grok' } }, extra: [{ id: 'gpt-5.6-sol' }] };
    const r = menuModels(list, map);
    expect(r.primary.map((m) => [m.id, m.label, m.key])).toEqual([['sonnet', 'minimax-m2.5', '1'], ['haiku', '小 Grok', '2']]);
    expect(r.primary[0]!.note).toBe('1M 上下文');
    // 「自定义模型」列全部映射模型：别名在前，target 记实际模型
    expect(r.more.map((m) => [m.id, m.target])).toEqual([['sonnet', 'minimax-m2.5'], ['haiku', 'grok-4.7'], ['gpt-5.6-sol', undefined]]);
    expect(r.moreLabel).toBe('自定义模型');
    // 自定义条目不在 CLI 列表里：强度按全部 5 档
    expect(effortsFor('gpt-5.6-sol', list)).toEqual([...ALL5]);
    expect(modelSummary({ model: 'gpt-5.6-sol', effort: 'high' }, { list, map })).toBe('gpt-5.6-sol · 高');
  });

  it('「自定义模型」子菜单：别名在前（选中仍传别名）、分隔线、自定义条目去重；复制的是实际模型名', () => {
    const map = {
      alias: { opus: { id: 'claude-opus-5.5' }, haiku: { id: 'claude-haiku-5.5', label: '小 Haiku', m1: true } },
      extra: [{ id: 'claude-opus-4.6' }, { id: 'claude-opus-5.5' }],
    };
    const onChange = vi.fn();
    const sub = find(buildModelMenu({ model: 'opus', effort: 'medium' }, onChange, true, { map }), 'more')!.submenu!;
    expect(sub.map((e) => (e.kind === 'sep' ? '—' : (e as MenuItem).label))).toEqual(['claude-opus-5.5', '小 Haiku', '—', 'claude-opus-4.6']);
    const rows = sub.filter((e): e is MenuItem => e.kind === undefined);
    expect(rows.map((e) => e.copy)).toEqual(['claude-opus-5.5', 'claude-haiku-5.5', 'claude-opus-4.6']);
    expect(rows[0]!.checked).toBe(true);
    expect(rows[1]!.note).toBe('1M 上下文');
    rows[1]!.onSelect!();
    expect(onChange).toHaveBeenLastCalledWith({ model: 'haiku', effort: 'medium' });
    rows[2]!.onSelect!();
    expect(onChange).toHaveBeenLastCalledWith({ model: 'claude-opus-4.6', effort: 'medium' });
  });

  it('「刷新模型列表」：传了 onRefresh 才有，不关菜单；刷新中禁用', () => {
    expect(find(buildModelMenu(cfg, () => {}), 'refresh')).toBeUndefined();
    const onRefresh = vi.fn();
    const r = find(buildModelMenu(cfg, () => {}, true, { list: SUB, onRefresh }), 'refresh')!;
    expect(r.keepOpen).toBe(true);
    r.onSelect!();
    expect(onRefresh).toHaveBeenCalled();
    expect(find(buildModelMenu(cfg, () => {}, true, { list: SUB, onRefresh, refreshing: true }), 'refresh')!.disabled).toBe(true);
  });
});
