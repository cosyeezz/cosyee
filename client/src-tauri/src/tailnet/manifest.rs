// manifest 拉取、Ed25519 签名校验、组件下载（sha256 + size 校验）、原子安装与旧版本清理。
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use base64::Engine as _;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::http_client;

/// 滚动 release 的 manifest 地址与签名地址
pub const MANIFEST_URL: &str =
    "https://github.com/cosyeezz/cosyee/releases/download/tailnet-latest/manifest.json";
pub const MANIFEST_SIG_URL: &str =
    "https://github.com/cosyeezz/cosyee/releases/download/tailnet-latest/manifest.json.sig";

/// 写死在客户端的 Ed25519 原始公钥（32 字节 base64），见 CONTRACT.md
pub const PUBLIC_KEY_B64: &str = "cRew2agsYGnnrphfIwIjmlvFFToCaaidYmpvylSKB64=";

const MANIFEST_MAX_RETRIES: usize = 2;
const MANIFEST_RETRY_DELAY: Duration = Duration::from_secs(2);
const DOWNLOAD_MAX_RETRIES: usize = 3;
const DOWNLOAD_RETRY_DELAY: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Manifest {
    pub version: String,
    #[serde(default)]
    pub tailscale: String,
    #[serde(default)]
    pub released: String,
    pub assets: HashMap<String, ManifestAsset>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ManifestAsset {
    pub url: String,
    pub sha256: String,
    pub size: u64,
}

/// 校验 manifest.json 原始字节的 Ed25519 签名（base64 一行）。
pub fn verify_manifest_signature(
    manifest_bytes: &[u8],
    sig_b64: &str,
    pubkey_b64: &str,
) -> Result<(), String> {
    let pub_raw = base64::engine::general_purpose::STANDARD
        .decode(pubkey_b64.trim())
        .map_err(|e| format!("内置公钥格式无效：{e}"))?;
    let pub_arr: [u8; 32] = pub_raw
        .try_into()
        .map_err(|_| "内置公钥长度不是 32 字节".to_string())?;
    let vk = VerifyingKey::from_bytes(&pub_arr).map_err(|e| format!("内置公钥无效：{e}"))?;

    let sig_raw = base64::engine::general_purpose::STANDARD
        .decode(sig_b64.trim())
        .map_err(|e| format!("签名文件格式无效：{e}"))?;
    let sig_arr: [u8; 64] = sig_raw
        .try_into()
        .map_err(|_| "签名长度不是 64 字节".to_string())?;
    let sig = Signature::from_bytes(&sig_arr);

    vk.verify(manifest_bytes, &sig)
        .map_err(|_| "manifest 签名校验失败，已拒绝安装".to_string())
}

/// 带重试的文本/字节拉取辅助：失败时最多重试 `max_retries` 次，每次间隔 `retry_delay`。
fn fetch_bytes_with_retry(
    agent: &ureq::Agent,
    url: &str,
    limit: u64,
    action: &str,
    max_retries: usize,
    retry_delay: Duration,
    log_fn: &mut impl FnMut(String),
) -> Result<Vec<u8>, String> {
    let mut last_err = String::new();
    for attempt in 0..=max_retries {
        if attempt > 0 {
            log_fn(format!("第 {attempt} 次重试…"));
            std::thread::sleep(retry_delay);
        }
        match agent.get(url).call() {
            Ok(mut resp) => {
                match resp.body_mut().with_config().limit(limit).read_to_vec() {
                    Ok(bytes) => return Ok(bytes),
                    Err(e) => {
                        last_err = http_client::format_github_error(action, "github.com", &e);
                    }
                }
            }
            Err(e) => {
                last_err = http_client::format_github_error(action, "github.com", &e);
            }
        }
    }
    Err(last_err)
}

/// 从 GitHub Releases 拉取 manifest.json 和 manifest.json.sig，验签通过后解析返回（带日志输出）。
pub fn fetch_verified_manifest_with_log(mut log_fn: impl FnMut(String)) -> Result<Manifest, String> {
    let (agent, resolved_proxy) =
        http_client::build_external_agent(Some(http_client::MANIFEST_GLOBAL_TIMEOUT));
    log_fn(http_client::describe_proxy_for_log(
        resolved_proxy.as_ref(),
        "GitHub",
    ));

    let manifest_bytes = fetch_bytes_with_retry(
        &agent,
        MANIFEST_URL,
        1024 * 1024,
        "获取版本信息失败",
        MANIFEST_MAX_RETRIES,
        MANIFEST_RETRY_DELAY,
        &mut log_fn,
    )?;

    let sig_bytes = fetch_bytes_with_retry(
        &agent,
        MANIFEST_SIG_URL,
        4096,
        "获取签名文件失败",
        MANIFEST_MAX_RETRIES,
        MANIFEST_RETRY_DELAY,
        &mut log_fn,
    )?;
    let sig_text = String::from_utf8(sig_bytes)
        .map_err(|e| format!("签名文件不是有效的 UTF-8 文本：{e}"))?;

    verify_manifest_signature(&manifest_bytes, &sig_text, PUBLIC_KEY_B64)?;

    serde_json::from_slice::<Manifest>(&manifest_bytes)
        .map_err(|e| format!("解析 manifest.json 失败：{e}"))
}

/// 从 GitHub Releases 拉取 manifest.json 和 manifest.json.sig，验签通过后解析返回。
#[allow(dead_code)]
pub fn fetch_verified_manifest() -> Result<Manifest, String> {
    fetch_verified_manifest_with_log(|_| {})
}

/// 根据平台键和版本号生成落盘文件名（按版本命名，便于原子替换与清理旧版本）。
pub fn asset_filename(platform_key: &str, version: &str) -> Result<String, String> {
    // 防止路径穿越
    if version.is_empty()
        || !version
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'+'))
    {
        return Err("manifest 中的版本号包含非法字符".into());
    }
    let name = match platform_key {
        "windows-x64" => format!("cosyee-tailnet_{version}_windows_x64.exe"),
        "macos-universal" => format!("cosyee-tailnet_{version}_macos_universal"),
        "android-arm64" => format!("libcosyee_tailnet_{version}_android_arm64.so"),
        _ => return Err(format!("不支持的平台：{platform_key}")),
    };
    Ok(name)
}

/// 简单的字节转小写十六进制。
pub fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

/// 下载资产到临时文件 → 校验 size 和 sha256 → 设置权限 → 原子改名到目标路径。
pub fn download_and_install_asset(
    install_dir: &Path,
    platform_key: &str,
    version: &str,
    asset: &ManifestAsset,
    log_fn: impl FnMut(String),
) -> Result<String, String> {
    if !asset.url.starts_with("https://") {
        return Err("下载地址不是 https，已拒绝".into());
    }
    let (agent, _) =
        http_client::build_external_agent(Some(http_client::DOWNLOAD_GLOBAL_TIMEOUT));
    download_and_install_asset_with_agent(
        install_dir,
        platform_key,
        version,
        asset,
        &agent,
        DOWNLOAD_RETRY_DELAY,
        log_fn,
    )
}

/// 校验 206 响应的 Content-Range 头（若存在）是否从期望偏移 `expected_start` 开始。
fn content_range_matches_start(header_val: Option<&str>, expected_start: u64) -> bool {
    let Some(raw) = header_val else {
        return true;
    };
    let trimmed = raw.trim();
    let Some(rest) = trimmed
        .strip_prefix("bytes ")
        .or_else(|| trimmed.strip_prefix("BYTES "))
    else {
        return false;
    };
    let Some((start_str, _)) = rest.split_once('-') else {
        return false;
    };
    start_str.trim().parse::<u64>().ok() == Some(expected_start)
}

/// 可注入 Agent 与重试间隔的核心下载实现（支持 Range 断点续传与 200 回退重下，便于本地 TcpListener 测试）。
fn download_and_install_asset_with_agent(
    install_dir: &Path,
    platform_key: &str,
    version: &str,
    asset: &ManifestAsset,
    agent: &ureq::Agent,
    retry_delay: Duration,
    mut log_fn: impl FnMut(String),
) -> Result<String, String> {
    if asset.size == 0 || asset.size > 256 * 1024 * 1024 {
        return Err(format!("组件体积异常（{} 字节），已拒绝", asset.size));
    }

    fs::create_dir_all(install_dir)
        .map_err(|e| format!("无法创建安装目录 {}：{e}", install_dir.display()))?;

    let target_name = asset_filename(platform_key, version)?;
    let target_path = install_dir.join(&target_name);
    let tmp_path = install_dir.join(format!(".{target_name}.part"));

    // 清理残留临时文件
    let _ = fs::remove_file(&tmp_path);

    log_fn(format!(
        "开始下载 cosyee-tailnet {version}（{:.1} MB）...",
        asset.size as f64 / (1024.0 * 1024.0)
    ));

    let mut file = File::create(&tmp_path)
        .map_err(|e| format!("无法创建临时文件 {}：{e}", tmp_path.display()))?;

    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total: u64 = 0;
    let mut last_pct: u64 = 0;

    let download_res: Result<(), String> = (|| {
        let mut last_err = String::new();

        for attempt in 0..=DOWNLOAD_MAX_RETRIES {
            if attempt > 0 {
                if total > 0 {
                    log_fn(format!("下载中断，第 {attempt} 次重试（断点续传）…"));
                } else {
                    log_fn(format!("下载中断，第 {attempt} 次重试…"));
                }
                std::thread::sleep(retry_delay);
            }

            let mut req = agent.get(&asset.url);
            if total > 0 {
                req = req.header("Range", &format!("bytes={total}-"));
            }

            let mut resp = match req.call() {
                Ok(r) => r,
                Err(e) => {
                    last_err = http_client::format_github_error("下载组件失败", "github.com", &e);
                    if attempt < DOWNLOAD_MAX_RETRIES {
                        continue;
                    }
                    return Err(last_err);
                }
            };

            let status = resp.status().as_u16();
            if total > 0 {
                if status == 200 {
                    // 服务端不支持 Range，返回了完整内容：清空临时文件并重置校验状态从头重下
                    log_fn("服务端不支持断点续传，正在从头重新下载…".into());
                    file.seek(SeekFrom::Start(0))
                        .map_err(|e| format!("重置临时文件失败：{e}"))?;
                    file.set_len(0)
                        .map_err(|e| format!("清空临时文件失败：{e}"))?;
                    hasher = Sha256::new();
                    total = 0;
                    last_pct = 0;
                } else if status == 206 {
                    let cr = resp
                        .headers()
                        .get("content-range")
                        .and_then(|v| v.to_str().ok());
                    if !content_range_matches_start(cr, total) {
                        last_err = format!(
                            "断点续传偏移不匹配（期望从 {total} 开始，实际 Content-Range: {}）",
                            cr.unwrap_or("无")
                        );
                        // 偏移不一致时安全起见重置为从头下载
                        file.seek(SeekFrom::Start(0))
                            .map_err(|e| format!("重置临时文件失败：{e}"))?;
                        file.set_len(0)
                            .map_err(|e| format!("清空临时文件失败：{e}"))?;
                        hasher = Sha256::new();
                        total = 0;
                        last_pct = 0;
                        if attempt < DOWNLOAD_MAX_RETRIES {
                            continue;
                        }
                        return Err(last_err);
                    }
                }
            }

            let mut reader = resp.body_mut().as_reader();
            let mut stream_err: Option<String> = None;

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        total += n as u64;
                        if total > asset.size {
                            return Err("下载文件大小超出 manifest 声明，已中止".into());
                        }
                        file.write_all(&buf[..n])
                            .map_err(|e| format!("写入临时文件失败：{e}"))?;
                        hasher.update(&buf[..n]);

                        let pct = total * 100 / asset.size;
                        if (pct >= last_pct + 20 || pct == 100) && pct != last_pct {
                            last_pct = pct;
                            log_fn(format!("下载进度：{pct}%"));
                        }
                    }
                    Err(e) => {
                        stream_err = Some(format!(
                            "下载读取中断：连不上 GitHub 或连接被中断，请检查网络或代理设置后重试。（{e}）"
                        ));
                        break;
                    }
                }
            }

            if stream_err.is_none() && total == asset.size {
                file.sync_all().map_err(|e| format!("落盘同步失败：{e}"))?;
                return Ok(());
            }

            last_err = stream_err.unwrap_or_else(|| {
                format!(
                    "下载未完成即中断：期望 {} 字节，已下载 {} 字节",
                    asset.size, total
                )
            });

            if attempt == DOWNLOAD_MAX_RETRIES {
                return Err(last_err);
            }
        }

        Err(last_err)
    })();

    drop(file);
    if let Err(e) = download_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(e);
    }

    if total != asset.size {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "文件大小不匹配：期望 {} 字节，实际 {} 字节",
            asset.size, total
        ));
    }

    let actual_sha = hex_lower(&hasher.finalize());
    let expected_sha = asset.sha256.trim().to_ascii_lowercase();
    if actual_sha != expected_sha {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "SHA-256 校验失败：期望 {expected_sha}，实际 {actual_sha}"
        ));
    }
    log_fn("SHA-256 校验通过".into());

    // 设置目标权限（macOS/Unix 可执行；Android 14 动态加载要求只读）
    set_installed_permissions(&tmp_path)?;

    // 若目标已存在且只读（如重装同版本），先尝试恢复可写再替换
    if target_path.exists() {
        make_writable_if_needed(&target_path);
        let _ = fs::remove_file(&target_path);
    }

    fs::rename(&tmp_path, &target_path).map_err(|e| {
        let _ = fs::remove_file(&tmp_path);
        format!("原子安装失败：{e}")
    })?;

    Ok(target_name)
}

#[cfg(unix)]
fn set_installed_permissions(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    #[cfg(target_os = "android")]
    let mode = 0o444;
    #[cfg(not(target_os = "android"))]
    let mode = 0o755;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
        .map_err(|e| format!("设置文件权限失败：{e}"))
}

#[cfg(not(unix))]
fn set_installed_permissions(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(unix)]
pub fn make_writable_if_needed(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o644));
}

#[cfg(not(unix))]
pub fn make_writable_if_needed(_path: &Path) {}

/// 删除安装目录里的旧版本二进制文件（保留 keep_files 中指定的文件）。
pub fn cleanup_old_versions(install_dir: &Path, keep_files: &[&str]) {
    let Ok(entries) = fs::read_dir(install_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path: PathBuf = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        let is_component_bin = name.starts_with("cosyee-tailnet_")
            || name.starts_with("libcosyee_tailnet_")
            || name.ends_with(".part");
        if !is_component_bin {
            continue;
        }
        if keep_files.contains(&name) {
            continue;
        }
        make_writable_if_needed(&path);
        let _ = fs::remove_file(&path);
    }
}

/// 比较 semver 版本字符串：返回 `latest` 是否比 `current` 更新（无法解析时按字符串不等判定）。
pub fn is_newer_version(latest: &str, current: &str) -> bool {
    let parse = |s: &str| -> Option<(u64, u64, u64, String)> {
        let s = s.trim().strip_prefix('v').unwrap_or(s.trim());
        let (core, pre) = match s.split_once('-') {
            Some((c, p)) => (c, p.to_string()),
            None => (s, String::new()),
        };
        let mut parts = core.split('.');
        let maj = parts.next()?.parse().ok()?;
        let min = parts.next()?.parse().ok()?;
        let pat = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some((maj, min, pat, pre))
    };
    match (parse(latest), parse(current)) {
        (Some((l1, l2, l3, lp)), Some((c1, c2, c3, cp))) => {
            if (l1, l2, l3) != (c1, c2, c3) {
                return (l1, l2, l3) > (c1, c2, c3);
            }
            // 同主次修订号：正式版（无 prerelease）高于预发布版
            match (lp.is_empty(), cp.is_empty()) {
                (true, false) => true,
                (false, true) => false,
                _ => lp > cp,
            }
        }
        _ => latest.trim() != current.trim(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn verify_signature_valid_and_tampered() {
        let seed = [42u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let pk_b64 = base64::engine::general_purpose::STANDARD.encode(sk.verifying_key().as_bytes());
        let body = br#"{"version":"1.0.0","assets":{}}"#;
        let sig = sk.sign(body);
        let sig_b64 = base64::engine::general_purpose::STANDARD.encode(sig.to_bytes());

        assert!(verify_manifest_signature(body, &format!("{sig_b64}\n"), &pk_b64).is_ok());

        // 篡改一个字节必须失败
        let tampered = br#"{"version":"1.0.1","assets":{}}"#;
        assert!(verify_manifest_signature(tampered, &sig_b64, &pk_b64).is_err());

        // 签名格式错误必须失败
        assert!(verify_manifest_signature(body, "not-base64!!!", &pk_b64).is_err());
    }

    #[test]
    fn hardcoded_public_key_is_valid_ed25519() {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(PUBLIC_KEY_B64)
            .expect("公钥 base64 应可解码");
        let arr: [u8; 32] = raw.try_into().expect("公钥应为 32 字节");
        VerifyingKey::from_bytes(&arr).expect("公钥应为合法的 Ed25519 点");
    }

    #[test]
    fn version_comparison_rules() {
        assert!(is_newer_version("1.0.1", "1.0.0"));
        assert!(is_newer_version("1.1.0", "1.0.9"));
        assert!(is_newer_version("2.0.0", "1.9.9"));
        assert!(!is_newer_version("1.0.0", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "1.0.1"));
        assert!(is_newer_version("1.0.0", "1.0.0-rc.1"));
    }

    #[test]
    fn asset_filename_rejects_traversal() {
        assert_eq!(
            asset_filename("windows-x64", "1.2.3").unwrap(),
            "cosyee-tailnet_1.2.3_windows_x64.exe"
        );
        assert_eq!(
            asset_filename("macos-universal", "1.2.3").unwrap(),
            "cosyee-tailnet_1.2.3_macos_universal"
        );
        assert_eq!(
            asset_filename("android-arm64", "1.2.3").unwrap(),
            "libcosyee_tailnet_1.2.3_android_arm64.so"
        );
        assert!(asset_filename("windows-x64", "../evil").is_err());
        assert!(asset_filename("linux-x64", "1.0.0").is_err());
    }

    fn read_http_request(stream: &mut std::net::TcpStream) -> String {
        let mut req_bytes = Vec::new();
        let mut buf = [0u8; 512];
        while !req_bytes.windows(4).any(|w| w == b"\r\n\r\n") {
            let n = stream.read(&mut buf).unwrap();
            if n == 0 {
                break;
            }
            req_bytes.extend_from_slice(&buf[..n]);
        }
        String::from_utf8_lossy(&req_bytes).into_owned()
    }

    fn make_test_payload(len: usize) -> (Vec<u8>, String) {
        let data: Vec<u8> = (0..len).map(|i| ((i * 31 + 17) % 251) as u8).collect();
        let sha = hex_lower(&Sha256::digest(&data));
        (data, sha)
    }

    #[test]
    fn download_resumes_with_range_and_verifies_sha256() {
        use std::net::TcpListener;

        let (payload, sha) = make_test_payload(128 * 1024);
        let split = 50 * 1024;
        let payload_srv = payload.clone();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = std::thread::spawn(move || {
            // 第 1 次请求：声明完整 Content-Length，但只发前一半就断开连接
            let (mut s1, _) = listener.accept().unwrap();
            let req1 = read_http_request(&mut s1);
            assert!(
                !req1.to_ascii_lowercase().contains("\r\nrange:"),
                "首次请求不应带 Range 头：{req1}"
            );
            let head1 = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload_srv.len()
            );
            s1.write_all(head1.as_bytes()).unwrap();
            s1.write_all(&payload_srv[..split]).unwrap();
            let _ = s1.flush();
            drop(s1);

            // 第 2 次请求：应携带 Range: bytes=<split>-，服务端返回 206 Partial Content 和剩余字节
            let (mut s2, _) = listener.accept().unwrap();
            let req2 = read_http_request(&mut s2);
            let expected_range = format!("range: bytes={split}-");
            assert!(
                req2.to_ascii_lowercase().contains(&expected_range),
                "续传请求应带 {expected_range}，实际请求：{req2}"
            );
            let rest = &payload_srv[split..];
            let head2 = format!(
                "HTTP/1.1 206 Partial Content\r\nContent-Range: bytes {}-{}/{}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                split,
                payload_srv.len() - 1,
                payload_srv.len(),
                rest.len()
            );
            s2.write_all(head2.as_bytes()).unwrap();
            s2.write_all(rest).unwrap();
            let _ = s2.flush();
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "cosyee_manifest_resume_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp_dir);

        let asset = ManifestAsset {
            url: format!("http://{addr}/cosyee-tailnet.bin"),
            sha256: sha,
            size: payload.len() as u64,
        };
        let agent = http_client::build_direct_agent(
            Some(Duration::from_secs(10)),
            Some(Duration::from_secs(5)),
        );
        let mut logs = Vec::new();
        let installed = download_and_install_asset_with_agent(
            &tmp_dir,
            "windows-x64",
            "1.0.0",
            &asset,
            &agent,
            Duration::from_millis(10),
            |line| logs.push(line),
        )
        .expect("Range 续传下载应成功并通过 sha256 校验");

        srv.join().unwrap();

        let installed_path = tmp_dir.join(&installed);
        assert_eq!(fs::read(&installed_path).unwrap(), payload);
        assert!(!tmp_dir.join(format!(".{installed}.part")).exists());
        assert!(logs.iter().any(|l| l.contains("断点续传")));
        assert!(logs.iter().any(|l| l.contains("SHA-256 校验通过")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }

    #[test]
    fn download_restarts_from_scratch_when_range_unsupported() {
        use std::net::TcpListener;

        let (payload, sha) = make_test_payload(96 * 1024);
        let split = 40 * 1024;
        let payload_srv = payload.clone();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();

        let srv = std::thread::spawn(move || {
            // 第 1 次请求：发前一半后断开
            let (mut s1, _) = listener.accept().unwrap();
            let _req1 = read_http_request(&mut s1);
            let head1 = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload_srv.len()
            );
            s1.write_all(head1.as_bytes()).unwrap();
            s1.write_all(&payload_srv[..split]).unwrap();
            let _ = s1.flush();
            drop(s1);

            // 第 2 次请求：客户端带了 Range，但服务端不支持 Range，直接返回 200 OK 和完整内容
            let (mut s2, _) = listener.accept().unwrap();
            let req2 = read_http_request(&mut s2);
            assert!(
                req2.to_ascii_lowercase().contains("range: bytes="),
                "重试请求应携带 Range 头：{req2}"
            );
            let head2 = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload_srv.len()
            );
            s2.write_all(head2.as_bytes()).unwrap();
            s2.write_all(&payload_srv).unwrap();
            let _ = s2.flush();
        });

        let tmp_dir = std::env::temp_dir().join(format!(
            "cosyee_manifest_no_range_test_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&tmp_dir);

        let asset = ManifestAsset {
            url: format!("http://{addr}/cosyee-tailnet.bin"),
            sha256: sha,
            size: payload.len() as u64,
        };
        let agent = http_client::build_direct_agent(
            Some(Duration::from_secs(10)),
            Some(Duration::from_secs(5)),
        );
        let mut logs = Vec::new();
        let installed = download_and_install_asset_with_agent(
            &tmp_dir,
            "windows-x64",
            "1.0.1",
            &asset,
            &agent,
            Duration::from_millis(10),
            |line| logs.push(line),
        )
        .expect("服务端不支持 Range 时应从头重下成功并通过 sha256 校验");

        srv.join().unwrap();

        let installed_path = tmp_dir.join(&installed);
        assert_eq!(fs::read(&installed_path).unwrap(), payload);
        assert!(!tmp_dir.join(format!(".{installed}.part")).exists());
        assert!(logs.iter().any(|l| l.contains("从头重新下载")));
        assert!(logs.iter().any(|l| l.contains("SHA-256 校验通过")));

        let _ = fs::remove_dir_all(&tmp_dir);
    }
}
