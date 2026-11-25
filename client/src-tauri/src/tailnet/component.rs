// 组件生命周期管理与控制接口客户端：
// - 桌面（Windows / macOS）：以 sidecar 子进程运行，stdin 管道保持打开（父进程退出→EOF→组件优雅退出），
//   读取 stdout 第一行 ready/error JSON，意外退出后按退避自动重启（滑动 60 秒窗口最多 5 次）。
// - Android：.so 随 APK 打进 jniLibs/arm64-v8a/libcosyee_tailnet.so，用 libloading 按库名加载，
//   通过 FFI 调 CosyeeTailnetStart/Stop/Free。
// - 控制接口：HTTP 请求 127.0.0.1:P1，带 Authorization: Bearer <token> 和 Host: 127.0.0.1:P1。
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::proxy::SharedSocksState;

#[cfg(not(target_os = "android"))]
const READY_TIMEOUT: Duration = Duration::from_secs(15);
#[cfg_attr(target_os = "android", allow(dead_code))]
const MAX_RESTARTS_PER_MIN: usize = 5;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ReadyMessage {
    Ready {
        version: String,
        control: String,
        socks: String,
        token: String,
    },
    Error {
        error: String,
    },
}

fn deserialize_null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    T: Default + Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SelfNode {
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub name: String,
    #[serde(default, rename = "dnsName", deserialize_with = "deserialize_null_default")]
    pub dns_name: String,
    #[serde(default, deserialize_with = "deserialize_null_default")]
    pub ips: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ControlStatus {
    pub version: String,
    pub state: String,
    #[serde(default, rename = "authURL")]
    pub auth_url: Option<String>,
    #[serde(default, rename = "self")]
    pub self_node: Option<SelfNode>,
    #[serde(default)]
    pub tailnet: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LoginResponse {
    #[serde(rename = "authURL")]
    pub auth_url: String,
}

#[derive(Debug, Clone)]
pub struct RunningInfo {
    pub version: String,
    pub control: String,
    pub socks: String,
    pub token: String,
    #[cfg_attr(target_os = "android", allow(dead_code))]
    pub bin_file: String,
}

/// 生成符合 Tailscale 主机名规则的默认节点名（仅小写字母、数字和短横线）。
pub fn default_hostname() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| {
            if cfg!(target_os = "android") {
                "android".into()
            } else if cfg!(target_os = "macos") {
                "mac".into()
            } else if cfg!(windows) {
                "win".into()
            } else {
                "client".into()
            }
        });
    let cleaned: String = raw
        .to_ascii_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "cosyee-client".into()
    } else {
        let short: String = trimmed.chars().take(24).collect();
        format!("cosyee-{}", short.trim_end_matches('-'))
    }
}

/// 滑动 60 秒窗口重启限频器：最多允许 5 次/分钟，返回本次退避时长。
#[cfg_attr(target_os = "android", allow(dead_code))]
#[derive(Default)]
pub struct RestartLimiter {
    recent: VecDeque<Instant>,
}

#[cfg_attr(target_os = "android", allow(dead_code))]
impl RestartLimiter {
    pub fn try_record(&mut self, now: Instant) -> Option<Duration> {
        let cutoff = now.checked_sub(Duration::from_secs(60));
        while let Some(&front) = self.recent.front() {
            if cutoff.is_some_and(|c| front < c) {
                self.recent.pop_front();
            } else {
                break;
            }
        }
        if self.recent.len() >= MAX_RESTARTS_PER_MIN {
            return None;
        }
        self.recent.push_back(now);
        let count = self.recent.len();
        let secs = match count {
            1 => 1,
            2 => 2,
            3 => 4,
            4 => 8,
            _ => 15,
        };
        Some(Duration::from_secs(secs))
    }

    pub fn reset(&mut self) {
        self.recent.clear();
    }
}

/// 向组件控制接口发一次 HTTP/1.0 请求（带 Authorization: Bearer <token> 和精确的 Host 头）。
pub fn control_request(
    control_addr: &str,
    token: &str,
    method: &str,
    path: &str,
    timeout: Duration,
) -> Result<(u16, String), String> {
    let addr: SocketAddr = control_addr
        .parse()
        .map_err(|_| format!("无效的控制接口地址：{control_addr}"))?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(2))
        .map_err(|e| format!("无法连接组件控制接口：{e}"))?;
    let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_read_timeout(Some(timeout));

    let req = format!(
        "{method} {path} HTTP/1.0\r\nHost: {control_addr}\r\nAuthorization: Bearer {token}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| format!("发送控制请求失败：{e}"))?;

    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("读取控制接口响应失败：{e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text
        .split_once("\r\n\r\n")
        .or_else(|| text.split_once("\n\n"))
        .ok_or_else(|| "控制接口响应格式无效".to_string())?;
    let status = head
        .lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "无法解析控制接口状态码".to_string())?;

    Ok((status, body.to_string()))
}

pub fn fetch_control_status(info: &RunningInfo) -> Result<ControlStatus, String> {
    let (status, body) = control_request(
        &info.control,
        &info.token,
        "GET",
        "/status",
        Duration::from_secs(3),
    )?;
    if !(200..300).contains(&status) {
        return Err(format!("查询组件状态失败（HTTP {status}）"));
    }
    serde_json::from_str::<ControlStatus>(&body)
        .map_err(|e| format!("解析组件状态失败：{e}"))
}

pub fn trigger_login(info: &RunningInfo) -> Result<String, String> {
    let (status, body) = control_request(
        &info.control,
        &info.token,
        "POST",
        "/login",
        Duration::from_secs(20),
    )?;
    if !(200..300).contains(&status) {
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| format!("发起登录失败（HTTP {status}）"));
        return Err(msg);
    }
    let parsed: LoginResponse =
        serde_json::from_str(&body).map_err(|e| format!("解析登录链接失败：{e}"))?;
    if parsed.auth_url.is_empty() {
        return Err("组件未返回登录链接".into());
    }
    Ok(parsed.auth_url)
}

pub fn trigger_logout(info: &RunningInfo) -> Result<(), String> {
    let (status, body) = control_request(
        &info.control,
        &info.token,
        "POST",
        "/logout",
        Duration::from_secs(10),
    )?;
    if !(200..300).contains(&status) {
        let msg = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(str::to_string))
            .unwrap_or_else(|| format!("登出失败（HTTP {status}）"));
        return Err(msg);
    }
    Ok(())
}

/// 同步更新代理共享的 SOCKS5 状态。
pub fn sync_socks_state(socks_state: &SharedSocksState, info: Option<&RunningInfo>, is_running_state: bool) {
    if let Ok(mut g) = socks_state.write() {
        if let Some(i) = info {
            g.addr = i.socks.clone();
            g.token = i.token.clone();
            g.running = is_running_state;
        } else {
            g.addr.clear();
            g.token.clear();
            g.running = false;
        }
    }
}

/// 运行期组件句柄（桌面管理子进程；Android 管理已加载的 .so）。
pub struct ComponentRunner {
    inner: Arc<Mutex<RunnerState>>,
    socks_state: SharedSocksState,
    log_cb: Arc<dyn Fn(String) + Send + Sync>,
    state_cb: Arc<dyn Fn(&str) + Send + Sync>,
}

struct RunnerState {
    generation: u64,
    stopping: bool,
    info: Option<RunningInfo>,
    last_error: Option<String>,
    #[cfg(not(target_os = "android"))]
    limiter: RestartLimiter,
    #[cfg(not(target_os = "android"))]
    child_stdin: Option<std::process::ChildStdin>,
    #[cfg(not(target_os = "android"))]
    child_pid: Option<u32>,
    #[cfg(target_os = "android")]
    loaded_version: Option<String>,
}

impl ComponentRunner {
    pub fn new(
        socks_state: SharedSocksState,
        log_cb: Arc<dyn Fn(String) + Send + Sync>,
        state_cb: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(RunnerState {
                generation: 0,
                stopping: false,
                info: None,
                last_error: None,
                #[cfg(not(target_os = "android"))]
                limiter: RestartLimiter::default(),
                #[cfg(not(target_os = "android"))]
                child_stdin: None,
                #[cfg(not(target_os = "android"))]
                child_pid: None,
                #[cfg(target_os = "android")]
                loaded_version: None,
            })),
            socks_state,
            log_cb,
            state_cb,
        }
    }

    pub fn running_info(&self) -> Option<RunningInfo> {
        self.inner.lock().ok().and_then(|g| g.info.clone())
    }

    pub fn last_error(&self) -> Option<String> {
        self.inner.lock().ok().and_then(|g| g.last_error.clone())
    }

    /// 返回当前正在占用的组件文件名（桌面清理旧版本时跳过它）。
    #[cfg(not(target_os = "android"))]
    pub fn active_file(&self) -> Option<String> {
        let g = self.inner.lock().ok()?;
        g.info.as_ref().map(|i| i.bin_file.clone())
    }

    /// Android 上返回已加载内置库上报的版本号。
    #[cfg(target_os = "android")]
    pub fn loaded_version(&self) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|g| g.loaded_version.clone())
    }

    /// 判断指定代次的组件实例是否仍在正常运行（供 Android 崩溃保护 10 秒稳定性校验使用）。
    #[cfg(target_os = "android")]
    pub fn is_generation_active(&self, gen: u64) -> bool {
        self.inner
            .lock()
            .map(|g| g.generation == gen && !g.stopping && g.info.is_some())
            .unwrap_or(false)
    }

    /// 桌面端启动组件（先停止旧实例）。
    #[cfg(not(target_os = "android"))]
    pub fn start(
        &self,
        bin_path: PathBuf,
        bin_file: String,
        state_dir: PathBuf,
        log_file: PathBuf,
    ) -> Result<RunningInfo, String> {
        self.stop();
        if let Ok(mut g) = self.inner.lock() {
            g.stopping = false;
            g.last_error = None;
            g.limiter.reset();
        }
        self.start_internal(bin_path, bin_file, state_dir, log_file)
    }

    #[cfg(not(target_os = "android"))]
    fn start_internal(
        &self,
        bin_path: PathBuf,
        bin_file: String,
        state_dir: PathBuf,
        log_file: PathBuf,
    ) -> Result<RunningInfo, String> {
        let _ = std::fs::create_dir_all(&state_dir);
        let hostname = default_hostname();
        self.start_desktop(bin_path, bin_file, state_dir, log_file, hostname)
    }

    /// Android 端启动内置组件库（先停止旧实例），返回运行信息与代次号。
    #[cfg(target_os = "android")]
    pub fn start_bundled(
        &self,
        state_dir: PathBuf,
        log_file: PathBuf,
    ) -> Result<(RunningInfo, u64), String> {
        self.stop();
        let expected_gen = {
            let mut g = self.inner.lock().map_err(|_| "内部锁异常".to_string())?;
            g.generation = g.generation.wrapping_add(1);
            g.stopping = false;
            g.last_error = None;
            g.generation
        };
        let _ = std::fs::create_dir_all(&state_dir);
        let hostname = default_hostname();
        self.start_android(expected_gen, state_dir, log_file, hostname)
    }

    /// 停止组件并清除代理路由状态。
    /// 注意：先在 inner 锁内更新状态并释放锁，再调用可能阻塞的 Go Stop，避免阻塞状态查询。
    pub fn stop(&self) {
        {
            let mut g = match self.inner.lock() {
                Ok(g) => g,
                Err(_) => return,
            };
            g.stopping = true;
            g.generation = g.generation.wrapping_add(1);
            g.info = None;

            #[cfg(not(target_os = "android"))]
            {
                // 关闭 stdin 管道，组件读到 EOF 会立即优雅退出
                g.child_stdin = None;
                g.child_pid = None;
            }
        }
        sync_socks_state(&self.socks_state, None, false);
        #[cfg(target_os = "android")]
        {
            android_ffi::stop_if_loaded();
        }
    }

    #[cfg(not(target_os = "android"))]
    fn start_desktop(
        &self,
        bin_path: PathBuf,
        bin_file: String,
        state_dir: PathBuf,
        log_file: PathBuf,
        hostname: String,
    ) -> Result<RunningInfo, String> {
        use std::io::BufRead;
        use std::process::{Command, Stdio};

        if !bin_path.exists() {
            return Err(format!("找不到组件文件：{}", bin_path.display()));
        }

        // macOS / Unix 启动前确保有执行权限
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&bin_path, std::fs::Permissions::from_mode(0o755));
        }

        (self.log_cb)(format!("启动组件：{}", bin_file));

        let mut cmd = Command::new(&bin_path);
        cmd.arg("--state-dir")
            .arg(&state_dir)
            .arg("--hostname")
            .arg(&hostname)
            .arg("--log-file")
            .arg(&log_file)
            .env("TS_NO_LOGS_NO_SUPPORT", "true")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());

        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("无法启动组件进程：{e}"))?;
        let pid = child.id();
        let stdin = child.stdin.take();
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "无法读取组件标准输出".to_string())?;

        // 在独立线程中读取第一行 ready JSON，主线程带超时等待
        let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
        std::thread::spawn(move || {
            let mut br = std::io::BufReader::new(stdout);
            let mut line = String::new();
            let res = match br.read_line(&mut line) {
                Ok(0) => Err("组件在就绪前已退出".into()),
                Ok(_) => Ok(line),
                Err(e) => Err(format!("读取组件输出失败：{e}")),
            };
            let _ = tx.send(res);
        });

        let line = match rx.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(l)) => l,
            Ok(Err(e)) => {
                drop(stdin);
                let _ = child.kill();
                let _ = child.wait();
                if let Ok(mut g) = self.inner.lock() {
                    g.last_error = Some(e.clone());
                }
                return Err(e);
            }
            Err(_) => {
                drop(stdin);
                let _ = child.kill();
                let _ = child.wait();
                let e = "等待组件就绪超时（15 秒）".to_string();
                if let Ok(mut g) = self.inner.lock() {
                    g.last_error = Some(e.clone());
                }
                return Err(e);
            }
        };

        let msg: ReadyMessage = match serde_json::from_str(line.trim()) {
            Ok(m) => m,
            Err(e) => {
                drop(stdin);
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("组件就绪输出格式无效：{e}"));
            }
        };

        let info = match msg {
            ReadyMessage::Ready {
                version,
                control,
                socks,
                token,
            } => RunningInfo {
                version,
                control,
                socks,
                token,
                bin_file: bin_file.clone(),
            },
            ReadyMessage::Error { error } => {
                drop(stdin);
                let _ = child.wait();
                if let Ok(mut g) = self.inner.lock() {
                    g.last_error = Some(error.clone());
                }
                return Err(format!("组件启动失败：{error}"));
            }
        };

        let gen = {
            let mut g = self.inner.lock().map_err(|_| "内部锁异常".to_string())?;
            g.generation = g.generation.wrapping_add(1);
            g.info = Some(info.clone());
            g.last_error = None;
            g.child_stdin = stdin;
            g.child_pid = Some(pid);
            g.generation
        };

        (self.log_cb)(format!(
            "组件已就绪（v{}，control={}，socks={}）",
            info.version, info.control, info.socks
        ));

        // 后台轮询一次状态并同步给代理（刚启动后可能很快进入 Running）
        self.spawn_status_poller(gen, info.clone());

        // 监控子进程退出，意外退出时按退避自动重启
        let inner = self.inner.clone();
        let socks_state = self.socks_state.clone();
        let log_cb = self.log_cb.clone();
        let state_cb = self.state_cb.clone();
        std::thread::spawn(move || {
            let status = child.wait();
            let should_restart = {
                let Ok(mut g) = inner.lock() else { return };
                if g.generation != gen || g.stopping {
                    return;
                }
                g.info = None;
                g.child_stdin = None;
                g.child_pid = None;
                sync_socks_state(&socks_state, None, false);

                let desc = match status {
                    Ok(st) => format!("组件意外退出（{st}）"),
                    Err(e) => format!("组件进程异常（{e}）"),
                };
                log_cb(desc.clone());

                match g.limiter.try_record(Instant::now()) {
                    Some(delay) => {
                        log_cb(format!("{} 秒后自动重启组件...", delay.as_secs()));
                        Some(delay)
                    }
                    None => {
                        let msg = "组件 1 分钟内连续崩溃超过 5 次，已停止自动重启".to_string();
                        g.last_error = Some(msg.clone());
                        log_cb(msg);
                        None
                    }
                }
            };

            if let Some(delay) = should_restart {
                std::thread::sleep(delay);
                let still_valid = inner
                    .lock()
                    .map(|g| g.generation == gen && !g.stopping)
                    .unwrap_or(false);
                if !still_valid {
                    return;
                }
                let runner = ComponentRunner {
                    inner: inner.clone(),
                    socks_state: socks_state.clone(),
                    log_cb: log_cb.clone(),
                    state_cb: state_cb.clone(),
                };
                if let Err(e) = runner.start_internal(bin_path, bin_file, state_dir, log_file) {
                    log_cb(format!("自动重启组件失败：{e}"));
                }
            }
        });

        Ok(info)
    }

    #[cfg(target_os = "android")]
    fn start_android(
        &self,
        expected_gen: u64,
        state_dir: PathBuf,
        log_file: PathBuf,
        hostname: String,
    ) -> Result<(RunningInfo, u64), String> {
        (self.log_cb)(format!("加载内置组件库：{}", android_ffi::BUNDLED_LIB_NAME));

        // 持 FFI 锁串行化 start/stop；锁顺序严格为 FFI_LOCK -> inner，不会死锁。
        let info = android_ffi::with_ffi_lock(|ffi| -> Result<RunningInfo, String> {
            // 真正调 Go Start 前先检查是否已被 stop 或新一代 start 取代
            if self.is_cancelled(expected_gen) {
                return Err("组件启动已被取消".into());
            }

            let json_str = match ffi.load_and_start(&state_dir, &hostname, &log_file) {
                Ok(s) => s,
                Err(e) => {
                    self.record_error_if_active(expected_gen, e.clone());
                    return Err(e);
                }
            };

            let msg: ReadyMessage = match serde_json::from_str(json_str.trim()) {
                Ok(m) => m,
                Err(e) => {
                    let err = format!("组件返回格式无效：{e}");
                    self.record_error_if_active(expected_gen, err.clone());
                    ffi.stop_if_loaded();
                    return Err(err);
                }
            };

            let info = match msg {
                ReadyMessage::Ready {
                    version,
                    control,
                    socks,
                    token,
                } => RunningInfo {
                    version,
                    control,
                    socks,
                    token,
                    bin_file: android_ffi::BUNDLED_LIB_NAME.to_string(),
                },
                ReadyMessage::Error { error } => {
                    self.record_error_if_active(expected_gen, error.clone());
                    return Err(format!("组件启动失败：{error}"));
                }
            };

            // 写回运行态前校验 generation / stopping：已被 stop 的启动不得写回 info，并立刻停掉刚启动的实例
            let committed = {
                let mut g = self.inner.lock().map_err(|_| "内部锁异常".to_string())?;
                if g.generation != expected_gen || g.stopping {
                    false
                } else {
                    g.info = Some(info.clone());
                    g.last_error = None;
                    if g.loaded_version.is_none() {
                        g.loaded_version = Some(info.version.clone());
                    }
                    true
                }
            };

            if !committed {
                ffi.stop_if_loaded();
                return Err("组件启动已被取消".into());
            }

            Ok(info)
        })?;

        (self.log_cb)(format!(
            "组件已就绪（v{}，control={}，socks={}）",
            info.version, info.control, info.socks
        ));
        self.spawn_status_poller(expected_gen, info.clone());
        Ok((info, expected_gen))
    }

    #[cfg(target_os = "android")]
    fn is_cancelled(&self, expected_gen: u64) -> bool {
        self.inner
            .lock()
            .map(|g| g.generation != expected_gen || g.stopping)
            .unwrap_or(true)
    }

    #[cfg(target_os = "android")]
    fn record_error_if_active(&self, expected_gen: u64, err: String) {
        if let Ok(mut g) = self.inner.lock() {
            if g.generation == expected_gen && !g.stopping {
                g.last_error = Some(err);
            }
        }
    }

    /// 启动后定期向控制接口同步 state，让代理能及时感知 Running / NeedsLogin 变化。
    fn spawn_status_poller(&self, gen: u64, info: RunningInfo) {
        let inner = self.inner.clone();
        let socks_state = self.socks_state.clone();
        let state_cb = self.state_cb.clone();
        std::thread::spawn(move || {
            // 前 10 次每 1 秒轮询一次（快速感知登录完成），之后每 5 秒同步一次
            for i in 0u64.. {
                let active = inner
                    .lock()
                    .map(|g| g.generation == gen && !g.stopping)
                    .unwrap_or(false);
                if !active {
                    break;
                }
                if let Ok(st) = fetch_control_status(&info) {
                    sync_socks_state(&socks_state, Some(&info), st.state == "Running");
                    state_cb(&st.state);
                }
                let sleep_secs = if i < 10 { 1 } else { 5 };
                std::thread::sleep(Duration::from_secs(sleep_secs));
            }
        });
    }
}

#[cfg(target_os = "android")]
mod android_ffi {
    use std::ffi::{CStr, CString};
    use std::os::raw::c_char;
    use std::path::Path;
    use std::sync::{Mutex, OnceLock};

    use libloading::{Library, Symbol};

    pub const BUNDLED_LIB_NAME: &str = "libcosyee_tailnet.so";

    type StartFn = unsafe extern "C" fn(*const c_char, *const c_char, *const c_char) -> *mut c_char;
    type StopFn = unsafe extern "C" fn();
    type FreeFn = unsafe extern "C" fn(*mut c_char);

    struct LoadedLib {
        _lib: Library,
        start: StartFn,
        stop: StopFn,
        free: FreeFn,
    }

    // Go c-shared 运行时在进程内无法卸载，因此全局持有一次加载的句柄
    unsafe impl Send for LoadedLib {}
    unsafe impl Sync for LoadedLib {}

    static LIB: OnceLock<LoadedLib> = OnceLock::new();
    /// 保证整个进程只 dlopen 一次的互斥锁
    static LOAD_LOCK: Mutex<()> = Mutex::new(());
    /// 串行化所有 Go Start/Stop FFI 调用的互斥锁（与 ComponentRunner::inner 锁顺序：FFI_LOCK -> inner）
    static FFI_LOCK: Mutex<()> = Mutex::new(());

    /// 已持有 FFI_LOCK 的操作令牌，用于在同一个锁临界区内完成 start + 取消回滚 stop。
    pub struct FfiSession(());

    impl FfiSession {
        pub fn load_and_start(
            &self,
            state_dir: &Path,
            hostname: &str,
            log_file: &Path,
        ) -> Result<String, String> {
            let lib = ensure_loaded()?;
            let c_state = CString::new(state_dir.to_string_lossy().as_bytes())
                .map_err(|_| "stateDir 路径包含空字节".to_string())?;
            let c_host = CString::new(hostname).map_err(|_| "hostname 包含空字节".to_string())?;
            let c_log = CString::new(log_file.to_string_lossy().as_bytes())
                .map_err(|_| "logFile 路径包含空字节".to_string())?;

            unsafe {
                let ptr = (lib.start)(c_state.as_ptr(), c_host.as_ptr(), c_log.as_ptr());
                if ptr.is_null() {
                    return Err("CosyeeTailnetStart 返回空指针".into());
                }
                let out = CStr::from_ptr(ptr).to_string_lossy().into_owned();
                (lib.free)(ptr);
                Ok(out)
            }
        }

        pub fn stop_if_loaded(&self) {
            if let Some(lib) = LIB.get() {
                unsafe {
                    (lib.stop)();
                }
            }
        }
    }

    pub fn with_ffi_lock<T>(f: impl FnOnce(&FfiSession) -> Result<T, String>) -> Result<T, String> {
        let _guard = FFI_LOCK
            .lock()
            .map_err(|_| "组件 FFI 锁异常".to_string())?;
        let session = FfiSession(());
        f(&session)
    }

    fn ensure_loaded() -> Result<&'static LoadedLib, String> {
        if let Some(l) = LIB.get() {
            return Ok(l);
        }
        let _load_guard = LOAD_LOCK
            .lock()
            .map_err(|_| "组件加载锁异常".to_string())?;
        if let Some(l) = LIB.get() {
            return Ok(l);
        }
        let loaded = unsafe {
            let lib = Library::new(BUNDLED_LIB_NAME)
                .map_err(|e| format!("无法加载内置组件库 {BUNDLED_LIB_NAME}：{e}"))?;
            let start: Symbol<StartFn> = lib
                .get(b"CosyeeTailnetStart\0")
                .map_err(|e| format!("组件库缺少 CosyeeTailnetStart：{e}"))?;
            let stop: Symbol<StopFn> = lib
                .get(b"CosyeeTailnetStop\0")
                .map_err(|e| format!("组件库缺少 CosyeeTailnetStop：{e}"))?;
            let free: Symbol<FreeFn> = lib
                .get(b"CosyeeTailnetFree\0")
                .map_err(|e| format!("组件库缺少 CosyeeTailnetFree：{e}"))?;
            LoadedLib {
                start: *start,
                stop: *stop,
                free: *free,
                _lib: lib,
            }
        };
        let _ = LIB.set(loaded);
        Ok(LIB.get().unwrap())
    }

    pub fn stop_if_loaded() {
        let Ok(_guard) = FFI_LOCK.lock() else {
            return;
        };
        if let Some(lib) = LIB.get() {
            unsafe {
                (lib.stop)();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn restart_limiter_allows_five_per_minute() {
        let mut lim = RestartLimiter::default();
        let t0 = Instant::now();
        assert_eq!(lim.try_record(t0), Some(Duration::from_secs(1)));
        assert_eq!(lim.try_record(t0 + Duration::from_secs(1)), Some(Duration::from_secs(2)));
        assert_eq!(lim.try_record(t0 + Duration::from_secs(2)), Some(Duration::from_secs(4)));
        assert_eq!(lim.try_record(t0 + Duration::from_secs(3)), Some(Duration::from_secs(8)));
        assert_eq!(lim.try_record(t0 + Duration::from_secs(4)), Some(Duration::from_secs(15)));
        // 第 6 次被拦
        assert_eq!(lim.try_record(t0 + Duration::from_secs(5)), None);
        // 超过 60 秒后滑出窗口，恢复允许
        assert!(lim.try_record(t0 + Duration::from_secs(62)).is_some());
    }

    #[test]
    fn control_http_client_sends_bearer_and_parses_status() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let expected_host = addr.to_string();

        let h = std::thread::spawn(move || {
            let (mut s, _) = listener.accept().unwrap();
            let mut req_bytes = Vec::new();
            let mut buf = [0u8; 512];
            while !req_bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                let n = s.read(&mut buf).unwrap();
                if n == 0 {
                    break;
                }
                req_bytes.extend_from_slice(&buf[..n]);
            }
            let req = String::from_utf8_lossy(&req_bytes);
            assert!(req.contains("Authorization: Bearer tok-abc"), "实际请求：{req}");
            assert!(req.contains(&format!("Host: {expected_host}")), "实际请求：{req}");
            let body = r#"{"version":"1.0.0","state":"Running","authURL":null,"self":{"name":"cosyee-test","dnsName":"cosyee-test.tail.ts.net","ips":["100.64.0.1"]},"tailnet":"tail.ts.net","error":null}"#;
            let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
            s.write_all(resp.as_bytes()).unwrap();
        });

        let info = RunningInfo {
            version: "1.0.0".into(),
            control: addr.to_string(),
            socks: "127.0.0.1:1".into(),
            token: "tok-abc".into(),
            bin_file: "test".into(),
        };
        let st = fetch_control_status(&info).unwrap();
        assert_eq!(st.state, "Running");
        assert_eq!(st.tailnet.as_deref(), Some("tail.ts.net"));
        assert_eq!(st.self_node.as_ref().unwrap().ips, vec!["100.64.0.1"]);
        h.join().unwrap();
    }

    #[test]
    fn ready_message_deserialization() {
        let ok_json = r#"{"type":"ready","version":"1.0.0","control":"127.0.0.1:12345","socks":"127.0.0.1:12346","token":"deadbeef"}"#;
        match serde_json::from_str::<ReadyMessage>(ok_json).unwrap() {
            ReadyMessage::Ready {
                version,
                control,
                socks,
                token,
            } => {
                assert_eq!(version, "1.0.0");
                assert_eq!(control, "127.0.0.1:12345");
                assert_eq!(socks, "127.0.0.1:12346");
                assert_eq!(token, "deadbeef");
            }
            _ => panic!("应解析为 ready"),
        }

        let err_json = r#"{"type":"error","error":"boom"}"#;
        match serde_json::from_str::<ReadyMessage>(err_json).unwrap() {
            ReadyMessage::Error { error } => assert_eq!(error, "boom"),
            _ => panic!("应解析为 error"),
        }
    }

    #[tokio::test]
    async fn fake_sidecar_lifecycle_and_proxy_chain() {
        use std::sync::RwLock;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        // 1. 假控制接口（返回 Running）
        let ctrl_listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let ctrl_addr = ctrl_listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in ctrl_listener.incoming().flatten() {
                let mut s = stream;
                let mut req_bytes = Vec::new();
                let mut buf = [0u8; 512];
                while !req_bytes.windows(4).any(|w| w == b"\r\n\r\n") {
                    match s.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => req_bytes.extend_from_slice(&buf[..n]),
                    }
                }
                let body = r#"{"version":"1.2.3","state":"Running","authURL":null,"self":null,"tailnet":"demo.ts.net","error":null}"#;
                let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len());
                let _ = s.write_all(resp.as_bytes());
            }
        });

        // 2. 假上游 HTTP 服务 + 假 SOCKS5 转发到该上游
        let up_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut s, _)) = up_listener.accept().await {
                let mut buf = [0u8; 512];
                let _ = s.read(&mut buf).await;
                let _ = s
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\ntailnet")
                    .await;
            }
        });

        let socks_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let socks_addr = socks_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut s, _)) = socks_listener.accept().await {
                let mut m = [0u8; 3];
                let _ = s.read_exact(&mut m).await;
                let _ = s.write_all(&[0x05, 0x02]).await;
                let mut vu = [0u8; 2];
                let _ = s.read_exact(&mut vu).await;
                let mut u = vec![0u8; vu[1] as usize];
                let _ = s.read_exact(&mut u).await;
                let mut pl = [0u8; 1];
                let _ = s.read_exact(&mut pl).await;
                let mut p = vec![0u8; pl[0] as usize];
                let _ = s.read_exact(&mut p).await;
                assert_eq!(u, b"cosyee");
                assert_eq!(p, b"e2e-token");
                let _ = s.write_all(&[0x01, 0x00]).await;
                let mut head = [0u8; 4];
                let _ = s.read_exact(&mut head).await;
                if head[3] == 0x01 {
                    let mut skip = [0u8; 6];
                    let _ = s.read_exact(&mut skip).await;
                }
                let mut target = tokio::net::TcpStream::connect(up_addr).await.unwrap();
                let _ = s.write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]).await;
                let _ = tokio::io::copy_bidirectional(&mut s, &mut target).await;
            }
        });

        // 3. 写入临时假 sidecar 脚本（打印 ready JSON 后阻塞读 stdin 直到 EOF）
        let tmp_dir = std::env::temp_dir().join(format!("cosyee_sidecar_test_{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp_dir);
        let ready = format!(
            r#"{{"type":"ready","version":"1.2.3","control":"{ctrl_addr}","socks":"{socks_addr}","token":"e2e-token"}}"#
        );

        #[cfg(windows)]
        let script_path = {
            let p = tmp_dir.join("fake_sidecar.cmd");
            let content = format!("@echo off\r\necho {ready}\r\nfindstr \"^\" > nul\r\n");
            std::fs::write(&p, content).unwrap();
            p
        };
        #[cfg(unix)]
        let script_path = {
            use std::os::unix::fs::PermissionsExt;
            let p = tmp_dir.join("fake_sidecar.sh");
            let content = format!("#!/bin/sh\nprintf '%s\\n' '{ready}'\ncat > /dev/null\n");
            std::fs::write(&p, content).unwrap();
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
            p
        };

        // 4. 启动本地代理 + ComponentRunner
        let socks_state = Arc::new(RwLock::new(super::super::proxy::SocksEndpoint::default()));
        let proxy_addr = super::super::proxy::start_http_proxy(socks_state.clone())
            .await
            .unwrap();
        let runner = ComponentRunner::new(
            socks_state.clone(),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );

        let info = runner
            .start(
                script_path.clone(),
                "fake_sidecar".into(),
                tmp_dir.join("state"),
                tmp_dir.join("tailnet.log"),
            )
            .unwrap();
        assert_eq!(info.version, "1.2.3");

        // 等待后台 poller 把 Running 同步到 socks_state
        for _ in 0..20 {
            if socks_state.read().unwrap().running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(socks_state.read().unwrap().running);

        // 5. 经本地 HTTP 代理访问 100.64.0.42:7878，验证走到了假 SOCKS5 → 假上游
        let mut client = tokio::net::TcpStream::connect(proxy_addr).await.unwrap();
        client
            .write_all(b"GET http://100.64.0.42:7878/test HTTP/1.1\r\nHost: 100.64.0.42:7878\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut resp = String::new();
        client.read_to_string(&mut resp).await.unwrap();
        assert!(resp.ends_with("tailnet"), "实际响应：{resp}");

        // 6. 停止组件（关闭 stdin 触发 EOF 退出）
        runner.stop();
        assert!(runner.running_info().is_none());
        assert!(!socks_state.read().unwrap().running);

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn real_go_sidecar_e2e_if_present() {
        use std::sync::RwLock;

        // 从 client/src-tauri 定位到仓库根目录的 tailnet/dist/cosyee-tailnet_1.0.0_windows_x64.exe
        let bin_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("tailnet")
            .join("dist")
            .join("cosyee-tailnet_1.0.0_windows_x64.exe");
        if !bin_path.exists() {
            return;
        }

        let tmp_dir = std::env::temp_dir().join(format!(
            "cosyee_real_sidecar_test_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&tmp_dir);
        let state_dir = tmp_dir.join("state");
        let log_file = tmp_dir.join("tailnet.log");

        let socks_state = Arc::new(RwLock::new(super::super::proxy::SocksEndpoint::default()));
        let runner = ComponentRunner::new(
            socks_state.clone(),
            Arc::new(|_| {}),
            Arc::new(|_| {}),
        );

        // 1. 启动真实 Go sidecar 并读 ready JSON
        let info = runner
            .start(
                bin_path,
                "cosyee-tailnet_1.0.0_windows_x64.exe".into(),
                state_dir.clone(),
                log_file.clone(),
            )
            .expect("真实 Go sidecar 应成功启动并输出 ready JSON");
        assert!(!info.version.is_empty());
        assert!(info.control.starts_with("127.0.0.1:"));
        assert!(info.socks.starts_with("127.0.0.1:"));
        assert!(!info.token.is_empty());

        // 2. 验证错误 token 被控制接口拒绝（401）
        let (unauth_code, _) =
            control_request(&info.control, "wrong-token", "GET", "/status", Duration::from_secs(3))
                .expect("控制接口应返回 HTTP 响应");
        assert_eq!(unauth_code, 401);

        // 3. 轮询 /status 直到进入 NeedsLogin（首次空 stateDir）
        let mut final_status = None;
        for _ in 0..30 {
            let st = fetch_control_status(&info).expect("/status 解析应成功");
            sync_socks_state(&socks_state, Some(&info), st.state == "Running");
            if st.state == "NeedsLogin" {
                final_status = Some(st);
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        let st = final_status.expect("空 stateDir 下应在 15 秒内进入 NeedsLogin");
        assert_eq!(st.state, "NeedsLogin");
        // 即使 NeedsLogin 时 self 非 null，代理分流标记也必须为 false（仅 state == Running 才走 SOCKS5）
        assert!(!socks_state.read().unwrap().running);

        // 4. 关 stdin 优雅退出，并确认控制端口很快不再可连
        let ctrl_addr = info.control.clone();
        runner.stop();
        assert!(runner.running_info().is_none());
        assert!(!socks_state.read().unwrap().running);

        let mut exited = false;
        for _ in 0..20 {
            if TcpStream::connect_timeout(&ctrl_addr.parse().unwrap(), Duration::from_millis(200)).is_err() {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
        assert!(exited, "关闭 stdin 后真实 Go sidecar 应在 5 秒内退出");
        assert!(log_file.exists(), "应已生成 tailnet.log");

        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
}
