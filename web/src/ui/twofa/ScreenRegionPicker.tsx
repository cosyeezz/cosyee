// 页内屏幕区域选择器：对应 Google Authenticator 浏览器扩展的「框选二维码」。
// 全视口 portal 浮层展示冻结的帧（contain 适配，按实际显示尺寸与帧像素的比值换算坐标，不依赖 devicePixelRatio 假设），
// 压暗 45%；自动检测到二维码就高亮挖洞，只有一个且可解码时 ~400ms 成功动画后自动完成，否则拖动框选。
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findAllQrInImage, findQrInRegion, type QrHit, type QrRect } from '../../core/twofa/qr';
import { Icon } from '../icons/Icon';
import './ScreenRegionPicker.css';

export interface ScreenRegionPickerProps {
  /** 冻结的帧（像素尺寸即原始帧尺寸） */
  frame: HTMLCanvasElement;
  /** 识别成功：二维码文本 */
  onResult: (text: string) => void;
  onCancel: () => void;
}

type Phase = 'finding' | 'idle' | 'success';

interface Sel {
  /** 相对舞台左上角的 CSS 像素 */
  x: number;
  y: number;
  w: number;
  h: number;
}

const AUTO_DONE_MS = 400;
const MIN_DRAG = 10;

export function ScreenRegionPicker({ frame, onResult, onCancel }: ScreenRegionPickerProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const [vp, setVp] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [phase, setPhase] = useState<Phase>('finding');
  const [hits, setHits] = useState<QrHit[]>([]);
  const [sel, setSel] = useState<Sel | null>(null);
  const [dragging, setDragging] = useState(false);
  const [okSel, setOkSel] = useState<Sel | null>(null);
  const [failed, setFailed] = useState(false);
  const [closing, setClosing] = useState(false);
  const startRef = useRef<{ x: number; y: number; id: number } | null>(null);
  const timers = useRef<number[]>([]);
  const doneRef = useRef(false);

  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(fn, ms);
    timers.current.push(t);
  };
  useEffect(() => () => timers.current.forEach(window.clearTimeout), []);

  // contain 适配：舞台尺寸 = 帧按比例缩放后的显示尺寸（小帧最多放大 3 倍）
  const fit = useMemo(() => {
    const k = Math.min(vp.w / frame.width, vp.h / frame.height, 3);
    return { w: Math.round(frame.width * k), h: Math.round(frame.height * k), k };
  }, [vp, frame.width, frame.height]);

  useEffect(() => {
    const onResize = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useLayoutEffect(() => {
    const c = viewRef.current;
    const ctx = c?.getContext('2d');
    if (c && ctx) {
      c.width = frame.width;
      c.height = frame.height;
      ctx.drawImage(frame, 0, 0);
    }
    rootRef.current?.focus();
  }, [frame]);

  const finish = useCallback(
    (fn: () => void) => {
      if (doneRef.current) return;
      doneRef.current = true;
      setClosing(true);
      later(fn, 150);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const cancel = useCallback(() => finish(onCancel), [finish, onCancel]);

  const succeed = useCallback(
    (text: string, box: Sel | null) => {
      if (doneRef.current) return;
      setOkSel(box);
      setPhase('success');
      setSel(null);
      later(() => finish(() => onResult(text)), AUTO_DONE_MS);
    },
    [finish, onResult],
  );

  // 自动检测：先让浮层画出来再开始（大图解码可能要几百毫秒）
  useEffect(() => {
    let dead = false;
    const t = window.setTimeout(() => {
      const found = findAllQrInImage(frame, 4);
      if (dead) return;
      setHits(found);
      setPhase('idle');
      if (found.length === 1) {
        const k = fit.k;
        const b = found[0].location.bounds;
        const pad = Math.max(6, Math.min(b.width, b.height) * 0.06);
        succeed(found[0].text, { x: (b.x - pad) * k, y: (b.y - pad) * k, w: (b.width + pad * 2) * k, h: (b.height + pad * 2) * k });
      }
    }, 60);
    return () => {
      dead = true;
      window.clearTimeout(t);
    };
    // 只在挂载时检测一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);

  // Esc 取消（捕获阶段，避免被下层面板的 Esc 抢先处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [cancel]);

  // 锁住背景滚动
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const toLocal = (e: React.PointerEvent): { x: number; y: number } => {
    const r = stageRef.current!.getBoundingClientRect();
    return {
      x: Math.min(Math.max(0, e.clientX - r.left), r.width),
      y: Math.min(Math.max(0, e.clientY - r.top), r.height),
    };
  };

  const decodeSel = (s: Sel) => {
    const r = stageRef.current!.getBoundingClientRect();
    const kx = frame.width / r.width;
    const ky = frame.height / r.height;
    const rect: QrRect = { x: s.x * kx, y: s.y * ky, width: s.w * kx, height: s.h * ky };
    const hit = findQrInRegion(frame, rect);
    if (hit) {
      succeed(hit.text, s);
    } else {
      setFailed(true);
      later(() => {
        setSel(null);
        setFailed(false);
      }, 900);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || phase !== 'idle' || failed) return;
    const p = toLocal(e);
    startRef.current = { ...p, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
    setSel({ x: p.x, y: p.y, w: 0, h: 0 });
    setDragging(true);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s || s.id !== e.pointerId) return;
    const p = toLocal(e);
    setSel({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const s = startRef.current;
    if (!s || s.id !== e.pointerId) return;
    startRef.current = null;
    setDragging(false);
    const p = toLocal(e);
    const box: Sel = { x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), w: Math.abs(p.x - s.x), h: Math.abs(p.y - s.y) };
    if (box.w < MIN_DRAG || box.h < MIN_DRAG) {
      setSel(null);
      return;
    }
    setSel(box);
    decodeSel(box);
  };

  const onPointerCancel = () => {
    startRef.current = null;
    setDragging(false);
    setSel(null);
  };

  const shown = sel ?? okSel;
  const showHits = phase === 'idle' && hits.length > 1 && !dragging && !sel;

  let hint = '拖动框选二维码 · Esc 取消';
  let hintTone = '';
  if (phase === 'finding') hint = '正在查找二维码…';
  else if (phase === 'success') {
    hint = '已识别二维码';
    hintTone = 'is-ok';
  } else if (failed) {
    hint = '未识别到二维码，请重新框选';
    hintTone = 'is-bad';
  } else if (hits.length > 1) hint = `检测到 ${hits.length} 个二维码，点击选择或拖动框选 · Esc 取消`;
  else if (dragging) hint = '松开鼠标开始识别';

  return createPortal(
    <div
      ref={rootRef}
      tabIndex={-1}
      className={`cz-2fa-rp${closing ? ' is-closing' : ''}${dragging ? ' is-dragging' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="框选二维码"
      onContextMenu={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <div
        ref={stageRef}
        className="cz-2fa-rp__stage"
        style={{ width: fit.w, height: fit.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
      >
        <canvas ref={viewRef} className="cz-2fa-rp__frame" />
        <div className={`cz-2fa-rp__dim${shown ? ' is-hole' : ''}`} />

        {showHits &&
          hits.map((h, i) => {
            const b = h.location.bounds;
            const pad = Math.max(6, Math.min(b.width, b.height) * 0.06);
            const k = fit.k;
            return (
              <button
                key={i}
                type="button"
                className="cz-2fa-rp__hit"
                style={{
                  left: (b.x - pad) * k,
                  top: (b.y - pad) * k,
                  width: (b.width + pad * 2) * k,
                  height: (b.height + pad * 2) * k,
                  animationDelay: `${i * 60}ms`,
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() =>
                  succeed(h.text, {
                    x: (b.x - pad) * k,
                    y: (b.y - pad) * k,
                    w: (b.width + pad * 2) * k,
                    h: (b.height + pad * 2) * k,
                  })
                }
              >
                <span className="cz-2fa-rp__hit-label">点击识别</span>
              </button>
            );
          })}

        {shown && (
          <div
            className={`cz-2fa-rp__sel${phase === 'success' ? ' is-ok' : ''}${failed ? ' is-bad' : ''}${dragging ? ' is-live' : ''}`}
            style={{ left: shown.x, top: shown.y, width: shown.w, height: shown.h }}
          >
            {phase === 'success' && (
              <span className="cz-2fa-rp__ok">
                <Icon name="check" size={18} />
              </span>
            )}
            {dragging && shown.w > 0 && (
              <span className={`cz-2fa-rp__size${shown.y < 28 ? ' is-in' : ''}`}>
                {Math.round(shown.w * (frame.width / fit.w))} × {Math.round(shown.h * (frame.height / fit.h))}
              </span>
            )}
          </div>
        )}
      </div>

      <div className={`cz-2fa-rp__pill ${hintTone}`} key={hint}>
        {phase === 'finding' && <span className="cz-2fa-rp__spin" aria-hidden="true" />}
        <span className="cz-2fa-rp__pill-text">{hint}</span>
        <button
          type="button"
          className="cz-2fa-rp__x"
          aria-label="取消"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={cancel}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>,
    document.body,
  );
}

export default ScreenRegionPicker;
