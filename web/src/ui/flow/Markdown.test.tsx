// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from './Markdown';
import { FilesContext, type FilesApi } from '../files/FileContext';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function makeFiles(): FilesApi & { open: ReturnType<typeof vi.fn> } {
  return { cwd: 'F:\\proj', open: vi.fn(), reveal: vi.fn(), terminal: vi.fn() };
}

function mount(text: string, files: FilesApi | null = makeFiles(), baseFile?: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(
    <FilesContext.Provider value={files}>
      <Markdown text={text} baseFile={baseFile} />
    </FilesContext.Provider>,
  ));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('Markdown 本地路径链接', () => {
  it('本地链接渲染成按钮（文件图标 + 文字，tooltip 是完整路径），点击通过 context 打开预览', () => {
    const files = makeFiles();
    const el = mount('看 [reducer](src/core/reducer.ts#L42)', files);
    const btn = el.querySelector<HTMLButtonElement>('button.cz-filelink');
    expect(btn).not.toBeNull();
    expect(btn!.querySelector('.icon-file')).not.toBeNull();
    expect(btn!.textContent).toBe('reducer');
    expect(btn!.title).toBe('F:\\proj\\src\\core\\reducer.ts:42');
    expect(el.querySelector('a')).toBeNull();
    act(() => btn!.click());
    expect(files.open).toHaveBeenCalledTimes(1);
    expect(files.open.mock.calls[0]![0]).toEqual({ path: 'F:\\proj\\src\\core\\reducer.ts', line: 42 });
    expect(files.open.mock.calls[0]![1]).toBe(btn);
  });

  it('Windows 绝对路径 href（F:\\x.md）不会被默认的 urlTransform 清空', () => {
    const files = makeFiles();
    const el = mount('[说明](F:\\x.md)', files);
    const btn = el.querySelector<HTMLButtonElement>('button.cz-filelink');
    expect(btn).not.toBeNull();
    act(() => btn!.click());
    expect(files.open.mock.calls[0]![0].path).toBe('F:\\x.md');
  });

  it('预览的 Markdown 里的相对链接按该文件所在目录解析', () => {
    const files = makeFiles();
    const el = mount('[b](./b.md)', files, 'F:\\proj\\docs\\a.md');
    expect(el.querySelector<HTMLButtonElement>('button.cz-filelink')!.title).toBe('F:\\proj\\docs\\b.md');
  });

  it('没有 FilesContext：本地链接是不可点击的纯文本，不渲染按钮', () => {
    const el = mount('[a](src/a.ts)', null);
    expect(el.querySelector('button')).toBeNull();
    expect(el.querySelector('a')).toBeNull();
    expect(el.querySelector('.cz-filelink.is-static')?.textContent).toBe('a');
  });

  it('远程链接仍是 <a target=_blank rel=noopener noreferrer>', () => {
    const el = mount('[文档](https://example.com/a?b=1) 和 [邮件](mailto:a@b.c)');
    const links = Array.from(el.querySelectorAll('a'));
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      const rel = a.getAttribute('rel') ?? '';
      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
    }
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/a?b=1');
    expect(el.querySelector('button')).toBeNull();
  });

  it('javascript: 等其它协议退化成纯文本（不是链接也不是按钮）', () => {
    const el = mount('[点我](javascript:alert(1))');
    expect(el.querySelector('a')).toBeNull();
    expect(el.querySelector('button')).toBeNull();
    expect(el.textContent).toContain('点我');
  });
});

describe('Markdown 行内代码路径', () => {
  it('行内代码是路径：tooltip 是解析后的完整路径（带行号）', () => {
    const el = mount('改了 `./src/a.ts:12` 这里');
    const code = el.querySelector('code')!;
    expect(code.title).toBe('F:\\proj\\src\\a.ts:12');
    expect(code.textContent).toBe('./src/a.ts:12');
    // 行内代码不会变成按钮
    expect(el.querySelector('button')).toBeNull();
  });

  it('不像路径的行内代码没有 tooltip', () => {
    const el = mount('调用 `foo()` 即可');
    expect(el.querySelector('code')!.hasAttribute('title')).toBe(false);
  });

  it('围栏代码块不受影响（没有 tooltip、仍有复制按钮）', () => {
    const el = mount('```ts\nconst a = "src/a.ts";\n```');
    expect(el.querySelector('.cz-flow__code-copy')).not.toBeNull();
    expect(el.querySelector('pre code')!.hasAttribute('title')).toBe(false);
  });
});

describe('代码块运行按钮', () => {
  const runBtn = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLButtonElement>('button.cz-flow__code-copy')].find((b) => b.textContent === '运行' || b.textContent === '停止');

  it('shell 类语言显示「运行」，其它语言 / 没有 exec / 预览里的 .md 不显示', () => {
    const exec = vi.fn();
    const files = { ...makeFiles(), platform: 'win32', exec };
    expect(runBtn(mount('```powershell\nstart ms-settings:\n```', files))).toBeDefined();
    act(() => root?.unmount());
    expect(runBtn(mount('```python\nprint(1)\n```', files))).toBeUndefined();
    act(() => root?.unmount());
    expect(runBtn(mount('```powershell\nls\n```', makeFiles()))).toBeUndefined();
    act(() => root?.unmount());
    expect(runBtn(mount('```powershell\nls\n```', files, 'F:\\proj\\README.md'))).toBeUndefined();
    act(() => root?.unmount());
    expect(runBtn(mount('```cmd\ndir\n```', { ...files, platform: 'linux' }))).toBeUndefined();
  });

  it('点「运行」调用 exec，结果显示在代码块下方，可收起', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: 'hello\n', stderr: 'warn!', timedOut: false, truncated: false, durationMs: 42 }));
    const el = mount('```powershell\nstart ms-settings:easeofaccess-visualeffects\n```', { ...makeFiles(), platform: 'win32', exec });
    const btn = runBtn(el)!;
    expect(btn.title).toContain('F:\\proj');
    expect(btn.title).toContain('PowerShell');
    await act(async () => btn.click());
    expect(exec).toHaveBeenCalledWith('powershell', 'start ms-settings:easeofaccess-visualeffects', expect.any(AbortSignal));
    expect(el.querySelector('.cz-flow__run-out')?.textContent).toBe('hello');
    expect(el.querySelector('.cz-flow__run-err')?.textContent).toBe('warn!');
    expect(el.querySelector('.cz-flow__run-status')?.textContent).toBe('退出码 0');
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="收起运行结果"]')!.click());
    expect(el.querySelector('.cz-flow__run')).toBeNull();
  });

  it('运行中按钮变「停止」，点了中止请求并显示「已停止」', async () => {
    let signal: AbortSignal | undefined;
    const exec = vi.fn((_l: string, _c: string, s: AbortSignal) => {
      signal = s;
      return new Promise<never>((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const el = mount('```bash\nsleep 100\n```', { ...makeFiles(), platform: 'linux', exec });
    await act(async () => runBtn(el)!.click());
    expect(runBtn(el)!.textContent).toBe('停止');
    await act(async () => runBtn(el)!.click());
    expect(signal?.aborted).toBe(true);
    expect(runBtn(el)!.textContent).toBe('运行');
    expect(el.querySelector('.cz-flow__run-status')?.textContent).toBe('已停止');
  });
});
