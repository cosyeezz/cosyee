// 滚动导航按钮用到的纯逻辑（无 React 依赖，便于单测）：交付点的选取、单击 / 双击区分。

/** 单击要等多久才确认不是双击（ms） */
export const DOUBLE_CLICK_MS = 250;
/** 滚动停止后多久淡出按钮（ms） */
export const FADE_OUT_MS = 1500;
/** 距顶 / 底多近算「已在顶 / 底」（px） */
export const EDGE_SLACK = 8;
/** 交付点与视口顶部之间留的空隙（px） */
export const POINT_MARGIN = 16;
/** 判断「已经在这个交付点上」的容差（px）：落在容差内的点不算上一个 / 下一个 */
const POINT_SLACK = 4;

export type NavDirection = 'up' | 'down';

/**
 * 在交付点（scrollTop 坐标，升序）里选出离当前视口最近的上一个 / 下一个。
 * 向上：严格在当前位置之上的最后一个，没有则回到顶部（0）。
 * 向下：严格在当前位置之下的第一个，没有（或它已不超过可滚动的最大值）则到底部（maxTop）。
 * 返回 { top, edge }：edge 表示目标是顶部 / 底部本身，调用方据此决定是否恢复贴底。
 */
export function pickTarget(
  points: number[],
  scrollTop: number,
  maxTop: number,
  dir: NavDirection,
): { top: number; edge: boolean } {
  if (dir === 'up') {
    let best: number | null = null;
    for (const p of points) {
      if (p < scrollTop - POINT_SLACK && (best === null || p > best)) best = p;
    }
    return best === null || best <= 0 ? { top: 0, edge: true } : { top: best, edge: false };
  }
  let best: number | null = null;
  for (const p of points) {
    if (p > scrollTop + POINT_SLACK && (best === null || p < best)) best = p;
  }
  return best === null || best >= maxTop - EDGE_SLACK ? { top: maxTop, edge: true } : { top: best, edge: false };
}

/** 按钮是否应该出现：向上滚时显示「上」，向下滚时显示「下」；已在顶 / 底时不显示 */
export function navVisible(dir: NavDirection | null, scrollTop: number, maxTop: number): NavDirection | null {
  if (dir === 'up') return scrollTop <= EDGE_SLACK ? null : 'up';
  if (dir === 'down') return maxTop - scrollTop <= EDGE_SLACK ? null : 'down';
  return null;
}

/**
 * 交付点：每个已结束的一轮里「最终答复文字」的开头位置（相对滚动容器内容顶部的 y，减去留白）。
 * 结束的一轮 = 根节点类名不含 is-understanding / is-running；答复节点即 .cz-flow__answer。
 * 若该轮展开着，吸顶的状态行会盖住答复开头，再多让出它的高度。
 */
export function collectPoints(scroller: HTMLElement): number[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const out: number[] = [];
  scroller.querySelectorAll<HTMLElement>('.cz-flow__turn').forEach((turn) => {
    if (turn.classList.contains('is-understanding') || turn.classList.contains('is-running')) return;
    const answer = turn.querySelector<HTMLElement>('.cz-flow__answer');
    if (!answer) return;
    const sticky = turn.querySelector<HTMLElement>('.cz-flow__status.is-open');
    const offset = POINT_MARGIN + (sticky ? sticky.getBoundingClientRect().height : 0);
    out.push(Math.max(0, Math.round(answer.getBoundingClientRect().top - base - offset)));
  });
  return out.sort((a, b) => a - b);
}

export interface ClickDispatcher {
  click: () => void;
  /** 丢弃还没触发的单击（卸载时调用） */
  cancel: () => void;
}

/**
 * 单击 / 双击分发：第一次点击先等 delay；期间再点一次 = 双击（只触发 onDouble）；
 * 超时没有第二次点击 = 单击（触发 onSingle）。
 */
export function createClickDispatcher(opts: {
  onSingle: () => void;
  onDouble: () => void;
  delay?: number;
}): ClickDispatcher {
  const delay = opts.delay ?? DOUBLE_CLICK_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    click() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
        opts.onDouble();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        opts.onSingle();
      }, delay);
    },
    cancel() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
