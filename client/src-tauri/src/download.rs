// macOS：网页里的下载（文件预览的「下载到本设备」等）。
// WKWebView 在没有下载处理时会直接取消下载导航，按钮点了没反应；这里接管后存进「下载」目录。
// 文件名由 wry 按服务端的 Content-Disposition 取好并避开重名（「名字 (1).ext」），这里只记下路径，
// 完成后在页面上提示一句（macOS 的完成回调拿不到路径，按 URL 对回去）。
// Windows 的 WebView2 自带下载栏，不经过这里；Android 由 MainActivity.kt 接管。
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::webview::DownloadEvent;

static PENDING: Mutex<Option<HashMap<String, PathBuf>>> = Mutex::new(None);

pub fn handle<R: tauri::Runtime>(webview: tauri::Webview<R>, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            if let Ok(mut g) = PENDING.lock() {
                g.get_or_insert_with(HashMap::new).insert(url.to_string(), destination.clone());
            }
            true
        }
        DownloadEvent::Finished { url, path, success } => {
            let recorded = PENDING
                .lock()
                .ok()
                .and_then(|mut g| g.as_mut().and_then(|m| m.remove(url.as_str())));
            let name = path
                .or(recorded)
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
                .unwrap_or_default();
            let msg = match (success, name.is_empty()) {
                (true, false) => format!("已下载到「下载」：{name}"),
                (true, true) => "已下载到「下载」文件夹".to_string(),
                (false, false) => format!("下载失败：{name}"),
                (false, true) => "下载失败".to_string(),
            };
            let lit = serde_json::to_string(&msg).unwrap_or_else(|_| "\"\"".into());
            let _ = webview.eval(format!("window.__cosyeeToast&&window.__cosyeeToast({lit})"));
            true
        }
        _ => true,
    }
}
