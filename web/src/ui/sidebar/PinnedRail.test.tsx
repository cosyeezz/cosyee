// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionSummary } from '@cosyee/shared';
import { PinnedRail, type PinnedRailProps } from './PinnedRail';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const pin = (id: string, title: string, dot: SessionSummary['dot'] = null): SessionSummary =>
  ({ id, cwd: '/w', title, lastActiveAt: 0, dot, pinned: 'manual' });

function render(p: Partial<PinnedRailProps>) {
  const props: PinnedRailProps = {
    open: true,
    pinned: [pin('a', '修登录', 'running'), pin('b', '', 'unread'), pin('c', '重构')],
    workspaces: [],
    currentSessionId: 'c',
    onSelectSession: () => {},
    ...p,
  };
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  act(() => root!.render(<PinnedRail {...props} />));
  return host;
}

describe('PinnedRail', () => {
  it('列出置顶会话的状态和标题，只有切换按钮', () => {
    const el = render({});
    const btns = [...el.querySelectorAll('.cz-prail__btn')];
    expect(btns.map((b) => b.querySelector('.cz-prail__title')!.textContent)).toEqual(['修登录', '新会话', '重构']);
    expect(btns[0].querySelector('.cz-prail__dot--running')).not.toBeNull();
    expect(btns[1].querySelector('.cz-prail__dot--unread')).not.toBeNull();
    expect(btns[2].querySelector('.cz-prail__dot')).toBeNull();
    expect(btns[2].getAttribute('aria-current')).toBe('true');
    // 每行只有一个按钮：没有置顶 / 删除
    expect(el.querySelectorAll('button')).toHaveLength(3);
  });

  it('点击切换会话', () => {
    const onSelectSession = vi.fn();
    const el = render({ onSelectSession });
    act(() => { (el.querySelectorAll('.cz-prail__btn')[0] as HTMLElement).click(); });
    expect(onSelectSession).toHaveBeenCalledWith('a');
  });

  it('侧栏展开或没有置顶时不显示', () => {
    expect(render({ open: false }).querySelector('.cz-prail')).toBeNull();
    expect(render({ open: true, pinned: [] }).querySelector('.cz-prail')).toBeNull();
    expect(render({ open: true }).querySelector('.cz-prail')).not.toBeNull();
  });
});
