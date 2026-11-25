// 内置浏览器面板（agent-browser 驱动的 cosyee 专用 Chrome，登录状态长期保存）。
// 宽屏时停靠在窗口右侧，把主界面往左挤（输入框始终可见，抓到的元素直接进输入框）；窄屏 / 最大化时铺满。
// 抓取模式：悬停高亮元素，点击后服务端把元素的位置 / 选择器 / 文字 / HTML 写成描述文件，按附件标签插进输入框。
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BrowserPickResult, BrowserStatus } from '@cosyee/shared';
import { api } from '../../core/api';
import { Icon } from '../icons/Icon';
import { NARROW_QUERY, useMediaQuery } from '../layout/useMediaQuery';
import { BrowserView } from './BrowserView';
import { useBrowserStream } from './useBrowserStream';
import './BrowserPanel.css';

const WIDTH_KEY = 'cosyee.browser.width';
const MIN_W = 360;
/** 主界面至少留这么宽 */
const MIN_REST = 420;
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MAC_TOGGLE = MAC ? '⇧⌘P' : 'Ctrl+Shift+P';
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function clampWidth(w: number): number {
  const max = Math.max(MIN_W, window.innerWidth - MIN_REST);
  return Math.round(Math.min(max, Math.max(MIN_W, w)));
}

function readWidth(): number {
  const v = Number(localStorage.getItem(WIDTH_KEY));
  return clampWidth(Number.isFinite(v) && v > 0 ? v : window.innerWidth * 0.5);
}

export interface BrowserPanelProps {
  onClose: () => void;
  /** 抓到元素：插进输入框；输入框当前不可用时返回 false */
  onPick: (r: BrowserPickResult) => boolean;
}

export function BrowserPanel({ onClose, onPick }: BrowserPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const narrow = useMediaQuery(NARROW_QUERY);
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [capture, setCapture] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [width, setWidth] = useState(readWidth);
  const [url, setUrl] = useState('');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const loadStatus = useCallback(() => {
    setStatusError(null);
    api.browserStatus().then(
      (s) => {
        setStatus(s);
        if (s.url && s.url !== 'about:blank') setUrl((u) => u || s.url!);
      },
      (e: unknown) => setStatusError(msg(e)),
    );
  }, []);
  useEffect(loadStatus, [loadStatus]);

  const stream = useBrowserStream(canvasRef, !!status?.installed);
  const { tab } = stream;
  // 地址栏跟随活动页（正在编辑时不动）
  useEffect(() => {
    if (!editing && tab) setUrl(tab.url === 'about:blank' ? '' : tab.url);
  }, [tab, editing]);

  const say = useCallback((text: string, error = false) => setNotice({ text, error }), []);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), notice.error ? 5000 : 2500);
    return () => window.clearTimeout(t);
  }, [notice]);
  const onError = useCallback((m: string) => say(m, true), [say]);

  // 一键安装：发起组件安装，轮询到装好（或失败）为止
  const install = useCallback(async () => {
    setInstalling(true);
    try {
      let c = await api.updateComponent('browser');
      while (c.job?.state === 'running') {
        await new Promise((r) => window.setTimeout(r, 1000));
        c = (await api.components()).list.find((x) => x.id === 'browser') ?? c;
      }
      if (c.job?.state === 'failed') throw new Error(`安装失败：${c.job.error ?? '未知错误'}`);
      loadStatus();
    } catch (e) {
      say(msg(e), true);
    } finally {
      setInstalling(false);
    }
  }, [loadStatus, say]);


  // 停靠：主界面右边让出面板宽度
  const docked = !narrow && !maximized;
  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('cz-browser-docked', docked);
    root.style.setProperty('--cz-browser-w', `${width}px`);
    return () => {
      root.classList.remove('cz-browser-docked');
      root.style.removeProperty('--cz-browser-w');
    };
  }, [docked, width]);
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 左边缘拖动调宽
  const onResizeDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = clampWidth(startW + (startX - ev.clientX));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('cz-br-resizing');
      localStorage.setItem(WIDTH_KEY, String(w));
    };
    document.body.classList.add('cz-br-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const go = async () => {
    const u = url.trim();
    if (!u) return;
    setEditing(false);
    setLoading(true);
    try {
      const r = await api.browserOpen(u);
      if (r.url) setUrl(r.url);
    } catch (e) {
      say(msg(e), true);
    } finally {
      setLoading(false);
    }
  };
  const nav = (action: 'back' | 'forward' | 'reload') => {
    api.browserNav(action).catch((e: unknown) => say(msg(e), true));
  };

  const onPicked = useCallback((r: BrowserPickResult) => {
    const tag = r.element.tag.toLowerCase();
    if (onPick(r)) say(`已加入输入框：<${tag}>`);
    else say('输入框当前不可用，元素没有加入', true);
  }, [onPick, say]);
  const cancelCapture = useCallback(() => setCapture(false), []);

  const installed = status?.installed === true;
  const cls = `cz-br${docked ? ' is-docked' : ' is-full'}`;
  return (
    <section className={cls} style={docked ? { width } : undefined} aria-label="内置浏览器">
      {docked && <div className="cz-br__resize" onPointerDown={onResizeDown} aria-hidden="true" />}
      <header className="cz-br__bar">
        <button type="button" className="cz-br__btn" title="后退" aria-label="后退" disabled={!installed} onClick={() => nav('back')}>
          <Icon name="arrow-left" size={15} />
        </button>
        <button type="button" className="cz-br__btn" title="前进" aria-label="前进" disabled={!installed} onClick={() => nav('forward')}>
          <Icon name="arrow-right" size={15} />
        </button>
        <button type="button" className="cz-br__btn" title="刷新" aria-label="刷新" disabled={!installed} onClick={() => nav('reload')}>
          <Icon name="refresh" size={15} />
        </button>
        <form
          className="cz-br__url"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <input
            value={url}
            disabled={!installed}
            placeholder="输入网址或搜索"
            aria-label="地址"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setUrl(e.target.value)}
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setEditing(false);
                setUrl(tab && tab.url !== 'about:blank' ? tab.url : '');
                e.currentTarget.blur();
              }
            }}
          />
          {loading && <span className="cz-br__spin" aria-label="正在打开" />}
        </form>
        <button
          type="button"
          className={`cz-br__btn cz-br__pick${capture ? ' is-on' : ''}`}
          title={capture ? '退出抓取模式（Esc）' : '抓取模式：点击网页元素加入输入框'}
          aria-label="抓取模式"
          aria-pressed={capture}
          disabled={!installed || stream.state !== 'open'}
          onClick={() => setCapture((c) => !c)}
        >
          <Icon name="pick" size={15} />
          <span>抓取</span>
        </button>
        {!narrow && (
          <button type="button" className="cz-br__btn" title={maximized ? '还原' : '最大化'} aria-label={maximized ? '还原' : '最大化'} onClick={() => setMaximized((m) => !m)}>
            <Icon name={maximized ? 'window-restore' : 'maximize'} size={15} />
          </button>
        )}
        <button type="button" className="cz-br__btn" title={`关闭（${MAC_TOGGLE}）`} aria-label="关闭浏览器" onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </header>
      {capture && <div className="cz-br__hint">抓取模式：移到元素上查看范围，点击加入输入框 · Esc 退出</div>}
      <div className="cz-br__body">
        {statusError ? (
          <div className="cz-br__empty">
            <p>读取浏览器状态失败：{statusError}</p>
            <button type="button" className="cz-br__action" onClick={loadStatus}>重试</button>
          </div>
        ) : !status ? (
          <div className="cz-br__empty"><p>正在加载…</p></div>
        ) : !installed ? (
          <div className="cz-br__empty">
            <Icon name="globe" size={28} />
            <p>内置浏览器还没有安装（cosyee 专用的 Chrome，登录状态会一直保存）。</p>
            <button type="button" className="cz-br__action is-primary" disabled={installing} onClick={() => void install()}>
              {installing ? '正在安装…' : '安装'}
            </button>
          </div>
        ) : (
          <>
            <BrowserView
              canvasRef={canvasRef}
              stream={stream}
              capture={capture}
              onCancelCapture={cancelCapture}
              onPicked={onPicked}
              onError={onError}
            />
            {stream.state === 'connecting' && !stream.page && <div className="cz-br__overlay">正在启动浏览器…</div>}
            {stream.state === 'closed' && (
              <div className="cz-br__overlay">
                <p>{stream.error ?? '与浏览器的连接断开了'}</p>
                <button type="button" className="cz-br__action" onClick={stream.reconnect}>重连</button>
              </div>
            )}
          </>
        )}
        {notice && (
          <div className={`cz-br__toast${notice.error ? ' is-error' : ''}`} role="status">
            {notice.text}
          </div>
        )}
      </div>
    </section>
  );
}
