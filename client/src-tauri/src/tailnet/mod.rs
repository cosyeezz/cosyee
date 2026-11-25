// 内置 Tailscale 组件（cosyee-tailnet）客户端管理模块。
// 负责：平台支持判断、配置持久化、启动期代理与组件拉起、操作日志、以及全部 tailnet_* 和 app_relaunch 命令。
pub mod component;
pub mod manifest;
pub mod proxy;

use std::fs;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use component::{ComponentRunner, SelfNode};
use proxy::{SharedSocksState, SocksEndpoint};

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CurrentMeta {
    version: String,
    file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SettingsMeta {
    enabled: bool,
}

#[derive(Default)]
struct CheckCache {
    latest: Option<String>,
    checked_at: Option<u64>,
}

/// 统一日志缓冲：包含客户端操作日志，以及增量追读 tailnet.log 的新行。
struct LogStore {
    lines: Vec<String>,
    file_offset: u64,
}

impl LogStore {
    fn new() -> Self {
        Self {
            lines: Vec::new(),
            file_offset: 0,
        }
    }

    fn push(&mut self, line: String) {
        self.lines.push(line);
    }

    /// 增量读取 tailnet.log 新增行并追加到统一日志列表（保持行号单调递增）。
    fn absorb_log_file(&mut self, path: &Path) {
        let Ok(mut f) = fs::File::open(path) else {
            return;
        };
        let Ok(meta) = f.metadata() else {
            return;
        };
        if meta.len() < self.file_offset {
            // 文件被截断或重建，从头再读
            self.file_offset = 0;
        }
        if meta.len() == self.file_offset {
            return;
        }
        if f.seek(SeekFrom::Start(self.file_offset)).is_err() {
            return;
        }
        let mut br = BufReader::new(f);
        let mut line = String::new();
        while let Ok(n) = br.read_line(&mut line) {
            if n == 0 {
                break;
            }
            self.file_offset += n as u64;
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if !trimmed.is_empty() {
                self.lines.push(trimmed.to_string());
            }
            line.clear();
        }
    }
}

pub struct TailnetManager {
    install_dir: PathBuf,
    socks_state: SharedSocksState,
    proxy_addr: RwLock<Option<SocketAddr>>,
    runner: ComponentRunner,
    check_cache: Mutex<CheckCache>,
    logs: Arc<Mutex<LogStore>>,
    busy: AtomicBool,
}

static MANAGER: OnceLock<Arc<TailnetManager>> = OnceLock::new();

fn manager() -> Result<Arc<TailnetManager>, String> {
    MANAGER
        .get()
        .cloned()
        .ok_or_else(|| "内置 Tailscale 模块尚未初始化".to_string())
}

/// 返回当前平台键及是否支持；不支持时附带中文原因。
pub fn platform_support() -> (Option<&'static str>, Option<String>) {
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        (Some("windows-x64"), None)
    }
    #[cfg(all(target_os = "windows", not(target_arch = "x86_64")))]
    {
        (None, Some("当前 Windows 架构暂不支持内置 Tailscale（仅支持 x64）".into()))
    }
    #[cfg(target_os = "macos")]
    {
        if macos_major_version().unwrap_or(0) >= 14 {
            (Some("macos-universal"), None)
        } else {
            (
                None,
                Some("内置 Tailscale 需要 macOS 14 (Sonoma) 及以上版本".into()),
            )
        }
    }
    #[cfg(all(target_os = "android", target_arch = "aarch64"))]
    {
        (Some("android-arm64"), None)
    }
    #[cfg(all(target_os = "android", not(target_arch = "aarch64")))]
    {
        (None, Some("当前 Android 架构暂不支持内置 Tailscale（仅支持 arm64）".into()))
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "android")))]
    {
        (None, Some("当前平台不支持内置 Tailscale 组件".into()))
    }
}

/// 通过 sysctlbyname("kern.osproductversion") 读取 macOS 主版本号（不启动外部进程）。
#[cfg(target_os = "macos")]
fn macos_major_version() -> Option<u32> {
    use std::ffi::CString;
    use std::os::raw::{c_char, c_int, c_void};

    unsafe extern "C" {
        fn sysctlbyname(
            name: *const c_char,
            oldp: *mut c_void,
            oldlenp: *mut usize,
            newp: *mut c_void,
            newlen: usize,
        ) -> c_int;
    }

    let name = CString::new("kern.osproductversion").ok()?;
    let mut buf = [0u8; 64];
    let mut len = buf.len();
    let rc = unsafe {
        sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr() as *mut c_void,
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || len == 0 {
        return None;
    }
    let s = std::str::from_utf8(&buf[..len]).ok()?.trim_end_matches('\0');
    s.split('.').next()?.parse::<u32>().ok()
}

impl TailnetManager {
    fn new(install_dir: PathBuf) -> Self {
        let socks_state: SharedSocksState = Arc::new(RwLock::new(SocksEndpoint::default()));
        let logs = Arc::new(Mutex::new(LogStore::new()));
        let logs_cb = logs.clone();
        let runner = ComponentRunner::new(
            socks_state.clone(),
            Arc::new(move |line| {
                if let Ok(mut l) = logs_cb.lock() {
                    l.push(line);
                }
            }),
        );
        Self {
            install_dir,
            socks_state,
            proxy_addr: RwLock::new(None),
            runner,
            check_cache: Mutex::new(CheckCache::default()),
            logs,
            busy: AtomicBool::new(false),
        }
    }

    fn log(&self, line: impl Into<String>) {
        if let Ok(mut l) = self.logs.lock() {
            l.push(line.into());
        }
    }

    fn current_path(&self) -> PathBuf {
        self.install_dir.join("current.json")
    }

    fn settings_path(&self) -> PathBuf {
        self.install_dir.join("settings.json")
    }

    fn state_dir(&self) -> PathBuf {
        self.install_dir.join("state")
    }

    fn log_file_path(&self) -> PathBuf {
        self.install_dir.join("tailnet.log")
    }

    fn read_current(&self) -> Option<CurrentMeta> {
        let text = fs::read_to_string(self.current_path()).ok()?;
        let meta: CurrentMeta = serde_json::from_str(&text).ok()?;
        if self.install_dir.join(&meta.file).exists() {
            Some(meta)
        } else {
            None
        }
    }

    fn write_current(&self, meta: &CurrentMeta) -> Result<(), String> {
        fs::create_dir_all(&self.install_dir)
            .map_err(|e| format!("无法创建目录 {}：{e}", self.install_dir.display()))?;
        let data = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
        atomic_write(&self.current_path(), data.as_bytes())
    }

    fn read_settings(&self) -> SettingsMeta {
        fs::read_to_string(self.settings_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write_settings(&self, meta: &SettingsMeta) -> Result<(), String> {
        fs::create_dir_all(&self.install_dir)
            .map_err(|e| format!("无法创建目录 {}：{e}", self.install_dir.display()))?;
        let data = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
        atomic_write(&self.settings_path(), data.as_bytes())
    }

    pub fn proxy_addr(&self) -> Option<SocketAddr> {
        self.proxy_addr.read().ok().and_then(|g| *g)
    }

    fn start_component_if_installed(&self) -> Result<(), String> {
        let cur = self
            .read_current()
            .ok_or_else(|| "尚未安装内置 Tailscale 组件".to_string())?;
        let bin_path = self.install_dir.join(&cur.file);
        self.runner
            .start(bin_path, cur.file, self.state_dir(), self.log_file_path())
            .map(|_| ())
    }
}

fn atomic_write(path: &Path, content: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入临时文件失败：{e}"))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("原子写入 {} 失败：{e}", path.display())
    })
}

struct BusyGuard(Arc<TailnetManager>);
impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

fn take_busy(mgr: &Arc<TailnetManager>) -> Result<BusyGuard, String> {
    if mgr.busy.swap(true, Ordering::SeqCst) {
        return Err("另一个内置 Tailscale 操作正在进行".into());
    }
    Ok(BusyGuard(mgr.clone()))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 在 Tauri `setup` 中调用：初始化管理器；如果当前平台支持且组件已安装并启用，
/// 先启动本地 HTTP 代理（端口立刻可用），并在后台线程异步启动组件。
pub fn init_on_startup<R: tauri::Runtime>(app: &tauri::App<R>) -> Option<tauri::Url> {
    let base_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("cosyee"));
    let install_dir = base_dir.join("tailnet");
    let mgr = Arc::new(TailnetManager::new(install_dir));
    let _ = MANAGER.set(mgr.clone());

    let (platform_key, _) = platform_support();
    platform_key?;

    let installed = mgr.read_current();
    let settings = mgr.read_settings();
    if installed.is_none() || !settings.enabled {
        return None;
    }

    // 先在 Tokio runtime 上绑定本地 HTTP 代理端口，立刻返回给 WebView 使用
    let socks_state = mgr.socks_state.clone();
    let addr = match tauri::async_runtime::block_on(proxy::start_http_proxy(socks_state)) {
        Ok(a) => a,
        Err(e) => {
            mgr.log(format!("启动本地代理失败：{e}"));
            return None;
        }
    };
    if let Ok(mut g) = mgr.proxy_addr.write() {
        *g = Some(addr);
    }
    mgr.log(format!("本地代理已就绪：http://{addr}"));

    // 组件异步启动，不阻塞主窗口显示
    let mgr_bg = mgr.clone();
    std::thread::spawn(move || {
        if let Err(e) = mgr_bg.start_component_if_installed() {
            mgr_bg.log(format!("启动组件失败：{e}"));
        }
    });

    format!("http://{addr}").parse().ok()
}

/// 返回本次启动时生效的本地代理 URL（供 `main` 窗口和 Windows 上的 `kiro-admin` 窗口保持参数一致）。
pub fn proxy_url() -> Option<tauri::Url> {
    let mgr = MANAGER.get()?;
    let addr = mgr.proxy_addr()?;
    format!("http://{addr}").parse().ok()
}

/// 探测 host:port 是否可达：代理开启时按相同分流规则决定走 SOCKS5 还是直连；未开启时纯直连。
pub async fn probe_tcp(host: &str, port: u16) -> bool {
    if let Some(mgr) = MANAGER.get() {
        if mgr.proxy_addr().is_some() {
            return proxy::probe_target(&mgr.socks_state, host, port).await;
        }
    }
    let host_owned = host.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        use std::net::{TcpStream, ToSocketAddrs};
        use std::time::Duration;
        let Ok(addrs) = (host_owned.as_str(), port).to_socket_addrs() else {
            return false;
        };
        addrs
            .into_iter()
            .any(|a| TcpStream::connect_timeout(&a, Duration::from_secs(3)).is_ok())
    })
    .await
    .unwrap_or(false)
}

/// Android 侧：通过 JNI 调用 MainActivity.setTailnetProxy 设置 WebView 代理。
#[cfg(target_os = "android")]
pub fn apply_android_proxy<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    proxy_url: &tauri::Url,
) {
    let url_str = proxy_url.to_string();
    let _ = window.with_webview(move |wv| {
        wv.jni_handle().exec(move |env, activity, _webview| {
            if let Ok(jurl) = env.new_string(&url_str) {
                let _ = env.call_method(
                    activity,
                    "setTailnetProxy",
                    "(Ljava/lang/String;)Z",
                    &[jni::objects::JValue::Object(&jurl)],
                );
            }
        });
    });
}

// ───────────────────── Tauri 命令（严格按 CONTRACT.md） ─────────────────────

#[derive(Serialize)]
pub struct TailnetStatusResp {
    pub supported: bool,
    #[serde(rename = "unsupportedReason")]
    pub unsupported_reason: Option<String>,
    pub installed: Option<String>,
    pub enabled: bool,
    pub running: bool,
    pub state: Option<String>,
    #[serde(rename = "authURL")]
    pub auth_url: Option<String>,
    #[serde(rename = "self")]
    pub self_node: Option<SelfNode>,
    pub tailnet: Option<String>,
    pub latest: Option<String>,
    #[serde(rename = "checkedAt")]
    pub checked_at: Option<u64>,
    pub busy: bool,
    #[serde(rename = "proxyActive")]
    pub proxy_active: bool,
    #[serde(rename = "needsRestart")]
    pub needs_restart: bool,
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct TailnetCheckResp {
    pub latest: String,
    pub current: Option<String>,
    #[serde(rename = "updateAvailable")]
    pub update_available: bool,
}

#[derive(Serialize)]
pub struct TailnetInstallResp {
    pub version: String,
    #[serde(rename = "needsRestart")]
    pub needs_restart: bool,
}

#[derive(Serialize)]
pub struct OkResp {
    pub ok: bool,
}

#[derive(Serialize)]
pub struct SetEnabledResp {
    pub enabled: bool,
    #[serde(rename = "needsRestart")]
    pub needs_restart: bool,
}

#[derive(Serialize)]
pub struct TailnetLoginResp {
    #[serde(rename = "authURL")]
    pub auth_url: String,
}

#[derive(Serialize)]
pub struct TailnetLogResp {
    pub lines: Vec<String>,
    pub next: usize,
}

#[tauri::command]
pub async fn tailnet_status() -> Result<TailnetStatusResp, String> {
    let mgr = manager()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (platform_key, unsupported_reason) = platform_support();
        let supported = platform_key.is_some();
        let current = mgr.read_current();
        let installed = current.as_ref().map(|c| c.version.clone());
        let enabled = mgr.read_settings().enabled;
        let proxy_active = mgr.proxy_addr().is_some();
        let busy = mgr.busy.load(Ordering::SeqCst);

        let (latest, checked_at) = mgr
            .check_cache
            .lock()
            .map(|c| (c.latest.clone(), c.checked_at))
            .unwrap_or((None, None));

        let running_info = mgr.runner.running_info();
        let mut running = false;
        let mut state = None;
        let mut auth_url = None;
        let mut self_node = None;
        let mut tailnet = None;
        let mut error = mgr.runner.last_error();

        if let Some(info) = running_info {
            match component::fetch_control_status(&info) {
                Ok(cs) => {
                    running = true;
                    component::sync_socks_state(&mgr.socks_state, Some(&info), cs.state == "Running");
                    state = Some(cs.state);
                    auth_url = cs.auth_url;
                    self_node = cs.self_node;
                    tailnet = cs.tailnet;
                    if cs.error.is_some() {
                        error = cs.error;
                    }
                }
                Err(e) => {
                    error = Some(e);
                }
            }
        }

        let needs_restart = (installed.is_some() && enabled && !proxy_active)
            || mgr.runner.android_library_outdated(installed.as_deref());

        TailnetStatusResp {
            supported,
            unsupported_reason,
            installed,
            enabled,
            running,
            state,
            auth_url,
            self_node,
            tailnet,
            latest,
            checked_at,
            busy,
            proxy_active,
            needs_restart,
            error,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tailnet_check() -> Result<TailnetCheckResp, String> {
    let mgr = manager()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (platform_key, reason) = platform_support();
        let platform_key = platform_key
            .ok_or_else(|| reason.unwrap_or_else(|| "当前平台不支持内置 Tailscale".into()))?;

        let m = manifest::fetch_verified_manifest()?;
        if !m.assets.contains_key(platform_key) {
            return Err(format!("最新版本 {} 未包含当前平台（{platform_key}）资产", m.version));
        }

        let current = mgr.read_current().map(|c| c.version);
        let update_available = match &current {
            Some(cur) => manifest::is_newer_version(&m.version, cur),
            None => true,
        };

        if let Ok(mut c) = mgr.check_cache.lock() {
            c.latest = Some(m.version.clone());
            c.checked_at = Some(now_millis());
        }

        Ok(TailnetCheckResp {
            latest: m.version,
            current,
            update_available,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailnet_install() -> Result<TailnetInstallResp, String> {
    let mgr = manager()?;
    let guard = take_busy(&mgr)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = guard;
        let (platform_key, reason) = platform_support();
        let platform_key = platform_key
            .ok_or_else(|| reason.unwrap_or_else(|| "当前平台不支持内置 Tailscale".into()))?;

        mgr.log("正在获取并校验组件清单（Ed25519）...");
        let m = manifest::fetch_verified_manifest()?;
        let asset = m
            .assets
            .get(platform_key)
            .ok_or_else(|| format!("manifest 中缺少当前平台（{platform_key}）的组件"))?;

        let mgr_log = mgr.clone();
        let installed_file = manifest::download_and_install_asset(
            &mgr.install_dir,
            platform_key,
            &m.version,
            asset,
            move |line| mgr_log.log(line),
        )?;

        mgr.write_current(&CurrentMeta {
            version: m.version.clone(),
            file: installed_file.clone(),
        })?;

        // 首次安装默认启用（见 CONTRACT.md）
        if !mgr.settings_path().exists() {
            mgr.write_settings(&SettingsMeta { enabled: true })?;
        }
        let enabled = mgr.read_settings().enabled;

        if let Ok(mut c) = mgr.check_cache.lock() {
            c.latest = Some(m.version.clone());
            c.checked_at = Some(now_millis());
        }

        let proxy_active = mgr.proxy_addr().is_some();
        let mut needs_restart = enabled && !proxy_active;

        // 如果代理已开且已启用，桌面端可以直接切换到新版本；Android 若已加载旧库则需重启 App
        if proxy_active && enabled {
            if mgr.runner.android_library_outdated(Some(&m.version)) {
                needs_restart = true;
                mgr.log("新版本组件已就绪，重启客户端后生效");
            } else {
                mgr.log("正在重启组件以启用新版本...");
                if let Err(e) = mgr.start_component_if_installed() {
                    mgr.log(format!("重启新版本组件失败：{e}"));
                }
            }
        }

        // 清理旧版本文件（跳过当前文件和仍在运行的旧库文件）
        let active_file = mgr.runner.active_file();
        let mut keep: Vec<&str> = vec![installed_file.as_str()];
        if let Some(af) = active_file.as_deref() {
            keep.push(af);
        }
        manifest::cleanup_old_versions(&mgr.install_dir, &keep);

        mgr.log(format!("安装完成：cosyee-tailnet {}", m.version));
        Ok(TailnetInstallResp {
            version: m.version,
            needs_restart,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailnet_uninstall(keep_state: bool) -> Result<OkResp, String> {
    let mgr = manager()?;
    let guard = take_busy(&mgr)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = guard;
        mgr.log("正在卸载内置 Tailscale 组件...");
        mgr.runner.stop();

        let _ = fs::remove_file(mgr.current_path());
        let _ = fs::remove_file(mgr.settings_path());
        manifest::cleanup_old_versions(&mgr.install_dir, &[]);

        if !keep_state {
            let state = mgr.state_dir();
            if state.exists() {
                let _ = fs::remove_dir_all(&state);
            }
            mgr.log("已清除 Tailscale 登录状态");
        }
        mgr.log("卸载完成");
        Ok(OkResp { ok: true })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailnet_set_enabled(enabled: bool) -> Result<SetEnabledResp, String> {
    let mgr = manager()?;
    let guard = take_busy(&mgr)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = guard;
        mgr.write_settings(&SettingsMeta { enabled })?;
        let installed = mgr.read_current();
        let proxy_active = mgr.proxy_addr().is_some();

        if !enabled {
            mgr.runner.stop();
            mgr.log("已停用内置 Tailscale 组件");
        } else if installed.is_some() && proxy_active {
            if let Err(e) = mgr.start_component_if_installed() {
                mgr.log(format!("启用后启动组件失败：{e}"));
            }
        }

        let needs_restart = (installed.is_some() && enabled && !proxy_active)
            || mgr
                .runner
                .android_library_outdated(installed.as_ref().map(|c| c.version.as_str()));

        Ok(SetEnabledResp {
            enabled,
            needs_restart,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailnet_login(app: tauri::AppHandle) -> Result<TailnetLoginResp, String> {
    let mgr = manager()?;
    let auth_url = tauri::async_runtime::spawn_blocking(move || {
        let info = match mgr.runner.running_info() {
            Some(i) => i,
            None => {
                mgr.start_component_if_installed()?;
                mgr.runner
                    .running_info()
                    .ok_or_else(|| "组件未能进入运行状态".to_string())?
            }
        };
        let url = component::trigger_login(&info)?;
        if !url.starts_with("https://") {
            return Err("组件返回的登录链接不是 https 地址，已拒绝打开".into());
        }
        Ok::<String, String>(url)
    })
    .await
    .map_err(|e| e.to_string())??;

    // 用系统浏览器打开登录链接（桌面 + Android 均支持）
    if let Err(e) = app.opener().open_url(&auth_url, None::<&str>) {
        if let Ok(mgr) = manager() {
            mgr.log(format!("打开系统浏览器失败（请手动访问链接）：{e}"));
        }
    }

    Ok(TailnetLoginResp { auth_url })
}

#[tauri::command]
pub async fn tailnet_logout() -> Result<OkResp, String> {
    let mgr = manager()?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = mgr
            .runner
            .running_info()
            .ok_or_else(|| "组件未运行".to_string())?;
        component::trigger_logout(&info)?;
        component::sync_socks_state(&mgr.socks_state, Some(&info), false);
        mgr.log("已登出 Tailscale 账号");
        Ok(OkResp { ok: true })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailnet_restart() -> Result<OkResp, String> {
    let mgr = manager()?;
    let guard = take_busy(&mgr)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = guard;
        mgr.log("正在重启内置 Tailscale 组件...");
        mgr.start_component_if_installed()?;
        Ok(OkResp { ok: true })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn tailnet_log(from: usize) -> Result<TailnetLogResp, String> {
    let mgr = manager()?;
    let mut store = mgr.logs.lock().map_err(|_| "日志锁异常".to_string())?;
    store.absorb_log_file(&mgr.log_file_path());
    let next = store.lines.len();
    let lines = store
        .lines
        .get(from..)
        .map(<[String]>::to_vec)
        .unwrap_or_default();
    Ok(TailnetLogResp { lines, next })
}

#[tauri::command]
pub fn app_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mgr) = manager() {
        mgr.runner.stop();
    }
    #[cfg(not(target_os = "android"))]
    {
        app.restart();
    }
    #[cfg(target_os = "android")]
    {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.with_webview(|wv| {
                wv.jni_handle().exec(|env, activity, _webview| {
                    let _ = env.call_method(activity, "relaunchApp", "()V", &[]);
                });
            });
            Ok(())
        } else {
            Err("找不到主窗口，无法重启应用".into())
        }
    }
}
