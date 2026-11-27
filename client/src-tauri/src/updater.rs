// 客户端自身自动更新模块：
// - Windows NSIS 安装版 / macOS .app：通过 tauri-plugin-updater 检查、验签下载并安装后重启（复用系统代理）。
// - Windows 免安装版（portable）/ Android：通过 http_client 读取 latest.json 比较版本，提示用户前往下载页或打开 APK 直链。
use std::collections::HashMap;
use std::path::Path;
#[cfg(desktop)]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri_plugin_opener::OpenerExt;

use crate::http_client::{self, MANIFEST_GLOBAL_TIMEOUT};

pub const LATEST_JSON_URL: &str =
    "https://github.com/cosyeezz/cosyee/releases/latest/download/latest.json";
pub const RELEASES_URL: &str = "https://github.com/cosyeezz/cosyee/releases";
const ALLOWED_URL_PREFIX: &str = "https://github.com/cosyeezz/cosyee/";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppVersionInfo {
    pub current: String,
    pub can_self_update: bool,
    pub is_portable: bool,
    pub release_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub notes: Option<String>,
    pub can_self_update: bool,
    pub download_url: String,
}

#[cfg(desktop)]
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateProgress {
    /// "idle" | "checking" | "downloading" | "installing"
    pub phase: String,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub percent: Option<u8>,
}

#[derive(Debug, Deserialize)]
struct LatestManifest {
    version: String,
    #[serde(default)]
    notes: Option<String>,
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    #[serde(default)]
    platforms: HashMap<String, ManifestPlatform>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct ManifestPlatform {
    #[serde(default)]
    url: String,
}

#[cfg(desktop)]
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[cfg(desktop)]
fn progress_store() -> &'static Mutex<AppUpdateProgress> {
    static STORE: OnceLock<Mutex<AppUpdateProgress>> = OnceLock::new();
    STORE.get_or_init(|| {
        Mutex::new(AppUpdateProgress {
            phase: "idle".into(),
            downloaded: 0,
            total: None,
            percent: None,
        })
    })
}

#[cfg(desktop)]
fn set_progress(phase: &str, downloaded: u64, total: Option<u64>) {
    let percent = total.and_then(|t| {
        if t == 0 {
            None
        } else {
            Some(((downloaded.saturating_mul(100)) / t).min(100) as u8)
        }
    });
    if let Ok(mut g) = progress_store().lock() {
        g.phase = phase.to_string();
        g.downloaded = downloaded;
        g.total = total;
        g.percent = percent;
    }
}

/// 判断给定目录是否为 Windows NSIS 安装目录（NSIS 安装器会在应用同目录写入 `uninstall.exe`）。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn is_nsis_installed_in(dir: &Path) -> bool {
    dir.join("uninstall.exe").is_file()
}

/// 判断当前运行的客户端是否支持应用内自更新。
pub fn can_self_update() -> bool {
    #[cfg(windows)]
    {
        std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(is_nsis_installed_in))
            .unwrap_or(false)
    }
    #[cfg(target_os = "macos")]
    {
        std::env::current_exe()
            .ok()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS"))
            .unwrap_or(false)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        false
    }
}

/// 是否为 Windows 免安装版（portable）。
fn is_windows_portable() -> bool {
    #[cfg(windows)]
    {
        !can_self_update()
    }
    #[cfg(not(windows))]
    {
        false
    }
}

/// 解析版本号（兼容可选的 `v` / `V` 前缀）。
pub fn parse_semver(raw: &str) -> Option<semver::Version> {
    let s = raw.trim().trim_start_matches(['v', 'V']);
    if s.is_empty() {
        return None;
    }
    semver::Version::parse(s).ok()
}

/// 判断 `latest` 是否比 `current` 更新。
///
/// 规则：
/// - 任一版本无法按 semver 解析则返回 false；
/// - `latest` 带预发布标识（如 `-dev.1`、`-rc.1`）时不视为可推送更新，避免把预发布版误判为比正式版新；
/// - `current` 是预发布版（如 `0.2.0-dev.1`）且 `latest` 是对应或更高正式版（如 `0.2.0`）时，semver 判定 `latest > current` 为 true。
pub fn is_newer_version(current: &str, latest: &str) -> bool {
    let (Some(cur), Some(lat)) = (parse_semver(current), parse_semver(latest)) else {
        return false;
    };
    if !lat.pre.is_empty() {
        return false;
    }
    lat > cur
}

fn clean_version(ver: &str) -> &str {
    ver.trim().trim_start_matches(['v', 'V'])
}

fn release_tag_url(ver: &str) -> String {
    let v = clean_version(ver);
    if v.is_empty() {
        RELEASES_URL.to_string()
    } else {
        format!("https://github.com/cosyeezz/cosyee/releases/tag/v{v}")
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn android_apk_url(manifest: &LatestManifest) -> String {
    if let Some(entry) = manifest.platforms.get("android-aarch64") {
        let u = entry.url.trim();
        if u.starts_with(ALLOWED_URL_PREFIX) {
            return u.to_string();
        }
    }
    let v = clean_version(&manifest.version);
    if v.is_empty() {
        RELEASES_URL.to_string()
    } else {
        format!(
            "https://github.com/cosyeezz/cosyee/releases/download/v{v}/Cosyee_{v}_android_arm64.apk"
        )
    }
}

fn download_url_for_manifest(manifest: &LatestManifest) -> String {
    #[cfg(target_os = "android")]
    {
        android_apk_url(manifest)
    }
    #[cfg(not(target_os = "android"))]
    {
        release_tag_url(&manifest.version)
    }
}

fn fetch_latest_manifest() -> Result<LatestManifest, String> {
    let (agent, _resolved) = http_client::build_external_agent(Some(MANIFEST_GLOBAL_TIMEOUT));
    let mut resp = agent
        .get(LATEST_JSON_URL)
        .call()
        .map_err(|e| http_client::format_github_error("检查客户端更新失败", "github.com", &e))?;
    let body = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| http_client::format_github_error("读取更新清单失败", "github.com", &e))?;
    serde_json::from_str::<LatestManifest>(&body)
        .map_err(|e| format!("解析更新清单失败：{e}"))
}

#[cfg(desktop)]
fn build_desktop_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri_plugin_updater::UpdaterExt;
    let mut builder = app.updater_builder();
    if let Some(proxy_str) = http_client::resolve_proxy_url() {
        if let Ok(url) = tauri::Url::parse(&proxy_str) {
            builder = builder.proxy(url);
        }
    }
    builder.build().map_err(|e| format!("初始化更新器失败：{e}"))
}

#[cfg(desktop)]
fn format_updater_error(action: &str, err: &tauri_plugin_updater::Error) -> String {
    let raw = err.to_string();
    let lower = raw.to_ascii_lowercase();
    if lower.contains("timeout")
        || lower.contains("timed out")
        || lower.contains("connect")
        || lower.contains("dns")
        || lower.contains("network")
        || lower.contains("hyper")
        || lower.contains("reqwest")
    {
        format!(
            "{action}：连不上 GitHub（github.com）。如果你通过代理上网，请开启系统代理，或设置 HTTPS_PROXY 环境变量后重试。（{raw}）"
        )
    } else {
        format!("{action}：{raw}")
    }
}

/// 获取当前客户端版本信息（不发网络请求）。
#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> AppVersionInfo {
    AppVersionInfo {
        current: app.package_info().version.to_string(),
        can_self_update: can_self_update(),
        is_portable: is_windows_portable(),
        release_url: RELEASES_URL.to_string(),
    }
}

/// 检查客户端更新。
#[tauri::command]
pub async fn app_update_check(app: tauri::AppHandle) -> Result<AppUpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let self_update = can_self_update();

    #[cfg(desktop)]
    if self_update {
        let updater = build_desktop_updater(&app)?;
        let update = updater
            .check()
            .await
            .map_err(|e| format_updater_error("检查客户端更新失败", &e))?;
        return Ok(match update {
            Some(u) if is_newer_version(&current, &u.version) => AppUpdateInfo {
                available: true,
                current,
                latest: u.version.clone(),
                notes: u.body.clone(),
                can_self_update: true,
                download_url: release_tag_url(&u.version),
            },
            _ => AppUpdateInfo {
                available: false,
                current: current.clone(),
                latest: current,
                notes: None,
                can_self_update: true,
                download_url: RELEASES_URL.to_string(),
            },
        });
    }

    // Windows 免安装版、macOS 开发运行、Android：走 http_client 读取 latest.json 并做 semver 比较
    let manifest = tauri::async_runtime::spawn_blocking(fetch_latest_manifest)
        .await
        .map_err(|e| format!("检查客户端更新失败：{e}"))??;
    let latest = clean_version(&manifest.version).to_string();
    let available = is_newer_version(&current, &latest);
    let download_url = if available {
        download_url_for_manifest(&manifest)
    } else {
        RELEASES_URL.to_string()
    };

    Ok(AppUpdateInfo {
        available,
        current,
        latest,
        notes: manifest.notes,
        can_self_update: self_update,
        download_url,
    })
}

/// 查询当前下载/安装进度（桌面端）。
#[cfg(desktop)]
#[tauri::command]
pub fn app_update_progress() -> AppUpdateProgress {
    progress_store()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_else(|_| AppUpdateProgress {
            phase: "idle".into(),
            downloaded: 0,
            total: None,
            percent: None,
        })
}

#[cfg(desktop)]
struct InstallingGuard;

#[cfg(desktop)]
impl Drop for InstallingGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
        set_progress("idle", 0, None);
    }
}

/// 下载并安装客户端更新，完成后重启（仅支持桌面安装版）。
#[cfg(desktop)]
#[tauri::command]
pub async fn app_update_install(app: tauri::AppHandle) -> Result<(), String> {
    if !can_self_update() {
        return Err("当前版本不支持自动更新，请前往发布页手动下载安装。".into());
    }
    if INSTALLING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("正在更新中，请稍候。".into());
    }
    let _guard = InstallingGuard;
    set_progress("checking", 0, None);

    let updater = build_desktop_updater(&app)?;
    let current = app.package_info().version.to_string();
    let update = updater
        .check()
        .await
        .map_err(|e| format_updater_error("获取更新信息失败", &e))?
        .filter(|u| is_newer_version(&current, &u.version))
        .ok_or_else(|| "当前已是最新版本。".to_string())?;

    set_progress("downloading", 0, None);
    let downloaded = std::sync::atomic::AtomicU64::new(0);
    update
        .download_and_install(
            |chunk_len, content_len| {
                let total_dl = downloaded
                    .fetch_add(chunk_len as u64, Ordering::Relaxed)
                    .saturating_add(chunk_len as u64);
                set_progress("downloading", total_dl, content_len);
            },
            || {
                let total_dl = downloaded.load(Ordering::Relaxed);
                set_progress("installing", total_dl, None);
            },
        )
        .await
        .map_err(|e| format_updater_error("下载或安装更新失败", &e))?;

    // 安装完成：先优雅停掉内置 Tailscale（若有），再重启应用
    let _ = crate::tailnet::app_relaunch(app).await;
    Ok(())
}

/// 在系统默认浏览器中打开 Cosyee 的 GitHub Release 页面或安装包直链。
#[tauri::command]
pub fn app_open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.starts_with(ALLOWED_URL_PREFIX) {
        return Err("不允许打开非 Cosyee 发布页链接。".into());
    }
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| format!("无法打开浏览器：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[test]
    fn version_comparison_basic_and_prerelease() {
        // 正式版升级
        assert!(is_newer_version("0.1.9", "0.2.0"));
        assert!(is_newer_version("v0.1.9", "v0.2.0"));
        assert!(is_newer_version("0.1.9", "0.1.10"));
        assert!(is_newer_version("0.1.9", "1.0.0"));

        // 相同或更旧
        assert!(!is_newer_version("0.2.0", "0.2.0"));
        assert!(!is_newer_version("0.2.0", "v0.2.0"));
        assert!(!is_newer_version("0.2.0", "0.1.9"));
        assert!(!is_newer_version("1.0.0", "0.9.9"));

        // -dev 预发布不被视为比正式版新
        assert!(!is_newer_version("0.2.0", "0.2.0-dev.1"));
        assert!(!is_newer_version("0.1.9", "0.2.0-dev.1"));
        assert!(!is_newer_version("0.2.0-dev.1", "0.2.0-dev.2"));
        assert!(!is_newer_version("0.1.9", "0.2.0-rc.1"));

        // 开发版可升级到对应或更高正式版
        assert!(is_newer_version("0.2.0-dev.1", "0.2.0"));
        assert!(is_newer_version("0.1.9-dev.5", "0.2.0"));
        assert!(!is_newer_version("0.2.0-dev.1", "0.1.9"));

        // 非法版本号安全返回 false
        assert!(!is_newer_version("", "0.2.0"));
        assert!(!is_newer_version("0.1.0", ""));
        assert!(!is_newer_version("not-a-ver", "0.2.0"));
        assert!(!is_newer_version("0.1.0", "not-a-ver"));
    }

    #[test]
    fn android_apk_url_prefers_manifest_entry_and_falls_back() {
        let mut platforms = HashMap::new();
        platforms.insert(
            "android-aarch64".to_string(),
            ManifestPlatform {
                url: "https://github.com/cosyeezz/cosyee/releases/download/v0.2.0/Cosyee_0.2.0_android_arm64.apk".into(),
            },
        );
        let m_with = LatestManifest {
            version: "0.2.0".into(),
            notes: None,
            platforms,
        };
        assert_eq!(
            android_apk_url(&m_with),
            "https://github.com/cosyeezz/cosyee/releases/download/v0.2.0/Cosyee_0.2.0_android_arm64.apk"
        );

        let m_fallback = LatestManifest {
            version: "v0.2.1".into(),
            notes: None,
            platforms: HashMap::new(),
        };
        assert_eq!(
            android_apk_url(&m_fallback),
            "https://github.com/cosyeezz/cosyee/releases/download/v0.2.1/Cosyee_0.2.1_android_arm64.apk"
        );
    }

    #[test]
    fn nsis_installed_detection() {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "cosyee-updater-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        assert!(!is_nsis_installed_in(&dir));
        fs::write(dir.join("uninstall.exe"), b"stub").unwrap();
        assert!(is_nsis_installed_in(&dir));

        let _ = fs::remove_dir_all(&dir);
    }
}
