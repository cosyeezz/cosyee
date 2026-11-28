// 屏幕扫码（仅桌面）：隐藏主窗口 → 截取每块屏幕 → 在 Rust 里识别所有二维码 →
// 每块屏幕开一个全屏覆盖层（本地页面 ui/qrscan.html，显示冻结的截图），
// 用户点选已识别的码或拖框选区 → 在 Rust 里解码选区 → 关闭覆盖层、恢复主窗口、把文本交回网页。
//
// 服务端网页通过 titlebar.js 的 `window.__cosyeeScreenQr.scan()` 调到 `qr_scan_screen`（remote.json 只放行了它）；
// `qr_overlay_*` 只开放给覆盖层窗口（capabilities/qrscan.json）。
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use image::RgbaImage;
use serde::Serialize;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// ───────────────────────── 结果类型 ─────────────────────────

/// 交给网页的结果，与 `__cosyeeScreenQr.scan()` 的返回值同构。
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "status", rename_all = "lowercase")]
pub enum ScanResult {
    Ok { texts: Vec<String> },
    Cancelled,
    Error { message: String },
}

fn err(msg: impl Into<String>) -> ScanResult {
    ScanResult::Error { message: msg.into() }
}

// ───────────────────────── 识别（纯函数，可单测） ─────────────────────────

/// 一个识别到的二维码：截图像素坐标下的外接矩形 + 内容。
#[derive(Clone, Debug)]
pub struct Det {
    pub id: u32,
    pub rect: [u32; 4], // x, y, w, h
    pub text: String,
}

/// 图像转灰度（亮度），顺便把 alpha 当作不透明。
fn to_gray(img: &RgbaImage) -> Vec<u8> {
    img.pixels()
        .map(|p| ((p[0] as u32 * 77 + p[1] as u32 * 150 + p[2] as u32 * 29) >> 8) as u8)
        .collect()
}

/// 对一张灰度图跑一遍 rqrr，返回 (外接矩形, 文本)；坐标乘 `back` 还原到原图尺度。
fn grids_of(gray: &[u8], w: usize, h: usize, back: f32) -> Vec<([u32; 4], String)> {
    if w < 21 || h < 21 {
        return vec![];
    }
    let mut prep = rqrr::PreparedImage::prepare_from_greyscale(w, h, |x, y| gray[y * w + x]);
    let mut out = vec![];
    for g in prep.detect_grids() {
        let Ok((_, text)) = g.decode() else { continue };
        let xs = g.bounds.iter().map(|p| p.x);
        let ys = g.bounds.iter().map(|p| p.y);
        let (x0, x1) = (xs.clone().min().unwrap_or(0).max(0), xs.max().unwrap_or(0).max(0));
        let (y0, y1) = (ys.clone().min().unwrap_or(0).max(0), ys.max().unwrap_or(0).max(0));
        let s = |v: i32| (v as f32 * back).round() as u32;
        out.push(([s(x0), s(y0), s(x1 - x0).max(1), s(y1 - y0).max(1)], text));
    }
    out
}

fn downscale(gray: &[u8], w: usize, h: usize, k: usize) -> (Vec<u8>, usize, usize) {
    let (nw, nh) = (w / k, h / k);
    let mut out = vec![0u8; nw * nh];
    for y in 0..nh {
        for x in 0..nw {
            let mut sum = 0u32;
            for dy in 0..k {
                for dx in 0..k {
                    sum += gray[(y * k + dy) * w + x * k + dx] as u32;
                }
            }
            out[y * nw + x] = (sum / (k * k) as u32) as u8;
        }
    }
    (out, nw, nh)
}

fn overlaps(a: &[u32; 4], b: &[u32; 4]) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

/// 在整张截图里找出所有二维码：原图、反色（浅色码配深色底）、半尺寸（大图 / 网点噪声）各一遍，结果去重合并。
pub fn detect_all(img: &RgbaImage, next_id: &AtomicU32) -> Vec<Det> {
    let (w, h) = (img.width() as usize, img.height() as usize);
    let gray = to_gray(img);
    let mut found: Vec<([u32; 4], String)> = grids_of(&gray, w, h, 1.0);
    let inv: Vec<u8> = gray.iter().map(|v| 255 - v).collect();
    let mut extra = grids_of(&inv, w, h, 1.0);
    if w >= 800 && h >= 600 {
        let (half, hw, hh) = downscale(&gray, w, h, 2);
        extra.extend(grids_of(&half, hw, hh, 2.0));
    }
    for (r, t) in extra {
        if !found.iter().any(|(fr, ft)| *ft == t && overlaps(fr, &r)) {
            found.push((r, t));
        }
    }
    found
        .into_iter()
        .map(|(rect, text)| Det { id: next_id.fetch_add(1, Ordering::Relaxed), rect, text })
        .collect()
}

/// 把覆盖层里的选区（CSS 像素，相对视口）换算到截图像素并夹在图内。
/// 视口与截图的比例按两轴分别算：不依赖系统缩放比，窗口被 DPI 缩放改了尺寸也不会错位。
pub fn map_selection(sel: [f64; 4], viewport: [f64; 2], img: [u32; 2]) -> Option<[u32; 4]> {
    let [vw, vh] = viewport;
    if !(vw > 0.0 && vh > 0.0) || sel.iter().any(|v| !v.is_finite()) {
        return None;
    }
    let (sx, sy) = (img[0] as f64 / vw, img[1] as f64 / vh);
    let x0 = (sel[0] * sx).floor().clamp(0.0, img[0] as f64);
    let y0 = (sel[1] * sy).floor().clamp(0.0, img[1] as f64);
    let x1 = ((sel[0] + sel[2]) * sx).ceil().clamp(0.0, img[0] as f64);
    let y1 = ((sel[1] + sel[3]) * sy).ceil().clamp(0.0, img[1] as f64);
    if x1 - x0 < 4.0 || y1 - y0 < 4.0 {
        return None;
    }
    Some([x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32])
}

/// 解码用户框选的一块区域：补静区（框得太紧时二维码没有留白）、小图放大、几种二值化 / 反色都试一遍。
pub fn decode_crop(img: &RgbaImage, rect: [u32; 4]) -> Vec<String> {
    use image::imageops;
    let [x, y, w, h] = rect;
    if x >= img.width() || y >= img.height() {
        return vec![];
    }
    let (w, h) = (w.min(img.width() - x), h.min(img.height() - y));
    let crop = imageops::crop_imm(img, x, y, w, h).to_image();
    let gray = image::GrayImage::from_raw(w, h, to_gray(&crop)).expect("尺寸一致");
    // 静区底色不能取四角（框得紧时四角正好是定位图案的深色）：浅底 / 深底各补一遍试
    for fill in [255u8, 0u8] {
        let res = decode_padded(&gray, fill);
        if !res.is_empty() {
            return res;
        }
    }
    vec![]
}

/// 在灰度裁剪图四周补 `fill` 色的静区后，按多个放大倍数 / 二值化变体尝试解码。
fn decode_padded(gray: &image::GrayImage, fill: u8) -> Vec<String> {
    use image::imageops::{self, FilterType};
    let (w, h) = gray.dimensions();
    let pad = (w.max(h) / 5).max(12);
    let mut padded = image::GrayImage::from_pixel(w + pad * 2, h + pad * 2, image::Luma([fill]));
    imageops::replace(&mut padded, gray, pad as i64, pad as i64);
    let gray = padded;

    let short = gray.width().min(gray.height());
    // 小图放大到短边 ~600 以上（最多 4 倍），再附带原尺寸
    let mut scales: Vec<f32> = vec![];
    if short >= 240 {
        scales.push(1.0);
    }
    for s in [2.0f32, 3.0, 4.0] {
        if short as f32 * s <= 1800.0 && (short as f32 * s >= 360.0 || s == 4.0) {
            scales.push(s);
        }
    }
    if scales.is_empty() {
        scales.push(1.0);
    }

    for s in scales {
        let g = if s == 1.0 {
            gray.clone()
        } else {
            imageops::resize(&gray, (gray.width() as f32 * s) as u32, (gray.height() as f32 * s) as u32, FilterType::CatmullRom)
        };
        let (gw, gh) = (g.width() as usize, g.height() as usize);
        let raw = g.into_raw();
        // 变体：原样 / 拉伸对比度 / 大津阈值二值化 / 以上的反色
        let (lo, hi) = (*raw.iter().min().unwrap_or(&0), *raw.iter().max().unwrap_or(&255));
        let stretched: Vec<u8> = if hi > lo + 8 {
            raw.iter().map(|&v| (((v - lo) as u32 * 255) / (hi - lo) as u32) as u8).collect()
        } else {
            raw.clone()
        };
        let t = otsu(&raw);
        let binary: Vec<u8> = raw.iter().map(|&v| if v > t { 255 } else { 0 }).collect();
        for v in [&raw, &stretched, &binary] {
            let mut res: Vec<String> = grids_of(v, gw, gh, 1.0).into_iter().map(|(_, t)| t).collect();
            if res.is_empty() {
                let inv: Vec<u8> = v.iter().map(|b| 255 - b).collect();
                res = grids_of(&inv, gw, gh, 1.0).into_iter().map(|(_, t)| t).collect();
            }
            if !res.is_empty() {
                res.dedup();
                let mut seen = std::collections::HashSet::new();
                res.retain(|t| seen.insert(t.clone()));
                return res;
            }
        }
    }
    vec![]
}

/// 大津法求二值化阈值。
fn otsu(data: &[u8]) -> u8 {
    let mut hist = [0u64; 256];
    for &v in data {
        hist[v as usize] += 1;
    }
    let total = data.len() as f64;
    let sum_all: f64 = hist.iter().enumerate().map(|(i, &c)| i as f64 * c as f64).sum();
    let (mut sum_b, mut w_b, mut best, mut thr) = (0.0, 0.0, 0.0, 127u8);
    for (i, &c) in hist.iter().enumerate() {
        w_b += c as f64;
        if w_b == 0.0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0.0 {
            break;
        }
        sum_b += i as f64 * c as f64;
        let (m_b, m_f) = (sum_b / w_b, (sum_all - sum_b) / w_f);
        let between = w_b * w_f * (m_b - m_f) * (m_b - m_f);
        if between > best {
            best = between;
            thr = i as u8;
        }
    }
    thr
}

/// 截图几乎纯色（全黑 / 全白 / 单色）：多半是没拿到屏幕内容（例如 macOS 没给屏幕录制权限）。
fn looks_blank(img: &RgbaImage) -> bool {
    let raw = img.as_raw();
    if raw.len() < 8 {
        return true;
    }
    let first = [raw[0], raw[1], raw[2]];
    img.pixels().step_by(97).all(|p| p.0[..3] == first)
}

fn encode_png(img: &RgbaImage) -> Option<Vec<u8>> {
    use image::codecs::png::{CompressionType, FilterType, PngEncoder};
    use image::{ExtendedColorType, ImageEncoder};
    let mut out = Vec::with_capacity(img.as_raw().len() / 3);
    // 快速压缩：冻结画面要尽快出来，体积不重要（只走本机自定义协议）
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Sub)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgba8)
        .ok()?;
    Some(out)
}

// ───────────────────────── 屏幕截取 ─────────────────────────

/// 一块屏幕在 Tauri 里的物理位置 / 尺寸（覆盖层窗口按它摆放）。
#[derive(Clone, Debug)]
struct MonitorBox {
    pos: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
}

#[cfg(any(windows, target_os = "macos"))]
fn capture_monitor(m: &MonitorBox, scale: f64) -> Result<RgbaImage, String> {
    // 以屏幕中心点找 xcap 的 Monitor：Windows 用物理坐标，macOS 用逻辑（点）坐标
    let (cx, cy) = (m.pos.x + (m.size.width / 2) as i32, m.pos.y + (m.size.height / 2) as i32);
    let found = xcap::Monitor::from_point(cx, cy)
        .or_else(|_| xcap::Monitor::from_point((cx as f64 / scale) as i32, (cy as f64 / scale) as i32))
        .map_err(|e| format!("找不到对应的屏幕：{e}"))?;
    found.capture_image().map_err(|e| format!("截屏失败：{e}"))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn capture_monitor(_: &MonitorBox, _: f64) -> Result<RgbaImage, String> {
    Err("当前系统暂不支持屏幕扫码".into())
}

#[cfg(target_os = "macos")]
mod mac {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGPreflightScreenCaptureAccess() -> bool;
        pub fn CGRequestScreenCaptureAccess() -> bool;
    }
}

const MAC_PERM_MSG: &str = "需要「屏幕录制」权限才能扫描屏幕上的二维码：请到 系统设置 → 隐私与安全性 → 屏幕录制 中允许 Cosyee，然后重新打开客户端再试。";

// ───────────────────────── 会话状态 ─────────────────────────

struct Shot {
    rgba: RgbaImage,
    png: Arc<Vec<u8>>,
    dets: Vec<Det>,
}

struct Session {
    seq: u32,
    shots: Vec<Shot>,
    /// 框选解码出来、等覆盖层动画播完后提交的文本
    candidate: Vec<String>,
    tx: Option<tokio::sync::oneshot::Sender<ScanResult>>,
}

#[derive(Default)]
pub struct QrState {
    busy: AtomicBool,
    seq: AtomicU32,
    session: Mutex<Option<Session>>,
    /// 自定义协议要读的截图（序号 → PNG）
    pngs: Mutex<HashMap<usize, Arc<Vec<u8>>>>,
}

fn finish(app: &AppHandle<impl Runtime>, res: ScanResult) {
    let st = app.state::<QrState>();
    let tx = st.session.lock().ok().and_then(|mut g| g.as_mut().and_then(|s| s.tx.take()));
    if let Some(tx) = tx {
        let _ = tx.send(res);
    }
}

/// 自定义协议 `qrshot`：覆盖层页面用它取冻结的截图（Windows 上是 http://qrshot.localhost/<序号>）。
pub fn shot_protocol<R: Runtime>(app: &AppHandle<R>, path: &str) -> tauri::http::Response<Vec<u8>> {
    let idx = path.trim_matches('/').parse::<usize>().ok();
    let png = idx.and_then(|i| app.state::<QrState>().pngs.lock().ok().and_then(|g| g.get(&i).cloned()));
    let mut b = tauri::http::Response::builder()
        .header("Access-Control-Allow-Origin", "*")
        .header("Cache-Control", "no-store");
    match png {
        Some(p) => {
            b = b.header("Content-Type", "image/png");
            b.body(p.as_ref().clone()).unwrap_or_default()
        }
        None => b.status(404).body(Vec::new()).unwrap_or_default(),
    }
}

#[cfg(windows)]
const SHOT_BASE: &str = "http://qrshot.localhost";
#[cfg(not(windows))]
const SHOT_BASE: &str = "qrshot://localhost";

// ───────────────────────── 主流程 ─────────────────────────

/// 无论怎么退出（正常 / 出错 / 取消 / panic 展开）都关闭覆盖层、恢复主窗口、清掉会话。
struct Restore<R: Runtime> {
    app: AppHandle<R>,
    main: WebviewWindow<R>,
}

impl<R: Runtime> Drop for Restore<R> {
    fn drop(&mut self) {
        let st = self.app.state::<QrState>();
        if let Ok(mut g) = st.session.lock() {
            *g = None;
        };
        if let Ok(mut g) = st.pngs.lock() {
            g.clear();
        };
        for (label, w) in self.app.webview_windows() {
            if label.starts_with("qrscan-") {
                let _ = w.destroy();
            }
        }
        let _ = self.main.show();
        let _ = self.main.unminimize();
        let _ = self.main.set_focus();
        st.busy.store(false, Ordering::SeqCst);
    }
}

/// 网页入口：只允许主窗口调用，同一时间只跑一个扫描。
#[tauri::command]
pub async fn qr_scan_screen<R: Runtime>(app: AppHandle<R>, window: WebviewWindow<R>) -> ScanResult {
    if window.label() != "main" {
        return err("只能在主窗口里扫描屏幕");
    }
    if app.state::<QrState>().busy.swap(true, Ordering::SeqCst) {
        return err("已有一个屏幕扫码正在进行");
    }
    let _restore = Restore { app: app.clone(), main: window.clone() };
    run(&app, &window).await
}

async fn run<R: Runtime>(app: &AppHandle<R>, main: &WebviewWindow<R>) -> ScanResult {
    #[cfg(target_os = "macos")]
    unsafe {
        if !mac::CGPreflightScreenCaptureAccess() {
            // 弹出系统授权提示（只会弹一次）；授权后需要重启应用才生效
            mac::CGRequestScreenCaptureAccess();
            return err(MAC_PERM_MSG);
        }
    }

    let monitors: Vec<(MonitorBox, f64)> = match app.available_monitors() {
        Ok(v) => v
            .iter()
            .map(|m| (MonitorBox { pos: *m.position(), size: *m.size() }, m.scale_factor()))
            .collect(),
        Err(e) => return err(format!("读取屏幕信息失败：{e}")),
    };
    if monitors.is_empty() {
        return err("没有找到可截取的屏幕");
    }

    // 先把主窗口藏起来，等它真的从屏幕上消失（系统的隐藏动画播完）再截图
    let _ = main.hide();
    for _ in 0..20 {
        if main.is_visible().map(|v| !v).unwrap_or(true) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    tokio::time::sleep(Duration::from_millis(if cfg!(target_os = "macos") { 450 } else { 260 })).await;

    let seq = app.state::<QrState>().seq.fetch_add(1, Ordering::SeqCst) + 1;
    let ids = Arc::new(AtomicU32::new(1));
    let mons = monitors.clone();
    let ids2 = ids.clone();
    // 截图 + 识别 + 编码放到阻塞线程，每块屏幕一个线程并行
    let job = tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            std::thread::scope(|s| {
                let hs: Vec<_> = mons
                    .iter()
                    .map(|(m, scale)| {
                        let ids = ids2.clone();
                        s.spawn(move || -> Result<Shot, String> {
                            let mut img = capture_monitor(m, *scale)?;
                            for p in img.pixels_mut() {
                                p[3] = 255;
                            }
                            let dets = detect_all(&img, &ids);
                            let png = encode_png(&img).ok_or("截图编码失败")?;
                            Ok(Shot { rgba: img, png: Arc::new(png), dets })
                        })
                    })
                    .collect();
                hs.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("识别线程异常".into()))).collect::<Vec<_>>()
            })
        }))
    });
    let results = match job.await {
        Ok(Ok(r)) => r,
        _ => return err("截屏过程中出现异常"),
    };

    // 屏幕与截图一一对应；单块失败的跳过，全失败才报错
    let mut shots = vec![];
    let mut boxes = vec![];
    let mut first_err = None;
    for (r, (m, _)) in results.into_iter().zip(monitors.iter()) {
        match r {
            Ok(s) => {
                shots.push(s);
                boxes.push(m.clone());
            }
            Err(e) => first_err = first_err.or(Some(e)),
        }
    }
    if shots.is_empty() {
        return err(first_err.unwrap_or_else(|| "截屏失败".into()));
    }
    if shots.iter().all(|s| looks_blank(&s.rgba)) {
        return err(if cfg!(target_os = "macos") { MAC_PERM_MSG.to_string() } else { "截屏失败：拿到的是一张纯色画面".to_string() });
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    {
        let st = app.state::<QrState>();
        if let Ok(mut g) = st.pngs.lock() {
            g.clear();
            for (i, s) in shots.iter().enumerate() {
                g.insert(i, s.png.clone());
            }
        }
        if let Ok(mut g) = st.session.lock() {
            *g = Some(Session { seq, shots, candidate: vec![], tx: Some(tx) });
        };
    }

    for (i, m) in boxes.iter().enumerate() {
        if let Err(e) = open_overlay(app, i, m) {
            return err(format!("打开扫码界面失败：{e}"));
        }
    }
    // 兜底：页面迟迟不就绪也要把窗口亮出来
    let app2 = app.clone();
    let n = boxes.len();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(2500)).await;
        for i in 0..n {
            if let Some(w) = app2.get_webview_window(&format!("qrscan-{i}")) {
                if !w.is_visible().unwrap_or(true) {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        }
    });

    match tokio::time::timeout(Duration::from_secs(300), rx).await {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => ScanResult::Cancelled,
        Err(_) => ScanResult::Cancelled,
    }
}

fn open_overlay<R: Runtime>(app: &AppHandle<R>, i: usize, m: &MonitorBox) -> tauri::Result<()> {
    let handle = app.clone();
    let url = WebviewUrl::App(format!("qrscan.html?i={i}").into());
    let mut b = WebviewWindowBuilder::new(app, format!("qrscan-{i}"), url);
    // WebView2 要求同一数据目录下所有窗口的浏览器参数一致：main 带了 tailnet 本地代理，覆盖层也必须带上，
    // 否则创建 webview 会报 0x8007139F（实测）。
    if let Some(p) = crate::tailnet::proxy_url() {
        b = b.proxy_url(p);
    }
    let w = b
        .title("Cosyee 屏幕扫码")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(true)
        .background_color(tauri::window::Color(0, 0, 0, 255))
        .build()?;
    // 覆盖层被系统关掉（Alt+F4 等）按取消处理
    w.on_window_event(move |e| {
        if matches!(e, tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed) {
            finish(&handle, ScanResult::Cancelled);
        }
    });
    // 创建时按逻辑坐标只是个大概；按物理坐标再对齐一次（不同 DPI 的屏幕之间移动会让系统改尺寸）
    w.set_position(m.pos)?;
    w.set_size(m.size)?;
    w.set_position(m.pos)?;
    Ok(())
}

// ───────────────────────── 覆盖层命令 ─────────────────────────

fn overlay_index<R: Runtime>(w: &WebviewWindow<R>) -> Result<usize, String> {
    w.label().strip_prefix("qrscan-").and_then(|s| s.parse().ok()).ok_or_else(|| "不是扫码窗口".to_string())
}

#[derive(Serialize)]
pub struct OverlayBox {
    id: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayInit {
    shot_url: String,
    w: u32,
    h: u32,
    boxes: Vec<OverlayBox>,
    /// 全部屏幕合计只识别到一个码时，它的 id（由所在覆盖层自动完成）
    auto: Option<u32>,
    total: usize,
}

#[tauri::command]
pub fn qr_overlay_init<R: Runtime>(window: WebviewWindow<R>, state: tauri::State<'_, QrState>) -> Result<OverlayInit, String> {
    let i = overlay_index(&window)?;
    let g = state.session.lock().map_err(|_| "状态异常")?;
    let s = g.as_ref().ok_or("扫码已结束")?;
    let shot = s.shots.get(i).ok_or("找不到对应的屏幕")?;
    let total: usize = s.shots.iter().map(|x| x.dets.len()).sum();
    let auto = if total == 1 { s.shots.iter().flat_map(|x| x.dets.iter()).next().map(|d| d.id) } else { None };
    Ok(OverlayInit {
        shot_url: format!("{SHOT_BASE}/{i}?s={}", s.seq),
        w: shot.rgba.width(),
        h: shot.rgba.height(),
        boxes: shot.dets.iter().map(|d| OverlayBox { id: d.id, x: d.rect[0], y: d.rect[1], w: d.rect[2], h: d.rect[3] }).collect(),
        auto,
        total,
    })
}

/// 覆盖层画面准备好了：显示并抢焦点（先隐藏创建、就绪再显示，避免闪白）。
#[tauri::command]
pub fn qr_overlay_ready<R: Runtime>(window: WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[derive(Serialize)]
pub struct CropResult {
    /// 选区内识别到的二维码个数（0 表示没识别到）
    count: usize,
}

/// 解码用户框选的区域（选区与视口都是 CSS 像素）。识别到了先存为候选，等页面播完动画再 `qr_overlay_complete`。
#[tauri::command]
pub async fn qr_overlay_crop<R: Runtime>(
    window: WebviewWindow<R>,
    state: tauri::State<'_, QrState>,
    sel: [f64; 4],
    viewport: [f64; 2],
) -> Result<CropResult, String> {
    let i = overlay_index(&window)?;
    let (img, rect) = {
        let g = state.session.lock().map_err(|_| "状态异常")?;
        let s = g.as_ref().ok_or("扫码已结束")?;
        let shot = s.shots.get(i).ok_or("找不到对应的屏幕")?;
        let dim = [shot.rgba.width(), shot.rgba.height()];
        let Some(rect) = map_selection(sel, viewport, dim) else { return Ok(CropResult { count: 0 }) };
        // 只复制选区附近，避免整屏拷贝
        let sub = image::imageops::crop_imm(&shot.rgba, rect[0], rect[1], rect[2], rect[3]).to_image();
        (sub, [0, 0, rect[2], rect[3]])
    };
    let texts = tauri::async_runtime::spawn_blocking(move || decode_crop(&img, rect)).await.map_err(|e| e.to_string())?;
    let count = texts.len();
    if count > 0 {
        if let Ok(mut g) = state.session.lock() {
            if let Some(s) = g.as_mut() {
                s.candidate = texts;
            }
        }
    }
    Ok(CropResult { count })
}

/// 提交结果：`id` 为已识别二维码的编号；不传则提交刚才框选解码出的候选。
#[tauri::command]
pub fn qr_overlay_complete<R: Runtime>(app: AppHandle<R>, state: tauri::State<'_, QrState>, id: Option<u32>) -> bool {
    let texts = {
        let Ok(g) = state.session.lock() else { return false };
        let Some(s) = g.as_ref() else { return false };
        match id {
            Some(id) => s.shots.iter().flat_map(|x| x.dets.iter()).find(|d| d.id == id).map(|d| vec![d.text.clone()]),
            None => Some(s.candidate.clone()).filter(|c| !c.is_empty()),
        }
    };
    match texts {
        Some(texts) => {
            finish(&app, ScanResult::Ok { texts });
            true
        }
        None => false,
    }
}

#[tauri::command]
pub fn qr_overlay_cancel<R: Runtime>(app: AppHandle<R>) {
    finish(&app, ScanResult::Cancelled);
}

// ───────────────────────── 单元测试 ─────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    const PAYLOAD: &str = "otpauth://totp/Example:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";

    /// 用 qrcode 渲染二维码到画布 (ox, oy) 处，module 为每格像素数。
    fn paint_qr(canvas: &mut RgbaImage, text: &str, ox: u32, oy: u32, module: u32, invert: bool) -> u32 {
        let code = qrcode::QrCode::new(text.as_bytes()).unwrap();
        let n = code.width() as u32;
        let colors = code.to_colors();
        let quiet = 4;
        let (dark, light) = if invert { (255u8, 0u8) } else { (0u8, 255u8) };
        for y in 0..(n + quiet * 2) * module {
            for x in 0..(n + quiet * 2) * module {
                let (mx, my) = (x / module, y / module);
                let is_dark = mx >= quiet && my >= quiet && mx < n + quiet && my < n + quiet
                    && colors[((my - quiet) * n + (mx - quiet)) as usize] == qrcode::Color::Dark;
                let v = if is_dark { dark } else { light };
                if ox + x < canvas.width() && oy + y < canvas.height() {
                    canvas.put_pixel(ox + x, oy + y, Rgba([v, v, v, 255]));
                }
            }
        }
        (n + quiet * 2) * module
    }

    /// 带渐变底色的“桌面”画布。
    fn desktop(w: u32, h: u32) -> RgbaImage {
        RgbaImage::from_fn(w, h, |x, y| Rgba([(40 + x * 60 / w) as u8, (60 + y * 50 / h) as u8, 110, 255]))
    }

    /// 走一遍 PNG 编解码，模拟真实截图链路。
    fn via_png(img: &RgbaImage) -> RgbaImage {
        let png = encode_png(img).unwrap();
        image::load_from_memory_with_format(&png, image::ImageFormat::Png).unwrap().to_rgba8()
    }

    #[test]
    fn detects_qr_on_desktop() {
        let mut c = desktop(1600, 900);
        let side = paint_qr(&mut c, PAYLOAD, 400, 200, 5, false);
        let dets = detect_all(&via_png(&c), &AtomicU32::new(1));
        assert_eq!(dets.len(), 1, "{dets:?}");
        assert_eq!(dets[0].text, PAYLOAD);
        let r = dets[0].rect;
        // 外接矩形应落在码的区域内（rqrr 的边界是码本体，不含静区）
        assert!(r[0] >= 400 && r[1] >= 200 && r[0] + r[2] <= 400 + side && r[1] + r[3] <= 200 + side, "{r:?}");
    }

    #[test]
    fn detects_two_codes_and_inverted() {
        let mut c = desktop(1600, 900);
        paint_qr(&mut c, PAYLOAD, 100, 100, 5, false);
        paint_qr(&mut c, "otpauth-migration://offline?data=AAAA", 900, 400, 5, true);
        let dets = detect_all(&c, &AtomicU32::new(1));
        let texts: Vec<_> = dets.iter().map(|d| d.text.as_str()).collect();
        assert!(texts.contains(&PAYLOAD) && texts.contains(&"otpauth-migration://offline?data=AAAA"), "{texts:?}");
    }

    #[test]
    fn crop_at_offset_tight_and_loose() {
        let mut c = desktop(1600, 900);
        let side = paint_qr(&mut c, PAYLOAD, 700, 300, 4, false);
        // 松：比码大一圈
        assert_eq!(decode_crop(&c, [650, 250, side + 100, side + 100]), vec![PAYLOAD.to_string()]);
        // 紧：恰好是码本体（去掉静区），补静区后仍应识别
        let q = 4 * 4;
        assert_eq!(decode_crop(&c, [700 + q, 300 + q, side - 2 * q, side - 2 * q]), vec![PAYLOAD.to_string()]);
    }

    #[test]
    fn crop_small_module_is_upscaled() {
        let mut c = desktop(800, 600);
        let side = paint_qr(&mut c, "otpauth://totp/a?secret=ABC", 50, 60, 2, false);
        assert_eq!(decode_crop(&c, [40, 50, side + 20, side + 20]), vec!["otpauth://totp/a?secret=ABC".to_string()]);
    }

    #[test]
    fn crop_without_code_is_empty() {
        let c = desktop(800, 600);
        assert!(decode_crop(&c, [100, 100, 300, 200]).is_empty());
        assert!(decode_crop(&c, [5000, 5000, 10, 10]).is_empty());
    }

    #[test]
    fn selection_maps_with_hidpi_scale() {
        // 视口 1280x720 CSS 像素，截图 2560x1440（2x）
        assert_eq!(map_selection([100.0, 50.0, 200.0, 200.0], [1280.0, 720.0], [2560, 1440]), Some([200, 100, 400, 400]));
        // 1.5x 且选区带小数
        assert_eq!(map_selection([10.5, 20.25, 100.0, 100.0], [1000.0, 600.0], [1500, 900]), Some([15, 30, 151, 151]));
        // 越界夹紧
        assert_eq!(map_selection([900.0, 500.0, 300.0, 300.0], [1000.0, 600.0], [1000, 600]), Some([900, 500, 100, 100]));
        // 太小 / 非法
        assert_eq!(map_selection([10.0, 10.0, 1.0, 1.0], [1000.0, 600.0], [1000, 600]), None);
        assert_eq!(map_selection([0.0, 0.0, 10.0, 10.0], [0.0, 600.0], [1000, 600]), None);
    }

    #[test]
    fn hidpi_end_to_end_crop() {
        // 2x 截图，用户在 CSS 坐标里框选二维码
        let mut c = desktop(2560, 1440);
        let side = paint_qr(&mut c, PAYLOAD, 1000, 600, 6, false); // 物理像素
        let css = [480.0, 280.0, side as f64 / 2.0 + 40.0, side as f64 / 2.0 + 40.0];
        let rect = map_selection(css, [1280.0, 720.0], [2560, 1440]).unwrap();
        assert_eq!(decode_crop(&c, rect), vec![PAYLOAD.to_string()]);
    }

    #[test]
    fn blank_detection() {
        assert!(looks_blank(&RgbaImage::from_pixel(100, 100, Rgba([0, 0, 0, 255]))));
        assert!(!looks_blank(&desktop(100, 100)));
    }

    #[test]
    fn result_serializes_like_bridge_contract() {
        let v = serde_json::to_value(ScanResult::Ok { texts: vec!["a".into()] }).unwrap();
        assert_eq!(v, serde_json::json!({"status": "ok", "texts": ["a"]}));
        assert_eq!(serde_json::to_value(ScanResult::Cancelled).unwrap(), serde_json::json!({"status": "cancelled"}));
        assert_eq!(serde_json::to_value(err("x")).unwrap(), serde_json::json!({"status": "error", "message": "x"}));
    }
}
