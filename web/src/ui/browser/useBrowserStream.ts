// 内置浏览器画面：连 /api/browser/stream（服务端转发 agent-browser 的推流），把 JPEG 帧画到 canvas，每画完一帧回 ack。
// 推流消息：status（视口）、tabs（标签页：取活动页的地址 / 标题）、frame（base64 JPEG + 页面尺寸），cosyee_error 是服务端自己的错误。
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { api } from '../../core/api';
import type { PageSize } from './input';

export type StreamState = 'connecting' | 'open' | 'closed';

export interface BrowserStream {
  state: StreamState;
  error: string | null;
  /** 当前帧对应的页面视口（CSS 像素）；还没收到帧时为 null */
  page: PageSize | null;
  /** 活动标签页 */
  tab: { url: string; title: string } | null;
  send: (msg: object) => void;
  reconnect: () => void;
}

function decodeBase64(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function useBrowserStream(canvasRef: RefObject<HTMLCanvasElement>, profile: string, enabled: boolean): BrowserStream {
  const [state, setState] = useState<StreamState>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState<PageSize | null>(null);
  const [tab, setTab] = useState<{ url: string; title: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setState('connecting');
    setError(null);
    // 换身份：旧画面和地址不再属于当前身份
    setPage(null);
    setTab(null);
    const ws = new WebSocket(api.browserStreamUrl(profile));
    wsRef.current = ws;
    let drawing = Promise.resolve();

    const draw = (seq: unknown, data: string, meta: Record<string, unknown> | undefined): Promise<void> =>
      createImageBitmap(new Blob([decodeBase64(data)], { type: 'image/jpeg' }))
        .then((bmp) => {
          const c = canvasRef.current;
          if (alive && c) {
            if (c.width !== bmp.width || c.height !== bmp.height) {
              c.width = bmp.width;
              c.height = bmp.height;
            }
            c.getContext('2d')?.drawImage(bmp, 0, 0);
            const w = Number(meta?.deviceWidth);
            const h = Number(meta?.deviceHeight);
            if (w > 0 && h > 0) setPage((p) => (p && p.width === w && p.height === h ? p : { width: w, height: h }));
          }
          bmp.close();
        })
        .catch(() => { /* 坏帧：跳过 */ })
        .finally(() => {
          if (alive && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', seq }));
        });

    ws.onopen = () => alive && setState('open');
    ws.onclose = () => alive && setState('closed');
    ws.onmessage = (ev) => {
      if (!alive || typeof ev.data !== 'string') return;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (m.type === 'frame' && typeof m.data === 'string') {
        const { seq, data } = m;
        const meta = m.metadata as Record<string, unknown> | undefined;
        drawing = drawing.then(() => draw(seq, data, meta)); // 按顺序画
      } else if (m.type === 'tabs' && Array.isArray(m.tabs)) {
        const t = (m.tabs as Record<string, unknown>[]).find((x) => x && x.active === true);
        if (t) setTab({ url: typeof t.url === 'string' ? t.url : '', title: typeof t.title === 'string' ? t.title : '' });
      } else if (m.type === 'cosyee_error') {
        setError(typeof m.message === 'string' ? m.message : '浏览器出错了');
      }
    };
    return () => {
      alive = false;
      wsRef.current = null;
      ws.close();
    };
  }, [canvasRef, profile, enabled, nonce]);

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);
  const reconnect = useCallback(() => setNonce((n) => n + 1), []);

  return { state, error, page, tab, send, reconnect };
}
