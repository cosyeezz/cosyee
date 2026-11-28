// 兼容旧版桌面客户端标题栏（client/src-tauri/src/titlebar.js）：
// 旧版客户端已编译进安装包，没有 data-cosyee-titlebar 属性，也没有 #t 两步验证按钮，
// 但会挂载带 open shadowRoot 的 <cosyee-titlebar> 且内含 #b（内置浏览器按钮）。
// 本模块负责检测标题栏是否存在、在缺失 #t 时幂等地将 2FA 按钮注入到 #b 左侧，并同步打开态。

/** 与 client/src-tauri/src/titlebar.js 的 I.twofa / icon('twofa') 逐字节一致 */
export const TWOFA_TITLEBAR_SVG =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M12 3.2 5.2 6v5.2c0 4.5 2.9 7.8 6.8 9.3 3.9-1.5 6.8-4.8 6.8-9.3V6z"/>'
  + '<circle cx="12" cy="10" r="2"/>'
  + '<path d="M12 12v4.2M12 14.5h1.8"/>'
  + '</svg>';

const COMPAT_STYLE_ID = '__cosyee_twofa_compat_style';
const COMPAT_CSS = [
  '#t{transition:background-color .14s,color .14s,transform .12s cubic-bezier(.16,1,.3,1),box-shadow .14s}',
  '#t:hover{background:var(--_hover);color:var(--_fg)}',
  '#t:active{transform:scale(.92)}',
  '#t[aria-pressed=true]{background:color-mix(in srgb,var(--_accent) 16%,transparent);color:var(--_accent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--_accent) 32%,transparent)}',
  '#t[aria-pressed=true]:hover{background:color-mix(in srgb,var(--_accent) 22%,transparent);color:var(--_accent)}',
].join('\n');

/** 页面是否存在客户端标题栏（新版有 data-cosyee-titlebar="1"，旧版有 <cosyee-titlebar> 元素） */
export function hasCosyeeTitlebar(doc: Document = document): boolean {
  if (typeof doc === 'undefined') return false;
  return doc.documentElement?.dataset.cosyeeTitlebar === '1' || !!doc.querySelector('cosyee-titlebar');
}

/**
 * 若存在 <cosyee-titlebar> 且其 shadowRoot 有 #b 但没有 #t，则在 #b 之前注入兼容 2FA 按钮。
 * 若新版标题栏已原生带 #t，则什么都不做。可安全重复调用（幂等 / HMR 安全）。
 */
export function ensureTitlebarTwoFaButton(isOpen: boolean, doc: Document = document): boolean {
  const host = doc.querySelector('cosyee-titlebar');
  const sr = host?.shadowRoot;
  if (!sr) return false;

  const existing = sr.getElementById('t');
  if (existing) {
    if (existing.getAttribute('data-cosyee-injected') === '1') {
      existing.setAttribute('aria-pressed', String(isOpen));
    }
    return true;
  }

  const browserBtn = sr.getElementById('b');
  if (!browserBtn || !browserBtn.parentNode) return false;

  if (!sr.getElementById(COMPAT_STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = COMPAT_STYLE_ID;
    style.textContent = COMPAT_CSS;
    sr.appendChild(style);
  }

  const btn = doc.createElement('button');
  btn.className = 'ib';
  btn.id = 't';
  btn.type = 'button';
  btn.setAttribute('aria-label', '两步验证');
  btn.setAttribute('aria-pressed', String(isOpen));
  btn.title = '两步验证';
  btn.setAttribute('data-cosyee-injected', '1');
  btn.innerHTML = TWOFA_TITLEBAR_SVG;
  btn.onclick = () => {
    window.dispatchEvent(new CustomEvent('cosyee:2fa'));
  };

  browserBtn.parentNode.insertBefore(btn, browserBtn);
  return true;
}

/** 同步已注入兼容按钮的 aria-pressed 状态（原生新版按钮由 titlebar.js 监听 cosyee:2fa-state 自行维护） */
export function syncInjectedTitlebarState(isOpen: boolean, doc: Document = document): void {
  const sr = doc.querySelector('cosyee-titlebar')?.shadowRoot;
  const btn = sr?.getElementById('t');
  if (btn && btn.getAttribute('data-cosyee-injected') === '1') {
    btn.setAttribute('aria-pressed', String(isOpen));
  }
}

/** 持续监听标题栏挂载/属性变化并执行兼容注入，返回清理函数 */
export function installTitlebarTwoFaCompat(
  onHasTitlebar: (present: boolean) => void,
  getOpen: () => boolean,
  doc: Document = document,
): () => void {
  const check = () => {
    const present = hasCosyeeTitlebar(doc);
    onHasTitlebar(present);
    if (present) ensureTitlebarTwoFaButton(getOpen(), doc);
  };

  check();

  const mo = new MutationObserver(check);
  mo.observe(doc.documentElement, {
    attributes: true,
    attributeFilter: ['data-cosyee-titlebar'],
    childList: true,
  });
  if (doc.body) {
    mo.observe(doc.body, { childList: true });
  }

  window.addEventListener('cosyee:browser-ready', check);
  window.addEventListener('load', check);

  return () => {
    mo.disconnect();
    window.removeEventListener('cosyee:browser-ready', check);
    window.removeEventListener('load', check);
  };
}
