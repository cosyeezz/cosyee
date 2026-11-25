import { useEffect, useRef, type RefObject } from 'react';

type Refs = RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[];

/** 正开着的弹层，后开的在上面（例如：账号菜单 → 移除确认气泡） */
const layers: { inside: (t: Node) => boolean }[] = [];

/**
 * 弹层打开时：点击 ref 之外的区域或按 Esc 触发 onDismiss。
 * 弹层可以叠放：Esc 只关最上面那层；点在上层弹层里（可能 portal 到了别处）不算点在下层的外面。
 */
export function useDismiss(open: boolean, ref: Refs, onDismiss: () => void): void {
  // 放在 ref 里：调用方每次渲染传新函数也不会重新入栈、打乱层序
  const latest = useRef({ ref, onDismiss });
  useEffect(() => {
    latest.current = { ref, onDismiss };
  });
  useEffect(() => {
    if (!open) return;
    const refs = () => (Array.isArray(latest.current.ref) ? latest.current.ref : [latest.current.ref]);
    const layer = { inside: (t: Node) => refs().some((r) => r.current?.contains(t)) };
    layers.push(layer);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (layers.slice(layers.indexOf(layer)).some((l) => l.inside(t))) return;
      latest.current.onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || handled.has(e) || layers.at(-1) !== layer) return;
      handled.add(e); // 同步卸载后下一层会变成最上层，同一次按键不能接着关它
      latest.current.onDismiss();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      layers.splice(layers.indexOf(layer), 1);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
}

const handled = new WeakSet<Event>();

/** 有弹层正开着：悬停类浮层据此不再打开，免得压住菜单、抢走它的 Esc */
export function hasOpenLayer(): boolean {
  return layers.length > 0;
}
