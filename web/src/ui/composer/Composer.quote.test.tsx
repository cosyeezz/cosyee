// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Composer, type ComposerHandle, type ComposerProps } from './Composer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 只有引用、回复为空的若干段 */
const qs = (...list: string[]) => list.map((quote) => ({ quote, reply: '' }));

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(extra: Partial<ComposerProps>) {
  const onSend = vi.fn();
  const onRemoveQuote = vi.fn();
  const onClearQuotes = vi.fn();
  const onEditQuoteReply = vi.fn();
  const ref = createRef<ComposerHandle>();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const props: ComposerProps = {
    onSend, onInterrupt: () => {}, running: false,
    pick: async () => ({ items: [], supportsMixed: false }), supportsMixed: false,
    previewInfo: async () => { throw new Error('unused'); }, previewRawUrl: () => '',
    slashCommands: [], skills: [], config: { model: 'sonnet', effort: 'medium' }, onConfigChange: () => {},
    onRemoveQuote, onClearQuotes, onEditQuoteReply, ...extra,
  };
  act(() => root!.render(<Composer ref={ref} {...props} />));
  const send = () => host!.querySelector<HTMLButtonElement>('.cz-composer__btn--send')!; // 空内容时按钮不存在（null）
  const chips = () => [...host!.querySelectorAll<HTMLElement>('.cz-composer__quote')];
  return { onSend, onRemoveQuote, onClearQuotes, onEditQuoteReply, ref, send, chips, host: host! };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('Composer 引用', () => {
  it('有引用时显示引用卡片，正文为空也能发送，并清除引用', () => {
    const m = mount({ quotes: qs('第一行\n第二行') });
    expect(m.host.querySelector('.cz-composer__quote-text')?.textContent).toBe('第一行\n第二行');
    expect(m.send().disabled).toBe(false);
    act(() => m.send().click());
    expect(m.onSend).toHaveBeenCalledWith('> 第一行\n> 第二行', []);
    expect(m.onClearQuotes).toHaveBeenCalledTimes(1);
  });

  it('appendText 填入编辑区，发送时引用块在前、正文在后', () => {
    const m = mount({ quotes: qs('引用') });
    act(() => m.ref.current!.appendText('我的回复'));
    const ed = m.host.querySelector('.cz-composer__editor')!;
    expect(ed.textContent).toBe('我的回复');
    act(() => m.send().click());
    expect(m.onSend).toHaveBeenCalledWith('> 引用\n\n我的回复', []);
  });

  it('没有引用且没有内容时不显示发送按钮；点 ✕ 移除对应引用', () => {
    const none = mount({});
    expect(none.send()).toBeNull();
    expect(none.chips()).toHaveLength(0);
    act(() => root?.unmount());
    host?.remove();
    const m = mount({ quotes: qs('x') });
    act(() => m.host.querySelector<HTMLButtonElement>('.cz-composer__quote-x')!.click());
    expect(m.onRemoveQuote).toHaveBeenCalledWith(0);
    expect(m.onClearQuotes).not.toHaveBeenCalled();
  });
});

describe('Composer 多段引用', () => {
  it('每段引用一张卡片，按顺序竖向排列', () => {
    const m = mount({ quotes: qs('甲', '乙', '丙') });
    expect(m.chips().map((c) => c.querySelector('.cz-composer__quote-text')?.textContent)).toEqual(['甲', '乙', '丙']);
  });

  it('点某张卡片的 ✕ 只移除这一段（回传对应下标）', () => {
    const m = mount({ quotes: qs('甲', '乙', '丙') });
    act(() => m.chips()[1].querySelector<HTMLButtonElement>('.cz-composer__quote-x')!.click());
    expect(m.onRemoveQuote).toHaveBeenCalledTimes(1);
    expect(m.onRemoveQuote).toHaveBeenCalledWith(1);
    expect(m.onClearQuotes).not.toHaveBeenCalled();
  });

  it('父组件据此更新 quotes 后，卡片随之减少，剩下的仍可发送', () => {
    const m = mount({ quotes: qs('甲', '乙', '丙') });
    act(() => root!.render(<Composer ref={m.ref} {...baseProps(m)} quotes={qs('甲', '丙')} />));
    expect(m.chips()).toHaveLength(2);
    act(() => m.send().click());
    expect(m.onSend).toHaveBeenCalledWith('> 甲\n\n> 丙', []);
  });

  it('发送时全部引用都带上（各自成块），正文在后，然后一次性清除', () => {
    const m = mount({ quotes: qs('甲', '乙\n乙2') });
    act(() => m.ref.current!.appendText('我的回复'));
    act(() => m.send().click());
    expect(m.onSend).toHaveBeenCalledWith('> 甲\n\n> 乙\n> 乙2\n\n我的回复', []);
    expect(m.onClearQuotes).toHaveBeenCalledTimes(1);
  });

  it('多段引用且正文为空也能发送', () => {
    const m = mount({ quotes: qs('甲', '乙') });
    expect(m.send().disabled).toBe(false);
    act(() => m.send().click());
    expect(m.onSend).toHaveBeenCalledWith('> 甲\n\n> 乙', []);
  });

  it('空白引用不显示卡片，也不算有引用', () => {
    const m = mount({ quotes: qs('  ', '甲', '\n') });
    expect(m.chips()).toHaveLength(1);
    act(() => m.chips()[0].querySelector<HTMLButtonElement>('.cz-composer__quote-x')!.click());
    expect(m.onRemoveQuote).toHaveBeenCalledWith(1); // 下标仍对应原数组
    const blank = mount({ quotes: qs('  ') });
    expect(blank.send()).toBeNull();
  });
});

describe('Composer 每段引用带回复', () => {
  const two = [{ quote: '用哪台设备？', reply: '三者都有' }, { quote: '要不要配置？', reply: '最好不配置' }];

  it('回复显示在各自引用的同一行，互不粘连', () => {
    const m = mount({ quotes: two });
    expect(m.chips().map((c) => c.querySelector<HTMLTextAreaElement>('.cz-composer__quote-reply')!.value)).toEqual(['三者都有', '最好不配置']);
    expect(m.host.querySelector('.cz-composer__editor')!.textContent).toBe('');
  });

  it('发送时引用与回复交错，正文在最后', () => {
    const m = mount({ quotes: two });
    act(() => m.ref.current!.appendText('另外一件事'));
    act(() => m.send().click());
    expect(m.onSend).toHaveBeenCalledWith('> 用哪台设备？\n\n三者都有\n\n> 要不要配置？\n\n最好不配置\n\n另外一件事', []);
  });

  it('编辑某段回复回传对应下标；在回复里按 Enter 发送整条消息', () => {
    const m = mount({ quotes: two });
    const ta = m.chips()[1].querySelector<HTMLTextAreaElement>('.cz-composer__quote-reply')!;
    act(() => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(ta, '改了');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(m.onEditQuoteReply).toHaveBeenCalledWith(1, '改了');
    act(() => { ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(m.onSend).toHaveBeenCalledTimes(1);
    expect(m.onClearQuotes).toHaveBeenCalledTimes(1);
  });
});

/** 重新渲染时沿用 mount 的其余 props */
function baseProps(m: ReturnType<typeof mount>): ComposerProps {
  return {
    onSend: m.onSend, onInterrupt: () => {}, running: false,
    pick: async () => ({ items: [], supportsMixed: false }), supportsMixed: false,
    previewInfo: async () => { throw new Error('unused'); }, previewRawUrl: () => '',
    slashCommands: [], skills: [], config: { model: 'sonnet', effort: 'medium' }, onConfigChange: () => {},
    onRemoveQuote: m.onRemoveQuote, onClearQuotes: m.onClearQuotes, onEditQuoteReply: m.onEditQuoteReply,
  };
}
