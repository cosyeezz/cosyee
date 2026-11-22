// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ToolStep } from '@cosyee/shared';
import { StepView } from './Steps';
import { toolFilePath } from './format';
import { FilesContext, type FilesApi } from '../files/FileContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const readStep: ToolStep = {
  kind: 'tool',
  id: 'r1',
  name: 'Read',
  input: { file_path: 'F:\\proj\\src\\a.ts' },
  summary: 'Read: src/a.ts',
};

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(step: ToolStep, files: FilesApi | null) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <FilesContext.Provider value={files}>
        <StepView step={step} turnActive={false} />
      </FilesContext.Provider>,
    ),
  );
  return host;
}
const makeFiles = (): FilesApi & { open: ReturnType<typeof vi.fn> } => ({ cwd: 'F:\\proj', open: vi.fn(), reveal: vi.fn(), terminal: vi.fn() });

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('toolFilePath', () => {
  it('读写文件类工具取 file_path / notebook_path；其它工具或缺失返回 undefined', () => {
    expect(toolFilePath({ name: 'Read', input: { file_path: 'a' } })).toBe('a');
    expect(toolFilePath({ name: 'MultiEdit', input: { file_path: 'b' } })).toBe('b');
    expect(toolFilePath({ name: 'NotebookEdit', input: { notebook_path: 'c.ipynb' } })).toBe('c.ipynb');
    expect(toolFilePath({ name: 'Bash', input: { file_path: 'x' } })).toBeUndefined();
    expect(toolFilePath({ name: 'Read', input: {} })).toBeUndefined();
    expect(toolFilePath({ name: 'Read', input: 'str' })).toBeUndefined();
    expect(toolFilePath({ name: 'Read', input: { file_path: '  ' } })).toBeUndefined();
  });
});

describe('工具行里的文件路径', () => {
  it('路径是独立按钮，点击打开预览（完整路径），不触发展开；按钮不嵌套', () => {
    const files = makeFiles();
    const el = mount(readStep, files);
    const pathBtn = el.querySelector<HTMLButtonElement>('.cz-flow__tool-path')!;
    expect(pathBtn.textContent).toBe('src/a.ts');
    expect(pathBtn.title).toBe('F:\\proj\\src\\a.ts');
    act(() => pathBtn.click());
    expect(files.open).toHaveBeenCalledTimes(1);
    expect(files.open.mock.calls[0]![0]).toEqual({ path: 'F:\\proj\\src\\a.ts' });
    expect(files.open.mock.calls[0]![1]).toBe(pathBtn);
    expect(el.querySelector('.cz-flow__tool-body')).toBeNull();
    // 不嵌套：任何 button 里都没有 button
    for (const b of Array.from(el.querySelectorAll('button'))) expect(b.querySelector('button')).toBeNull();
  });

  it('行里其余按钮仍能展开 / 收起', () => {
    const el = mount(readStep, makeFiles());
    const toggles = Array.from(el.querySelectorAll<HTMLButtonElement>('.cz-flow__row-btn'));
    expect(toggles).toHaveLength(2);
    act(() => toggles[0]!.click());
    expect(el.querySelector('.cz-flow__tool-body')).not.toBeNull();
    act(() => toggles[1]!.click());
    expect(el.querySelector('.cz-flow__tool-body')).toBeNull();
  });

  it('没有 FilesContext 或输入里没有路径：保持原来的整行单按钮', () => {
    const noCtx = mount(readStep, null);
    expect(noCtx.querySelector('.cz-flow__tool-path')).toBeNull();
    expect(noCtx.querySelectorAll('button')).toHaveLength(1);
    expect(noCtx.querySelector('.cz-flow__tool-summary')!.textContent).toBe('Read: src/a.ts');
    act(() => root?.unmount());
    host?.remove();
    const noPath = mount({ ...readStep, input: {} }, makeFiles());
    expect(noPath.querySelector('.cz-flow__tool-path')).toBeNull();
    expect(noPath.querySelectorAll('button')).toHaveLength(1);
  });
});

describe('交互工具的展示', () => {
  it('AskUserQuestion：摘要、选项与解析出的答案', () => {
    const step: ToolStep = {
      kind: 'tool', id: 'q1', name: 'AskUserQuestion', summary: 'AskUserQuestion',
      input: { questions: [{ question: '选哪个？', options: [{ label: 'A', description: '说明' }, { label: 'B' }] }] },
      result: { content: 'Your questions have been answered: "选哪个？"="B". You can now continue.', isError: false },
    };
    const el = mount(step, null);
    expect(el.querySelector('.cz-flow__tool-summary')!.textContent).toBe('提问：选哪个？');
    act(() => el.querySelector<HTMLButtonElement>('.cz-flow__row-btn')!.click());
    expect(el.querySelector('.cz-flow__ask-ans')!.textContent).toBe('回答：B');
    expect(el.textContent).toContain('说明');
  });

  it('ExitPlanMode：渲染 Markdown 计划与批准状态', () => {
    const step: ToolStep = {
      kind: 'tool', id: 'p1', name: 'ExitPlanMode', summary: 'ExitPlanMode',
      input: { plan: '# 方案\n\n- 第一步' },
      result: { content: 'User has approved your plan.', isError: false },
    };
    const el = mount(step, null);
    expect(el.querySelector('.cz-flow__tool-summary')!.textContent).toBe('计划：方案');
    act(() => el.querySelector<HTMLButtonElement>('.cz-flow__row-btn')!.click());
    expect(el.querySelector('.cz-flow__plan li')!.textContent).toContain('第一步');
    expect(el.querySelector('.cz-flow__plan-status')!.textContent).toBe('已批准');
  });
});
