// Cosyee 轻量客户端：一个 WebView 窗口，先显示本地的「服务器列表」页（ui/index.html），
// 选中后整页跳到服务端地址（http://<tailscale 地址>:7878/），之后就是服务端托管的网页界面。
// 客户端不处理任何业务逻辑，也没有令牌：访问控制由服务端的 Tailscale 模式负责。
use tauri::{WebviewUrl, WebviewWindowBuilder};

mod http_client;
#[cfg(desktop)]
mod local;
#[cfg(desktop)]
mod peers;
mod tailnet;

/// 本地页面的 origin（Windows / Android 是 http://tauri.localhost，macOS / Linux 是 tauri://localhost）。
#[cfg(any(windows, target_os = "android"))]
const HOME: &str = "http://tauri.localhost/";
#[cfg(not(any(windows, target_os = "android")))]
const HOME: &str = "tauri://localhost/";

/// 注入到每个页面（包括服务端页面）的外壳脚本：桌面端画一行自绘标题栏（菜单 / 当前服务器 / 窗口按钮），
/// 手机端按系统栏让位、返回手势回到服务器列表；两端都支持 Ctrl/⌘+Shift+L 回到服务器列表。
/// 服务端页面只开放了窗口相关的权限（见 capabilities/remote.json），调不到本机服务等自定义命令。
fn shell_script() -> String {
    let os = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "android") {
        "android"
    } else if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    };
    include_str!("titlebar.js").replace("__HOME__", HOME).replace("__OS__", os)
}

/// 连接前探测服务端端口是否可达（纯 TCP 连接，3 秒超时）。
/// 放在 Rust 里做是因为 macOS 上 tauri:// 页面 fetch http 地址会被当成混合内容拦掉，探测结果不可靠。
/// 代理开启时按与本地代理完全一致的分流规则走 SOCKS5 或直连。
#[tauri::command]
async fn probe(host: String, port: u16) -> bool {
    tailnet::probe_tcp(&host, port).await
}

/// 服务器列表（JSON 数组字符串）。真正的列表存在本地页面的 localStorage 里，服务端网页读不到，
/// 所以列表页每次变动都同步一份到这里，再由 `watch_server` 在服务端页面加载完后注入给标题栏的切换下拉用。
#[derive(Default)]
struct Servers(std::sync::Mutex<String>);

#[tauri::command]
fn set_servers(state: tauri::State<'_, Servers>, json: String) {
    // 只接受 JSON 数组，其它内容一律丢弃
    let ok = serde_json::from_str::<serde_json::Value>(&json).map(|v| v.is_array()).unwrap_or(false);
    if let Ok(mut g) = state.0.lock() {
        *g = if ok { json } else { "[]".into() };
    }
}

/// 上次查到的 tailnet 节点名单（JSON 数组字符串），页面加载完先注入这份，再后台刷新。
#[derive(Default)]
struct PeerCache(std::sync::Mutex<String>);

/// 把节点名单交给标题栏：先给缓存（下拉立即有别名），再在后台重新查一次，变了就再注入一次。
#[cfg(desktop)]
fn inject_peers<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>) {
    use tauri::Manager;
    fn eval<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>, json: &str) {
        let lit = serde_json::to_string(json).unwrap_or_else(|_| "\"[]\"".into());
        let _ = w.eval(format!("window.__cosyeePeers={lit};window.dispatchEvent(new Event('cosyee:servers'))"));
    }
    let cached = w.state::<PeerCache>().0.lock().map(|g| g.clone()).unwrap_or_default();
    if !cached.is_empty() {
        eval(w, &cached);
    }
    let w = w.clone();
    tauri::async_runtime::spawn(async move {
        let Ok(list) = tauri::async_runtime::spawn_blocking(peers::list).await else { return };
        let json = serde_json::to_string(&list).unwrap_or_else(|_| "[]".into());
        if json == cached {
            return;
        }
        if let Ok(mut g) = w.state::<PeerCache>().0.lock() {
            *g = json.clone();
        }
        eval(&w, &json);
    });
}

fn go_list<R: tauri::Runtime>(w: &tauri::WebviewWindow<R>, extra: &str) {
    if let Ok(u) = format!("{HOME}index.html?list=1{extra}").parse() {
        let _ = w.navigate(u);
    }
}

/// 打开服务端页面时再探测一次：服务端已经停了（例如重新加载时）就回到服务器列表并说明原因，
/// 不停在 WebView 的错误页上——错误页里没有标题栏，用户会找不到返回和关闭窗口的地方。
fn watch_server<R: tauri::Runtime>(w: tauri::WebviewWindow<R>, p: tauri::webview::PageLoadPayload<'_>) {
    use tauri::webview::PageLoadEvent;
    use tauri::Manager;
    let url = p.url().clone();
    if !matches!(url.scheme(), "http" | "https") || url.as_str().starts_with(HOME) {
        return;
    }
    // 页面加载完：把服务器列表交给标题栏（二次编码成 JS 字符串，脚本里 JSON.parse）
    if p.event() == PageLoadEvent::Finished {
        let json = w.state::<Servers>().0.lock().map(|g| g.clone()).unwrap_or_default();
        let lit = serde_json::to_string(if json.is_empty() { "[]" } else { &json }).unwrap_or_else(|_| "\"[]\"".into());
        let _ = w.eval(format!("window.__cosyeeServers={lit};window.dispatchEvent(new Event('cosyee:servers'))"));
        #[cfg(desktop)]
        inject_peers(&w);
        return;
    }
    if p.event() != PageLoadEvent::Started {
        return;
    }
    let (Some(host), Some(port)) = (url.host_str().map(|h| h.trim_matches(['[', ']']).to_string()), url.port_or_known_default())
    else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        if probe(host, port).await {
            return;
        }
        let origin = url.origin().ascii_serialization();
        // 这期间用户可能已经去了别处
        if w.url().map(|u| u.origin().ascii_serialization() == origin).unwrap_or(false) {
            go_list(&w, &format!("&lost={origin}"));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(Servers::default())
        .manage(PeerCache::default());
    // 桌面端多一组「本机服务」命令（安装 / 启动 / 停止本机的服务端）；手机上没有，页面据此隐藏那一栏。
    // 内置 Tailscale 命令在桌面与手机两端都注册，且仅对客户端本地页面开放（远程页面调不到自定义命令）。
    #[cfg(desktop)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        probe,
        set_servers,
        tailnet::tailnet_status,
        tailnet::tailnet_peers,
        tailnet::tailnet_check,
        tailnet::tailnet_install,
        tailnet::tailnet_uninstall,
        tailnet::tailnet_set_enabled,
        tailnet::tailnet_login,
        tailnet::tailnet_logout,
        tailnet::tailnet_restart,
        tailnet::tailnet_log,
        tailnet::app_relaunch,
        local::local_status,
        local::local_log,
        local::local_install,
        local::local_start,
        local::local_stop,
        local::server_latest,
        local::kiro_admin,
        local::components_status,
        local::component_check,
        local::component_update,
        local::component_auto,
        local::component_service,
        local::component_log
    ]);
    #[cfg(mobile)]
    let builder = builder.invoke_handler(tauri::generate_handler![
        probe,
        set_servers,
        tailnet::tailnet_status,
        tailnet::tailnet_peers,
        tailnet::tailnet_check,
        tailnet::tailnet_install,
        tailnet::tailnet_uninstall,
        tailnet::tailnet_set_enabled,
        tailnet::tailnet_login,
        tailnet::tailnet_logout,
        tailnet::tailnet_restart,
        tailnet::tailnet_log,
        tailnet::app_relaunch
    ]);
    builder
        .setup(|app| {
            // 若内置 Tailscale 已安装且启用，先拉起本地 HTTP 代理（端口立即可用，组件后台异步启动）
            let proxy_url = tailnet::init_on_startup(app);

            let script = shell_script();
            let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .initialization_script(&script)
                .on_page_load(watch_server);
            #[cfg(desktop)]
            let builder = if let Some(ref url) = proxy_url {
                builder.proxy_url(url.clone())
            } else {
                builder
            };
            #[cfg(desktop)]
            let builder = builder
                .title("Cosyee")
                .inner_size(1280.0, 820.0)
                .min_inner_size(420.0, 360.0)
                // 窗口底色跟深色主题一致，启动和拖动缩放时不闪白（浅色由页面再改）
                .background_color(tauri::window::Color(20, 18, 16, 255));
            // 标题栏由页面自己画（titlebar.js）：Windows / Linux 去掉系统边框；macOS 保留红绿灯，内容延伸到标题栏下
            #[cfg(all(desktop, not(target_os = "macos")))]
            let builder = builder.decorations(false);
            #[cfg(target_os = "macos")]
            let builder = builder
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(14.0, 19.0));
            let _window = builder.build()?;
            #[cfg(target_os = "android")]
            if let Some(ref url) = proxy_url {
                tailnet::apply_android_proxy(&_window, url);
            }
            // 客户端开着时负责更新本机 npm 安装的 cosyee 服务端（服务端不能自己替换自己）
            #[cfg(desktop)]
            local::spawn_auto_update();

            // macOS：保留系统菜单（否则 ⌘C / ⌘V 不可用）并加「连接」菜单。Windows / Linux 不要菜单栏，
            // 同样的操作放在标题栏左上角的菜单里。
            #[cfg(target_os = "macos")]
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
                        "servers" => go_list(&w, ""),
                        "reload" => {
                            if let Ok(u) = w.url() {
                                let _ = w.navigate(u);
                            }
                        }
                        // 由服务器列表页去停（页面是本机服务时不会白屏，停的过程也能看到）
                        "stop" => go_list(&w, "&stop=1"),
                        _ => {}
                    }
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Cosyee 启动失败");
}
