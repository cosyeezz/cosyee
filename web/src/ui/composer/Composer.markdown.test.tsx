// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Composer, type ComposerHandle, type ComposerProps } from './Composer';
import { DRAFT_KEY } from './draft';
import { getSelectionOffsets, setSelectionOffsets } from './mdEditorDom';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(extra: Partial<ComposerProps> = {}) {
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
  const key = (k: string, init: KeyboardEventInit = {}) => {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    act(() => { ed().dispatchEvent(ev); });
    return ev;
  };
  /** 模拟用户键入：改文本节点后触发 input */
  const type = (text: string) => {
    act(() => {
      ed().textContent = text;
      const sel = window.getSelection()!;
      sel.collapse(ed().firstChild, text.length);
      ed().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const text = () => ed().textContent!.replace(/￼/g, '');
  return { onSend, ref, ed, key, type, text };
}

function unmount() {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});
afterEach(() => {
  unmount();
  vi.useRealTimers();
  localStorage.clear();
  window.getSelection()?.removeAllRanges();
});

describe('Composer Markdown 着色', () => {
  it('输入后套上着色，发送的文本保持原样', () => {
    const m = mount();
    m.type('# 标题 **粗**');
    expect(m.ed().querySelector('.cz-md-b')?.textContent).toBe('粗');
    expect(m.ed().querySelector('.cz-md-mark')).not.toBeNull();
    m.key('Enter');
    expect(m.onSend).toHaveBeenCalledWith('# 标题 **粗**', []);
  });

  it('输入法组合期间不重渲染，compositionend 后再着色，光标不动', () => {
    const m = mount();
    act(() => { m.ed().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    act(() => {
      m.ed().textContent = '**ni**';
      window.getSelection()!.collapse(m.ed().firstChild, 6);
      m.ed().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(m.ed().querySelector('.cz-md-line')).toBeNull();
    expect(m.ed().firstChild?.nodeType).toBe(Node.TEXT_NODE);
    act(() => { m.ed().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); });
    expect(m.ed().querySelector('.cz-md-b')?.textContent).toBe('ni');
    expect(getSelectionOffsets(m.ed())).toEqual({ anchor: 6, focus: 6 });
  });

  it('组合期间 Shift+Enter / Tab 不做列表处理', () => {
    const m = mount();
    m.type('- a');
    act(() => { m.ed().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); });
    expect(m.key('Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(m.key('Tab').defaultPrevented).toBe(false);
  });
});

describe('Composer 列表', () => {
  it('Shift+Enter 在有序列表里续写并序号 +1', () => {
    const m = mount();
    m.type('1. 苹果');
    expect(m.key('Enter', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(m.text()).toBe('1. 苹果\n2. ');
    expect(getSelectionOffsets(m.ed())).toEqual({ anchor: 9, focus: 9 });
    m.key('Enter', { shiftKey: true }); // 空项：退出列表
    expect(m.text()).toBe('1. 苹果\n');
    expect(m.onSend).not.toHaveBeenCalled();
  });

  it('无序列表保持缩进与标记', () => {
    const m = mount();
    m.type('  - a');
    m.key('Enter', { shiftKey: true });
    expect(m.text()).toBe('  - a\n  - ');
  });

  it('非列表行 Shift+Enter 走默认换行（不拦截）', () => {
    const m = mount();
    m.type('普通文字');
    expect(m.key('Enter', { shiftKey: true }).defaultPrevented).toBe(false);
    expect(m.onSend).not.toHaveBeenCalled();
  });

  it('Tab / Shift+Tab 缩进与反缩进列表项，非列表保持默认', () => {
    const m = mount();
    m.type('- a\n- b');
    expect(m.key('Tab').defaultPrevented).toBe(true);
    expect(m.text()).toBe('- a\n  - b');
    expect(getSelectionOffsets(m.ed())).toEqual({ anchor: 9, focus: 9 });
    m.key('Tab', { shiftKey: true });
    expect(m.text()).toBe('- a\n- b');
    m.type('普通');
    expect(m.key('Tab').defaultPrevented).toBe(false);
  });

  it('列表续写后标签仍在，序列化包含 @"路径"', () => {
    const m = mount();
    act(() => m.ref.current!.restoreText('- 看 @"/a/b.ts"', 'replace'));
    expect(m.ed().querySelector('.cz-chip')).not.toBeNull();
    const n = m.ed().textContent!.length;
    act(() => setSelectionOffsets(m.ed(), n));
    m.key('Enter', { shiftKey: true });
    expect(m.ed().querySelectorAll('.cz-chip').length).toBe(1);
    m.type('x'); // 破坏性输入后再发送前先还原一个带标签的内容
    act(() => m.ref.current!.restoreText('- 看 @"/a/b.ts"', 'replace'));
    m.key('Enter');
    expect(m.onSend).toHaveBeenCalledTimes(1);
    expect(m.onSend.mock.calls[0][0]).toContain('/a/b.ts');
  });
});

describe('Composer 删除标签', () => {
  // 着色后标签包在 .cz-md-line 里，不是编辑区的直接子节点
  const withChip = () => {
    const m = mount();
    act(() => m.ref.current!.restoreText('看 @"/a/b.png" 尾', 'replace'));
    const chip = m.ed().querySelector<HTMLElement>('.cz-chip')!;
    expect(chip.parentElement).not.toBe(m.ed());
    return m;
  };

  it('光标在标签后按退格删掉标签', () => {
    const m = withChip();
    const at = '看 '.length;
    act(() => setSelectionOffsets(m.ed(), at + 1));
    expect(m.key('Backspace').defaultPrevented).toBe(true);
    expect(m.ed().querySelector('.cz-chip')).toBeNull();
    expect(getSelectionOffsets(m.ed())).toEqual({ anchor: at, focus: at });
  });

  it('光标在标签前按 Delete 删掉标签；不挨着标签时交给浏览器', () => {
    const m = withChip();
    act(() => setSelectionOffsets(m.ed(), '看 '.length));
    expect(m.key('Delete').defaultPrevented).toBe(true);
    expect(m.ed().querySelector('.cz-chip')).toBeNull();
    act(() => setSelectionOffsets(m.ed(), 1));
    expect(m.key('Backspace').defaultPrevented).toBe(false);
  });

  it('预览浮窗的「移除」删掉标签', () => {
    const m = withChip();
    act(() => { m.ed().querySelector<HTMLElement>('.cz-chip')!.click(); });
    const btn = document.querySelector<HTMLButtonElement>('.cz-preview__remove')!;
    act(() => btn.click());
    expect(m.ed().querySelector('.cz-chip')).toBeNull();
    expect(document.querySelector('.cz-preview')).toBeNull();
  });
});

describe('Composer 草稿', () => {
  it('输入 300ms 后写入 localStorage，期间不写', () => {
    const m = mount();
    m.type('草稿内容');
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    act(() => { vi.advanceTimersByTime(299); });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    act(() => { vi.advanceTimersByTime(2); });
    expect(localStorage.getItem(DRAFT_KEY)).toBe('草稿内容');
  });

  it('连续输入只保存最后的内容（防抖）', () => {
    const m = mount();
    const spy = vi.spyOn(Storage.prototype, 'setItem');
    m.type('a');
    act(() => { vi.advanceTimersByTime(100); });
    m.type('ab');
    act(() => { vi.advanceTimersByTime(100); });
    m.type('abc');
    act(() => { vi.advanceTimersByTime(400); });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DRAFT_KEY)).toBe('abc');
    spy.mockRestore();
  });

  it('挂载时编辑区为空就恢复草稿（标签 + 着色）', () => {
    localStorage.setItem(DRAFT_KEY, '- 看 @"/a/b.ts" **粗**');
    const m = mount();
    expect(m.ed().querySelector('.cz-chip')).not.toBeNull();
    expect(m.ed().querySelector('.cz-md-b')?.textContent).toBe('粗');
    expect(m.ed().dataset.empty).toBe('false');
    expect(m.ref.current!.hasContent()).toBe(true);
  });

  it('草稿里的标签写回时还是 @"路径"', () => {
    localStorage.setItem(DRAFT_KEY, '看 @"/a/b.ts"');
    const m = mount();
    m.type('x');
    unmount();
    expect(localStorage.getItem(DRAFT_KEY)).toBe('看 @"/a/b.ts"'); // 卸载不改写
    const m2 = mount();
    m2.key('Enter');
    expect(m2.onSend.mock.calls[0][0]).toContain('@');
    void m;
  });

  it('发送后清除草稿', () => {
    localStorage.setItem(DRAFT_KEY, '要发送的');
    const m = mount();
    m.key('Enter');
    expect(m.onSend).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull(); // 防抖定时器也被取消，不会把旧内容写回
  });

  it('清空内容后草稿被删除', () => {
    const m = mount();
    m.type('abc');
    act(() => { vi.advanceTimersByTime(400); });
    expect(localStorage.getItem(DRAFT_KEY)).toBe('abc');
    m.type('');
    act(() => { vi.advanceTimersByTime(400); });
    expect(localStorage.getItem(DRAFT_KEY)).toBeNull();
  });

  it('编辑区已有内容（挂载后）不会被草稿覆盖；引用不进草稿', () => {
    const m = mount({ quotes: [{ quote: '被引用的话', reply: '' }] });
    expect(m.text()).toBe('');
    m.type('正文');
    act(() => { vi.advanceTimersByTime(400); });
    expect(localStorage.getItem(DRAFT_KEY)).toBe('正文');
  });

  it('localStorage 不可用时静默降级', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    const m = mount();
    expect(() => {
      m.type('abc');
      act(() => { vi.advanceTimersByTime(400); });
      m.key('Enter');
    }).not.toThrow();
    expect(m.onSend).toHaveBeenCalledTimes(1);
    get.mockRestore();
    set.mockRestore();
  });
});

describe('Composer / 菜单', () => {
  it('有命令或 skill 时输入 / 弹出菜单，按 Enter 选中插入', () => {
    const origScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = vi.fn();
    try {
      const m = mount({ slashCommands: ['compact', 'clear'], skills: ['code-review'] });
      m.type('/');
      const menu = host!.querySelector('[role="listbox"].cz-slash');
      expect(menu).not.toBeNull();
      expect(menu!.querySelectorAll('[role="option"]').length).toBe(3);
      expect(m.key('Enter').defaultPrevented).toBe(true);
      expect(m.onSend).not.toHaveBeenCalled();
      expect(m.text()).toBe('/compact ');
      expect(host!.querySelector('[role="listbox"].cz-slash')).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = origScroll;
    }
  });

  it('命令与 skill 都为空时输入 / 不弹出菜单', () => {
    const m = mount({ slashCommands: [], skills: [] });
    m.type('/');
    expect(host!.querySelector('[role="listbox"].cz-slash')).toBeNull();
  });
});
