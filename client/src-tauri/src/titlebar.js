// 注入到每个页面（本地服务器列表页 + 服务端网页）的客户端外壳脚本。
// 桌面端：窗口去掉系统标题栏和菜单栏，换成这里画的一行标题栏（菜单 / 当前服务器 / 窗口按钮）。
//   - 标题栏放在 Shadow DOM 里，不受页面样式影响；颜色直接取页面的设计变量（--bg-sidebar、--text …），
//     所以服务端网页切换深浅主题时标题栏自动跟着变；页面没有这些变量时按 data-theme / 背景亮度兜底。
//   - 页面整体下移一个标题栏高度（html 的 padding-top），并暴露 --cosyee-titlebar-h 给页面自己用。
//   - 只调用窗口相关的接口（最小化 / 最大化 / 关闭 / 拖动），远程页面也只开放了这些权限。
// 手机端：没有标题栏，只保留左边缘「回到服务器列表」小标签。
// __HOME__ / __OS__ 由 lib.rs 替换。
(function () {
  'use strict';
  if (window.__cosyeeShell || window.top !== window) return;
  window.__cosyeeShell = true;

  var HOME = '__HOME__';
  var OS = '__OS__';
  var H = 38;
  var isHome = location.href.indexOf(HOME) === 0;
  var mobile = OS === 'android' || OS === 'ios';
  var mac = OS === 'macos';

  /** 页面当前是深色还是浅色：优先 data-theme，其次背景亮度 */
  function pageTheme() {
    var root = document.documentElement;
    var t = root && root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    try {
      var el = document.body || root;
      var c = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (c && (c.length < 4 || Number(c[3]) > 0)) {
        var l = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
        return l > 0.55 ? 'light' : 'dark';
      }
    } catch (e) { /* 忽略 */ }
    return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  function goList(extra) {
    location.href = HOME + 'index.html?list=1&theme=' + pageTheme() + (extra || '');
  }

  window.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      goList();
    }
  }, true);

  function whenReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  // ───────────── 手机：左边缘小标签 ─────────────
  if (mobile) {
    whenReady(function () {
      if (isHome || document.getElementById('__cosyee_back')) return;
      var b = document.createElement('div');
      b.id = '__cosyee_back';
      b.textContent = '‹';
      b.title = '回到服务器列表';
      b.setAttribute('style', 'position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:2147483647;width:20px;height:56px;'
        + 'display:flex;align-items:center;justify-content:center;font:24px/1 sans-serif;color:#fff;background:rgba(74,144,226,.55);'
        + 'border-radius:0 10px 10px 0;opacity:.45;cursor:pointer;user-select:none;-webkit-user-select:none;');
      b.onclick = function () { goList(); };
      (document.body || document.documentElement).appendChild(b);
    });
    return;
  }

  // ───────────── 桌面：单行标题栏 ─────────────
  var I = {
    menu: '<path d="M4 7h16M4 12h16M4 17h10"/>',
    list: '<rect x="3.5" y="4" width="17" height="6.5" rx="2"/><rect x="3.5" y="13.5" width="17" height="6.5" rx="2"/><path d="M7.5 7.25h.01M7.5 16.75h.01"/>',
    reload: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4h-4"/>',
    power: '<path d="M12 3.5v8"/><path d="M7.05 6.6a7.5 7.5 0 1 0 9.9 0"/>',
    server: '<rect x="3.5" y="4.5" width="17" height="11" rx="2"/><path d="M8.5 19.5h7M12 15.5v4"/>',
    swap: '<path d="M8 9.5 12 5.5l4 4M8 14.5l4 4 4-4"/>'
  };
  function icon(name) {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[name] + '</svg>';
  }
  var LOGO = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M17.26 8.18A6.5 6.5 0 1 0 17.26 15.82" fill="none" stroke="var(--_accent)" stroke-width="2.6" stroke-linecap="round"/><circle cx="19" cy="12" r="1.55" fill="var(--_accent)"/></svg>';
  // Windows 风格的窗口按钮：10px 细线图标
  var WIN = {
    min: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M0 5.5h10" stroke="currentColor" stroke-width="1"/></svg>',
    max: '<svg viewBox="0 0 10 10" width="10" height="10"><rect x=".5" y=".5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1"/></svg>',
    restore: '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1"><rect x=".5" y="2.5" width="7" height="7" rx="1"/><path d="M2.5 2.5V1.5a1 1 0 0 1 1-1h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-1"/></svg>',
    close: '<svg viewBox="0 0 10 10" width="10" height="10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" stroke-width="1"/></svg>'
  };
  var KEY = mac ? '⌘⇧L' : 'Ctrl+Shift+L';
  var RELOAD_KEY = mac ? '⌘R' : 'Ctrl+R';

  var CSS = [
    ':host{all:initial;position:fixed;inset:0 0 auto 0;height:' + H + 'px;z-index:2147483646;display:block;',
    '  --_bg:var(--bg-sidebar,#141210);--_fg:var(--text,#ece9e5);--_fg2:var(--text-2,#bcb8b4);--_fg3:var(--text-3,#94908b);',
    '  --_line:var(--border,#2e2b28);--_hover:var(--bg-hover,#302d2a);--_menu:var(--bg-menu,#2a2723);--_accent:var(--accent,#4a90e2);',
    '  --_g-fill:var(--glass-fill,linear-gradient(180deg,rgb(255 246 236/.095),rgb(255 246 236/.04) 60%,rgb(255 246 236/.055)));',
    '  --_g-edge:var(--glass-edge,rgb(255 244 232/.1));--_g-hi:var(--glass-hi,rgb(255 255 255/.1));--_g-lo:var(--glass-lo,rgb(0 0 0/.28));',
    '  --_shadow:0 1px 2px rgb(0 0 0/.3),0 18px 40px -12px rgb(0 0 0/.6);',
    '  font:13px/1 Inter,"Noto Sans SC","Source Han Sans SC","Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;',
    '  -webkit-font-smoothing:antialiased;color:var(--_fg);user-select:none;-webkit-user-select:none}',
    ':host([data-tone=light]){--_bg:var(--bg-sidebar,#f2f0eb);--_fg:var(--text,#1f1f1f);--_fg2:var(--text-2,#4b4b4b);--_fg3:var(--text-3,#7a7a7a);',
    '  --_line:var(--border,#e3dfd6);--_hover:var(--bg-hover,#ece9e2);--_menu:var(--bg-menu,#fff);--_accent:var(--accent,#2f6fd1);',
    '  --_g-fill:var(--glass-fill,linear-gradient(180deg,rgb(255 255 255/.98),rgb(255 255 255/.78)));',
    '  --_g-edge:var(--glass-edge,rgb(60 40 20/.09));--_g-hi:var(--glass-hi,#fff);--_g-lo:var(--glass-lo,rgb(60 40 20/.05));',
    '  --_shadow:0 1px 2px rgb(60 40 20/.08),0 18px 40px -14px rgb(60 40 20/.28)}',
    '*{box-sizing:border-box}',
    'button{font:inherit;color:inherit;background:none;border:0;margin:0;padding:0;cursor:default;-webkit-app-region:no-drag}',
    'button:focus-visible{outline:2px solid var(--_accent);outline-offset:-2px}',
    '.bar{display:flex;align-items:center;height:100%;padding-left:' + (mac ? 84 : 6) + 'px;background:var(--_bg);',
    '  border-bottom:1px solid var(--_line);transition:background-color .2s,border-color .2s}',
    '.ib{display:grid;place-items:center;width:30px;height:28px;border-radius:8px;color:var(--_fg3);',
    '  transition:background-color .12s,color .12s}',
    '.ib:hover,.ib[aria-expanded=true]{background:var(--_hover);color:var(--_fg)}',
    '.brand{display:flex;align-items:center;gap:7px;margin-left:6px;font-weight:600;letter-spacing:.01em;color:var(--_fg)}',
    '.sep{margin:0 2px 0 8px;color:var(--_fg3);opacity:.6;font-weight:300}',
    '.crumb{display:flex;align-items:center;gap:6px;height:26px;max-width:min(320px,40vw);padding:0 6px 0 8px;border-radius:7px;',
    '  color:var(--_fg2);transition:background-color .12s,color .12s}',
    '.crumb:hover{background:var(--_hover);color:var(--_fg)}',
    '.crumb span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.crumb svg{flex:none;color:var(--_fg3)}',
    '.crumb .sw{width:14px;height:14px;opacity:.7}',
    '.grow{flex:1;align-self:stretch}',
    '.win{display:flex;align-self:stretch}',
    '.wb{display:grid;place-items:center;width:46px;height:100%;color:var(--_fg2);transition:background-color .1s,color .1s}',
    '.wb:hover{background:var(--_hover);color:var(--_fg)}',
    '.wb.close:hover{background:#c42b1c;color:#fff}',
    '.wb:active{opacity:.8}',
    /* 菜单：磨砂玻璃面板 + 跟随悬停项滑动的液态胶囊 */
    '.menu{position:absolute;top:' + (H + 4) + 'px;left:' + (mac ? 80 : 6) + 'px;min-width:232px;padding:5px;border-radius:12px;',
    '  background:color-mix(in srgb,var(--_menu) 84%,transparent);border:1px solid var(--_line);',
    '  -webkit-backdrop-filter:blur(22px) saturate(1.4);backdrop-filter:blur(22px) saturate(1.4);',
    '  box-shadow:inset 0 1px 0 var(--_g-hi),var(--_shadow);transform-origin:14px 0;',
    '  opacity:0;transform:translateY(-4px) scale(.97);filter:blur(2px);visibility:hidden;pointer-events:none;',
    '  transition:opacity .16s cubic-bezier(.16,1,.3,1),transform .22s cubic-bezier(.16,1,.3,1),filter .16s,visibility 0s linear .22s}',
    '.menu.open{opacity:1;transform:none;filter:none;visibility:visible;pointer-events:auto;transition-delay:0s}',
    '.cap{position:absolute;top:0;left:0;border-radius:8px;background:var(--_g-fill);border:1px solid var(--_g-edge);',
    '  box-shadow:inset 0 1px 0 var(--_g-hi),inset 0 -1px 0 var(--_g-lo),0 1px 2px rgb(0 0 0/.12);opacity:0;pointer-events:none;',
    '  transition:opacity .18s}',
    '.cap.on{opacity:1}',
    '.mi{position:relative;z-index:1;display:flex;align-items:center;gap:10px;width:100%;height:34px;padding:0 10px;border-radius:8px;',
    '  color:var(--_fg2);text-align:left;outline:none}',
    '.mi:focus-visible{outline:none}',
    '.mi.hot{color:var(--_fg)}',
    '.mi svg{flex:none;color:var(--_fg3);transition:color .12s}',
    '.mi.hot svg{color:var(--_fg)}',
    '.mi .k{margin-left:auto;padding-left:18px;font-size:11.5px;color:var(--_fg3);font-variant-numeric:tabular-nums;letter-spacing:.02em}',
    '.mi.danger.hot,.mi.danger.hot svg{color:var(--danger,#ff5d5d)}',
    '.hr{height:1px;margin:5px 8px;background:var(--_line)}',
    '@media (prefers-reduced-motion:reduce){.menu,.cap{transition:none}}'
  ].join('\n');

  var host, root, bar, menu, cap, maxBtn, hot = -1, items = [];

  function serverLabel() {
    var h = location.hostname;
    if (h === '127.0.0.1' || h === 'localhost' || h === '[::1]') return '本机';
    if (/^[\d.]+$/.test(h)) return h;
    return h.split('.')[0] || h;
  }

  function build() {
    host = document.createElement('cosyee-titlebar');
    root = host.attachShadow({ mode: 'open' });
    var html = '<style>' + CSS + '</style>'
      + '<div class="bar" data-tauri-drag-region="deep">'
      + '<button class="ib" id="m" aria-label="菜单" aria-haspopup="menu" aria-expanded="false" title="菜单">' + icon('menu') + '</button>'
      + '<span class="brand">' + LOGO + 'Cosyee</span>';
    if (!isHome) {
      html += '<span class="sep">/</span>'
        + '<button class="crumb" id="c" title="' + location.origin + ' — 切换服务器（' + KEY + '）">'
        + icon('server') + '<span></span>' + icon('swap').replace('<svg ', '<svg class="sw" ') + '</button>';
    }
    html += '<div class="grow"></div>';
    if (!mac) {
      html += '<div class="win">'
        + '<button class="wb" id="w-min" aria-label="最小化" title="最小化">' + WIN.min + '</button>'
        + '<button class="wb" id="w-max" aria-label="最大化" title="最大化">' + WIN.max + '</button>'
        + '<button class="wb close" id="w-close" aria-label="关闭" title="关闭">' + WIN.close + '</button>'
        + '</div>';
    }
    html += '</div>'
      + '<div class="menu" role="menu" aria-label="Cosyee"><span class="cap" aria-hidden="true"></span>'
      + '<button class="mi" role="menuitem" data-a="list">' + icon('list') + '服务器列表<span class="k">' + KEY + '</span></button>'
      + '<button class="mi" role="menuitem" data-a="reload">' + icon('reload') + '重新加载<span class="k">' + RELOAD_KEY + '</span></button>'
      + '<div class="hr" role="separator"></div>'
      + '<button class="mi danger" role="menuitem" data-a="stop">' + icon('power') + '停止本机服务</button>'
      + '</div>';
    root.innerHTML = html;
    bar = root.querySelector('.bar');
    menu = root.querySelector('.menu');
    cap = root.querySelector('.cap');
    items = Array.prototype.slice.call(root.querySelectorAll('.mi'));
    var crumb = root.getElementById('c');
    if (crumb) {
      crumb.querySelector('span').textContent = serverLabel();
      crumb.onclick = function () { goList(); };
    }
    root.getElementById('m').onclick = function () { toggle(); };
    items.forEach(function (b, i) {
      b.addEventListener('pointerenter', function () { setHot(i); });
      b.onclick = function () { run(b.getAttribute('data-a')); };
    });
    menu.addEventListener('pointerleave', function () { setHot(-1); });
    menu.addEventListener('keydown', onMenuKey);
    if (!mac) {
      maxBtn = root.getElementById('w-max');
      root.getElementById('w-min').onclick = function () { win('minimize'); };
      maxBtn.onclick = function () { win('toggleMaximize'); };
      root.getElementById('w-close').onclick = function () { win('close'); };
      window.addEventListener('resize', syncMax);
      syncMax();
    }
  }

  function tauriWindow() {
    var T = window.__TAURI__;
    return T && T.window && T.window.getCurrentWindow ? T.window.getCurrentWindow() : null;
  }
  function win(op) {
    var w = tauriWindow();
    if (w) w[op]().catch(function () {});
  }
  var maxTimer = 0;
  function syncMax() {
    clearTimeout(maxTimer);
    maxTimer = setTimeout(function () {
      var w = tauriWindow();
      if (!w || !maxBtn) return;
      w.isMaximized().then(function (m) {
        maxBtn.innerHTML = m ? WIN.restore : WIN.max;
        maxBtn.title = m ? '向下还原' : '最大化';
        maxBtn.setAttribute('aria-label', maxBtn.title);
      }).catch(function () {});
    }, 60);
  }

  // ── 菜单 ──
  function isOpen() { return menu.classList.contains('open'); }
  function toggle(force) {
    var open = force === undefined ? !isOpen() : force;
    menu.classList.toggle('open', open);
    root.getElementById('m').setAttribute('aria-expanded', String(open));
    if (open) { setHot(0, true); items[0].focus({ preventScroll: true }); }
    else { setHot(-1); }
  }
  function run(a) {
    toggle(false);
    if (a === 'list') goList();
    else if (a === 'reload') location.reload();
    else if (a === 'stop') goList('&stop=1');
  }
  function onMenuKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      var n = items.length, i = hot < 0 ? 0 : (hot + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
      setHot(i);
      items[i].focus({ preventScroll: true });
    } else if (e.key === 'Escape') {
      toggle(false);
      root.getElementById('m').focus();
    } else if (e.key === 'Tab') {
      toggle(false);
    }
  }
  document.addEventListener('pointerdown', function (e) {
    if (menu && isOpen() && e.composedPath().indexOf(host) < 0) toggle(false);
  }, true);
  window.addEventListener('blur', function () { if (menu && isOpen()) toggle(false); });

  // 液态胶囊：切换时前沿先到、后沿跟上（沿移动方向拉长），到位后轻微回弹
  var capBox = null, capAnim = null;
  var reduce = matchMedia('(prefers-reduced-motion: reduce)');
  function setHot(i, instant) {
    if (hot >= 0 && items[hot]) items[hot].classList.remove('hot');
    hot = i;
    if (i < 0) { cap.classList.remove('on'); capBox = null; return; }
    var el = items[i];
    el.classList.add('hot');
    var to = { y: el.offsetTop, x: el.offsetLeft, w: el.offsetWidth, h: el.offsetHeight };
    var from = capBox;
    capBox = to;
    cap.style.width = to.w + 'px';
    cap.style.left = to.x + 'px';
    var end = 'translateY(' + to.y + 'px)';
    if (capAnim) capAnim.cancel();
    var wasOn = cap.classList.contains('on');
    cap.classList.add('on');
    if (!from || !wasOn || instant || reduce.matches || !cap.animate) {
      cap.style.height = to.h + 'px';
      cap.style.transform = end;
      return;
    }
    var down = to.y > from.y;
    var top = Math.min(from.y, to.y), span = Math.abs(to.y - from.y) + to.h;
    cap.style.height = to.h + 'px';
    cap.style.transform = end;
    capAnim = cap.animate([
      { transform: 'translateY(' + from.y + 'px)', height: from.h + 'px' },
      { transform: 'translateY(' + (down ? top + span * 0.18 : top) + 'px)', height: (span * 0.82) + 'px', offset: 0.42 },
      { transform: 'translateY(' + (to.y + (down ? 1.5 : -1.5)) + 'px)', height: to.h + 'px', offset: 0.78 },
      { transform: end, height: to.h + 'px' }
    ], { duration: 420, easing: 'cubic-bezier(.3,.7,.2,1)' });
  }

  // ── 主题兜底：页面没有设计变量时按亮度给标题栏定深浅 ──
  function syncTone() {
    if (host) host.setAttribute('data-tone', pageTheme());
  }

  function padStyle() {
    var s = document.getElementById('__cosyee_tb_style');
    if (s) return;
    s = document.createElement('style');
    s.id = '__cosyee_tb_style';
    s.textContent = 'html{--cosyee-titlebar-h:' + H + 'px;padding-top:' + H + 'px!important;box-sizing:border-box!important;scroll-padding-top:' + H + 'px}';
    (document.head || document.documentElement).appendChild(s);
  }

  function mount() {
    var rootEl = document.documentElement;
    if (!rootEl) return;
    padStyle();
    if (!host) build();
    if (!host.isConnected) rootEl.appendChild(host);
    syncTone();
  }

  if (document.documentElement) mount();
  whenReady(function () {
    mount();
    // data-theme / class / style 变化（服务端网页切主题）时同步兜底色调
    new MutationObserver(syncTone).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] });
    if (document.body) new MutationObserver(syncTone).observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
  });
  window.addEventListener('load', mount);
})();
