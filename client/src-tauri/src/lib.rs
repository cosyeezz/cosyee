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

/// 注入到每个页面（包括服务端页面）的脚本：Ctrl/⌘+Shift+L 或左边缘小标签回到服务器列表。
/// 只做页面跳转，不调用任何客户端接口（服务端页面本来也没有 IPC 权限）。
fn shortcut_script() -> String {
    format!(
        r#"(function () {{
  if (window.__cosyeeShell) return;
  window.__cosyeeShell = true;
  var home = {home:?};
  var list = home + 'index.html?list=1';
  // 页面左边缘一个半透明小标签：点一下回服务器列表（本地页面自己不显示）。快捷键之外的可见入口，手机上也能用
  function addTab() {{
    if (location.href.indexOf(home) === 0 || document.getElementById('__cosyee_back')) return;
    var b = document.createElement('div');
    b.id = '__cosyee_back';
    b.textContent = '‹';
    b.title = '回到服务器列表';
    b.setAttribute('style', 'position:fixed;left:0;top:50%;transform:translateY(-50%);z-index:2147483647;width:20px;height:56px;'
      + 'display:flex;align-items:center;justify-content:center;font:24px/1 sans-serif;color:#fff;background:rgba(74,144,226,.55);'
      + 'border-radius:0 10px 10px 0;opacity:.45;cursor:pointer;user-select:none;-webkit-user-select:none;');
    b.onmouseenter = function () {{ b.style.opacity = '1'; }};
    b.onmouseleave = function () {{ b.style.opacity = '.45'; }};
    b.onclick = function () {{ location.href = list; }};
    (document.body || document.documentElement).appendChild(b);
  }}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', addTab); else addTab();
  window.addEventListener('load', addTab);
  window.addEventListener('keydown', function (e) {{
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {{
      e.preventDefault();
      location.href = list;
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

            // 桌面端：菜单栏（保留默认菜单，否则 ⌘C / ⌘V 不可用）+「连接」菜单：服务器列表 / 重新加载 / 停止本机服务。
            // 服务端断开时页面会变成空白，注入的脚本失效，菜单仍然能回到服务器列表、停掉本机服务。
            #[cfg(desktop)]
            {
                use tauri::menu::{Menu, MenuItem, Submenu};
                use tauri::Manager;
                let menu = Menu::default(app.handle())?;
                let list = MenuItem::with_id(app, "servers", "服务器列表", true, Some("CmdOrCtrl+Shift+L"))?;
                let reload = MenuItem::with_id(app, "reload", "重新加载", true, Some("CmdOrCtrl+R"))?;
                let stop = MenuItem::with_id(app, "stop", "停止本机服务", true, None::<&str>)?;
                menu.append(&Submenu::with_items(app, "连接", true, &[&list, &reload, &stop])?)?;
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
                        "stop" => {
                            // 先回到列表（页面是本机服务时不会白屏），再停服务
                            if let Ok(u) = format!("{HOME}index.html?list=1").parse() {
                                let _ = w.navigate(u);
                            }
                            tauri::async_runtime::spawn(async {
                                let _ = local::local_stop().await;
                            });
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
