// 外网 HTTP 客户端公共模块：统一处理代理（环境变量优先，其次 Windows 系统代理）、超时与中文错误提示。
// 仅用于访问外网（GitHub 等）；访问 127.0.0.1 的本地请求不走此模块。
use std::io::ErrorKind;
use std::time::Duration;

pub const USER_AGENT: &str = "cosyee-client";
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub const PER_READ_TIMEOUT: Duration = Duration::from_secs(60);
pub const MANIFEST_GLOBAL_TIMEOUT: Duration = Duration::from_secs(30);
pub const DOWNLOAD_GLOBAL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxySource {
    Env,
    System,
}

#[derive(Debug, Clone)]
pub struct ResolvedProxy {
    pub proxy: ureq::Proxy,
    /// 带 scheme 的完整代理 URL（供 reqwest / tauri-plugin-updater 等外部客户端复用）。
    pub url: String,
    pub source: ProxySource,
}

impl ResolvedProxy {
    /// 生成不含用户名、密码的安全展示地址（仅 host:port）。
    pub fn display_endpoint(&self) -> String {
        format!("{}:{}", self.proxy.host(), self.proxy.port())
    }
}

/// 生成供操作日志展示的代理说明（绝不包含用户名、密码）。
pub fn describe_proxy_for_log(resolved: Option<&ResolvedProxy>, target_name: &str) -> String {
    match resolved {
        Some(r) => match r.source {
            ProxySource::Env => {
                format!("通过环境变量代理 {} 访问 {target_name}", r.display_endpoint())
            }
            ProxySource::System => {
                format!("通过系统代理 {} 访问 {target_name}", r.display_endpoint())
            }
        },
        None => format!("直连 {target_name}"),
    }
}

/// 解析 Windows 注册表 `Internet Settings\ProxyServer` 字符串为可用的代理 URL。
///
/// 支持：
/// - 单一地址：`127.0.0.1:7890`、`http://127.0.0.1:7890`、`socks5://127.0.0.1:10808`
/// - 按协议分开：`http=127.0.0.1:7890;https=127.0.0.1:7890;socks=127.0.0.1:10808`
///
/// 优先级：`https` > `http` > `socks`（socks 键默认拼 `socks5h://`，由代理解析域名）。
/// 注意：Windows 下 `https=host:port` 表示用于 HTTPS 流量的 HTTP CONNECT 代理，本身走 `http://`。
pub fn parse_windows_proxy_server(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.contains('=') {
        let mut https_val: Option<&str> = None;
        let mut http_val: Option<&str> = None;
        let mut socks_val: Option<(&str, &str)> = None;

        for part in trimmed.split(';') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let Some((k, v)) = part.split_once('=') else {
                continue;
            };
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim();
            if val.is_empty() {
                continue;
            }
            match key.as_str() {
                "https" if https_val.is_none() => https_val = Some(val),
                "http" if http_val.is_none() => http_val = Some(val),
                "socks" | "socks5" | "socks5h" if socks_val.is_none() => {
                    socks_val = Some(("socks5h", val));
                }
                "socks4" | "socks4a" if socks_val.is_none() => {
                    socks_val = Some(("socks4a", val));
                }
                _ => {}
            }
        }

        // 按优先级依次尝试：https -> http -> socks
        if let Some(v) = https_val {
            if let Some(url) = normalize_proxy_entry(v, "http") {
                return Some(url);
            }
        }
        if let Some(v) = http_val {
            if let Some(url) = normalize_proxy_entry(v, "http") {
                return Some(url);
            }
        }
        if let Some((default_scheme, v)) = socks_val {
            if let Some(url) = normalize_proxy_entry(v, default_scheme) {
                return Some(url);
            }
        }
        return None;
    }

    // 单一地址（不带 `=`）
    let single = trimmed.trim_end_matches(';').trim();
    if single.is_empty() || single.contains(';') {
        return None;
    }
    normalize_proxy_entry(single, "http")
}

/// 校验并规范化单条代理地址。无 scheme 时要求必须是 `host:port`（含合法非零端口）并补全默认 scheme。
fn normalize_proxy_entry(val: &str, default_scheme: &str) -> Option<String> {
    let v = val.trim();
    if v.is_empty() || v.chars().any(char::is_whitespace) {
        return None;
    }

    let candidate = if let Some((scheme, rest)) = v.split_once("://") {
        let scheme_lower = scheme.to_ascii_lowercase();
        if !matches!(
            scheme_lower.as_str(),
            "http" | "https" | "socks" | "socks4" | "socks4a" | "socks5" | "socks5h"
        ) {
            return None;
        }
        if rest.is_empty() {
            return None;
        }
        // 带 scheme 时如为 socks:// 则统一为 socks5h:// 以便代理解析域名
        if scheme_lower == "socks" {
            format!("socks5h://{rest}")
        } else {
            format!("{scheme_lower}://{rest}")
        }
    } else {
        // 无 scheme 时必须是 host:port 形式（支持 IPv6 `[::1]:7890`）
        let (host, port_str) = v.rsplit_once(':')?;
        if host.is_empty() {
            return None;
        }
        let port: u16 = port_str.parse().ok()?;
        if port == 0 {
            return None;
        }
        format!("{default_scheme}://{v}")
    };

    let parsed = ureq::Proxy::new(&candidate).ok()?;
    if parsed.host().is_empty() {
        return None;
    }
    Some(candidate)
}

/// 从环境变量读取代理（HTTPS_PROXY / ALL_PROXY / HTTP_PROXY 优先于系统代理）。
fn resolve_env_proxy() -> Option<ResolvedProxy> {
    const ENV_KEYS: &[&str] = &[
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ];
    for key in ENV_KEYS {
        let Ok(raw) = std::env::var(key) else {
            continue;
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(proxy) = ureq::Proxy::new(trimmed) {
            let url = if trimmed.contains("://") {
                trimmed.to_string()
            } else {
                format!("http://{trimmed}")
            };
            return Some(ResolvedProxy {
                proxy,
                url,
                source: ProxySource::Env,
            });
        }
    }
    None
}

/// 读取 Windows 系统代理（HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings）。
#[cfg(windows)]
fn resolve_system_proxy() -> Option<ResolvedProxy> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;

    const REGISTRY_PATH: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let settings = hkcu.open_subkey_with_flags(REGISTRY_PATH, KEY_READ).ok()?;
    let enabled = settings
        .get_value::<u32, _>("ProxyEnable")
        .is_ok_and(|v| v == 1);
    if !enabled {
        return None;
    }
    let raw = settings.get_value::<String, _>("ProxyServer").ok()?;
    let url = parse_windows_proxy_server(&raw)?;
    let proxy = ureq::Proxy::new(&url).ok()?;
    Some(ResolvedProxy {
        proxy,
        url,
        source: ProxySource::System,
    })
}

#[cfg(not(windows))]
fn resolve_system_proxy() -> Option<ResolvedProxy> {
    None
}

/// 解析当前应使用的外网代理：环境变量优先，其次 Windows 系统代理。
pub fn resolve_proxy() -> Option<ResolvedProxy> {
    resolve_env_proxy().or_else(resolve_system_proxy)
}

/// 返回可用于 `tauri::Url::parse` 的代理 URL（供 tauri-plugin-updater 等使用）。
#[allow(dead_code)]
pub fn resolve_proxy_url() -> Option<String> {
    resolve_proxy().map(|r| r.url)
}

/// 构造外网请求用的 ureq::Agent，统一设置代理、连接超时（15s）、单次读取超时（60s）与全局超时。
pub fn build_external_agent(global_timeout: Option<Duration>) -> (ureq::Agent, Option<ResolvedProxy>) {
    let resolved = resolve_proxy();
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .proxy(resolved.as_ref().map(|r| r.proxy.clone()))
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_per_read(Some(PER_READ_TIMEOUT))
        .timeout_global(global_timeout)
        .user_agent(USER_AGENT)
        .build()
        .into();
    (agent, resolved)
}

/// 构造明确直连的 ureq::Agent（不读取环境变量或系统代理，供本地测试使用）。
#[cfg(test)]
pub fn build_direct_agent(
    global_timeout: Option<Duration>,
    per_read_timeout: Option<Duration>,
) -> ureq::Agent {
    ureq::Agent::config_builder()
        .proxy(None)
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_per_read(per_read_timeout)
        .timeout_global(global_timeout)
        .user_agent(USER_AGENT)
        .build()
        .into()
}

/// 判断 ureq 错误是否属于连接失败或超时（适合给出代理配置提示）。
pub fn is_connectivity_error(err: &ureq::Error) -> bool {
    match err {
        ureq::Error::Timeout(_)
        | ureq::Error::HostNotFound
        | ureq::Error::ConnectionFailed
        | ureq::Error::ConnectProxyFailed(_)
        | ureq::Error::Tls(_)
        | ureq::Error::Rustls(_) => true,
        ureq::Error::Io(io_err) => matches!(
            io_err.kind(),
            ErrorKind::ConnectionRefused
                | ErrorKind::ConnectionReset
                | ErrorKind::ConnectionAborted
                | ErrorKind::NotConnected
                | ErrorKind::AddrNotAvailable
                | ErrorKind::TimedOut
                | ErrorKind::UnexpectedEof
                | ErrorKind::BrokenPipe
        ),
        _ => false,
    }
}

/// 将访问 GitHub 时的网络错误格式化为可读的中文提示（原始错误附在括号内）。
pub fn format_github_error(action: &str, host: &str, err: &ureq::Error) -> String {
    if is_connectivity_error(err) {
        format!(
            "{action}：连不上 GitHub（{host}）。如果你通过代理上网，请开启系统代理，或设置 HTTPS_PROXY 环境变量后重试。（{err}）"
        )
    } else {
        format!("{action}：{err}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_proxy_server_single_address() {
        assert_eq!(
            parse_windows_proxy_server("127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_windows_proxy_server("  127.0.0.1:10809  ").as_deref(),
            Some("http://127.0.0.1:10809")
        );
        assert_eq!(
            parse_windows_proxy_server("http://127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        assert_eq!(
            parse_windows_proxy_server("socks5://127.0.0.1:10808").as_deref(),
            Some("socks5://127.0.0.1:10808")
        );
        assert_eq!(
            parse_windows_proxy_server("[::1]:7890").as_deref(),
            Some("http://[::1]:7890")
        );
    }

    #[test]
    fn parse_proxy_server_per_protocol_priority() {
        // 优先取 https
        assert_eq!(
            parse_windows_proxy_server(
                "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:10808"
            )
            .as_deref(),
            Some("http://127.0.0.1:7891")
        );
        // 大小写不敏感
        assert_eq!(
            parse_windows_proxy_server("HTTP=127.0.0.1:7890;HTTPS=127.0.0.1:7892").as_deref(),
            Some("http://127.0.0.1:7892")
        );
        // 没有 https 时退回 http
        assert_eq!(
            parse_windows_proxy_server("http=127.0.0.1:7890;socks=127.0.0.1:10808").as_deref(),
            Some("http://127.0.0.1:7890")
        );
        // https 条目无效时自动降级到有效的 http
        assert_eq!(
            parse_windows_proxy_server("https=bad_value;http=127.0.0.1:7890").as_deref(),
            Some("http://127.0.0.1:7890")
        );
    }

    #[test]
    fn parse_proxy_server_socks_only() {
        assert_eq!(
            parse_windows_proxy_server("socks=127.0.0.1:10808").as_deref(),
            Some("socks5h://127.0.0.1:10808")
        );
        assert_eq!(
            parse_windows_proxy_server("ftp=127.0.0.1:2121;socks=127.0.0.1:10808").as_deref(),
            Some("socks5h://127.0.0.1:10808")
        );
        assert_eq!(
            parse_windows_proxy_server("socks=socks5://127.0.0.1:10808").as_deref(),
            Some("socks5://127.0.0.1:10808")
        );
    }

    #[test]
    fn parse_proxy_server_empty_and_invalid() {
        for bad in [
            "",
            "   ",
            ";;;",
            "garbage",
            "not a proxy",
            "127.0.0.1:notaport",
            "127.0.0.1:0",
            ":7890",
            ":::",
            "http=",
            "https=",
            "=127.0.0.1:7890",
            "ftp=127.0.0.1:2121",
            "http://",
            "ftp://127.0.0.1:2121",
            "127.0.0.1:7890;127.0.0.1:7891",
        ] {
            assert_eq!(
                parse_windows_proxy_server(bad),
                None,
                "应拒绝非法 ProxyServer：{bad:?}"
            );
        }
    }

    #[test]
    fn proxy_log_never_leaks_credentials() {
        let raw = "http://alice:supersecret@127.0.0.1:7890";
        let p = ureq::Proxy::new(raw).unwrap();
        let resolved = ResolvedProxy {
            proxy: p,
            url: raw.to_string(),
            source: ProxySource::System,
        };
        let msg = describe_proxy_for_log(Some(&resolved), "GitHub");
        assert_eq!(msg, "通过系统代理 127.0.0.1:7890 访问 GitHub");
        assert!(!msg.contains("alice"));
        assert!(!msg.contains("supersecret"));

        assert_eq!(describe_proxy_for_log(None, "GitHub"), "直连 GitHub");
    }

    #[test]
    fn format_github_connectivity_error_is_readable() {
        let err = ureq::Error::Timeout(ureq::Timeout::Connect);
        let msg = format_github_error("获取版本信息失败", "github.com", &err);
        assert!(msg.contains("连不上 GitHub（github.com）"));
        assert!(msg.contains("系统代理"));
        assert!(msg.contains("HTTPS_PROXY"));
        assert!(msg.contains("timeout: connect"));
    }
}
