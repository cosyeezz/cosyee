// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SkillLoad, Turn } from '@cosyee/shared';
import { SessionDock } from './SessionDock';
import { FlowMetaContext } from './flowContext';
import { FilesContext } from '../files/FileContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const load = (p: Partial<SkillLoad> & { id: string; name: string }): SkillLoad => ({ source: 'model', status: 'loaded', ...p });
const mkTurn = (skills: SkillLoad[]): Turn => ({
  id: 't1',
  userText: 'hi',
  attachments: [],
  status: 'running',
  statusText: '',
  steps: [],
  answer: '',
  subagents: [],
  skills,
  startedAt: 1,
});

async function mount(skills: SkillLoad[], loadSkill = vi.fn()) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <FilesContext.Provider value={{ cwd: '/proj', open: () => {} }}>
        <FlowMetaContext.Provider value={{ mcpServers: [], loadSkill }}>
          <SessionDock turns={[mkTurn(skills)]} sessionKey="s1" />
        </FlowMetaContext.Provider>
      </FilesContext.Provider>,
    );
  });
  return loadSkill;
}
const rows = () => [...host!.querySelectorAll<HTMLButtonElement>('.cz-flow__pitem-row')];
const click = async (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));

describe('SkillList（经 SessionDock 展示）', () => {
  it('同名合并为 ×N，头部按不同名字计数', async () => {
    await mount([load({ id: '1', name: 'a' }), load({ id: '2', name: 'b' }), load({ id: '3', name: 'a' })]);
    expect(host!.textContent).toContain('2 个技能');
    expect(rows()).toHaveLength(2);
    expect(rows()[0].textContent).toContain('×2');
    expect(rows()[1].textContent).not.toContain('×');
  });

  it('用户输入的加载带「手动」标', async () => {
    await mount([load({ id: '1', name: 'a', source: 'user' }), load({ id: '2', name: 'b' })]);
    expect(rows()[0].textContent).toContain('手动');
    expect(rows()[1].textContent).not.toContain('手动');
  });

  it('加载中：头部流光，图标不静止', async () => {
    await mount([load({ id: '1', name: 'a', status: 'loading' })]);
    expect(host!.querySelector('.cz-st-compacting')?.textContent).toContain('正在加载技能');
    expect(host!.querySelector('.cz-ss-skill')?.classList.contains('is-still')).toBe(false);
    expect(host!.querySelector('.cz-st-tool')).not.toBeNull();
  });

  it('展开显示注入正文，多行可同时展开，「收起」关闭', async () => {
    const loader = await mount([
      load({ id: '1', name: 'a', body: '正文A', args: 'alpha' }),
      load({ id: '2', name: 'b', body: '正文B' }),
    ]);
    await click(rows()[0]);
    await click(rows()[1]);
    expect(host!.textContent).toContain('正文A');
    expect(host!.textContent).toContain('正文B');
    expect(host!.textContent).toContain('参数：alpha');
    expect(loader).not.toHaveBeenCalled();
    const close = host!.querySelector<HTMLButtonElement>('.cz-flow__pdetail-close')!;
    await click(close);
    expect(host!.textContent).not.toContain('正文A');
    expect(host!.textContent).toContain('正文B');
    await click(rows()[1]);
    expect(host!.textContent).not.toContain('正文B');
  });

  it('没有正文时展开才读磁盘，带 cwd，并标注来源', async () => {
    const loader = vi.fn().mockResolvedValue({ name: 'a', body: '磁盘正文', dir: '/d' });
    await mount([load({ id: 'user:t', name: 'a', source: 'user' })], loader);
    expect(loader).not.toHaveBeenCalled();
    await click(rows()[0]);
    expect(loader).toHaveBeenCalledWith('a', '/proj');
    expect(host!.textContent).toContain('磁盘正文');
    expect(host!.textContent).toContain('来自磁盘 SKILL.md');
    await click(host!.querySelector('.cz-flow__pdetail-close')!);
    await click(rows()[0]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('读磁盘失败显示失败信息', async () => {
    await mount([load({ id: 'u', name: 'a', source: 'user' })], vi.fn().mockRejectedValue(new Error('404')));
    await click(rows()[0]);
    expect(host!.textContent).toContain('读取 SKILL.md 失败：404');
  });

  it('错误行标红，展开显示错误文字且不读磁盘', async () => {
    const loader = await mount([load({ id: '1', name: 'bad', status: 'error', error: 'Unknown skill: bad' })]);
    expect(host!.querySelector('.cz-st-error')?.textContent).toBe('bad');
    await click(rows()[0]);
    expect(host!.textContent).toContain('Unknown skill: bad');
    expect(loader).not.toHaveBeenCalled();
  });
});
