// 应用里的 http(s) 链接默认在内置浏览器面板里打开：点击时发 cosyee:browser-open 事件，MainApp 收下后打开面板并跳过去。
// 按住 Shift / ⌘ / Ctrl / Alt 点击、中键点击，或者没有面板收下（事件没被 preventDefault）时，链接照原来的方式打开。
import type { MouseEvent } from 'react';

export const BROWSER_OPEN_EVENT = 'cosyee:browser-open';

/** cosyee:browser-open 事件的 detail */
export interface BrowserOpenDetail {
  url: string;
}

/** 交给面板打开的链接：seq 每次点击加一，同一个地址再点一次也会重新打开 */
export interface BrowserLink {
  url: string;
  seq: number;
}

const WEB_HREF = /^https?:/i;

/** 链接的 onClick：普通左键点 http(s) 链接时交给内置浏览器面板，面板收下了就取消链接默认的打开方式 */
export function openInBrowserPanel(e: MouseEvent<HTMLElement>, href: string | undefined): void {
  if (!href || !WEB_HREF.test(href)) return;
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const ev = new CustomEvent<BrowserOpenDetail>(BROWSER_OPEN_EVENT, { detail: { url: href }, cancelable: true });
  if (!window.dispatchEvent(ev)) e.preventDefault();
}
