// tailnet 节点名单：给标题栏的服务器切换下拉显示 Tailscale 机器名（别名）、复制 IP 用。
// 内置 Tailscale 在运行就问它（GET /peers）；否则读系统 Tailscale 的 `tailscale status --json`。
// 两边都拿不到时返回空列表，下拉照常只显示地址。
use serde::{Deserialize, Serialize};

use crate::tailnet::{self, component::SelfNode};

/// 注入给标题栏的一项：机器名 + 它的 Tailscale 地址；me 表示这台设备自己。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Peer {
    pub name: String,
    pub dns: String,
    pub ips: Vec<String>,
    pub me: bool,
}

/// Tailscale 管理后台显示的机器名就是 MagicDNS 全名的第一段；没有 MagicDNS 时退回系统主机名。
fn short_name(dns: &str, host: &str) -> String {
    let first = dns.trim_end_matches('.').split('.').next().unwrap_or("");
    if first.is_empty() { host.to_string() } else { first.to_string() }
}

fn peer(dns: &str, host: &str, ips: Vec<String>, me: bool) -> Option<Peer> {
    let name = short_name(dns, host);
    if name.is_empty() || ips.is_empty() {
        return None;
    }
    Some(Peer { name, dns: dns.trim_end_matches('.').to_string(), ips, me })
}

fn from_builtin(me: Option<SelfNode>, peers: Vec<SelfNode>) -> Vec<Peer> {
    me.into_iter()
        .map(|n| (n, true))
        .chain(peers.into_iter().map(|n| (n, false)))
        .filter_map(|(n, me)| peer(&n.dns_name, &n.name, n.ips, me))
        .collect()
}

#[derive(Deserialize)]
struct CliNode {
    #[serde(default, rename = "HostName")]
    host: Option<String>,
    #[serde(default, rename = "DNSName")]
    dns: Option<String>,
    #[serde(default, rename = "TailscaleIPs")]
    ips: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct CliStatus {
    #[serde(default, rename = "Self")]
    me: Option<CliNode>,
    #[serde(default, rename = "Peer")]
    peers: Option<std::collections::BTreeMap<String, CliNode>>,
}

fn parse_cli(json: &str) -> Vec<Peer> {
    let Ok(st) = serde_json::from_str::<CliStatus>(json) else {
        return Vec::new();
    };
    let node = |n: CliNode, me| peer(n.dns.as_deref().unwrap_or(""), n.host.as_deref().unwrap_or(""), n.ips.unwrap_or_default(), me);
    let mut out: Vec<Peer> = st.me.and_then(|n| node(n, true)).into_iter().collect();
    out.extend(st.peers.unwrap_or_default().into_values().filter_map(|n| node(n, false)));
    out
}

/// 系统 Tailscale 的命令行（与服务端 tailscaleHttps.ts 的查找顺序一致）
fn cli_path() -> std::path::PathBuf {
    let cands: Vec<std::path::PathBuf> = if cfg!(windows) {
        let pf = std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into());
        vec![std::path::Path::new(&pf).join("Tailscale").join("tailscale.exe")]
    } else if cfg!(target_os = "macos") {
        ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]
            .iter()
            .map(Into::into)
            .collect()
    } else {
        Vec::new()
    };
    cands.into_iter().find(|p| p.exists()).unwrap_or_else(|| "tailscale".into())
}

fn from_cli() -> Vec<Peer> {
    let mut c = std::process::Command::new(cli_path());
    c.args(["status", "--json"]).stdin(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    match c.output() {
        Ok(o) if o.status.success() => parse_cli(&String::from_utf8_lossy(&o.stdout)),
        _ => Vec::new(),
    }
}

/// 阻塞调用（最多几秒），放在 spawn_blocking 里用。
pub fn list() -> Vec<Peer> {
    match tailnet::builtin_peers() {
        Some((me, peers)) => from_builtin(me, peers),
        None => from_cli(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cli_status() {
        let json = r#"{"Self":{"HostName":"Dane MBP","DNSName":"danedemacbook-pro.tail1.ts.net.","TailscaleIPs":["100.108.140.0","fd7a::1"]},
            "Peer":{"k1":{"HostName":"box","DNSName":"","TailscaleIPs":["100.106.9.14"]},"k2":{"HostName":"gone","TailscaleIPs":null}}}"#;
        let got = parse_cli(json);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0], Peer { name: "danedemacbook-pro".into(), dns: "danedemacbook-pro.tail1.ts.net".into(), ips: vec!["100.108.140.0".into(), "fd7a::1".into()], me: true });
        assert_eq!(got[1].name, "box");
        assert!(!got[1].me);
        assert!(parse_cli("not json").is_empty());
    }

    #[test]
    fn builtin_marks_self() {
        let n = |dns: &str, ip: &str| SelfNode { name: "h".into(), dns_name: dns.into(), ips: vec![ip.into()] };
        let got = from_builtin(Some(n("me.t.ts.net", "100.1.1.1")), vec![n("pc.t.ts.net", "100.2.2.2"), n("", "100.3.3.3")]);
        let names: Vec<_> = got.iter().map(|p| (p.name.as_str(), p.me)).collect();
        assert_eq!(names, [("me", true), ("pc", false), ("h", false)]);
    }
}
