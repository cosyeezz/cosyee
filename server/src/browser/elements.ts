// 抓取模式抓到的页面元素：描述写成 Markdown 文件（加一张元素截图），输入框里当附件标签，
// 发送时以 `@"<文件路径>"` 交给 Claude，Claude 读到的就是元素的位置 / 选择器 / 文字 / HTML。
// 文件在 <cosyee 目录>/browser/elements/，名字由服务端生成：element-<毫秒>-<12 位 hex>.md / .png。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BrowserElement, BrowserRect } from '@cosyee/shared';
import { cosyeeHome } from '../paths.js';
import { HttpError } from '../workspaces.js';

export const ELEMENT_NAME_RE = /^element-\d{1,16}-[0-9a-f]{12}\.(?:md|png)$/;
const MAX_FILE = 4 * 1024 * 1024;

export function elementsDir(): string {
  return path.join(cosyeeHome(), 'browser', 'elements');
}

export function newElementFiles(now = Date.now()): { md: string; png: string } {
  const dir = elementsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = `element-${now}-${crypto.randomBytes(6).toString('hex')}`;
  return { md: path.join(dir, `${base}.md`), png: path.join(dir, `${base}.png`) };
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
  attrs: Record<string, string>;
  html: string;
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
  const attrs: Record<string, string> = {};
  if (o.attrs && typeof o.attrs === 'object') {
    for (const [k, val] of Object.entries(o.attrs as Record<string, unknown>).slice(0, 20)) {
      if (/^[a-z][a-z0-9-]{0,40}$/i.test(k) && typeof val === 'string' && val) attrs[k] = val.slice(0, 300);
    }
  }
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
    attrs,
    html: str(o.html, 4000),
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

/** 反引号围栏：内容里有 ``` 时加长 */
function fence(body: string, lang = ''): string {
  let f = '```';
  while (body.includes(f)) f += '`';
  return `${f}${lang}\n${body}\n${f}`;
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** POSIX shell 单引号转义 */
export const shellQuote = (s: string): string => (/^[\w./:@=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** 元素描述（给 Claude 读的 Markdown） */
export function elementMarkdown(p: RawPick, opts: { png: string | null; cli: string[] | null }): string {
  const r = p.rect;
  const lines = [
    '# 内置浏览器里抓取的页面元素',
    '',
    `- 页面：${oneLine(p.title) || '（无标题）'}`,
    `- 地址：${p.url}`,
    `- 元素：\`<${p.tag}>\`${p.label ? `（${oneLine(p.label)}）` : ''}`,
    `- CSS 选择器：\`${p.selector}\`${p.inFrame ? '（在 iframe 内，相对 iframe 文档）' : ''}${p.inShadow ? '（在 shadow DOM 内）' : ''}`,
    `- 位置（视口坐标，CSS 像素）：x=${r.x}, y=${r.y}, 宽=${r.width}, 高=${r.height}；中心点 (${Math.round(r.x + r.width / 2)}, ${Math.round(r.y + r.height / 2)})`,
    `- 视口：${p.viewport.width}×${p.viewport.height}，页面滚动位置：(${p.scroll.x}, ${p.scroll.y})`,
  ];
  if (p.text) lines.push(`- 可见文字：${oneLine(p.text)}`);
  const attrs = Object.entries(p.attrs);
  if (attrs.length) lines.push(`- 属性：${attrs.map(([k, v]) => `${k}="${oneLine(v)}"`).join(' ')}`);
  if (opts.png) lines.push(`- 元素截图：${opts.png}`);
  if (p.html) lines.push('', '## HTML（可能已截断）', '', fence(p.html, 'html'));
  if (opts.cli) {
    lines.push(
      '',
      '## 在同一个浏览器里继续操作',
      '',
      '这个浏览器由 cosyee 用 agent-browser 驱动，登录状态与用户在 cosyee 里看到的一致。用下面的命令操作同一个页面'
        + '（参数要原样带上，换了参数会重启浏览器、丢掉当前页面）：',
      '',
      fence(
        [
          `${opts.cli.map(shellQuote).join(' ')} snapshot -i`,
          `${opts.cli.map(shellQuote).join(' ')} click ${shellQuote(p.selector)}`,
        ].join('\n'),
        'sh',
      ),
    );
  }
  return lines.join('\n') + '\n';
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
 * mark 非空时给元素加 data-cosyee-pick=<mark>，方便随后按选择器截图（截完再去掉）。
 * hoverOnly 只返回矩形和简短描述（悬停高亮用，要快）。
 */
export function pickScript(x: number, y: number, mark: string | null, hoverOnly: boolean): string {
  const args = JSON.stringify({ X: x, Y: y, MARK: mark, HOVER: hoverOnly });
  return `(() => {
const { X, Y, MARK, HOVER } = ${args};
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
const r = el.getBoundingClientRect();
const rect = { x: r.left + ox, y: r.top + oy, width: r.width, height: r.height };
const tag = el.tagName.toLowerCase();
const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 3) : [];
const label = tag + (el.id ? '#' + el.id : '') + cls.map((c) => '.' + c).join('');
if (HOVER) return { tag, label, rect };
const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^\\w-]/g, '\\\\$&'));
const unique = (sel) => { try { return el.getRootNode().querySelectorAll(sel).length === 1; } catch (e) { return false; } };
let selector = '';
if (el.id && unique('#' + esc(el.id))) selector = '#' + esc(el.id);
else {
  const parts = [];
  let n = el;
  while (n && n.nodeType === 1 && parts.length < 12) {
    let part = n.tagName.toLowerCase();
    if (n.id && n !== el) {
      const s = '#' + esc(n.id);
      try { if (n.getRootNode().querySelectorAll(s).length === 1) { parts.unshift(s); break; } } catch (e) {}
    }
    const p = n.parentElement;
    if (p) {
      const same = Array.from(p.children).filter((c) => c.tagName === n.tagName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
    }
    parts.unshift(part);
    if (!p || n.tagName === 'HTML') break;
    n = p;
  }
  selector = parts.join(' > ');
}
const attrs = {};
for (const k of ['id', 'class', 'name', 'type', 'role', 'aria-label', 'href', 'src', 'alt', 'title', 'placeholder', 'value', 'data-testid']) {
  const v = k === 'value' ? (el.value != null && typeof el.value === 'string' && el.type !== 'password' ? el.value : '') : el.getAttribute(k);
  if (v) attrs[k] = String(v);
}
const html = (el.outerHTML || '').slice(0, 4000);
const text = ((el.innerText || el.textContent || '') + '').replace(/\\s+/g, ' ').trim().slice(0, 1000);
if (MARK) el.setAttribute('data-cosyee-pick', MARK);
return {
  tag, label, selector, text, rect, attrs, html, inFrame, inShadow,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  scroll: { x: window.scrollX, y: window.scrollY },
  url: location.href, title: document.title,
};
})()`;
}

export function unmarkScript(mark: string): string {
  return `(() => { for (const e of document.querySelectorAll('[data-cosyee-pick=${JSON.stringify(mark)}]')) e.removeAttribute('data-cosyee-pick'); return true; })()`;
}
