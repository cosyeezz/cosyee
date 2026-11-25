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
#[cfg(not(target_os = "android"))]
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

use component::{ComponentRunner, SelfNode};
use proxy::{SharedSocksState, SocksEndpoint};

#[cfg(not(target_os = "android"))]
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CurrentMeta {
    version: String,
    file: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
struct SettingsMeta {
    #[serde(default)]
    enabled: bool,
    #[serde(default, rename = "loggedIn")]
    logged_in: bool,
}

#[cfg(not(target_os = "android"))]
#[derive(Default)]
struct CheckCache {
    latest: Option<String>,
    checked_at: Option<u64>,
}

const CRASH_GUARD_FILE: &str = "starting.json";
const CRASH_GUARD_THRESHOLD: u32 = 2;
#[cfg(target_os = "android")]
const CRASH_GUARD_STABLE_SECS: u64 = 10;
#[cfg(target_os = "android")]
const CRASH_AUTO_DISABLE_MSG: &str =
    "内置 Tailscale 上次启动时崩溃，已自动停用；可在此重新启用";
#[cfg(target_os = "android")]
const PROXY_UNSUPPORTED_MSG: &str =
    "当前系统 WebView 不支持代理覆写（PROXY_OVERRIDE），无法启用内置 Tailscale 代理；请更新 Android System WebView";

fn settings_file_path(install_dir: &Path) -> PathBuf {
    install_dir.join("settings.json")
}

/// 在 settings_lock 保护下读取 settings.json（兼容仅含 enabled 的旧文件）。
fn read_settings_locked(install_dir: &Path, lock: &Mutex<()>) -> SettingsMeta {
    let _g = lock.lock();
    fs::read_to_string(settings_file_path(install_dir))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// 在 settings_lock 保护下执行读-改-写：
/// - 若 `force_write_if_missing` 为 false 且字段未变化，则不写盘；
/// - 保证 enabled 与 loggedIn 并发更新时不会互相覆盖。
/// 返回 `(更新后的配置, 是否执行了写盘)`。
fn update_settings_locked(
    install_dir: &Path,
    lock: &Mutex<()>,
    force_write_if_missing: bool,
    mutate: impl FnOnce(&mut SettingsMeta),
) -> Result<(SettingsMeta, bool), String> {
    let _g = lock.lock().map_err(|_| "设置锁异常".to_string())?;
    let path = settings_file_path(install_dir);
    let existed = path.exists();
    let old: SettingsMeta = fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let mut next = old.clone();
    mutate(&mut next);
    if next == old && (existed || !force_write_if_missing) {
        return Ok((next, false));
    }
    fs::create_dir_all(install_dir)
        .map_err(|e| format!("无法创建目录 {}：{e}", install_dir.display()))?;
    let data = serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?;
    atomic_write(&path, data.as_bytes())?;
    Ok((next, true))
}

/// 根据组件状态同步持久化 loggedIn（Running -> true，NeedsLogin -> false；只在变化时写盘）。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn sync_logged_in_for_state(install_dir: &Path, lock: &Mutex<()>, state: &str) {
    let target = match state {
        "Running" => Some(true),
        "NeedsLogin" => Some(false),
        _ => None,
    };
    if let Some(val) = target {
        let _ = update_settings_locked(install_dir, lock, false, |s| s.logged_in = val);
    }
}

/// Android 登录前等待状态稳定时的判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
enum LoginWaitOutcome {
    KeepWaiting,
    NoLoginNeeded,
    NeedLogin,
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn classify_login_wait_state(state: &str) -> LoginWaitOutcome {
    match state {
        "" | "NoState" | "Starting" => LoginWaitOutcome::KeepWaiting,
        "Running" | "NeedsMachineAuth" => LoginWaitOutcome::NoLoginNeeded,
        _ => LoginWaitOutcome::NeedLogin,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CrashGuardMeta {
    count: u32,
}

/// 读取崩溃保护标记中的连续未稳定启动次数（文件不存在或损坏时返回 0）。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn read_crash_guard(install_dir: &Path) -> u32 {
    let path = install_dir.join(CRASH_GUARD_FILE);
    fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<CrashGuardMeta>(&s).ok())
        .map(|m| m.count)
        .unwrap_or(0)
}

/// 记录一次启动尝试（在 dlopen + Start 之前调用），返回递增后的连续次数。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn record_crash_guard_attempt(install_dir: &Path) -> Result<u32, String> {
    fs::create_dir_all(install_dir)
        .map_err(|e| format!("无法创建目录 {}：{e}", install_dir.display()))?;
    let next = read_crash_guard(install_dir).saturating_add(1);
    let data = serde_json::to_string_pretty(&CrashGuardMeta { count: next })
        .map_err(|e| e.to_string())?;
    atomic_write(&install_dir.join(CRASH_GUARD_FILE), data.as_bytes())?;
    Ok(next)
}

/// 删除崩溃保护标记（组件稳定运行 10 秒后、正常停止/停用或正常返回错误时调用）。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn clear_crash_guard(install_dir: &Path) {
    let _ = fs::remove_file(install_dir.join(CRASH_GUARD_FILE));
}

/// 判断启动期是否应因连续崩溃自动停用（连续次数 >= 2）。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn should_auto_disable_on_startup(install_dir: &Path) -> bool {
    read_crash_guard(install_dir) >= CRASH_GUARD_THRESHOLD
}

/// 清理 Android 旧版可选组件方式遗留的 current.json 与 install_dir 下的旧 libcosyee_tailnet_*.so（及 .part），
/// 保留 state/（登录状态）、settings.json、tailnet.log、starting.json 等文件。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn cleanup_legacy_android_files(install_dir: &Path) {
    let _ = fs::remove_file(install_dir.join("current.json"));
    let Ok(entries) = fs::read_dir(install_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let is_legacy = (name.starts_with("libcosyee_tailnet_") && name.ends_with(".so"))
            || name.ends_with(".part");
        if !is_legacy {
            continue;
        }
        manifest::make_writable_if_needed(&path);
        let _ = fs::remove_file(&path);
    }
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
    settings_lock: Arc<Mutex<()>>,
    socks_state: SharedSocksState,
    proxy_addr: RwLock<Option<SocketAddr>>,
    #[cfg(target_os = "android")]
    proxy_start_lock: Mutex<()>,
    #[cfg(target_os = "android")]
    proxy_applied: AtomicBool,
    #[cfg(target_os = "android")]
    extra_error: Mutex<Option<String>>,
    runner: ComponentRunner,
    #[cfg(not(target_os = "android"))]
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
        let settings_lock = Arc::new(Mutex::new(()));
        let socks_state: SharedSocksState = Arc::new(RwLock::new(SocksEndpoint::default()));
        let logs = Arc::new(Mutex::new(LogStore::new()));
        let logs_cb = logs.clone();
        #[cfg(target_os = "android")]
        let state_cb: Arc<dyn Fn(&str) + Send + Sync> = {
            let dir = install_dir.clone();
            let lock = settings_lock.clone();
            Arc::new(move |state: &str| {
                sync_logged_in_for_state(&dir, &lock, state);
            })
        };
        #[cfg(not(target_os = "android"))]
        let state_cb: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(|_| {});

        let runner = ComponentRunner::new(
            socks_state.clone(),
            Arc::new(move |line| {
                if let Ok(mut l) = logs_cb.lock() {
                    l.push(line);
                }
            }),
            state_cb,
        );
        Self {
            install_dir,
            settings_lock,
            socks_state,
            proxy_addr: RwLock::new(None),
            #[cfg(target_os = "android")]
            proxy_start_lock: Mutex::new(()),
            #[cfg(target_os = "android")]
            proxy_applied: AtomicBool::new(false),
            #[cfg(target_os = "android")]
            extra_error: Mutex::new(None),
            runner,
            #[cfg(not(target_os = "android"))]
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

    #[cfg(not(target_os = "android"))]
    fn current_path(&self) -> PathBuf {
        self.install_dir.join("current.json")
    }

    #[cfg(not(target_os = "android"))]
    fn settings_path(&self) -> PathBuf {
        settings_file_path(&self.install_dir)
    }

    fn state_dir(&self) -> PathBuf {
        self.install_dir.join("state")
    }

    fn log_file_path(&self) -> PathBuf {
        self.install_dir.join("tailnet.log")
    }

    #[cfg(not(target_os = "android"))]
    fn read_current(&self) -> Option<CurrentMeta> {
        let text = fs::read_to_string(self.current_path()).ok()?;
        let meta: CurrentMeta = serde_json::from_str(&text).ok()?;
        if self.install_dir.join(&meta.file).exists() {
            Some(meta)
        } else {
            None
        }
    }

    #[cfg(not(target_os = "android"))]
    fn write_current(&self, meta: &CurrentMeta) -> Result<(), String> {
        fs::create_dir_all(&self.install_dir)
            .map_err(|e| format!("无法创建目录 {}：{e}", self.install_dir.display()))?;
        let data = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
        atomic_write(&self.current_path(), data.as_bytes())
    }

    fn read_settings(&self) -> SettingsMeta {
        read_settings_locked(&self.install_dir, &self.settings_lock)
    }

    fn set_enabled_setting(&self, enabled: bool) -> Result<(), String> {
        update_settings_locked(&self.install_dir, &self.settings_lock, true, |s| {
            s.enabled = enabled;
        })
        .map(|_| ())
    }

    #[cfg(target_os = "android")]
    fn set_logged_in_setting(&self, logged_in: bool) {
        let _ = update_settings_locked(&self.install_dir, &self.settings_lock, false, |s| {
            s.logged_in = logged_in;
        });
    }

    pub fn proxy_addr(&self) -> Option<SocketAddr> {
        self.proxy_addr.read().ok().and_then(|g| *g)
    }

    #[cfg(target_os = "android")]
    fn set_extra_error(&self, err: Option<String>) {
        if let Ok(mut g) = self.extra_error.lock() {
            *g = err;
        }
    }

    #[cfg(target_os = "android")]
    fn extra_error(&self) -> Option<String> {
        self.extra_error.lock().ok().and_then(|g| g.clone())
    }

    /// 确保本地 HTTP 代理已启动（幂等，重复调用不会新开监听）。
    #[cfg(target_os = "android")]
    fn ensure_proxy_started(&self) -> Result<tauri::Url, String> {
        let _guard = self
            .proxy_start_lock
            .lock()
            .map_err(|_| "代理锁异常".to_string())?;
        if let Some(addr) = self.proxy_addr() {
            return format!("http://{addr}")
                .parse()
                .map_err(|e| format!("代理地址无效：{e}"));
        }
        let socks_state = self.socks_state.clone();
        let addr = tauri::async_runtime::block_on(proxy::start_http_proxy(socks_state))?;
        if let Ok(mut g) = self.proxy_addr.write() {
            *g = Some(addr);
        }
        self.log(format!("本地代理已就绪：http://{addr}"));
        format!("http://{addr}")
            .parse()
            .map_err(|e| format!("代理地址无效：{e}"))
    }

    #[cfg(not(target_os = "android"))]
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

#[cfg(not(target_os = "android"))]
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(target_os = "android")]
fn bundled_version(runner: &ComponentRunner) -> String {
    if let Some(v) = option_env!("COSYEE_TAILNET_VERSION") {
        let trimmed = v.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    if let Some(v) = runner.loaded_version() {
        if !v.is_empty() {
            return v;
        }
    }
    "内置".to_string()
}

/// Android 侧：启动内置组件库并维护崩溃保护标记（启动前写 starting.json，就绪稳定 10 秒后删除；
/// 正常返回错误也删除）。`reset_guard` 为 true 表示用户手动启用/登录/重启，先清旧计数重新计数。
#[cfg(target_os = "android")]
fn start_android_with_guard(
    mgr: &Arc<TailnetManager>,
    reset_guard: bool,
) -> Result<component::RunningInfo, String> {
    if reset_guard {
        clear_crash_guard(&mgr.install_dir);
        mgr.set_extra_error(None);
    }
    if let Err(e) = record_crash_guard_attempt(&mgr.install_dir) {
        mgr.log(format!("写入崩溃保护标记失败：{e}"));
    }
    match mgr.runner.start_bundled(mgr.state_dir(), mgr.log_file_path()) {
        Ok((info, gen)) => {
            let mgr_bg = mgr.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(CRASH_GUARD_STABLE_SECS));
                if mgr_bg.runner.is_generation_active(gen) {
                    clear_crash_guard(&mgr_bg.install_dir);
                }
            });
            Ok(info)
        }
        Err(e) => {
            clear_crash_guard(&mgr.install_dir);
            Err(e)
        }
    }
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

    #[cfg(target_os = "android")]
    {
        // 清理以前可选组件方式遗留的 current.json 和旧 .so，保留 state/、settings.json、日志
        cleanup_legacy_android_files(&mgr.install_dir);

        let (platform_key, _) = platform_support();
        platform_key?;

        let settings = mgr.read_settings();
        if !settings.enabled {
            return None;
        }

        // 连续 2 次启动阶段未稳定退出：自动停用并提示用户，避免启动即闪退死循环
        if should_auto_disable_on_startup(&mgr.install_dir) {
            let _ = mgr.set_enabled_setting(false);
            clear_crash_guard(&mgr.install_dir);
            mgr.set_extra_error(Some(CRASH_AUTO_DISABLE_MSG.to_string()));
            mgr.log(CRASH_AUTO_DISABLE_MSG);
            return None;
        }

        let proxy_url = match mgr.ensure_proxy_started() {
            Ok(u) => u,
            Err(e) => {
                mgr.log(format!("启动本地代理失败：{e}"));
                return None;
            }
        };

        // 组件异步启动，不阻塞主窗口显示（不重置崩溃计数，保留上次残留次数）
        let mgr_bg = mgr.clone();
        std::thread::spawn(move || {
            if let Err(e) = start_android_with_guard(&mgr_bg, false) {
                mgr_bg.log(format!("启动内置组件失败：{e}"));
            }
        });

        Some(proxy_url)
    }

    #[cfg(not(target_os = "android"))]
    {
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
}

/// 返回本次启动时生效的本地代理 URL（供 `main` 窗口和 Windows 上的 `kiro-admin` 窗口保持参数一致）。
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn proxy_url() -> Option<tauri::Url> {
    let mgr = MANAGER.get()?;
    let addr = mgr.proxy_addr()?;
    format!("http://{addr}").parse().ok()
}

/// 探测 host:port 是否可达：代理开启时按相同分流规则决定走 SOCKS5 还是直连；未开启时纯直连。
pub async fn probe_tcp(host: &str, port: u16) -> bool {
    if let Some(mgr) = MANAGER.get() {
        #[cfg(target_os = "android")]
        let proxy_on = mgr.proxy_addr().is_some() && mgr.proxy_applied.load(Ordering::SeqCst);
        #[cfg(not(target_os = "android"))]
        let proxy_on = mgr.proxy_addr().is_some();

        if proxy_on {
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

/// Android 侧：检查并清除 JNIEnv 上未处理的 Java 异常，绝不能带着异常返回 Java 侧。
/// 有异常时返回它的 toString()（取不到时返回占位说明），便于在日志和界面上看到真正原因。
#[cfg(target_os = "android")]
fn take_jni_exception(env: &mut jni::JNIEnv) -> Option<String> {
    if !env.exception_check().unwrap_or(false) {
        return None;
    }
    let thrown = env.exception_occurred().ok();
    let _ = env.exception_clear();
    let desc = thrown.and_then(|t| {
        if t.is_null() {
            return None;
        }
        let r = env
            .call_method(&*t, "toString", "()Ljava/lang/String;", &[])
            .and_then(|v| v.l());
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return None;
        }
        let js = jni::objects::JString::from(r.ok()?);
        env.get_string(&js).ok().map(String::from)
    });
    Some(desc.unwrap_or_else(|| "未知 Java 异常".to_string()))
}

/// Android 侧：通过 JNI 调用 MainActivity.setTailnetProxy 设置 WebView 代理。
#[cfg(target_os = "android")]
pub fn apply_android_proxy<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
    proxy_url: &tauri::Url,
) {
    // ProxyConfig 规则只接受 [scheme://]host[:port]；Url 序列化会带结尾 "/"，WebView 会判为非法规则并抛异常
    let url_str = match (proxy_url.host_str(), proxy_url.port()) {
        (Some(h), Some(p)) => format!("{}://{h}:{p}", proxy_url.scheme()),
        _ => proxy_url.as_str().trim_end_matches('/').to_string(),
    };
    let mgr = MANAGER.get().cloned();
    let res = window.with_webview(move |wv| {
        wv.jni_handle().exec(move |env, activity, _webview| {
            if activity.is_null() {
                if let Some(m) = &mgr {
                    m.proxy_applied.store(false, Ordering::SeqCst);
                    m.log("设置 Android WebView 代理失败：Activity 尚未就绪");
                }
                return;
            }
            let jurl = match env.new_string(&url_str) {
                Ok(s) => s,
                Err(e) => {
                    let _ = take_jni_exception(env);
                    if let Some(m) = &mgr {
                        m.proxy_applied.store(false, Ordering::SeqCst);
                        let msg = format!("设置 Android WebView 代理失败（创建字符串）：{e}");
                        m.log(msg.clone());
                        m.set_extra_error(Some(msg));
                    }
                    return;
                }
            };
            let call_res = env
                .call_method(
                    activity,
                    "setTailnetProxy",
                    "(Ljava/lang/String;)Z",
                    &[jni::objects::JValue::Object(&jurl)],
                )
                .and_then(|v| v.z());
            let exc = take_jni_exception(env);
            let outcome: Result<(), String> = match (call_res, exc) {
                (_, Some(desc)) => Err(format!("设置 Android WebView 代理失败：{desc}")),
                (Ok(true), None) => Ok(()),
                (Ok(false), None) => Err(PROXY_UNSUPPORTED_MSG.to_string()),
                (Err(e), None) => Err(format!("设置 Android WebView 代理失败（JNI）：{e}")),
            };
            if let Some(m) = &mgr {
                match outcome {
                    Ok(()) => {
                        m.proxy_applied.store(true, Ordering::SeqCst);
                        m.set_extra_error(None);
                        m.log(format!("已应用 Android WebView 代理：{url_str}"));
                    }
                    Err(msg) => {
                        m.proxy_applied.store(false, Ordering::SeqCst);
                        m.log(msg.clone());
                        m.set_extra_error(Some(msg));
                    }
                }
            }
        });
    });
    if let Err(e) = res {
        if let Some(m) = MANAGER.get() {
            m.proxy_applied.store(false, Ordering::SeqCst);
            m.log(format!("投递设置 Android WebView 代理任务失败：{e}"));
        }
    }
}

/// Android 侧：通过 JNI 调用 MainActivity.clearTailnetProxy 清除 WebView 代理覆写。
#[cfg(target_os = "android")]
pub fn clear_android_proxy<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) {
    let mgr = MANAGER.get().cloned();
    if let Some(m) = &mgr {
        m.proxy_applied.store(false, Ordering::SeqCst);
        m.set_extra_error(None);
    }
    let res = window.with_webview(move |wv| {
        wv.jni_handle().exec(move |env, activity, _webview| {
            if activity.is_null() {
                if let Some(m) = &mgr {
                    m.log("清除 Android WebView 代理失败：Activity 尚未就绪");
                }
                return;
            }
            let call_res = env.call_method(activity, "clearTailnetProxy", "()V", &[]);
            let exc = take_jni_exception(env);
            if let Some(desc) = exc {
                if let Some(m) = &mgr {
                    m.log(format!("清除 Android WebView 代理失败：{desc}"));
                }
            } else if let Err(e) = call_res {
                if let Some(m) = &mgr {
                    m.log(format!("清除 Android WebView 代理失败（JNI）：{e}"));
                }
            } else if let Some(m) = &mgr {
                m.log("已清除 Android WebView 代理");
            }
        });
    });
    if let Err(e) = res {
        if let Some(m) = MANAGER.get() {
            m.log(format!("投递清除 Android WebView 代理任务失败：{e}"));
        }
    }
}

// ───────────────────── Tauri 命令（严格按 CONTRACT.md） ─────────────────────

#[derive(Serialize)]
pub struct TailnetStatusResp {
    pub supported: bool,
    #[serde(rename = "unsupportedReason")]
    pub unsupported_reason: Option<String>,
    pub bundled: bool,
    pub installed: Option<String>,
    pub enabled: bool,
    #[serde(rename = "loggedIn")]
    pub logged_in: bool,
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

#[derive(Debug, Clone, Serialize)]
pub struct TailnetPeersResp {
    pub state: Option<String>,
    pub peers: Vec<component::PeerInfo>,
    pub outdated: bool,
    pub error: Option<String>,
}

/// 查询 tailnet 其它设备列表的纯辅助逻辑（组件未运行或旧版返回 404 均返回结构化提示，不报错）。
fn query_peers_for_info(info: Option<component::RunningInfo>) -> TailnetPeersResp {
    let Some(info) = info else {
        return TailnetPeersResp {
            state: None,
            peers: Vec::new(),
            outdated: false,
            error: Some("内置 Tailscale 组件未运行".into()),
        };
    };
    match component::fetch_control_peers(&info) {
        Ok(cp) => TailnetPeersResp {
            state: if cp.state.is_empty() {
                None
            } else {
                Some(cp.state)
            },
            peers: cp.peers,
            outdated: false,
            error: cp.error,
        },
        Err(component::FetchPeersError::Outdated) => TailnetPeersResp {
            state: None,
            peers: Vec::new(),
            outdated: true,
            error: Some(component::PEERS_OUTDATED_MSG.into()),
        },
        Err(component::FetchPeersError::Other(msg)) => TailnetPeersResp {
            state: None,
            peers: Vec::new(),
            outdated: false,
            error: Some(msg),
        },
    }
}

#[tauri::command]
pub async fn tailnet_peers() -> Result<TailnetPeersResp, String> {
    let mgr = manager()?;
    tauri::async_runtime::spawn_blocking(move || {
        let info = mgr.runner.running_info();
        query_peers_for_info(info)
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tailnet_status() -> Result<TailnetStatusResp, String> {
    let mgr = manager()?;
    tauri::async_runtime::spawn_blocking(move || {
        let (platform_key, unsupported_reason) = platform_support();
        let supported = platform_key.is_some();
        let bundled = cfg!(target_os = "android");

        #[cfg(target_os = "android")]
        let installed = if supported {
            Some(bundled_version(&mgr.runner))
        } else {
            None
        };
        #[cfg(not(target_os = "android"))]
        let installed = mgr.read_current().map(|c| c.version);

        let enabled = mgr.read_settings().enabled;

        #[cfg(target_os = "android")]
        let proxy_active = mgr.proxy_addr().is_some() && mgr.proxy_applied.load(Ordering::SeqCst);
        #[cfg(not(target_os = "android"))]
        let proxy_active = mgr.proxy_addr().is_some();

        let busy = mgr.busy.load(Ordering::SeqCst);

        #[cfg(target_os = "android")]
        let (latest, checked_at) = (None, None);
        #[cfg(not(target_os = "android"))]
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
                    #[cfg(target_os = "android")]
                    sync_logged_in_for_state(&mgr.install_dir, &mgr.settings_lock, &cs.state);
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

        #[cfg(target_os = "android")]
        let logged_in = mgr.read_settings().logged_in;
        #[cfg(not(target_os = "android"))]
        let logged_in = state.as_deref() == Some("Running");

        #[cfg(target_os = "android")]
        if error.is_none() {
            error = mgr.extra_error();
        }

        #[cfg(target_os = "android")]
        let needs_restart = false;
        #[cfg(not(target_os = "android"))]
        let needs_restart = installed.is_some() && enabled && !proxy_active;

        TailnetStatusResp {
            supported,
            unsupported_reason,
            bundled,
            installed,
            enabled,
            logged_in,
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
    #[cfg(target_os = "android")]
    {
        Err("内置 Tailscale 随客户端更新，无需安装".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let mgr = manager()?;
        tauri::async_runtime::spawn_blocking(move || {
            let (platform_key, reason) = platform_support();
            let platform_key = platform_key
                .ok_or_else(|| reason.unwrap_or_else(|| "当前平台不支持内置 Tailscale".into()))?;

            let mgr_log = mgr.clone();
            let m = manifest::fetch_verified_manifest_with_log(move |line| mgr_log.log(line))?;
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
}

#[tauri::command]
pub async fn tailnet_install() -> Result<TailnetInstallResp, String> {
    #[cfg(target_os = "android")]
    {
        Err("内置 Tailscale 随客户端更新，无需安装".into())
    }
    #[cfg(not(target_os = "android"))]
    {
        let mgr = manager()?;
        let guard = take_busy(&mgr)?;
        tauri::async_runtime::spawn_blocking(move || {
            let _g = guard;
            let (platform_key, reason) = platform_support();
            let platform_key = platform_key
                .ok_or_else(|| reason.unwrap_or_else(|| "当前平台不支持内置 Tailscale".into()))?;

            mgr.log("正在获取并校验组件清单（Ed25519）...");
            let mgr_log = mgr.clone();
            let m = manifest::fetch_verified_manifest_with_log(move |line| mgr_log.log(line))?;
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
                mgr.set_enabled_setting(true)?;
            }
            let enabled = mgr.read_settings().enabled;

            if let Ok(mut c) = mgr.check_cache.lock() {
                c.latest = Some(m.version.clone());
                c.checked_at = Some(now_millis());
            }

            let proxy_active = mgr.proxy_addr().is_some();
            let needs_restart = enabled && !proxy_active;

            // 如果代理已开且已启用，桌面端直接切换到新版本
            if proxy_active && enabled {
                mgr.log("正在重启组件以启用新版本...");
                if let Err(e) = mgr.start_component_if_installed() {
                    mgr.log(format!("重启新版本组件失败：{e}"));
                }
            }

            // 清理旧版本文件（跳过当前文件和仍在运行的旧文件）
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
}

#[tauri::command]
pub async fn tailnet_uninstall(keep_state: bool) -> Result<OkResp, String> {
    #[cfg(target_os = "android")]
    {
        let _ = keep_state;
        Err("内置 Tailscale 随客户端更新，无需安装".into())
    }
    #[cfg(not(target_os = "android"))]
    {
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
}

#[tauri::command]
pub async fn tailnet_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<SetEnabledResp, String> {
    let mgr = manager()?;
    let guard = take_busy(&mgr)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = guard;

        #[cfg(target_os = "android")]
        {
            if enabled {
                let (platform_key, reason) = platform_support();
                if platform_key.is_none() {
                    return Err(reason.unwrap_or_else(|| "当前平台不支持内置 Tailscale".into()));
                }
            }

            mgr.set_enabled_setting(enabled)?;

            if !enabled {
                mgr.runner.stop();
                clear_crash_guard(&mgr.install_dir);
                if let Some(w) = app.get_webview_window("main") {
                    clear_android_proxy(&w);
                } else {
                    mgr.proxy_applied.store(false, Ordering::SeqCst);
                    mgr.set_extra_error(None);
                }
                mgr.log("已停用内置 Tailscale");
            } else {
                let proxy_url = mgr.ensure_proxy_started()?;
                if let Some(w) = app.get_webview_window("main") {
                    apply_android_proxy(&w, &proxy_url);
                }
                if mgr.runner.running_info().is_none() {
                    if let Err(e) = start_android_with_guard(&mgr, true) {
                        mgr.log(format!("启用后启动组件失败：{e}"));
                    }
                }
            }

            Ok(SetEnabledResp {
                enabled,
                needs_restart: false,
            })
        }

        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            mgr.set_enabled_setting(enabled)?;
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

            let needs_restart = installed.is_some() && enabled && !proxy_active;

            Ok(SetEnabledResp {
                enabled,
                needs_restart,
            })
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailnet_login(app: tauri::AppHandle) -> Result<TailnetLoginResp, String> {
    let mgr = manager()?;

    #[cfg(target_os = "android")]
    let auth_url = {
        let guard = take_busy(&mgr)?;
        let app_bg = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            // 仅在启用与启动组件阶段持有 busy 互斥锁，启动完成后立即释放，避免等待登录期间长期占用
            let info = {
                let _g = guard;
                let (platform_key, reason) = platform_support();
                if platform_key.is_none() {
                    return Err(reason.unwrap_or_else(|| "当前平台不支持内置 Tailscale".into()));
                }
                if !mgr.read_settings().enabled {
                    mgr.set_enabled_setting(true)?;
                }
                let proxy_url = mgr.ensure_proxy_started()?;
                if !mgr.proxy_applied.load(Ordering::SeqCst) {
                    if let Some(w) = app_bg.get_webview_window("main") {
                        apply_android_proxy(&w, &proxy_url);
                    }
                }
                match mgr.runner.running_info() {
                    Some(i) => i,
                    None => start_android_with_guard(&mgr, true)?,
                }
            };

            // 启动后先等待状态离开 NoState / Starting（最多约 10 秒），避免已有登录状态时重复触发登录
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                if mgr.runner.running_info().is_none() {
                    return Err("组件已停止".into());
                }
                if let Ok(cs) = component::fetch_control_status(&info) {
                    component::sync_socks_state(&mgr.socks_state, Some(&info), cs.state == "Running");
                    sync_logged_in_for_state(&mgr.install_dir, &mgr.settings_lock, &cs.state);
                    match classify_login_wait_state(&cs.state) {
                        LoginWaitOutcome::NoLoginNeeded => {
                            return Ok::<String, String>(String::new());
                        }
                        LoginWaitOutcome::NeedLogin => break,
                        LoginWaitOutcome::KeepWaiting => {}
                    }
                }
                if std::time::Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(250));
            }

            if mgr.runner.running_info().is_none() {
                return Err("组件已停止".into());
            }
            let url = component::trigger_login(&info)?;
            if !url.starts_with("https://") {
                return Err("组件返回的登录链接不是 https 地址，已拒绝打开".into());
            }
            Ok::<String, String>(url)
        })
        .await
        .map_err(|e| e.to_string())??
    };

    #[cfg(not(target_os = "android"))]
    let auth_url = {
        let info = match mgr.runner.running_info() {
            Some(i) => i,
            None => {
                let guard = take_busy(&mgr)?;
                let mgr_start = mgr.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let _g = guard;
                    if let Some(i) = mgr_start.runner.running_info() {
                        return Ok::<_, String>(i);
                    }
                    mgr_start.start_component_if_installed()?;
                    mgr_start
                        .runner
                        .running_info()
                        .ok_or_else(|| "组件未能进入运行状态".to_string())
                })
                .await
                .map_err(|e| e.to_string())??
            }
        };
        tauri::async_runtime::spawn_blocking(move || {
            let url = component::trigger_login(&info)?;
            if !url.starts_with("https://") {
                return Err("组件返回的登录链接不是 https 地址，已拒绝打开".into());
            }
            Ok::<String, String>(url)
        })
        .await
        .map_err(|e| e.to_string())??
    };

    // 仅当返回了登录链接时用系统浏览器打开（桌面 + Android 均支持；Android 已登录/待审批返回空串时不打开）
    if !auth_url.is_empty() {
        if let Err(e) = app.opener().open_url(&auth_url, None::<&str>) {
            if let Ok(mgr) = manager() {
                mgr.log(format!("打开系统浏览器失败（请手动访问链接）：{e}"));
            }
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
        #[cfg(target_os = "android")]
        mgr.set_logged_in_setting(false);
        mgr.log("已登出 Tailscale 账号");
        Ok(OkResp { ok: true })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn tailnet_restart(app: tauri::AppHandle) -> Result<OkResp, String> {
    let mgr = manager()?;
    let guard = take_busy(&mgr)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _g = guard;
        mgr.log("正在重启内置 Tailscale 组件...");
        #[cfg(target_os = "android")]
        {
            let (platform_key, reason) = platform_support();
            if platform_key.is_none() {
                return Err(reason.unwrap_or_else(|| "当前平台不支持内置 Tailscale".into()));
            }
            let proxy_url = mgr.ensure_proxy_started()?;
            if !mgr.proxy_applied.load(Ordering::SeqCst) {
                if let Some(w) = app.get_webview_window("main") {
                    apply_android_proxy(&w, &proxy_url);
                }
            }
            start_android_with_guard(&mgr, true)?;
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = app;
            mgr.start_component_if_installed()?;
        }
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
pub async fn app_relaunch(app: tauri::AppHandle) -> Result<(), String> {
    if let Ok(mgr) = manager() {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            mgr.runner.stop();
            #[cfg(target_os = "android")]
            clear_crash_guard(&mgr.install_dir);
        })
        .await;
    }
    #[cfg(not(target_os = "android"))]
    {
        app.restart();
    }
    #[cfg(target_os = "android")]
    {
        let mgr = MANAGER.get().cloned();
        if let Some(w) = app.get_webview_window("main") {
            w.with_webview(move |wv| {
                wv.jni_handle().exec(move |env, activity, _webview| {
                    if activity.is_null() {
                        if let Some(m) = &mgr {
                            m.log("重启应用失败：Activity 尚未就绪");
                        }
                        return;
                    }
                    let call_res = env.call_method(activity, "relaunchApp", "()V", &[]);
                    let exc = take_jni_exception(env);
                    if let Some(desc) = exc {
                        if let Some(m) = &mgr {
                            m.log(format!("重启应用失败：{desc}"));
                        }
                    } else if let Err(e) = call_res {
                        if let Some(m) = &mgr {
                            m.log(format!("重启应用失败（JNI）：{e}"));
                        }
                    }
                });
            })
            .map_err(|e| {
                let msg = format!("投递重启应用任务失败：{e}");
                if let Some(m) = MANAGER.get() {
                    m.log(msg.clone());
                }
                msg
            })?;
            Ok(())
        } else {
            Err("找不到主窗口，无法重启应用".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};

    fn make_temp_dir(label: &str) -> PathBuf {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let n = SEQ.fetch_add(1, AtomicOrdering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "cosyee-tailnet-test-{label}-{}-{n}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn crash_guard_lifecycle_and_threshold() {
        let dir = make_temp_dir("crash-guard");

        // 初始无标记
        assert_eq!(read_crash_guard(&dir), 0);
        assert!(!should_auto_disable_on_startup(&dir));

        // 第一次启动未稳定留下 count = 1，不自动停用
        assert_eq!(record_crash_guard_attempt(&dir).unwrap(), 1);
        assert_eq!(read_crash_guard(&dir), 1);
        assert!(!should_auto_disable_on_startup(&dir));

        // 第二次启动再次崩溃留下 count = 2，下次启动触发自动停用
        assert_eq!(record_crash_guard_attempt(&dir).unwrap(), 2);
        assert_eq!(read_crash_guard(&dir), 2);
        assert!(should_auto_disable_on_startup(&dir));

        // 清除后归零，手动重新启用从 1 开始计数
        clear_crash_guard(&dir);
        assert_eq!(read_crash_guard(&dir), 0);
        assert!(!should_auto_disable_on_startup(&dir));
        assert_eq!(record_crash_guard_attempt(&dir).unwrap(), 1);

        // 损坏的 JSON 安全降级为 0
        fs::write(dir.join(CRASH_GUARD_FILE), b"{broken").unwrap();
        assert_eq!(read_crash_guard(&dir), 0);
        assert!(!should_auto_disable_on_startup(&dir));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cleanup_legacy_android_files_preserves_state_and_settings() {
        let dir = make_temp_dir("legacy-cleanup");
        fs::create_dir_all(dir.join("state")).unwrap();
        fs::write(dir.join("state").join("tailscaled.state"), b"keep").unwrap();
        fs::write(dir.join("settings.json"), br#"{"enabled":true}"#).unwrap();
        fs::write(dir.join("tailnet.log"), b"log line\n").unwrap();
        fs::write(dir.join(CRASH_GUARD_FILE), br#"{"count":1}"#).unwrap();
        fs::write(dir.join("current.json"), br#"{"version":"1.0.0","file":"x.so"}"#).unwrap();
        fs::write(dir.join("libcosyee_tailnet_1.0.0_android_arm64.so"), b"elf").unwrap();
        fs::write(dir.join(".libcosyee_tailnet_1.0.0_android_arm64.so.part"), b"tmp").unwrap();

        cleanup_legacy_android_files(&dir);

        assert!(!dir.join("current.json").exists());
        assert!(!dir.join("libcosyee_tailnet_1.0.0_android_arm64.so").exists());
        assert!(!dir.join(".libcosyee_tailnet_1.0.0_android_arm64.so.part").exists());
        assert!(dir.join("state").join("tailscaled.state").exists());
        assert!(dir.join("settings.json").exists());
        assert!(dir.join("tailnet.log").exists());
        assert!(dir.join(CRASH_GUARD_FILE).exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_meta_compat_and_locked_updates() {
        let dir = make_temp_dir("settings-meta");
        let lock = Mutex::new(());

        // 1. 兼容只有 enabled 字段的旧 settings.json（loggedIn 默认为 false）
        fs::write(settings_file_path(&dir), br#"{"enabled":true}"#).unwrap();
        let meta = read_settings_locked(&dir, &lock);
        assert!(meta.enabled);
        assert!(!meta.logged_in);

        // 2. 更新 loggedIn 时不能覆盖 enabled，且值变化时才写盘
        let (after_login, wrote) =
            update_settings_locked(&dir, &lock, false, |s| s.logged_in = true).unwrap();
        assert!(wrote);
        assert!(after_login.enabled);
        assert!(after_login.logged_in);

        // 再次设置为相同值：不写盘
        let (same, wrote_again) =
            update_settings_locked(&dir, &lock, false, |s| s.logged_in = true).unwrap();
        assert!(!wrote_again);
        assert!(same.enabled);
        assert!(same.logged_in);

        // 3. 更新 enabled=false 时保留 loggedIn=true
        let (after_disable, wrote_disable) =
            update_settings_locked(&dir, &lock, true, |s| s.enabled = false).unwrap();
        assert!(wrote_disable);
        assert!(!after_disable.enabled);
        assert!(after_disable.logged_in);

        // 4. sync_logged_in_for_state：Starting 不变、NeedsLogin 置 false、Running 置 true
        sync_logged_in_for_state(&dir, &lock, "Starting");
        assert!(read_settings_locked(&dir, &lock).logged_in);

        sync_logged_in_for_state(&dir, &lock, "NeedsLogin");
        let after_needs_login = read_settings_locked(&dir, &lock);
        assert!(!after_needs_login.enabled);
        assert!(!after_needs_login.logged_in);

        sync_logged_in_for_state(&dir, &lock, "Running");
        let after_running = read_settings_locked(&dir, &lock);
        assert!(!after_running.enabled);
        assert!(after_running.logged_in);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn login_wait_state_classification() {
        assert_eq!(classify_login_wait_state(""), LoginWaitOutcome::KeepWaiting);
        assert_eq!(classify_login_wait_state("NoState"), LoginWaitOutcome::KeepWaiting);
        assert_eq!(classify_login_wait_state("Starting"), LoginWaitOutcome::KeepWaiting);
        assert_eq!(classify_login_wait_state("Running"), LoginWaitOutcome::NoLoginNeeded);
        assert_eq!(
            classify_login_wait_state("NeedsMachineAuth"),
            LoginWaitOutcome::NoLoginNeeded
        );
        assert_eq!(classify_login_wait_state("NeedsLogin"), LoginWaitOutcome::NeedLogin);
        assert_eq!(classify_login_wait_state("Stopped"), LoginWaitOutcome::NeedLogin);
    }

    #[test]
    fn query_peers_handles_not_running_and_outdated() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        // 1. 组件未运行时返回空列表加提示，不报错
        let not_running = query_peers_for_info(None);
        assert!(not_running.peers.is_empty());
        assert!(!not_running.outdated);
        assert!(not_running.error.as_deref().unwrap_or("").contains("未运行"));

        // 2. 旧版组件返回 404 时返回可识别中文提示
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut buf = [0u8; 512];
            let _ = s.read(&mut buf);
            let _ = s.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 9\r\n\r\nnot found");
        });
        let info = component::RunningInfo {
            version: "1.0.0".into(),
            control: addr.to_string(),
            socks: "127.0.0.1:1".into(),
            token: "tok".into(),
            bin_file: "test".into(),
        };
        let outdated = query_peers_for_info(Some(info));
        assert!(outdated.peers.is_empty());
        assert!(outdated.outdated);
        assert_eq!(outdated.error.as_deref(), Some(component::PEERS_OUTDATED_MSG));
        h.join().unwrap();
    }
}
