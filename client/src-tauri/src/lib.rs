// Cosyee 轻量客户端：一个 WebView 窗口，先显示本地的「服务器列表」页（ui/index.html），
// 选中后整页跳到服务端地址（http://<tailscale 地址>:7878/），之后就是服务端托管的网页界面。
// 客户端不处理任何业务逻辑，也没有令牌：访问控制由服务端的 Tailscale 模式负责。
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(desktop)]
mod local;

/// 本地页面的 origin（Windows / Android 是 http://tauri.localhost，macOS / Linux 是 tauri://localhost）。
#[cfg(any(windows, target_os = "android"))]
const HOME: &str = "http://tauri.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const HOME: &str = "tauri://localhost/";

/// 注入到每个页面（包括服务端页面）的脚本：Ctrl/⌘+Shift+L 回到服务器列表。
/// 只做页面跳转，不调用任何客户端接口（服务端页面本来也没有 IPC 权限）。
fn shortcut_script() -> String {
    format!(
        r#"(function () {{
  if (window.__cosyeeShell) return;
  window.__cosyeeShell = true;
  var home = {home:?};
  window.addEventListener('keydown', function (e) {{
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {{
      e.preventDefault();
      location.href = home + 'index.html?list=1';
    }}
  }}, true);
}})();"#,
        home = HOME
    )
}

/// 连接前探测服务端端口是否可达（纯 TCP 连接，3 秒超时）。
/// 放在 Rust 里做是因为 macOS 上 tauri:// 页面 fetch http 地址会被当成混合内容拦掉，探测结果不可靠。
#[tauri::command]
async fn probe(host: String, port: u16) -> bool {
    tauri::async_runtime::spawn_blocking(move || {
        let Ok(addrs) = (host.as_str(), port).to_socket_addrs() else {
            return false;
        };
        addrs
            .into_iter()
            .any(|a| TcpStream::connect_timeout(&a, Duration::from_secs(3)).is_ok())
    })
    .await
    .unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 桌面端多一组「本机服务」命令（安装 / 启动 / 停止本机的服务端）；手机上没有，页面据此隐藏那一栏
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        probe,
        local::local_status,
        local::local_log,
        local::local_install,
        local::local_start,
        local::local_stop
    ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![probe]);
    builder
        .setup(|app| {
            let script = shortcut_script();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script(&script);
            #[cfg(desktop)]
            let builder = builder
                .title("Cosyee")
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 360.0);
            builder.build()?;

            // macOS：系统菜单栏（保留默认的编辑菜单，否则 ⌘C / ⌘V 不可用）+「连接」菜单。
            // 服务端断开时页面会变成空白，注入的快捷键失效，菜单仍然能回到服务器列表。
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{Menu, MenuItem, Submenu};
                use tauri::Manager;
                let menu = Menu::default(app.handle())?;
                let list = MenuItem::with_id(app, "servers", "服务器列表", true, Some("CmdOrCtrl+Shift+L"))?;
                let reload = MenuItem::with_id(app, "reload", "重新加载", true, Some("CmdOrCtrl+R"))?;
                menu.append(&Submenu::with_items(app, "连接", true, &[&list, &reload])?)?;
                app.set_menu(menu)?;
                app.on_menu_event(|app, e| {
                    let Some(w) = app.get_webview_window("main") else { return };
                    match e.id().as_ref() {
                        "servers" => {
                            if let Ok(u) = format!("{HOME}index.html?list=1").parse() {
                                let _ = w.navigate(u);
                            }
                        }
                        "reload" => {
                            if let Ok(u) = w.url() {
                                let _ = w.navigate(u);
                            }
                        }
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Cosyee 启动失败");
}
