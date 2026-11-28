// 仅开发预览用（qrscan.html?mock=1）：在普通浏览器里用假截图 + 假识别框跑覆盖层页面。
// ?n=0|1|2 控制“已识别”的二维码个数；框选命中第一个假二维码区域则视为识别成功。
window.__qrMock = function (n) {
  var W = 1920, H = 1080;
  var c = document.createElement('canvas');
  c.width = W; c.height = H;
  var g = c.getContext('2d');
  var bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#2b3a67'); bg.addColorStop(1, '#6b3f7a');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  // 假窗口
  g.fillStyle = '#f4f4f6'; g.fillRect(180, 120, 1100, 760);
  g.fillStyle = '#dcdce2'; g.fillRect(180, 120, 1100, 38);
  g.fillStyle = '#9a9aa5';
  for (var i = 0; i < 14; i++) g.fillRect(220, 200 + i * 38, 360 + (i * 97) % 300, 12);
  // 假二维码：随机模块 + 三个定位角
  function qr(x, y, s, seed) {
    var m = 29, u = s / m, r = seed;
    function rnd() { r = (r * 1103515245 + 12345) & 0x7fffffff; return r / 0x7fffffff; }
    g.fillStyle = '#fff'; g.fillRect(x - u * 2, y - u * 2, s + u * 4, s + u * 4);
    g.fillStyle = '#111';
    for (var a = 0; a < m; a++) for (var b = 0; b < m; b++) if (rnd() > 0.52) g.fillRect(x + a * u, y + b * u, u, u);
    [[0, 0], [m - 7, 0], [0, m - 7]].forEach(function (p) {
      g.fillStyle = '#fff'; g.fillRect(x + p[0] * u - u, y + p[1] * u - u, u * 9, u * 9);
      g.fillStyle = '#111'; g.fillRect(x + p[0] * u, y + p[1] * u, u * 7, u * 7);
      g.fillStyle = '#fff'; g.fillRect(x + p[0] * u + u, y + p[1] * u + u, u * 5, u * 5);
      g.fillStyle = '#111'; g.fillRect(x + p[0] * u + u * 2, y + p[1] * u + u * 2, u * 3, u * 3);
    });
  }
  var q1 = { x: 760, y: 260, s: 290 }, q2 = { x: 1420, y: 560, s: 250 };
  qr(q1.x, q1.y, q1.s, 7); qr(q2.x, q2.y, q2.s, 99);
  g.fillStyle = '#fff'; g.font = '28px sans-serif'; g.fillText('Cosyee', 1420, 200);
  var all = [q1, q2].slice(0, Math.max(0, Math.min(2, n)));
  var boxes = all.map(function (q, i) { return { id: i + 1, x: q.x, y: q.y, w: q.s, h: q.s }; });
  var firstBox = q1;
  return {
    init: function () {
      return Promise.resolve({ shotUrl: c.toDataURL('image/png'), w: W, h: H, boxes: boxes, auto: boxes.length === 1 ? 1 : null, total: boxes.length });
    },
    ready: function () { return Promise.resolve(); },
    crop: function (sel, vp) {
      var kx = W / vp[0], ky = H / vp[1];
      var x = sel[0] * kx, y = sel[1] * ky, w = sel[2] * kx, h = sel[3] * ky;
      var hit = x <= firstBox.x && y <= firstBox.y && x + w >= firstBox.x + firstBox.s && y + h >= firstBox.y + firstBox.s;
      return new Promise(function (r) { setTimeout(function () { r({ count: hit ? 1 : 0 }); }, 350); });
    },
    complete: function (id) { window.__done = { id: id }; document.title = 'done:' + id; return Promise.resolve(true); },
    cancel: function () { window.__done = 'cancel'; document.title = 'cancel'; return Promise.resolve(); }
  };
};
