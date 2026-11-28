// 屏幕扫码覆盖层：显示冻结的截图，压暗；已识别的二维码提亮可点；也可以拖框选区。
// 识别全部在 Rust 里完成（src-tauri/src/qrscan.rs），本页只负责交互与动画。
// 本页同时是 Rust 之外的开发预览：加 ?mock=1（可选 &n=0|1|2）用假数据在普通浏览器里看效果。
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var shot = $('shot'), boxesEl = $('boxes'), selEl = $('sel'), sizeEl = $('size');
  var hint = $('hint'), hintText = $('hint-text'), toast = $('toast');
  var params = new URLSearchParams(location.search);
  var mock = params.get('mock') !== null;

  // ── 数据源：Tauri 命令 / 开发用假数据 ──
  var api;
  if (mock) {
    api = null; // 等 mock 脚本加载后再赋值
  } else {
    var inv = function (cmd, args) { return window.__TAURI__.core.invoke(cmd, args); };
    api = {
      init: function () { return inv('qr_overlay_init'); },
      ready: function () { return inv('qr_overlay_ready'); },
      crop: function (sel, vp) { return inv('qr_overlay_crop', { sel: sel, viewport: vp }); },
      complete: function (id) { return inv('qr_overlay_complete', { id: id == null ? null : id }); },
      cancel: function () { return inv('qr_overlay_cancel'); }
    };
  }

  var info = null;          // 来自 Rust：{shotUrl, w, h, boxes, auto, total}
  var holes = [];           // 已识别码的 DOM
  var busy = false;         // 正在识别 / 正在收尾，忽略新操作
  var drag = null;          // {x0, y0, x1, y1, moved}
  var missTimer = 0, toastTimer = 0;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function cancel() { if (api) api.cancel().catch(function () {}); }

  // ── 挖洞：背景图与整屏对齐 ──
  function place(el, x, y, w, h) {
    el.style.left = x + 'px'; el.style.top = y + 'px';
    el.style.width = w + 'px'; el.style.height = h + 'px';
    el.style.backgroundPosition = (-x) + 'px ' + (-y) + 'px';
  }
  function syncBg() {
    var s = document.documentElement.style;
    s.setProperty('--bgw', innerWidth + 'px');
    s.setProperty('--bgh', innerHeight + 'px');
    if (info) layoutBoxes();
  }

  function layoutBoxes() {
    var kx = innerWidth / info.w, ky = innerHeight / info.h;
    holes.forEach(function (h) {
      var b = h.box, pad = 10;
      var x = Math.max(0, b.x * kx - pad), y = Math.max(0, b.y * ky - pad);
      var w = Math.min(innerWidth - x, b.w * kx + pad * 2), hh = Math.min(innerHeight - y, b.h * ky + pad * 2);
      place(h.el, x, y, w, hh);
      h.el.classList.toggle('up', y + hh + 52 > innerHeight);
    });
  }

  function buildBoxes() {
    info.boxes.forEach(function (b, i) {
      var el = document.createElement('div');
      el.className = 'qr';
      el.style.setProperty('--n', i);
      el.innerHTML = '<span class="tag">点击识别</span>';
      el.dataset.id = b.id;
      boxesEl.appendChild(el);
      holes.push({ el: el, box: b });
    });
    layoutBoxes();
  }

  // ── 完成：命中动画后提交 ──
  async function finishWith(el, id, tagEl) {
    busy = true;
    el.classList.add('hit');
    if (tagEl) tagEl.textContent = '已识别';
    hint.classList.add('ok');
    await sleep(420);
    api.complete(id).catch(function () {});
  }

  // ── 选区 ──
  function rectOf(d) {
    var x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    return { x: x, y: y, w: Math.abs(d.x1 - d.x0), h: Math.abs(d.y1 - d.y0) };
  }
  function showSel(r) {
    selEl.hidden = false;
    place(selEl, r.x, r.y, r.w, r.h);
    var k = info ? info.w / innerWidth : devicePixelRatio;
    sizeEl.textContent = Math.round(r.w * k) + ' × ' + Math.round(r.h * (info ? info.h / innerHeight : devicePixelRatio));
    selEl.classList.toggle('flip', r.y + r.h + 40 > innerHeight);
  }
  function clearSel() {
    clearTimeout(missTimer);
    selEl.hidden = true;
    selEl.className = 'sel';
  }
  function showToast(t) {
    toast.textContent = t;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove('show'); }, 2200);
  }

  function pt(e) { return { x: Math.max(0, Math.min(innerWidth, e.clientX)), y: Math.max(0, Math.min(innerHeight, e.clientY)) }; }

  addEventListener('pointerdown', function (e) {
    if (busy || e.button !== 0 || !info) return;
    var p = pt(e);
    clearSel();
    toast.classList.remove('show');
    drag = { x0: p.x, y0: p.y, x1: p.x, y1: p.y, moved: false, target: e.target.closest && e.target.closest('.qr') };
    document.body.setPointerCapture && document.body.setPointerCapture(e.pointerId);
  });
  addEventListener('pointermove', function (e) {
    if (!drag || busy) return;
    var p = pt(e);
    drag.x1 = p.x; drag.y1 = p.y;
    if (!drag.moved && Math.hypot(drag.x1 - drag.x0, drag.y1 - drag.y0) > 5) {
      drag.moved = true;
      hint.classList.add('away');
      document.body.classList.add('dimmed', 'dragging');
      boxesEl.style.pointerEvents = 'none';
    }
    if (drag.moved) showSel(rectOf(drag));
  });
  addEventListener('pointerup', async function (e) {
    if (!drag || busy) { drag = null; return; }
    var d = drag; drag = null;
    boxesEl.style.pointerEvents = '';
    document.body.classList.remove('dimmed', 'dragging');
    if (!d.moved) {
      // 单击：命中已识别的码就选它
      var el = d.target || (e.target.closest && e.target.closest('.qr'));
      if (el) finishWith(el, Number(el.dataset.id), el.querySelector('.tag'));
      return;
    }
    var r = rectOf(d);
    if (r.w < 12 || r.h < 12) { clearSel(); hint.classList.remove('away'); return; }
    busy = true;
    selEl.classList.add('busy');
    var res = null;
    try { res = await api.crop([r.x, r.y, r.w, r.h], [innerWidth, innerHeight]); } catch (err) { res = null; }
    selEl.classList.remove('busy');
    if (res && res.count > 0) {
      selEl.classList.add('hit');
      hint.classList.remove('away'); hint.classList.add('ok');
      await sleep(420);
      api.complete(null).catch(function () {});
      return;
    }
    // 没识别到：选区抖一下，提示重新框选
    void selEl.offsetWidth;
    selEl.classList.add('miss', 'warn');
    showToast('未识别到二维码，请重新框选');
    hint.classList.remove('away');
    missTimer = setTimeout(function () { selEl.classList.remove('miss'); }, 460);
    busy = false;
  });

  addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); cancel(); } });
  addEventListener('contextmenu', function (e) { e.preventDefault(); cancel(); });
  addEventListener('resize', syncBg);
  addEventListener('dragstart', function (e) { e.preventDefault(); });

  // ── 启动 ──
  async function start() {
    if (mock) {
      await new Promise(function (ok) {
        var s = document.createElement('script');
        s.src = 'qrscan-mock.js'; s.onload = ok; document.head.appendChild(s);
      });
      api = window.__qrMock(Number(params.get('n') == null ? 2 : params.get('n')));
    }
    try { info = await api.init(); } catch (e) { cancel(); return; }
    shot.src = info.shotUrl;
    document.documentElement.style.setProperty('--shot', 'url("' + info.shotUrl + '")');
    syncBg();
    try { await shot.decode(); } catch (e) { /* 解码失败也照常显示 */ }
    buildBoxes();
    if (info.total === 0) hintText.textContent = '拖动框选二维码';
    // 全部屏幕只识别到一个码：由它所在的覆盖层高亮后自动完成
    if (info.auto != null) {
      hintText.textContent = info.boxes.length ? '已识别到二维码' : '已识别到二维码（在另一块屏幕上）';
      hint.classList.add('ok');
      var h = holes.filter(function (x) { return x.box.id === info.auto; })[0];
      if (h) {
        busy = true;
        await sleep(520);
        finishWith(h.el, info.auto, h.el.querySelector('.tag'));
      }
    }
    api.ready().catch(function () {});
  }
  start();
})();
