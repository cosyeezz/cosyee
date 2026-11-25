fn main() {
    // tauri 的 macos-proxy feature 会让 wry 用 extern "C" 链接 Network.framework 里 macOS 14 才有的
    // nw_proxy_config_create_*。Rust 的 extern 声明不带可用性标注，默认是强符号，macOS 10.15–13 上
    // dyld 加载时就会因找不到符号而起不来。整体弱链接 Network.framework：旧系统上这些符号为空，
    // 而运行时只在 macOS 14+ 才会设置 proxy_url（见 tailnet::platform 检查），不会被调用。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-weak_framework,Network");
    }
    tauri_build::build()
}
