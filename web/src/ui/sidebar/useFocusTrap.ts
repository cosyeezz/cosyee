import { useEffect, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** 模态对话框：Tab / Shift+Tab 在对话框里循环，不跑到后面的页面上。上面又叠了一层对话框时传 enabled = false，让给上层 */
export function useFocusTrap(ref: RefObject<HTMLElement>, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const box = ref.current;
      if (e.key !== 'Tab' || !box) return;
      const els = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
      const first = els[0];
      const last = els.at(-1);
      if (!first || !last) return;
      const at = document.activeElement;
      const inside = box.contains(at);
      if (e.shiftKey ? at === first || !inside : at === last || !inside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ref, enabled]);
}
