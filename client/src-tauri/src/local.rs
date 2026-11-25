// 「本机服务」（仅桌面端）：在这台电脑上用 npm 安装 / 更新 / 启动 / 停止 Cosyee 服务端。
// 服务端包来自 GitHub 仓库的 server-dist 分支（CI 自动构建），不需要 git、也没有依赖和安装脚本：
//   npm install -g https://codeload.github.com/cosyeezz/cosyee/tar.gz/refs/heads/server-dist
// 启动时直接 `node <npm 全局目录>/cosyee-server/server.mjs`，作为独立后台进程运行（关掉客户端不影响服务）；
// 停止走服务端的 POST /api/shutdown（只接受本机回环，Windows 后台进程收不到信号）。
// 这些命令只对客户端自己的本地页面开放：Tauri 不允许远程页面（服务端网页）调用自定义命令。
use std::io::{BufRead, BufReader, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

pub const PACKAGE_URL: &str = "https://codeload.github.com/cosyeezz/cosyee/tar.gz/refs/heads/server-dist";
const PORT: u16 = 7878;

/// 安装日志（页面轮询 local_log 读增量）
static LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
static BUSY: AtomicBool = AtomicBool::new(false);

fn log(line: impl Into<String>) {
    if let Ok(mut l) = LOG.lock() {
        l.push(line.into());
    }
}

/// macOS / Linux 从 Dock 启动的 App 拿不到 shell 里配置的 PATH（nvm、Homebrew 等），从登录 shell 取一次。
#[cfg(unix)]
fn shell_path() -> Option<&'static str> {
    static P: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    P.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        let out = Command::new(shell)
            .args(["-ilc", "printf '__COSYEE_PATH__%s__COSYEE_PATH__' \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        let s = String::from_utf8_lossy(&out.stdout).into_owned();
        let mut parts = s.split("__COSYEE_PATH__");
        parts.next()?;
        let p = parts.next()?.trim().to_string();
        let base = std::env::var("PATH").unwrap_or_default();
        // 再补上常见位置，防止 shell 配置有问题
        Some(format!("{p}:{base}:/opt/homebrew/bin:/usr/local/bin"))
    })
    .as_deref()
}

/// 构造子进程：Windows 上不弹黑窗口（.cmd 通过 cmd /C 执行），unix 上用登录 shell 的 PATH。
fn command(program: &str, args: &[&str]) -> Command {
    #[cfg(windows)]
    let mut c = {
        use std::os::windows::process::CommandExt;
        let mut c = if program == "node" {
            Command::new("node")
        } else {
            let mut c = Command::new("cmd");
            c.arg("/D").arg("/C").arg(program);
            c
        };
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(unix)]
    let mut c = {
        let mut c = Command::new(program);
        if let Some(p) = shell_path() {
            c.env("PATH", p);
        }
        c
    };
    c.args(args).stdin(Stdio::null());
    c
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = command(program, args).stderr(Stdio::null()).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!s.is_empty()).then_some(s)
}

fn has_claude() -> bool {
    #[cfg(windows)]
    return run("where", &["claude"]).is_some();
    #[cfg(unix)]
    return run("sh", &["-c", "command -v claude"]).is_some();
}

fn npm_root() -> Option<PathBuf> {
    run("npm", &["root", "-g"]).map(|s| PathBuf::from(s.lines().last().unwrap_or("").trim()))
}

fn installed_version(root: &Path) -> Option<String> {
    let text = std::fs::read_to_string(root.join("cosyee-server").join("package.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("version")?.as_str().map(str::to_string)
}

/// 发一个最简单的 HTTP/1.0 请求到本机服务端，返回响应全文（不带 Origin，服务端按非浏览器请求处理）。
fn http_local(method: &str, path: &str) -> Option<String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    write!(s, "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\nContent-Length: 0\r\n\r\n").ok()?;
    let mut buf = String::new();
    s.read_to_string(&mut buf).ok()?;
    Some(buf)
}

/// 状态行是 200（Node 对 HTTP/1.0 请求也回 HTTP/1.1，只看状态码）
fn is_ok(r: &str) -> bool {
    r.lines().next().is_some_and(|l| l.split(' ').nth(1) == Some("200"))
}

fn running() -> bool {
    http_local("GET", "/api/running").is_some_and(|r| is_ok(&r) && r.contains("\"count\""))
}

fn home() -> PathBuf {
    let h = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default();
    PathBuf::from(h)
}

fn log_file() -> PathBuf {
    let dir = std::env::var_os("COSYEE_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".cosyee"));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("server.log")
}

fn tail(path: &Path, lines: usize) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[derive(Serialize)]
pub struct Status {
    node: Option<String>,
    npm: bool,
    claude: bool,
    installed: Option<String>,
    running: bool,
    busy: bool,
    log_file: String,
    package: &'static str,
}

fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> impl std::future::Future<Output = Result<T, String>> {
    let h = tauri::async_runtime::spawn_blocking(f);
    async move { h.await.map_err(|e| e.to_string()) }
}

#[tauri::command]
pub async fn local_status() -> Result<Status, String> {
    blocking(|| {
        let root = npm_root();
        Status {
            node: run("node", &["--version"]),
            npm: root.is_some(),
            claude: has_claude(),
            installed: root.as_deref().and_then(installed_version),
            running: running(),
            busy: BUSY.load(Ordering::SeqCst),
            log_file: log_file().display().to_string(),
            package: PACKAGE_URL,
        }
    })
    .await
}

/// 服务端最新版本清单（与服务端 components/server.ts 的 SERVER_LATEST_URL 相同）
const SERVER_LATEST_URL: &str = "https://raw.githubusercontent.com/cosyeezz/cosyee/server-dist/package.json";

/// 从 package.json 里取 version，只接受 `X.Y.Z` 或 `X.Y.Z-main.N`
fn parse_server_latest(body: &[u8]) -> Result<String, String> {
    let v: serde_json::Value = serde_json::from_slice(body).map_err(|_| "最新版本信息不是有效的 JSON".to_string())?;
    let ver = v.get("version").and_then(|x| x.as_str()).unwrap_or("").trim();
    let (base, main) = match ver.split_once("-main.") {
        Some((b, m)) => (b, Some(m)),
        None => (ver, None),
    };
    let num = |s: &str| !s.is_empty() && s.len() <= 9 && s.bytes().all(|c| c.is_ascii_digit());
    let parts: Vec<&str> = base.strip_prefix('v').unwrap_or(base).split('.').collect();
    if parts.len() == 3 && parts.iter().all(|p| num(p)) && main.is_none_or(num) {
        Ok(ver.to_string())
    } else {
        Err("服务端最新版本号格式无效".into())
    }
}

/// 客户端自己查服务端最新版（走公共 HTTP 客户端，自动支持系统代理），不需要服务端在运行
#[tauri::command]
pub async fn server_latest() -> Result<String, String> {
    blocking(|| {
        let (agent, _) =
            crate::http_client::build_external_agent(Some(Duration::from_secs(15)));
        let bytes = agent
            .get(SERVER_LATEST_URL)
            .call()
            .map_err(|e| {
                crate::http_client::format_github_error(
                    "读取最新版本失败",
                    "raw.githubusercontent.com",
                    &e,
                )
            })?
            .body_mut()
            .with_config()
            .limit(256 * 1024)
            .read_to_vec()
            .map_err(|e| {
                crate::http_client::format_github_error(
                    "读取最新版本失败",
                    "raw.githubusercontent.com",
                    &e,
                )
            })?;
        parse_server_latest(&bytes)
    })
    .await?
}

/// 读安装日志：返回第 from 行之后的内容
#[tauri::command]
pub fn local_log(from: usize) -> Vec<String> {
    LOG.lock().map(|l| l.get(from..).map(<[String]>::to_vec).unwrap_or_default()).unwrap_or_default()
}

struct BusyGuard;
impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}
fn take_busy() -> Result<BusyGuard, String> {
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("另一个操作还在进行".into());
    }
    Ok(BusyGuard)
}

/// npm install -g（安装和更新是同一个命令；--prefer-online 保证拿到分支最新的包）
#[tauri::command]
pub async fn local_install() -> Result<String, String> {
    let guard = take_busy()?;
    blocking(move || {
        let _g = guard;
        clear_log();
        install_inner()
    })
    .await?
}

fn clear_log() {
    if let Ok(mut l) = LOG.lock() {
        l.clear();
    }
}

fn install_inner() -> Result<String, String> {
    let args = ["install", "-g", "--prefer-online", "--no-fund", "--no-audit", PACKAGE_URL];
    log(format!("> npm {}", args.join(" ")));
    let mut child = command("npm", &args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("无法运行 npm（先安装 Node.js 24+）：{e}"))?;
    let err = child.stderr.take().map(|e| {
        std::thread::spawn(move || {
            for line in BufReader::new(e).lines().map_while(Result::ok) {
                log(line);
            }
        })
    });
    if let Some(out) = child.stdout.take() {
        for line in BufReader::new(out).lines().map_while(Result::ok) {
            log(line);
        }
    }
    if let Some(t) = err {
        let _ = t.join();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        log(format!("npm 退出码 {}", status.code().unwrap_or(-1)));
        return Err("安装失败，详情见日志".into());
    }
    let v = npm_root().as_deref().and_then(installed_version).ok_or("安装完成，但没找到 cosyee-server 包")?;
    log(format!("已安装 cosyee-server {v}"));
    Ok(v)
}

fn start_params_file() -> PathBuf {
    log_file().with_file_name("client-start.json")
}

fn remember_start(tailnet: bool) {
    let _ = std::fs::write(start_params_file(), serde_json::json!({ "tailnet": tailnet }).to_string());
}

/// 上次由客户端启动服务端时的 tailnet 参数；从没记录过（服务端不是客户端启动的）返回 None。
fn last_start() -> Option<bool> {
    let text = std::fs::read_to_string(start_params_file()).ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()?.get("tailnet")?.as_bool()
}

/// 后台启动服务端。tailnet=true 时监听 Tailscale（手机和其它电脑可连），否则只给本机用。
#[tauri::command]
pub async fn local_start(tailnet: bool) -> Result<(), String> {
    let guard = take_busy()?;
    blocking(move || {
        let _g = guard;
        start_inner(tailnet)
    })
    .await?
}

/// 启动成功后记下这次的启动参数，客户端自动更新服务端时按它重启（客户端重启后也沿用）。
fn start_inner(tailnet: bool) -> Result<(), String> {
    // 服务端本来就在跑时不知道它的参数，不覆盖记录
    if spawn_server(tailnet)? {
        remember_start(tailnet);
    }
    Ok(())
}

fn spawn_server(tailnet: bool) -> Result<bool, String> {
    if running() {
        return Ok(false);
    }
    let root = npm_root().ok_or("找不到 npm（先安装 Node.js 24+）")?;
    let entry = root.join("cosyee-server").join("server.mjs");
    if !entry.exists() {
        return Err("还没安装服务端".into());
    }
    let lf = log_file();
    let file = std::fs::File::create(&lf).map_err(|e| format!("无法写日志 {}：{e}", lf.display()))?;
    let file2 = file.try_clone().map_err(|e| e.to_string())?;
    let entry_s = entry.to_string_lossy().into_owned();
    let mut c = command("node", &[&entry_s]);
    c.current_dir(home())
        .env("COSYEE_HOST", if tailnet { "tailscale" } else { "127.0.0.1" })
        .env("COSYEE_PORT", PORT.to_string())
        .stdout(Stdio::from(file))
        .stderr(Stdio::from(file2));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP：没有窗口，也不跟客户端共享 Ctrl+C
        c.creation_flags(0x0800_0000 | 0x0000_0200);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        c.process_group(0);
    }
    let mut child = c.spawn().map_err(|e| format!("无法启动 node：{e}"))?;
    let started = Instant::now();
    loop {
        if running() {
            // 回收子进程（服务端退出时不留僵尸进程）；客户端退出不影响服务端
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Ok(true);
        }
        if let Ok(Some(st)) = child.try_wait() {
            return Err(format!("服务端退出了（{st}）：\n{}", tail(&lf, 12)));
        }
        if started.elapsed() > Duration::from_secs(15) {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return Err(format!("等了 15 秒服务端还没响应：\n{}", tail(&lf, 12)));
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

#[tauri::command]
pub async fn local_stop() -> Result<(), String> {
    let guard = take_busy()?;
    blocking(move || {
        let _g = guard;
        stop_inner()
    })
    .await?
}

fn stop_inner() -> Result<(), String> {
    let r = http_local("POST", "/api/shutdown").ok_or("服务端没有运行")?;
    if !is_ok(&r) {
        return Err("这个服务端版本不支持从客户端停止（先更新），或者 7878 端口上是别的程序".into());
    }
    let started = Instant::now();
    while running() {
        if started.elapsed() > Duration::from_secs(15) {
            return Err("服务端 15 秒内没有退出".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
    Ok(())
}

// ───────────── 本机服务端扩展接口（kiro.rs / Antigravity CLI） ─────────────

#[derive(Debug, PartialEq, Eq)]
struct HttpResponse {
    status: u16,
    body: String,
}

/// 返回给页面的结构化错误，便于区分服务端未运行、旧版服务端（404）、403、409（带 running 数）等。
#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LocalApiError {
    Offline { error: String },
    Unsupported { error: String },
    Forbidden { error: String },
    Conflict { error: String, running: Option<u64> },
    Other { status: Option<u16>, error: String },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KiroServiceAction {
    Start,
    Stop,
    Restart,
}

fn decode_chunked(input: &str) -> Result<String, String> {
    let mut rest = input;
    let mut out = String::new();
    loop {
        let (size_line, after_size) = rest
            .split_once("\r\n")
            .or_else(|| rest.split_once('\n'))
            .ok_or_else(|| "分块响应格式不完整".to_string())?;
        let hex = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(hex, 16).map_err(|_| "分块响应长度无效".to_string())?;
        if size == 0 {
            break;
        }
        // 用 get 而不是 split_at：边界落在多字节字符中间时报错，不 panic
        let (Some(chunk), Some(tail)) = (after_size.get(..size), after_size.get(size..)) else {
            return Err("分块响应内容被截断".into());
        };
        out.push_str(chunk);
        rest = tail
            .strip_prefix("\r\n")
            .or_else(|| tail.strip_prefix('\n'))
            .unwrap_or(tail);
    }
    Ok(out)
}

fn parse_http_response(raw: &str) -> Result<HttpResponse, String> {
    let (head, body_raw) = raw
        .split_once("\r\n\r\n")
        .or_else(|| raw.split_once("\n\n"))
        .ok_or_else(|| "服务端响应格式无效".to_string())?;
    let status_line = head.lines().next().ok_or_else(|| "服务端响应缺少状态行".to_string())?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "无法解析服务端响应状态码".to_string())?;
    let chunked = head.lines().skip(1).any(|line| {
        line.split_once(':')
            .is_some_and(|(k, v)| k.trim().eq_ignore_ascii_case("transfer-encoding") && v.to_ascii_lowercase().contains("chunked"))
    });
    let body = if chunked { decode_chunked(body_raw)? } else { body_raw.to_string() };
    Ok(HttpResponse { status, body })
}

fn decode_api_response(resp: HttpResponse) -> Result<serde_json::Value, LocalApiError> {
    if (200..300).contains(&resp.status) {
        return serde_json::from_str(&resp.body).map_err(|e| LocalApiError::Other {
            status: Some(resp.status),
            error: format!("服务端返回的数据格式无法解析：{e}"),
        });
    }
    let parsed = serde_json::from_str::<serde_json::Value>(&resp.body).ok();
    let msg = parsed
        .as_ref()
        .and_then(|v| v.get("error"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let running = parsed.as_ref().and_then(|v| v.get("running")).and_then(|v| v.as_u64());
    match resp.status {
        404 => Err(LocalApiError::Unsupported {
            error: msg.unwrap_or_else(|| "当前服务端版本不支持该功能，请先更新服务端".into()),
        }),
        403 => Err(LocalApiError::Forbidden {
            error: msg.unwrap_or_else(|| "服务端拒绝了该请求（403）".into()),
        }),
        409 => Err(LocalApiError::Conflict {
            error: msg.unwrap_or_else(|| "当前状态无法执行该操作（409）".into()),
            running,
        }),
        code => Err(LocalApiError::Other {
            status: Some(code),
            error: msg.unwrap_or_else(|| format!("服务端返回错误（HTTP {code}）")),
        }),
    }
}

/// 发 HTTP/1.0 请求到本机服务端，读到 EOF，返回解析后的状态码与响应体。
fn http_local_with_timeout(method: &str, path: &str, timeout: Duration) -> Result<HttpResponse, LocalApiError> {
    let addr = SocketAddr::from(([127, 0, 0, 1], PORT));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(800)).map_err(|e| match e.kind() {
        ErrorKind::ConnectionRefused | ErrorKind::TimedOut | ErrorKind::AddrNotAvailable | ErrorKind::NotConnected => {
            LocalApiError::Offline {
                error: "服务端未运行".into(),
            }
        }
        _ => LocalApiError::Offline {
            error: format!("无法连接本机服务端：{e}"),
        },
    })?;
    let _ = s.set_write_timeout(Some(Duration::from_secs(5)));
    let _ = s.set_read_timeout(Some(timeout));
    write!(
        s,
        "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{PORT}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    )
    .map_err(|e| LocalApiError::Other {
        status: None,
        error: format!("向服务端发送请求失败：{e}"),
    })?;
    let mut bytes = Vec::new();
    s.read_to_end(&mut bytes).map_err(|e| match e.kind() {
        ErrorKind::TimedOut | ErrorKind::WouldBlock => LocalApiError::Other {
            status: None,
            error: format!("等待服务端响应超时（{} 秒）", timeout.as_secs()),
        },
        ErrorKind::ConnectionReset | ErrorKind::UnexpectedEof if bytes.is_empty() => LocalApiError::Offline {
            error: "服务端连接中断".into(),
        },
        _ => LocalApiError::Other {
            status: None,
            error: format!("读取服务端响应失败：{e}"),
        },
    })?;
    let raw = String::from_utf8_lossy(&bytes);
    parse_http_response(&raw).map_err(|error| LocalApiError::Other { status: None, error })
}

async fn local_api_request(method: &'static str, path: String, timeout: Duration) -> Result<serde_json::Value, LocalApiError> {
    blocking(move || {
        let resp = http_local_with_timeout(method, &path, timeout)?;
        decode_api_response(resp)
    })
    .await
    .map_err(|error| LocalApiError::Other { status: None, error })?
}

fn validate_account_id(account: &str) -> Result<(), String> {
    if account.is_empty() || account.len() > 64 {
        return Err("账号标识长度无效".into());
    }
    if !account.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err("账号标识包含非法字符".into());
    }
    Ok(())
}

/// 严格校验 kiro.rs 管理页面地址：必须为 http://127.0.0.1:<port>/admin，无多余路径、查询参数或用户信息。
fn validate_kiro_admin_url(url_str: &str) -> Result<(tauri::Url, String), String> {
    let parsed = tauri::Url::parse(url_str).map_err(|_| "服务端返回的管理页面地址无效".to_string())?;
    if parsed.scheme() != "http"
        || parsed.host_str() != Some("127.0.0.1")
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/admin"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err("管理页面地址不在允许的本机路径范围内".into());
    }
    let origin = parsed.origin().ascii_serialization();
    Ok((parsed, origin))
}

/// 构造管理页面初始化脚本：仅当 location.origin 匹配时写入上游 admin-ui 的 adminApiKey，所有字面量用 serde_json 编码。
fn build_admin_init_script(origin: &str, key: &str) -> Result<String, String> {
    let origin_lit = serde_json::to_string(origin).map_err(|e| e.to_string())?;
    let key_lit = serde_json::to_string(key).map_err(|e| e.to_string())?;
    Ok(format!(
        "(function(){{try{{if(location.origin==={origin_lit}){{localStorage.setItem(\"adminApiKey\",{key_lit});}}}}catch(e){{}}}})();"
    ))
}

#[tauri::command]
pub async fn kiro_status() -> Result<serde_json::Value, LocalApiError> {
    local_api_request("GET", "/api/kiro".into(), Duration::from_secs(5)).await
}

#[tauri::command]
pub async fn kiro_check() -> Result<serde_json::Value, LocalApiError> {
    local_api_request("POST", "/api/kiro/engine/check".into(), Duration::from_secs(30)).await
}

#[tauri::command]
pub async fn kiro_build() -> Result<serde_json::Value, LocalApiError> {
    local_api_request("POST", "/api/kiro/engine/build".into(), Duration::from_secs(15)).await
}

#[tauri::command]
pub async fn kiro_log(from: usize) -> Result<serde_json::Value, LocalApiError> {
    local_api_request("GET", format!("/api/kiro/engine/log?from={from}"), Duration::from_secs(5)).await
}

#[tauri::command]
pub async fn kiro_service(action: KiroServiceAction, force: Option<bool>) -> Result<serde_json::Value, LocalApiError> {
    let path = match (action, force.unwrap_or(false)) {
        (KiroServiceAction::Start, _) => "/api/kiro/service/start",
        (KiroServiceAction::Stop, false) => "/api/kiro/service/stop",
        (KiroServiceAction::Stop, true) => "/api/kiro/service/stop?force=1",
        (KiroServiceAction::Restart, false) => "/api/kiro/service/restart",
        (KiroServiceAction::Restart, true) => "/api/kiro/service/restart?force=1",
    };
    local_api_request("POST", path.into(), Duration::from_secs(30)).await
}

/// 打开 kiro.rs 自带的管理页面独立窗口：密钥仅在 Rust 内部经 initialization_script 注入，绝不返回给主页面、不写日志。
/// 新窗口 label 为 `kiro-admin-<account>`，不在任何 capabilities/*.json 中，调不到任何 Tauri 命令；导航限制在同 origin。
#[tauri::command]
pub async fn kiro_admin(app: tauri::AppHandle, account: String) -> Result<(), LocalApiError> {
    validate_account_id(&account).map_err(|error| LocalApiError::Other { status: None, error })?;
    let val = local_api_request(
        "POST",
        format!("/api/kiro/service/admin?account={account}"),
        Duration::from_secs(30),
    )
    .await?;
    let url_str = val
        .get("url")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| LocalApiError::Other {
            status: None,
            error: "服务端未返回管理页面地址".into(),
        })?;
    let key = val
        .get("key")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| LocalApiError::Other {
            status: None,
            error: "服务端未返回管理密钥".into(),
        })?;
    let (parsed_url, expected_origin) =
        validate_kiro_admin_url(url_str).map_err(|error| LocalApiError::Other { status: None, error })?;
    let init_script =
        build_admin_init_script(&expected_origin, key).map_err(|error| LocalApiError::Other { status: None, error })?;

    let label = format!("kiro-admin-{account}");
    if let Some(existing) = app.get_webview_window(&label) {
        let same_origin = existing
            .url()
            .ok()
            .is_some_and(|u| u.origin().ascii_serialization() == expected_origin);
        if same_origin {
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            return Ok(());
        }
        // 代理重启后端口可能变化，销毁旧窗口再重建
        let _ = existing.destroy();
    }

    let allowed_origin = expected_origin.clone();
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed_url))
        .title("kiro.rs 管理页面")
        .inner_size(1180.0, 780.0)
        .min_inner_size(640.0, 480.0)
        .decorations(true)
        .incognito(true)
        .initialization_script(&init_script)
        .on_navigation(move |u| u.origin().ascii_serialization() == allowed_origin);
    // Windows 上 WebView2 要求同进程内所有窗口的 additional_browser_arguments（含 --proxy-server）保持一致，
    // 否则创建第二个窗口会失败；本地代理对 127.0.0.1 会直接直连。
    let builder = if let Some(proxy_url) = crate::tailnet::proxy_url() {
        builder.proxy_url(proxy_url)
    } else {
        builder
    };
    builder
        .build()
        .map_err(|e| LocalApiError::Other {
            status: None,
            error: format!("无法打开管理页面窗口：{e}"),
        })?;
    Ok(())
}

#[tauri::command]
pub async fn agy_status() -> Result<serde_json::Value, LocalApiError> {
    local_api_request("GET", "/api/agy/cli".into(), Duration::from_secs(5)).await
}

#[tauri::command]
pub async fn agy_check() -> Result<serde_json::Value, LocalApiError> {
    local_api_request("POST", "/api/agy/cli/check".into(), Duration::from_secs(30)).await
}

#[tauri::command]
pub async fn agy_update() -> Result<serde_json::Value, LocalApiError> {
    local_api_request("POST", "/api/agy/cli/update".into(), Duration::from_secs(15)).await
}

#[tauri::command]
pub async fn agy_log(from: usize) -> Result<serde_json::Value, LocalApiError> {
    local_api_request("GET", format!("/api/agy/cli/log?from={from}"), Duration::from_secs(5)).await
}

#[tauri::command]
pub async fn agy_restart(force: Option<bool>) -> Result<serde_json::Value, LocalApiError> {
    let path = if force.unwrap_or(false) {
        "/api/agy/cli/restart?force=1"
    } else {
        "/api/agy/cli/restart"
    };
    local_api_request("POST", path.into(), Duration::from_secs(30)).await
}

// ───────────── 本机组件（Claude CLI / kiro.rs / agy / 内置浏览器 / cosyee 服务端）版本管理 ─────────────

const COMPONENT_IDS: [&str; 5] = ["claude", "kiro", "agy", "browser", "server"];

/// id 只能是这几个固定值，拼进请求路径前先校验。
fn component_id(id: &str) -> Result<&'static str, LocalApiError> {
    COMPONENT_IDS.iter().copied().find(|c| *c == id).ok_or_else(|| LocalApiError::Other {
        status: None,
        error: format!("未知组件：{id}"),
    })
}

#[tauri::command]
pub async fn components_status() -> Result<serde_json::Value, LocalApiError> {
    local_api_request("GET", "/api/components".into(), Duration::from_secs(5)).await
}

#[tauri::command]
pub async fn component_check(id: String) -> Result<serde_json::Value, LocalApiError> {
    let id = component_id(&id)?;
    local_api_request("POST", format!("/api/components/{id}/check"), Duration::from_secs(30)).await
}

#[tauri::command]
pub async fn component_update(id: String) -> Result<serde_json::Value, LocalApiError> {
    let id = component_id(&id)?;
    local_api_request("POST", format!("/api/components/{id}/update"), Duration::from_secs(15)).await
}

#[tauri::command]
pub async fn component_auto(id: String, enabled: bool) -> Result<serde_json::Value, LocalApiError> {
    let id = component_id(&id)?;
    let flag = u8::from(enabled);
    local_api_request("POST", format!("/api/components/{id}/auto?enabled={flag}"), Duration::from_secs(5)).await
}

#[tauri::command]
pub async fn component_log(id: String, from: usize) -> Result<serde_json::Value, LocalApiError> {
    let id = component_id(&id)?;
    local_api_request("GET", format!("/api/components/{id}/log?from={from}"), Duration::from_secs(5)).await
}

// ───────────── 客户端自动更新 cosyee 服务端 ─────────────
// 服务端不能在运行中替换自己：客户端开着时每小时看一次 /api/components，
// 有新版、自动更新开着、不是自定义、没有任务在跑时，由客户端停服务 → npm 安装 → 按上次的参数重新启动。

const AUTO_UPDATE_FIRST_DELAY: Duration = Duration::from_secs(5 * 60);
const AUTO_UPDATE_INTERVAL: Duration = Duration::from_secs(60 * 60);

/// 是否应该现在自动更新服务端。components 是 GET /api/components 的响应，running_count 是 GET /api/running 的 count。
/// 数据缺失或格式不对一律不更新。
fn should_auto_update_server(components: &serde_json::Value, running_count: Option<u64>) -> bool {
    if running_count != Some(0) {
        return false;
    }
    let Some(server) = components
        .get("list")
        .and_then(|l| l.as_array())
        .and_then(|l| l.iter().find(|c| c.get("id").and_then(|v| v.as_str()) == Some("server")))
    else {
        return false;
    };
    let flag = |k: &str| server.get(k).and_then(|v| v.as_bool());
    flag("installed") == Some(true)
        && flag("custom") == Some(false)
        && flag("updateAvailable") == Some(true)
        && flag("autoUpdate") == Some(true)
}

fn api_get(path: &str) -> Option<serde_json::Value> {
    let resp = http_local_with_timeout("GET", path, Duration::from_secs(5)).ok()?;
    decode_api_response(resp).ok()
}

fn api_running_count() -> Option<u64> {
    api_get("/api/running")?.get("count")?.as_u64()
}

/// 每小时一次的检查；返回时服务端要么没动，要么已经按原参数重新启动（失败会写日志）。
fn auto_update_tick() {
    let Some(components) = api_get("/api/components") else { return };
    if !should_auto_update_server(&components, api_running_count()) {
        return;
    }
    // 只更新由客户端 npm 安装的那份
    if npm_root().as_deref().and_then(installed_version).is_none() {
        return;
    }
    let Some(tailnet) = last_start() else {
        log("自动更新：不知道服务端是怎么启动的（不是客户端启动的），跳过");
        return;
    };
    let Ok(_guard) = take_busy() else { return };
    // 拿到操作权后再确认一次没有任务，缩小窗口
    if api_running_count() != Some(0) {
        return;
    }
    clear_log();
    log("自动更新：发现服务端新版本，没有任务在执行，开始更新");
    log("自动更新：停止服务端");
    if let Err(e) = stop_inner() {
        log(format!("自动更新：停止失败，放弃本次更新：{e}"));
        return;
    }
    log("自动更新：安装新版本");
    match install_inner() {
        Ok(v) => log(format!("自动更新：已安装 {v}")),
        // 装失败了也把原来的版本启动回来
        Err(e) => log(format!("自动更新：安装失败：{e}")),
    }
    log("自动更新：启动服务端");
    match start_inner(tailnet) {
        Ok(()) => log("自动更新：完成"),
        Err(e) => log(format!("自动更新：启动失败：{e}")),
    }
}

/// 客户端启动时调用：后台线程，几分钟后第一次检查，之后每小时一次。
pub fn spawn_auto_update() {
    let _ = std::thread::Builder::new().name("server-auto-update".into()).spawn(|| {
        std::thread::sleep(AUTO_UPDATE_FIRST_DELAY);
        loop {
            auto_update_tick();
            std::thread::sleep(AUTO_UPDATE_INTERVAL);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_standard_http11_json() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
        let resp = parse_http_response(raw).unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, "{\"ok\":true}");
    }

    #[test]
    fn parse_http10_lf_only() {
        let raw = "HTTP/1.0 404 Not Found\nContent-Type: application/json\n\n{\"error\":\"not found\"}";
        let resp = parse_http_response(raw).unwrap();
        assert_eq!(resp.status, 404);
        assert_eq!(resp.body, "{\"error\":\"not found\"}");
    }

    #[test]
    fn parse_chunked_response() {
        let raw = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n7\r\n{\"a\":1,\r\n6\r\n\"b\":2}\r\n0\r\n\r\n";
        let resp = parse_http_response(raw).unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, "{\"a\":1,\"b\":2}");
    }

    #[test]
    fn parse_malformed_response_fails() {
        assert!(parse_http_response("HTTP/1.1 200 OK").is_err());
        assert!(parse_http_response("INVALID\r\n\r\n{}").is_err());
    }

    #[test]
    fn decode_409_with_running_and_error() {
        let resp = HttpResponse {
            status: 409,
            body: r#"{"error":"有 2 个会话正在执行","running":2}"#.into(),
        };
        let err = decode_api_response(resp).unwrap_err();
        assert_eq!(
            err,
            LocalApiError::Conflict {
                error: "有 2 个会话正在执行".into(),
                running: Some(2),
            }
        );
    }

    #[test]
    fn decode_404_and_403_and_500() {
        assert!(matches!(
            decode_api_response(HttpResponse { status: 404, body: "Not Found".into() }),
            Err(LocalApiError::Unsupported { .. })
        ));
        assert_eq!(
            decode_api_response(HttpResponse {
                status: 403,
                body: r#"{"error":"仅允许本机操作"}"#.into(),
            }),
            Err(LocalApiError::Forbidden {
                error: "仅允许本机操作".into(),
            })
        );
        assert_eq!(
            decode_api_response(HttpResponse {
                status: 500,
                body: r#"{"error":"内部错误"}"#.into(),
            }),
            Err(LocalApiError::Other {
                status: Some(500),
                error: "内部错误".into(),
            })
        );
    }

    #[test]
    fn decode_200_json_body() {
        let val = decode_api_response(HttpResponse {
            status: 200,
            body: r#"{"lines":["a","b"],"next":2}"#.into(),
        })
        .unwrap();
        assert_eq!(val["next"], 2);
        assert_eq!(val["lines"][0], "a");
    }

    #[test]
    fn validate_account_id_rules() {
        assert!(validate_account_id("acc_01-AB").is_ok());
        assert!(validate_account_id("").is_err());
        assert!(validate_account_id(&"a".repeat(65)).is_err());
        assert!(validate_account_id("a&b=1").is_err());
        assert!(validate_account_id("../etc").is_err());
        assert!(validate_account_id("中文").is_err());
    }

    #[test]
    fn validate_kiro_admin_url_strict() {
        let (u, origin) = validate_kiro_admin_url("http://127.0.0.1:43210/admin").unwrap();
        assert_eq!(u.as_str(), "http://127.0.0.1:43210/admin");
        assert_eq!(origin, "http://127.0.0.1:43210");

        assert!(validate_kiro_admin_url("https://127.0.0.1:43210/admin").is_err());
        assert!(validate_kiro_admin_url("http://localhost:43210/admin").is_err());
        assert!(validate_kiro_admin_url("http://127.0.0.1/admin").is_err());
        assert!(validate_kiro_admin_url("http://127.0.0.1:43210/admin?x=1").is_err());
        assert!(validate_kiro_admin_url("http://127.0.0.1:43210/other").is_err());
        assert!(validate_kiro_admin_url("http://user@127.0.0.1:43210/admin").is_err());
        assert!(validate_kiro_admin_url("http://evil.com:43210/admin").is_err());
    }

    #[test]
    fn admin_init_script_safely_encodes_values() {
        let s = build_admin_init_script("http://127.0.0.1:8080", "k\"'\n</script>").unwrap();
        assert!(s.contains(r#"location.origin==="http://127.0.0.1:8080""#));
        assert!(s.contains(r#"localStorage.setItem("adminApiKey","k\"'\n</script>")"#));
    }

    fn comps(server: serde_json::Value) -> serde_json::Value {
        serde_json::json!({ "list": [
            { "id": "claude", "installed": true, "custom": false, "updateAvailable": true, "autoUpdate": true },
            server,
        ]})
    }

    fn server_item(custom: bool, update: bool, auto: bool) -> serde_json::Value {
        serde_json::json!({ "id": "server", "installed": true, "custom": custom, "updateAvailable": update, "autoUpdate": auto })
    }

    #[test]
    fn auto_update_when_available_and_idle() {
        assert!(should_auto_update_server(&comps(server_item(false, true, true)), Some(0)));
    }

    #[test]
    fn auto_update_skips_when_busy_or_unknown() {
        let c = comps(server_item(false, true, true));
        assert!(!should_auto_update_server(&c, Some(1)));
        assert!(!should_auto_update_server(&c, None));
    }

    #[test]
    fn auto_update_skips_custom_auto_off_and_no_update() {
        assert!(!should_auto_update_server(&comps(server_item(true, true, true)), Some(0)));
        assert!(!should_auto_update_server(&comps(server_item(false, true, false)), Some(0)));
        assert!(!should_auto_update_server(&comps(server_item(false, false, true)), Some(0)));
        let not_installed = comps(serde_json::json!({ "id": "server", "installed": false, "custom": false, "updateAvailable": true, "autoUpdate": true }));
        assert!(!should_auto_update_server(&not_installed, Some(0)));
    }

    #[test]
    fn auto_update_skips_missing_or_malformed_json() {
        assert!(!should_auto_update_server(&serde_json::Value::Null, Some(0)));
        assert!(!should_auto_update_server(&serde_json::json!({}), Some(0)));
        assert!(!should_auto_update_server(&serde_json::json!({ "list": "x" }), Some(0)));
        assert!(!should_auto_update_server(&serde_json::json!({ "list": [{ "id": "claude", "updateAvailable": true }] }), Some(0)));
        // 字段缺失或类型不对
        assert!(!should_auto_update_server(&comps(serde_json::json!({ "id": "server", "updateAvailable": true })), Some(0)));
        assert!(!should_auto_update_server(
            &comps(serde_json::json!({ "id": "server", "installed": true, "custom": false, "updateAvailable": "yes", "autoUpdate": true })),
            Some(0)
        ));
    }

    #[test]
    fn component_id_whitelist() {
        for id in ["claude", "kiro", "agy", "browser", "server"] {
            assert_eq!(component_id(id).unwrap(), id);
        }
        for bad in ["", "Claude", "../x", "kiro/check", "agy?x=1", "other"] {
            assert!(component_id(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn server_latest_version_parsing() {
        for ok in ["0.1.6", "v0.1.6", "0.1.6-main.12"] {
            let body = format!(r#"{{"name":"cosyee-server","version":"{ok}"}}"#);
            assert_eq!(parse_server_latest(body.as_bytes()).unwrap(), ok);
        }
        for bad in [r#"{"version":"0.1"}"#, r#"{"version":"0.1.6-beta"}"#, r#"{"version":"0.1.6-main."}"#, r#"{}"#, "nope"] {
            assert!(parse_server_latest(bad.as_bytes()).is_err(), "{bad}");
        }
    }
}
