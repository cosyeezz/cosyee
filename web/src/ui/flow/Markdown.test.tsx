// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Markdown } from './Markdown';
import { BROWSER_OPEN_EVENT, type BrowserOpenDetail } from '../browser/links';
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

/** 点链接，返回默认打开方式有没有被取消（在 window 上看，和桌面客户端 opener 插件的位置一样）；看完取消掉，免得 jsdom 去导航 */
function clickLink(a: Element, init: MouseEventInit = {}): boolean {
  let prevented = false;
  const spy = (e: Event) => {
    prevented = e.defaultPrevented;
    e.preventDefault();
  };
  window.addEventListener('click', spy);
  try {
    act(() => {
      a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
    });
  } finally {
    window.removeEventListener('click', spy);
  }
  return prevented;
}

/** 模拟 MainApp 收下 cosyee:browser-open 事件；返回收到的地址 */
function claimBrowserOpen(): { urls: string[]; stop: () => void } {
  const urls: string[] = [];
  const on = (e: Event) => {
    urls.push((e as CustomEvent<BrowserOpenDetail>).detail.url);
    e.preventDefault();
  };
  window.addEventListener(BROWSER_OPEN_EVENT, on);
  return { urls, stop: () => window.removeEventListener(BROWSER_OPEN_EVENT, on) };
}

describe('Markdown 远程链接默认在内置浏览器打开', () => {
  let claim: ReturnType<typeof claimBrowserOpen> | null = null;
  afterEach(() => {
    claim?.stop();
    claim = null;
  });

  it('普通左键点 http(s) 链接：交给面板打开，链接默认的打开方式被取消', () => {
    claim = claimBrowserOpen();
    const el = mount('[文档](https://example.com/a?b=1) 和 [内网](http://grafana.example.com/d/1)');
    const [a, b] = Array.from(el.querySelectorAll('a'));
    expect(clickLink(a!)).toBe(true);
    expect(clickLink(b!)).toBe(true);
    expect(claim.urls).toEqual(['https://example.com/a?b=1', 'http://grafana.example.com/d/1']);
  });

  it('按住修饰键、mailto 链接：保持默认打开方式', () => {
    claim = claimBrowserOpen();
    const el = mount('[文档](https://example.com/) 和 [邮件](mailto:a@b.c)');
    const [web, mail] = Array.from(el.querySelectorAll('a'));
    for (const mod of ['shiftKey', 'metaKey', 'ctrlKey', 'altKey'] as const) {
      expect(clickLink(web!, { [mod]: true })).toBe(false);
    }
    expect(clickLink(mail!)).toBe(false);
    expect(claim.urls).toEqual([]);
  });

  it('没有面板收下事件时（不在主界面里）保持默认打开方式', () => {
    const el = mount('[文档](https://example.com/)');
    expect(clickLink(el.querySelector('a')!)).toBe(false);
  });
});

describe('Markdown 行内代码路径', () => {
  afterEach(() => window.getSelection()?.removeAllRanges());

  it('行内代码是路径：tooltip 是解析后的完整路径（带行号），点击通过 context 打开预览', () => {
    const files = makeFiles();
    const el = mount('改了 `./src/a.ts:12` 这里', files);
    const code = el.querySelector('code')!;
    expect(code.title).toBe('F:\\proj\\src\\a.ts:12');
    expect(code.textContent).toBe('./src/a.ts:12');
    expect(code.getAttribute('role')).toBe('button');
    // 仍是 <code>（跟着正文换行、文字可选），不换成 <button>
    expect(el.querySelector('button')).toBeNull();
    act(() => code.click());
    expect(files.open).toHaveBeenCalledTimes(1);
    expect(files.open.mock.calls[0]![0]).toEqual({ path: 'F:\\proj\\src\\a.ts', line: 12 });
    expect(files.open.mock.calls[0]![1]).toBe(code);
  });

  it('`~/` 路径原样交给服务端展开；Enter / 空格也能打开', () => {
    const files = makeFiles();
    const el = mount('改 `~/.cosyee/kiro-rs/service/config.json` 里的 `adminApiKey`。', files);
    const [path, key] = Array.from(el.querySelectorAll('code'));
    expect(key!.hasAttribute('role')).toBe(false);
    for (const k of ['Enter', ' ']) {
      act(() => {
        path!.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      });
    }
    expect(files.open.mock.calls.map((c) => c[0])).toEqual([
      { path: '~/.cosyee/kiro-rs/service/config.json' },
      { path: '~/.cosyee/kiro-rs/service/config.json' },
    ]);
  });

  it('在路径里拖选了文字时点击不打开（方便复制）', () => {
    const files = makeFiles();
    const code = mount('看 `/etc/xray/config.json`', files).querySelector('code')!;
    const range = document.createRange();
    range.selectNodeContents(code);
    window.getSelection()!.addRange(range);
    act(() => code.click());
    expect(files.open).not.toHaveBeenCalled();
  });

  it('斜杠命令、带选项的命令行不当路径', () => {
    const el = mount('用 `/compact`，或运行 `./run.sh --watch`、`/usr/local/bin/xray -test`');
    for (const code of Array.from(el.querySelectorAll('code'))) {
      expect(code.hasAttribute('role')).toBe(false);
      expect(code.hasAttribute('title')).toBe(false);
    }
  });

  it('没有 FilesContext：只有 tooltip，不可点击', () => {
    const code = mount('改了 `./src/a.ts`', null).querySelector('code')!;
    expect(code.title).toBe('./src/a.ts');
    expect(code.hasAttribute('role')).toBe(false);
    expect(code.hasAttribute('tabindex')).toBe(false);
  });

  it('不像路径的行内代码没有 tooltip、不可点击', () => {
    const el = mount('调用 `foo()` 即可');
    expect(el.querySelector('code')!.hasAttribute('title')).toBe(false);
    expect(el.querySelector('code')!.hasAttribute('role')).toBe(false);
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

  it('没标语言但内容像命令时也显示「运行」，用平台默认 shell；普通文本不显示', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 1 }));
    const files = { ...makeFiles(), platform: 'darwin', exec };
    const el = mount('```\npython3 -m http.server 8000\n```', files);
    expect(el.querySelector('.cz-flow__code-lang')?.textContent).toBe('text');
    expect(runBtn(el)!.title).toContain('Bash');
    await act(async () => runBtn(el)!.click());
    expect(exec).toHaveBeenCalledWith('bash', 'python3 -m http.server 8000', expect.any(Function), expect.any(AbortSignal));
    act(() => root?.unmount());
    expect(runBtn(mount('```\nHello world\n```', files))).toBeUndefined();
  });

  it('点「运行」调用 exec，结果显示在代码块下方，可收起', async () => {
    const exec = vi.fn(async (_l: string, _c: string, onOutput: (s: 'stdout' | 'stderr', d: string) => void) => {
      onOutput('stdout', 'hel');
      onOutput('stdout', 'lo\n');
      onOutput('stderr', 'warn!');
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, durationMs: 42 };
    });
    const el = mount('```powershell\nstart ms-settings:easeofaccess-visualeffects\n```', { ...makeFiles(), platform: 'win32', exec });
    const btn = runBtn(el)!;
    expect(btn.title).toContain('F:\\proj');
    expect(btn.title).toContain('PowerShell');
    await act(async () => btn.click());
    expect(exec).toHaveBeenCalledWith('powershell', 'start ms-settings:easeofaccess-visualeffects', expect.any(Function), expect.any(AbortSignal));
    expect(el.querySelector('.cz-flow__run-out')?.textContent).toBe('hello\nwarn!');
    expect(el.querySelector('.cz-flow__run-errtext')?.textContent).toBe('warn!');
    expect(el.querySelector('.cz-flow__run-status')?.textContent).toBe('退出码 0');
    act(() => el.querySelector<HTMLButtonElement>('[aria-label="收起运行结果"]')!.click());
    expect(el.querySelector('.cz-flow__run')).toBeNull();
  });

  it('运行中按钮变「停止」，点了中止请求并显示「已停止」', async () => {
    let signal: AbortSignal | undefined;
    let emit: ((s: 'stdout' | 'stderr', d: string) => void) | undefined;
    const exec = vi.fn((_l: string, _c: string, onOutput: (s: 'stdout' | 'stderr', d: string) => void, s: AbortSignal) => {
      signal = s;
      emit = onOutput;
      return new Promise<never>((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const el = mount('```bash\nsleep 100\n```', { ...makeFiles(), platform: 'linux', exec });
    await act(async () => runBtn(el)!.click());
    expect(runBtn(el)!.textContent).toBe('停止');
    expect(el.querySelector('.cz-flow__run-status')?.textContent).toBe('运行中…');
    act(() => emit!('stdout', 'Serving HTTP on :: port 8000\n'));
    expect(el.querySelector('.cz-flow__run-out')?.textContent).toContain('Serving HTTP');
    await act(async () => runBtn(el)!.click());
    expect(signal?.aborted).toBe(true);
    expect(runBtn(el)!.textContent).toBe('运行');
    expect(el.querySelector('.cz-flow__run-status')?.textContent).toBe('已停止');
    expect(el.querySelector('.cz-flow__run-out')?.textContent).toContain('Serving HTTP');
  });

  it('代码块卸载时中止运行', async () => {
    let signal: AbortSignal | undefined;
    const exec = vi.fn((_l: string, _c: string, _o: unknown, s: AbortSignal) => {
      signal = s;
      return new Promise<never>((_, reject) => s.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const el = mount('```bash\nsleep 100\n```', { ...makeFiles(), platform: 'linux', exec });
    await act(async () => runBtn(el)!.click());
    act(() => root?.unmount());
    expect(signal?.aborted).toBe(true);
  });
});
