// 会话流的滚动导航：平时隐藏；向上滚时顶部居中出现「上一个交付点」，向下滚时底部居中出现「下一个交付点」。
// 交付点 = 每个已结束的一轮里最终答复文字的开头。单击去上 / 下一个，双击直达顶部 / 底部；
// 滚动停止约 1.5 秒后淡出（悬停或键盘聚焦时不淡出）；已在顶 / 底时不出现。
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Icon } from '../icons/Icon';
import { scrollBehavior } from './motion';
import {
  FADE_OUT_MS,
  collectPoints,
  createClickDispatcher,
  navVisible,
  pickTarget,
  type NavDirection,
} from './navPoints';
import './scrollNav.css';

export interface ScrollNavProps {
  scrollRef: RefObject<HTMLElement>;
  /** 滚到底并恢复自动贴底（useStickToBottom 提供） */
  onJumpBottom: (behavior?: ScrollBehavior) => void;
}

const LABEL: Record<NavDirection, { single: string; double: string }> = {
  up: { single: '上一个交付点', double: '双击回到顶部' },
  down: { single: '下一个交付点', double: '双击回到底部' },
};

function scrollToTop(sc: HTMLElement, top: number) {
  const behavior = scrollBehavior();
  if (typeof sc.scrollTo === 'function') sc.scrollTo({ top, behavior });
  else sc.scrollTop = top;
}

export function ScrollNav({ scrollRef, onJumpBottom }: ScrollNavProps) {
  const [shown, setShown] = useState<NavDirection | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hovered = useRef(false);
  const lastTop = useRef(0);
  const jumpRef = useRef(onJumpBottom);
  jumpRef.current = onJumpBottom;

  const armFade = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (hovered.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      setShown(null);
    }, FADE_OUT_MS);
  }, []);

  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    lastTop.current = sc.scrollTop;
    const onScroll = () => {
      const top = sc.scrollTop;
      const delta = top - lastTop.current;
      if (Math.abs(delta) < 1) return;
      lastTop.current = top;
      const next = navVisible(delta < 0 ? 'up' : 'down', top, sc.scrollHeight - sc.clientHeight);
      setShown(next);
      if (next) armFade();
    };
    sc.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      sc.removeEventListener('scroll', onScroll);
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, [scrollRef, armFade]);

  const dispatchers = useMemo(() => {
    const go = (dir: NavDirection, double: boolean) => {
      const sc = scrollRef.current;
      if (!sc) return;
      const behavior = scrollBehavior();
      const max = sc.scrollHeight - sc.clientHeight;
      if (double) {
        if (dir === 'down') jumpRef.current(behavior);
        else scrollToTop(sc, 0);
        return;
      }
      const { top, edge } = pickTarget(collectPoints(sc), sc.scrollTop, max, dir);
      if (edge && dir === 'down') jumpRef.current(behavior);
      else scrollToTop(sc, top);
    };
    return {
      up: createClickDispatcher({ onSingle: () => go('up', false), onDouble: () => go('up', true) }),
      down: createClickDispatcher({ onSingle: () => go('down', false), onDouble: () => go('down', true) }),
    };
  }, [scrollRef]);
  useEffect(
    () => () => {
      dispatchers.up.cancel();
      dispatchers.down.cancel();
    },
    [dispatchers],
  );

  const onEnter = () => {
    hovered.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const onLeave = () => {
    hovered.current = false;
    armFade();
  };

  const button = (dir: NavDirection) => {
    const visible = shown === dir;
    return (
      <button
        type="button"
        className={`cz-flow__nav cz-flow__nav--${dir === 'up' ? 'top' : 'bottom'}${visible ? ' is-visible' : ''}`}
        aria-label={`${LABEL[dir].single}（${LABEL[dir].double}）`}
        title={`${LABEL[dir].single}，${LABEL[dir].double}`}
        tabIndex={visible ? 0 : -1}
        aria-hidden={visible ? undefined : true}
        onClick={() => dispatchers[dir].click()}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onFocus={onEnter}
        onBlur={onLeave}
      >
        <Icon name={dir === 'up' ? 'arrow-up' : 'arrow-down'} size={16} />
      </button>
    );
  };

  return (
    <>
      {button('up')}
      {button('down')}
    </>
  );
}
