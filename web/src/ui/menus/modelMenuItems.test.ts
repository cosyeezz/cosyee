import { describe, expect, it, vi } from 'vitest';
import type { SessionConfig } from '@cosyee/shared';
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
  it('更多模型子菜单', () => {
    const more = find(buildModelMenu(cfg, () => {}), 'more').submenu!;
    expect(more.length).toBeGreaterThan(5);
  });
  it('数字热键 1–4', () => {
    const onChange = vi.fn();
    const done = vi.fn();
    modelHotkeys(cfg, onChange, done)['4']();
    expect(onChange).toHaveBeenCalledWith({ model: 'haiku', effort: 'medium' });
    expect(done).toHaveBeenCalled();
  });
});
