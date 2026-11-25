// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Composer, type ComposerHandle, type ComposerProps } from './Composer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(extra: Partial<ComposerProps>) {
  const onSend = vi.fn();
  const ref = createRef<ComposerHandle>();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const props: ComposerProps = {
    onSend, onInterrupt: () => {}, running: false,
    pick: async () => ({ items: [], supportsMixed: false }), supportsMixed: false,
    previewInfo: async () => { throw new Error('unused'); }, previewRawUrl: () => '',
    slashCommands: [], skills: [], config: { model: 'sonnet', effort: 'medium' }, onConfigChange: () => {},
    ...extra,
  };
  act(() => root!.render(<Composer ref={ref} {...props} />));
  const ed = () => host!.querySelector<HTMLElement>('.cz-composer__editor')!;
  const key = (key: string, init: KeyboardEventInit = {}, target: EventTarget = ed()) =>
    act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })); });
  return { onSend, ref, ed, key, host: host! };
}

afterEach(() => {
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('Composer 发送模式', () => {
  it('执行中：Enter = 插话（next），Ctrl+Enter = 排队（later）', () => {
    const m = mount({ running: true });
    act(() => m.ref.current!.appendText('甲'));
    m.key('Enter');
    expect(m.onSend).toHaveBeenLastCalledWith('甲', [], 'next');
    act(() => m.ref.current!.appendText('乙'));
    m.key('Enter', { ctrlKey: true });
    expect(m.onSend).toHaveBeenLastCalledWith('乙', [], 'later');
  });

  it('空闲：Enter 与 Ctrl+Enter 都是普通发送（不带 mode）', () => {
    const m = mount({ running: false });
    act(() => m.ref.current!.appendText('甲'));
    m.key('Enter');
    expect(m.onSend).toHaveBeenLastCalledWith('甲', []);
    act(() => m.ref.current!.appendText('乙'));
    m.key('Enter', { ctrlKey: true });
    expect(m.onSend).toHaveBeenLastCalledWith('乙', []);
  });

  it('执行中的占位提示说明两种模式', () => {
    const m = mount({ running: true });
    expect(m.ed().dataset.placeholder).toBe('Enter 插话 · Ctrl+Enter 排队');
  });

  it('触屏没有组合键：执行中的占位提示用短文案', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', addEventListener() {}, removeEventListener() {} }));
    try {
      const m = mount({ running: true });
      expect(m.ed().dataset.placeholder).toBe('输入以插话');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Composer 队列列表', () => {
  const queue = [
    { id: 'q1', text: '第一条\n第二行', mode: 'next' as const, at: 1 },
    { id: 'q2', text: '稍后再说', mode: 'later' as const, at: 2 },
  ];

  it('显示类型标签与单行文字，按钮调用 onQueueSendNow / onQueueCancel', () => {
    const onQueueSendNow = vi.fn();
    const onQueueCancel = vi.fn();
    const m = mount({ running: true, queue, onQueueSendNow, onQueueCancel });
    const items = Array.from(m.host.querySelectorAll('.cz-queue__item'));
    expect(items).toHaveLength(2);
    expect(items[0].querySelector('.cz-queue__tag')?.textContent).toBe('插话');
    expect(items[0].querySelector('.cz-queue__text')?.textContent).toBe('第一条');
    expect(items[1].querySelector('.cz-queue__tag')?.textContent).toBe('排队');
    const btn = (i: number, label: string) => Array.from(items[i].querySelectorAll('button')).find((b) => b.textContent === label)!;
    act(() => btn(1, '立即发送').click());
    expect(onQueueSendNow).toHaveBeenCalledWith('q2');
    act(() => btn(0, '撤回编辑').click());
    expect(onQueueCancel).toHaveBeenCalledWith('q1');
  });

  it('队列为空时不渲染列表', () => {
    const m = mount({ running: true, queue: [] });
    expect(m.host.querySelector('.cz-queue')).toBeNull();
  });
});

describe('Composer.restoreText', () => {
  it('编辑区为空：直接填入，@"路径" 还原为标签', () => {
    const m = mount({});
    act(() => m.ref.current!.restoreText('看 @"C:\\a\\b.ts" 这个', 'append'));
    expect(m.ed().querySelectorAll('.cz-chip')).toHaveLength(1);
    expect(m.ed().querySelector<HTMLElement>('.cz-chip')?.dataset.path).toBe('C:\\a\\b.ts');
    m.key('Enter');
    expect(m.onSend).toHaveBeenLastCalledWith('看 @"C:\\a\\b.ts" 这个', [{ kind: 'file', label: 'file1', path: 'C:\\a\\b.ts' }]);
  });

  it('append：已有内容时换行追加；replace：整体替换', () => {
    const m = mount({});
    act(() => m.ref.current!.appendText('已有'));
    act(() => m.ref.current!.restoreText('撤回的', 'append'));
    expect(m.ed().textContent).toBe('已有\n撤回的');
    act(() => m.ref.current!.restoreText('回退的', 'replace'));
    expect(m.ed().textContent).toBe('回退的');
  });
});

describe('Composer 双击 Esc 回退', () => {
  const targets = [
    { id: 'a', text: '第一条消息' },
    { id: 'b', text: '第二条消息' },
    { id: 'c', text: '第三条消息' },
  ];

  it('400ms 内连按两次 Esc 打开浮层，默认选中最新一条，Enter 确认', () => {
    const onRewind = vi.fn();
    const m = mount({ rewindTargets: targets, onRewind });
    m.key('Escape');
    expect(m.host.querySelector('.cz-rewind')).toBeNull(); // 单击不打开
    m.key('Escape');
    const items = Array.from(m.host.querySelectorAll('.cz-rewind__item'));
    expect(items.map((i) => i.textContent)).toEqual(['第一条消息', '第二条消息', '第三条消息']);
    expect(items[2].getAttribute('aria-selected')).toBe('true');
    m.key('ArrowUp', {}, document.body);
    m.key('Enter', {}, document.body);
    expect(onRewind).toHaveBeenCalledWith('b');
    expect(m.host.querySelector('.cz-rewind')).toBeNull();
  });

  it('间隔超过 400ms 不算双击', () => {
    vi.useFakeTimers();
    const m = mount({ rewindTargets: targets });
    m.key('Escape');
    vi.setSystemTime(Date.now() + 500);
    m.key('Escape');
    expect(m.host.querySelector('.cz-rewind')).toBeNull();
  });

  it('浮层里 Esc 关闭；鼠标点击直接确认；Enter 不会误发送输入框内容', () => {
    const onRewind = vi.fn();
    const m = mount({ rewindTargets: targets, onRewind });
    act(() => m.ref.current!.appendText('草稿'));
    m.key('Escape');
    m.key('Escape');
    expect(m.host.querySelector('.cz-rewind')).not.toBeNull();
    m.key('Escape', {}, document.body);
    expect(m.host.querySelector('.cz-rewind')).toBeNull();
    m.key('Escape');
    m.key('Escape');
    act(() => (m.host.querySelectorAll('.cz-rewind__item')[0] as HTMLElement).click());
    expect(onRewind).toHaveBeenCalledWith('a');
    expect(m.onSend).not.toHaveBeenCalled();
  });

  it('没有可回退的消息时给出提示而不打开浮层', () => {
    const m = mount({ rewindTargets: [] });
    m.key('Escape');
    m.key('Escape');
    expect(m.host.querySelector('.cz-rewind')).toBeNull();
    expect(m.host.querySelector('.cz-composer__hint')?.textContent).toBe('没有可回退的消息');
  });
});

describe('Composer 排队列表', () => {
  it('条目里的 @"路径" 显示成附件标签，和会话流一致', () => {
    const text = '看下 @"/Users/x/.cosyee/pastes/paste-1795590625505-274f6bf64a62.png" 这个\n第二行';
    const m = mount({ running: true, queue: [{ id: 'q1', text, mode: 'next', at: 0 }] });
    const line = m.host.querySelector<HTMLElement>('.cz-queue__text')!;
    expect(line.textContent).toBe('看下 img1 这个');
    const tag = line.querySelector<HTMLElement>('.cz-flow__tag--img')!;
    expect(tag.title).toBe('/Users/x/.cosyee/pastes/paste-1795590625505-274f6bf64a62.png');
  });
});
