// 内置浏览器的画面区：canvas 显示推流帧，鼠标 / 键盘转发给页面；抓取模式下悬停高亮元素、点击抓取。
// 键盘输入走一个透明 textarea：普通按键转成 keyDown / keyUp，输入法上屏和粘贴的文字转成 char。
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { BrowserHover, BrowserPickResult } from '@cosyee/shared';
import { api } from '../../core/api';
import { buttonName, charMsgs, heldButton, isLocalKey, keyMsg, mouseMsg, toPage, wheelMsg, type PageSize } from './input';
import type { BrowserStream } from './useBrowserStream';

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const DOUBLE_CLICK_MS = 400;

export interface BrowserViewProps {
  /** 身份 id */
  profile: string;
  canvasRef: RefObject<HTMLCanvasElement>;
  stream: BrowserStream;
  capture: boolean;
  onCancelCapture: () => void;
  onPicked: (r: BrowserPickResult) => void;
  onError: (message: string) => void;
}

export function BrowserView({ profile, canvasRef, stream, capture, onCancelCapture, onPicked, onError }: BrowserViewProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imeRef = useRef<HTMLTextAreaElement>(null);
  const [stage, setStage] = useState<PageSize | null>(null);
  const [hover, setHover] = useState<BrowserHover | null>(null);
  const [picking, setPicking] = useState(false);
  const [focused, setFocused] = useState(false);
  const { page, send, state } = stream;
  const captureRef = useRef(capture);
  captureRef.current = capture;
  const pageRef = useRef(page);
  pageRef.current = page;

  // 视口跟随面板大小（防抖），高分屏按设备像素比出图
  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      const r = e!.contentRect;
      setStage((s) => (s && s.width === Math.floor(r.width) && s.height === Math.floor(r.height) ? s : { width: Math.floor(r.width), height: Math.floor(r.height) }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 连上后的第一次立即发（面板刚打开就点了链接时，页面尽早按面板尺寸排版），之后拖动改大小才防抖
  const viewportSent = useRef(false);
  useEffect(() => {
    if (state !== 'open') viewportSent.current = false;
  }, [state]);
  useEffect(() => {
    if (!stage || state !== 'open' || stage.width < 10 || stage.height < 10) return;
    const t = window.setTimeout(() => {
      viewportSent.current = true;
      api.browserViewport(profile, stage.width, stage.height, window.devicePixelRatio || 1).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
    }, viewportSent.current ? 200 : 0);
    return () => window.clearTimeout(t);
  }, [profile, stage, state, onError]);

  useEffect(() => {
    if (!capture) setHover(null);
  }, [capture]);

  const pos = useCallback((e: { clientX: number; clientY: number }) => {
    const c = canvasRef.current;
    const p = pageRef.current;
    return c && p ? toPage(e.clientX, e.clientY, c.getBoundingClientRect(), p) : null;
  }, [canvasRef]);

  // 悬停高亮：同一时间只有一个请求，期间的移动只保留最后一个点
  const hoverBusy = useRef(false);
  const hoverNext = useRef<{ x: number; y: number } | null>(null);
  const hoverAt = useCallback(async (p: { x: number; y: number }) => {
    hoverNext.current = p;
    if (hoverBusy.current) return;
    hoverBusy.current = true;
    try {
      while (hoverNext.current) {
        const q = hoverNext.current;
        hoverNext.current = null;
        const h = await api.browserHover(profile, q.x, q.y).catch(() => null);
        if (captureRef.current) setHover(h);
      }
    } finally {
      hoverBusy.current = false;
    }
  }, [profile]);

  const pick = useCallback(async (p: { x: number; y: number }) => {
    setPicking(true);
    try {
      onPicked(await api.browserPick(profile, p.x, p.y));
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  }, [profile, onPicked, onError]);

  // 滚轮要能 preventDefault（不让外层滚动），React 的 onWheel 是被动监听，只能自己挂
  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = pos(e);
      if (p) send(wheelMsg(p, e));
    };
    c.addEventListener('wheel', onWheel, { passive: false });
    return () => c.removeEventListener('wheel', onWheel);
  }, [canvasRef, pos, send]);

  const lastPress = useRef({ t: 0, x: 0, y: 0, n: 0 });
  const moveFrame = useRef(0);
  const moveEvent = useRef<{ clientX: number; clientY: number; buttons: number; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean } | null>(null);
  useEffect(() => () => cancelAnimationFrame(moveFrame.current), []);

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    imeRef.current?.focus({ preventScroll: true });
    const p = pos(e);
    if (!p) return;
    if (capture) {
      if (e.button === 0 && !picking) void pick(p);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    // pointer 事件的 detail 恒为 0，连击次数自己数
    const l = lastPress.current;
    const n = e.timeStamp - l.t < DOUBLE_CLICK_MS && Math.abs(e.clientX - l.x) < 5 && Math.abs(e.clientY - l.y) < 5 ? Math.min(l.n + 1, 3) : 1;
    lastPress.current = { t: e.timeStamp, x: e.clientX, y: e.clientY, n };
    send(mouseMsg('mousePressed', p, buttonName(e.button), n, e));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (capture) return;
    const p = pos(e);
    if (p) send(mouseMsg('mouseReleased', p, buttonName(e.button), lastPress.current.n, e));
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const { clientX, clientY, buttons, altKey, ctrlKey, metaKey, shiftKey } = e;
    moveEvent.current = { clientX, clientY, buttons, altKey, ctrlKey, metaKey, shiftKey };
    if (moveFrame.current) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = 0;
      const m = moveEvent.current;
      const p = m && pos(m);
      if (!m || !p) return;
      if (captureRef.current) void hoverAt(p);
      else send(mouseMsg('mouseMoved', p, heldButton(m.buttons), 0, m));
    });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>, type: 'keyDown' | 'keyUp') => {
    if (e.nativeEvent.isComposing || e.key === 'Process' || e.keyCode === 229) return; // 输入法组字中
    if (isLocalKey(e, MAC)) return;
    if (type === 'keyDown' && capture && e.key === 'Escape') {
      e.preventDefault();
      onCancelCapture();
      return;
    }
    e.preventDefault();
    send(keyMsg(type, e));
  };

  const scale = page && stage ? Math.min(stage.width / page.width, stage.height / page.height) : 1;
  const disp = page ? { width: Math.round(page.width * scale), height: Math.round(page.height * scale) } : null;
  const box = hover?.rect && hover.rect.width > 0 && hover.rect.height > 0 ? hover.rect : null;

  return (
    <div ref={stageRef} className={`cz-br__stage${capture ? ' is-capture' : ''}${focused ? ' is-focused' : ''}`}>
      <div className="cz-br__screen" style={disp ? { width: disp.width, height: disp.height } : { visibility: 'hidden' }}>
        <canvas
          ref={canvasRef}
          className="cz-br__canvas"
          aria-label="网页画面"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHover(null)}
          onContextMenu={(e) => e.preventDefault()}
        />
        {capture && box && (
          <div
            className="cz-br__hl"
            style={{ left: box.x * scale, top: box.y * scale, width: box.width * scale, height: box.height * scale }}
          >
            <span className="cz-br__hl-label">{hover!.label}</span>
          </div>
        )}
        <textarea
          ref={imeRef}
          className="cz-br__ime"
          aria-label="向网页输入"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => onKey(e, 'keyDown')}
          onKeyUp={(e) => onKey(e, 'keyUp')}
          onCompositionEnd={(e) => {
            for (const m of charMsgs(e.data)) send(m);
            e.currentTarget.value = '';
          }}
          onPaste={(e) => {
            e.preventDefault();
            for (const m of charMsgs(e.clipboardData.getData('text/plain'))) send(m);
          }}
          onInput={(e) => {
            if (!(e.nativeEvent as InputEvent).isComposing) e.currentTarget.value = '';
          }}
        />
      </div>
      {picking && <div className="cz-br__busy">正在抓取…</div>}
    </div>
  );
}
