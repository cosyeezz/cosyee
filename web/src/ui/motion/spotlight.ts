// 卡片聚光：鼠标在带 .cz-spot 的元素上移动时，一团柔光跟着指针，并把附近的边框照亮。
// 全局只挂一个 pointermove 监听（事件委托 + 每帧最多处理一次），组件只需要加类名。
// 同时带 .cz-tilt 的卡片还会朝指针方向微微倾斜（最多 4°），离开后平滑回正。
// 样式见 styles/motion.css；只响应鼠标 / 触控笔，触摸不出光。
const TILT_MAX = 4;

export function installSpotlight(doc: Document = document): () => void {
  let lit: HTMLElement | null = null;
  let pending: PointerEvent | null = null;
  let raf = 0;

  const setLit = (el: HTMLElement | null) => {
    if (el === lit) return;
    if (lit) {
      lit.classList.remove('is-lit');
      lit.style.removeProperty('--tilt-x');
      lit.style.removeProperty('--tilt-y');
    }
    lit = el;
    el?.classList.add('is-lit');
  };

  const flush = () => {
    raf = 0;
    const e = pending;
    pending = null;
    if (!e) return;
    const target = e.target instanceof Element ? e.target.closest<HTMLElement>('.cz-spot') : null;
    if (target) {
      const r = target.getBoundingClientRect();
      target.style.setProperty('--spot-x', `${Math.round(e.clientX - r.left)}px`);
      target.style.setProperty('--spot-y', `${Math.round(e.clientY - r.top)}px`);
      if (target.classList.contains('cz-tilt') && r.width > 0 && r.height > 0) {
        // 指针一侧往里压：右侧 → rotateY 正，下侧 → rotateX 负
        const nx = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
        const ny = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
        target.style.setProperty('--tilt-x', `${(-ny * TILT_MAX).toFixed(2)}deg`);
        target.style.setProperty('--tilt-y', `${(nx * TILT_MAX).toFixed(2)}deg`);
      }
    }
    setLit(target);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    pending = e;
    if (!raf) raf = requestAnimationFrame(flush);
  };
  // 指针离开窗口：熄灭
  const onOut = (e: PointerEvent) => {
    if (!e.relatedTarget) setLit(null);
  };

  doc.addEventListener('pointermove', onMove, { passive: true });
  doc.addEventListener('pointerout', onOut, { passive: true });
  return () => {
    doc.removeEventListener('pointermove', onMove);
    doc.removeEventListener('pointerout', onOut);
    if (raf) cancelAnimationFrame(raf);
    setLit(null);
  };
}
