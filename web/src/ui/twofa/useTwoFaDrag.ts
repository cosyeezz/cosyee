// 2FA 列表拖动：指针事件（鼠标直接拖，触屏长按约 300ms 拾起）、浮动副本跟随指针、
// 命中检测（同区排序 / 拖入分组 / 拖到面包屑）、边缘自动滚动、Esc 取消。
// 命中检测只用 offsetTop/offsetHeight（不受 FLIP 动画中 transform 影响），避免排序抖动。
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';

export type DragKind = 'entry' | 'group';

export interface DragState {
  kind: DragKind;
  id: string;
  /** 被拖项所在分区：pinned / groups / entries */
  section: string;
  /** 分区内的虚拟顺序（含被拖项在当前插入位置） */
  order: string[];
  /** 当前高亮的「拖入」目标分组 */
  intoGroupId: string | null;
  /** 当前高亮的面包屑目标（null = 根，undefined = 无） */
  crumbId: string | null | undefined;
  /** 已松手、副本正在落位动画中 */
  dropping: boolean;
}

export type DragResult =
  | { type: 'reorder'; kind: DragKind; id: string; section: string; order: string[] }
  | { type: 'into'; kind: DragKind; id: string; groupId: string }
  | { type: 'crumb'; kind: DragKind; id: string; groupId: string | null };

export interface UseTwoFaDragOptions {
  enabled: boolean;
  panelRef: RefObject<HTMLElement>;
  bodyRef: RefObject<HTMLElement>;
  canDropInto: (kind: DragKind, id: string, groupId: string | null) => boolean;
  onCommit: (r: DragResult) => void;
  /** 触屏长按拾起后未移动就松手：当作长按菜单 */
  onTapHold?: (kind: DragKind, id: string, x: number, y: number) => void;
}

const LONG_PRESS_MS = 300;
const MOUSE_THRESHOLD = 5;
const TOUCH_CANCEL = 8;
const EDGE = 52;
const MAX_SCROLL = 16;

/** 行在其分区内的布局矩形（client 坐标，不含 transform） */
function layoutRect(el: HTMLElement) {
  const parent = el.parentElement as HTMLElement;
  const pr = parent.getBoundingClientRect();
  const top = pr.top + parent.clientTop + el.offsetTop;
  return { top, height: el.offsetHeight, left: pr.left, right: pr.right };
}

function sameOrder(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function useTwoFaDrag({ enabled, panelRef, bodyRef, canDropInto, onCommit, onTapHold }: UseTwoFaDragOptions) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const suppressClick = useRef(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const optsRef = useRef({ enabled, canDropInto, onCommit, onTapHold });
  optsRef.current = { enabled, canDropInto, onCommit, onTapHold };

  const setBoth = (next: DragState | null) => {
    dragRef.current = next;
    setDrag(next);
  };

  // 卸载时清理
  useEffect(() => () => cleanupRef.current?.(), []);
  // 被禁用（开始搜索等）时中止
  useEffect(() => {
    if (!enabled) cleanupRef.current?.();
  }, [enabled]);

  const begin = useCallback(
    (kind: DragKind, id: string, section: string, ev: ReactPointerEvent<HTMLElement>) => {
      if (!optsRef.current.enabled || ev.button !== 0) return;
      if ((ev.target as HTMLElement).closest('button, a, input')) return;
      const rowEl = ev.currentTarget;
      const isTouch = ev.pointerType === 'touch';
      const pid = ev.pointerId;
      const startX = ev.clientX;
      const startY = ev.clientY;
      let px = startX;
      let py = startY;
      let picked = false;
      let timer = 0;
      let raf = 0;
      let scrollRaf = 0;
      let clone: HTMLElement | null = null;
      let grabX = 0;
      let grabY = 0;
      let travel = 0;
      cleanupRef.current?.();

      const panel = () => panelRef.current;

      const sectionEl = () =>
        panel()?.querySelector<HTMLElement>(`[data-drag-section-el="${section}"]`) ?? null;

      const baseOrder = () => {
        const sec = sectionEl();
        if (!sec) return [id];
        return Array.from(sec.querySelectorAll<HTMLElement>(':scope > [data-drag-id]')).map((e) => e.dataset.dragId!);
      };

      const hitTest = () => {
        const cur = dragRef.current;
        const p = panel();
        if (!cur || !p || cur.dropping) return;
        const { canDropInto: canDrop } = optsRef.current;
        let intoGroupId: string | null = null;
        let crumbId: string | null | undefined;
        let order = cur.order;

        // 1) 面包屑
        for (const c of Array.from(p.querySelectorAll<HTMLElement>('[data-crumb]'))) {
          const r = c.getBoundingClientRect();
          if (px >= r.left - 4 && px <= r.right + 4 && py >= r.top - 4 && py <= r.bottom + 4) {
            const gid = c.dataset.crumb === '' ? null : c.dataset.crumb!;
            if (canDrop(kind, id, gid)) crumbId = gid;
            break;
          }
        }

        // 2) 分组行
        if (crumbId === undefined) {
          for (const g of Array.from(p.querySelectorAll<HTMLElement>('[data-drop-group]'))) {
            const gid = g.dataset.dropGroup!;
            if (kind === 'group' && gid === id) continue;
            const lr = layoutRect(g);
            if (px < lr.left || px > lr.right) continue;
            const pad = kind === 'group' ? lr.height * 0.25 : 0;
            if (py >= lr.top + pad && py <= lr.top + lr.height - pad) {
              if (canDrop(kind, id, gid)) intoGroupId = gid;
              break;
            }
          }
        }

        // 3) 同区排序（拖入/拖到面包屑时保持原顺序）
        if (crumbId === undefined && intoGroupId === null) {
          const sec = sectionEl();
          if (sec) {
            const others = Array.from(sec.querySelectorAll<HTMLElement>(':scope > [data-drag-id]')).filter(
              (e) => e.dataset.dragId !== id,
            );
            let idx = 0;
            for (const o of others) {
              const lr = layoutRect(o);
              if (lr.top + lr.height / 2 < py) idx++;
            }
            const ids = others.map((e) => e.dataset.dragId!);
            ids.splice(idx, 0, id);
            order = ids;
          }
        }

        if (
          sameOrder(order, cur.order) &&
          intoGroupId === cur.intoGroupId &&
          crumbId === cur.crumbId
        ) {
          return;
        }
        setBoth({ ...cur, order, intoGroupId, crumbId });
      };

      const placeClone = () => {
        raf = 0;
        const p = panel();
        if (!clone || !p) return;
        const pr = p.getBoundingClientRect();
        const tx = px - pr.left - grabX;
        const ty = py - pr.top - grabY;
        hitTest();
        // 悬在分组 / 面包屑上时缩小，露出下面目标的高亮（缩放放进 transform 内，避免和位移相乘）
        const cur = dragRef.current;
        const into = !!cur && (cur.intoGroupId !== null || cur.crumbId !== undefined);
        clone.style.transformOrigin = `${grabX}px ${grabY}px`;
        clone.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${into ? 0.7 : 1.02})`;
      };

      const autoScroll = () => {
        scrollRaf = 0;
        const body = bodyRef.current;
        if (!body || !dragRef.current || dragRef.current.dropping) return;
        const r = body.getBoundingClientRect();
        let v = 0;
        if (py < r.top + EDGE) v = -Math.min(1, (r.top + EDGE - py) / EDGE) * MAX_SCROLL;
        else if (py > r.bottom - EDGE) v = Math.min(1, (py - (r.bottom - EDGE)) / EDGE) * MAX_SCROLL;
        if (v !== 0) {
          const before = body.scrollTop;
          body.scrollTop += v;
          if (body.scrollTop !== before) hitTest();
        }
        scrollRaf = requestAnimationFrame(autoScroll);
      };

      const pickUp = () => {
        const p = panel();
        if (!p || picked) return;
        picked = true;
        const rr = rowEl.getBoundingClientRect();
        const pr = p.getBoundingClientRect();
        grabX = startX - rr.left;
        grabY = startY - rr.top;
        clone = rowEl.cloneNode(true) as HTMLElement;
        clone.removeAttribute('data-row-key');
        clone.removeAttribute('data-drag-id');
        clone.removeAttribute('data-drop-group');
        clone.classList.add('cz-2fa-dragclone');
        clone.style.width = `${rr.width}px`;
        const bx = rr.left - pr.left;
        const by = rr.top - pr.top;
        clone.style.transform = `translate3d(${bx}px, ${by}px, 0) scale(1.02)`;
        p.appendChild(clone);
        // 拾起：从原位置轻微抬起
        clone.animate(
          [
            { transform: `translate3d(${bx}px, ${by}px, 0) scale(1)` },
            { transform: `translate3d(${bx}px, ${by}px, 0) scale(1.02)` },
          ],
          { duration: 140, easing: 'cubic-bezier(.16, 1, .3, 1)' },
        );
        suppressClick.current = true;
        p.classList.add('is-dragging');
        setBoth({
          kind,
          id,
          section,
          order: baseOrder(),
          intoGroupId: null,
          crumbId: undefined,
          dropping: false,
        });
        scrollRaf = requestAnimationFrame(autoScroll);
        if (isTouch && navigator.vibrate) navigator.vibrate(8);
      };

      const teardown = () => {
        window.clearTimeout(timer);
        cancelAnimationFrame(raf);
        cancelAnimationFrame(scrollRaf);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('keydown', onKey, true);
        document.removeEventListener('touchmove', onTouchMove);
        panel()?.classList.remove('is-dragging');
        cleanupRef.current = null;
      };

      const finish = () => {
        clone?.remove();
        clone = null;
        setBoth(null);
        // 吞掉拖动结束后紧随的 click
        window.setTimeout(() => {
          suppressClick.current = false;
        }, 0);
      };

      const abort = () => {
        const wasPicked = picked;
        teardown();
        if (wasPicked) {
          if (clone) {
            const c = clone;
            const a = c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'forwards' });
            a.onfinish = () => c.remove();
            clone = null;
          }
          setBoth(null);
          window.setTimeout(() => {
            suppressClick.current = false;
          }, 0);
        }
      };

      const onTouchMove = (e: TouchEvent) => {
        if (picked && e.cancelable) e.preventDefault();
      };

      function onMove(e: PointerEvent) {
        if (e.pointerId !== pid) return;
        px = e.clientX;
        py = e.clientY;
        travel = Math.max(travel, Math.hypot(px - startX, py - startY));
        if (!picked) {
          if (isTouch) {
            if (travel > TOUCH_CANCEL) abort();
          } else if (travel > MOUSE_THRESHOLD) {
            pickUp();
          }
          return;
        }
        if (!raf) raf = requestAnimationFrame(placeClone);
      }

      function onUp(e: PointerEvent) {
        if (e.pointerId !== pid) return;
        if (!picked) {
          teardown();
          return;
        }
        const cur = dragRef.current;
        const p = panel();
        teardown();
        if (!cur || !p || !clone) {
          finish();
          return;
        }
        if (isTouch && travel <= TOUCH_CANCEL) {
          // 长按未移动：当作长按菜单
          optsRef.current.onTapHold?.(kind, id, e.clientX, e.clientY);
          abort();
          return;
        }
        // 提交并让副本落位
        let result: DragResult | null = null;
        if (cur.intoGroupId) result = { type: 'into', kind, id, groupId: cur.intoGroupId };
        else if (cur.crumbId !== undefined) result = { type: 'crumb', kind, id, groupId: cur.crumbId };
        else if (!sameOrder(cur.order, baseOriginal)) {
          result = { type: 'reorder', kind, id, section, order: cur.order };
        }
        setBoth({ ...cur, dropping: true });
        const c = clone;
        const pr = p.getBoundingClientRect();
        let target: DOMRect | null = null;
        let intoTarget = false;
        if (cur.intoGroupId || cur.crumbId !== undefined) {
          const sel = cur.intoGroupId
            ? `[data-drop-group="${CSS.escape(cur.intoGroupId)}"]`
            : `[data-crumb="${cur.crumbId ?? ''}"]`;
          target = p.querySelector<HTMLElement>(sel)?.getBoundingClientRect() ?? null;
          intoTarget = true;
        } else {
          target = p.querySelector<HTMLElement>('[data-drag-ghost]')?.getBoundingClientRect() ?? null;
        }
        const from = c.style.transform;
        const finalT = target
          ? intoTarget
            ? `translate3d(${target.left - pr.left + 24}px, ${target.top - pr.top + target.height / 2 - 14}px, 0) scale(.5)`
            : `translate3d(${target.left - pr.left}px, ${target.top - pr.top}px, 0) scale(1)`
          : from;
        const anim = c.animate(
          [
            { transform: from },
            { transform: finalT, opacity: intoTarget ? 0 : 1 },
          ],
          { duration: intoTarget ? 200 : 180, easing: 'cubic-bezier(.16, 1, .3, 1)', fill: 'forwards' },
        );
        // 副本的 left/top 已作为基准，transform 以面板为参照，需要抵消基准
        if (result) optsRef.current.onCommit(result);
        const done = () => finish();
        anim.onfinish = done;
        anim.oncancel = done;
      }

      function onCancel(e: PointerEvent) {
        if (e.pointerId !== pid) return;
        abort();
      }

      function onKey(e: KeyboardEvent) {
        if (e.key === 'Escape' && picked) {
          e.preventDefault();
          e.stopPropagation();
          abort();
        }
      }

      const baseOriginal = baseOrder();

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onCancel);
      window.addEventListener('keydown', onKey, true);
      if (isTouch) {
        document.addEventListener('touchmove', onTouchMove, { passive: false });
        timer = window.setTimeout(pickUp, LONG_PRESS_MS);
      }
      cleanupRef.current = () => {
        if (picked) {
          clone?.remove();
          clone = null;
          setBoth(null);
        }
        teardown();
      };
    },
    [panelRef, bodyRef],
  );

  /** 行上挂载：pointerdown 起手；拖动后吞掉 click */
  const rowHandlers = useCallback(
    (kind: DragKind, id: string, section: string) => ({
      onPointerDown: (e: ReactPointerEvent<HTMLElement>) => begin(kind, id, section, e),
      onClickCapture: (e: { stopPropagation: () => void; preventDefault: () => void }) => {
        if (suppressClick.current) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
    }),
    [begin],
  );

  return { drag, rowHandlers };
}
