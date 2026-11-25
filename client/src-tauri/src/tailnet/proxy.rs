// 本地 HTTP/1.1 代理 + SOCKS5 客户端（用户名/密码认证）+ 分流规则。
// - 监听 127.0.0.1:0（随机端口），进程生命周期内端口不变。
// - 分流规则（见 CONTRACT.md）：
//   目标为 100.64.0.0/10、fd7a:115c:a1e0::/48、*.ts.net、或不含点且不是 localhost 的主机名，
//   且组件处于 Running 状态 → 经组件 SOCKS5 拨出；其它一律直连。
// - 支持 CONNECT（https / wss）和 absolute-form 普通 HTTP（含 keep-alive、chunked/SSE 流式、WebSocket Upgrade），
//   拒绝 origin-form 请求（防止网页直接打本地代理端口）。
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, RwLock};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};

const SOCKS5_USER: &str = "cosyee";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

/// 代理运行期读取的组件路由状态：只有当组件 Running 且有 socks 地址和 token 时才走 SOCKS5。
#[derive(Debug, Clone, Default)]
pub struct SocksEndpoint {
    pub addr: String,
    pub token: String,
    pub running: bool,
}

pub type SharedSocksState = Arc<RwLock<SocksEndpoint>>;

/// 判断目标主机名/IP 是否属于 tailnet 流量（仅看地址本身，不含组件是否 Running）。
pub fn should_route_via_tailnet(host: &str) -> bool {
    let h = host.trim().trim_start_matches('[').trim_end_matches(']');
    let h = h.trim_end_matches('.');
    if h.is_empty() {
        return false;
    }

    // 1. 尝试解析 IP
    if let Ok(ip) = h.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(v4) => is_tailscale_ipv4(v4),
            IpAddr::V6(v6) => is_tailscale_ipv6(v6),
        };
    }

    let lower = h.to_ascii_lowercase();
    // 2. *.ts.net
    if lower.len() > ".ts.net".len() && lower.ends_with(".ts.net") {
        return true;
    }

    // 3. 不含点且不是 localhost 的主机名（MagicDNS 短名，同时排除含冒号的异常串）
    if !lower.contains('.') && !lower.contains(':') && lower != "localhost" {
        return true;
    }

    false
}

fn is_tailscale_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    // 100.64.0.0/10 => 100.64.0.0 - 100.127.255.255
    a == 100 && (b & 0xc0) == 64
}

fn is_tailscale_ipv6(ip: Ipv6Addr) -> bool {
    let o = ip.octets();
    // fd7a:115c:a1e0::/48
    o[0] == 0xfd && o[1] == 0x7a && o[2] == 0x11 && o[3] == 0x5c && o[4] == 0xa1 && o[5] == 0xe0
}

/// 根据分流规则与组件状态决定是否经 SOCKS5 拨出，返回建立好的上游 TCP 连接。
pub async fn dial_upstream(
    socks_state: &SharedSocksState,
    host: &str,
    port: u16,
    timeout: Duration,
) -> Result<TcpStream, String> {
    let route_socks = should_route_via_tailnet(host);
    let endpoint = if route_socks {
        socks_state
            .read()
            .ok()
            .filter(|s| s.running && !s.addr.is_empty() && !s.token.is_empty())
            .map(|s| (s.addr.clone(), s.token.clone()))
    } else {
        None
    };

    if let Some((socks_addr, token)) = endpoint {
        tokio::time::timeout(
            timeout,
            socks5_connect(&socks_addr, SOCKS5_USER, &token, host, port),
        )
        .await
        .map_err(|_| format!("经 SOCKS5 连接 {host}:{port} 超时"))?
    } else {
        let target = format_host_port(host, port);
        tokio::time::timeout(timeout, TcpStream::connect(&target))
            .await
            .map_err(|_| format!("直连 {target} 超时"))?
            .map_err(|e| format!("直连 {target} 失败：{e}"))
    }
}

/// 探测目标 host:port 是否可达（供 `probe` 命令使用，与 HTTP 代理共用完全相同的分流逻辑）。
pub async fn probe_target(socks_state: &SharedSocksState, host: &str, port: u16) -> bool {
    dial_upstream(socks_state, host, port, Duration::from_secs(3))
        .await
        .is_ok()
}

fn format_host_port(host: &str, port: u16) -> String {
    let clean = host.trim_start_matches('[').trim_end_matches(']');
    if clean.contains(':') {
        format!("[{clean}]:{port}")
    } else {
        format!("{clean}:{port}")
    }
}

/// SOCKS5 CONNECT 客户端（RFC 1928 + RFC 1929 用户名/密码认证）。
pub async fn socks5_connect(
    socks_addr: &str,
    username: &str,
    password: &str,
    target_host: &str,
    target_port: u16,
) -> Result<TcpStream, String> {
    let mut stream = TcpStream::connect(socks_addr)
        .await
        .map_err(|e| format!("连接本地 SOCKS5 失败：{e}"))?;
    let _ = stream.set_nodelay(true);

    // 1. 认证方法协商：VER=5, NMETHODS=1, METHOD=0x02 (Username/Password)
    stream
        .write_all(&[0x05, 0x01, 0x02])
        .await
        .map_err(|e| format!("SOCKS5 握手发送失败：{e}"))?;
    let mut method_resp = [0u8; 2];
    stream
        .read_exact(&mut method_resp)
        .await
        .map_err(|e| format!("SOCKS5 握手响应失败：{e}"))?;
    if method_resp[0] != 0x05 || method_resp[1] != 0x02 {
        return Err(format!(
            "SOCKS5 服务端拒绝用户名密码认证（响应 {:02x} {:02x}）",
            method_resp[0], method_resp[1]
        ));
    }

    // 2. RFC 1929 用户名密码子协商
    let u = username.as_bytes();
    let p = password.as_bytes();
    if u.len() > 255 || p.len() > 255 {
        return Err("SOCKS5 认证凭据过长".into());
    }
    let mut auth_req = Vec::with_capacity(3 + u.len() + p.len());
    auth_req.push(0x01); // subnegotiation version
    auth_req.push(u.len() as u8);
    auth_req.extend_from_slice(u);
    auth_req.push(p.len() as u8);
    auth_req.extend_from_slice(p);
    stream
        .write_all(&auth_req)
        .await
        .map_err(|e| format!("SOCKS5 认证发送失败：{e}"))?;
    let mut auth_resp = [0u8; 2];
    stream
        .read_exact(&mut auth_resp)
        .await
        .map_err(|e| format!("SOCKS5 认证响应失败：{e}"))?;
    if auth_resp[1] != 0x00 {
        return Err("SOCKS5 认证失败".into());
    }

    // 3. CONNECT 请求
    let clean_host = target_host.trim_start_matches('[').trim_end_matches(']');
    let mut req = Vec::with_capacity(6 + clean_host.len() + 2);
    req.extend_from_slice(&[0x05, 0x01, 0x00]); // VER=5, CMD=CONNECT, RSV=0
    if let Ok(ip) = clean_host.parse::<IpAddr>() {
        match ip {
            IpAddr::V4(v4) => {
                req.push(0x01);
                req.extend_from_slice(&v4.octets());
            }
            IpAddr::V6(v6) => {
                req.push(0x04);
                req.extend_from_slice(&v6.octets());
            }
        }
    } else {
        let hb = clean_host.as_bytes();
        if hb.is_empty() || hb.len() > 255 {
            return Err("目标主机名长度无效".into());
        }
        req.push(0x03);
        req.push(hb.len() as u8);
        req.extend_from_slice(hb);
    }
    req.extend_from_slice(&target_port.to_be_bytes());
    stream
        .write_all(&req)
        .await
        .map_err(|e| format!("SOCKS5 CONNECT 发送失败：{e}"))?;

    // 4. CONNECT 响应
    let mut head = [0u8; 4];
    stream
        .read_exact(&mut head)
        .await
        .map_err(|e| format!("SOCKS5 CONNECT 响应失败：{e}"))?;
    if head[0] != 0x05 {
        return Err("SOCKS5 响应版本无效".into());
    }
    if head[1] != 0x00 {
        return Err(format!("SOCKS5 CONNECT 被拒绝（错误码 0x{:02x}）", head[1]));
    }
    // 消费 BND.ADDR + BND.PORT
    match head[3] {
        0x01 => {
            let mut skip = [0u8; 6];
            stream
                .read_exact(&mut skip)
                .await
                .map_err(|e| format!("SOCKS5 读取绑定地址失败：{e}"))?;
        }
        0x04 => {
            let mut skip = [0u8; 18];
            stream
                .read_exact(&mut skip)
                .await
                .map_err(|e| format!("SOCKS5 读取绑定地址失败：{e}"))?;
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream
                .read_exact(&mut len)
                .await
                .map_err(|e| format!("SOCKS5 读取绑定域名长度失败：{e}"))?;
            let mut skip = vec![0u8; len[0] as usize + 2];
            stream
                .read_exact(&mut skip)
                .await
                .map_err(|e| format!("SOCKS5 读取绑定域名失败：{e}"))?;
        }
        atyp => return Err(format!("SOCKS5 响应地址类型无效：0x{atyp:02x}")),
    }

    Ok(stream)
}

/// 启动本地 HTTP 代理监听（127.0.0.1:0），返回绑定的本地地址。
/// 后台 accept 循环在 Tokio runtime 上持续运行直到进程退出。
pub async fn start_http_proxy(socks_state: SharedSocksState) -> Result<SocketAddr, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("启动本地代理监听失败：{e}"))?;
    let addr = listener
        .local_addr()
        .map_err(|e| format!("获取本地代理端口失败：{e}"))?;

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let _ = stream.set_nodelay(true);
            let st = socks_state.clone();
            tokio::spawn(async move {
                let _ = handle_client(stream, st).await;
            });
        }
    });

    Ok(addr)
}

#[derive(Debug, PartialEq, Eq)]
enum RequestTarget {
    Connect { host: String, port: u16 },
    AbsoluteHttp { host: String, port: u16, path: String },
}

/// 解析 HTTP 代理请求行：只允许 CONNECT authority-form 和 http:// absolute-form，拒绝 origin-form。
fn parse_request_line(line: &str) -> Result<(String, RequestTarget, String), &'static str> {
    let trimmed = line.trim_end_matches(['\r', '\n']);
    let mut parts = trimmed.split_whitespace();
    let method = parts.next().ok_or("缺少请求方法")?;
    let target = parts.next().ok_or("缺少请求目标")?;
    let version = parts.next().ok_or("缺少协议版本")?;
    if parts.next().is_some() || !version.starts_with("HTTP/") {
        return Err("请求行格式无效");
    }

    if method.eq_ignore_ascii_case("CONNECT") {
        let (host, port) = parse_authority(target, 443)?;
        return Ok((
            method.to_string(),
            RequestTarget::Connect { host, port },
            version.to_string(),
        ));
    }

    // 拒绝 origin-form（如 GET /path）和 asterisk-form（OPTIONS *）
    if target.starts_with('/') || target == "*" {
        return Err("拒绝 origin-form 请求");
    }

    // 仅接受 absolute-form http://...（WebView 代理普通 HTTP / WS 时使用 http://）
    let rest = target
        .strip_prefix("http://")
        .or_else(|| target.strip_prefix("HTTP://"))
        .ok_or("仅支持 http:// absolute-form 或 CONNECT")?;

    let (authority, path) = match rest.find(['/', '?']) {
        Some(idx) => {
            let (a, p) = rest.split_at(idx);
            let p = if p.starts_with('?') {
                format!("/{p}")
            } else {
                p.to_string()
            };
            (a, p)
        }
        None => (rest, "/".to_string()),
    };

    let (host, port) = parse_authority(authority, 80)?;
    Ok((
        method.to_string(),
        RequestTarget::AbsoluteHttp { host, port, path },
        version.to_string(),
    ))
}

fn parse_authority(auth: &str, default_port: u16) -> Result<(String, u16), &'static str> {
    if auth.is_empty() || auth.contains('@') {
        return Err("主机地址无效");
    }
    if let Some(rest) = auth.strip_prefix('[') {
        let (ip, after) = rest.split_once(']').ok_or("IPv6 地址缺少右括号")?;
        if ip.is_empty() {
            return Err("IPv6 地址为空");
        }
        let port = if after.is_empty() {
            default_port
        } else if let Some(p) = after.strip_prefix(':') {
            p.parse::<u16>().map_err(|_| "端口无效")?
        } else {
            return Err("IPv6 后缀无效");
        };
        Ok((ip.to_string(), port))
    } else if let Some((h, p)) = auth.rsplit_once(':') {
        if h.is_empty() {
            return Err("主机名为空");
        }
        let port = p.parse::<u16>().map_err(|_| "端口无效")?;
        Ok((h.to_string(), port))
    } else {
        Ok((auth.to_string(), default_port))
    }
}

struct HeaderBlock {
    first_line: String,
    headers: Vec<(String, String)>,
}

async fn read_header_block<R: AsyncBufReadExt + Unpin>(
    reader: &mut R,
) -> Result<Option<HeaderBlock>, String> {
    let mut first_line = String::new();
    let n = reader
        .read_line(&mut first_line)
        .await
        .map_err(|e| format!("读取首行失败：{e}"))?;
    if n == 0 {
        return Ok(None);
    }
    if first_line.len() > 16 * 1024 {
        return Err("请求/响应首行过长".into());
    }

    let mut headers = Vec::new();
    let mut total_bytes = first_line.len();
    loop {
        let mut line = String::new();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| format!("读取头部失败：{e}"))?;
        if n == 0 {
            return Err("头部未完整结束".into());
        }
        total_bytes += n;
        if total_bytes > 64 * 1024 || headers.len() > 200 {
            return Err("HTTP 头部过大".into());
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some((k, v)) = trimmed.split_once(':') {
            headers.push((k.trim().to_string(), v.trim().to_string()));
        }
    }

    Ok(Some(HeaderBlock {
        first_line,
        headers,
    }))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BodyMode {
    None,
    Length(u64),
    Chunked,
    UntilEof,
}

fn header_value<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn has_token(headers: &[(String, String)], name: &str, token: &str) -> bool {
    headers.iter().any(|(k, v)| {
        k.eq_ignore_ascii_case(name)
            && v.split(',').any(|part| part.trim().eq_ignore_ascii_case(token))
    })
}

fn request_body_mode(headers: &[(String, String)]) -> BodyMode {
    if has_token(headers, "transfer-encoding", "chunked") {
        BodyMode::Chunked
    } else if let Some(cl) = header_value(headers, "content-length") {
        if let Ok(n) = cl.parse::<u64>() {
            if n > 0 {
                BodyMode::Length(n)
            } else {
                BodyMode::None
            }
        } else {
            BodyMode::None
        }
    } else {
        BodyMode::None
    }
}

fn response_body_mode(req_method: &str, status: u16, headers: &[(String, String)]) -> BodyMode {
    if req_method.eq_ignore_ascii_case("HEAD")
        || (100..200).contains(&status)
        || status == 204
        || status == 304
    {
        return BodyMode::None;
    }
    if has_token(headers, "transfer-encoding", "chunked") {
        return BodyMode::Chunked;
    }
    if let Some(cl) = header_value(headers, "content-length") {
        if let Ok(n) = cl.parse::<u64>() {
            return if n == 0 {
                BodyMode::None
            } else {
                BodyMode::Length(n)
            };
        }
    }
    BodyMode::UntilEof
}

fn parse_status_code(status_line: &str) -> Option<u16> {
    status_line.split_whitespace().nth(1)?.parse::<u16>().ok()
}

/// 逐块转发 HTTP body 并及时 flush（保证 SSE / 流式响应无缓冲延迟）。
async fn forward_body<R, W>(reader: &mut R, writer: &mut W, mode: BodyMode) -> Result<(), String>
where
    R: AsyncBufReadExt + AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    match mode {
        BodyMode::None => Ok(()),
        BodyMode::Length(mut remaining) => {
            let mut buf = [0u8; 16 * 1024];
            while remaining > 0 {
                let to_read = (remaining as usize).min(buf.len());
                let n = reader
                    .read(&mut buf[..to_read])
                    .await
                    .map_err(|e| format!("读取固定长度消息体失败：{e}"))?;
                if n == 0 {
                    return Err("消息体提前结束".into());
                }
                writer
                    .write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("写入固定长度消息体失败：{e}"))?;
                writer.flush().await.map_err(|e| format!("flush 失败：{e}"))?;
                remaining -= n as u64;
            }
            Ok(())
        }
        BodyMode::Chunked => {
            let mut buf = [0u8; 16 * 1024];
            loop {
                let mut size_line = String::new();
                let n = reader
                    .read_line(&mut size_line)
                    .await
                    .map_err(|e| format!("读取分块大小失败：{e}"))?;
                if n == 0 {
                    return Err("分块消息体提前结束".into());
                }
                writer
                    .write_all(size_line.as_bytes())
                    .await
                    .map_err(|e| format!("写入分块大小失败：{e}"))?;

                let hex = size_line
                    .trim_end_matches(['\r', '\n'])
                    .split(';')
                    .next()
                    .unwrap_or("")
                    .trim();
                let size = u64::from_str_radix(hex, 16)
                    .map_err(|_| "无效的分块大小".to_string())?;

                if size == 0 {
                    // 转发尾部 trailer 直到空行
                    loop {
                        let mut trailer = String::new();
                        let tn = reader
                            .read_line(&mut trailer)
                            .await
                            .map_err(|e| format!("读取分块结尾失败：{e}"))?;
                        if tn == 0 {
                            break;
                        }
                        writer
                            .write_all(trailer.as_bytes())
                            .await
                            .map_err(|e| format!("写入分块结尾失败：{e}"))?;
                        if trailer == "\r\n" || trailer == "\n" {
                            break;
                        }
                    }
                    writer.flush().await.map_err(|e| format!("flush 失败：{e}"))?;
                    return Ok(());
                }

                // 转发 chunk 数据 + 结尾的 \r\n（2 字节）
                let mut left = size;
                while left > 0 {
                    let to_read = (left as usize).min(buf.len());
                    let rn = reader
                        .read(&mut buf[..to_read])
                        .await
                        .map_err(|e| format!("读取分块数据失败：{e}"))?;
                    if rn == 0 {
                        return Err("分块数据被截断".into());
                    }
                    writer
                        .write_all(&buf[..rn])
                        .await
                        .map_err(|e| format!("写入分块数据失败：{e}"))?;
                    left -= rn as u64;
                }
                let mut crlf = String::new();
                let _ = reader
                    .read_line(&mut crlf)
                    .await
                    .map_err(|e| format!("读取分块换行失败：{e}"))?;
                writer
                    .write_all(crlf.as_bytes())
                    .await
                    .map_err(|e| format!("写入分块换行失败：{e}"))?;
                writer.flush().await.map_err(|e| format!("flush 失败：{e}"))?;
            }
        }
        BodyMode::UntilEof => {
            let mut buf = [0u8; 16 * 1024];
            loop {
                let n = reader
                    .read(&mut buf)
                    .await
                    .map_err(|e| format!("读取流式消息体失败：{e}"))?;
                if n == 0 {
                    break;
                }
                writer
                    .write_all(&buf[..n])
                    .await
                    .map_err(|e| format!("写入流式消息体失败：{e}"))?;
                writer.flush().await.map_err(|e| format!("flush 失败：{e}"))?;
            }
            Ok(())
        }
    }
}

async fn send_error(stream: &mut TcpStream, status: &str, body: &str) {
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.flush().await;
}

/// 双向透传：先把已读入缓冲区的剩余字节刷出去，再 copy_bidirectional。
async fn tunnel_bidirectional(
    client_reader: BufReader<TcpStream>,
    upstream_reader: BufReader<TcpStream>,
) {
    let client_pre = client_reader.buffer().to_vec();
    let up_pre = upstream_reader.buffer().to_vec();
    let mut client = client_reader.into_inner();
    let mut upstream = upstream_reader.into_inner();

    if !client_pre.is_empty() && upstream.write_all(&client_pre).await.is_err() {
        return;
    }
    if !up_pre.is_empty() && client.write_all(&up_pre).await.is_err() {
        return;
    }
    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
}

async fn handle_client(client_stream: TcpStream, socks_state: SharedSocksState) -> Result<(), String> {
    let mut client = BufReader::new(client_stream);
    let mut cached_upstream: Option<(String, u16, BufReader<TcpStream>)> = None;

    loop {
        let Some(req) = read_header_block(&mut client).await? else {
            return Ok(());
        };

        let (method, target, version) = match parse_request_line(&req.first_line) {
            Ok(v) => v,
            Err(msg) => {
                send_error(client.get_mut(), "400 Bad Request", msg).await;
                return Ok(());
            }
        };

        match target {
            RequestTarget::Connect { host, port } => {
                // CONNECT 独占连接，丢弃任何缓存上游
                drop(cached_upstream);
                let upstream = match dial_upstream(&socks_state, &host, port, CONNECT_TIMEOUT).await {
                    Ok(s) => s,
                    Err(e) => {
                        send_error(client.get_mut(), "502 Bad Gateway", &e).await;
                        return Ok(());
                    }
                };
                client
                    .get_mut()
                    .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                    .await
                    .map_err(|e| format!("回复 CONNECT 200 失败：{e}"))?;
                client
                    .get_mut()
                    .flush()
                    .await
                    .map_err(|e| format!("flush 失败：{e}"))?;

                tunnel_bidirectional(client, BufReader::new(upstream)).await;
                return Ok(());
            }

            RequestTarget::AbsoluteHttp { host, port, path } => {
                let is_upgrade = header_value(&req.headers, "upgrade").is_some()
                    && has_token(&req.headers, "connection", "upgrade");
                let client_wants_close = has_token(&req.headers, "connection", "close")
                    || has_token(&req.headers, "proxy-connection", "close")
                    || (version == "HTTP/1.0"
                        && !has_token(&req.headers, "connection", "keep-alive")
                        && !has_token(&req.headers, "proxy-connection", "keep-alive"));

                // 取出可复用的上游连接，或者新建
                let mut upstream = match cached_upstream.take() {
                    Some((ch, cp, up)) if !is_upgrade && ch == host && cp == port => up,
                    _ => match dial_upstream(&socks_state, &host, port, CONNECT_TIMEOUT).await {
                        Ok(s) => BufReader::new(s),
                        Err(e) => {
                            send_error(client.get_mut(), "502 Bad Gateway", &e).await;
                            return Ok(());
                        }
                    },
                };

                // 构造转发给上游的请求头
                let mut out_head = format!("{method} {path} {version}\r\n");
                let has_host = header_value(&req.headers, "host").is_some();
                if !has_host {
                    let host_hdr = if port == 80 {
                        if host.contains(':') {
                            format!("[{host}]")
                        } else {
                            host.clone()
                        }
                    } else {
                        format_host_port(&host, port)
                    };
                    out_head.push_str(&format!("Host: {host_hdr}\r\n"));
                }
                for (k, v) in &req.headers {
                    if k.eq_ignore_ascii_case("proxy-connection")
                        || k.eq_ignore_ascii_case("proxy-authorization")
                    {
                        continue;
                    }
                    out_head.push_str(k);
                    out_head.push_str(": ");
                    out_head.push_str(v);
                    out_head.push_str("\r\n");
                }
                out_head.push_str("\r\n");

                // 尝试写入上游（若复用连接已失效，自动重连一次）
                if upstream.get_mut().write_all(out_head.as_bytes()).await.is_err() {
                    let fresh = match dial_upstream(&socks_state, &host, port, CONNECT_TIMEOUT).await {
                        Ok(s) => s,
                        Err(e) => {
                            send_error(client.get_mut(), "502 Bad Gateway", &e).await;
                            return Ok(());
                        }
                    };
                    upstream = BufReader::new(fresh);
                    upstream
                        .get_mut()
                        .write_all(out_head.as_bytes())
                        .await
                        .map_err(|e| format!("发送上游请求头失败：{e}"))?;
                }
                upstream
                    .get_mut()
                    .flush()
                    .await
                    .map_err(|e| format!("flush 上游失败：{e}"))?;

                // 转发请求体
                let req_body_mode = request_body_mode(&req.headers);
                forward_body(&mut client, upstream.get_mut(), req_body_mode).await?;

                // 读取上游响应头（处理可能的 100 Continue 等临时 1xx 响应）
                let resp = loop {
                    let Some(block) = read_header_block(&mut upstream).await? else {
                        return Ok(());
                    };
                    let status = parse_status_code(&block.first_line).unwrap_or(502);

                    let mut resp_head = block.first_line.clone();
                    for (k, v) in &block.headers {
                        if k.eq_ignore_ascii_case("proxy-connection") {
                            continue;
                        }
                        resp_head.push_str(k);
                        resp_head.push_str(": ");
                        resp_head.push_str(v);
                        resp_head.push_str("\r\n");
                    }
                    resp_head.push_str("\r\n");
                    client
                        .get_mut()
                        .write_all(resp_head.as_bytes())
                        .await
                        .map_err(|e| format!("写响应头失败：{e}"))?;
                    client
                        .get_mut()
                        .flush()
                        .await
                        .map_err(|e| format!("flush 客户端失败：{e}"))?;

                    if status == 101 && is_upgrade {
                        tunnel_bidirectional(client, upstream).await;
                        return Ok(());
                    }
                    if (100..200).contains(&status) && status != 101 {
                        continue;
                    }
                    break (status, block);
                };

                let (status, resp_block) = resp;
                let resp_mode = response_body_mode(&method, status, &resp_block.headers);
                forward_body(&mut upstream, client.get_mut(), resp_mode).await?;

                let upstream_wants_close = has_token(&resp_block.headers, "connection", "close")
                    || resp_mode == BodyMode::UntilEof
                    || (resp_block.first_line.starts_with("HTTP/1.0")
                        && !has_token(&resp_block.headers, "connection", "keep-alive"));

                if client_wants_close || upstream_wants_close {
                    return Ok(());
                }

                cached_upstream = Some((host, port, upstream));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routing_rules_match_contract() {
        // 100.64.0.0/10
        assert!(should_route_via_tailnet("100.64.0.1"));
        assert!(should_route_via_tailnet("100.100.100.100"));
        assert!(should_route_via_tailnet("100.127.255.254"));
        assert!(!should_route_via_tailnet("100.63.255.255"));
        assert!(!should_route_via_tailnet("100.128.0.1"));
        assert!(!should_route_via_tailnet("127.0.0.1"));
        assert!(!should_route_via_tailnet("192.168.1.1"));

        // fd7a:115c:a1e0::/48
        assert!(should_route_via_tailnet("fd7a:115c:a1e0::1"));
        assert!(should_route_via_tailnet("[fd7a:115c:a1e0::ab12:3456]"));
        assert!(!should_route_via_tailnet("fd7a:115c:a1e1::1"));
        assert!(!should_route_via_tailnet("::1"));

        // *.ts.net
        assert!(should_route_via_tailnet("mybox.tail1234.ts.net"));
        assert!(should_route_via_tailnet("MYBOX.TS.NET."));
        assert!(!should_route_via_tailnet("ts.net"));
        assert!(!should_route_via_tailnet("example.com"));

        // 不含点且不是 localhost
        assert!(should_route_via_tailnet("my-server"));
        assert!(should_route_via_tailnet("workstation"));
        assert!(!should_route_via_tailnet("localhost"));
        assert!(!should_route_via_tailnet("LOCALHOST"));
        assert!(!should_route_via_tailnet("tauri.localhost"));
        assert!(!should_route_via_tailnet(""));
    }

    #[test]
    fn request_line_parsing_and_origin_form_rejection() {
        assert_eq!(
            parse_request_line("CONNECT 100.64.0.1:443 HTTP/1.1\r\n").unwrap(),
            (
                "CONNECT".into(),
                RequestTarget::Connect {
                    host: "100.64.0.1".into(),
                    port: 443
                },
                "HTTP/1.1".into()
            )
        );
        assert_eq!(
            parse_request_line("GET http://100.64.0.2:7878/api/ping?x=1 HTTP/1.1\r\n").unwrap(),
            (
                "GET".into(),
                RequestTarget::AbsoluteHttp {
                    host: "100.64.0.2".into(),
                    port: 7878,
                    path: "/api/ping?x=1".into()
                },
                "HTTP/1.1".into()
            )
        );
        // 必须拒绝 origin-form
        assert!(parse_request_line("GET /index.html HTTP/1.1\r\n").is_err());
        assert!(parse_request_line("OPTIONS * HTTP/1.1\r\n").is_err());
    }

    /// 启动一个假 SOCKS5 服务端（校验用户名密码，然后把流量直连到指定的目标地址）
    async fn spawn_mock_socks5(expected_pass: &'static str, redirect_to: SocketAddr) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((mut s, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut m = [0u8; 3];
                    if s.read_exact(&mut m).await.is_err() {
                        return;
                    }
                    // 回复选择用户名密码认证 (0x02)
                    let _ = s.write_all(&[0x05, 0x02]).await;
                    let mut ver_ulen = [0u8; 2];
                    if s.read_exact(&mut ver_ulen).await.is_err() {
                        return;
                    }
                    let mut u = vec![0u8; ver_ulen[1] as usize];
                    let _ = s.read_exact(&mut u).await;
                    let mut plen = [0u8; 1];
                    let _ = s.read_exact(&mut plen).await;
                    let mut p = vec![0u8; plen[0] as usize];
                    let _ = s.read_exact(&mut p).await;
                    if u != b"cosyee" || p != expected_pass.as_bytes() {
                        let _ = s.write_all(&[0x01, 0x01]).await;
                        return;
                    }
                    let _ = s.write_all(&[0x01, 0x00]).await;

                    // 读 CONNECT 请求
                    let mut head = [0u8; 4];
                    if s.read_exact(&mut head).await.is_err() {
                        return;
                    }
                    match head[3] {
                        0x01 => {
                            let mut skip = [0u8; 6];
                            let _ = s.read_exact(&mut skip).await;
                        }
                        0x04 => {
                            let mut skip = [0u8; 18];
                            let _ = s.read_exact(&mut skip).await;
                        }
                        0x03 => {
                            let mut l = [0u8; 1];
                            let _ = s.read_exact(&mut l).await;
                            let mut skip = vec![0u8; l[0] as usize + 2];
                            let _ = s.read_exact(&mut skip).await;
                        }
                        _ => return,
                    }
                    if let Ok(mut target) = TcpStream::connect(redirect_to).await {
                        let _ = s.write_all(&[0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]).await;
                        let _ = tokio::io::copy_bidirectional(&mut s, &mut target).await;
                    } else {
                        let _ = s.write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
                    }
                });
            }
        });
        addr
    }

    #[tokio::test]
    async fn socks5_handshake_and_auth_failure() {
        // 简单回声服务端
        let echo_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let echo_addr = echo_listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((mut s, _)) = echo_listener.accept().await {
                let mut buf = [0u8; 16];
                if let Ok(n) = s.read(&mut buf).await {
                    let _ = s.write_all(&buf[..n]).await;
                }
            }
        });

        let socks_addr = spawn_mock_socks5("secret-token", echo_addr).await;

        // 正确密码通过
        let mut s = socks5_connect(&socks_addr.to_string(), "cosyee", "secret-token", "mybox.ts.net", 7878)
            .await
            .unwrap();
        s.write_all(b"ping").await.unwrap();
        let mut out = [0u8; 4];
        s.read_exact(&mut out).await.unwrap();
        assert_eq!(&out, b"ping");

        // 错误密码失败
        let err = socks5_connect(&socks_addr.to_string(), "cosyee", "wrong", "mybox.ts.net", 7878).await;
        assert!(err.is_err());
    }

    #[tokio::test]
    async fn proxy_rejects_origin_form_and_forwards_absolute_http_and_connect_and_ws() {
        // 假上游 HTTP/WS 服务端
        let up_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let up_addr = up_listener.local_addr().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((s, _)) = up_listener.accept().await else {
                    break;
                };
                tokio::spawn(async move {
                    let mut br = BufReader::new(s);
                    loop {
                        let Ok(Some(req)) = read_header_block(&mut br).await else {
                            break;
                        };
                        if req.first_line.starts_with("GET /ws ") {
                            let _ = br
                                .get_mut()
                                .write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
                                .await;
                            let mut buf = [0u8; 5];
                            if br.read_exact(&mut buf).await.is_ok() {
                                let _ = br.get_mut().write_all(&buf).await;
                            }
                            break;
                        } else if req.first_line.starts_with("GET /sse ") {
                            let _ = br
                                .get_mut()
                                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\ndata:1\r\n6\r\ndata:2\r\n0\r\n\r\n")
                                .await;
                        } else {
                            let _ = br
                                .get_mut()
                                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK")
                                .await;
                        }
                    }
                });
            }
        });

        let socks_addr = spawn_mock_socks5("tok123", up_addr).await;
        let state = Arc::new(RwLock::new(SocksEndpoint {
            addr: socks_addr.to_string(),
            token: "tok123".into(),
            running: true,
        }));
        let proxy_addr = start_http_proxy(state).await.unwrap();

        // 1. origin-form 必须返回 400
        let mut c1 = TcpStream::connect(proxy_addr).await.unwrap();
        c1.write_all(b"GET /secret HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut r1 = String::new();
        c1.read_to_string(&mut r1).await.unwrap();
        assert!(r1.starts_with("HTTP/1.1 400 Bad Request"));

        // 2. absolute-form + keep-alive + chunked/SSE 经 SOCKS5 路由（目标 100.64.0.9）
        let mut c2 = BufReader::new(TcpStream::connect(proxy_addr).await.unwrap());
        c2.get_mut()
            .write_all(b"GET http://100.64.0.9:7878/hello HTTP/1.1\r\nHost: 100.64.0.9:7878\r\n\r\n")
            .await
            .unwrap();
        let b1 = read_header_block(&mut c2).await.unwrap().unwrap();
        assert!(b1.first_line.contains("200 OK"));
        let mut body1 = [0u8; 2];
        c2.read_exact(&mut body1).await.unwrap();
        assert_eq!(&body1, b"OK");

        // 同一连接复用发送 SSE chunked 请求
        c2.get_mut()
            .write_all(b"GET http://100.64.0.9:7878/sse HTTP/1.1\r\nHost: 100.64.0.9:7878\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let b2 = read_header_block(&mut c2).await.unwrap().unwrap();
        assert!(b2.first_line.contains("200 OK"));
        let mut sse_rest = String::new();
        c2.read_to_string(&mut sse_rest).await.unwrap();
        assert!(sse_rest.contains("data:1") && sse_rest.contains("data:2"));

        // 3. WebSocket Upgrade 101 双向透传
        let mut c3 = BufReader::new(TcpStream::connect(proxy_addr).await.unwrap());
        c3.get_mut()
            .write_all(b"GET http://mybox.ts.net:7878/ws HTTP/1.1\r\nHost: mybox.ts.net:7878\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
            .await
            .unwrap();
        let b3 = read_header_block(&mut c3).await.unwrap().unwrap();
        assert!(b3.first_line.contains("101 Switching Protocols"));
        c3.get_mut().write_all(b"hello").await.unwrap();
        let mut ws_out = [0u8; 5];
        c3.read_exact(&mut ws_out).await.unwrap();
        assert_eq!(&ws_out, b"hello");

        // 4. CONNECT 隧道（经 SOCKS5 转发到假上游）
        let mut c4 = BufReader::new(TcpStream::connect(proxy_addr).await.unwrap());
        c4.get_mut()
            .write_all(b"CONNECT mybox.ts.net:7878 HTTP/1.1\r\nHost: mybox.ts.net:7878\r\n\r\n")
            .await
            .unwrap();
        let b4 = read_header_block(&mut c4).await.unwrap().unwrap();
        assert!(b4.first_line.contains("200 Connection Established"));
        c4.get_mut()
            .write_all(b"GET /tunnel HTTP/1.1\r\nHost: mybox.ts.net:7878\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let b4_inner = read_header_block(&mut c4).await.unwrap().unwrap();
        assert!(b4_inner.first_line.contains("200 OK"));
    }
}
