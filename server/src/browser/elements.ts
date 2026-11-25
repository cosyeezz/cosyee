// 抓取模式抓到的页面元素：生成一行定位文字（写法见 shared/browserRef），输入框里显示成附件标签。
// 早期版本把描述写成 <cosyee 目录>/browser/elements/element-<毫秒>-<12 位 hex>.md / .png，
// 历史消息里还有这些文件的标签，elementTarget 继续按文件名提供预览。
import fs from 'node:fs';
import path from 'node:path';
import { formatElementRef, type BrowserElement, type BrowserRect } from '@cosyee/shared';
import { cosyeeHome } from '../paths.js';
import { HttpError } from '../workspaces.js';

export const ELEMENT_NAME_RE = /^element-\d{1,16}-[0-9a-f]{12}\.(?:md|png)$/;
const MAX_FILE = 4 * 1024 * 1024;

export function elementsDir(): string {
  return path.join(cosyeeHome(), 'browser', 'elements');
}

/** 在页面里执行的脚本拿回来的原始结果（不可信：字段逐个校验） */
export interface RawPick {
  tag: string;
  label: string;
  selector: string;
  text: string;
  rect: BrowserRect;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  inFrame: boolean;
  inShadow: boolean;
  url: string;
  title: string;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : 0);

export function parseRawPick(v: unknown): RawPick | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const tag = str(o.tag, 64);
  if (!tag) return null;
  return {
    tag,
    label: str(o.label, 200),
    selector: str(o.selector, 1000),
    text: str(o.text, 1000),
    rect: { x: num(o.rect?.x), y: num(o.rect?.y), width: num(o.rect?.width), height: num(o.rect?.height) },
    viewport: { width: num(o.viewport?.width), height: num(o.viewport?.height) },
    scroll: { x: num(o.scroll?.x), y: num(o.scroll?.y) },
    inFrame: o.inFrame === true,
    inShadow: o.inShadow === true,
    url: str(o.url, 2000),
    title: str(o.title, 300),
  };
}

export function toElement(p: RawPick): BrowserElement {
  return {
    url: p.url,
    title: p.title,
    tag: p.tag,
    selector: p.selector,
    text: p.text,
    rect: p.rect,
    viewport: p.viewport,
    scroll: p.scroll,
    inFrame: p.inFrame,
  };
}

/** 插进输入框的定位文字（附件标签发出去就是这一行）：唯一选择器 + 可见文字 + 页面 + 身份 */
export function elementText(p: RawPick, profile: { id: string; name: string }): string {
  return formatElementRef({
    tag: p.tag,
    selector: p.selector,
    text: p.text,
    where: p.inFrame ? 'iframe' : p.inShadow ? 'shadow' : null,
    url: p.url,
    profile,
  });
}

/** 按文件名找回元素文件（会话流里历史标签没有预览令牌）；只认生成的文件名，不跟随符号链接 */
export async function elementTarget(name: string): Promise<{ file: string; size: number; mtime: number; type: string }> {
  if (!ELEMENT_NAME_RE.test(name)) throw new HttpError(404, '文件不存在');
  const file = path.join(elementsDir(), name);
  let st: fs.Stats;
  try {
    st = await fs.promises.lstat(file);
  } catch {
    throw new HttpError(404, '文件不存在');
  }
  if (!st.isFile() || st.size > MAX_FILE) throw new HttpError(404, '文件不存在');
  const type = name.endsWith('.png') ? 'image/png' : 'text/markdown; charset=utf-8';
  return { file, size: st.size, mtime: st.mtimeMs, type };
}

/**
 * 在页面里执行：找 (x, y) 处的元素（会进入 shadow DOM 和同源 iframe），返回描述。
 * hoverOnly 只返回矩形和简短描述（悬停高亮用，要快）。
 */
export function pickScript(x: number, y: number, hoverOnly: boolean): string {
  const args = JSON.stringify({ X: x, Y: y, HOVER: hoverOnly });
  return `(() => {
const { X, Y, HOVER } = ${args};
let doc = document, x = X, y = Y, ox = 0, oy = 0, inFrame = false, inShadow = false;
let el = doc.elementFromPoint(x, y);
for (let i = 0; i < 20 && el; i++) {
  if (el.shadowRoot) {
    const inner = el.shadowRoot.elementFromPoint(x, y);
    if (inner && inner !== el) { el = inner; inShadow = true; continue; }
  }
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
    try {
      const d = el.contentDocument;
      if (d) {
        const r = el.getBoundingClientRect();
        ox += r.left + el.clientLeft; oy += r.top + el.clientTop;
        x = X - ox; y = Y - oy;
        const inner = d.elementFromPoint(x, y);
        if (inner) { el = inner; doc = d; inFrame = true; continue; }
      }
    } catch (e) {}
  }
  break;
}
if (!el) return null;
// 点到按钮 / 链接里的图标、文字时，取外面那个可交互的元素（最多往上 3 层）
const ACT = 'button,a[href],[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="option"],[role="checkbox"],[role="switch"],summary,label,input,select,textarea';
if (!el.matches(ACT)) {
  const up = el.closest(ACT);
  let d = 0;
  for (let n = el; up && n && n !== up && d <= 3; n = n.parentElement) d++;
  if (up && d <= 3) el = up;
}
const r = el.getBoundingClientRect();
const rect = { x: r.left + ox, y: r.top + oy, width: r.width, height: r.height };
const tag = el.tagName.toLowerCase();
const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3) : [];
const label = tag + (el.id ? '#' + el.id : '') + cls.map((c) => '.' + c).join('');
if (HOVER) return { tag, label, rect };
const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\\w-]/g, '\\\\$&'));
const q = (v) => '"' + String(v).replace(/["\\\\]/g, '\\\\$&') + '"';
const root = el.getRootNode();
const uniq = (sel, n) => { try { const l = root.querySelectorAll(sel); return l.length === 1 && l[0] === n; } catch (e) { return false; } };
// 生成的 id / class（React useId、CSS Modules、styled-components、带长数字的）换个版本就变，不拿来定位
const okId = (s) => !!s && s.length <= 64 && !/^\\d|:|\\d{4,}|^[0-9a-f]{8,}$/i.test(s);
const okCls = (c) => c.length >= 3 && c.length <= 48 && !/[:\\[\\]\\/!@]/.test(c) && !/\\d{3,}/.test(c)
  && !/^(?:css|sc|jsx|svelte|emotion)-/.test(c) && !/[_-](?=[a-z0-9]*\\d)(?=[a-z0-9]*[a-z])[a-z0-9]{5,}$/i.test(c)
  && !/^(?:is|has)-|^(?:active|selected|open|hover|focus|focused|disabled|checked|current)$/.test(c);
// 一个元素自己的候选写法，按稳定程度排：id > 测试标记 > 语义属性 > class
const cands = (n) => {
  const t = n.tagName.toLowerCase(), out = [];
  if (okId(n.id)) out.push('#' + esc(n.id));
  for (const a of ['data-testid', 'data-test', 'data-cy', 'data-qa']) { const v = n.getAttribute(a); if (v) out.push('[' + a + '=' + q(v) + ']'); }
  for (const a of ['aria-label', 'name', 'placeholder', 'title', 'alt']) { const v = n.getAttribute(a); if (v && v.length <= 80) out.push(t + '[' + a + '=' + q(v) + ']'); }
  const href = n.getAttribute('href');
  if (t === 'a' && href && href.length <= 120 && !/^javascript:/i.test(href)) out.push('a[href=' + q(href) + ']');
  const cls = (n.getAttribute('class') || '').trim().split(/\\s+/).filter(okCls).sort((a, b) => b.length - a.length).slice(0, 4);
  for (const c of cls) out.push('.' + esc(c));
  for (let i = 0; i < cls.length; i++) for (let j = i + 1; j < cls.length; j++) out.push('.' + esc(cls[i]) + '.' + esc(cls[j]));
  for (const c of cls) out.push(t + '.' + esc(c));
  return out;
};
const anchorOf = (n) => cands(n).find((s) => uniq(s, n)) || '';
let selector = anchorOf(el);
if (!selector) {
  // 最近的有唯一写法的祖先 + 元素自己的简短写法
  const local = cands(el).concat([el.tagName.toLowerCase()]);
  for (let a = el.parentElement, d = 0; a && d < 8; a = a.parentElement, d++) {
    const anchor = anchorOf(a);
    if (!anchor) continue;
    selector = local.map((l) => anchor + ' ' + l).find((s) => uniq(s, el)) || '';
    break; // 再往上的祖先范围只会更大
  }
}
if (!selector) {
  // 兜底：从元素往上按位置一层层写，遇到有唯一写法的祖先就停
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && parts.length < 12) {
    let part = n.tagName.toLowerCase();
    if (n !== el) {
      const a = anchorOf(n);
      if (a) { parts.unshift(a); break; }
    }
    const p = n.parentElement;
    if (p) {
      const same = Array.from(p.children).filter((c) => c.tagName === n.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
    }
    parts.unshift(part);
    if (!p || n.tagName === 'BODY' || n.tagName === 'HTML') break;
    n = p;
  }
  selector = parts.join(' > ');
}
const text = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 1000);
return {
  tag, label, selector, text, rect, inFrame, inShadow,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  scroll: { x: window.scrollX, y: window.scrollY },
  url: location.href, title: document.title,
};
})()`;
}

