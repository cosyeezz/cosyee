// 「本机服务」（仅桌面端）：在这台电脑上用 npm 安装 / 更新 / 启动 / 停止 Cosyee 服务端。
// 服务端包来自 GitHub 仓库的 server-dist 分支（CI 自动构建），不需要 git、也没有依赖和安装脚本：
//   npm install -g https://codeload.github.com/cosyeezz/cosyee/tar.gz/refs/heads/server-dist
// 启动时直接 `node <npm 全局目录>/cosyee-server/server.mjs`，作为独立后台进程运行（关掉客户端不影响服务）；
// 停止走服务端的 POST /api/shutdown（只接受本机回环，Windows 后台进程收不到信号）。
// 这些命令只对客户端自己的本地页面开放：Tauri 不允许远程页面（服务端网页）调用自定义命令。
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

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
        if let Ok(mut l) = LOG.lock() {
            l.clear();
        }
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
    })
    .await?
}

/// 后台启动服务端。tailnet=true 时监听 Tailscale（手机和其它电脑可连），否则只给本机用。
#[tauri::command]
pub async fn local_start(tailnet: bool) -> Result<(), String> {
    let guard = take_busy()?;
    blocking(move || {
        let _g = guard;
        if running() {
            return Ok(());
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
                return Ok(());
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
    })
    .await?
}

#[tauri::command]
pub async fn local_stop() -> Result<(), String> {
    let guard = take_busy()?;
    blocking(move || {
        let _g = guard;
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
    })
    .await?
}
