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
  const onClearQuote = vi.fn();
  const ref = createRef<ComposerHandle>();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const props: ComposerProps = {
    onSend, onInterrupt: () => {}, running: false,
    pick: async () => ({ items: [], supportsMixed: false }), supportsMixed: false,
    previewInfo: async () => { throw new Error('unused'); }, previewRawUrl: () => '',
    slashCommands: [], skills: [], config: { model: 'sonnet', effort: 'medium' }, onConfigChange: () => {},
    onClearQuote, ...extra,
  };
  act(() => root!.render(<Composer ref={ref} {...props} />));
  const send = () => host!.querySelector<HTMLButtonElement>('.cz-composer__btn--send')!; // 空内容时按钮不存在（null）
  return { onSend, onClearQuote, ref, send, host: host! };
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('Composer 引用', () => {
  it('有引用时显示引用卡片，正文为空也能发送，并清除引用', () => {
    const m = mount({ quote: '第一行\n第二行' });
    expect(m.host.querySelector('.cz-composer__quote-text')?.textContent).toBe('“第一行\n第二行”');
    expect(m.send().disabled).toBe(false);
    act(() => m.send().click());
    expect(m.onSend).toHaveBeenCalledWith('> 第一行\n> 第二行', []);
    expect(m.onClearQuote).toHaveBeenCalledTimes(1);
  });

  it('appendText 填入编辑区，发送时引用块在前、正文在后', () => {
    const m = mount({ quote: '引用' });
    act(() => m.ref.current!.appendText('我的回复'));
    const ed = m.host.querySelector('.cz-composer__editor')!;
    expect(ed.textContent).toBe('我的回复');
    act(() => m.send().click());
    expect(m.onSend).toHaveBeenCalledWith('> 引用\n\n我的回复', []);
  });

  it('没有引用且没有内容时不显示发送按钮；点 ✕ 调用 onClearQuote', () => {
    const none = mount({});
    expect(none.send()).toBeNull();
    act(() => root?.unmount());
    host?.remove();
    const m = mount({ quote: 'x' });
    act(() => m.host.querySelector<HTMLButtonElement>('.cz-composer__quote-x')!.click());
    expect(m.onClearQuote).toHaveBeenCalledTimes(1);
  });
});
