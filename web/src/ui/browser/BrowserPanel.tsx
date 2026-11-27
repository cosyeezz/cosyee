// 内置浏览器面板（agent-browser 驱动的 cosyee 专用 Chrome，登录状态长期保存）。
// 宽屏时停靠在窗口右侧，把主界面往左挤（输入框始终可见，抓到的元素直接进输入框）；窄屏 / 最大化时铺满。
// 登录窗口：Google 等网站拦截内置（无界面、被自动化控制的）浏览器的登录，这时在本机桌面用同一个身份打开有界面的 Chrome 登录，
// 用户登录好后点「登录完成」：窗口正常退出（Cookie 写盘）后回到这里，登录状态是同一份。窗口开着时面板只显示提示。
// 什么时候用窗口由用户决定，不按网址自动判断。
// 抓取模式：悬停高亮元素，点击后服务端生成一行定位文字（唯一选择器 / 文字 / 页面 / 身份），按附件标签插进输入框，发送时就是这行文字。
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { BrowserHistoryItem, BrowserPickResult, BrowserProfileStatus, BrowserStatus } from '@cosyee/shared';
import { api } from '../../core/api';
import { Icon } from '../icons/Icon';
import { NARROW_QUERY, useMediaQuery } from '../layout/useMediaQuery';
import { BrowserView } from './BrowserView';
import type { BrowserLink } from './links';
import { ProfileMenu } from './ProfileMenu';
import { useBrowserStream } from './useBrowserStream';
import './BrowserPanel.css';

const WIDTH_KEY = 'cosyee.browser.width';
/** 上次用的身份 */
const PROFILE_KEY = 'cosyee.browser.profile';
const DEFAULT_PROFILE = 'default';
const MIN_W = 360;
/** 主界面至少留这么宽 */
const MIN_REST = 420;
const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const MAC_TOGGLE = MAC ? '⇧⌘P' : 'Ctrl+Shift+P';
/** 窗口模式期间多久查一次状态（用户直接退出 Chrome 时也能回到内置） */
const WINDOW_POLL_MS = 1500;
/** 地址栏停止输入多久后查历史 */
const HISTORY_DEBOUNCE_MS = 120;
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
  /** 应用里点的链接：在当前身份的活动页里打开（seq 变了才打开） */
  link?: BrowserLink | null;
}

export function BrowserPanel({ onClose, onPick, link }: BrowserPanelProps) {
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
  const [profile, setProfileState] = useState(() => localStorage.getItem(PROFILE_KEY) || DEFAULT_PROFILE);
  const setProfile = useCallback((id: string) => {
    setProfileState(id);
    localStorage.setItem(PROFILE_KEY, id);
  }, []);

  // 只认最后一次请求的结果：先发的慢响应不能盖掉新列表（否则刚建的身份会被当成「已删除」退回默认）
  const statusSeq = useRef(0);
  const loadStatus = useCallback(() => {
    const seq = ++statusSeq.current;
    setStatusError(null);
    api.browserStatus().then(
      (s) => seq === statusSeq.current && setStatus(s),
      (e: unknown) => seq === statusSeq.current && setStatusError(msg(e)),
    );
  }, []);
  // 新建的身份先放进列表再切过去，不等状态刷新
  const onCreated = useCallback(
    (p: BrowserProfileStatus) => {
      setStatus((s) => (s && !s.profiles.some((x) => x.id === p.id) ? { ...s, profiles: [...s.profiles, p] } : s));
      setProfile(p.id);
    },
    [setProfile],
  );
  useEffect(loadStatus, [loadStatus]);
  const installed = status?.installed === true;
  // 记住的身份已被删掉（比如在别的窗口里删的）：退回默认身份
  const profiles = status?.profiles;
  useEffect(() => {
    if (profiles && !profiles.some((p) => p.id === profile)) setProfile(DEFAULT_PROFILE);
  }, [profiles, profile, setProfile]);
  // 换身份：地址栏换成那个身份的当前地址，退出抓取模式
  const profileUrl = profiles?.find((p) => p.id === profile)?.url ?? null;
  const profileUrlRef = useRef(profileUrl);
  profileUrlRef.current = profileUrl;
  useEffect(() => {
    const u = profileUrlRef.current;
    setUrl(u && u !== 'about:blank' ? u : '');
    setEditing(false);
    setCapture(false);
  }, [profile]);

  const stream = useBrowserStream(canvasRef, profile, !!status?.installed);
  const { tab, windowed, reconnect } = stream;

  // 登录窗口：状态里的 window 是准的；推流先一步收到 cosyee_window 时立刻刷新状态
  const statusWindow = profiles?.find((p) => p.id === profile)?.window === true;
  const inWindow = statusWindow || windowed;
  const [windowBusy, setWindowBusy] = useState(false);
  useEffect(() => {
    if (windowed) loadStatus();
  }, [windowed, loadStatus]);
  useEffect(() => {
    if (!inWindow) return;
    const t = window.setInterval(loadStatus, WINDOW_POLL_MS);
    return () => window.clearInterval(t);
  }, [inWindow, loadStatus]);
  // 窗口关掉（状态从 true 变 false）：重连画面
  const wasWindow = useRef(false);
  useEffect(() => {
    if (statusWindow) wasWindow.current = true;
    else if (wasWindow.current) {
      wasWindow.current = false;
      reconnect();
    }
  }, [statusWindow, reconnect]);
  useEffect(() => {
    wasWindow.current = false;
  }, [profile]);
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

  const openWindow = useCallback(async () => {
    setWindowBusy(true);
    setCapture(false);
    try {
      await api.browserWindow(profile, 'open');
      loadStatus();
    } catch (e) {
      say(msg(e), true);
    } finally {
      setWindowBusy(false);
    }
  }, [profile, loadStatus, say]);
  const closeWindow = useCallback(async () => {
    setWindowBusy(true);
    try {
      await api.browserWindow(profile, 'close');
    } catch (e) {
      say(msg(e), true);
    } finally {
      setWindowBusy(false);
      wasWindow.current = false;
      loadStatus();
      reconnect();
    }
  }, [profile, loadStatus, reconnect, say]);

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

  const open = useCallback(
    async (u: string) => {
      setEditing(false);
      setLoading(true);
      try {
        const r = await api.browserOpen(profile, u);
        if (r.url) setUrl(r.url);
      } catch (e) {
        say(msg(e), true);
      } finally {
        setLoading(false);
      }
    },
    [profile, say],
  );
  const go = () => {
    const u = url.trim();
    if (u) void open(u);
  };

  // 地址栏历史联想：只在用户打字时查（聚焦时框里是当前网址，不弹）；只认最后一次请求的结果
  const [typed, setTyped] = useState(false);
  const [suggest, setSuggest] = useState<BrowserHistoryItem[]>([]);
  const [active, setActive] = useState(-1);
  const suggestSeq = useRef(0);
  useEffect(() => {
    const seq = ++suggestSeq.current;
    const q = url.trim();
    if (!editing || !typed || !q) {
      setSuggest([]);
      setActive(-1);
      return;
    }
    const t = window.setTimeout(() => {
      api.browserHistory(profile, q).then(
        (r) => {
          if (seq !== suggestSeq.current) return;
          setSuggest(r.items);
          setActive(-1);
        },
        () => seq === suggestSeq.current && setSuggest([]),
      );
    }, HISTORY_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [url, editing, typed, profile]);
  const showSuggest = editing && typed && suggest.length > 0;
  const pickSuggest = (item: BrowserHistoryItem) => {
    setTyped(false);
    setUrl(item.url);
    void open(item.url);
  };
  // 应用里点的链接：浏览器装好、身份确认存在后再打开；每次点击只打开一次
  const linkSeq = useRef(0);
  const profileReady = !!profiles?.some((p) => p.id === profile);
  useEffect(() => {
    if (!link || !installed || !profileReady || link.seq === linkSeq.current) return;
    linkSeq.current = link.seq;
    setUrl(link.url);
    void open(link.url);
  }, [link, installed, profileReady, open]);
  const nav = (action: 'back' | 'forward' | 'reload') => {
    api.browserNav(profile, action).catch((e: unknown) => say(msg(e), true));
  };

  const onPicked = useCallback((r: BrowserPickResult) => {
    const tag = r.element.tag.toLowerCase();
    if (onPick(r)) say(`已加入输入框：<${tag}>`);
    else say('输入框当前不可用，元素没有加入', true);
  }, [onPick, say]);
  const cancelCapture = useCallback(() => setCapture(false), []);

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
        {installed && status && (
          <ProfileMenu profiles={status.profiles} current={profile} onSelect={setProfile} onCreated={onCreated} onChanged={loadStatus} onError={onError} />
        )}
        <form
          className="cz-br__url"
          onSubmit={(e) => {
            e.preventDefault();
            setTyped(false);
            go();
          }}
        >
          <input
            value={url}
            disabled={!installed}
            placeholder="输入网址或搜索"
            aria-label="地址"
            spellCheck={false}
            autoComplete="off"
            role="combobox"
            aria-expanded={showSuggest}
            aria-controls="cz-br-suggest"
            aria-activedescendant={showSuggest && active >= 0 ? `cz-br-suggest-${active}` : undefined}
            onChange={(e) => {
              setTyped(true);
              setUrl(e.target.value);
            }}
            onFocus={(e) => {
              setEditing(true);
              e.currentTarget.select();
            }}
            onBlur={() => {
              setEditing(false);
              setTyped(false);
            }}
            onKeyDown={(e) => {
              if (showSuggest && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault();
                const n = suggest.length;
                setActive((i) => (e.key === 'ArrowDown' ? (i + 1 >= n ? -1 : i + 1) : i <= -1 ? n - 1 : i - 1));
                return;
              }
              if (showSuggest && e.key === 'Enter' && active >= 0 && suggest[active]) {
                e.preventDefault();
                pickSuggest(suggest[active]);
                return;
              }
              if (showSuggest && e.key === 'Escape') {
                setTyped(false);
                return;
              }
              if (e.key === 'Escape') {
                setEditing(false);
                setUrl(tab && tab.url !== 'about:blank' ? tab.url : '');
                e.currentTarget.blur();
              }
            }}
          />
          {loading && <span className="cz-br__spin" aria-label="正在打开" />}
          {showSuggest && (
            <ul className="cz-br__suggest" id="cz-br-suggest" role="listbox" aria-label="历史记录">
              {suggest.map((item, i) => (
                <li
                  key={item.url}
                  id={`cz-br-suggest-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={i === active ? 'is-on' : undefined}
                  // 按下时不让输入框失焦（失焦会收起列表），松开再打开
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pickSuggest(item)}
                >
                  <span className="cz-br__suggest-title">{item.title || item.url}</span>
                  {item.title && <span className="cz-br__suggest-url">{item.url}</span>}
                </li>
              ))}
            </ul>
          )}
        </form>
        <button
          type="button"
          className="cz-br__btn cz-br__pick"
          title="在独立的 Chrome 窗口里登录（Google 等网站不允许在内置浏览器里登录）；登录好后点「登录完成」回到这里"
          aria-label="窗口登录"
          disabled={!installed || inWindow || windowBusy}
          onClick={() => void openWindow()}
        >
          <Icon name="open-external" size={15} />
          <span>窗口登录</span>
        </button>
        <button
          type="button"
          className={`cz-br__btn cz-br__pick${capture ? ' is-on' : ''}`}
          title={capture ? '退出抓取模式（Esc）' : '抓取模式：点击网页元素加入输入框'}
          aria-label="抓取模式"
          aria-pressed={capture}
          disabled={!installed || inWindow || stream.state !== 'open'}
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
              profile={profile}
              canvasRef={canvasRef}
              stream={stream}
              capture={capture}
              onCancelCapture={cancelCapture}
              onPicked={onPicked}
              onError={onError}
            />
            {inWindow ? (
              <div className="cz-br__overlay">
                <p>正在独立的 Chrome 窗口里登录。登录好后点「登录完成」，窗口会关掉，登录状态带回内置浏览器。</p>
                <button type="button" className="cz-br__action is-primary" disabled={windowBusy} onClick={() => void closeWindow()}>
                  {windowBusy ? '正在保存登录状态…' : '登录完成'}
                </button>
              </div>
            ) : stream.state === 'connecting' && !stream.page ? (
              <div className="cz-br__overlay">正在启动浏览器…</div>
            ) : stream.state === 'closed' && (
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
