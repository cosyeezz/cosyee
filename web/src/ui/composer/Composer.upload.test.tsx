// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PickedItem } from '@cosyee/shared';
import { Composer, type ComposerHandle, type ComposerProps } from './Composer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

const UP = 'C:\\Users\\u\\.cosyee\\uploads\\1795354327668-0123456789ab\\';

/** 可以手动结束的上传：记下每次调用的进度回调和 resolve / reject */
function controlledUpload() {
  const calls: { name: string; progress?: (r: number) => void; resolve: (i: PickedItem) => void; reject: (e: unknown) => void }[] = [];
  const upload = vi.fn((_blob: Blob, name: string, progress?: (r: number) => void) =>
    new Promise<PickedItem>((resolve, reject) => { calls.push({ name, progress, resolve, reject }); }));
  const done = (i: number, isImage = false) =>
    act(async () => {
      calls[i]!.resolve({ path: UP + calls[i]!.name, kind: 'file', previewToken: `t${i}`, isImage });
      await Promise.resolve();
    });
  return { upload, calls, done };
}

function mount(extra: Partial<ComposerProps>) {
  const onSend = vi.fn();
  const pick = vi.fn(async () => ({ items: [] as PickedItem[], supportsMixed: false }));
  const ref = createRef<ComposerHandle>();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const props: ComposerProps = {
    onSend, onInterrupt: () => {}, running: false,
    pick, supportsMixed: false,
    previewInfo: async () => { throw new Error('unused'); }, previewRawUrl: () => '',
    slashCommands: [], skills: [], config: { model: 'sonnet', effort: 'medium' }, onConfigChange: () => {},
    ...extra,
  };
  act(() => root!.render(<Composer ref={ref} {...props} />));
  const ed = () => host!.querySelector<HTMLElement>('.cz-composer__editor')!;
  const plus = () => host!.querySelector<HTMLButtonElement>('button[aria-label="添加文件"]')!;
  const input = () => host!.querySelector<HTMLInputElement>('.cz-composer__file');
  const sendBtn = () => host!.querySelector<HTMLButtonElement>('.cz-composer__btn--send');
  const pending = () => ed().querySelectorAll('.cz-chip--pending');
  const chips = () => ed().querySelectorAll('.cz-chip:not([data-pending])');
  const choose = (files: File[]) =>
    act(async () => {
      Object.defineProperty(input()!, 'files', { value: files, configurable: true });
      input()!.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve(); // prepareUpload（jsdom 没有 createImageBitmap，原样返回）
      await Promise.resolve();
    });
  const enter = () => act(() => { ed().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  return { onSend, pick, ref, ed, plus, input, sendBtn, pending, chips, choose, enter, host: host! };
}

const file = (name: string, size = 10, type = 'text/plain') => {
  const f = new File(['x'], name, { type });
  if (size !== 1) Object.defineProperty(f, 'size', { value: size });
  return f;
};
const menuLabels = () => [...document.querySelectorAll('.cz-menu__row .cz-menu__label')].map((n) => n.textContent);
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe('Composer「+」', () => {
  it('远程连接：弹出两种来源，「从本设备上传」排第一；选宿主机走原来的选择器', async () => {
    const { upload } = controlledUpload();
    const m = mount({ upload, remote: true });
    act(() => m.plus().click());
    expect(menuLabels()).toEqual(['从本设备上传', '选择宿主机上的文件']);
    expect(m.pick).not.toHaveBeenCalled();
    const rows = [...document.querySelectorAll<HTMLElement>('.cz-menu__row')];
    act(() => rows[1]!.click());
    await flush();
    expect(m.pick).toHaveBeenCalled();
    expect(menuLabels()).toEqual([]);
  });

  it('「从本设备上传」点开隐藏的文件框（保持用户手势，同步触发）', () => {
    const { upload } = controlledUpload();
    const m = mount({ upload, remote: true });
    const click = vi.spyOn(m.input()!, 'click').mockImplementation(() => {});
    act(() => m.plus().click());
    act(() => document.querySelector<HTMLElement>('.cz-menu__row')!.click());
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('本机连接：「+」仍直接打开宿主机选择器，不弹菜单', async () => {
    const { upload } = controlledUpload();
    const m = mount({ upload, remote: false });
    act(() => m.plus().click());
    await flush();
    expect(m.pick).toHaveBeenCalled();
    expect(menuLabels()).toEqual([]);
  });

  it('没有 upload 能力时不渲染文件框', () => {
    const m = mount({ remote: true });
    expect(m.input()).toBeNull();
  });
});

describe('Composer 从本设备上传', () => {
  it('选文件 → 先出带进度的占位标签 → 完成后换成正式标签，发送带上路径', async () => {
    const { upload, calls, done } = controlledUpload();
    const m = mount({ upload, remote: true });
    await m.choose([file('报告.pdf'), file('a.txt')]);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(m.pending()).toHaveLength(2);
    expect(m.pending()[0]!.textContent).toContain('报告.pdf');

    act(() => calls[0]!.progress?.(0.42));
    expect(m.pending()[0]!.textContent).toContain('42%');

    // 还有上传没完成：发送按钮置灰，回车不发送并提示
    expect(m.sendBtn()?.disabled).toBe(true);
    m.enter();
    expect(m.onSend).not.toHaveBeenCalled();
    expect(m.host.querySelector('.cz-composer__hint')?.textContent).toBe('文件还在上传');

    await done(0);
    await done(1);
    expect(m.pending()).toHaveLength(0);
    expect([...m.chips()].map((c) => (c as HTMLElement).dataset.path)).toEqual([UP + '报告.pdf', UP + 'a.txt']);
    expect(m.sendBtn()?.disabled).toBe(false);
    m.enter();
    expect(m.onSend).toHaveBeenCalledTimes(1);
    const [text, atts] = m.onSend.mock.calls[0]!;
    expect(text).toContain(`@"${UP}报告.pdf"`);
    expect(atts).toEqual([
      { kind: 'file', label: 'file1', path: UP + '报告.pdf' },
      { kind: 'file', label: 'file2', path: UP + 'a.txt' },
    ]);
  });

  it('上传失败：删掉占位并提示', async () => {
    const { upload, calls } = controlledUpload();
    const m = mount({ upload, remote: true });
    await m.choose([file('x.zip')]);
    await act(async () => { calls[0]!.reject(new Error('网络错误')); await Promise.resolve(); });
    expect(m.pending()).toHaveLength(0);
    expect(m.chips()).toHaveLength(0);
    expect(m.host.querySelector('.cz-composer__hint')?.textContent).toBe('上传失败：网络错误');
  });

  it('超过 100MB 不发请求，直接提示', async () => {
    const { upload } = controlledUpload();
    const m = mount({ upload, remote: true });
    await m.choose([file('big.mov', 100 * 1024 * 1024 + 1)]);
    expect(upload).not.toHaveBeenCalled();
    expect(m.pending()).toHaveLength(0);
    expect(m.host.querySelector('.cz-composer__hint')?.textContent).toBe('「big.mov」超过 100MB');
  });

  it('上传途中占位被删掉：结果丢弃，不再插回标签', async () => {
    const { upload, done } = controlledUpload();
    const m = mount({ upload, remote: true });
    await m.choose([file('a.txt')]);
    act(() => { m.pending()[0]!.remove(); });
    await done(0);
    expect(m.chips()).toHaveLength(0);
  });

  it('拖放文件到输入框：高亮提示，松开后上传', async () => {
    const { upload } = controlledUpload();
    const m = mount({ upload });
    const box = m.host.querySelector<HTMLElement>('.cz-composer__box')!;
    const dt = { types: ['Files'], files: [file('拖进来.log')], dropEffect: 'none' };
    const fire = (type: string) =>
      act(async () => {
        const ev = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(ev, 'dataTransfer', { value: dt });
        box.dispatchEvent(ev);
        await Promise.resolve();
        await Promise.resolve();
      });
    await fire('dragenter');
    expect(box.classList.contains('is-dragging')).toBe(true);
    expect(m.host.querySelector('.cz-composer__drop')?.textContent).toContain('松开上传');
    await fire('drop');
    expect(box.classList.contains('is-dragging')).toBe(false);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![1]).toBe('拖进来.log');
    expect(m.pending()).toHaveLength(1);
  });
});
