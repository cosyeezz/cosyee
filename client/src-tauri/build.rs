fn main() {
    // tauri 的 macos-proxy feature 会让 wry 用 extern "C" 链接 Network.framework 里 macOS 14 才有的
    // nw_proxy_config_create_*。Rust 的 extern 声明不带可用性标注，默认是强符号，macOS 10.15–13 上
    // dyld 加载时就会因找不到符号而起不来。整体弱链接 Network.framework：旧系统上这些符号为空，
    // 而运行时只在 macOS 14+ 才会设置 proxy_url（见 tailnet::platform 检查），不会被调用。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,Network");
    }
    // 声明了 app manifest 之后，所有自定义命令都要有权限才能被前端调用（默认「全放行」不再生效）。
    // 每个命令生成一个 `allow-<命令名>` 权限：default.json 给本地页面全量授权，
    // remote.json 只给远程（服务端）页面授权 allow-qr-scan-screen 一个。
    const COMMANDS: &[&str] = &[
        "probe",
        "set_servers",
        "app_version",
        "app_update_check",
        "app_update_install",
        "app_update_progress",
        "app_open_url",
        "tailnet_status",
        "tailnet_peers",
        "tailnet_check",
        "tailnet_install",
        "tailnet_uninstall",
        "tailnet_set_enabled",
        "tailnet_login",
        "tailnet_logout",
        "tailnet_restart",
        "tailnet_log",
        "app_relaunch",
        "local_status",
        "local_log",
        "local_install",
        "local_start",
        "local_stop",
        "server_latest",
        "kiro_admin",
        "components_status",
        "component_check",
        "component_update",
        "component_auto",
        "component_service",
        "component_log",
        // 屏幕扫码：qr_scan_screen 给服务端页面（经 titlebar.js 桥接），qr_overlay_* 只给扫码覆盖层窗口
        "qr_scan_screen",
        "qr_overlay_init",
        "qr_overlay_ready",
        "qr_overlay_crop",
        "qr_overlay_complete",
        "qr_overlay_cancel",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)))
        .expect("tauri-build 失败");
}
