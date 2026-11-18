// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOUBLE_CLICK_MS,
  POINT_MARGIN,
  collectPoints,
  createClickDispatcher,
  navVisible,
  pickTarget,
} from './navPoints';

describe('pickTarget', () => {
  const pts = [100, 400, 900];
  it('向上：取严格在当前位置之上、最近的交付点', () => {
    expect(pickTarget(pts, 500, 2000, 'up')).toEqual({ top: 400, edge: false });
    expect(pickTarget(pts, 1000, 2000, 'up')).toEqual({ top: 900, edge: false });
  });
  it('向上：已经停在某个交付点上（容差内）则去再上一个', () => {
    expect(pickTarget(pts, 402, 2000, 'up')).toEqual({ top: 100, edge: false });
  });
  it('向上：没有更靠上的交付点则回到顶部（edge）', () => {
    expect(pickTarget(pts, 100, 2000, 'up')).toEqual({ top: 0, edge: true });
    expect(pickTarget([], 500, 2000, 'up')).toEqual({ top: 0, edge: true });
    // 交付点就在最顶部：等价于回到顶部
    expect(pickTarget([0], 500, 2000, 'up')).toEqual({ top: 0, edge: true });
  });
  it('向下：取严格在当前位置之下、最近的交付点', () => {
    expect(pickTarget(pts, 0, 2000, 'down')).toEqual({ top: 100, edge: false });
    expect(pickTarget(pts, 100, 2000, 'down')).toEqual({ top: 400, edge: false });
    expect(pickTarget(pts, 398, 2000, 'down')).toEqual({ top: 900, edge: false });
  });
  it('向下：没有更靠下的交付点，或交付点已超过可滚动范围，则到底部（edge）', () => {
    expect(pickTarget(pts, 900, 2000, 'down')).toEqual({ top: 2000, edge: true });
    expect(pickTarget([], 0, 2000, 'down')).toEqual({ top: 2000, edge: true });
    expect(pickTarget([1998], 0, 2000, 'down')).toEqual({ top: 2000, edge: true });
  });
});

describe('navVisible', () => {
  it('向上滚显示「上」，向下滚显示「下」，没有滚动方向则不显示', () => {
    expect(navVisible('up', 500, 2000)).toBe('up');
    expect(navVisible('down', 500, 2000)).toBe('down');
    expect(navVisible(null, 500, 2000)).toBeNull();
  });
  it('已在顶部 / 底部时不显示', () => {
    expect(navVisible('up', 0, 2000)).toBeNull();
    expect(navVisible('up', 8, 2000)).toBeNull();
    expect(navVisible('down', 2000, 2000)).toBeNull();
    expect(navVisible('down', 1995, 2000)).toBeNull();
    expect(navVisible('down', 1900, 2000)).toBe('down');
  });
});

describe('createClickDispatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function make() {
    const onSingle = vi.fn();
    const onDouble = vi.fn();
    return { onSingle, onDouble, d: createClickDispatcher({ onSingle, onDouble }) };
  }

  it('单击：等满 250ms 没有第二次点击才触发单击', () => {
    const { onSingle, onDouble, d } = make();
    d.click();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS - 1);
    expect(onSingle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onSingle).toHaveBeenCalledTimes(1);
    expect(onDouble).not.toHaveBeenCalled();
  });
  it('双击：窗口内第二次点击只触发双击，不再触发单击', () => {
    const { onSingle, onDouble, d } = make();
    d.click();
    vi.advanceTimersByTime(100);
    d.click();
    expect(onDouble).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(onSingle).not.toHaveBeenCalled();
    expect(onDouble).toHaveBeenCalledTimes(1);
  });
  it('间隔超过窗口的两次点击是两次单击', () => {
    const { onSingle, onDouble, d } = make();
    d.click();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS + 10);
    d.click();
    vi.advanceTimersByTime(DOUBLE_CLICK_MS + 10);
    expect(onSingle).toHaveBeenCalledTimes(2);
    expect(onDouble).not.toHaveBeenCalled();
  });
  it('cancel 丢弃尚未触发的单击', () => {
    const { onSingle, d } = make();
    d.click();
    d.cancel();
    vi.advanceTimersByTime(1000);
    expect(onSingle).not.toHaveBeenCalled();
  });
});

describe('collectPoints', () => {
  const rectOf = (top: number, height = 20) =>
    (() => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) })) as () => DOMRect;

  /** 构造滚动容器：每个回合的答复在内容坐标 y 处；容器视口顶在屏幕 100，当前 scrollTop = st */
  function build(st: number, turns: { cls: string; answerY?: number; stickyH?: number }[]) {
    const sc = document.createElement('div');
    Object.defineProperty(sc, 'scrollTop', { value: st, configurable: true });
    sc.getBoundingClientRect = rectOf(100);
    for (const t of turns) {
      const el = document.createElement('div');
      el.className = `cz-flow__turn ${t.cls}`;
      if (t.stickyH != null) {
        const s = document.createElement('button');
        s.className = 'cz-flow__status is-open';
        s.getBoundingClientRect = rectOf(0, t.stickyH);
        el.appendChild(s);
      }
      if (t.answerY != null) {
        const a = document.createElement('div');
        a.className = 'cz-flow__answer';
        a.getBoundingClientRect = rectOf(100 - st + t.answerY);
        el.appendChild(a);
      }
      sc.appendChild(el);
    }
    return sc;
  }

  it('取每个已结束回合的答复开头（扣掉留白），升序排列', () => {
    const sc = build(250, [
      { cls: 'is-done', answerY: 900 },
      { cls: 'is-interrupted', answerY: 300 },
    ]);
    expect(collectPoints(sc)).toEqual([300 - POINT_MARGIN, 900 - POINT_MARGIN]);
  });
  it('跳过进行中的回合与没有答复的回合', () => {
    const sc = build(0, [
      { cls: 'is-running', answerY: 100 },
      { cls: 'is-understanding', answerY: 200 },
      { cls: 'is-done' },
      { cls: 'is-error', answerY: 700 },
    ]);
    expect(collectPoints(sc)).toEqual([700 - POINT_MARGIN]);
  });
  it('该回合展开着：再让出吸顶状态行的高度；结果不会小于 0', () => {
    const sc = build(0, [
      { cls: 'is-done', answerY: 500, stickyH: 40 },
      { cls: 'is-done', answerY: 5 },
    ]);
    expect(collectPoints(sc)).toEqual([0, 500 - POINT_MARGIN - 40]);
  });
});
